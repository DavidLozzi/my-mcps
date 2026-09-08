/**
 * Search Analytics can return 25k rows per page. Rendering that as pretty JSON
 * would swamp the context window, so every tool emits compact rows through
 * here with an explicit truncation notice.
 */

export function pct(ctr: number): string {
  return `${(ctr * 100).toFixed(2)}%`;
}

export function pos(position: number): string {
  return position.toFixed(1);
}

export function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
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

/** Trim long URLs for table display while keeping the distinguishing tail. */
export function shortenUrl(url: string, max = 70): string {
  if (url.length <= max) return url;
  const head = Math.ceil((max - 3) / 2);
  const tail = Math.floor((max - 3) / 2);
  return `${url.slice(0, head)}...${url.slice(-tail)}`;
}
