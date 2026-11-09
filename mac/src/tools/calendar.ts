import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runHelper } from "../helper.js";
import { fail, guard, ok } from "../lib/tool.js";
import { WEEKDAY_KEYS, addDays, localDay, parseLocal } from "../lib/reminders.js";
import {
  clock,
  compareEvents,
  duration,
  findFreeSlots,
  matchesSearch,
  renderEventDetail,
  renderEventLine,
  weekday,
  type CalendarEvent,
  type EventCalendar,
} from "../lib/calendar.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

// EventKit refuses event searches spanning more than four years; a year is plenty.
const MAX_RANGE_DAYS = 366;

const dayField = z.string().regex(DAY, "Use YYYY-MM-DD.");

const timeField = z
  .string()
  .regex(STAMP, "Use YYYY-MM-DD for all-day or YYYY-MM-DDTHH:MM for a specific time.")
  .describe(
    "YYYY-MM-DD for an all-day event, or YYYY-MM-DDTHH:MM in the Mac's local time (or in timeZone when given).",
  );

const calendarRefField = z
  .string()
  .min(1)
  .describe("Calendar name (case-insensitive) or id from calendar_list_calendars.");

const availabilityField = z
  .enum(["busy", "free", "tentative", "unavailable"])
  .describe("How the event shows to anyone checking your free/busy time.");

const timeZoneField = z
  .string()
  .min(1)
  .describe(
    "IANA time zone the start and end are written in, e.g. America/Los_Angeles for a flight. Defaults to the " +
      "Mac's zone. Listings always show times in the Mac's zone.",
  );

const alarmField = z
  .array(
    z.union([
      z.object({
        minutesBefore: z.number().int().describe("Alert this many minutes before the start (0 = at start)."),
      }),
      z.object({ at: z.string().regex(STAMP).describe("Alert at this local time, YYYY-MM-DDTHH:MM.") }),
    ]),
  )
  .describe("Alerts. Replaces the event's existing time alerts; [] removes them.");

const recurrenceField = z
  .object({
    frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().min(1).default(1).describe("Every N days/weeks/months/years."),
    daysOfWeek: z
      .array(z.enum(WEEKDAY_KEYS))
      .min(1)
      .max(7)
      .optional()
      .describe("Weekly only: repeat on these days, e.g. [\"mon\", \"wed\", \"fri\"]."),
    until: timeField.optional().describe("Stop repeating after this date."),
    count: z.number().int().min(1).optional().describe("Stop after this many occurrences."),
  })
  .describe("Repeat schedule, anchored on the start.");

const spanField = z
  .enum(["this", "future"])
  .default("this")
  .describe(
    "For a repeating event: \"this\" changes only the occurrence the id names; \"future\" changes it and every " +
      "later one. Ignored for one-off events.",
  );

const idsField = z.array(z.string().min(1)).min(1).max(100);

/** Drop undefined keys but keep null, which the helper reads as "clear this field". */
function patch(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((parseLocal(toDay).getTime() - parseLocal(fromDay).getTime()) / 86_400_000);
}

/** Inclusive day range from a start and either an end day or a length. */
function resolveRange(start: string | undefined, end: string | undefined, days: number, now: Date) {
  const fromDay = start?.slice(0, 10) ?? localDay(now);
  const lastDay = end ?? addDays(fromDay, days - 1);
  if (lastDay < fromDay) return { error: `end (${lastDay}) is before start (${fromDay}).` };
  if (daysBetween(fromDay, lastDay) + 1 > MAX_RANGE_DAYS) {
    return { error: `That range is longer than ${MAX_RANGE_DAYS} days; split it into smaller windows.` };
  }
  return { fromDay, lastDay, from: start ?? fromDay, to: addDays(lastDay, 1) };
}

function fetchEvents(from: string, to: string, calendars?: string[]): Promise<CalendarEvent[]> {
  return runHelper<CalendarEvent[]>("events", patch({ from, to, calendars }));
}

export function registerCalendarTools(server: McpServer): void {
  server.registerTool(
    "calendar_list_calendars",
    {
      title: "List calendars",
      description:
        "Every calendar on this Mac across iCloud, Exchange, Google and subscribed accounts, with its account, " +
        "type, color, the default calendar for new events, and ids. Names repeat across accounts (\"Calendar\", " +
        "\"Home\"), so pass the id to other tools when a name is ambiguous.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async () => {
      const calendars = await runHelper<EventCalendar[]>("calendars");
      if (calendars.length === 0) return ok("No calendars. Calendar may not be set up on this Mac.");

      const counts = new Map<string, number>();
      for (const c of calendars) counts.set(c.title.toLowerCase(), (counts.get(c.title.toLowerCase()) ?? 0) + 1);

      // Grouped by account, which is how the Calendar app's sidebar reads.
      const byAccount = new Map<string, EventCalendar[]>();
      for (const c of calendars) byAccount.set(c.account, [...(byAccount.get(c.account) ?? []), c]);

      const body = [...byAccount.entries()]
        .map(([account, items]) => {
          const lines = items.map((c) => {
            const flags = [
              c.type,
              c.isDefault ? "default" : null,
              c.readOnly ? "read-only" : null,
              (counts.get(c.title.toLowerCase()) ?? 0) > 1 ? "name shared — use id" : null,
              c.color,
            ].filter(Boolean);
            return `  ${c.title} · ${flags.join(", ")} · id: ${c.id}`;
          });
          return `${account || "On My Mac"}\n${lines.join("\n")}`;
        })
        .join("\n\n");
      return ok(`${plural(calendars.length, "calendar")}\n\n${body}`);
    }),
  );

  server.registerTool(
    "calendar_list_events",
    {
      title: "Find events",
      description:
        "Calendar events in a date range, grouped by day, with repeating events expanded into their occurrences. " +
        "Defaults to the next 7 days from today. Use search to find a specific event by title, location, notes, or " +
        "attendee before changing it. Each line carries the id the other calendar tools need; a repeating " +
        "event's id names that one occurrence.",
      inputSchema: {
        start: timeField
          .optional()
          .describe("First day (YYYY-MM-DD) or moment (YYYY-MM-DDTHH:MM) to include. Defaults to today."),
        end: dayField.optional().describe("Last day to include (inclusive). Overrides days."),
        days: z.number().int().min(1).max(MAX_RANGE_DAYS).default(7).describe("Days to cover when end is omitted."),
        calendars: z
          .array(calendarRefField)
          .min(1)
          .max(30)
          .optional()
          .describe("Only these calendars (names or ids). Omit for every calendar."),
        search: z.string().min(1).optional().describe("Case-insensitive match on title, location, notes, attendees."),
        limit: z.number().int().min(1).max(1000).default(300),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ start, end, days, calendars, search, limit }) => {
      const now = new Date();
      const range = resolveRange(start, end, days, now);
      if ("error" in range) return fail(range.error!);

      const fetched = await fetchEvents(range.from, range.to, calendars);
      const matched = (search ? fetched.filter((e) => matchesSearch(e, search)) : fetched).sort(compareEvents);
      const shown = matched.slice(0, limit);

      const scope = [
        range.fromDay === range.lastDay ? `${weekday(range.fromDay)} ${range.fromDay}` : `${range.fromDay} to ${range.lastDay}`,
        search ? `matching "${search}"` : null,
        calendars ? `in ${calendars.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join(" · ");

      if (matched.length === 0) return ok(`No events (${scope}).`);

      // An event that began before the range (a trip, a long meeting) is listed on the range's first day.
      const byDay = new Map<string, CalendarEvent[]>();
      for (const e of shown) {
        const day = e.start.slice(0, 10) < range.fromDay ? range.fromDay : e.start.slice(0, 10);
        byDay.set(day, [...(byDay.get(day) ?? []), e]);
      }
      const showCalendar = new Set(shown.map((e) => e.calendarId)).size > 1;
      const today = localDay(now);
      const body = [...byDay.entries()]
        .map(([day, items]) => {
          const tag = day === today ? " (today)" : day === addDays(today, 1) ? " (tomorrow)" : "";
          const lines = items.map((e) => `  ${renderEventLine(e, { showCalendar })}`).join("\n");
          return `${weekday(day)} ${day}${tag}\n${lines}`;
        })
        .join("\n\n");

      const truncated =
        matched.length > shown.length
          ? `\n\nShowing ${shown.length} of ${matched.length}. Narrow the range, calendars, or search, or raise limit.`
          : "";
      return ok(`${plural(matched.length, "event")} (${scope}) as of ${now.toString().slice(0, 21)}\n\n${body}${truncated}`);
    }),
  );

  server.registerTool(
    "calendar_get_event",
    {
      title: "Get an event",
      description:
        "Full detail for one event: notes, attendees and their responses, organizer, alerts, repeat rule, time " +
        "zone, and url. calendar_list_events already shows the essentials, so call this when those details matter.",
      inputSchema: { id: z.string().min(1).describe("Event id from calendar_list_events.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ id }) => {
      const event = await runHelper<CalendarEvent>("event_get", { id });
      return ok(renderEventDetail(event, new Date()));
    }),
  );

  server.registerTool(
    "calendar_find_free_time",
    {
      title: "Find free time",
      description:
        "Open slots within working hours across the given days, for \"when am I free\" or picking a meeting time. " +
        "Timed events block time unless shown as free, canceled, or declined; all-day events only block when " +
        "marked busy. Today's slots start from now.",
      inputSchema: {
        start: dayField.optional().describe("First day to check. Defaults to today."),
        days: z.number().int().min(1).max(31).default(5).describe("How many consecutive days to check."),
        dayStart: z.string().regex(CLOCK, "Use HH:MM.").default("09:00").describe("Start of the bookable day, HH:MM."),
        dayEnd: z.string().regex(CLOCK, "Use HH:MM.").default("17:00").describe("End of the bookable day, HH:MM."),
        minMinutes: z.number().int().min(5).max(1440).default(30).describe("Shortest slot worth reporting."),
        weekends: z.boolean().default(false).describe("Include Saturdays and Sundays."),
        calendars: z
          .array(calendarRefField)
          .min(1)
          .max(30)
          .optional()
          .describe("Only count events on these calendars. Omit to count every calendar."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ start, days, dayStart, dayEnd, minMinutes, weekends, calendars }) => {
      if (dayEnd <= dayStart) return fail(`dayEnd (${dayEnd}) must be after dayStart (${dayStart}).`);
      const now = new Date();
      const range = resolveRange(start, undefined, days, now);
      if ("error" in range) return fail(range.error!);

      const checked: string[] = [];
      for (let day = range.fromDay; day <= range.lastDay; day = addDays(day, 1)) {
        const dow = parseLocal(day).getDay();
        if (weekends || (dow !== 0 && dow !== 6)) checked.push(day);
      }
      if (checked.length === 0) return ok("Every day in that range is a weekend. Pass weekends=true to include them.");

      const events = await fetchEvents(range.fromDay, range.to, calendars);
      const slots = findFreeSlots(events, { days: checked, dayStart, dayEnd, minMinutes, now });

      const body = checked
        .map((day) => {
          const mine = slots.filter((s) => s.day === day);
          const lines = mine.length
            ? mine.map((s) => `  ${clock(s.start)}–${clock(s.end)} (${duration(Math.round((s.end.getTime() - s.start.getTime()) / 60_000))})`)
            : ["  no free slots"];
          return `${weekday(day)} ${day}\n${lines.join("\n")}`;
        })
        .join("\n\n");
      return ok(
        `${plural(slots.length, "free slot")} of ${duration(minMinutes)} or more between ${dayStart} and ${dayEnd}` +
          `${calendars ? ` (counting ${calendars.join(", ")})` : ""}\n\n${body}`,
      );
    }),
  );

  server.registerTool(
    "calendar_create_event",
    {
      title: "Create an event",
      description:
        "Add an event. A date-only start makes an all-day event; a timed one without end lasts an hour. Without a " +
        "calendar it goes to the default shown by calendar_list_calendars. Syncs to the user's other devices. " +
        "Invitations cannot be sent from here: EventKit cannot add attendees.",
      inputSchema: {
        title: z.string().min(1),
        start: timeField,
        end: timeField.optional().describe("Same form as start. For all-day events, the last day (inclusive)."),
        calendar: calendarRefField.optional(),
        location: z.string().optional(),
        notes: z.string().optional(),
        url: z.string().url().optional(),
        availability: availabilityField.optional(),
        timeZone: timeZoneField.optional(),
        alarms: alarmField.optional(),
        recurrence: recurrenceField.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guard(async (args) => {
      const event = await runHelper<CalendarEvent>("event_create", patch(args));
      return ok(`Created in "${event.calendar}".\n\n${renderEventDetail(event, new Date())}`);
    }),
  );

  server.registerTool(
    "calendar_update_event",
    {
      title: "Update an event",
      description:
        "Change fields on an event. Omitted fields are left alone; pass null to clear location, notes, url, " +
        "alarms, or recurrence. Moving start without end keeps the event's length. Setting calendar moves it. " +
        "For a repeating event pick span: \"this\" (default) for just the occurrence, \"future\" for the rest of " +
        "the series. Changes to an invitation someone else organized stay on this calendar only and may be " +
        "overwritten by the organizer; attendees and RSVPs cannot be changed through EventKit.",
      inputSchema: {
        id: z.string().min(1),
        span: spanField,
        title: z.string().min(1).optional(),
        start: timeField.optional(),
        end: timeField.optional().describe("Same form as start. For all-day events, the last day (inclusive)."),
        calendar: calendarRefField.optional(),
        location: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
        url: z.string().url().nullable().optional(),
        availability: availabilityField.optional(),
        timeZone: timeZoneField.optional(),
        alarms: alarmField.nullable().optional(),
        recurrence: recurrenceField.nullable().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(async (args) => {
      const { id, span, ...fields } = args;
      if (Object.values(fields).every((v) => v === undefined)) {
        return ok("Nothing to change — pass at least one field besides id and span.");
      }
      const event = await runHelper<CalendarEvent>("event_update", { id, span, ...patch(fields) });
      return ok(`Updated${span === "future" ? " this and future occurrences" : ""}.\n\n${renderEventDetail(event, new Date())}`);
    }),
  );

  server.registerTool(
    "calendar_delete_events",
    {
      title: "Delete events",
      description:
        "Permanently delete events from every synced device; there is no undo through this server. For repeating " +
        "events, span \"this\" removes only the named occurrence and \"future\" removes it and every later one — " +
        "use the first occurrence's id with \"future\" to remove a whole series. Deleting an invitation may " +
        "notify the organizer, depending on the account. Delete only when the user asks. All ids are checked " +
        "first, so one bad id deletes nothing.",
      inputSchema: { ids: idsField, span: spanField },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    guard(async ({ ids, span }) => {
      const removed = await runHelper<CalendarEvent[]>("event_delete", { ids, span });
      const lines = removed.map((e) => `${weekday(e.start)} ${e.start.slice(0, 10)} ${renderEventLine(e, { showCalendar: true })}`);
      return ok(
        `Deleted ${plural(removed.length, "event")}${span === "future" ? " (and their later occurrences)" : ""}:\n` +
          lines.join("\n"),
      );
    }),
  );

  server.registerTool(
    "calendar_create_calendar",
    {
      title: "Create a calendar",
      description:
        "Add a new calendar, in the default account unless account names another (e.g. \"iCloud\"). Names need " +
        "not be unique, so check calendar_list_calendars before creating a likely duplicate.",
      inputSchema: {
        title: z.string().min(1),
        account: z.string().min(1).optional().describe("Account name as shown by calendar_list_calendars."),
        color: z
          .string()
          .regex(/^#?[0-9a-fA-F]{6}$/, "Use a hex color like #FF9500.")
          .optional()
          .describe("Hex color, e.g. #FF9500."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guard(async (args) => {
      const cal = await runHelper<EventCalendar>("calendar_create", patch(args));
      return ok(`Created calendar "${cal.title}" in ${cal.account}${cal.color ? ` (${cal.color})` : ""} · id: ${cal.id}`);
    }),
  );

  server.registerTool(
    "calendar_delete_calendar",
    {
      title: "Delete a calendar",
      description:
        "Permanently delete a calendar and every event on it, from every synced device. There is no undo. Only " +
        "do this when the user explicitly asks for that calendar to be removed, and confirm which one by id.",
      inputSchema: { calendar: calendarRefField },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    guard(async ({ calendar }) => {
      const cal = await runHelper<EventCalendar>("calendar_delete", { calendar });
      return ok(`Deleted calendar "${cal.title}" from ${cal.account} · id: ${cal.id}`);
    }),
  );
}
