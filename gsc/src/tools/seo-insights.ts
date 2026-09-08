import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchAnalyticsAll, type AnalyticsRow, type Dimension } from "../client.js";
import { guard, ok } from "../lib/tool.js";
import { pct, pos, shortenUrl, signed, table, truncationNotice } from "../lib/format.js";
import { describeRange, precedingRange, resolveDateRange } from "../lib/dates.js";
import { dateFields, filterGroupsSchema, searchTypeSchema } from "./search-analytics.js";

/**
 * Every tool here pulls the full result set so baselines are computed against
 * the whole property rather than an arbitrary first page. maxRows bounds that.
 */
const maxRowsField = z
  .number()
  .int()
  .min(100)
  .max(100_000)
  .default(25_000)
  .describe(
    "Upper bound on rows pulled from the API before analysis. Raise for large properties, lower to speed up.",
  );

const siteUrlField = z
  .string()
  .describe("Property, exactly as returned by gsc_list_sites.");

const limitField = z
  .number()
  .int()
  .min(1)
  .max(500)
  .default(50)
  .describe("Maximum opportunities to return.");

/**
 * Typical organic CTR by average position. Only used as a fallback when the
 * property has too few rows at a position to derive its own baseline.
 */
const CTR_CURVE: Record<number, number> = {
  1: 0.28, 2: 0.15, 3: 0.11, 4: 0.08, 5: 0.06,
  6: 0.05, 7: 0.04, 8: 0.033, 9: 0.028, 10: 0.025,
};

function fallbackCtr(position: number): number {
  const bucket = Math.max(1, Math.round(position));
  if (bucket <= 10) return CTR_CURVE[bucket]!;
  if (bucket <= 20) return 0.02 - (bucket - 10) * 0.001;
  return 0.005;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

interface FetchArgs {
  siteUrl: string;
  startDate?: string;
  endDate?: string;
  range?: "last_7_days" | "last_28_days" | "last_3_months" | "last_6_months" | "last_12_months" | "last_16_months";
  type?: "WEB" | "IMAGE" | "VIDEO" | "NEWS" | "DISCOVER" | "GOOGLE_NEWS";
  dimensionFilterGroups?: any;
  maxRows: number;
}

async function fetchRows(args: FetchArgs, dimensions: Dimension[]) {
  const range = resolveDateRange(args);
  const rows = await searchAnalyticsAll(
    {
      siteUrl: args.siteUrl,
      startDate: range.startDate,
      endDate: range.endDate,
      dimensions,
      type: args.type,
      dimensionFilterGroups: args.dimensionFilterGroups,
    },
    args.maxRows,
  );
  return { rows, range };
}

// ---------------------------------------------------------------------------

function registerStrikingDistance(server: McpServer): void {
  server.registerTool(
    "gsc_striking_distance",
    {
      title: "Find striking-distance queries",
      description:
        "Queries already ranking just off page 1 (positions ~5-20) with real impression volume — the set where " +
        "small on-page changes move you onto page 1 for the largest traffic gain. Ranked by impressions, since " +
        "impressions at a fixed position are the ceiling on what better ranking can capture. " +
        "For queries you already rank well on but few people click, use gsc_low_ctr_pages instead.",
      inputSchema: {
        siteUrl: siteUrlField,
        ...dateFields,
        type: searchTypeSchema.default("WEB").describe("Search surface to analyze."),
        minPosition: z
          .number()
          .min(1)
          .max(100)
          .default(5)
          .describe("Lowest average position to include. Below ~5 you already rank well."),
        maxPosition: z
          .number()
          .min(1)
          .max(100)
          .default(20)
          .describe("Highest average position to include. Beyond ~20 the gap is usually too large to close cheaply."),
        minImpressions: z
          .number()
          .int()
          .min(1)
          .default(50)
          .describe("Minimum impressions over the window. Filters out noise with no upside."),
        includePages: z
          .boolean()
          .default(true)
          .describe("Also report which page ranks for each query, so you know what to edit."),
        dimensionFilterGroups: filterGroupsSchema.optional(),
        limit: limitField,
        maxRows: maxRowsField,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const dimensions: Dimension[] = args.includePages ? ["QUERY", "PAGE"] : ["QUERY"];
      const { rows, range } = await fetchRows(args, dimensions);

      const matches = rows
        .filter(
          (r) =>
            r.position >= args.minPosition &&
            r.position <= args.maxPosition &&
            r.impressions >= args.minImpressions,
        )
        .sort((a, b) => b.impressions - a.impressions);

      const header =
        `Striking-distance queries — ${args.siteUrl} — ${describeRange(range)}\n` +
        `Positions ${args.minPosition}-${args.maxPosition}, min ${args.minImpressions} impressions ` +
        `(scanned ${rows.length} rows)`;

      if (matches.length === 0) {
        return ok(
          `${header}\n\nNothing matched. Widen maxPosition, lower minImpressions, or extend the date range.`,
        );
      }

      const shown = matches.slice(0, args.limit);
      const headers = args.includePages
        ? ["query", "page", "impressions", "clicks", "ctr", "position"]
        : ["query", "impressions", "clicks", "ctr", "position"];

      const body = shown.map((r) => {
        const [query, page] = r.keys ?? [];
        const base = [query ?? ""];
        if (args.includePages) base.push(shortenUrl(page ?? "", 55));
        return [...base, String(r.impressions), String(r.clicks), pct(r.ctr), pos(r.position)];
      });

      const potential = shown.reduce((sum, r) => sum + r.impressions, 0);

      return ok(
        `${header}\n${matches.length} opportunities, ${potential} impressions across the top ${shown.length}\n\n` +
          table(headers, body) +
          truncationNotice({ shown: shown.length, total: matches.length, hint: "Raise `limit` to see more." }),
      );
    }),
  );
}

// ---------------------------------------------------------------------------

function registerLowCtr(server: McpServer): void {
  server.registerTool(
    "gsc_low_ctr_pages",
    {
      title: "Find low-CTR pages or queries",
      description:
        "Pages (or queries) that rank well but get clicked far less than others at the same position on this " +
        "same property — the title and meta description rewrite list. The baseline is self-calibrating: it " +
        "compares each row against this site's own median CTR at that position, not a generic industry curve, " +
        "so it stays meaningful for any niche. Use gsc_striking_distance for pages that rank too low to be clicked at all.",
      inputSchema: {
        siteUrl: siteUrlField,
        ...dateFields,
        type: searchTypeSchema.default("WEB").describe("Search surface to analyze."),
        dimension: z
          .enum(["PAGE", "QUERY"])
          .default("PAGE")
          .describe("Analyze per page (rewrite candidates) or per query (intent mismatch)."),
        minImpressions: z
          .number()
          .int()
          .min(1)
          .default(100)
          .describe("Minimum impressions. CTR is unreliable below ~100 impressions."),
        maxPosition: z
          .number()
          .min(1)
          .max(100)
          .default(20)
          .describe("Ignore rows ranking worse than this — low CTR there is expected, not a defect."),
        ratioThreshold: z
          .number()
          .min(0.1)
          .max(1)
          .default(0.5)
          .describe("Flag rows whose CTR is below this fraction of the position baseline. 0.5 = less than half."),
        dimensionFilterGroups: filterGroupsSchema.optional(),
        limit: limitField,
        maxRows: maxRowsField,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const { rows, range } = await fetchRows(args, [args.dimension as Dimension]);
      const eligible = rows.filter((r) => r.position <= args.maxPosition && r.impressions > 0);

      // Site-relative baseline: median CTR among this property's own rows at
      // each whole-number position.
      const buckets = new Map<number, number[]>();
      for (const r of eligible) {
        const bucket = Math.max(1, Math.round(r.position));
        const samples = buckets.get(bucket);
        if (samples) samples.push(r.ctr);
        else buckets.set(bucket, [r.ctr]);
      }

      const baselineFor = (position: number): { value: number; source: "site" | "curve" } => {
        const bucket = Math.max(1, Math.round(position));
        const samples = buckets.get(bucket);
        return samples && samples.length >= 5
          ? { value: median(samples), source: "site" }
          : { value: fallbackCtr(position), source: "curve" };
      };

      const flagged = eligible
        .filter((r) => r.impressions >= args.minImpressions)
        .map((r) => {
          const baseline = baselineFor(r.position);
          return {
            row: r,
            baseline: baseline.value,
            source: baseline.source,
            lostClicks: Math.round(r.impressions * Math.max(0, baseline.value - r.ctr)),
          };
        })
        .filter((f) => f.baseline > 0 && f.row.ctr < f.baseline * args.ratioThreshold)
        .sort((a, b) => b.lostClicks - a.lostClicks);

      const header =
        `Low-CTR ${args.dimension === "PAGE" ? "pages" : "queries"} — ${args.siteUrl} — ${describeRange(range)}\n` +
        `CTR below ${args.ratioThreshold}x the position baseline, min ${args.minImpressions} impressions, ` +
        `position <= ${args.maxPosition} (scanned ${rows.length} rows)`;

      if (flagged.length === 0) {
        return ok(
          `${header}\n\nNothing flagged — CTR is in line with this site's norm at every position. ` +
            `Raise ratioThreshold or lower minImpressions to loosen the filter.`,
        );
      }

      const shown = flagged.slice(0, args.limit);
      const totalLost = flagged.reduce((sum, f) => sum + f.lostClicks, 0);

      const body = shown.map((f) => [
        shortenUrl(f.row.keys?.[0] ?? "", args.dimension === "PAGE" ? 55 : 45),
        String(f.row.impressions),
        String(f.row.clicks),
        pct(f.row.ctr),
        `${pct(f.baseline)}${f.source === "curve" ? "*" : ""}`,
        String(f.lostClicks),
        pos(f.row.position),
      ]);

      // Only explain the asterisk when a rendered row actually carries one.
      const footnote = shown.some((f) => f.source === "curve")
        ? `\n\n* baseline from the generic CTR curve (too few site rows at that position).`
        : "";

      return ok(
        `${header}\n${flagged.length} flagged, ~${totalLost} clicks/period left on the table\n\n` +
          table(
            [args.dimension.toLowerCase(), "impressions", "clicks", "ctr", "baseline", "lost clicks", "position"],
            body,
          ) +
          footnote +
          truncationNotice({ shown: shown.length, total: flagged.length, hint: "Raise `limit` to see more." }),
      );
    }),
  );
}

// ---------------------------------------------------------------------------

function registerComparePeriods(server: McpServer): void {
  server.registerTool(
    "gsc_compare_periods",
    {
      title: "Compare two time periods",
      description:
        "Period-over-period change in clicks, impressions, and position, broken down by query or page. " +
        "Returns the biggest gainers and the biggest losers separately, plus site totals. This is the tool for " +
        "'why did my traffic drop' — it isolates which specific pages or queries moved, rather than showing an " +
        "aggregate trend line. By default the comparison period is the window immediately before the primary one.",
      inputSchema: {
        siteUrl: siteUrlField,
        ...dateFields,
        compareStartDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Start of the baseline period. Defaults to the equal-length window immediately before the primary period."),
        compareEndDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("End of the baseline period. Defaults to the day before the primary period starts."),
        type: searchTypeSchema.default("WEB").describe("Search surface to analyze."),
        dimension: z
          .enum(["QUERY", "PAGE"])
          .default("PAGE")
          .describe("Compare per page or per query."),
        minImpressions: z
          .number()
          .int()
          .min(1)
          .default(20)
          .describe("Ignore rows below this impression count in both periods — cuts long-tail noise."),
        dimensionFilterGroups: filterGroupsSchema.optional(),
        limit: limitField,
        maxRows: maxRowsField,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const current = resolveDateRange(args);
      const baseline =
        args.compareStartDate && args.compareEndDate
          ? { startDate: args.compareStartDate, endDate: args.compareEndDate }
          : precedingRange(current);

      const dimensions = [args.dimension as Dimension];
      const shared = {
        siteUrl: args.siteUrl,
        dimensions,
        type: args.type,
        dimensionFilterGroups: args.dimensionFilterGroups,
      };

      const [currentRows, baselineRows] = await Promise.all([
        searchAnalyticsAll({ ...shared, ...current }, args.maxRows),
        searchAnalyticsAll({ ...shared, ...baseline }, args.maxRows),
      ]);

      const index = (rows: AnalyticsRow[]) =>
        new Map(rows.map((r) => [r.keys?.[0] ?? "", r]));
      const currentIndex = index(currentRows);
      const baselineIndex = index(baselineRows);

      const zero: AnalyticsRow = { clicks: 0, impressions: 0, ctr: 0, position: 0 };
      const keys = new Set([...currentIndex.keys(), ...baselineIndex.keys()]);

      const deltas = [...keys]
        .map((key) => {
          const now = currentIndex.get(key) ?? zero;
          const before = baselineIndex.get(key) ?? zero;
          return {
            key,
            now,
            before,
            clickDelta: now.clicks - before.clicks,
            impressionDelta: now.impressions - before.impressions,
            // Position is "lower is better", so negate to make positive mean improved.
            positionDelta:
              now.position && before.position ? before.position - now.position : 0,
            isNew: !baselineIndex.has(key),
            isGone: !currentIndex.has(key),
          };
        })
        .filter(
          (d) =>
            d.now.impressions >= args.minImpressions ||
            d.before.impressions >= args.minImpressions,
        );

      const sum = (rows: AnalyticsRow[], field: "clicks" | "impressions") =>
        rows.reduce((acc, r) => acc + r[field], 0);

      const totals = {
        clicksNow: sum(currentRows, "clicks"),
        clicksBefore: sum(baselineRows, "clicks"),
        impressionsNow: sum(currentRows, "impressions"),
        impressionsBefore: sum(baselineRows, "impressions"),
      };

      const changePct = (now: number, before: number) =>
        before === 0 ? (now === 0 ? "0%" : "new") : `${(((now - before) / before) * 100).toFixed(1)}%`;

      const header =
        `Period comparison — ${args.siteUrl} — by ${args.dimension}\n` +
        `  current:  ${describeRange(current)}\n` +
        `  baseline: ${describeRange(baseline)}\n\n` +
        `Site totals:\n` +
        `  clicks:      ${totals.clicksBefore} -> ${totals.clicksNow}  (${signed(totals.clicksNow - totals.clicksBefore)}, ${changePct(totals.clicksNow, totals.clicksBefore)})\n` +
        `  impressions: ${totals.impressionsBefore} -> ${totals.impressionsNow}  (${signed(totals.impressionsNow - totals.impressionsBefore)}, ${changePct(totals.impressionsNow, totals.impressionsBefore)})`;

      if (deltas.length === 0) {
        return ok(`${header}\n\nNo rows cleared minImpressions in either period.`);
      }

      const headers = [args.dimension.toLowerCase(), "clicks", "impr", "position", "status"];
      const render = (d: (typeof deltas)[number]) => [
        shortenUrl(d.key, args.dimension === "PAGE" ? 55 : 45),
        `${d.before.clicks} -> ${d.now.clicks} (${signed(d.clickDelta)})`,
        `${d.before.impressions} -> ${d.now.impressions} (${signed(d.impressionDelta)})`,
        d.now.position && d.before.position
          ? `${pos(d.before.position)} -> ${pos(d.now.position)} (${d.positionDelta > 0 ? "+" : ""}${d.positionDelta.toFixed(1)})`
          : "-",
        d.isNew ? "new" : d.isGone ? "dropped out" : "",
      ];

      const half = Math.max(1, Math.floor(args.limit / 2));
      const losers = deltas.filter((d) => d.clickDelta < 0).sort((a, b) => a.clickDelta - b.clickDelta).slice(0, half);
      const gainers = deltas.filter((d) => d.clickDelta > 0).sort((a, b) => b.clickDelta - a.clickDelta).slice(0, half);

      const sections = [header];
      if (losers.length) {
        sections.push(`\nTOP LOSSES (${losers.length} of ${deltas.filter((d) => d.clickDelta < 0).length} declining)\n` + table(headers, losers.map(render)));
      }
      if (gainers.length) {
        sections.push(`\nTOP GAINS (${gainers.length} of ${deltas.filter((d) => d.clickDelta > 0).length} improving)\n` + table(headers, gainers.map(render)));
      }
      if (!losers.length && !gainers.length) {
        sections.push("\nNo click changes between the two periods.");
      }

      return ok(sections.join("\n"));
    }),
  );
}

// ---------------------------------------------------------------------------

function registerCannibalization(server: McpServer): void {
  server.registerTool(
    "gsc_find_cannibalization",
    {
      title: "Find keyword cannibalization",
      description:
        "Queries where several of your own pages compete for the same term, splitting clicks and link equity so " +
        "no single page ranks as well as one consolidated page would. Reports each competing page with its own " +
        "impressions, clicks, and position, so you can decide what to merge, redirect, or de-optimize. " +
        "Ranked by total impressions at stake.",
      inputSchema: {
        siteUrl: siteUrlField,
        ...dateFields,
        type: searchTypeSchema.default("WEB").describe("Search surface to analyze."),
        minImpressions: z
          .number()
          .int()
          .min(1)
          .default(20)
          .describe("Minimum impressions for a page to count as a real competitor on a query."),
        minQueryImpressions: z
          .number()
          .int()
          .min(1)
          .default(100)
          .describe("Ignore queries below this total impression count — cannibalizing a term nobody searches is not worth fixing."),
        dominanceThreshold: z
          .number()
          .min(0.5)
          .max(1)
          .default(0.8)
          .describe("If one page already takes more than this share of the query's clicks, Google has effectively picked a winner and it is not treated as cannibalization."),
        maxPosition: z
          .number()
          .min(1)
          .max(100)
          .default(30)
          .describe("Ignore competing pages ranking worse than this."),
        dimensionFilterGroups: filterGroupsSchema.optional(),
        limit: limitField,
        maxRows: maxRowsField,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const { rows, range } = await fetchRows(args, ["QUERY", "PAGE"]);

      const byQuery = new Map<string, AnalyticsRow[]>();
      for (const r of rows) {
        const [query] = r.keys ?? [];
        if (!query) continue;
        if (r.impressions < args.minImpressions || r.position > args.maxPosition) continue;
        const bucket = byQuery.get(query);
        if (bucket) bucket.push(r);
        else byQuery.set(query, [r]);
      }

      const conflicts = [...byQuery.entries()]
        .filter(([, pages]) => pages.length >= 2)
        .map(([query, pages]) => {
          const totalImpressions = pages.reduce((s, p) => s + p.impressions, 0);
          const totalClicks = pages.reduce((s, p) => s + p.clicks, 0);
          // With no clicks anywhere, impression share is the only signal of
          // whether Google has settled on one page.
          const shares = pages.map((p) =>
            totalClicks > 0 ? p.clicks / totalClicks : p.impressions / totalImpressions,
          );
          return {
            query,
            pages: [...pages].sort((a, b) => a.position - b.position),
            totalImpressions,
            totalClicks,
            dominance: Math.max(...shares),
          };
        })
        .filter(
          (c) =>
            c.totalImpressions >= args.minQueryImpressions &&
            c.dominance <= args.dominanceThreshold,
        )
        .sort((a, b) => b.totalImpressions - a.totalImpressions);

      const header =
        `Keyword cannibalization — ${args.siteUrl} — ${describeRange(range)}\n` +
        `Queries with 2+ pages above ${args.minImpressions} impressions and no page holding >${(args.dominanceThreshold * 100).toFixed(0)}% of clicks ` +
        `(scanned ${rows.length} query/page rows)`;

      if (conflicts.length === 0) {
        return ok(
          `${header}\n\nNo cannibalization found. Either each query has a clear winning page, or thresholds are too strict — ` +
            `try lowering minQueryImpressions or raising dominanceThreshold.`,
        );
      }

      const shown = conflicts.slice(0, args.limit);
      const sections = shown.map((c) => {
        const body = c.pages.map((p) => [
          shortenUrl(p.keys?.[1] ?? "", 60),
          String(p.impressions),
          String(p.clicks),
          pct(p.ctr),
          pos(p.position),
        ]);
        return (
          `"${c.query}" — ${c.totalImpressions} impressions, ${c.totalClicks} clicks across ${c.pages.length} pages ` +
          `(top page holds ${(c.dominance * 100).toFixed(0)}%)\n` +
          table(["page", "impressions", "clicks", "ctr", "position"], body)
        );
      });

      return ok(
        `${header}\n${conflicts.length} conflicted queries\n\n` +
          sections.join("\n\n") +
          truncationNotice({ shown: shown.length, total: conflicts.length, hint: "Raise `limit` to see more." }),
      );
    }),
  );
}

export function registerSeoInsightTools(server: McpServer): void {
  registerStrikingDistance(server);
  registerLowCtr(server);
  registerComparePeriods(server);
  registerCannibalization(server);
}
