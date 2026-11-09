/**
 * Ordering, searching, free-time arithmetic, and rendering for calendar events.
 * As with reminders, the helper returns raw occurrences and every judgement a
 * person would make ("am I free at 2?") is made here against the local clock.
 */

import { addDays, describeRecurrence, localDay, parseLocal, type Alarm, type Recurrence } from "./reminders.js";

export interface Participant {
  name: string;
  email: string | null;
  status: string;
  role: string;
  type: string;
  isMe: boolean;
}

export interface CalendarEvent {
  /** Unique per occurrence: a repeating event's id carries `::<original start>`. */
  id: string;
  title: string;
  calendar: string;
  calendarId: string;
  allDay: boolean;
  /** `YYYY-MM-DD` when all-day, `YYYY-MM-DDTHH:MM` in the Mac's local time otherwise. */
  start: string;
  /** Inclusive last day when all-day; the exclusive end moment otherwise. */
  end: string;
  location: string | null;
  notes: string | null;
  url: string | null;
  timeZone: string | null;
  availability: "busy" | "free" | "tentative" | "unavailable" | "not_supported";
  status: "none" | "confirmed" | "tentative" | "canceled";
  recurring: boolean;
  detached: boolean;
  recurrence: Recurrence | null;
  occurrence: string | null;
  alarms: Alarm[];
  organizer: Participant | null;
  attendees: Participant[];
  myStatus: string | null;
  readOnly: boolean;
  created: string | null;
  modified: string | null;
}

export interface EventCalendar {
  id: string;
  title: string;
  account: string;
  type: string;
  color: string | null;
  isDefault: boolean;
  readOnly: boolean;
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function weekday(day: string): string {
  return WEEKDAY_LABELS[parseLocal(day.slice(0, 10)).getDay()];
}

export function eventStart(e: CalendarEvent): Date {
  return parseLocal(e.start);
}

export function eventEnd(e: CalendarEvent): Date {
  return e.allDay ? parseLocal(addDays(e.end, 1)) : parseLocal(e.end);
}

/** Day order, all-day events first within a day as Calendar shows them, then start time. */
export function compareEvents(a: CalendarEvent, b: CalendarEvent): number {
  const byDay = a.start.slice(0, 10).localeCompare(b.start.slice(0, 10));
  if (byDay !== 0) return byDay;
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  return a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.title.localeCompare(b.title);
}

export function matchesSearch(e: CalendarEvent, search: string): boolean {
  const needle = search.trim().toLowerCase();
  const people = [e.organizer, ...e.attendees].filter(Boolean).map((p) => `${p!.name} ${p!.email ?? ""}`);
  const haystack = [e.title, e.location ?? "", e.notes ?? "", ...people].join("\n").toLowerCase();
  return haystack.includes(needle);
}

/**
 * An event blocks time unless it is free, canceled, or declined. All-day events
 * (holidays, birthdays, trips) only block when explicitly marked busy.
 */
export function isBlocking(e: CalendarEvent): boolean {
  if (e.status === "canceled" || e.myStatus === "declined" || e.availability === "free") return false;
  if (e.allDay) return e.availability === "busy" || e.availability === "unavailable";
  return true;
}

export interface FreeSlot {
  day: string;
  start: Date;
  end: Date;
}

export interface FreeTimeOptions {
  days: string[];
  /** `HH:MM` */
  dayStart: string;
  dayEnd: string;
  minMinutes: number;
  now: Date;
}

export function findFreeSlots(events: CalendarEvent[], opts: FreeTimeOptions): FreeSlot[] {
  const busy = events
    .filter(isBlocking)
    .map((e) => ({ start: eventStart(e), end: eventEnd(e) }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  // Nothing before now is bookable; round up to the next five minutes.
  const step = 5 * 60_000;
  const earliest = new Date(Math.ceil(opts.now.getTime() / step) * step);

  const slots: FreeSlot[] = [];
  for (const day of opts.days) {
    const windowEnd = parseLocal(`${day}T${opts.dayEnd}`);
    let cursor = parseLocal(`${day}T${opts.dayStart}`);
    if (cursor < earliest) cursor = earliest;

    const push = (end: Date) => {
      if (end.getTime() - cursor.getTime() >= opts.minMinutes * 60_000) slots.push({ day, start: cursor, end });
    };
    for (const b of busy) {
      if (cursor >= windowEnd) break;
      if (b.end <= cursor || b.start >= windowEnd) continue;
      if (b.start > cursor) push(b.start);
      if (b.end > cursor) cursor = b.end;
    }
    if (cursor < windowEnd) push(windowEnd);
  }
  return slots;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function clock(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function duration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** "09:00–10:30", "all day", or a span that crosses days. */
export function describeTime(e: CalendarEvent): string {
  if (e.allDay) return e.end !== e.start ? `all day through ${weekday(e.end)} ${e.end}` : "all day";
  const sameDay = e.start.slice(0, 10) === e.end.slice(0, 10);
  const end = sameDay ? e.end.slice(11) : `${weekday(e.end)} ${e.end.replace("T", " ")}`;
  return `${e.start.slice(11)}–${end}`;
}

export function describeWhen(e: CalendarEvent, now: Date): string {
  const day = e.start.slice(0, 10);
  const today = localDay(now);
  const tag = day === today ? " (today)" : day === addDays(today, 1) ? " (tomorrow)" : "";
  return `${weekday(day)} ${day}${tag} · ${describeTime(e)}`;
}

/** All-day alerts count back from midnight, so 900 minutes before is 09:00 the day before. */
function describeAllDayAlarm(minutesBefore: number): string {
  const daysBack = Math.ceil(minutesBefore / 1440);
  const at = daysBack * 1440 - minutesBefore;
  const when = daysBack === 0 ? "the day of" : daysBack === 1 ? "the day before" : `${daysBack} days before`;
  return `${pad(Math.floor(at / 60))}:${pad(at % 60)} ${when}`;
}

function describeEventAlarm(a: Alarm, allDay: boolean): string {
  switch (a.type) {
    case "absolute":
      return `at ${a.at?.replace("T", " ")}`;
    case "relative":
      if (allDay) return describeAllDayAlarm(a.minutesBefore ?? 0);
      return a.minutesBefore === 0
        ? "at start"
        : (a.minutesBefore ?? 0) < 0
          ? `${duration(-(a.minutesBefore ?? 0))} after start`
          : `${duration(a.minutesBefore ?? 0)} before`;
    case "location":
      return `${a.proximity} ${a.title}`;
  }
}

function describeParticipant(p: Participant): string {
  const who = p.name && p.email && p.name !== p.email ? `${p.name} <${p.email}>` : p.name || p.email || "unknown";
  const extras = [
    p.status,
    p.role !== "required" && p.role !== "unknown" ? p.role : null,
    p.type !== "person" && p.type !== "unknown" ? p.type : null,
    p.isMe ? "you" : null,
  ];
  return `${who} · ${extras.filter(Boolean).join(" · ")}`;
}

/** Compact line for agendas: enough to recognise an event and act on it. */
export function renderEventLine(e: CalendarEvent, opts: { showCalendar: boolean }): string {
  const parts = [`${describeTime(e)}  ${e.title || "(no title)"}`];
  if (e.status === "canceled") parts.push("CANCELED");
  if (e.location) parts.push(`@ ${oneLine(e.location, 60)}`);
  if (opts.showCalendar) parts.push(e.calendar);
  if (e.recurrence) parts.push(describeRecurrence(e.recurrence));
  else if (e.detached) parts.push("edited occurrence of a repeating event");
  if (e.attendees.length) {
    parts.push(`${e.attendees.length} attendee${e.attendees.length === 1 ? "" : "s"}${e.myStatus ? ` (you: ${e.myStatus})` : ""}`);
  }
  if (e.availability === "free" && !e.allDay) parts.push("shown as free");
  if (e.availability === "tentative") parts.push("tentative");
  parts.push(`id: ${e.id}`);
  return parts.join(" · ");
}

/** Everything the store holds for one event. */
export function renderEventDetail(e: CalendarEvent, now: Date): string {
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const lines = [
    `${e.title || "(no title)"}${e.status === "canceled" ? " — CANCELED" : ""}`,
    `id: ${e.id}`,
    `calendar: ${e.calendar} (id ${e.calendarId})${e.readOnly ? " · read-only" : ""}`,
    `when: ${describeWhen(e, now)}`,
  ];
  if (e.timeZone && !e.allDay && e.timeZone !== localZone) {
    lines.push(`time zone: ${e.timeZone} (times above are in this Mac's ${localZone})`);
  }
  if (e.location) lines.push(`location: ${e.location}`);
  if (e.recurrence) {
    lines.push(`recurrence: ${describeRecurrence(e.recurrence)}${e.detached ? " · this occurrence was edited separately" : ""}`);
  } else if (e.detached) {
    lines.push(`recurrence: occurrence of a repeating event, edited separately (originally ${e.occurrence?.replace("T", " ")})`);
  }
  lines.push(`availability: ${e.availability.replace("_", " ")}`);
  if (e.alarms.length) lines.push(`alerts: ${e.alarms.map((a) => describeEventAlarm(a, e.allDay)).join("; ")}`);
  if (e.organizer) lines.push(`organizer: ${describeParticipant(e.organizer)}`);
  if (e.attendees.length) {
    lines.push(`attendees (${e.attendees.length}):`, ...e.attendees.map((p) => `  - ${describeParticipant(p)}`));
  }
  if (e.url) lines.push(`url: ${e.url}`);
  if (e.created) lines.push(`created: ${e.created.replace("T", " ")}`);
  if (e.modified) lines.push(`modified: ${e.modified.replace("T", " ")}`);
  lines.push(e.notes?.trim() ? `notes:\n${e.notes}` : "notes: none");
  return lines.join("\n");
}
