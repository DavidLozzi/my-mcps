import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveAccount } from "../config.js";
import { isSelectable, resolveFolder, withClient } from "../imap.js";
import { ZohoError } from "../lib/errors.js";
import { fmtSize } from "../lib/render.js";
import { guard, ok } from "../lib/tool.js";
import { accountField } from "./shared.js";

const ROLE_LABEL: Record<string, string> = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Drafts": "drafts",
  "\\Trash": "trash",
  "\\Junk": "spam",
  "\\Archive": "archive",
  "\\All": "all mail",
  "\\Flagged": "flagged",
};

export function registerFolderTools(server: McpServer): void {
  server.registerTool(
    "email_list_folders",
    {
      title: "List folders",
      description:
        "Every folder in the mailbox as a tree, with total and unread counts and its role (inbox, sent, drafts, " +
        "trash, spam, archive). The paths shown are what the folder parameters on other tools accept, though a " +
        "plain name or role works too.",
      inputSchema: { account: accountField },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const account = resolveAccount(args.account);
      const folders = await withClient(account, (c) => c.list({ statusQuery: { messages: true, unseen: true } }));
      folders.sort((a, b) => (a.path.toUpperCase() === "INBOX" ? -1 : b.path.toUpperCase() === "INBOX" ? 1 : a.path.localeCompare(b.path)));
      let totalUnread = 0;
      const lines = folders.map((f) => {
        const depth = f.parent.length;
        const role = f.path.toUpperCase() === "INBOX" ? "inbox" : f.specialUse ? ROLE_LABEL[f.specialUse] : undefined;
        const counts = isSelectable(f) && f.status
          ? `  ${f.status.messages ?? 0} messages${f.status.unseen ? `, ${f.status.unseen} unread` : ""}`
          : isSelectable(f) ? "" : "  (container only)";
        if (f.status?.unseen) totalUnread += f.status.unseen;
        return `${"  ".repeat(depth)}${f.path}${role ? ` [${role}]` : ""}${counts}`;
      });
      return ok(`${account.name} — ${folders.length} folders, ${totalUnread} unread\n\n${lines.join("\n")}`);
    }),
  );

  server.registerTool(
    "email_create_folder",
    {
      title: "Create a folder",
      description:
        "Create a folder, optionally inside another. Zoho also shows these as folders in its web app. Nested paths " +
        "use the server's delimiter, which email_list_folders reveals; passing parent avoids having to know it.",
      inputSchema: {
        account: accountField,
        name: z.string().min(1).describe("New folder name."),
        parent: z.string().min(1).optional().describe("Existing folder to create it inside."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (args) => {
      const account = resolveAccount(args.account);
      const created = await withClient(account, async (c) => {
        if (!args.parent) return c.mailboxCreate(args.name);
        const parent = await resolveFolder(c, args.parent);
        return c.mailboxCreate([parent, args.name]);
      });
      return ok(created.created ? `Created folder ${created.path}.` : `Folder ${created.path} already existed.`);
    }),
  );

  server.registerTool(
    "email_rename_folder",
    {
      title: "Rename or move a folder",
      description:
        "Rename a folder, or move it under another parent (newParent), keeping its messages. System folders " +
        "(Inbox, Sent, Drafts, Trash, Spam) cannot be renamed.",
      inputSchema: {
        account: accountField,
        folder: z.string().min(1).describe("Folder to rename."),
        newName: z.string().min(1).optional().describe("New name. Omit to keep the name and only move it."),
        newParent: z.string().optional().describe('Folder to move it under, or "" for the top level.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (args) => {
      if (!args.newName && args.newParent === undefined) throw new ZohoError("Give newName, newParent, or both.");
      const account = resolveAccount(args.account);
      const result = await withClient(account, async (c) => {
        const path = await resolveFolder(c, args.folder);
        const all = await c.list();
        const info = all.find((f) => f.path === path)!;
        if (path.toUpperCase() === "INBOX" || ["\\Sent", "\\Drafts", "\\Trash", "\\Junk"].includes(info.specialUse ?? "")) {
          throw new ZohoError(`${path} is a system folder and cannot be renamed.`);
        }
        const name = args.newName ?? info.name;
        const parentPath =
          args.newParent === undefined ? info.parentPath : args.newParent === "" ? "" : await resolveFolder(c, args.newParent);
        const target = parentPath ? [parentPath, name] : name;
        return c.mailboxRename(path, target);
      });
      return ok(`Renamed ${result.path} to ${result.newPath}.`);
    }),
  );

  server.registerTool(
    "email_delete_folder",
    {
      title: "Delete a folder",
      description:
        "Permanently delete a folder AND every message in it — they do not go to Trash. Move anything worth " +
        "keeping out first (email_move). System folders cannot be deleted. Only call this when the user asked.",
      inputSchema: {
        account: accountField,
        folder: z.string().min(1).describe("Folder to delete."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const account = resolveAccount(args.account);
      const { path, count } = await withClient(account, async (c) => {
        const path = await resolveFolder(c, args.folder);
        const info = (await c.list()).find((f) => f.path === path)!;
        if (path.toUpperCase() === "INBOX" || ["\\Sent", "\\Drafts", "\\Trash", "\\Junk"].includes(info.specialUse ?? "")) {
          throw new ZohoError(`${path} is a system folder and cannot be deleted.`);
        }
        const status = await c.status(path, { messages: true });
        await c.mailboxDelete(path);
        return { path, count: status ? status.messages ?? 0 : 0 };
      });
      return ok(`Deleted folder ${path} and the ${count} messages in it.`);
    }),
  );

  server.registerTool(
    "email_quota",
    {
      title: "Storage quota",
      description: "How much of the mailbox's storage quota is used, when the server reports it.",
      inputSchema: { account: accountField },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const account = resolveAccount(args.account);
      const quota = await withClient(account, (c) => c.getQuota("INBOX"));
      if (!quota || !quota.storage) return ok("The server does not report a storage quota.");
      const { usage, limit } = quota.storage;
      const pct = usage !== undefined && limit ? ` (${((usage / limit) * 100).toFixed(1)}%)` : "";
      return ok(`${account.name}: ${fmtSize(usage)} of ${fmtSize(limit)} used${pct}.`);
    }),
  );
}
