/**
 * A GA4 report can return 250,000 rows. Rendering that as pretty JSON would
 * swamp the context window, so every tool emits compact rows through here with
 * an explicit truncation notice.
 */

export function pct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

export function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

/** GA4 counts run far larger than Search Console's, so group thousands. */
export function num(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Seconds to `2m 14s`, for averageSessionDuration and engagement durations. */
export function dur(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

/**
 * Render `rows` as an aligned text table. Falls back to a placeholder when
 * there is nothing to show, so tools never return an empty content block.
 */
export function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "(no rows)";

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );

  const render = (cells: string[]) =>
    cells.map((c, i) => (c ?? "").padEnd(widths[i]!)).join("  ").trimEnd();

  return [
    render(headers),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...rows.map(render),
  ].join("\n");
}

export interface TruncationOptions {
  /** How many rows are actually rendered. */
  shown: number;
  /** How many rows matched before capping. */
  total: number;
  /** Advice for widening or narrowing the result set. */
  hint?: string;
}

export function truncationNotice(opts: TruncationOptions): string {
  if (opts.shown >= opts.total) return "";
  const hint = opts.hint ?? "Raise `limit` or narrow the query to see more.";
  return `\n\nShowing ${opts.shown} of ${opts.total} rows. ${hint}`;
}

/** Trim long paths/URLs for table display while keeping the distinguishing tail. */
export function shortenUrl(url: string, max = 70): string {
  if (url.length <= max) return url;
  const head = Math.ceil((max - 3) / 2);
  const tail = Math.floor((max - 3) / 2);
  return `${url.slice(0, head)}...${url.slice(-tail)}`;
}

/** Percent change, phrased for a human rather than as NaN or Infinity. */
export function changePct(now: number, before: number): string {
  if (before === 0) return now === 0 ? "0%" : "new";
  return `${(((now - before) / before) * 100).toFixed(1)}%`;
}
