#!/usr/bin/env node
/**
 * Stand-in for dist/mac-helper so tests run without Reminders access. Speaks
 * the same stdin/stdout protocol, serves fixtures from STUB_FIXTURES, and
 * appends every call to STUB_LOG so tests can assert what the server sent.
 *
 * STUB_MODE=denied answers every command as a TCC denial; STUB_MODE=crash
 * exits non-zero with stderr, as a helper killed by the OS would.
 */
import { appendFileSync, readFileSync } from "node:fs";

const command = process.argv[2];
const input = JSON.parse(readFileSync(0, "utf8") || "{}");
if (process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, JSON.stringify({ command, input }) + "\n");

const reply = (payload) => {
  process.stdout.write(JSON.stringify(payload) + "\n");
  process.exit(0);
};
const fail = (code, message) => reply({ ok: false, code, message });

if (process.env.STUB_MODE === "crash") {
  process.stderr.write("dyld: Symbol not found: _EKEventStore\n");
  process.exit(134);
}
if (process.env.STUB_MODE === "denied" && command !== "status") {
  fail("access_denied", "Reminders access is denied.");
}

const { lists, reminders } = JSON.parse(readFileSync(process.env.STUB_FIXTURES, "utf8"));

const resolveList = (ref) => {
  const byId = lists.find((l) => l.id === ref);
  if (byId) return byId;
  const matches = lists.filter((l) => l.title.toLowerCase() === ref.toLowerCase());
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) fail("list_not_found", `No reminder list named "${ref}".`);
  fail("ambiguous_list", `${matches.length} lists are named "${ref}".`);
};

const find = (id) => reminders.find((r) => r.id === id) ?? fail("not_found", `No reminder with id ${id}.`);

switch (command) {
  case "status":
    reply({ ok: true, data: { reminders: process.env.STUB_MODE === "denied" ? "denied" : "full_access" } });
  case "lists":
    reply({ ok: true, data: lists });
  case "fetch": {
    const listIds = input.lists?.map((ref) => resolveList(ref).id);
    const status = input.status ?? "incomplete";
    const data = reminders.filter(
      (r) =>
        (!listIds || listIds.includes(r.listId)) &&
        (status === "all" || r.completed === (status === "completed")) &&
        (!r.completed || !input.completedAfter || r.completedAt.slice(0, 10) >= input.completedAfter),
    );
    reply({ ok: true, data });
  }
  case "get":
    reply({ ok: true, data: find(input.id) });
  case "create": {
    const list = input.list ? resolveList(input.list) : lists.find((l) => l.isDefault);
    reply({
      ok: true,
      data: {
        id: "NEW-ID",
        title: input.title,
        list: list.title,
        listId: list.id,
        completed: false,
        priority: input.priority ?? "none",
        notes: input.notes ?? null,
        url: input.url ?? null,
        due: input.due ?? null,
        completedAt: null,
        created: "2026-01-01T09:00",
        modified: "2026-01-01T09:00",
        alarms: input.due?.includes("T") ? [{ type: "absolute", at: input.due }] : [],
        recurrence: input.recurrence ?? null,
      },
    });
  }
  case "update": {
    const { id, ...fields } = input;
    reply({ ok: true, data: { ...find(id), ...fields } });
  }
  case "set_completed": {
    const found = input.ids.map(find);
    reply({
      ok: true,
      data: found.map((r) =>
        // Mirror EventKit: a repeating reminder stays open with its next due date.
        r.recurrence && input.completed ? { ...r, due: "2099-01-01" } : { ...r, completed: input.completed },
      ),
    });
  }
  case "delete":
    reply({ ok: true, data: input.ids.map(find) });
  case "create_list":
    reply({ ok: true, data: { id: "NEW-LIST", title: input.title, account: input.account ?? "iCloud" } });
  default:
    fail("invalid_input", `Unknown command "${command}".`);
}
