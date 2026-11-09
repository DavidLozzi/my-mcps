# mac — macOS ecosystem MCP server

Local stdio MCP server giving Claude access to the apps on your Mac: **Reminders** and **Calendar**.
Contacts and Notes are natural next additions under the same server.

Both are read and written through EventKit, the same framework the Reminders and Calendar apps use,
so changes sync to your iPhone and other devices through iCloud, Exchange, Google, or whichever
account owns the list or calendar. It does not script the apps, so it is fast (a full fetch of a few
hundred reminders takes about a tenth of a second) and works whether or not they are open.

## Reminders tools

| Tool | Does |
|---|---|
| `reminders_list_lists` | Every list with open counts, the default list, account, and id |
| `reminders_list` | Find reminders by list, due window, completion, and text |
| `reminders_get` | Full detail for one reminder — notes, alerts, repeat rule, url |
| `reminders_create` | Add a reminder with due date, priority, notes, alerts, repeat |
| `reminders_update` | Patch fields; `null` clears one; `list` moves it |
| `reminders_complete` | Tick off (or reopen) a batch |
| `reminders_delete` | Permanently delete a batch — the only destructive tool |
| `reminders_create_list` | Add a new list |

`reminders_list` takes a `due` window — `overdue`, `today`, `today_and_overdue`, `tomorrow`,
`next_7_days`, `scheduled`, `no_due_date` — evaluated against the Mac's clock. Open reminders sort
like an agenda, soonest first; completed ones sort most recent first and default to the last 30 days.

### Dates

`YYYY-MM-DD` is an all-day reminder; `YYYY-MM-DDTHH:MM` is a specific time in the Mac's local time
zone. Setting a time also adds an alert at that moment, as the Reminders app does, unless you pass
`alarms` explicitly (`[]` for none). Changing a timed due date moves that alert with it.

### Behaviour worth knowing

- **List names are not unique.** Two accounts, or even one, can each have a "Timeline" list. A name
  that matches more than one list is rejected with every candidate's id.
- **Batches are all-or-nothing.** `reminders_complete` and `reminders_delete` resolve every id before
  changing anything.
- **Completing a repeating reminder** logs a completed copy and moves the original to its next due
  date, exactly as the app does. Deleting one removes the whole series.
- **Not reachable through EventKit:** flags, tags, subtasks, sections, smart lists, and images. Weekly
  repeats on chosen days (`daysOfWeek`) round-trip; subtler rules built in the app ("last Friday of
  the month") are shown as custom and replaced wholesale if you set `recurrence`. Location alerts are
  shown and preserved but cannot be created.

## Calendar tools

| Tool | Does |
|---|---|
| `calendar_list_calendars` | Every calendar by account, with type, color, default, read-only, and id |
| `calendar_list_events` | Events in a range (default the next 7 days), grouped by day, repeats expanded |
| `calendar_get_event` | Full detail — attendees and responses, organizer, alerts, repeat rule, notes |
| `calendar_find_free_time` | Open slots inside working hours across a run of days |
| `calendar_create_event` | Add a timed or all-day event with location, alerts, repeat, time zone |
| `calendar_update_event` | Patch fields; `null` clears one; `calendar` moves it; `span` for repeats |
| `calendar_delete_events` | Permanently delete a batch of events (destructive) |
| `calendar_create_calendar` | Add a calendar to an account, optionally with a color |
| `calendar_delete_calendar` | Delete a calendar and everything on it (destructive) |

### Behaviour worth knowing

- **A repeating event's id names one occurrence.** Every occurrence shares EventKit's event id, so the
  server appends the occurrence's original start (`<id>::2026-11-10T09:30`). Updates and deletes take
  `span`: `this` (default) for that occurrence, `future` for it and everything after. Pass the first
  occurrence with `future` to change or remove the whole series.
- **All-day events** use `YYYY-MM-DD`; `end` is the last day, inclusive. A timed event with no `end`
  lasts an hour, and moving `start` alone keeps the event's length.
- **Time zones.** Listings show times in the Mac's zone. `timeZone` on create/update says which zone
  `start` and `end` are written in, for a flight or a meeting elsewhere.
- **Free time** counts timed events as busy unless they are shown as free, canceled, or declined.
  All-day events (holidays, trips, birthdays) block only when marked busy.
- **Not reachable through EventKit:** adding or removing attendees, sending invitations, and
  responding to them (accept/decline). Attendees, the organizer, and your response are shown
  read-only. Edits to an invitation someone else organized stay on your calendar and may be
  overwritten by the organizer.

## Setup

Needs macOS 14 or later, Node 20+, and the Xcode command line tools (`xcode-select --install`) for
`swiftc`.

```bash
cd mac
npm install
npm run build        # compiles the TypeScript and the Swift helper into dist/
npm run authorize    # triggers the macOS Reminders and Calendar permission prompts
```

### Permission

Reminders and Calendar are separate permissions, both granted to **mac-helper** itself. macOS
normally charges access to whichever app launched a process, and Claude.app declares no Calendar
or Reminders usage text, so requests made on its behalf are refused without a prompt. The helper
therefore relaunches itself with responsibility disclaimed, becoming its own app with the usage
text in `helper/Info.plist`. One grant then works from Claude Desktop, Claude Code, or any terminal.

Run `npm run authorize` once from any terminal and click Allow on both dialogs. The grant is tied
to the helper's ad-hoc signature, so if a rebuild ever makes tools report access as
`not_determined` or denied, run it again.

If access was denied, re-enable **mac-helper** in **System Settings → Privacy & Security →
Reminders** (or **Calendars**), then restart the MCP server. Tools report a denial with those same instructions.

### Register with Claude Code

`.mcp.json` at the repo root already registers it inside this repo. To use it everywhere:

```bash
claude mcp add mac -- node /absolute/path/to/my-mcps/mac/dist/index.js
```

## How it works

```
Claude ──stdio── node dist/index.js ──spawn per call── dist/mac-helper (Swift, EventKit)
                 (validation, filtering,                (read/write the store,
                  sorting, rendering)                    JSON in on stdin, JSON out)
```

The Swift helper (`helper/main.swift`) is deliberately thin: it reads and writes the store and
nothing else. Due-window filtering, free-time arithmetic, ordering, and all text output live in
TypeScript, where they are tested without touching real Reminders or Calendar. `helper/Info.plist` is linked into the binary so macOS has
the usage description it requires before showing the permission prompt.

| Variable | Purpose |
|---|---|
| `MAC_HELPER_PATH` | Use a different helper binary. The tests point this at `test/stub-helper.mjs`. |

## Tests

```bash
npm test
```

Runs entirely offline against a stub helper — nothing reads or changes your reminders or events.

- `test/smoke.mjs` — tool contract, annotations (only delete is destructive), missing and crashed
  helper paths, date validation.
- `test/e2e.mjs` — due windows computed against the real clock, agenda ordering, grouping, search,
  the 30-day completed bound, null-means-clear patches, repeating-reminder completion, and the
  access-denied message.
- `test/calendar.mjs` — default range, day grouping, occurrence ids, search by location and attendee,
  free-time rules (declined, canceled, free, all-day), `span` defaults, null-means-clear, and the
  Calendars access-denied message.
