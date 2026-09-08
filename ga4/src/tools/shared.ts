/**
 * Field schemas shared across tools. The filter shape here is deliberately flat
 * — GA4's real FilterExpression is recursive, which produces a $ref-heavy JSON
 * schema that models fill in badly. One list of clauses plus a combiner covers
 * essentially every filter anyone asks for in conversation.
 */
import { z } from "zod";
import {
  Ga4ApiError,
  runReport,
  runReportAll,
  type FilterExpression,
  type OrderBy,
  type ReportRequest,
  type ReportResponse,
} from "../client.js";
import { RANGE_PRESETS } from "../lib/dates.js";

export const propertyIdField = z
  .string()
  .describe(
    "GA4 property, as the numeric id from ga4_list_properties (e.g. 123456789). The prefixed form " +
      "properties/123456789 is accepted too. A G-XXXXXXX measurement id will not work.",
  );

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD");

export const rangeSchema = z.enum(RANGE_PRESETS);

/** Shared date/range fields. Explicit dates always beat the preset. */
export const dateFields = {
  startDate: dateSchema
    .optional()
    .describe("Start of the window, YYYY-MM-DD. Overrides `range` when set."),
  endDate: dateSchema
    .optional()
    .describe(
      "End of the window, YYYY-MM-DD. Defaults to yesterday, since today is always a partial day in GA4.",
    ),
  range: rangeSchema
    .optional()
    .describe("Relative window used when startDate is omitted. Defaults to last_28_days."),
};

export const matchTypeSchema = z.enum([
  "EXACT",
  "BEGINS_WITH",
  "ENDS_WITH",
  "CONTAINS",
  "FULL_REGEXP",
  "PARTIAL_REGEXP",
]);

export const numericOperationSchema = z.enum([
  "EQUAL",
  "LESS_THAN",
  "LESS_THAN_OR_EQUAL",
  "GREATER_THAN",
  "GREATER_THAN_OR_EQUAL",
]);

export const filterClauseSchema = z.object({
  fieldName: z
    .string()
    .describe(
      "API name of the dimension (for dimensionFilters) or metric (for metricFilters) to test, e.g. pagePath, sessionSource, sessions.",
    ),
  match: matchTypeSchema
    .optional()
    .describe("String comparison to use with `value`. Defaults to EXACT."),
  value: z.string().optional().describe("Single value to compare against, used with `match`."),
  values: z
    .array(z.string())
    .optional()
    .describe("Match any of these values (an IN list). Use instead of `value`."),
  numericOperation: numericOperationSchema
    .optional()
    .describe("Numeric comparison, used with `numericValue`. Required for metric filters."),
  numericValue: z.number().optional().describe("Number to compare against."),
  betweenFrom: z.number().optional().describe("Lower bound of an inclusive range; pair with betweenTo."),
  betweenTo: z.number().optional().describe("Upper bound of an inclusive range."),
  caseSensitive: z.boolean().optional().describe("Case-sensitive string matching. Defaults to false."),
  negate: z.boolean().optional().describe("Invert this single clause (NOT)."),
});

export type FilterClause = z.infer<typeof filterClauseSchema>;

export const filtersField = z
  .array(filterClauseSchema)
  .optional()
  .describe(
    "Restrict rows to matching dimension values, e.g. only pagePath beginning with /blog. Combined per `filtersCombine`.",
  );

export const filtersCombineField = z
  .enum(["AND", "OR"])
  .default("AND")
  .describe("How multiple filter clauses combine.");

function clauseToExpression(clause: FilterClause): FilterExpression {
  const base: FilterExpression = { filter: buildFilter(clause) };
  return clause.negate ? { notExpression: base } : base;
}

function buildFilter(clause: FilterClause) {
  if (clause.values && clause.values.length > 0) {
    return {
      fieldName: clause.fieldName,
      inListFilter: { values: clause.values, caseSensitive: clause.caseSensitive ?? false },
    };
  }
  if (clause.betweenFrom !== undefined && clause.betweenTo !== undefined) {
    return {
      fieldName: clause.fieldName,
      betweenFilter: {
        fromValue: { doubleValue: clause.betweenFrom },
        toValue: { doubleValue: clause.betweenTo },
      },
    };
  }
  if (clause.numericOperation && clause.numericValue !== undefined) {
    return {
      fieldName: clause.fieldName,
      numericFilter: {
        operation: clause.numericOperation,
        value: { doubleValue: clause.numericValue },
      },
    };
  }
  return {
    fieldName: clause.fieldName,
    stringFilter: {
      matchType: clause.match ?? "EXACT",
      value: clause.value ?? "",
      caseSensitive: clause.caseSensitive ?? false,
    },
  };
}

/** Undefined when there is nothing to filter, so the request omits the field. */
export function buildFilterExpression(
  clauses: FilterClause[] | undefined,
  combine: "AND" | "OR" = "AND",
): FilterExpression | undefined {
  if (!clauses || clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauseToExpression(clauses[0]!);

  const expressions = clauses.map(clauseToExpression);
  return combine === "OR" ? { orGroup: { expressions } } : { andGroup: { expressions } };
}

export const limitField = z
  .number()
  .int()
  .min(1)
  .max(500)
  .default(50)
  .describe("Maximum rows to return.");

export const maxRowsField = z
  .number()
  .int()
  .min(100)
  .max(100_000)
  .default(10_000)
  .describe(
    "Upper bound on rows pulled from the API before analysis. Raise for large properties, lower to spend less quota.",
  );

/** Sort by a metric descending, the default every ranking tool wants. */
export function orderByMetric(metricName: string, desc = true): OrderBy[] {
  return [{ metric: { metricName }, desc }];
}

export function orderByDimension(dimensionName: string, desc = false): OrderBy[] {
  return [{ dimension: { dimensionName }, desc }];
}

/**
 * Newer metric names (keyEvents, sessionKeyEventRate) do not exist on every
 * property, and an older property answers a request containing one with a 400
 * naming the field. Rather than making every analysis tool refuse to run, drop
 * the offending optional metrics and retry once.
 */
export async function runReportTolerant(
  request: Omit<ReportRequest, "metrics">,
  required: string[],
  optional: string[] = [],
): Promise<{ res: ReportResponse; metrics: string[]; dropped: string[] }> {
  const metrics = [...required, ...optional];
  try {
    return { res: await runReport({ ...request, metrics }), metrics, dropped: [] };
  } catch (err) {
    if (!(err instanceof Ga4ApiError) || err.status !== 400 || optional.length === 0) throw err;

    const dropped = optional.filter((name) => err.message.includes(name));
    if (dropped.length === 0) throw err;

    const kept = metrics.filter((name) => !dropped.includes(name));
    return { res: await runReport({ ...request, metrics: kept }), metrics: kept, dropped };
  }
}

/** Same fallback, for the paging variant used by the analysis tools. */
export async function runReportAllTolerant(
  request: Omit<ReportRequest, "metrics" | "limit" | "offset">,
  required: string[],
  optional: string[],
  maxRows: number,
): Promise<{ res: ReportResponse; metrics: string[]; dropped: string[] }> {
  const metrics = [...required, ...optional];
  try {
    return { res: await runReportAll({ ...request, metrics }, maxRows), metrics, dropped: [] };
  } catch (err) {
    if (!(err instanceof Ga4ApiError) || err.status !== 400 || optional.length === 0) throw err;

    const dropped = optional.filter((name) => err.message.includes(name));
    if (dropped.length === 0) throw err;

    const kept = metrics.filter((name) => !dropped.includes(name));
    return { res: await runReportAll({ ...request, metrics: kept }, maxRows), metrics: kept, dropped };
  }
}

/** Footnote naming metrics this property could not answer. */
export function droppedNotice(dropped: string[]): string {
  if (dropped.length === 0) return "";
  return (
    `\n\nNote: this property does not support ${dropped.join(", ")}, so those columns are absent. ` +
    `Older properties use 'conversions' where newer ones use 'keyEvents' — ga4_get_metadata shows which exist here.`
  );
}
