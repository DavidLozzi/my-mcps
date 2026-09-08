import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runReport } from "../client.js";
import { guard, ok } from "../lib/tool.js";
import { describeRange, resolveDateRange, EMPTY_HINT } from "../lib/dates.js";
import { renderReportTable, renderTotals, reportWarnings } from "../lib/report.js";
import {
  buildFilterExpression,
  dateFields,
  filtersCombineField,
  filtersField,
  propertyIdField,
} from "./shared.js";

export function registerReportTool(server: McpServer): void {
  server.registerTool(
    "ga4_run_report",
    {
      title: "Run a Google Analytics report",
      description:
        "Raw GA4 report: any combination of dimensions and metrics over a date range, with filters and sorting. " +
        "This is the general-purpose escape hatch — use it for arbitrary breakdowns nothing else covers. For the " +
        "common questions prefer the purpose-built tools, which pick sensible fields and do the analysis: " +
        "ga4_traffic_overview (how is traffic doing), ga4_compare_periods (what changed and why), ga4_top_pages " +
        "(most-viewed content), ga4_acquisition (which channels work), ga4_landing_page_opportunities (what to " +
        "fix), ga4_funnel (where users drop off). Field names must be GA4 camelCase API names — get them from " +
        "ga4_get_metadata, not from the GA4 UI labels.",
      inputSchema: {
        propertyId: propertyIdField,
        metrics: z
          .array(z.string())
          .min(1)
          .max(10)
          .describe(
            "Metric API names, e.g. ['activeUsers','sessions','screenPageViews','engagementRate','keyEvents','totalRevenue'].",
          ),
        dimensions: z
          .array(z.string())
          .max(9)
          .optional()
          .describe(
            "Dimension API names to group by, in order, e.g. ['date'], ['pagePath'], ['sessionDefaultChannelGroup','deviceCategory']. Omit for a single totals row.",
          ),
        ...dateFields,
        dimensionFilters: filtersField,
        dimensionFiltersCombine: filtersCombineField,
        metricFilters: filtersField.describe(
          "Applied after aggregation, like SQL HAVING — e.g. only rows with sessions greater than 100. Use numericOperation/numericValue.",
        ),
        metricFiltersCombine: filtersCombineField,
        orderByMetric: z
          .string()
          .optional()
          .describe("Metric API name to sort by. Defaults to the first requested metric."),
        orderByDimension: z
          .string()
          .optional()
          .describe("Dimension API name to sort by instead of a metric — use for time series (e.g. 'date')."),
        descending: z
          .boolean()
          .default(true)
          .describe("Sort direction. Set false for chronological order when sorting by date."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100_000)
          .default(100)
          .describe("Rows to fetch from the API."),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Zero-based row offset for paging."),
        includeTotals: z
          .boolean()
          .default(true)
          .describe("Also report the aggregate total for each metric across all matching rows."),
        keepEmptyRows: z
          .boolean()
          .default(false)
          .describe("Include rows whose metrics are all zero."),
        currencyCode: z
          .string()
          .optional()
          .describe("ISO 4217 code for revenue metrics, e.g. USD. Defaults to the property's currency."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const range = resolveDateRange(args);

      const orderBys = args.orderByDimension
        ? [{ dimension: { dimensionName: args.orderByDimension }, desc: args.descending }]
        : [{ metric: { metricName: args.orderByMetric ?? args.metrics[0]! }, desc: args.descending }];

      const res = await runReport({
        propertyId: args.propertyId,
        dimensions: args.dimensions,
        metrics: args.metrics,
        startDate: range.startDate,
        endDate: range.endDate,
        dimensionFilter: buildFilterExpression(args.dimensionFilters, args.dimensionFiltersCombine),
        metricFilter: buildFilterExpression(args.metricFilters, args.metricFiltersCombine),
        orderBys,
        limit: args.limit,
        offset: args.offset,
        metricAggregations: args.includeTotals ? ["TOTAL"] : undefined,
        keepEmptyRows: args.keepEmptyRows,
        currencyCode: args.currencyCode,
      });

      const header = `${args.propertyId} — ${describeRange(range)}`;
      const rows = res.rows ?? [];

      if (rows.length === 0) {
        return ok(`${header}\n\n${EMPTY_HINT}${reportWarnings(res)}`);
      }

      const totals = args.includeTotals ? renderTotals(res) : "";

      return ok(
        `${header}\n` +
          `${res.rowCount ?? rows.length} matching rows${totals ? `\nTotals: ${totals}` : ""}\n\n` +
          renderReportTable(res, { hint: "Use offset to page, or add dimensionFilters to narrow." }) +
          reportWarnings(res),
      );
    }),
  );
}
