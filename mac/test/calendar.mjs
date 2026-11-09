/**
 * End-to-end exercise of the calendar tools against the stub helper. Fixtures
 * are dated relative to today; free-time checks use tomorrow so the "nothing
 * before now" rule cannot shift the expected slots.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "dist", "index.js");
const STUB = join(HERE, "stub-helper.mjs");
chmodSync(STUB, 0o755);

const pad = (n) => String(n).padStart(2, "0");
const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// ---------------------------------------------------------------------------
// Fixtures. Titles name what each event is there to prove.
// ---------------------------------------------------------------------------

const calendars = [
  { id: "C-WORK", title: "Work", account: "Exchange", type: "exchange", color: "#0088FF", isDefault: true, readOnly: false },
  { id: "C-HOME", title: "Home", account: "iCloud", type: "caldav", color: "#FF9500", isDefault: false, readOnly: false },
  { id: "C-HOL", title: "Holidays", account: "Other", type: "subscription", color: "#34C759", isDefault: false, readOnly: true },
];

const base = {
  allDay: false,
  location: null,
  notes: null,
  url: null,
  timeZone: "America/New_York",
  availability: "busy",
  status: "none",
  recurring: false,
  detached: false,
  recurrence: null,
  occurrence: null,
  alarms: [],
  organizer: null,
  attendees: [],
  myStatus: null,
  readOnly: false,
  created: "2026-01-01T09:00",
  modified: "2026-01-01T09:00",
};
const work = { calendar: "Work", calendarId: "C-WORK" };
const home = { calendar: "Home", calendarId: "C-HOME" };
const holidays = { calendar: "Holidays", calendarId: "C-HOL", readOnly: true };
const tom = day(1);

const events = [
  {
    ...base,
    ...work,
    id: `E-STANDUP::${tom}T09:30`,
    title: "standup",
    start: `${tom}T09:30`,
    end: `${tom}T10:00`,
    recurring: true,
    recurrence: { frequency: "weekly", interval: 1, daysOfWeek: ["mon", "wed", "fri"] },
    occurrence: `${tom}T09:30`,
  },
  {
    ...base,
    ...work,
    id: "E-DECLINED",
    title: "declined-sync",
    start: `${tom}T10:30`,
    end: `${tom}T11:30`,
    myStatus: "declined",
    organizer: { name: "Pat", email: "pat@example.com", status: "accepted", role: "chair", type: "person", isMe: false },
    attendees: [
      { name: "Pat", email: "pat@example.com", status: "accepted", role: "required", type: "person", isMe: false },
      { name: "Me", email: "me@example.com", status: "declined", role: "required", type: "person", isMe: true },
    ],
  },
  { ...base, ...work, id: "E-LUNCH", title: "lunch-review", start: `${tom}T12:00`, end: `${tom}T13:30`, location: "Cafe Rio, Boston" },
  { ...base, ...work, id: "E-CANCELED", title: "canceled-demo", start: `${tom}T14:00`, end: `${tom}T15:00`, status: "canceled" },
  { ...base, ...home, id: "E-FREE", title: "free-hold", start: `${tom}T15:00`, end: `${tom}T16:00`, availability: "free" },
  { ...base, ...holidays, id: "E-HOL", title: "holiday", start: tom, end: tom, allDay: true, availability: "free" },
  { ...base, ...home, id: "E-TRIP", title: "trip", start: day(-1), end: day(2), allDay: true, availability: "free" },
  { ...base, ...home, id: "E-FAR", title: "far-away", start: `${day(10)}T09:00`, end: `${day(10)}T10:00` },
];

const dir = mkdtempSync(join(tmpdir(), "mac-mcp-cal-"));
const FIXTURES = join(dir, "fixtures.json");
const LOG = join(dir, "calls.jsonl");
writeFileSync(FIXTURES, JSON.stringify({ lists: [], reminders: [], calendars, events }));

const calls = () =>
  readFileSync(LOG, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const lastCall = () => calls().at(-1);

let failures = 0;
const expect = (desc, condition) => {
  if (!condition) failures++;
  console.log(`  ${condition ? "PASS" : "FAIL"}: ${desc}`);
};

async function connect(extraEnv = {}) {
  const env = { ...process.env, MAC_HELPER_PATH: STUB, STUB_FIXTURES: FIXTURES, STUB_LOG: LOG };
  delete env.STUB_MODE;
  Object.assign(env, extraEnv);
  const client = new Client({ name: "calendar-e2e", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: "node", args: [SERVER], env }));
  return client;
}

const client = await connect();
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { text: res.content[0].text, isError: res.isError === true };
};
/** Event titles in the order the tool printed them. */
const titles = (text) => [...text.matchAll(/^ {2}(?:all day(?: through \S+ \S+)?|\d\d:\d\d–\S+(?: \S+)?) {2}(\S+)/gm)].map((m) => m[1]);

try {
  console.log("CALENDARS:");
  {
    const { text } = await call("calendar_list_calendars");
    expect("counts calendars", text.startsWith("3 calendars"));
    expect("groups by account", text.includes("Exchange\n  Work") && text.includes("iCloud\n  Home"));
    expect("marks default and read-only", /Work · exchange, default/.test(text) && /Holidays · subscription, read-only/.test(text));
  }

  console.log("\nLISTING:");
  {
    const week = await call("calendar_list_events");
    const t = titles(week.text);
    expect(`defaults to 7 days from today (${t})`, !t.includes("far-away") && t.includes("standup"));
    expect("asks the helper for today through day 7 exclusive",
      lastCall().input.from === day(0) && lastCall().input.to === day(7));
    expect("an event begun before the range is listed on its first day",
      week.text.indexOf("trip") < week.text.indexOf(`${tom}`));
    expect("all-day events lead their day", t.indexOf("holiday") < t.indexOf("standup"));
    expect("describes the weekday repeat", week.text.includes("repeats every week on Mon, Wed, Fri"));
    expect("shows the occurrence id", week.text.includes(`id: E-STANDUP::${tom}T09:30`));
    expect("flags canceled events", /canceled-demo · CANCELED/.test(week.text));
    expect("shows my response to invitations", week.text.includes("2 attendees (you: declined)"));

    const found = await call("calendar_list_events", { search: "cafe rio" });
    expect("search matches location", titles(found.text).join() === "lunch-review");
    const byPerson = await call("calendar_list_events", { search: "pat@example" });
    expect("search matches attendees", titles(byPerson.text).join() === "declined-sync");

    const later = await call("calendar_list_events", { start: day(10), end: day(10) });
    expect("explicit single-day range", titles(later.text).join() === "far-away");

    const scoped = await call("calendar_list_events", { calendars: ["home"] });
    expect("passes calendar refs through", lastCall().input.calendars[0] === "home");
    expect("a single calendar omits calendar names on lines", !/ · Home · /.test(scoped.text));

    const backwards = await call("calendar_list_events", { start: day(3), end: day(1) });
    expect("rejects end before start", backwards.isError && backwards.text.includes("before start"));
    const huge = await call("calendar_list_events", { start: day(0), end: day(500) });
    expect("rejects ranges over a year", huge.isError && huge.text.includes("366 days"));
  }

  console.log("\nFREE TIME:");
  {
    const free = await call("calendar_find_free_time", { start: tom, days: 1, weekends: true });
    const slots = [...free.text.matchAll(/^ {2}(\d\d:\d\d–\d\d:\d\d)/gm)].map((m) => m[1]);
    expect(`declined, canceled, free and all-day events do not block (${slots})`,
      slots.join() === "09:00–09:30,10:00–12:00,13:30–17:00");
    expect("reports durations", free.text.includes("(3h 30m)"));

    const longOnly = await call("calendar_find_free_time", { start: tom, days: 1, weekends: true, minMinutes: 180 });
    expect("minMinutes drops short gaps", longOnly.text.startsWith("1 free slot"));

    const bad = await call("calendar_find_free_time", { dayStart: "17:00", dayEnd: "09:00" });
    expect("rejects an inverted working day", bad.isError);
  }

  console.log("\nDETAIL AND ERRORS:");
  {
    const detail = await call("calendar_get_event", { id: "E-DECLINED" });
    expect("lists attendees with responses", detail.text.includes("Me <me@example.com> · declined · you"));
    expect("shows the organizer", detail.text.includes("organizer: Pat <pat@example.com> · accepted · chair"));

    const missing = await call("calendar_get_event", { id: "NOPE" });
    expect("unknown id explains where ids come from", missing.isError && missing.text.includes("calendar_list_events"));

    const noCal = await call("calendar_list_events", { calendars: ["Nope"] });
    expect("unknown calendar points at calendar_list_calendars", noCal.isError && noCal.text.includes("calendar_list_calendars"));
  }

  console.log("\nWRITES:");
  {
    const created = await call("calendar_create_event", { title: "Dentist", start: `${day(3)}T15:00`, location: "Main St" });
    expect("create reports the calendar", created.text.startsWith('Created in "Work"'));
    expect("create sends only the fields given",
      JSON.stringify(Object.keys(lastCall().input).sort()) === JSON.stringify(["location", "start", "title"]));

    await call("calendar_create_event", {
      title: "Gym",
      start: `${day(3)}T07:00`,
      recurrence: { frequency: "weekly", daysOfWeek: ["tue", "thu"] },
    });
    expect("recurrence weekdays reach the helper", lastCall().input.recurrence.daysOfWeek.join() === "tue,thu");

    await call("calendar_update_event", { id: `E-STANDUP::${tom}T09:30`, start: `${tom}T09:45`, notes: null });
    const sent = lastCall().input;
    expect("update defaults span to this", sent.span === "this");
    expect("update keeps null so the helper clears the field", sent.notes === null && !("title" in sent));

    const future = await call("calendar_update_event", { id: `E-STANDUP::${tom}T09:30`, span: "future", title: "standup v2" });
    expect("span=future is passed and reported", lastCall().input.span === "future" && future.text.includes("future occurrences"));

    const before = calls().length;
    const nothing = await call("calendar_update_event", { id: "E-LUNCH" });
    expect("an empty update never reaches the helper", nothing.text.startsWith("Nothing to change") && calls().length === before);

    const deleted = await call("calendar_delete_events", { ids: ["E-LUNCH"] });
    expect("delete echoes what was removed", deleted.text.includes("lunch-review") && lastCall().input.span === "this");

    const cal = await call("calendar_create_calendar", { title: "Garden", color: "#33AA55" });
    expect("create_calendar returns the new id", cal.text.includes("id: NEW-CAL") && cal.text.includes("#33AA55"));

    const gone = await call("calendar_delete_calendar", { calendar: "Home" });
    expect("delete_calendar names what was removed", gone.text.includes('Deleted calendar "Home"'));
  }

  await client.close();

  console.log("\nACCESS DENIED:");
  {
    const denied = await connect({ STUB_MODE: "denied" });
    const res = await denied.callTool({ name: "calendar_list_events", arguments: {} });
    const text = res.content[0].text;
    console.log("  " + text);
    expect("is a tool error", res.isError === true);
    expect("names the Calendars settings pane", text.includes("Privacy & Security → Calendars"));
    await denied.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL ASSERTIONS PASSED" : `${failures} ASSERTION(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
