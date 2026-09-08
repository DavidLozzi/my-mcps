/**
 * Search Console data lags roughly 2-3 days. Defaulting endDate to "today"
 * returns empty or partial rows, which reads as a broken tool rather than
 * missing data — so every default end date backs off by DATA_LAG_DAYS.
 */

export const DATA_LAG_DAYS = 3;

/** Search Console retains at most 16 months of Search Analytics data. */
export const MAX_RETENTION_MONTHS = 16;

export const RANGE_PRESETS = [
  "last_7_days",
  "last_28_days",
  "last_3_months",
  "last_6_months",
  "last_12_months",
  "last_16_months",
] as const;

export type RangePreset = (typeof RANGE_PRESETS)[number];

export interface DateRange {
  startDate: string;
  endDate: string;
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addMonths(d: Date, months: number): Date {
  const next = new Date(d);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

/** Latest date that reliably has data. */
export function defaultEndDate(): string {
  return toIso(addDays(new Date(), -DATA_LAG_DAYS));
}

function startForPreset(end: Date, preset: RangePreset): Date {
  switch (preset) {
    case "last_7_days":
      return addDays(end, -6);
    case "last_28_days":
      return addDays(end, -27);
    case "last_3_months":
      return addMonths(end, -3);
    case "last_6_months":
      return addMonths(end, -6);
    case "last_12_months":
      return addMonths(end, -12);
    case "last_16_months":
      return addMonths(end, -MAX_RETENTION_MONTHS);
  }
}

export interface ResolveRangeInput {
  startDate?: string;
  endDate?: string;
  range?: RangePreset;
}

/**
 * Explicit dates always win. Otherwise fall back to the preset (defaulting to
 * last_28_days), anchored on the most recent day with complete data.
 */
export function resolveDateRange(input: ResolveRangeInput): DateRange {
  const endDate = input.endDate ?? defaultEndDate();

  if (input.startDate) {
    return { startDate: input.startDate, endDate };
  }

  const preset = input.range ?? "last_28_days";
  return {
    startDate: toIso(startForPreset(new Date(`${endDate}T00:00:00Z`), preset)),
    endDate,
  };
}

/**
 * The window of equal length immediately preceding `range`, used as the default
 * comparison period in gsc_compare_periods.
 */
export function precedingRange(range: DateRange): DateRange {
  const start = new Date(`${range.startDate}T00:00:00Z`);
  const end = new Date(`${range.endDate}T00:00:00Z`);
  const lengthDays = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;

  return {
    startDate: toIso(addDays(start, -lengthDays)),
    endDate: toIso(addDays(start, -1)),
  };
}

export function describeRange(range: DateRange): string {
  return `${range.startDate} to ${range.endDate}`;
}
