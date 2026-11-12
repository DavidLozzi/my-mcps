/**
 * AdSense returns every cell as a string, typed only by its column header.
 * Parse once here into keyed rows so tools work with numbers and names rather
 * than positional cells.
 */
import type { ReportHeader, ReportResponse } from "../client.js";
import { money, num, pct, table, truncationNotice } from "./format.js";

export interface ParsedRow {
  dims: Record<string, string>;
  metrics: Record<string, number>;
}

export interface ParsedReport {
  headers: ReportHeader[];
  rows: ParsedRow[];
  totals?: Record<string, number>;
  totalMatchedRows: number;
  currency: string;
  warnings: string[];
}

function parseCells(headers: ReportHeader[], cells: Array<{ value?: string }> = []): ParsedRow {
  const row: ParsedRow = { dims: {}, metrics: {} };
  headers.forEach((h, i) => {
    const value = cells[i]?.value ?? "";
    if (h.type === "DIMENSION") row.dims[h.name] = value;
    else row.metrics[h.name] = value === "" ? 0 : Number(value);
  });
  return row;
}

export function parseReport(res: ReportResponse): ParsedReport {
  const headers = res.headers ?? [];
  const rows = (res.rows ?? []).map((r) => parseCells(headers, r.cells));
  return {
    headers,
    rows,
    totals: res.totals ? parseCells(headers, res.totals.cells).metrics : undefined,
    totalMatchedRows: Number(res.totalMatchedRows ?? rows.length),
    currency: headers.find((h) => h.currencyCode)?.currencyCode ?? "USD",
    warnings: res.warnings ?? [],
  };
}

/** Format one metric value by its AdSense header type. */
export function formatMetric(header: ReportHeader, value: number): string {
  switch (header.type) {
    case "METRIC_CURRENCY":
      return money(value, header.currencyCode ?? "USD");
    case "METRIC_RATIO":
      return pct(value);
    case "METRIC_MILLISECONDS":
      return `${(value / 1000).toFixed(1)}s`;
    case "METRIC_DECIMAL":
      return value.toFixed(2);
    default:
      return num(value);
  }
}

export function renderReport(report: ParsedReport, includeTotals: boolean): string {
  const { headers } = report;
  const body = table(
    headers.map((h) => h.name),
    report.rows.map((r) =>
      headers.map((h) => (h.type === "DIMENSION" ? r.dims[h.name]! : formatMetric(h, r.metrics[h.name] ?? 0))),
    ),
  );

  const parts = [body + truncationNotice(report.rows.length, report.totalMatchedRows)];

  if (includeTotals && report.totals) {
    const totals = headers
      .filter((h) => h.type !== "DIMENSION")
      .map((h) => `  ${h.name}: ${formatMetric(h, report.totals![h.name] ?? 0)}`);
    parts.push(`TOTALS\n${totals.join("\n")}`);
  }

  if (report.warnings.length > 0) {
    parts.push(`NOTES\n${report.warnings.map((w) => `  - ${w}`).join("\n")}`);
  }

  return parts.join("\n\n");
}
