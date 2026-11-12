# zoho — Zoho Mail MCP server

Local stdio MCP server giving Claude your Zoho Mail over **IMAP** (read, search, organize) and
**SMTP** (send, reply, forward). Several accounts can be configured side by side.

Changes are real: they show up in Zoho's web and phone apps, and sent mail cannot be recalled.
The server's instructions tell Claude to confirm before sending and to prefer Trash over
permanent deletion; every send tool also takes `saveAsDraft: true` so you can review in Zoho.

## Setup

1. **Plan.** IMAP/SMTP needs Zoho Mail Lite or higher — the Forever Free plan does not include it.
2. **Turn on IMAP.** Zoho Mail > Settings > Mail Accounts > your address > IMAP > enable.
3. **Make an app password.** accounts.zoho.com > Security > App Passwords > generate one (name it
   "Claude MCP"). Your normal password is refused when two-factor sign-in is on, and an app
   password can be revoked on its own.
4. **Build and add the account:**

   ```bash
   cd zoho
   npm install
   npm run auth        # prompts for address, name, display name, app password
   ```

   `npm run auth` logs in over IMAP and SMTP before saving, then writes
   `zoho/.credentials/accounts.json` (directory `700`, file `600`, gitignored). Run it again to add
   another account or replace a password; `--default` makes the account the default.

   Scripted form: `echo "$APP_PASSWORD" | node dist/auth-cli.js --email me@zoho.com --name personal`.

5. Restart Claude Code. `.mcp.json` at the repo root registers the server, or register globally:
   `claude mcp add zoho -- node /absolute/path/to/my-mcps/zoho/dist/index.js`.

### accounts.json

```json
[
  {
    "name": "personal",
    "email": "me@zoho.com",
    "appPassword": "…",
    "fromName": "My Name",
    "aliases": ["me@mydomain.com"],
    "default": true
  }
]
```

Optional per account: `imapHost`, `imapPort` (993), `smtpHost`, `smtpPort` (465; 587 uses
STARTTLS). Hosts default to `imap.zoho.com` / `smtp.zoho.com`; `npm run auth` picks
`imappro`/`smtppro` for custom-domain addresses. Other data centers use `imap.zoho.eu`,
`.in`, `.com.au` and so on. `aliases` are extra addresses that count as "me", so reply-all
leaves them out.

## Tools

Every tool takes an optional `account` (name or address); omit it for the default. Message ids
come from list/search results and encode account, folder, and UIDVALIDITY, so an id from before a
move fails loudly instead of pointing at the wrong message. Moves return the new ids.

### Accounts and folders

| Tool | Does |
|---|---|
| `email_list_accounts` | Configured accounts; `check: true` tests each login |
| `email_list_folders` | Folder tree with roles (inbox, sent, drafts, trash, spam, archive), totals, unread |
| `email_create_folder` | New folder, optionally inside a parent |
| `email_rename_folder` | Rename and/or move under another parent |
| `email_delete_folder` | Delete a folder **and its messages** (destructive) |
| `email_quota` | Storage used of quota |

Folder parameters accept an exact path, a folder name in any case, or a role (`sent`, `spam`, …).

### Reading

| Tool | Does |
|---|---|
| `email_mailbox_summary` | Unread per folder, top unread senders, oldest unread, flagged count |
| `email_list` | A folder newest first, paged; `unreadOnly` |
| `email_search` | From/to/cc/subject/body/text, date range, unread/flagged/replied, attachment, keyword, size; one folder or `allFolders` |
| `email_get` | Headers, body as text (HTML converted), attachments, unsubscribe availability; does not mark read unless `markRead` |
| `email_get_thread` | The whole conversation across Inbox, Sent, Archive, oldest first, quoted history stripped |
| `email_get_raw` | Raw source or header block (delivery/SPF/DKIM debugging) |
| `email_download_attachment` | Save one or all attachments (default `~/Downloads`), never overwriting |

### Organizing

| Tool | Does |
|---|---|
| `email_mark` | Read/unread, flagged, replied — batches up to 500 |
| `email_set_keywords` | Add/remove custom IMAP keywords |
| `email_move` / `email_copy` | To any folder |
| `email_archive` | To Archive (created if missing) |
| `email_trash` | To Trash — the normal "delete" |
| `email_mark_spam` / `email_not_spam` | To Spam / back to Inbox |
| `email_delete_permanently` | Erase now, no Trash (destructive) |
| `email_empty_folder` | Empty Trash or Spam; previews unless `confirm: true` (destructive) |
| `email_bulk_action` | Read/unread/flag/unflag/archive/trash/spam/move every search match; previews unless `confirm: true` |

### Sending

| Tool | Does |
|---|---|
| `email_send` | New message: to/cc/bcc, text and optional HTML, file attachments, priority, reply-to, send-as alias |
| `email_reply` | Reply or reply-all, threaded, quoted, marks the original replied |
| `email_forward` | Forward with a note; original attachments included |
| `email_save_draft` / `email_update_draft` / `email_send_draft` | Draft workflow; drafts keep Bcc |
| `email_unsubscribe` | RFC 8058 one-click, else the list's mailto; web-only links are returned, never visited |

The bytes sent over SMTP are the same bytes filed in Sent. Zoho normally files SMTP mail in Sent
itself; the server checks for the Message-ID afterwards and appends a copy only if it is missing,
so Sent never lacks the message or holds it twice.

## Behaviour worth knowing

- **Search is server-side substring matching**, as IMAP defines it. There is no Gmail-style query
  syntax. `hasAttachment` is narrowed on the server and confirmed from each message's structure.
- **Labels/tags in Zoho's web app are not exposed over IMAP.** Folders are the portable way to
  organize; IMAP keywords work for searching but may not show in Zoho's UI.
- **Connections are pooled** per account and closed after five idle minutes. A dropped connection
  reconnects on the next call.
- **Reading never marks mail read** — folders are opened with EXAMINE for reads.

## Tests

```bash
npm test             # smoke (contract), lib (pure functions), e2e (mock IMAP + SMTP over TLS)
npm run test:live    # real account: read, send to self, confirm Inbox + Sent, trash both
npm run test:live -- --read-only
```

The e2e suite runs the real server against [hoodiecrow](https://github.com/postalsys/hoodiecrow-imap)
and `smtp-server` on localhost; nothing touches Zoho.
