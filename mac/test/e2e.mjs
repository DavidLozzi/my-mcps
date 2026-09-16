/**
 * End-to-end exercise of the reminder tools against the stub helper. Fixtures
 * are dated relative to the moment the test runs, so the due-window filters are
 * checked against a real clock rather than a frozen one.
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
const at = (offset, minutes) => {
  const d = new Date(Date.now() + offset * 86_400_000 + minutes * 60_000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// ---------------------------------------------------------------------------
// Fixtures. Titles name the bucket each reminder must land in.
// ---------------------------------------------------------------------------

const lists = [
  { id: "L-HOME", title: "Home", account: "iCloud", openCount: 6, isDefault: true, readOnly: false },
  { id: "L-WORK", title: "Work", account: "iCloud", openCount: 2, isDefault: false, readOnly: false },
  { id: "L-DUP1", title: "Shared", account: "iCloud", openCount: 0, isDefault: false, readOnly: false },
  { id: "L-DUP2", title: "Shared", account: "Exchange", openCount: 0, isDefault: false, readOnly: true },
];

const base = {
  notes: null,
  url: null,
  completedAt: null,
  created: "2026-01-01T09:00",
  modified: "2026-01-01T09:00",
  alarms: [],
  recurrence: null,
  priority: "none",
  completed: false,
};
const home = { list: "Home", listId: "L-HOME" };
const work = { list: "Work", listId: "L-WORK" };

const reminders = [
  { ...base, ...home, id: "R1", title: "overdue-yesterday", due: day(-1) },
  // Timed an hour ago today: overdue *and* today.
  { ...base, ...home, id: "R2", title: "overdue-earlier-today", due: at(0, -60) },
  // All-day today is never overdue until the day is over.
  { ...base, ...home, id: "R3", title: "today-all-day", due: day(0), priority: "high" },
  { ...base, ...work, id: "R4", title: "tomorrow-item", due: day(1), notes: "bring the Quarterly deck" },
  { ...base, ...work, id: "R5", title: "in-six-days", due: day(6) },
  { ...base, ...home, id: "R6", title: "in-eight-days", due: day(8) },
  { ...base, ...home, id: "R7", title: "undated-low", priority: "low" },
  { ...base, ...home, id: "R8", title: "undated-high", priority: "high" },
  {
    ...base,
    ...home,
    id: "R9",
    title: "repeating-bins",
    due: day(3),
    recurrence: { frequency: "weekly", interval: 2 },
  },
  { ...base, ...home, id: "C1", title: "done-recently", completed: true, completedAt: `${day(-2)}T10:00` },
  { ...base, ...home, id: "C2", title: "done-long-ago", completed: true, completedAt: `${day(-90)}T10:00` },
];

const dir = mkdtempSync(join(tmpdir(), "mac-mcp-e2e-"));
const FIXTURES = join(dir, "fixtures.json");
const LOG = join(dir, "calls.jsonl");
writeFileSync(FIXTURES, JSON.stringify({ lists, reminders }));

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
  const env = { ...process.env, MAC_HELPER_PATH: STUB, STUB_FIXTURES: FIXTURES, STUB_LOG: LOG, ...extraEnv };
  delete env.STUB_MODE;
  Object.assign(env, extraEnv);
  const client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: "node", args: [SERVER], env }));
  return client;
}

const client = await connect();
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { text: res.content[0].text, isError: res.isError === true };
};
/** Titles in the order the tool printed them. */
const titles = (text) => [...text.matchAll(/\[[ x]\] (\S+)/g)].map((m) => m[1]);

try {
  console.log("LISTS:");
  {
    const { text } = await call("reminders_list_lists");
    expect("totals the open counts", text.startsWith("4 lists, 8 open reminders"));
    expect("marks the default list", /Home — .*default/.test(text));
    expect("flags duplicate names and points at ids", (text.match(/name shared — use id/g) ?? []).length === 2);
    expect("marks read-only lists", /Exchange · read-only/.test(text));
  }

  console.log("\nDUE WINDOWS:");
  {
    const t = titles((await call("reminders_list", { due: "overdue" })).text);
    expect(`overdue = past days and past times today (${t})`, t.join() === "overdue-yesterday,overdue-earlier-today");

    const today = titles((await call("reminders_list", { due: "today" })).text);
    expect(`today includes a timed item already past (${today})`, today.includes("overdue-earlier-today"));
    expect("today puts the all-day item before the timed one", today.join() === "today-all-day,overdue-earlier-today");

    const plate = titles((await call("reminders_list", { due: "today_and_overdue" })).text);
    expect(`today_and_overdue is the union, in agenda order (${plate})`,
      plate.join() === "overdue-yesterday,today-all-day,overdue-earlier-today");

    const week = titles((await call("reminders_list", { due: "next_7_days" })).text);
    expect(`next_7_days spans today..today+6 and skips overdue (${week})`,
      week.join() === "today-all-day,overdue-earlier-today,tomorrow-item,repeating-bins,in-six-days");

    const undated = titles((await call("reminders_list", { due: "no_due_date" })).text);
    expect(`undated sorts by priority (${undated})`, undated.join() === "undated-high,undated-low");

    const bounded = titles((await call("reminders_list", { dueAfter: day(1), dueBefore: day(6) })).text);
    expect(`explicit bounds are inclusive and drop undated (${bounded})`,
      bounded.join() === "tomorrow-item,repeating-bins,in-six-days");
  }

  console.log("\nLISTING:");
  {
    const all = await call("reminders_list");
    expect("counts every open reminder", all.text.startsWith("9 reminders (open)"));
    expect("groups by list when unfiltered", all.text.includes("Home (list id L-HOME)") && all.text.includes("Work (list id L-WORK)"));
    expect("undated reminders sort after dated ones", titles(all.text).indexOf("undated-high") > titles(all.text).indexOf("in-eight-days"));
    expect("describes the repeat rule", all.text.includes("repeats every 2 weeks"));
    expect("fetch asks only for open reminders, without a completion bound",
      lastCall().input.status === "incomplete" && !("completedAfter" in lastCall().input));

    const found = await call("reminders_list", { search: "quarterly" });
    expect("search matches notes case-insensitively", titles(found.text).join() === "tomorrow-item");
    expect("shows the notes that matched", found.text.includes("notes: bring the Quarterly deck"));

    const scoped = await call("reminders_list", { lists: ["work"] });
    expect("passes list refs through to the helper", lastCall().input.lists[0] === "work");
    expect("a single list gets no group headers", !scoped.text.includes("(list id"));

    const done = await call("reminders_list", { status: "completed" });
    expect("completed defaults to a 30-day window", lastCall().input.completedAfter === day(-30));
    expect(`and excludes older completions (${titles(done.text)})`, titles(done.text).join() === "done-recently");

    const capped = await call("reminders_list", { limit: 2 });
    expect("truncation says how many were hidden", capped.text.includes("Showing 2 of 9"));

    const none = await call("reminders_list", { search: "zzz-no-match" });
    expect("empty results explain the scope", none.text.startsWith("No reminders (open · matching \"zzz-no-match\")"));
  }

  console.log("\nERRORS FROM THE HELPER:");
  {
    const ambiguous = await call("reminders_list", { lists: ["Shared"] });
    expect("ambiguous list is a tool error", ambiguous.isError);
    expect("and points at reminders_list_lists", ambiguous.text.includes("reminders_list_lists"));

    const missing = await call("reminders_get", { id: "NOPE" });
    expect("unknown id explains where ids come from", missing.isError && missing.text.includes("Ids come from reminders_list"));
  }

  console.log("\nWRITES:");
  {
    const created = await call("reminders_create", { title: "Pay rent", due: `${day(1)}T09:00`, priority: "medium" });
    expect("create reports the list it landed in", created.text.startsWith('Created in "Home"'));
    expect("create sends only the fields given",
      JSON.stringify(Object.keys(lastCall().input).sort()) === JSON.stringify(["due", "priority", "title"]));
    expect("a due-time alert is not restated as a separate alert", created.text.includes("alerts: at due time"));

    await call("reminders_update", { id: "R4", notes: null, due: day(2) });
    const sent = lastCall().input;
    expect("update keeps null so the helper clears the field", sent.notes === null);
    expect("update omits untouched fields", !("title" in sent) && !("priority" in sent));

    const nothing = await call("reminders_update", { id: "R4" });
    const before = calls().length;
    expect("an empty update never reaches the helper", nothing.text.startsWith("Nothing to change") && calls().length === before);

    const completed = await call("reminders_complete", { ids: ["R1", "R9"] });
    expect("complete defaults to completed=true", lastCall().input.completed === true);
    expect("plain reminders report as completed", /Completed 1 reminder:\n\[x\] overdue-yesterday/.test(completed.text));
    expect("repeating reminders report the advance", completed.text.includes("this occurrence of 1 repeating reminder"));

    const reopened = await call("reminders_complete", { ids: ["C1"], completed: false });
    expect("completed=false reopens", reopened.text.startsWith("Reopened 1 reminder"));

    const deleted = await call("reminders_delete", { ids: ["R7"] });
    expect("delete echoes what was removed", deleted.text.includes("undated-low"));

    const list = await call("reminders_create_list", { title: "Garden" });
    expect("create_list returns the new id", list.text.includes("id: NEW-LIST"));
  }

  await client.close();

  console.log("\nACCESS DENIED:");
  {
    const denied = await connect({ STUB_MODE: "denied" });
    const res = await denied.callTool({ name: "reminders_list", arguments: {} });
    const text = res.content[0].text;
    console.log("  " + text);
    expect("is a tool error", res.isError === true);
    expect("names the settings pane", text.includes("Privacy & Security → Reminders"));
    expect("names the command that triggers the prompt", text.includes("npm run authorize"));
    await denied.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL ASSERTIONS PASSED" : `${failures} ASSERTION(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
