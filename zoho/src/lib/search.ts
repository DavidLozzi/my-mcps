import type { SearchObject } from "imapflow";

export interface SearchFilters {
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  text?: string;
  since?: string;
  before?: string;
  unread?: boolean;
  flagged?: boolean;
  answered?: boolean;
  hasAttachment?: boolean;
  keyword?: string;
  largerThanKb?: number;
  smallerThanKb?: number;
}

/** A YYYY-MM-DD day as local midnight, which is how IMAP SINCE/BEFORE compare. */
export function localDate(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function buildSearch(f: SearchFilters): SearchObject {
  const q: SearchObject = {};
  if (f.from) q.from = f.from;
  if (f.to) q.to = f.to;
  if (f.cc) q.cc = f.cc;
  if (f.subject) q.subject = f.subject;
  if (f.body) q.body = f.body;
  if (f.text) q.text = f.text;
  if (f.since) q.since = localDate(f.since);
  if (f.before) q.before = localDate(f.before);
  if (f.unread !== undefined) q.seen = !f.unread;
  if (f.flagged !== undefined) q.flagged = f.flagged;
  if (f.answered !== undefined) q.answered = f.answered;
  if (f.keyword) q.keyword = f.keyword;
  if (f.largerThanKb !== undefined) q.larger = Math.round(f.largerThanKb * 1024);
  if (f.smallerThanKb !== undefined) q.smaller = Math.round(f.smallerThanKb * 1024);
  // IMAP cannot search for attachments. A multipart/mixed top-level type is a
  // cheap server-side narrowing; the caller confirms against BODYSTRUCTURE.
  if (f.hasAttachment) q.header = { "content-type": "multipart/mixed" };
  if (Object.keys(q).length === 0) q.all = true;
  return q;
}

export function describeFilters(f: SearchFilters): string {
  const parts = Object.entries(f)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : v}`);
  return parts.length ? parts.join(", ") : "everything";
}
