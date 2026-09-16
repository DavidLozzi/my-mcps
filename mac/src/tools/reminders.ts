import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runHelper } from "../helper.js";
import { guard, ok } from "../lib/tool.js";
import {
  DUE_FILTERS,
  addDays,
  compareReminders,
  filterReminders,
  localDay,
  renderDetail,
  renderLine,
  type Reminder,
  type ReminderList,
} from "../lib/reminders.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DUE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/;

const dayField = z.string().regex(DAY, "Use YYYY-MM-DD.");

const dueField = z
  .string()
  .regex(DUE, "Use YYYY-MM-DD for an all-day reminder or YYYY-MM-DDTHH:MM for a specific local time.")
  .describe(
    "YYYY-MM-DD for an all-day reminder, or YYYY-MM-DDTHH:MM in the Mac's local time. A time also adds an alert " +
      "at that moment, as the Reminders app does, unless alarms is given.",
  );

const listRefField = z
  .string()
  .min(1)
  .describe("List name (case-insensitive) or list id from reminders_list_lists.");

const priorityField = z.enum(["none", "low", "medium", "high"]);

const alarmField = z
  .array(
    z.union([
      z.object({ at: z.string().regex(DUE).describe("Alert at this local time, YYYY-MM-DDTHH:MM.") }),
      z.object({
        minutesBefore: z.number().int().min(0).describe("Alert this many minutes before the due time."),
      }),
    ]),
  )
  .describe("Time-based alerts. Replaces existing time alerts; location alerts set in the app are kept.");

const recurrenceField = z
  .object({
    frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().min(1).default(1).describe("Every N days/weeks/months/years."),
    until: dueField.optional().describe("Stop repeating after this date."),
    count: z.number().int().min(1).optional().describe("Stop after this many occurrences."),
  })
  .describe("Repeat schedule. Needs a due date, which anchors the first occurrence.");

const idsField = z.array(z.string().min(1)).min(1).max(100);

/** Drop undefined keys but keep null, which the helper reads as "clear this field". */
function patch(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function registerReminderTools(server: McpServer): void {
  server.registerTool(
    "reminders_list_lists",
    {
      title: "List reminder lists",
      description:
        "Every Reminders list on this Mac across iCloud and other accounts, with open-item counts, the default " +
        "list for new reminders, and ids. Names are not unique — two accounts can each have a list called " +
        "\"Groceries\" — so when a name is ambiguous, pass the id to other tools.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async () => {
      const lists = await runHelper<ReminderList[]>("lists");
      if (lists.length === 0) {
        return ok("No reminder lists. Reminders may not be set up on this Mac.");
      }

      const counts = new Map<string, number>();
      for (const l of lists) counts.set(l.title.toLowerCase(), (counts.get(l.title.toLowerCase()) ?? 0) + 1);

      const lines = lists.map((l) => {
        const flags = [
          l.isDefault ? "default" : null,
          l.readOnly ? "read-only" : null,
          (counts.get(l.title.toLowerCase()) ?? 0) > 1 ? "name shared — use id" : null,
        ].filter(Boolean);
        return (
          `${l.title} — ${plural(l.openCount, "open item")} · ${l.account}` +
          `${flags.length ? ` · ${flags.join(", ")}` : ""} · id: ${l.id}`
        );
      });

      const open = lists.reduce((sum, l) => sum + l.openCount, 0);
      return ok(`${plural(lists.length, "list")}, ${plural(open, "open reminder")}\n\n${lines.join("\n")}`);
    }),
  );

  server.registerTool(
    "reminders_list",
    {
      title: "Find reminders",
      description:
        "Reminders filtered by list, due window, completion, and text. Use due=today_and_overdue for \"what's on " +
        "my plate\", next_7_days for the week ahead, no_due_date for the unscheduled backlog, and search to find a " +
        "specific item before updating it. Open reminders sort like an agenda (soonest due first); completed ones " +
        "sort most recent first. Each line carries the id the other reminder tools need.",
      inputSchema: {
        lists: z
          .array(listRefField)
          .max(20)
          .optional()
          .describe("Only these lists (names or ids). Omit for every list."),
        status: z
          .enum(["incomplete", "completed", "all"])
          .default("incomplete")
          .describe("Completed reminders are bounded by completedSince."),
        due: z.enum(DUE_FILTERS).default("any").describe("Due-date window, relative to now on this Mac."),
        dueAfter: dayField.optional().describe("Due on or after this day (inclusive)."),
        dueBefore: dayField.optional().describe("Due on or before this day (inclusive)."),
        search: z.string().min(1).optional().describe("Case-insensitive match against title and notes."),
        completedSince: dayField
          .optional()
          .describe("For completed/all: only reminders completed on or after this day. Defaults to 30 days ago."),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ lists, status, due, dueAfter, dueBefore, search, completedSince, limit }) => {
      const now = new Date();
      // Years of completed reminders can run to thousands, so always bound them.
      const since = completedSince ?? addDays(localDay(now), -30);

      const fetched = await runHelper<Reminder[]>(
        "fetch",
        patch({ lists, status, completedAfter: status === "incomplete" ? undefined : since }),
      );
      const matched = filterReminders(fetched, { due, dueAfter, dueBefore, search }, now).sort(compareReminders);
      const shown = matched.slice(0, limit);

      const scope = [
        status === "incomplete" ? "open" : status === "completed" ? "completed" : "open and completed",
        due !== "any" ? `due: ${due}` : null,
        dueAfter ? `due on/after ${dueAfter}` : null,
        dueBefore ? `due on/before ${dueBefore}` : null,
        search ? `matching "${search}"` : null,
        lists ? `in ${lists.join(", ")}` : null,
        status !== "incomplete" ? `completed since ${since}` : null,
      ]
        .filter(Boolean)
        .join(" · ");

      if (matched.length === 0) {
        return ok(`No reminders (${scope}).`);
      }

      // Group by list when several are in play; a single list needs no headers.
      const multiList = new Set(shown.map((r) => r.listId)).size > 1;
      const groupByList = multiList && due === "any" && !dueAfter && !dueBefore && !search;
      let body: string;
      if (groupByList) {
        // Keyed by id: list names repeat across accounts.
        const groups = new Map<string, Reminder[]>();
        for (const r of shown) {
          groups.set(r.listId, [...(groups.get(r.listId) ?? []), r]);
        }
        body = [...groups.entries()]
          .map(([id, items]) => {
            const lines = items.map((r) => `  ${renderLine(r, now, { showList: false })}`).join("\n");
            return `${items[0].list} (list id ${id})\n${lines}`;
          })
          .join("\n\n");
      } else {
        // Across lists in a due window, agenda order matters more than grouping.
        body = shown.map((r) => renderLine(r, now, { showList: multiList })).join("\n");
      }

      const truncated =
        matched.length > shown.length
          ? `\n\nShowing ${shown.length} of ${matched.length}. Narrow with lists, due, or search, or raise limit.`
          : "";
      return ok(`${plural(matched.length, "reminder")} (${scope}) as of ${now.toString().slice(0, 21)}\n\n${body}${truncated}`);
    }),
  );

  server.registerTool(
    "reminders_get",
    {
      title: "Get a reminder",
      description:
        "Full detail for one reminder: untruncated notes, alerts, repeat rule, url, and timestamps. reminders_list " +
        "already shows the essentials, so call this only when the notes or schedule matter.",
      inputSchema: { id: z.string().min(1).describe("Reminder id from reminders_list.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ id }) => {
      const reminder = await runHelper<Reminder>("get", { id });
      return ok(renderDetail(reminder, new Date()));
    }),
  );

  server.registerTool(
    "reminders_create",
    {
      title: "Create a reminder",
      description:
        "Add a reminder. Without a list it goes to the default list shown by reminders_list_lists. Syncs to the " +
        "user's other devices through their Reminders account.",
      inputSchema: {
        title: z.string().min(1),
        list: listRefField.optional(),
        notes: z.string().optional(),
        due: dueField.optional(),
        priority: priorityField.optional(),
        url: z.string().url().optional(),
        alarms: alarmField.optional(),
        recurrence: recurrenceField.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guard(async (args) => {
      const reminder = await runHelper<Reminder>("create", patch(args));
      return ok(`Created in "${reminder.list}".\n\n${renderDetail(reminder, new Date())}`);
    }),
  );

  server.registerTool(
    "reminders_update",
    {
      title: "Update a reminder",
      description:
        "Change fields on one reminder. Omitted fields are left alone; pass null to clear notes, due, url, alarms, " +
        "or recurrence. Setting list moves it. Changing a timed due date moves its due-time alert with it. A " +
        "custom repeat rule built in the Reminders app (e.g. every weekday) is replaced wholesale if recurrence is " +
        "set, so check reminders_get first. To tick a reminder off use reminders_complete.",
      inputSchema: {
        id: z.string().min(1),
        title: z.string().min(1).optional(),
        list: listRefField.optional(),
        notes: z.string().nullable().optional(),
        due: dueField.nullable().optional(),
        priority: priorityField.optional(),
        url: z.string().url().nullable().optional(),
        alarms: alarmField.nullable().optional(),
        recurrence: recurrenceField.nullable().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(async (args) => {
      const { id, ...fields } = args;
      if (Object.values(fields).every((v) => v === undefined)) {
        return ok("Nothing to change — pass at least one field besides id.");
      }
      const reminder = await runHelper<Reminder>("update", { id, ...patch(fields) });
      return ok(`Updated.\n\n${renderDetail(reminder, new Date())}`);
    }),
  );

  server.registerTool(
    "reminders_complete",
    {
      title: "Complete reminders",
      description:
        "Mark one or more reminders done, or pass completed=false to reopen them. All ids are checked before " +
        "anything changes, so one bad id leaves the whole batch untouched. Completing a repeating reminder " +
        "advances it to its next occurrence.",
      inputSchema: {
        ids: idsField,
        completed: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(async ({ ids, completed }) => {
      const now = new Date();
      const updated = await runHelper<Reminder[]>("set_completed", { ids, completed });
      // EventKit completes a repeating reminder by logging a completed copy and
      // moving the original to its next due date, so the original stays open.
      const advanced = updated.filter((r) => completed && !r.completed);
      const done = updated.filter((r) => !advanced.includes(r));

      const sections: string[] = [];
      if (done.length) {
        sections.push(
          `${completed ? "Completed" : "Reopened"} ${plural(done.length, "reminder")}:\n` +
            done.map((r) => renderLine(r, now, { showList: true })).join("\n"),
        );
      }
      if (advanced.length) {
        sections.push(
          `Completed this occurrence of ${plural(advanced.length, "repeating reminder")}; each now shows its next ` +
            "due date (the finished occurrence is logged as a separate completed reminder):\n" +
            advanced.map((r) => renderLine(r, now, { showList: true })).join("\n"),
        );
      }
      return ok(sections.join("\n\n"));
    }),
  );

  server.registerTool(
    "reminders_delete",
    {
      title: "Delete reminders",
      description:
        "Permanently delete reminders, removing them from every synced device. There is no undo through this " +
        "server, and deleting a repeating reminder removes every future occurrence. Prefer reminders_complete for " +
        "finished items; delete only when the user asks for removal. All " +
        "ids are checked first, so one bad id deletes nothing.",
      inputSchema: { ids: idsField },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    guard(async ({ ids }) => {
      const now = new Date();
      const removed = await runHelper<Reminder[]>("delete", { ids });
      return ok(
        `Deleted ${plural(removed.length, "reminder")}:\n` +
          removed.map((r) => renderLine(r, now, { showList: true })).join("\n"),
      );
    }),
  );

  server.registerTool(
    "reminders_create_list",
    {
      title: "Create a reminder list",
      description:
        "Add a new Reminders list, in the default account unless account names another (e.g. \"iCloud\"). " +
        "List names need not be unique, so check reminders_list_lists before creating a likely duplicate.",
      inputSchema: {
        title: z.string().min(1),
        account: z.string().min(1).optional().describe("Account name as shown by reminders_list_lists."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guard(async (args) => {
      const list = await runHelper<{ id: string; title: string; account: string }>("create_list", patch(args));
      return ok(`Created list "${list.title}" in ${list.account} · id: ${list.id}`);
    }),
  );
}
