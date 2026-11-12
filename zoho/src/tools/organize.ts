import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow, MailboxObject } from "imapflow";
import { z } from "zod";
import { resolveAccount, type Account } from "../config.js";
import { ensureSpecial, findSpecial, resolveFolder, withClient, withMailbox, type SpecialUse } from "../imap.js";
import { fetchSummaries, forEachFolder } from "../mail.js";
import { ZohoError } from "../lib/errors.js";
import { encodeId } from "../lib/ids.js";
import { renderList } from "../lib/render.js";
import { buildSearch, describeFilters, type SearchFilters } from "../lib/search.js";
import { guard, ok, plural } from "../lib/tool.js";
import { searchUids } from "./messages.js";
import { accountField, folderField, idsField, searchFields } from "./shared.js";

interface MoveOutcome {
  from: string;
  to: string;
  count: number;
  newIds: string[];
}

async function moveUids(
  client: ImapFlow,
  account: Account,
  mailbox: MailboxObject,
  uids: number[],
  destination: string,
  copy = false,
): Promise<MoveOutcome> {
  if (destination === mailbox.path) return { from: mailbox.path, to: destination, count: 0, newIds: [] };
  const res = copy
    ? await client.messageCopy(uids, destination, { uid: true })
    : await client.messageMove(uids, destination, { uid: true });
  const newIds: string[] = [];
  if (res && res.uidMap && res.uidValidity !== undefined) {
    for (const uid of uids) {
      const target = res.uidMap.get(uid);
      if (target !== undefined) {
        newIds.push(encodeId({ account: account.name, folder: destination, uidValidity: String(res.uidValidity), uid: target }));
      }
    }
  }
  return { from: mailbox.path, to: destination, count: uids.length, newIds };
}

function describeMoves(verb: string, outcomes: MoveOutcome[]): string {
  const moved = outcomes.filter((o) => o.count > 0);
  const skipped = outcomes.filter((o) => o.count === 0);
  const lines = moved.map((o) => `${verb} ${plural(o.count, "message")} from ${o.from} to ${o.to}.`);
  if (skipped.length) lines.push(`Skipped messages already in ${[...new Set(skipped.map((o) => o.to))].join(", ")}.`);
  const ids = moved.flatMap((o) => o.newIds);
  if (ids.length) lines.push("", "New ids:", ...ids);
  return lines.join("\n");
}

/** Move a batch into a special folder, resolved (or created) once per account. */
async function moveToSpecial(ids: string[], use: SpecialUse, fallback: string, verb: string): Promise<string> {
  const destinations = new Map<string, string>();
  const outcomes = await forEachFolder(ids, async (client, mailbox, uids, account) => {
    let dest = destinations.get(account.name);
    if (!dest) {
      dest = await ensureSpecial(client, use, fallback);
      destinations.set(account.name, dest);
    }
    return moveUids(client, account, mailbox, uids, dest);
  });
  return describeMoves(verb, outcomes);
}

export function registerOrganizeTools(server: McpServer): void {
  server.registerTool(
    "email_mark",
    {
      title: "Mark read, unread, flagged",
      description:
        "Set read/unread, flagged/unflagged, or replied state on a batch of messages. Only the fields given change.",
      inputSchema: {
        ids: idsField,
        read: z.boolean().optional(),
        flagged: z.boolean().optional(),
        answered: z.boolean().optional().describe("The 'replied' mark."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const changes: [string, boolean][] = [];
      if (args.read !== undefined) changes.push(["\\Seen", args.read]);
      if (args.flagged !== undefined) changes.push(["\\Flagged", args.flagged]);
      if (args.answered !== undefined) changes.push(["\\Answered", args.answered]);
      if (changes.length === 0) throw new ZohoError("Give at least one of read, flagged, answered.");
      const counts = await forEachFolder(args.ids, async (client, _mailbox, uids) => {
        for (const [flag, on] of changes) {
          if (on) await client.messageFlagsAdd(uids, [flag], { uid: true });
          else await client.messageFlagsRemove(uids, [flag], { uid: true });
        }
        return uids.length;
      });
      const what = [
        args.read !== undefined ? (args.read ? "read" : "unread") : "",
        args.flagged !== undefined ? (args.flagged ? "flagged" : "unflagged") : "",
        args.answered !== undefined ? (args.answered ? "replied" : "not replied") : "",
      ].filter(Boolean).join(", ");
      return ok(`Marked ${plural(counts.reduce((a, b) => a + b, 0), "message")} ${what}.`);
    }),
  );

  server.registerTool(
    "email_set_keywords",
    {
      title: "Add or remove keywords",
      description:
        "Tag messages with custom IMAP keywords (e.g. 'followup', 'receipts') or remove them. Keywords are " +
        "searchable with email_search keyword. Zoho may not show IMAP keywords as labels in its web app; folders " +
        "are the portable way to organize.",
      inputSchema: {
        ids: idsField,
        add: z.array(z.string().regex(/^[^\s()\\"{%*\]]+$/, "Keywords cannot contain spaces or ( ) { % * \\ \" ]")).optional(),
        remove: z.array(z.string().min(1)).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      if (!args.add?.length && !args.remove?.length) throw new ZohoError("Give add, remove, or both.");
      const counts = await forEachFolder(args.ids, async (client, mailbox, uids) => {
        const perm = mailbox.permanentFlags;
        if (args.add?.length && perm && !perm.has("\\*") && !args.add.every((k) => perm.has(k))) {
          throw new ZohoError(`${mailbox.path} does not allow custom keywords (server permanent flags: ${[...perm].join(" ") || "none"}).`);
        }
        if (args.add?.length) await client.messageFlagsAdd(uids, args.add, { uid: true });
        if (args.remove?.length) await client.messageFlagsRemove(uids, args.remove, { uid: true });
        return uids.length;
      });
      return ok(
        `Updated keywords on ${plural(counts.reduce((a, b) => a + b, 0), "message")}` +
          `${args.add?.length ? ` +${args.add.join(" +")}` : ""}${args.remove?.length ? ` -${args.remove.join(" -")}` : ""}.`,
      );
    }),
  );

  server.registerTool(
    "email_move",
    {
      title: "Move messages",
      description:
        "Move a batch of messages to another folder in the same account. Ids change when a message moves; the new " +
        "ids are returned.",
      inputSchema: { ids: idsField, folder: z.string().min(1).describe("Destination folder path, name, or role.") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (args) => {
      const outcomes = await forEachFolder(args.ids, async (client, mailbox, uids, account) =>
        moveUids(client, account, mailbox, uids, await resolveFolder(client, args.folder)),
      );
      return ok(describeMoves("Moved", outcomes));
    }),
  );

  server.registerTool(
    "email_copy",
    {
      title: "Copy messages",
      description: "Copy a batch of messages into another folder, leaving the originals where they are.",
      inputSchema: { ids: idsField, folder: z.string().min(1).describe("Destination folder path, name, or role.") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (args) => {
      const outcomes = await forEachFolder(args.ids, async (client, mailbox, uids, account) =>
        moveUids(client, account, mailbox, uids, await resolveFolder(client, args.folder), true),
      );
      return ok(describeMoves("Copied", outcomes));
    }),
  );

  server.registerTool(
    "email_archive",
    {
      title: "Archive messages",
      description: "Move a batch out of the inbox into the Archive folder (created if the account has none).",
      inputSchema: { ids: idsField },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (args) => ok(await moveToSpecial(args.ids, "\\Archive", "Archive", "Archived"))),
  );

  server.registerTool(
    "email_trash",
    {
      title: "Move to Trash",
      description:
        "Delete messages the recoverable way: move them to Trash, where Zoho keeps them until Trash is emptied. " +
        "This is what 'delete' should mean unless the user explicitly wants them gone for good.",
      inputSchema: { ids: idsField },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (args) => ok(await moveToSpecial(args.ids, "\\Trash", "Trash", "Trashed"))),
  );

  server.registerTool(
    "email_mark_spam",
    {
      title: "Report spam",
      description: "Move messages to the Spam folder, which also trains Zoho's spam filter on them.",
      inputSchema: { ids: idsField },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (args) => ok(await moveToSpecial(args.ids, "\\Junk", "Spam", "Moved to spam"))),
  );

  server.registerTool(
    "email_not_spam",
    {
      title: "Not spam",
      description: "Rescue messages from Spam (or anywhere) back to the inbox.",
      inputSchema: { ids: idsField },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (args) => ok(await moveToSpecial(args.ids, "\\Inbox", "INBOX", "Moved"))),
  );

  server.registerTool(
    "email_delete_permanently",
    {
      title: "Delete permanently",
      description:
        "Erase messages immediately — no Trash, no undo. Use email_trash for normal deleting; call this only when " +
        "the user explicitly asks for permanent deletion or to purge specific messages from Trash.",
      inputSchema: { ids: idsField },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const counts = await forEachFolder(args.ids, async (client, mailbox, uids) => {
        await client.messageDelete(uids, { uid: true });
        return { folder: mailbox.path, n: uids.length };
      });
      return ok(counts.map((c) => `Permanently deleted ${plural(c.n, "message")} from ${c.folder}.`).join("\n"));
    }),
  );

  server.registerTool(
    "email_empty_folder",
    {
      title: "Empty Trash or Spam",
      description:
        "Permanently delete every message in a folder — meant for Trash and Spam. Any other folder needs " +
        "allowOtherFolder:true. Without confirm:true it only reports how many messages would be erased.",
      inputSchema: {
        account: accountField,
        folder: z.string().min(1).describe('Folder to empty, usually "trash" or "spam".'),
        allowOtherFolder: z.boolean().default(false),
        confirm: z.boolean().default(false).describe("Actually erase. Only after the user agreed to the preview."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const account = resolveAccount(args.account);
      const { path, special } = await withClient(account, async (c) => {
        const path = await resolveFolder(c, args.folder);
        const info = (await c.list()).find((f) => f.path === path);
        return { path, special: info?.specialUse };
      });
      if (special !== "\\Trash" && special !== "\\Junk" && !args.allowOtherFolder) {
        throw new ZohoError(`${path} is not Trash or Spam. Pass allowOtherFolder:true if emptying it is really intended.`);
      }
      return withMailbox(account, path, async (client, mailbox) => {
        if (mailbox.exists === 0) return ok(`${path} is already empty.`);
        if (!args.confirm) return ok(`${path} holds ${plural(mailbox.exists, "message")}. Call again with confirm:true to erase them permanently.`);
        const n = mailbox.exists;
        await client.messageDelete("1:*");
        return ok(`Emptied ${path}: ${plural(n, "message")} permanently deleted.`);
      });
    }),
  );

  const BULK_ACTIONS = ["mark_read", "mark_unread", "flag", "unflag", "archive", "trash", "spam", "move"] as const;

  server.registerTool(
    "email_bulk_action",
    {
      title: "Act on every search match",
      description:
        "Apply one action to every message in a folder matching search filters — e.g. archive all newsletters " +
        "from a sender, mark everything older than a date read, trash all notifications from a service. Without " +
        "confirm:true it returns the match count and a sample so the user can check it; nothing changes until " +
        "called again with confirm:true. Actions: mark_read, mark_unread, flag, unflag, archive, trash, spam, " +
        "move (needs targetFolder). At least one filter is required.",
      inputSchema: {
        account: accountField,
        folder: folderField,
        ...searchFields,
        action: z.enum(BULK_ACTIONS),
        targetFolder: z.string().min(1).optional().describe("Destination for action=move."),
        confirm: z.boolean().default(false),
        max: z.number().int().min(1).max(5000).default(1000).describe("Refuse if more than this many match."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (args) => {
      const filters: SearchFilters = {
        from: args.from, to: args.to, cc: args.cc, subject: args.subject, body: args.body, text: args.text,
        since: args.since, before: args.before, unread: args.unread, flagged: args.flagged, answered: args.answered,
        hasAttachment: args.hasAttachment, keyword: args.keyword, largerThanKb: args.largerThanKb, smallerThanKb: args.smallerThanKb,
      };
      if (Object.values(filters).every((v) => v === undefined)) {
        throw new ZohoError("Give at least one filter — bulk actions never run on a whole folder unfiltered.");
      }
      if (args.action === "move" && !args.targetFolder) throw new ZohoError("action=move needs targetFolder.");
      const account = resolveAccount(args.account);
      const path = await withClient(account, (c) => resolveFolder(c, args.folder));

      return withMailbox(account, path, async (client, mailbox) => {
        let uids = await searchUids(client, buildSearch(filters));
        if (args.hasAttachment) {
          const summaries = await fetchSummaries(client, account, mailbox, uids);
          uids = summaries.filter((s) => s.hasAttachment).map((s) => s.uid);
        }
        const label = `${plural(uids.length, "message")} in ${path} matching ${describeFilters(filters)}`;
        if (uids.length === 0) return ok(`No ${label.replace(/^0 messages /, "messages ")}.`);
        if (uids.length > args.max) {
          throw new ZohoError(`${label} — more than max ${args.max}. Narrow the filters or raise max.`);
        }
        if (!args.confirm) {
          const sample = await fetchSummaries(client, account, mailbox, uids.slice(0, 10));
          return ok(
            `PREVIEW — would ${args.action.replace("_", " ")}${args.action === "move" ? ` to ${args.targetFolder}` : ""} ` +
              `${label}.\n\nNewest ${sample.length}:\n\n${renderList(sample)}\n\nCall again with confirm:true to apply.`,
          );
        }
        switch (args.action) {
          case "mark_read":
            await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
            break;
          case "mark_unread":
            await client.messageFlagsRemove(uids, ["\\Seen"], { uid: true });
            break;
          case "flag":
            await client.messageFlagsAdd(uids, ["\\Flagged"], { uid: true });
            break;
          case "unflag":
            await client.messageFlagsRemove(uids, ["\\Flagged"], { uid: true });
            break;
          default: {
            const dest =
              args.action === "move"
                ? await resolveFolder(client, args.targetFolder)
                : args.action === "archive"
                  ? await ensureSpecial(client, "\\Archive", "Archive")
                  : args.action === "trash"
                    ? (await findSpecial(client, "\\Trash"))?.path
                    : (await findSpecial(client, "\\Junk"))?.path;
            if (!dest) throw new ZohoError(`This account has no ${args.action} folder.`);
            if (dest === path) throw new ZohoError(`These messages are already in ${path}.`);
            await client.messageMove(uids, dest, { uid: true });
            return ok(`Moved ${label} to ${dest}.`);
          }
        }
        return ok(`Applied ${args.action.replace("_", " ")} to ${label}.`);
      });
    }),
  );
}
