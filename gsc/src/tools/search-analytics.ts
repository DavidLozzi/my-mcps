import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchAnalytics, type Dimension } from "../client.js";
import { guard, ok } from "../lib/tool.js";
import { pct, pos, shortenUrl, table, truncationNotice } from "../lib/format.js";
import { RANGE_PRESETS, describeRange, resolveDateRange } from "../lib/dates.js";

/** Rows rendered by default; the API itself can return up to 25,000. */
const RENDER_CAP = 200;

export const dimensionSchema = z.enum([
  "DATE",
  "QUERY",
  "PAGE",
  "COUNTRY",
  "DEVICE",
  "SEARCH_APPEARANCE",
  "HOUR",
]);

export const searchTypeSchema = z.enum([
  "WEB",
  "IMAGE",
  "VIDEO",
  "NEWS",
  "DISCOVER",
  "GOOGLE_NEWS",
]);

export const rangeSchema = z.enum(RANGE_PRESETS);

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD");

export const filterGroupsSchema = z
  .array(
    z.object({
      groupType: z.literal("AND").default("AND"),
      filters: z.array(
        z.object({
          dimension: z.enum(["QUERY", "PAGE", "COUNTRY", "DEVICE", "SEARCH_APPEARANCE"]),
          operator: z.enum([
            "EQUALS",
            "NOT_EQUALS",
            "CONTAINS",
            "NOT_CONTAINS",
            "INCLUDING_REGEX",
            "EXCLUDING_REGEX",
          ]),
          expression: z
            .string()
            .describe(
              "Value to match. COUNTRY uses 3-letter ISO codes (usa, gbr); DEVICE uses DESKTOP/MOBILE/TABLET; regex operators use RE2 syntax.",
            ),
        }),
      ),
    }),
  )
  .describe(
    "Filters applied to dimension values, e.g. only queries containing 'pricing'. Filters within a group are ANDed; separate groups are ORed.",
  );

/** Shared date/range fields reused by the derived SEO tools. */
export const dateFields = {
  startDate: dateSchema
    .optional()
    .describe("Start of the window, YYYY-MM-DD. Overrides `range` when set."),
  endDate: dateSchema
    .optional()
    .describe(
      "End of the window, YYYY-MM-DD. Defaults to 3 days ago because Search Console data lags 2-3 days.",
    ),
  range: rangeSchema
    .optional()
    .describe(
      "Relative window used when startDate is omitted. Defaults to last_28_days. Search Console retains 16 months.",
    ),
};

export function registerSearchAnalyticsTool(server: McpServer): void {
  server.registerTool(
    "gsc_search_analytics",
    {
      title: "Query Search Analytics",
      description:
        "Raw Search Analytics query: clicks, impressions, CTR, and average position grouped by any combination " +
        "of dimensions. This is the general-purpose tool — use it for arbitrary breakdowns, trends over DATE, " +
        "country/device splits, or filtered slices. For ready-made SEO analysis prefer the purpose-built tools: " +
        "gsc_striking_distance (near-page-1 wins), gsc_low_ctr_pages (title rewrites), gsc_compare_periods " +
        "(traffic changes), gsc_find_cannibalization (pages competing with each other).",
      inputSchema: {
        siteUrl: z
          .string()
          .describe(
            "Property to query, exactly as returned by gsc_list_sites. URL-prefix form needs a trailing slash (https://example.com/); domain form is sc-domain:example.com.",
          ),
        ...dateFields,
        dimensions: z
          .array(dimensionSchema)
          .max(4)
          .optional()
          .describe(
            "Group results by these dimensions, in order. Omit for site-wide totals. HOUR requires dataState HOURLY_ALL and only covers the last ~10 days.",
          ),
        type: searchTypeSchema
          .default("WEB")
          .describe("Search surface to report on. DISCOVER and GOOGLE_NEWS support fewer dimensions."),
        dimensionFilterGroups: filterGroupsSchema.optional(),
        aggregationType: z
          .enum(["AUTO", "BY_PROPERTY", "BY_PAGE", "BY_NEWS_SHOWCASE_PANEL"])
          .optional()
          .describe("How rows are aggregated. Leave unset unless you specifically need BY_PAGE or BY_PROPERTY."),
        dataState: z
          .enum(["FINAL", "ALL", "HOURLY_ALL"])
          .optional()
          .describe(
            "FINAL (default) excludes incomplete recent days. ALL includes fresh partial data. HOURLY_ALL is required for the HOUR dimension.",
          ),
        rowLimit: z
          .number()
          .int()
          .min(1)
          .max(25_000)
          .default(1000)
          .describe("Rows to fetch from the API. Max 25000."),
        startRow: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Zero-based offset for paging through results."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const range = resolveDateRange(args);

      const rows = await searchAnalytics({
        siteUrl: args.siteUrl,
        startDate: range.startDate,
        endDate: range.endDate,
        dimensions: args.dimensions as Dimension[] | undefined,
        type: args.type,
        dimensionFilterGroups: args.dimensionFilterGroups,
        aggregationType: args.aggregationType,
        dataState: args.dataState,
        rowLimit: args.rowLimit,
        startRow: args.startRow,
      });

      const header = `${args.siteUrl} — ${describeRange(range)} — ${args.type}`;

      if (rows.length === 0) {
        return ok(
          `${header}\n\nNo rows. Either the property had no traffic in this window, the filters excluded ` +
            `everything, or the range is too recent (Search Console data lags 2-3 days).`,
        );
      }

      const dimensions = args.dimensions ?? [];
      const shown = rows.slice(0, RENDER_CAP);

      const headers = [...dimensions, "clicks", "impressions", "ctr", "position"];
      const body = shown.map((r) => [
        ...(r.keys ?? []).map((k, i) => (dimensions[i] === "PAGE" ? shortenUrl(k) : k)),
        String(r.clicks),
        String(r.impressions),
        pct(r.ctr),
        pos(r.position),
      ]);

      const totals = rows.reduce(
        (acc, r) => ({ clicks: acc.clicks + r.clicks, impressions: acc.impressions + r.impressions }),
        { clicks: 0, impressions: 0 },
      );

      return ok(
        `${header}\nTotals across ${rows.length} rows: ${totals.clicks} clicks, ${totals.impressions} impressions\n\n` +
          table(headers, body) +
          truncationNotice({
            shown: shown.length,
            total: rows.length,
            hint: "Use startRow to page, or add dimensionFilterGroups to narrow.",
          }),
      );
    }),
  );
}
