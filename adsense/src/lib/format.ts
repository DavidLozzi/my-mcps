/**
 * Compact text rendering shared by every tool, so results stay readable in a
 * context window instead of arriving as pretty-printed JSON.
 */

export function pct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

export function num(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/**
 * AdSense reports currency as a decimal string in the account (or requested)
 * currency. Show a symbol for the common ones and the ISO code otherwise.
 */
const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", CAD: "CA$", AUD: "A$" };

export function money(n: number, currency = "USD"): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const symbol = SYMBOLS[currency];
  return symbol ? `${sign}${symbol}${abs}` : `${sign}${abs} ${currency}`;
}

export function signedMoney(n: number, currency = "USD"): string {
  return n > 0 ? `+${money(n, currency)}` : money(n, currency);
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

export function truncationNotice(shown: number, total: number, hint?: string): string {
  if (shown >= total) return "";
  return `\n\nShowing ${shown} of ${total} rows. ${hint ?? "Raise `limit` or narrow the query to see more."}`;
}

/** Trim long URLs for table display while keeping the distinguishing tail. */
export function shortenUrl(url: string, max = 70): string {
  const bare = url.replace(/^https?:\/\//, "");
  if (bare.length <= max) return bare;
  const head = Math.ceil((max - 3) / 2);
  const tail = Math.floor((max - 3) / 2);
  return `${bare.slice(0, head)}...${bare.slice(-tail)}`;
}

/** Percent change, phrased for a human rather than as NaN or Infinity. */
export function changePct(now: number, before: number): string {
  if (before === 0) return now === 0 ? "0%" : "new";
  const change = ((now - before) / before) * 100;
  return `${change > 0 ? "+" : ""}${change.toFixed(1)}%`;
}

/** Page RPM: earnings per thousand page views. */
export function rpm(earnings: number, pageViews: number): number {
  return pageViews > 0 ? (earnings / pageViews) * 1000 : 0;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
