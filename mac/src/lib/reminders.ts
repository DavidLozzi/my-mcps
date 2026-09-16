/**
 * Filtering, ordering, and rendering for reminders. The helper hands back raw
 * store contents; everything a person would call "what's due" is decided here,
 * against the local clock, where it can be tested without EventKit.
 */

export interface Alarm {
  type: "absolute" | "relative" | "location";
  at?: string;
  minutesBefore?: number;
  title?: string;
  proximity?: string;
}

export interface Recurrence {
  frequency: string;
  interval: number;
  until?: string;
  count?: number;
  custom?: boolean;
}

export interface Reminder {
  id: string;
  title: string;
  list: string;
  listId: string;
  completed: boolean;
  priority: "none" | "low" | "medium" | "high";
  notes: string | null;
  url: string | null;
  /** `YYYY-MM-DD` when all-day, `YYYY-MM-DDTHH:MM` in local time otherwise. */
  due: string | null;
  completedAt: string | null;
  created: string | null;
  modified: string | null;
  alarms: Alarm[];
  recurrence: Recurrence | null;
}

export interface ReminderList {
  id: string;
  title: string;
  account: string;
  openCount: number;
  isDefault: boolean;
  readOnly: boolean;
}

export const DUE_FILTERS = [
  "any",
  "overdue",
  "today",
  "today_and_overdue",
  "tomorrow",
  "next_7_days",
  "scheduled",
  "no_due_date",
] as const;

export type DueFilter = (typeof DUE_FILTERS)[number];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PRIORITY_RANK: Record<Reminder["priority"], number> = { high: 0, medium: 1, low: 2, none: 3 };

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return localDay(new Date(y, m - 1, d + days));
}

/** Local wall-clock parse. `new Date("2026-09-16")` would read it as UTC. */
export function parseLocal(stamp: string): Date {
  const [day, time] = stamp.split("T");
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = (time ?? "00:00").split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm);
}

function dueDay(r: Reminder): string | null {
  return r.due ? r.due.slice(0, 10) : null;
}

export function isOverdue(r: Reminder, now: Date): boolean {
  if (r.completed || !r.due) return false;
  // An all-day reminder is not late until its whole day has passed.
  return r.due.includes("T") ? parseLocal(r.due) < now : r.due < localDay(now);
}

export interface FilterOptions {
  due: DueFilter;
  dueAfter?: string;
  dueBefore?: string;
  search?: string;
}

export function filterReminders(reminders: Reminder[], opts: FilterOptions, now: Date): Reminder[] {
  const today = localDay(now);
  const tomorrow = addDays(today, 1);
  const weekEnd = addDays(today, 6);
  const needle = opts.search?.trim().toLowerCase();

  return reminders.filter((r) => {
    const day = dueDay(r);

    switch (opts.due) {
      case "overdue":
        if (!isOverdue(r, now)) return false;
        break;
      case "today":
        if (day !== today) return false;
        break;
      case "today_and_overdue":
        if (day !== today && !isOverdue(r, now)) return false;
        break;
      case "tomorrow":
        if (day !== tomorrow) return false;
        break;
      case "next_7_days":
        if (!day || day < today || day > weekEnd) return false;
        break;
      case "scheduled":
        if (!day) return false;
        break;
      case "no_due_date":
        if (day) return false;
        break;
      case "any":
        break;
    }

    // Explicit bounds are inclusive whole days and imply a due date exists.
    if (opts.dueAfter && (!day || day < opts.dueAfter)) return false;
    if (opts.dueBefore && (!day || day > opts.dueBefore)) return false;

    if (needle) {
      const haystack = `${r.title}\n${r.notes ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

/**
 * Open reminders read like an agenda: dated first by due time (all-day items
 * ahead of timed ones on the same day, as the Reminders app shows them), then
 * by priority. Completed reminders read like a log: most recent first.
 */
export function compareReminders(a: Reminder, b: Reminder): number {
  if (a.completed !== b.completed) return a.completed ? 1 : -1;

  if (a.completed) {
    return (b.completedAt ?? "").localeCompare(a.completedAt ?? "");
  }

  if (a.due && !b.due) return -1;
  if (!a.due && b.due) return 1;
  if (a.due && b.due && a.due !== b.due) {
    const dayOrder = a.due.slice(0, 10).localeCompare(b.due.slice(0, 10));
    if (dayOrder !== 0) return dayOrder;
    return a.due.length - b.due.length || a.due.localeCompare(b.due);
  }

  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (byPriority !== 0) return byPriority;
  return (a.created ?? "").localeCompare(b.created ?? "");
}

export function describeDue(r: Reminder, now: Date): string {
  if (!r.due) return "";
  const day = r.due.slice(0, 10);
  const time = r.due.includes("T") ? ` ${r.due.slice(11, 16)}` : "";
  const weekday = WEEKDAYS[parseLocal(r.due).getDay()];

  const today = localDay(now);
  const tags: string[] = [];
  if (day === today) tags.push("today");
  else if (day === addDays(today, 1)) tags.push("tomorrow");
  if (isOverdue(r, now)) tags.push("overdue");

  return `due ${weekday} ${day}${time}${tags.length ? ` (${tags.join(", ")})` : ""}`;
}

export function describeRecurrence(rule: Recurrence): string {
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[rule.frequency] ?? rule.frequency;
  let text = rule.interval === 1 ? `repeats every ${unit}` : `repeats every ${rule.interval} ${unit}s`;
  if (rule.until) text += ` until ${rule.until.slice(0, 10)}`;
  if (rule.count) text += ` for ${rule.count} times`;
  if (rule.custom) text += " (custom rule — details not shown)";
  return text;
}

function describeAlarm(alarm: Alarm): string {
  switch (alarm.type) {
    case "absolute":
      return `alert ${alarm.at?.replace("T", " ")}`;
    case "relative":
      return alarm.minutesBefore === 0 ? "alert at due time" : `alert ${alarm.minutesBefore}m before due`;
    case "location":
      return `alert ${alarm.proximity} ${alarm.title}`;
  }
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A timed due date gets an alert at that exact moment; restating it is noise. */
function interestingAlarms(r: Reminder): Alarm[] {
  return r.alarms.filter((a) => !(a.type === "absolute" && r.due?.includes("T") && a.at === r.due));
}

/** Compact line for lists: everything needed to pick a reminder and act on it. */
export function renderLine(r: Reminder, now: Date, opts: { showList: boolean }): string {
  const parts = [`${r.completed ? "[x]" : "[ ]"} ${r.title}`];
  const due = describeDue(r, now);
  if (due) parts.push(due);
  if (r.priority !== "none") parts.push(`${r.priority} priority`);
  if (r.recurrence) parts.push(describeRecurrence(r.recurrence));
  if (r.completed && r.completedAt) parts.push(`done ${r.completedAt.replace("T", " ")}`);
  if (opts.showList) parts.push(`list: ${r.list}`);
  parts.push(`id: ${r.id}`);

  let text = parts.join(" · ");
  if (r.notes?.trim()) text += `\n    notes: ${oneLine(r.notes, 140)}`;
  return text;
}

/** Everything the store holds for one reminder. */
export function renderDetail(r: Reminder, now: Date): string {
  const lines = [
    `${r.completed ? "[x]" : "[ ]"} ${r.title}`,
    `id: ${r.id}`,
    `list: ${r.list} (id ${r.listId})`,
    `status: ${r.completed ? `completed ${r.completedAt?.replace("T", " ") ?? ""}`.trim() : "open"}`,
    `due: ${r.due ? describeDue(r, now).replace(/^due /, "") : "none"}`,
    `priority: ${r.priority}`,
  ];
  if (r.recurrence) lines.push(`recurrence: ${describeRecurrence(r.recurrence)}`);
  const alarms = interestingAlarms(r);
  if (r.alarms.length) {
    lines.push(`alerts: ${alarms.length ? alarms.map(describeAlarm).join("; ") : "at due time"}`);
  }
  if (r.url) lines.push(`url: ${r.url}`);
  if (r.created) lines.push(`created: ${r.created.replace("T", " ")}`);
  if (r.modified) lines.push(`modified: ${r.modified.replace("T", " ")}`);
  lines.push(r.notes?.trim() ? `notes:\n${r.notes}` : "notes: none");
  return lines.join("\n");
}
