import type { FetchMessageObject, MessageAddressObject, MessageStructureObject } from "imapflow";
import type { AddressObject, ParsedMail } from "mailparser";
import { convert } from "html-to-text";

export interface Summary {
  id: string;
  folder: string;
  uid: number;
  date?: Date;
  from: string;
  to: string;
  subject: string;
  flags: Set<string>;
  size?: number;
  hasAttachment: boolean;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local time as YYYY-MM-DD HH:MM — the same shape the tools accept. */
export function fmtDate(d: Date | string | undefined): string {
  if (!d) return "-";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "-";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fmtSize(bytes: number | undefined): string {
  if (bytes === undefined) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtAddress(a: MessageAddressObject | { name?: string; address?: string }): string {
  if (a.name && a.address) return `${a.name} <${a.address}>`;
  return a.address ?? a.name ?? "";
}

export function fmtAddresses(list: MessageAddressObject[] | undefined): string {
  return (list ?? []).map(fmtAddress).filter(Boolean).join(", ");
}

export function fmtParsedAddresses(value: AddressObject | AddressObject[] | undefined): string {
  if (!value) return "";
  const groups = Array.isArray(value) ? value : [value];
  return groups
    .flatMap((g) => g.value)
    .map((a) => fmtAddress({ name: a.name, address: a.address }))
    .filter(Boolean)
    .join(", ");
}

/** True when any part is a real attachment rather than body text or an inline image. */
export function hasAttachment(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;
  if (node.childNodes?.length) return node.childNodes.some(hasAttachment);
  const disposition = node.disposition?.toLowerCase();
  if (disposition === "attachment") return true;
  const named = Boolean(node.dispositionParameters?.filename ?? node.parameters?.name);
  return named && disposition !== "inline" && !node.type.startsWith("text/");
}

export function toSummary(msg: FetchMessageObject, folder: string, id: string): Summary {
  const env = msg.envelope ?? {};
  return {
    id,
    folder,
    uid: msg.uid,
    date: env.date ? new Date(env.date) : msg.internalDate ? new Date(msg.internalDate) : undefined,
    from: fmtAddresses(env.from) || "(no sender)",
    to: fmtAddresses(env.to),
    subject: env.subject || "(no subject)",
    flags: msg.flags ?? new Set(),
    size: msg.size,
    hasAttachment: hasAttachment(msg.bodyStructure),
  };
}

export function flagMarks(flags: Set<string>): string {
  const marks: string[] = [];
  if (!flags.has("\\Seen")) marks.push("UNREAD");
  if (flags.has("\\Flagged")) marks.push("FLAGGED");
  if (flags.has("\\Answered")) marks.push("REPLIED");
  if (flags.has("$Forwarded")) marks.push("FORWARDED");
  if (flags.has("\\Draft")) marks.push("DRAFT");
  const keywords = [...flags].filter((f) => !f.startsWith("\\") && !f.startsWith("$"));
  if (keywords.length) marks.push(`#${keywords.join(" #")}`);
  return marks.join(" ");
}

export function renderLine(s: Summary, opts: { showFolder?: boolean } = {}): string {
  const marks = flagMarks(s.flags);
  const extras = [marks, s.hasAttachment ? "[attachment]" : "", opts.showFolder ? `in ${s.folder}` : ""]
    .filter(Boolean)
    .join("  ");
  return `${fmtDate(s.date)}  ${s.from}\n  ${s.subject}${extras ? `\n  ${extras}` : ""}\n  id: ${s.id}`;
}

export function renderList(summaries: Summary[], opts: { showFolder?: boolean } = {}): string {
  return summaries.map((s) => renderLine(s, opts)).join("\n\n");
}

/** Body as readable text: the plain part when there is one, otherwise the HTML flattened. */
export function bodyText(parsed: ParsedMail): string {
  const text = parsed.text?.trim();
  if (text) return text;
  if (parsed.html) {
    return convert(parsed.html, {
      wordwrap: false,
      selectors: [
        { selector: "img", format: "skip" },
        { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
      ],
    }).trim();
  }
  return "";
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[… truncated ${text.length - max} more characters — pass a larger maxChars to see more]`;
}

/** Drop quoted reply history (lines starting with ">" and the "On … wrote:" line before them). */
export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*>/.test(line)) continue;
    if (/^On .+wrote:\s*$/.test(line) && lines.slice(i + 1).some((l) => /^\s*>/.test(l))) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export interface UnsubscribeOptions {
  urls: string[];
  mailto: string[];
  oneClick: boolean;
}

/** RFC 2369 List-Unsubscribe plus the RFC 8058 one-click marker, read from the raw header lines. */
export function unsubscribeOptions(parsed: ParsedMail): UnsubscribeOptions | undefined {
  const raw = (name: string) =>
    parsed.headerLines
      .filter((h) => h.key === name)
      .map((h) => h.line.replace(/^[^:]+:\s*/, "").replace(/\r?\n\s+/g, " "))
      .join(", ");
  const header = raw("list-unsubscribe");
  if (!header) return undefined;
  const entries = [...header.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  const urls = entries.filter((e) => /^https?:/i.test(e));
  const mailto = entries.filter((e) => /^mailto:/i.test(e));
  const oneClick = /List-Unsubscribe=One-Click/i.test(raw("list-unsubscribe-post"));
  if (!urls.length && !mailto.length) return undefined;
  return { urls, mailto, oneClick };
}

export interface AttachmentInfo {
  index: number;
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
}

export function attachmentInfo(parsed: ParsedMail): AttachmentInfo[] {
  return parsed.attachments.map((a, i) => ({
    index: i + 1,
    filename: a.filename ?? `attachment-${i + 1}`,
    contentType: a.contentType,
    size: a.size,
    inline: a.contentDisposition === "inline" || Boolean(a.related),
  }));
}

export function renderDetail(
  id: string,
  folder: string,
  flags: Set<string>,
  parsed: ParsedMail,
  maxChars: number,
): string {
  const lines: string[] = [];
  const add = (label: string, value: string | undefined) => {
    if (value) lines.push(`${label.padEnd(9)}${value}`);
  };
  add("Subject:", parsed.subject || "(no subject)");
  add("From:", fmtParsedAddresses(parsed.from));
  add("To:", fmtParsedAddresses(parsed.to));
  add("Cc:", fmtParsedAddresses(parsed.cc));
  add("Bcc:", fmtParsedAddresses(parsed.bcc));
  add("Reply-To:", fmtParsedAddresses(parsed.replyTo));
  add("Date:", fmtDate(parsed.date));
  add("Folder:", folder);
  add("Flags:", flagMarks(flags) || "read");
  add("Msg-ID:", parsed.messageId);
  lines.push(`id:      ${id}`);

  const atts = attachmentInfo(parsed);
  if (atts.length) {
    lines.push("", `ATTACHMENTS (${atts.length}) — email_download_attachment takes the index`);
    for (const a of atts) {
      lines.push(`  ${a.index}. ${a.filename}  ${a.contentType}  ${fmtSize(a.size)}${a.inline ? "  (inline)" : ""}`);
    }
  }

  const unsub = unsubscribeOptions(parsed);
  if (unsub) {
    lines.push("", `Unsubscribe available${unsub.oneClick ? " (one-click)" : ""} — email_unsubscribe`);
  }

  const body = bodyText(parsed);
  lines.push("", "BODY", body ? truncate(body, maxChars) : "(empty)");
  return lines.join("\n");
}
