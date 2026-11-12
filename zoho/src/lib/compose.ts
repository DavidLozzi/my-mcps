import type { AddressObject, ParsedMail } from "mailparser";
import { bodyText, fmtDate, fmtParsedAddresses } from "./render.js";

export interface Address {
  name?: string;
  address: string;
}

function flatten(value: AddressObject | AddressObject[] | undefined): Address[] {
  if (!value) return [];
  const groups = Array.isArray(value) ? value : [value];
  return groups.flatMap((g) => g.value).flatMap((a) => (a.address ? [{ name: a.name || undefined, address: a.address }] : []));
}

export function fmt(a: Address): string {
  return a.name ? `"${a.name.replace(/"/g, "'")}" <${a.address}>` : a.address;
}

function dedupe(list: Address[], exclude: Set<string>): Address[] {
  const seen = new Set(exclude);
  const out: Address[] = [];
  for (const a of list) {
    const key = a.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

export function prefixSubject(prefix: "Re" | "Fwd", subject: string | undefined): string {
  const s = (subject ?? "").trim();
  const pattern = prefix === "Re" ? /^re:/i : /^(fwd?|fw):/i;
  return pattern.test(s) ? s : `${prefix}: ${s}`.trim();
}

/**
 * Who a reply goes to. Reply-To wins over From. Reply-all adds the original To
 * and Cc, leaving out every address that is this account. Replying to a message
 * this account sent goes back to its original recipients instead of to itself.
 */
export function replyRecipients(
  original: ParsedMail,
  self: Set<string>,
  all: boolean,
): { to: Address[]; cc: Address[] } {
  const from = flatten(original.from);
  const fromSelf = from.length > 0 && from.every((a) => self.has(a.address.toLowerCase()));
  const primary = fromSelf ? flatten(original.to) : flatten(original.replyTo).length ? flatten(original.replyTo) : from;
  const to = dedupe(primary, fromSelf ? new Set(self) : new Set());
  if (!all) return { to: to.length ? to : primary, cc: [] };
  const exclude = new Set([...self, ...to.map((a) => a.address.toLowerCase())]);
  const cc = dedupe([...(fromSelf ? [] : flatten(original.to)), ...flatten(original.cc)], exclude);
  return { to, cc };
}

export function threadHeaders(original: ParsedMail): { inReplyTo?: string; references?: string[] } {
  const refs = original.references ? (Array.isArray(original.references) ? original.references : [original.references]) : [];
  if (!original.messageId) return refs.length ? { references: refs } : {};
  return { inReplyTo: original.messageId, references: [...refs.filter((r) => r !== original.messageId), original.messageId] };
}

function quote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => (l.startsWith(">") ? `>${l}` : `> ${l}`))
    .join("\n");
}

export function replyText(original: ParsedMail, body: string): string {
  const who = fmtParsedAddresses(original.from) || "someone";
  return `${body.trimEnd()}\n\nOn ${fmtDate(original.date)}, ${who} wrote:\n${quote(bodyText(original))}\n`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function textToHtml(text: string): string {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

/** HTML reply: the new body, then the original HTML in a blockquote, as mail clients do. */
export function replyHtml(original: ParsedMail, bodyHtml: string): string | undefined {
  if (!original.html) return undefined;
  const who = escapeHtml(fmtParsedAddresses(original.from) || "someone");
  return (
    `<div>${bodyHtml}</div>\n<br>\n<div>On ${escapeHtml(fmtDate(original.date))}, ${who} wrote:</div>\n` +
    `<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${original.html}</blockquote>`
  );
}

function forwardHeaderLines(original: ParsedMail): string[] {
  return [
    "---------- Forwarded message ---------",
    `From: ${fmtParsedAddresses(original.from)}`,
    `Date: ${fmtDate(original.date)}`,
    `Subject: ${original.subject ?? ""}`,
    `To: ${fmtParsedAddresses(original.to)}`,
    ...(original.cc ? [`Cc: ${fmtParsedAddresses(original.cc)}`] : []),
  ];
}

export function forwardText(original: ParsedMail, note: string | undefined): string {
  return `${note ? `${note.trimEnd()}\n\n` : ""}${forwardHeaderLines(original).join("\n")}\n\n${bodyText(original)}\n`;
}

export function forwardHtml(original: ParsedMail, noteHtml: string | undefined): string | undefined {
  if (!original.html) return undefined;
  const header = forwardHeaderLines(original).map(escapeHtml).join("<br>");
  return `${noteHtml ? `<div>${noteHtml}</div><br>` : ""}<div>${header}</div><br>\n${original.html}`;
}
