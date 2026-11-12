/**
 * AdSense reports in the account's time zone and keeps updating today's
 * estimated earnings all day, so "today" is always partial. Multi-day presets
 * therefore end yesterday; only `today` and `month_to_date` include today.
 *
 * Every range is resolved to explicit dates here and sent as dateRange=CUSTOM,
 * so the window a tool reports is exactly the window it asked for, and period
 * comparisons can be computed rather than approximated by API presets.
 */

export const RANGE_PRESETS = [
  "today",
  "yesterday",
  "last_7_days",
  "last_28_days",
  "last_30_days",
  "last_90_days",
  "month_to_date",
  "last_month",
  "year_to_date",
  "last_12_months",
] as const;

export type RangePreset = (typeof RANGE_PRESETS)[number];

export interface DateRange {
  startDate: string;
  endDate: string;
}

/** Local calendar date, since AdSense accounts report in a local time zone. */
export function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

export function addDays(iso: string, days: number): string {
  const d = parseIso(iso);
  d.setDate(d.getDate() + days);
  return toIso(d);
}

export function today(): string {
  return toIso(new Date());
}

export function daysBetween(range: DateRange): number {
  const ms = parseIso(range.endDate).getTime() - parseIso(range.startDate).getTime();
  return Math.round(ms / 86_400_000) + 1;
}

export function presetRange(preset: RangePreset, now = today()): DateRange {
  const yesterday = addDays(now, -1);
  const d = parseIso(now);
  switch (preset) {
    case "today":
      return { startDate: now, endDate: now };
    case "yesterday":
      return { startDate: yesterday, endDate: yesterday };
    case "last_7_days":
      return { startDate: addDays(yesterday, -6), endDate: yesterday };
    case "last_28_days":
      return { startDate: addDays(yesterday, -27), endDate: yesterday };
    case "last_30_days":
      return { startDate: addDays(yesterday, -29), endDate: yesterday };
    case "last_90_days":
      return { startDate: addDays(yesterday, -89), endDate: yesterday };
    case "month_to_date":
      return { startDate: toIso(new Date(d.getFullYear(), d.getMonth(), 1)), endDate: now };
    case "last_month":
      return {
        startDate: toIso(new Date(d.getFullYear(), d.getMonth() - 1, 1)),
        endDate: toIso(new Date(d.getFullYear(), d.getMonth(), 0)),
      };
    case "year_to_date":
      return { startDate: toIso(new Date(d.getFullYear(), 0, 1)), endDate: now };
    case "last_12_months": {
      const start = new Date(d.getFullYear(), d.getMonth() - 12, d.getDate());
      return { startDate: toIso(start), endDate: yesterday };
    }
  }
}

export interface ResolveRangeInput {
  startDate?: string;
  endDate?: string;
  range?: RangePreset;
}

/** Explicit dates always win; otherwise the preset, defaulting to `fallback`. */
export function resolveDateRange(
  input: ResolveRangeInput,
  fallback: RangePreset = "last_28_days",
): DateRange {
  if (input.startDate) {
    return { startDate: input.startDate, endDate: input.endDate ?? addDays(today(), -1) };
  }
  const preset = presetRange(input.range ?? fallback);
  return input.endDate ? { ...preset, endDate: input.endDate } : preset;
}

/** The window of equal length immediately preceding `range`. */
export function precedingRange(range: DateRange): DateRange {
  const length = daysBetween(range);
  return {
    startDate: addDays(range.startDate, -length),
    endDate: addDays(range.startDate, -1),
  };
}

export function describeRange(range: DateRange): string {
  return range.startDate === range.endDate
    ? range.startDate
    : `${range.startDate} to ${range.endDate}`;
}

export const EMPTY_HINT =
  "No rows. Either the account earned nothing in this window, the filters excluded everything, or " +
  "this dimension has no data for it (PAGE_URL only covers pages that served ads). AdSense keeps " +
  "report data for about three years.";
