import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { generateReport, resolveAccount } from "../client.js";
import { guard, ok } from "../lib/tool.js";
import { describeRange, resolveDateRange, EMPTY_HINT } from "../lib/dates.js";
import { parseReport, renderReport } from "../lib/report.js";
import { accountField, apiName, dateFields } from "./shared.js";

/**
 * The AdSense API exposes no metadata endpoint, so the common field names live
 * here. Not exhaustive — the API accepts any value of its Metric and Dimension
 * enums — but it covers what publishers actually ask about.
 */
const METRICS: Array<[string, string]> = [
  ["ESTIMATED_EARNINGS", "Estimated earnings (account currency)"],
  ["PAGE_VIEWS", "Page views with at least one ad request"],
  ["PAGE_VIEWS_RPM", "Earnings per 1,000 page views — the headline yield metric"],
  ["PAGE_VIEWS_CTR", "Clicks per page view"],
  ["IMPRESSIONS", "Ad impressions (ad units shown)"],
  ["IMPRESSIONS_RPM", "Earnings per 1,000 impressions"],
  ["IMPRESSIONS_CTR", "Clicks per impression"],
  ["INDIVIDUAL_AD_IMPRESSIONS", "Individual ads shown (an ad unit can show several)"],
  ["CLICKS", "Ad clicks"],
  ["COST_PER_CLICK", "Earnings per click"],
  ["AD_REQUESTS", "Ad requests"],
  ["MATCHED_AD_REQUESTS", "Ad requests that returned an ad"],
  ["AD_REQUESTS_COVERAGE", "Matched / total ad requests — low coverage means unfilled inventory"],
  ["ACTIVE_VIEW_VIEWABILITY", "Share of measurable impressions that were viewable"],
  ["ACTIVE_VIEW_MEASURABILITY", "Share of impressions Active View could measure"],
  ["ACTIVE_VIEW_TIME", "Average viewable time per impression"],
  ["TOTAL_EARNINGS", "Earnings including adjustments (not available on every account)"],
];

const DIMENSIONS: Array<[string, string]> = [
  ["DATE / WEEK / MONTH", "Time series"],
  ["PAGE_URL", "The page the ad served on (supports only a subset of metrics)"],
  ["DOMAIN_NAME", "The (sub)domain the ad served on"],
  ["OWNED_SITE_DOMAIN_NAME / OWNED_SITE_ID", "The site as registered in AdSense"],
  ["AD_UNIT_NAME / AD_UNIT_ID", "Manual ad unit"],
  ["AD_FORMAT_NAME", "Display, in-feed, in-article, multiplex, anchor, vignette…"],
  ["AD_PLACEMENT_NAME", "Auto ads vs manual placement"],
  ["CUSTOM_CHANNEL_NAME / URL_CHANNEL_NAME", "Channels set up in AdSense"],
  ["COUNTRY_NAME / COUNTRY_CODE", "Visitor country"],
  ["PLATFORM_TYPE_NAME", "Desktop / mobile / tablet"],
  ["BUYER_NETWORK_NAME", "Which ad network won the auction"],
  ["BID_TYPE_NAME", "CPC vs CPM"],
  ["CREATIVE_SIZE_NAME", "Served creative size"],
  ["PRODUCT_NAME", "AdSense for Content, Search, etc."],
];

export function registerReportTools(server: McpServer): void {
  server.registerTool(
    "adsense_run_report",
    {
      title: "Run an AdSense report",
      description:
        "Raw AdSense report: any dimensions and metrics over a date range, with filters and sorting. The " +
        "general-purpose escape hatch for breakdowns nothing else covers. For the common questions prefer the " +
        "purpose-built tools: adsense_earnings_overview (how am I doing), adsense_compare_periods (what changed), " +
        "adsense_top_pages (which pages earn), adsense_rpm_opportunities (which pages under-earn). Names are " +
        "UPPER_SNAKE_CASE API enums — adsense_report_fields lists the common ones.",
      inputSchema: {
        account: accountField,
        metrics: z
          .array(z.string())
          .min(1)
          .max(20)
          .describe("Metric names, e.g. ['ESTIMATED_EARNINGS','PAGE_VIEWS','PAGE_VIEWS_RPM','CLICKS']."),
        dimensions: z
          .array(z.string())
          .max(8)
          .optional()
          .describe("Dimensions to group by, in order, e.g. ['DATE'] or ['COUNTRY_NAME','PLATFORM_TYPE_NAME']. Omit for totals only."),
        ...dateFields,
        filters: z
          .array(z.string())
          .optional()
          .describe(
            "AdSense filter expressions, ANDed together. Operators: == equals, != not equals, =@ contains, " +
              "!@ does not contain. Comma inside one expression ORs values. E.g. ['COUNTRY_CODE==US', " +
              "'DOMAIN_NAME=@starwars']. Escape a literal comma or backslash with a backslash.",
          ),
        orderBy: z
          .array(z.string())
          .optional()
          .describe(
            "Sort keys, prefixed + for ascending or - for descending, e.g. ['-ESTIMATED_EARNINGS'] or ['+DATE']. " +
              "Defaults to the first metric descending, or +DATE when grouping by DATE.",
          ),
        limit: z.number().int().min(1).max(100_000).default(100).describe("Maximum rows to return."),
        currencyCode: z
          .string()
          .length(3)
          .optional()
          .describe("ISO 4217 code to report earnings in. Defaults to the account currency."),
        includeTotals: z.boolean().default(true).describe("Also report the total across all matching rows."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const acct = await resolveAccount(args.account);
      const dateRange = resolveDateRange(args);
      const metrics = args.metrics.map(apiName);
      const dimensions = (args.dimensions ?? []).map(apiName);

      const orderBy =
        args.orderBy && args.orderBy.length > 0
          ? args.orderBy.map((o) => o.trim().replace(/^([+-]?)(.*)$/, (_, sign, name) => `${sign || "+"}${apiName(name)}`))
          : dimensions[0] === "DATE" || dimensions[0] === "WEEK" || dimensions[0] === "MONTH"
            ? [`+${dimensions[0]}`]
            : dimensions.length > 0
              ? [`-${metrics[0]}`]
              : undefined;

      const report = parseReport(
        await generateReport(acct, {
          dateRange,
          metrics,
          dimensions,
          filters: args.filters,
          orderBy,
          limit: args.limit,
          currencyCode: args.currencyCode,
        }),
      );

      const header = `AdSense report, ${describeRange(dateRange)}${args.filters?.length ? ` — filters: ${args.filters.join(" AND ")}` : ""}`;
      if (report.rows.length === 0 && dimensions.length > 0) return ok(`${header}\n\n${EMPTY_HINT}`);
      return ok(`${header}\n\n${renderReport(report, args.includeTotals)}`);
    }),
  );

  server.registerTool(
    "adsense_report_fields",
    {
      title: "AdSense report field reference",
      description:
        "The common AdSense report metric and dimension API names with what each means. AdSense has no metadata " +
        "endpoint, so check here before composing an adsense_run_report call rather than guessing names.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async () => {
      const render = (rows: Array<[string, string]>) =>
        rows.map(([name, desc]) => `  ${name.padEnd(40)} ${desc}`).join("\n");
      return ok(
        `METRICS\n${render(METRICS)}\n\nDIMENSIONS\n${render(DIMENSIONS)}\n\n` +
          `Most dimensions come in _NAME and _CODE/_ID pairs; group by the _ID form when names can repeat. ` +
          `Full list: https://developers.google.com/adsense/management/reference/rest/v2/Metric and …/v2/Dimension`,
      );
    }),
  );
}
