import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ReportResponse, ReportRow } from "../client.js";
import { guard, ok } from "../lib/tool.js";
import { changePct, num, pct, dur, shortenUrl, signed, table, truncationNotice } from "../lib/format.js";
import { describeRange, precedingRange, resolveDateRange, EMPTY_HINT } from "../lib/dates.js";
import {
  dimValue,
  median,
  metricIndex,
  metricValue,
  renderReportTable,
  reportWarnings,
} from "../lib/report.js";
import {
  buildFilterExpression,
  dateFields,
  droppedNotice,
  filtersCombineField,
  filtersField,
  limitField,
  maxRowsField,
  propertyIdField,
  runReportAllTolerant,
  runReportTolerant,
} from "./shared.js";

/** Reading a single metric out of a totals-style single-row report. */
function readMetric(res: ReportResponse, name: string, row?: ReportRow): number {
  const index = metricIndex(res).get(name);
  if (index === undefined) return 0;
  const target = row ?? res.rows?.[0];
  return target ? metricValue(target, index) : 0;
}

// ---------------------------------------------------------------------------

function registerTrafficOverview(server: McpServer): void {
  server.registerTool(
    "ga4_traffic_overview",
    {
      title: "Traffic overview with trend",
      description:
        "The single call that answers 'how is the site doing': users, sessions, views, engagement, and key events " +
        "for the period, each with its change against the preceding period, plus a trend series and a breakdown " +
        "by acquisition channel. Start here for any open-ended question about performance, then drill in with " +
        "ga4_compare_periods (what specifically changed), ga4_top_pages, or ga4_acquisition.",
      inputSchema: {
        propertyId: propertyIdField,
        ...dateFields,
        compareStartDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Start of the baseline period. Defaults to the equal-length window immediately before."),
        compareEndDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("End of the baseline period. Defaults to the day before the primary period starts."),
        granularity: z
          .enum(["auto", "date", "yearWeek", "yearMonth"])
          .default("auto")
          .describe("Trend bucket size. 'auto' picks daily for short ranges, weekly or monthly for long ones."),
        dimensionFilters: filtersField,
        dimensionFiltersCombine: filtersCombineField,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const current = resolveDateRange(args);
      const baseline =
        args.compareStartDate && args.compareEndDate
          ? { startDate: args.compareStartDate, endDate: args.compareEndDate }
          : precedingRange(current);

      const dimensionFilter = buildFilterExpression(args.dimensionFilters, args.dimensionFiltersCombine);
      const required = ["activeUsers", "newUsers", "sessions", "screenPageViews", "engagementRate", "averageSessionDuration"];
      const optional = ["keyEvents"];

      const days =
        Math.round(
          (new Date(`${current.endDate}T00:00:00Z`).getTime() -
            new Date(`${current.startDate}T00:00:00Z`).getTime()) /
            86_400_000,
        ) + 1;
      const granularity =
        args.granularity !== "auto"
          ? args.granularity
          : days <= 45
            ? "date"
            : days <= 210
              ? "yearWeek"
              : "yearMonth";

      const [now, before, trend, channels] = await Promise.all([
        runReportTolerant(
          { propertyId: args.propertyId, ...current, dimensionFilter },
          required,
          optional,
        ),
        runReportTolerant(
          { propertyId: args.propertyId, ...baseline, dimensionFilter },
          required,
          optional,
        ),
        runReportTolerant(
          {
            propertyId: args.propertyId,
            ...current,
            dimensions: [granularity],
            dimensionFilter,
            orderBys: [{ dimension: { dimensionName: granularity }, desc: false }],
            limit: 400,
          },
          ["sessions", "activeUsers"],
          optional,
        ),
        runReportTolerant(
          {
            propertyId: args.propertyId,
            ...current,
            dimensions: ["sessionDefaultChannelGroup"],
            dimensionFilter,
            orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
            limit: 15,
          },
          ["sessions", "activeUsers", "engagementRate"],
          optional,
        ),
      ]);

      if ((now.res.rows ?? []).length === 0 && (trend.res.rows ?? []).length === 0) {
        return ok(`${args.propertyId} — ${describeRange(current)}\n\n${EMPTY_HINT}${reportWarnings(now.res)}`);
      }

      const summaryRows = now.metrics.map((metric) => {
        const nowValue = readMetric(now.res, metric);
        const beforeValue = readMetric(before.res, metric);
        const isRate = /Rate$/.test(metric);
        const isDuration = metric === "averageSessionDuration";
        const render = (v: number) => (isRate ? pct(v) : isDuration ? dur(v) : num(v));
        const delta = isRate
          ? `${signed(Number(((nowValue - beforeValue) * 100).toFixed(2)))} pts`
          : isDuration
            ? `${nowValue >= beforeValue ? "+" : ""}${dur(Math.abs(nowValue - beforeValue))}`
            : signed(Math.round(nowValue - beforeValue));
        return [metric, render(nowValue), render(beforeValue), delta, changePct(nowValue, beforeValue)];
      });

      const sections = [
        `${args.propertyId} — ${describeRange(current)}\n` +
          `  vs baseline: ${describeRange(baseline)}`,
        `HEADLINE\n${table(["metric", "current", "baseline", "change", "%"], summaryRows)}`,
        `TREND by ${granularity}\n${renderReportTable(trend.res, { cap: 400 })}`,
        `CHANNELS\n${renderReportTable(channels.res, { cap: 15 })}`,
      ];

      return ok(
        sections.join("\n\n") +
          droppedNotice(now.dropped) +
          reportWarnings(now.res) +
          reportWarnings(channels.res),
      );
    }),
  );
}

// ---------------------------------------------------------------------------

const comparisonDimensionSchema = z.enum([
  "pagePath",
  "landingPage",
  "sessionDefaultChannelGroup",
  "sessionSourceMedium",
  "sessionCampaignName",
  "country",
  "deviceCategory",
  "eventName",
]);

function registerComparePeriods(server: McpServer): void {
  server.registerTool(
    "ga4_compare_periods",
    {
      title: "Compare two periods and find what moved",
      description:
        "Period-over-period change broken down by page, landing page, channel, source, country, device, or event, " +
        "reporting the biggest losses and the biggest gains separately with items that appeared or vanished " +
        "flagged. This is the tool for 'why did traffic drop' or 'what drove the spike' — it isolates which " +
        "specific rows moved instead of showing an aggregate line. By default the baseline is the equal-length " +
        "window immediately before the primary period.",
      inputSchema: {
        propertyId: propertyIdField,
        ...dateFields,
        compareStartDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Start of the baseline period. Defaults to the equal-length window immediately before."),
        compareEndDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("End of the baseline period. Defaults to the day before the primary period starts."),
        dimension: comparisonDimensionSchema
          .default("pagePath")
          .describe("What to break the change down by."),
        metric: z
          .enum(["sessions", "activeUsers", "screenPageViews", "keyEvents", "totalRevenue", "eventCount"])
          .default("sessions")
          .describe("Metric whose change ranks the rows."),
        minValue: z
          .number()
          .int()
          .min(0)
          .default(10)
          .describe("Ignore rows below this metric value in both periods — cuts long-tail noise."),
        dimensionFilters: filtersField,
        dimensionFiltersCombine: filtersCombineField,
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

      const shared = {
        propertyId: args.propertyId,
        dimensions: [args.dimension],
        dimensionFilter: buildFilterExpression(args.dimensionFilters, args.dimensionFiltersCombine),
        orderBys: [{ metric: { metricName: args.metric } , desc: true }],
      };

      const [nowReport, beforeReport] = await Promise.all([
        runReportAllTolerant({ ...shared, ...current }, [args.metric], [], args.maxRows),
        runReportAllTolerant({ ...shared, ...baseline }, [args.metric], [], args.maxRows),
      ]);

      const index = (res: ReportResponse) => {
        const map = new Map<string, number>();
        for (const row of res.rows ?? []) {
          map.set(dimValue(row, 0), metricValue(row, 0));
        }
        return map;
      };
      const nowIndex = index(nowReport.res);
      const beforeIndex = index(beforeReport.res);

      const keys = new Set([...nowIndex.keys(), ...beforeIndex.keys()]);
      const deltas = [...keys]
        .map((key) => {
          const nowValue = nowIndex.get(key) ?? 0;
          const beforeValue = beforeIndex.get(key) ?? 0;
          return {
            key,
            nowValue,
            beforeValue,
            delta: nowValue - beforeValue,
            isNew: !beforeIndex.has(key),
            isGone: !nowIndex.has(key),
          };
        })
        .filter((d) => d.nowValue >= args.minValue || d.beforeValue >= args.minValue);

      const sum = (map: Map<string, number>) => [...map.values()].reduce((a, b) => a + b, 0);
      const totalNow = sum(nowIndex);
      const totalBefore = sum(beforeIndex);

      const header =
        `Period comparison — ${args.propertyId} — by ${args.dimension}, ranked on ${args.metric}\n` +
        `  current:  ${describeRange(current)}\n` +
        `  baseline: ${describeRange(baseline)}\n\n` +
        `Property totals for ${args.metric}: ${num(totalBefore)} -> ${num(totalNow)} ` +
        `(${signed(Math.round(totalNow - totalBefore))}, ${changePct(totalNow, totalBefore)})`;

      if (deltas.length === 0) {
        return ok(
          `${header}\n\nNo rows cleared minValue in either period. Lower minValue, widen the range, or check ` +
            `that this dimension is populated on the property.`,
        );
      }

      const headers = [args.dimension, args.metric, "change", "%", "status"];
      const render = (d: (typeof deltas)[number]) => [
        shortenUrl(d.key, /page/i.test(args.dimension) ? 55 : 40),
        `${num(d.beforeValue)} -> ${num(d.nowValue)}`,
        signed(Math.round(d.delta)),
        changePct(d.nowValue, d.beforeValue),
        d.isNew ? "new" : d.isGone ? "dropped out" : "",
      ];

      const half = Math.max(1, Math.floor(args.limit / 2));
      const declining = deltas.filter((d) => d.delta < 0);
      const improving = deltas.filter((d) => d.delta > 0);
      const losers = [...declining].sort((a, b) => a.delta - b.delta).slice(0, half);
      const gainers = [...improving].sort((a, b) => b.delta - a.delta).slice(0, half);

      const sections = [header];
      if (losers.length) {
        sections.push(
          `\nTOP LOSSES (${losers.length} of ${declining.length} declining)\n` + table(headers, losers.map(render)),
        );
      }
      if (gainers.length) {
        sections.push(
          `\nTOP GAINS (${gainers.length} of ${improving.length} improving)\n` + table(headers, gainers.map(render)),
        );
      }
      if (!losers.length && !gainers.length) {
        sections.push("\nNo change in this metric between the two periods.");
      }

      return ok(sections.join("\n") + reportWarnings(nowReport.res));
    }),
  );
}

// ---------------------------------------------------------------------------

function registerTopPages(server: McpServer): void {
  server.registerTool(
    "ga4_top_pages",
    {
      title: "Top pages by traffic and engagement",
      description:
        "The most-viewed pages with views, users, average engagement time, and key events side by side, so a page " +
        "with high traffic but poor engagement is visible in the same table rather than needing a second query. " +
        "Use ga4_landing_page_opportunities when the question is what to fix rather than what is popular, and " +
        "ga4_compare_periods when it is what changed.",
      inputSchema: {
        propertyId: propertyIdField,
        ...dateFields,
        dimension: z
          .enum(["pagePath", "pagePathPlusQueryString", "pageTitle", "landingPage", "fullPageUrl"])
          .default("pagePath")
          .describe("How to identify a page. pagePath ignores query strings; landingPage counts session entries only."),
        orderBy: z
          .enum(["screenPageViews", "activeUsers", "userEngagementDuration", "keyEvents"])
          .default("screenPageViews")
          .describe("Ranking metric."),
        dimensionFilters: filtersField,
        dimensionFiltersCombine: filtersCombineField,
        limit: limitField,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const range = resolveDateRange(args);

      const { res, dropped } = await runReportTolerant(
        {
          propertyId: args.propertyId,
          ...range,
          dimensions: [args.dimension],
          dimensionFilter: buildFilterExpression(args.dimensionFilters, args.dimensionFiltersCombine),
          orderBys: [{ metric: { metricName: args.orderBy }, desc: true }],
          limit: args.limit,
          metricAggregations: ["TOTAL"],
        },
        ["screenPageViews", "activeUsers", "userEngagementDuration"],
        ["keyEvents"],
      );

      const rows = res.rows ?? [];
      if (rows.length === 0) {
        return ok(`${args.propertyId} — ${describeRange(range)}\n\n${EMPTY_HINT}${reportWarnings(res)}`);
      }

      const idx = metricIndex(res);
      const views = idx.get("screenPageViews") ?? 0;
      const users = idx.get("activeUsers") ?? 1;
      const engagement = idx.get("userEngagementDuration") ?? 2;
      const keyEvents = idx.get("keyEvents");

      // Engagement time is only meaningful per user; the raw total scales with
      // traffic and would just re-rank the views column.
      const body = rows.map((row) => {
        const userCount = metricValue(row, users);
        const cells = [
          shortenUrl(dimValue(row, 0), 60),
          num(metricValue(row, views)),
          num(userCount),
          dur(userCount > 0 ? metricValue(row, engagement) / userCount : 0),
        ];
        if (keyEvents !== undefined) cells.push(num(metricValue(row, keyEvents)));
        return cells;
      });

      const headers = [args.dimension, "views", "users", "avg engagement/user"];
      if (keyEvents !== undefined) headers.push("keyEvents");

      const totalViews = rows.reduce((sum, row) => sum + metricValue(row, views), 0);

      return ok(
        `Top pages — ${args.propertyId} — ${describeRange(range)}\n` +
          `${rows.length} pages shown, ${num(totalViews)} views among them\n\n` +
          table(headers, body) +
          truncationNotice({ shown: rows.length, total: res.rowCount ?? rows.length, hint: "Raise `limit` to see more." }) +
          droppedNotice(dropped) +
          reportWarnings(res),
      );
    }),
  );
}

// ---------------------------------------------------------------------------

function registerAcquisition(server: McpServer): void {
  server.registerTool(
    "ga4_acquisition",
    {
      title: "Acquisition performance by channel or source",
      description:
        "How each traffic source performs, not just how much it sends: sessions, engagement, key events, revenue, " +
        "and key events per session per channel, source/medium, or campaign. Ranked by conversion efficiency by " +
        "default, so a small channel that converts well is not buried under a large one that does not. Pair with " +
        "ga4_compare_periods on the same dimension to see which channel moved.",
      inputSchema: {
        propertyId: propertyIdField,
        ...dateFields,
        dimension: z
          .enum([
            "sessionDefaultChannelGroup",
            "sessionSourceMedium",
            "sessionSource",
            "sessionMedium",
            "sessionCampaignName",
            "firstUserDefaultChannelGroup",
            "firstUserSourceMedium",
          ])
          .default("sessionDefaultChannelGroup")
          .describe(
            "Attribution breakdown. session* reflects the visit's own source; firstUser* reflects how that user was originally acquired.",
          ),
        orderBy: z
          .enum(["efficiency", "sessions", "keyEvents", "totalRevenue", "engagedSessions"])
          .default("efficiency")
          .describe("'efficiency' ranks by key events per session; the rest rank by raw volume."),
        minSessions: z
          .number()
          .int()
          .min(1)
          .default(10)
          .describe("Ignore sources below this many sessions — rates are meaningless on tiny samples."),
        dimensionFilters: filtersField,
        dimensionFiltersCombine: filtersCombineField,
        limit: limitField,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const range = resolveDateRange(args);

      const { res, dropped } = await runReportTolerant(
        {
          propertyId: args.propertyId,
          ...range,
          dimensions: [args.dimension],
          dimensionFilter: buildFilterExpression(args.dimensionFilters, args.dimensionFiltersCombine),
          orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
          limit: 500,
        },
        ["sessions", "engagedSessions", "activeUsers"],
        ["keyEvents", "totalRevenue"],
      );

      const rows = res.rows ?? [];
      if (rows.length === 0) {
        return ok(`${args.propertyId} — ${describeRange(range)}\n\n${EMPTY_HINT}${reportWarnings(res)}`);
      }

      const idx = metricIndex(res);
      const sessionsAt = idx.get("sessions") ?? 0;
      const engagedAt = idx.get("engagedSessions") ?? 1;
      const usersAt = idx.get("activeUsers") ?? 2;
      const keyEventsAt = idx.get("keyEvents");
      const revenueAt = idx.get("totalRevenue");

      const analyzed = rows
        .map((row) => {
          const sessions = metricValue(row, sessionsAt);
          const engaged = metricValue(row, engagedAt);
          const keyEvents = keyEventsAt === undefined ? 0 : metricValue(row, keyEventsAt);
          const revenue = revenueAt === undefined ? 0 : metricValue(row, revenueAt);
          return {
            key: dimValue(row, 0) || "(not set)",
            sessions,
            engaged,
            users: metricValue(row, usersAt),
            keyEvents,
            revenue,
            engagementRate: sessions > 0 ? engaged / sessions : 0,
            efficiency: sessions > 0 ? keyEvents / sessions : 0,
          };
        })
        .filter((r) => r.sessions >= args.minSessions);

      if (analyzed.length === 0) {
        return ok(
          `Acquisition — ${args.propertyId} — ${describeRange(range)}\n\n` +
            `No source cleared minSessions (${args.minSessions}). Lower it or widen the date range.`,
        );
      }

      const sortKey = {
        efficiency: (r: (typeof analyzed)[number]) => r.efficiency,
        sessions: (r: (typeof analyzed)[number]) => r.sessions,
        keyEvents: (r: (typeof analyzed)[number]) => r.keyEvents,
        totalRevenue: (r: (typeof analyzed)[number]) => r.revenue,
        engagedSessions: (r: (typeof analyzed)[number]) => r.engaged,
      }[args.orderBy];

      const sorted = [...analyzed].sort((a, b) => sortKey(b) - sortKey(a));
      const shown = sorted.slice(0, args.limit);

      const headers = [args.dimension, "sessions", "users", "engagement", "keyEvents", "per session"];
      if (revenueAt !== undefined) headers.push("revenue");

      const body = shown.map((r) => {
        const cells = [
          shortenUrl(r.key, 40),
          num(r.sessions),
          num(r.users),
          pct(r.engagementRate),
          keyEventsAt === undefined ? "-" : num(r.keyEvents),
          keyEventsAt === undefined ? "-" : r.efficiency.toFixed(3),
        ];
        if (revenueAt !== undefined) cells.push(r.revenue.toFixed(2));
        return cells;
      });

      const totalSessions = analyzed.reduce((s, r) => s + r.sessions, 0);
      const totalKeyEvents = analyzed.reduce((s, r) => s + r.keyEvents, 0);
      const siteWide = totalSessions > 0 ? totalKeyEvents / totalSessions : 0;

      return ok(
        `Acquisition — ${args.propertyId} — ${describeRange(range)}\n` +
          `${analyzed.length} sources above ${args.minSessions} sessions, ranked by ${args.orderBy}\n` +
          (keyEventsAt === undefined
            ? ""
            : `Property-wide key events per session: ${siteWide.toFixed(3)} — rows below that are underperforming\n`) +
          `\n` +
          table(headers, body) +
          truncationNotice({ shown: shown.length, total: analyzed.length, hint: "Raise `limit` to see more." }) +
          droppedNotice(dropped) +
          reportWarnings(res),
      );
    }),
  );
}

// ---------------------------------------------------------------------------

function registerLandingPageOpportunities(server: McpServer): void {
  server.registerTool(
    "ga4_landing_page_opportunities",
    {
      title: "Find underperforming landing pages",
      description:
        "The optimization list: landing pages pulling real traffic whose engagement or key-event rate is far below " +
        "this property's own median, ranked by how many key events that gap costs per period. The baseline is " +
        "self-calibrating — every page is judged against the rest of this site rather than an industry benchmark — " +
        "so the output stays meaningful whatever the niche. Use ga4_top_pages for what is popular; this answers " +
        "what to fix first.",
      inputSchema: {
        propertyId: propertyIdField,
        ...dateFields,
        dimension: z
          .enum(["landingPage", "landingPagePlusQueryString", "pagePath"])
          .default("landingPage")
          .describe("Which page identity to judge. landingPage attributes each session to its entry page."),
        basis: z
          .enum(["keyEvents", "engagement"])
          .default("keyEvents")
          .describe(
            "What counts as underperformance: a low key-event rate (needs key events configured) or a low engagement rate.",
          ),
        minSessions: z
          .number()
          .int()
          .min(1)
          .default(50)
          .describe("Minimum sessions for a page to be judged. Rates below ~50 sessions are noise."),
        ratioThreshold: z
          .number()
          .min(0.1)
          .max(1)
          .default(0.5)
          .describe("Flag pages whose rate is below this fraction of the property median. 0.5 = less than half."),
        dimensionFilters: filtersField,
        dimensionFiltersCombine: filtersCombineField,
        limit: limitField,
        maxRows: maxRowsField,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const range = resolveDateRange(args);

      const { res, dropped } = await runReportAllTolerant(
        {
          propertyId: args.propertyId,
          ...range,
          dimensions: [args.dimension],
          dimensionFilter: buildFilterExpression(args.dimensionFilters, args.dimensionFiltersCombine),
          orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        },
        ["sessions", "engagedSessions", "userEngagementDuration"],
        ["keyEvents"],
        args.maxRows,
      );

      const rows = res.rows ?? [];
      if (rows.length === 0) {
        return ok(`${args.propertyId} — ${describeRange(range)}\n\n${EMPTY_HINT}${reportWarnings(res)}`);
      }

      const idx = metricIndex(res);
      const sessionsAt = idx.get("sessions") ?? 0;
      const engagedAt = idx.get("engagedSessions") ?? 1;
      const durationAt = idx.get("userEngagementDuration") ?? 2;
      const keyEventsAt = idx.get("keyEvents");

      const basis = args.basis === "keyEvents" && keyEventsAt === undefined ? "engagement" : args.basis;

      const pages = rows
        .map((row) => {
          const sessions = metricValue(row, sessionsAt);
          const engaged = metricValue(row, engagedAt);
          const keyEvents = keyEventsAt === undefined ? 0 : metricValue(row, keyEventsAt);
          return {
            key: dimValue(row, 0) || "(not set)",
            sessions,
            engaged,
            keyEvents,
            duration: metricValue(row, durationAt),
            engagementRate: sessions > 0 ? engaged / sessions : 0,
            keyEventRate: sessions > 0 ? keyEvents / sessions : 0,
          };
        })
        .filter((p) => p.sessions >= args.minSessions);

      if (pages.length === 0) {
        return ok(
          `Landing page opportunities — ${args.propertyId} — ${describeRange(range)}\n\n` +
            `No page reached ${args.minSessions} sessions. Lower minSessions or widen the date range.`,
        );
      }

      const rateOf = (p: (typeof pages)[number]) =>
        basis === "keyEvents" ? p.keyEventRate : p.engagementRate;

      // Property-relative baseline: the median rate among pages that cleared the
      // sessions floor, so one dominant page cannot set the bar for the rest.
      const baseline = median(pages.map(rateOf));

      if (baseline <= 0) {
        return ok(
          `Landing page opportunities — ${args.propertyId} — ${describeRange(range)}\n\n` +
            `The median ${basis === "keyEvents" ? "key-event" : "engagement"} rate across ${pages.length} pages is zero, ` +
            `so there is no baseline to compare against.` +
            (basis === "keyEvents"
              ? ` This property may have no key events configured — ga4_describe_property lists them, and basis:"engagement" works without any.`
              : "") +
            droppedNotice(dropped),
        );
      }

      const flagged = pages
        .map((p) => ({
          page: p,
          rate: rateOf(p),
          // What closing the gap to the median would be worth, in the currency
          // of the chosen basis.
          lost:
            basis === "keyEvents"
              ? Math.round(p.sessions * Math.max(0, baseline - p.keyEventRate))
              : Math.round(p.sessions * Math.max(0, baseline - p.engagementRate)),
        }))
        .filter((f) => f.rate < baseline * args.ratioThreshold)
        .sort((a, b) => b.lost - a.lost);

      const label = basis === "keyEvents" ? "key events" : "engaged sessions";
      const header =
        `Landing page opportunities — ${args.propertyId} — ${describeRange(range)}\n` +
        `Basis: ${basis}. Property median ${basis === "keyEvents" ? "key-event" : "engagement"} rate ` +
        `across ${pages.length} qualifying pages: ${pct(baseline)}\n` +
        `Flagging pages below ${args.ratioThreshold}x that median with at least ${args.minSessions} sessions ` +
        `(scanned ${rows.length} rows)`;

      if (flagged.length === 0) {
        return ok(
          `${header}\n\nNothing flagged — every page with real traffic performs in line with the rest of the site. ` +
            `Raise ratioThreshold or lower minSessions to loosen the filter.` +
            droppedNotice(dropped) +
            reportWarnings(res),
        );
      }

      const shown = flagged.slice(0, args.limit);
      const totalLost = flagged.reduce((sum, f) => sum + f.lost, 0);

      const headers = [
        args.dimension,
        "sessions",
        basis === "keyEvents" ? "keyEvents" : "engaged",
        "rate",
        "median",
        `lost ${label}`,
        "avg engagement",
      ];
      const body = shown.map((f) => [
        shortenUrl(f.page.key, 55),
        num(f.page.sessions),
        num(basis === "keyEvents" ? f.page.keyEvents : f.page.engaged),
        pct(f.rate),
        pct(baseline),
        num(f.lost),
        dur(f.page.sessions > 0 ? f.page.duration / f.page.sessions : 0),
      ]);

      return ok(
        `${header}\n${flagged.length} pages flagged, ~${num(totalLost)} ${label}/period left on the table\n\n` +
          table(headers, body) +
          truncationNotice({ shown: shown.length, total: flagged.length, hint: "Raise `limit` to see more." }) +
          droppedNotice(dropped) +
          reportWarnings(res),
      );
    }),
  );
}

export function registerInsightTools(server: McpServer): void {
  registerTrafficOverview(server);
  registerComparePeriods(server);
  registerTopPages(server);
  registerAcquisition(server);
  registerLandingPageOpportunities(server);
}
