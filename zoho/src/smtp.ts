import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import type { Account } from "./config.js";
import { findSpecial, withMailbox, withClient } from "./imap.js";

export interface OutgoingAttachment {
  filename?: string;
  path?: string;
  content?: Buffer;
  contentType?: string;
  cid?: string;
}

export interface Outgoing {
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: OutgoingAttachment[];
  inReplyTo?: string;
  references?: string[];
  priority?: "high" | "normal" | "low";
}

export interface Built {
  raw: Buffer;
  messageId: string;
  envelope: { from: string; to: string[] };
}

export function fromHeader(account: Account): string {
  return account.fromName ? `"${account.fromName.replace(/"/g, "'")}" <${account.email}>` : account.email;
}

/**
 * Render the RFC 822 message once, so the bytes sent over SMTP and the copy
 * filed in Sent or Drafts are identical. keepBcc is for drafts: a sent copy
 * must not reveal Bcc recipients, but a draft has to remember them.
 */
export async function buildMessage(account: Account, mail: Outgoing, opts: { keepBcc?: boolean } = {}): Promise<Built> {
  const domain = account.email.split("@")[1] ?? "zoho.com";
  const messageId = `<${randomUUID()}@${domain}>`;
  const composer = new MailComposer({
    from: mail.from ?? fromHeader(account),
    to: mail.to,
    cc: mail.cc,
    bcc: mail.bcc,
    replyTo: mail.replyTo,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    attachments: mail.attachments,
    inReplyTo: mail.inReplyTo,
    references: mail.references,
    priority: mail.priority,
    messageId,
    date: new Date(),
    xMailer: false,
  });
  const node = composer.compile();
  node.keepBcc = Boolean(opts.keepBcc);
  const env = node.getEnvelope();
  const raw = await node.build();
  return { raw, messageId, envelope: { from: env.from || account.email, to: env.to } };
}

function createTransport(account: Account) {
  return nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    // Implicit TLS (Zoho: 465) unless the port is a STARTTLS one (587, 25).
    secure: account.smtpPort !== 587 && account.smtpPort !== 25,
    auth: { user: account.email, pass: account.appPassword },
    // Test suite only: its local mock servers use a self-signed certificate.
    ...(process.env.ZOHO_TEST_INSECURE_TLS === "1" ? { tls: { rejectUnauthorized: false } } : {}),
  });
}

export async function sendBuilt(account: Account, built: Built): Promise<string> {
  if (built.envelope.to.length === 0) {
    throw new Error("No recipients — give at least one to, cc, or bcc address.");
  }
  const transport = createTransport(account);
  try {
    const info = await transport.sendMail({ envelope: built.envelope, raw: built.raw });
    return info.response ?? "accepted";
  } finally {
    transport.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Zoho normally files SMTP-sent mail in Sent on its own. Check for the message
 * by Message-ID and only append a copy if it never showed up, so Sent neither
 * misses a message nor holds it twice.
 */
export async function ensureInSent(account: Account, built: Built): Promise<string> {
  const sent = await withClient(account, (c) => findSpecial(c, "\\Sent"));
  if (!sent) return "no Sent folder found, so no copy was filed";
  for (const wait of [1500, 3500]) {
    await sleep(wait);
    const found = await withMailbox(
      account,
      sent.path,
      async (c) => {
        const uids = await c.search({ header: { "message-id": built.messageId } }, { uid: true });
        return Array.isArray(uids) && uids.length > 0;
      },
      { readOnly: true },
    );
    if (found) return `filed in ${sent.path}`;
  }
  await withClient(account, (c) => c.append(sent.path, built.raw, ["\\Seen"]));
  return `copy appended to ${sent.path}`;
}

export async function verifySmtp(account: Account): Promise<void> {
  const transport = createTransport(account);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}
