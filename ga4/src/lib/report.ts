/**
 * One place that turns a RunReportResponse into text. Every tool goes through
 * here so metric formatting, the `(other)` cardinality warning, thresholding,
 * and quota pressure are reported identically no matter which tool asked.
 */
import type { ReportResponse, ReportRow } from "../client.js";
import { dur, num, pct, shortenUrl, table, truncationNotice } from "./format.js";

export function dimValue(row: ReportRow, index: number): string {
  return row.dimensionValues?.[index]?.value ?? "";
}

export function metricValue(row: ReportRow, index: number): number {
  const raw = row.metricValues?.[index]?.value;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Metric index by API name, so tools can read a column without counting. */
export function metricIndex(res: ReportResponse): Map<string, number> {
  const map = new Map<string, number>();
  (res.metricHeaders ?? []).forEach((h, i) => {
    if (h.name) map.set(h.name, i);
  });
  return map;
}

/**
 * GA4 reports rates as fractions and durations as seconds, both of which read
 * badly raw. The metric's declared type covers most of it; names ending in
 * "Rate" are the exception the type system does not distinguish.
 */
export function formatMetric(name: string, type: string | undefined, value: number): string {
  if (/Rate$/.test(name) || name === "sessionKeyEventRate") return pct(value);

  switch (type) {
    case "TYPE_SECONDS":
      return dur(value);
    case "TYPE_MILLISECONDS":
      return dur(value / 1000);
    case "TYPE_MINUTES":
      return dur(value * 60);
    case "TYPE_HOURS":
      return dur(value * 3600);
    case "TYPE_CURRENCY":
      return value.toFixed(2);
    case "TYPE_FLOAT":
    case "TYPE_STANDARD":
      return Number.isInteger(value) ? num(value) : value.toFixed(2);
    default:
      return num(value);
  }
}

/** Dimensions whose values are long enough to need trimming in a table. */
const LONG_DIMENSIONS = new Set([
  "pagePath",
  "pagePathPlusQueryString",
  "fullPageUrl",
  "landingPage",
  "landingPagePlusQueryString",
  "pageLocation",
  "pageReferrer",
  "unifiedPagePathScreen",
  "pageTitle",
]);

export interface RenderOptions {
  /** Rows rendered before truncating. */
  cap?: number;
  /** Width budget for long dimension values. */
  urlWidth?: number;
  hint?: string;
}

export function renderReportTable(res: ReportResponse, opts: RenderOptions = {}): string {
  const cap = opts.cap ?? 200;
  const rows = res.rows ?? [];
  if (rows.length === 0) return "(no rows)";

  const dimHeaders = (res.dimensionHeaders ?? []).map((h) => h.name ?? "");
  const metHeaders = res.metricHeaders ?? [];
  const shown = rows.slice(0, cap);

  const body = shown.map((row) => [
    ...dimHeaders.map((name, i) => {
      const value = dimValue(row, i);
      return LONG_DIMENSIONS.has(name) ? shortenUrl(value, opts.urlWidth ?? 55) : value;
    }),
    ...metHeaders.map((h, i) => formatMetric(h.name ?? "", h.type, metricValue(row, i))),
  ]);

  return (
    table([...dimHeaders, ...metHeaders.map((h) => h.name ?? "")], body) +
    truncationNotice({
      shown: shown.length,
      total: rows.length,
      hint: opts.hint,
    })
  );
}

/** Totals row, when the request asked for metricAggregations. */
export function renderTotals(res: ReportResponse): string {
  const totals = res.totals?.[0];
  if (!totals) return "";
  const metHeaders = res.metricHeaders ?? [];
  return metHeaders
    .map((h, i) => `${h.name}: ${formatMetric(h.name ?? "", h.type, metricValue(totals, i))}`)
    .join("  |  ");
}

/**
 * Anything that makes the numbers less trustworthy than they look. Silence here
 * is meaningful: it means the report is complete and unsampled.
 */
export function reportWarnings(res: ReportResponse): string {
  const notes: string[] = [];
  const meta = res.metadata ?? {};

  if (meta.dataLossFromOtherRow) {
    notes.push(
      "Cardinality limit hit: GA4 collapsed some rows into an `(other)` bucket, so per-row totals " +
        "here understate reality. Narrow the date range, add a dimension filter, or query fewer " +
        "dimensions at once for exact numbers.",
    );
  }
  if (meta.subjectToThresholding) {
    notes.push(
      "Thresholding applied: GA4 withheld rows to prevent identifying individuals (this happens " +
        "with demographic or audience dimensions on low-volume data), so totals are incomplete.",
    );
  }
  if (meta.emptyReason) {
    notes.push(`Google reported an empty result: ${meta.emptyReason}`);
  }
  const sampling = meta.samplingMetadatas ?? [];
  for (const s of sampling) {
    const read = Number(s.samplesReadCount ?? 0);
    const space = Number(s.samplingSpaceSize ?? 0);
    if (space > 0 && read < space) {
      notes.push(
        `Sampled: based on ${num(read)} of ${num(space)} events (${pct(read / space)}). ` +
          `Shorten the date range for unsampled numbers.`,
      );
    }
  }

  const quota = res.propertyQuota;
  if (quota) {
    const low = (bucket?: { consumed?: number; remaining?: number }) => {
      if (!bucket || bucket.remaining === undefined || bucket.consumed === undefined) return false;
      const total = bucket.remaining + bucket.consumed;
      return total > 0 && bucket.remaining / total < 0.2;
    };
    if (low(quota.tokensPerDay)) {
      notes.push(`Quota warning: ${num(quota.tokensPerDay!.remaining!)} core tokens left today.`);
    } else if (low(quota.tokensPerHour)) {
      notes.push(`Quota warning: ${num(quota.tokensPerHour!.remaining!)} core tokens left this hour.`);
    }
  }

  return notes.length === 0 ? "" : `\n\nNOTES\n${notes.map((n) => `- ${n}`).join("\n")}`;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}
