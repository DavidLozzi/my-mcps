import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AddressObject } from "mailparser";
import { z } from "zod";
import { resolveAccount, selfAddresses, type Account } from "../config.js";
import { findSpecial, withClient, withMailbox } from "../imap.js";
import { idFor, loadMessage, type LoadedMessage } from "../mail.js";
import { buildMessage, ensureInSent, sendBuilt, type Outgoing, type OutgoingAttachment } from "../smtp.js";
import {
  fmt,
  forwardHtml,
  forwardText,
  prefixSubject,
  replyHtml,
  replyRecipients,
  replyText,
  textToHtml,
  threadHeaders,
} from "../lib/compose.js";
import { ZohoError } from "../lib/errors.js";
import { encodeId } from "../lib/ids.js";
import { unsubscribeOptions } from "../lib/render.js";
import { guard, ok } from "../lib/tool.js";
import { accountField, attachmentPathsField, idField, recipientsField } from "./shared.js";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function fileAttachments(paths: string[] | undefined): OutgoingAttachment[] {
  return (paths ?? []).map((p) => {
    if (!isAbsolute(p)) throw new ZohoError(`Attachment path must be absolute: ${p}`);
    if (!existsSync(p) || !statSync(p).isFile()) throw new ZohoError(`No file at ${p}`);
    if (statSync(p).size > MAX_ATTACHMENT_BYTES) throw new ZohoError(`${p} is over Zoho's 25 MB attachment limit.`);
    return { path: p, filename: basename(p) };
  });
}

function addresses(value: AddressObject | AddressObject[] | undefined): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value])
    .flatMap((g) => g.value)
    .flatMap((a) => (a.address ? [fmt({ name: a.name || undefined, address: a.address })] : []));
}

function recipientSummary(mail: Outgoing): string {
  return [
    mail.to?.length ? `to ${mail.to.join(", ")}` : "",
    mail.cc?.length ? `cc ${mail.cc.join(", ")}` : "",
    mail.bcc?.length ? `bcc ${mail.bcc.join(", ")}` : "",
  ].filter(Boolean).join("; ");
}

async function saveDraft(account: Account, mail: Outgoing): Promise<string> {
  const built = await buildMessage(account, mail, { keepBcc: true });
  const drafts = await withClient(account, (c) => findSpecial(c, "\\Drafts"));
  if (!drafts) throw new ZohoError("This account has no Drafts folder.");
  const res = await withClient(account, (c) => c.append(drafts.path, built.raw, ["\\Draft", "\\Seen"]));
  if (res && res.uid !== undefined && res.uidValidity !== undefined) {
    return encodeId({ account: account.name, folder: drafts.path, uidValidity: String(res.uidValidity), uid: res.uid });
  }
  // No UIDPLUS: find the draft we just stored by its Message-ID.
  return withMailbox(
    account,
    drafts.path,
    async (c, mailbox) => {
      const uids = await c.search({ header: { "message-id": built.messageId } }, { uid: true });
      const uid = Array.isArray(uids) ? uids.at(-1) : undefined;
      if (uid === undefined) throw new ZohoError("The draft was saved but could not be found again; check Drafts.");
      return idFor(account, mailbox, uid);
    },
    { readOnly: true },
  );
}

/** Send now, or with saveAsDraft store it in Drafts for the user to review and send. */
async function deliver(account: Account, mail: Outgoing, saveAsDraft: boolean): Promise<string> {
  if (saveAsDraft) {
    const id = await saveDraft(account, mail);
    return `Saved draft "${mail.subject}" (${recipientSummary(mail)}).\nDraft id: ${id}\nSend it with email_send_draft, or edit it in Zoho.`;
  }
  const built = await buildMessage(account, mail);
  const response = await sendBuilt(account, built);
  const sent = await ensureInSent(account, built);
  return `Sent "${mail.subject}" ${recipientSummary(mail)} from ${mail.from ?? account.email}.\nServer: ${response}\nSent copy: ${sent}\nMessage-ID: ${built.messageId}`;
}

async function markOriginal(msg: LoadedMessage, flag: string): Promise<void> {
  try {
    await withMailbox(msg.account, msg.ref.folder, (c) => c.messageFlagsAdd(String(msg.ref.uid), [flag], { uid: true }));
  } catch {
    // The message was sent; failing to set a cosmetic flag should not report failure.
  }
}

const bodyFields = {
  body: z.string().describe("Plain-text body. Becomes simple HTML too when html is omitted for replies/forwards."),
  html: z.string().optional().describe("Optional HTML body. When given, body is the plain-text alternative."),
  attachments: attachmentPathsField,
  priority: z.enum(["high", "normal", "low"]).optional(),
  saveAsDraft: z.boolean().default(false).describe("Store in Drafts instead of sending, for the user to review."),
};

export function registerComposeTools(server: McpServer): void {
  server.registerTool(
    "email_send",
    {
      title: "Send an email",
      description:
        "Compose and send a new email through Zoho SMTP. It goes out immediately and cannot be recalled, so " +
        "confirm recipients, subject, and body with the user before calling — or pass saveAsDraft:true to leave " +
        "it in Drafts. A copy lands in Sent. To answer a message use email_reply, which keeps the thread.",
      inputSchema: {
        account: accountField,
        to: recipientsField.min(1).optional(),
        cc: recipientsField.optional(),
        bcc: recipientsField.optional(),
        subject: z.string(),
        ...bodyFields,
        replyTo: z.string().optional().describe("Where replies should go, if not this account."),
        from: z.string().optional().describe("A Zoho send-as alias (\"Name <alias@domain>\"). Must be verified in Zoho."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (args) => {
      const account = resolveAccount(args.account);
      if (!args.to?.length && !args.cc?.length && !args.bcc?.length && !args.saveAsDraft) {
        throw new ZohoError("Give at least one recipient in to, cc, or bcc.");
      }
      const mail: Outgoing = {
        from: args.from,
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        replyTo: args.replyTo,
        subject: args.subject,
        text: args.body,
        html: args.html,
        attachments: fileAttachments(args.attachments),
        priority: args.priority,
      };
      return ok(await deliver(account, mail, args.saveAsDraft));
    }),
  );

  server.registerTool(
    "email_reply",
    {
      title: "Reply to a message",
      description:
        "Reply (or reply-all with all:true) to a message, threaded with In-Reply-To/References, subject prefixed " +
        "Re:, and the original quoted below. Reply-all leaves this account's own addresses out. Sends immediately " +
        "— confirm the wording with the user first, or pass saveAsDraft:true. Marks the original as replied.",
      inputSchema: {
        id: idField,
        all: z.boolean().default(false).describe("Reply to everyone on the original, not just the sender."),
        ...bodyFields,
        addCc: recipientsField.optional().describe("Extra Cc recipients."),
        quoteOriginal: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (args) => {
      const original = await loadMessage(args.id);
      const account = original.account;
      const { to, cc } = replyRecipients(original.parsed, selfAddresses(account), args.all);
      if (to.length === 0) throw new ZohoError("Could not work out who to reply to — the original has no usable From/Reply-To.");
      const html = args.html ?? (original.parsed.html && args.quoteOriginal ? textToHtml(args.body) : undefined);
      const mail: Outgoing = {
        to: to.map(fmt),
        cc: [...cc.map(fmt), ...(args.addCc ?? [])],
        subject: prefixSubject("Re", original.parsed.subject),
        text: args.quoteOriginal ? replyText(original.parsed, args.body) : args.body,
        html: html && args.quoteOriginal ? replyHtml(original.parsed, html) ?? html : html,
        attachments: fileAttachments(args.attachments),
        priority: args.priority,
        ...threadHeaders(original.parsed),
      };
      const result = await deliver(account, mail, args.saveAsDraft);
      if (!args.saveAsDraft) await markOriginal(original, "\\Answered");
      return ok(result);
    }),
  );

  server.registerTool(
    "email_forward",
    {
      title: "Forward a message",
      description:
        "Forward a message with an optional note above it. The original's attachments come along unless " +
        "includeAttachments:false. Sends immediately — confirm the recipients first, or saveAsDraft:true.",
      inputSchema: {
        id: idField,
        to: recipientsField.min(1),
        cc: recipientsField.optional(),
        bcc: recipientsField.optional(),
        note: z.string().optional().describe("Text above the forwarded message."),
        includeAttachments: z.boolean().default(true),
        attachments: attachmentPathsField.describe("Extra local files to attach."),
        saveAsDraft: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (args) => {
      const original = await loadMessage(args.id);
      const carried: OutgoingAttachment[] = args.includeAttachments
        ? original.parsed.attachments.map((a) => ({
            filename: a.filename,
            content: a.content,
            contentType: a.contentType,
            cid: a.contentId ? a.contentId.replace(/^<|>$/g, "") : undefined,
          }))
        : [];
      const mail: Outgoing = {
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: prefixSubject("Fwd", original.parsed.subject),
        text: forwardText(original.parsed, args.note),
        html: forwardHtml(original.parsed, args.note ? textToHtml(args.note) : undefined),
        attachments: [...carried, ...fileAttachments(args.attachments)],
      };
      const result = await deliver(original.account, mail, args.saveAsDraft);
      if (!args.saveAsDraft) await markOriginal(original, "$Forwarded");
      return ok(result);
    }),
  );

  server.registerTool(
    "email_save_draft",
    {
      title: "Save a draft",
      description:
        "Write a new email into Drafts without sending it — the user can open it in Zoho to review, or it can be " +
        "sent later with email_send_draft. Returns the draft id.",
      inputSchema: {
        account: accountField,
        to: recipientsField.optional(),
        cc: recipientsField.optional(),
        bcc: recipientsField.optional(),
        subject: z.string(),
        body: z.string(),
        html: z.string().optional(),
        attachments: attachmentPathsField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (args) => {
      const account = resolveAccount(args.account);
      const mail: Outgoing = {
        to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject, text: args.body, html: args.html,
        attachments: fileAttachments(args.attachments),
      };
      return ok(await deliver(account, mail, true));
    }),
  );

  /** Rebuild an Outgoing from a stored draft so it can be edited or sent. */
  function fromDraft(draft: LoadedMessage): Outgoing {
    const p = draft.parsed;
    const refs = p.references ? ([] as string[]).concat(p.references) : undefined;
    return {
      from: addresses(p.from)[0],
      to: addresses(p.to),
      cc: addresses(p.cc),
      bcc: addresses(p.bcc),
      replyTo: addresses(p.replyTo)[0],
      subject: p.subject ?? "",
      text: p.text,
      html: p.html || undefined,
      attachments: p.attachments.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
        cid: a.contentId ? a.contentId.replace(/^<|>$/g, "") : undefined,
      })),
      inReplyTo: p.inReplyTo,
      references: refs,
    };
  }

  async function requireDraft(id: string): Promise<LoadedMessage> {
    const draft = await loadMessage(id);
    const drafts = await withClient(draft.account, (c) => findSpecial(c, "\\Drafts"));
    if (draft.ref.folder !== drafts?.path && !draft.flags.has("\\Draft")) {
      throw new ZohoError("That message is not a draft. Use email_forward or email_send for other messages.");
    }
    return draft;
  }

  async function removeDraft(draft: LoadedMessage): Promise<void> {
    await withMailbox(draft.account, draft.ref.folder, (c) => c.messageDelete(String(draft.ref.uid), { uid: true }));
  }

  server.registerTool(
    "email_update_draft",
    {
      title: "Edit a draft",
      description:
        "Change fields of a saved draft. Only the fields given change; recipients and attachments given replace " +
        "the old ones (addAttachments appends instead). The draft gets a new id, which is returned.",
      inputSchema: {
        id: idField.describe("Draft id from email_save_draft, or from listing the Drafts folder."),
        to: recipientsField.optional(),
        cc: recipientsField.optional(),
        bcc: recipientsField.optional(),
        subject: z.string().optional(),
        body: z.string().optional(),
        html: z.string().nullable().optional().describe("New HTML body, or null to drop HTML and send plain text."),
        addAttachments: attachmentPathsField,
        removeAttachments: z.boolean().default(false).describe("Drop all existing attachments first."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (args) => {
      const draft = await requireDraft(args.id);
      const mail = fromDraft(draft);
      if (args.to) mail.to = args.to;
      if (args.cc) mail.cc = args.cc;
      if (args.bcc) mail.bcc = args.bcc;
      if (args.subject !== undefined) mail.subject = args.subject;
      if (args.body !== undefined) {
        mail.text = args.body;
        // A stale HTML part would contradict the new text.
        if (args.html === undefined) mail.html = undefined;
      }
      if (args.html !== undefined) mail.html = args.html ?? undefined;
      mail.attachments = [...(args.removeAttachments ? [] : mail.attachments ?? []), ...fileAttachments(args.addAttachments)];
      const newId = await saveDraft(draft.account, mail);
      await removeDraft(draft);
      return ok(`Updated draft "${mail.subject}" (${recipientSummary(mail) || "no recipients yet"}).\nNew draft id: ${newId}`);
    }),
  );

  server.registerTool(
    "email_send_draft",
    {
      title: "Send a draft",
      description:
        "Send a saved draft as it stands, then remove it from Drafts. Sends immediately — confirm with the user " +
        "that the draft is final.",
      inputSchema: { id: idField.describe("Draft id.") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (args) => {
      const draft = await requireDraft(args.id);
      const mail = fromDraft(draft);
      if (!mail.to?.length && !mail.cc?.length && !mail.bcc?.length) {
        throw new ZohoError("The draft has no recipients. Add them with email_update_draft first.");
      }
      const result = await deliver(draft.account, mail, false);
      await removeDraft(draft);
      return ok(`${result}\nDraft removed from ${draft.ref.folder}.`);
    }),
  );

  server.registerTool(
    "email_unsubscribe",
    {
      title: "Unsubscribe from a mailing list",
      description:
        "Unsubscribe from the list a message came from, using its List-Unsubscribe header. Uses the RFC 8058 " +
        "one-click method when the sender supports it, otherwise sends the unsubscribe email the header names. " +
        "When only a web link is offered it returns the link for the user to open rather than visiting it. Confirm " +
        "with the user first. Pair with email_bulk_action to clear out the list's existing mail.",
      inputSchema: {
        id: idField,
        method: z.enum(["auto", "one_click", "mailto"]).default("auto"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (args) => {
      const msg = await loadMessage(args.id);
      const opts = unsubscribeOptions(msg.parsed);
      if (!opts) throw new ZohoError("This message has no List-Unsubscribe header — look for an unsubscribe link in its body.");
      const sender = addresses(msg.parsed.from)[0] ?? "the sender";

      const httpsUrl = opts.urls.find((u) => u.startsWith("https:"));
      if ((args.method === "auto" || args.method === "one_click") && opts.oneClick && httpsUrl) {
        const res = await fetch(httpsUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
          redirect: "follow",
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) return ok(`Unsubscribed from ${sender} (one-click, HTTP ${res.status}).`);
        if (args.method === "one_click") throw new ZohoError(`One-click unsubscribe failed: HTTP ${res.status}.`);
      } else if (args.method === "one_click") {
        throw new ZohoError("This sender does not support one-click unsubscribe.");
      }

      const mailto = opts.mailto[0];
      if (mailto) {
        const url = new URL(mailto);
        const to = decodeURIComponent(url.pathname);
        const mail: Outgoing = {
          to: [to],
          subject: url.searchParams.get("subject") ?? "unsubscribe",
          text: url.searchParams.get("body") ?? "unsubscribe",
        };
        const built = await buildMessage(msg.account, mail);
        await sendBuilt(msg.account, built);
        return ok(`Sent an unsubscribe request to ${to} for ${sender}. Lists usually take a few days to stop.`);
      }

      return ok(
        `${sender} only offers a web unsubscribe page, which needs a person to open it:\n${opts.urls.join("\n")}`,
      );
    }),
  );
}
