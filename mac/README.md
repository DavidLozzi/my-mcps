# mac — macOS ecosystem MCP server

Local stdio MCP server giving Claude access to the apps on your Mac. It starts with **Reminders**;
Calendar, Contacts, and Notes are natural next additions under the same server.

Reminders are read and written through EventKit, the same framework the Reminders app uses, so
changes sync to your iPhone and other devices through iCloud (or whichever account owns the list).
It does not script the Reminders app, so it is fast (a full fetch of a few hundred reminders takes
about a tenth of a second) and works whether or not the app is open.

## Tools

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
- **Not reachable through EventKit:** flags, tags, subtasks, sections, smart lists, and images. Custom
  repeat rules built in the app ("every weekday") are shown as custom and replaced wholesale if you
  set `recurrence`. Location alerts are shown and preserved but cannot be created.

## Setup

Needs macOS 14 or later, Node 20+, and the Xcode command line tools (`xcode-select --install`) for
`swiftc`.

```bash
cd mac
npm install
npm run build        # compiles the TypeScript and the Swift helper into dist/
npm run authorize    # triggers the macOS Reminders permission prompt
```

### Permission

macOS grants Reminders access to the **app that launched the server**, not to the server itself:
your terminal (Terminal, iTerm, Ghostty…) when using Claude Code, or Claude when using the desktop
app. Run `npm run authorize` from that same app so the prompt appears and is answered up front,
rather than stalling the first tool call.

If access was denied, re-enable it in **System Settings → Privacy & Security → Reminders**, then
restart the MCP server. Tools report a denial with those same instructions.

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
nothing else. Due-window filtering, ordering, and all text output live in TypeScript, where they are
tested without touching real Reminders. `helper/Info.plist` is linked into the binary so macOS has
the usage description it requires before showing the permission prompt.

| Variable | Purpose |
|---|---|
| `MAC_HELPER_PATH` | Use a different helper binary. The tests point this at `test/stub-helper.mjs`. |

## Tests

```bash
npm test
```

Runs entirely offline against a stub helper — nothing reads or changes your reminders.

- `test/smoke.mjs` — tool contract, annotations (only delete is destructive), missing and crashed
  helper paths, date validation.
- `test/e2e.mjs` — due windows computed against the real clock, agenda ordering, grouping, search,
  the 30-day completed bound, null-means-clear patches, repeating-reminder completion, and the
  access-denied message.
