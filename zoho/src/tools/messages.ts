import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow, MailboxObject, SearchObject } from "imapflow";
import { z } from "zod";
import { resolveAccount, type Account } from "../config.js";
import { isSelectable, resolveFolder, withClient, withMailbox } from "../imap.js";
import { fetchSummaries, loadMessage } from "../mail.js";
import { ZohoError } from "../lib/errors.js";
import {
  attachmentInfo,
  bodyText,
  fmtDate,
  fmtParsedAddresses,
  renderDetail,
  renderList,
  stripQuoted,
  truncate,
  type Summary,
} from "../lib/render.js";
import { buildSearch, describeFilters, type SearchFilters } from "../lib/search.js";
import { guard, ok, plural } from "../lib/tool.js";
import { accountField, folderField, idField, maxCharsField, searchFields } from "./shared.js";

/** UIDs matching a query in the open mailbox, newest (highest UID) first. */
export async function searchUids(client: ImapFlow, query: SearchObject): Promise<number[]> {
  const uids = await client.search(query, { uid: true });
  return Array.isArray(uids) ? [...uids].sort((a, b) => b - a) : [];
}

/**
 * Page through matches newest first. hasAttachment can only be narrowed on the
 * server, so it keeps fetching until a page of confirmed matches is full.
 */
async function pageMatches(
  client: ImapFlow,
  account: Account,
  mailbox: MailboxObject,
  uids: number[],
  offset: number,
  limit: number,
  needAttachment: boolean,
): Promise<Summary[]> {
  if (!needAttachment) return fetchSummaries(client, account, mailbox, uids.slice(offset, offset + limit));
  const out: Summary[] = [];
  let skipped = 0;
  for (let i = 0; i < uids.length && out.length < limit; i += 100) {
    const batch = await fetchSummaries(client, account, mailbox, uids.slice(i, i + 100));
    for (const s of batch.filter((b) => b.hasAttachment)) {
      if (skipped < offset) skipped++;
      else if (out.length < limit) out.push(s);
    }
  }
  return out;
}

export function registerMessageTools(server: McpServer): void {
  server.registerTool(
    "email_list",
    {
      title: "List messages in a folder",
      description:
        "Messages in one folder, newest first: date, sender, subject, unread/flagged/replied marks, attachment " +
        "marker, and the id every other message tool needs. For 'what's new' use unreadOnly:true on the inbox. " +
        "Use email_search to filter by sender, subject, text, or dates.",
      inputSchema: {
        account: accountField,
        folder: folderField,
        unreadOnly: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(25),
        offset: z.number().int().min(0).default(0).describe("Skip this many newest messages — for paging."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const account = resolveAccount(args.account);
      const path = await withClient(account, (c) => resolveFolder(c, args.folder));
      const { summaries, total } = await withMailbox(
        account,
        path,
        async (client, mailbox) => {
          if (args.unreadOnly) {
            const uids = await searchUids(client, { seen: false });
            return {
              total: uids.length,
              summaries: await fetchSummaries(client, account, mailbox, uids.slice(args.offset, args.offset + args.limit)),
            };
          }
          const total = mailbox.exists;
          const end = total - args.offset;
          if (end < 1) return { total, summaries: [] };
          const start = Math.max(1, end - args.limit + 1);
          const msgs = await client.fetchAll(`${start}:${end}`, { uid: true });
          const uids = msgs.map((m) => m.uid);
          return { total, summaries: await fetchSummaries(client, account, mailbox, uids) };
        },
        { readOnly: true },
      );
      const what = args.unreadOnly ? "unread messages" : "messages";
      if (summaries.length === 0) return ok(`${path}: no ${what}${args.offset ? ` past offset ${args.offset}` : ""}.`);
      const more = total > args.offset + summaries.length ? `\n\n${total - args.offset - summaries.length} more — pass offset:${args.offset + summaries.length}.` : "";
      return ok(
        `${path} — showing ${args.offset + 1}-${args.offset + summaries.length} of ${total} ${what}\n\n${renderList(summaries)}${more}`,
      );
    }),
  );

  server.registerTool(
    "email_search",
    {
      title: "Search messages",
      description:
        "Find messages by sender, recipient, subject, body text, date range, read/flagged/replied state, " +
        "attachments, keyword, or size. Filters combine with AND. Searches one folder (default INBOX) or, with " +
        "allFolders:true, every folder except Trash and Spam (add includeTrashAndSpam to search those too). Text " +
        "matching is substring and case-insensitive, done by Zoho's server. Results are newest first.",
      inputSchema: {
        account: accountField,
        folder: folderField,
        allFolders: z.boolean().default(false),
        includeTrashAndSpam: z.boolean().default(false),
        ...searchFields,
        limit: z.number().int().min(1).max(200).default(25),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const account = resolveAccount(args.account);
      const filters: SearchFilters = {
        from: args.from, to: args.to, cc: args.cc, subject: args.subject, body: args.body, text: args.text,
        since: args.since, before: args.before, unread: args.unread, flagged: args.flagged, answered: args.answered,
        hasAttachment: args.hasAttachment, keyword: args.keyword, largerThanKb: args.largerThanKb, smallerThanKb: args.smallerThanKb,
      };
      const query = buildSearch(filters);

      if (!args.allFolders) {
        const path = await withClient(account, (c) => resolveFolder(c, args.folder));
        const { summaries, total } = await withMailbox(
          account,
          path,
          async (client, mailbox) => {
            const uids = await searchUids(client, query);
            const summaries = await pageMatches(client, account, mailbox, uids, args.offset, args.limit, Boolean(args.hasAttachment));
            return { summaries, total: uids.length };
          },
          { readOnly: true },
        );
        if (summaries.length === 0) return ok(`No messages in ${path} match ${describeFilters(filters)}.`);
        const approx = args.hasAttachment ? "up to " : "";
        const more = !args.hasAttachment && total > args.offset + summaries.length ? `\n\nMore matches — pass offset:${args.offset + summaries.length}.` : "";
        return ok(`${path} — ${approx}${total} matches for ${describeFilters(filters)}\n\n${renderList(summaries)}${more}`);
      }

      const folders = (await withClient(account, (c) => c.list())).filter(
        (f) => isSelectable(f) && (args.includeTrashAndSpam || (f.specialUse !== "\\Trash" && f.specialUse !== "\\Junk")),
      );
      const all: Summary[] = [];
      let total = 0;
      for (const f of folders) {
        const found = await withMailbox(
          account,
          f.path,
          async (client, mailbox) => {
            const uids = await searchUids(client, query);
            total += uids.length;
            // Enough from each folder to fill the requested page after merging.
            return pageMatches(client, account, mailbox, uids, 0, args.offset + args.limit, Boolean(args.hasAttachment));
          },
          { readOnly: true },
        );
        all.push(...found);
      }
      all.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
      const page = all.slice(args.offset, args.offset + args.limit);
      if (page.length === 0) return ok(`No messages in ${plural(folders.length, "folder")} match ${describeFilters(filters)}.`);
      const more = total > args.offset + page.length ? `\n\nMore matches — pass offset:${args.offset + page.length}.` : "";
      return ok(
        `${total} matches across ${plural(folders.length, "folder")} for ${describeFilters(filters)}\n\n${renderList(page, { showFolder: true })}${more}`,
      );
    }),
  );

  server.registerTool(
    "email_get",
    {
      title: "Read a message",
      description:
        "Full message: headers, body as readable text (HTML converted), attachment list with indexes for " +
        "email_download_attachment, and whether it offers unsubscribe. Reading does not mark it read unless " +
        "markRead:true. For a whole conversation use email_get_thread.",
      inputSchema: {
        id: idField,
        maxChars: maxCharsField,
        markRead: z.boolean().default(false).describe("Also mark the message as read."),
        showHtml: z.boolean().default(false).describe("Return the raw HTML body instead of the text version."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const msg = await loadMessage(args.id);
      if (args.markRead && !msg.flags.has("\\Seen")) {
        await withMailbox(msg.account, msg.ref.folder, (c) => c.messageFlagsAdd(String(msg.ref.uid), ["\\Seen"], { uid: true }));
        msg.flags.add("\\Seen");
      }
      let text = renderDetail(args.id, msg.ref.folder, msg.flags, msg.parsed, args.maxChars);
      if (args.showHtml && msg.parsed.html) {
        text = text.replace(/\nBODY\n[\s\S]*$/, `\nHTML BODY\n${truncate(msg.parsed.html, args.maxChars)}`);
      }
      return ok(text);
    }),
  );

  server.registerTool(
    "email_get_thread",
    {
      title: "Read a conversation",
      description:
        "Every message in the conversation a message belongs to, oldest first, found through Message-ID, " +
        "In-Reply-To, and References across the inbox, Sent, and the message's own folder. Quoted history is " +
        "stripped from each message so the thread reads once through.",
      inputSchema: {
        id: idField,
        maxCharsPerMessage: z.number().int().min(200).max(50000).default(2000),
        extraFolders: z.array(z.string()).optional().describe("Also look in these folders, e.g. an archive folder."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const seed = await loadMessage(args.id);
      const refs = seed.parsed.references ? ([] as string[]).concat(seed.parsed.references) : [];
      const ids = [...new Set([...refs, seed.parsed.inReplyTo, seed.parsed.messageId].filter((x): x is string => Boolean(x)))].slice(-25);
      if (ids.length === 0) return ok(`This message has no thread headers.\n\n${renderDetail(args.id, seed.ref.folder, seed.flags, seed.parsed, args.maxCharsPerMessage)}`);
      const root = ids[0];

      const account = seed.account;
      const folders = await withClient(account, async (c) => {
        const list = await c.list();
        const sent = list.find((f) => f.specialUse === "\\Sent")?.path;
        const archive = list.find((f) => f.specialUse === "\\Archive")?.path;
        const extra = await Promise.all((args.extraFolders ?? []).map((f) => resolveFolder(c, f)));
        return [...new Set(["INBOX", seed.ref.folder, sent, archive, ...extra].filter((x): x is string => Boolean(x)))];
      });

      const clauses: SearchObject[] = [
        ...ids.map((mid) => ({ header: { "message-id": mid } })),
        { header: { references: root } },
        ...(seed.parsed.messageId ? [{ header: { "in-reply-to": seed.parsed.messageId } }] : []),
      ];
      const query: SearchObject = clauses.length === 1 ? clauses[0] : { or: clauses };

      const found: { id: string; folder: string; uid: number }[] = [];
      for (const folder of folders) {
        await withMailbox(
          account,
          folder,
          async (client, mailbox) => {
            const uids = await searchUids(client, query);
            const summaries = await fetchSummaries(client, account, mailbox, uids.slice(0, 50));
            found.push(...summaries.map((s) => ({ id: s.id, folder, uid: s.uid })));
          },
          { readOnly: true },
        );
      }

      const seen = new Set<string>();
      const messages = [];
      for (const f of found) {
        const m = await loadMessage(f.id);
        const key = m.parsed.messageId ?? f.id;
        if (seen.has(key)) continue;
        seen.add(key);
        messages.push(m);
      }
      messages.sort((a, b) => (a.parsed.date?.getTime() ?? 0) - (b.parsed.date?.getTime() ?? 0));

      const blocks = messages.map((m, i) => {
        const atts = attachmentInfo(m.parsed).filter((a) => !a.inline);
        return [
          `[${i + 1}/${messages.length}] ${fmtDate(m.parsed.date)}  ${fmtParsedAddresses(m.parsed.from)}  (${m.ref.folder})`,
          `To: ${fmtParsedAddresses(m.parsed.to)}${m.parsed.cc ? `  Cc: ${fmtParsedAddresses(m.parsed.cc)}` : ""}`,
          `Subject: ${m.parsed.subject ?? ""}`,
          ...(atts.length ? [`Attachments: ${atts.map((a) => a.filename).join(", ")}`] : []),
          `id: ${m.id}`,
          "",
          truncate(stripQuoted(bodyText(m.parsed)) || "(empty)", args.maxCharsPerMessage),
        ].join("\n");
      });
      return ok(`Thread: ${seed.parsed.subject ?? "(no subject)"} — ${plural(messages.length, "message")}\n\n${blocks.join("\n\n" + "-".repeat(60) + "\n\n")}`);
    }),
  );

  server.registerTool(
    "email_get_raw",
    {
      title: "Raw message source",
      description:
        "The message exactly as stored, headers and MIME parts included. For diagnosing delivery, spam scoring " +
        "(Received, Authentication-Results, DKIM/SPF), or anything email_get does not show.",
      inputSchema: {
        id: idField,
        headersOnly: z.boolean().default(true).describe("Only the header block — usually what is wanted."),
        maxChars: z.number().int().min(200).max(200000).default(20000),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const msg = await loadMessage(args.id);
      const source = msg.source.toString("utf8");
      const text = args.headersOnly ? source.split(/\r?\n\r?\n/)[0] : source;
      return ok(truncate(text, args.maxChars));
    }),
  );

  server.registerTool(
    "email_download_attachment",
    {
      title: "Save an attachment",
      description:
        "Save one attachment (by its index from email_get), or all of them, to a local folder — ~/Downloads unless " +
        "directory is given. Never overwrites: a clashing name gets a numeric suffix. Returns the saved paths.",
      inputSchema: {
        id: idField,
        index: z.number().int().min(1).optional().describe("Attachment number from email_get. Omit to save all."),
        directory: z.string().min(1).optional().describe("Absolute folder path to save into."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (args) => {
      const msg = await loadMessage(args.id);
      const atts = msg.parsed.attachments;
      if (atts.length === 0) throw new ZohoError("This message has no attachments.");
      const chosen = args.index === undefined ? atts.map((a, i) => ({ a, i })) : [{ a: atts[args.index - 1], i: args.index - 1 }];
      if (chosen.some((c) => !c.a)) throw new ZohoError(`No attachment ${args.index}; this message has ${atts.length}.`);
      const dir = resolve(args.directory ?? join(homedir(), "Downloads"));
      mkdirSync(dir, { recursive: true });
      const saved = chosen.map(({ a, i }) => {
        const name = basename(a.filename ?? `attachment-${i + 1}`).replace(/[/\\:\0]/g, "_") || `attachment-${i + 1}`;
        const ext = extname(name);
        const stem = name.slice(0, name.length - ext.length);
        let target = join(dir, name);
        for (let n = 1; existsSync(target); n++) target = join(dir, `${stem} (${n})${ext}`);
        writeFileSync(target, a.content);
        return target;
      });
      return ok(`Saved ${plural(saved.length, "file")}:\n${saved.join("\n")}`);
    }),
  );

  server.registerTool(
    "email_mailbox_summary",
    {
      title: "Inbox summary",
      description:
        "Triage overview: unread count per folder, who the unread inbox mail is from (top senders), the oldest " +
        "unread message, and flagged count. Use to open 'what's in my email' before listing anything.",
      inputSchema: {
        account: accountField,
        topSenders: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const account = resolveAccount(args.account);
      const folders = await withClient(account, (c) => c.list({ statusQuery: { messages: true, unseen: true } }));
      const { unread, flagged, oldest, senders, sampled } = await withMailbox(
        account,
        "INBOX",
        async (client, mailbox) => {
          const unreadUids = await searchUids(client, { seen: false });
          const flaggedUids = await searchUids(client, { flagged: true });
          const sample = await fetchSummaries(client, account, mailbox, unreadUids.slice(0, 500));
          const counts = new Map<string, number>();
          for (const s of sample) counts.set(s.from, (counts.get(s.from) ?? 0) + 1);
          const senders = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, args.topSenders);
          const oldestUid = unreadUids.at(-1);
          const oldest = oldestUid ? (await fetchSummaries(client, account, mailbox, [oldestUid]))[0] : undefined;
          return { unread: unreadUids.length, flagged: flaggedUids.length, oldest, senders, sampled: sample.length };
        },
        { readOnly: true },
      );
      const withUnread = folders
        .filter((f) => f.status?.unseen && f.path.toUpperCase() !== "INBOX")
        .map((f) => `  ${f.path}: ${f.status!.unseen} unread`);
      const lines = [
        `${account.name} <${account.email}>`,
        `Inbox: ${unread} unread, ${flagged} flagged`,
        ...(withUnread.length ? ["Other folders with unread:", ...withUnread] : []),
        "",
        `TOP UNREAD SENDERS${sampled < unread ? ` (newest ${sampled} unread)` : ""}`,
        ...(senders.length ? senders.map(([from, n]) => `  ${String(n).padStart(4)}  ${from}`) : ["  none"]),
      ];
      if (oldest) lines.push("", `Oldest unread: ${fmtDate(oldest.date)}  ${oldest.from} — ${oldest.subject}`, `  id: ${oldest.id}`);
      return ok(lines.join("\n"));
    }),
  );
}
