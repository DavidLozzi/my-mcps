/**
 * Analysis tools: each answers one question a publisher actually asks, doing
 * the arithmetic server-side so the answer arrives as a verdict rather than a
 * spreadsheet to interpret.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { generateReport, resolveAccount } from "../client.js";
import { guard, ok } from "../lib/tool.js";
import {
  addDays,
  describeRange,
  precedingRange,
  presetRange,
  resolveDateRange,
  today,
  EMPTY_HINT,
  type DateRange,
} from "../lib/dates.js";
import { parseReport, type ParsedReport } from "../lib/report.js";
import {
  changePct,
  median,
  money,
  num,
  pct,
  rpm,
  shortenUrl,
  signedMoney,
  table,
  truncationNotice,
} from "../lib/format.js";
import { accountField, breakdownDimensionField, dateFields } from "./shared.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

/** AdSense filter values escape a literal comma or backslash with a backslash. */
function escapeFilterValue(value: string): string {
  return value.replace(/([\\,])/g, "\\$1");
}

interface Totals {
  earnings: number;
  pageViews: number;
  impressions: number;
  clicks: number;
}

function sumDays(report: ParsedReport, range: DateRange): Totals {
  const t: Totals = { earnings: 0, pageViews: 0, impressions: 0, clicks: 0 };
  for (const row of report.rows) {
    const date = row.dims.DATE!;
    if (date < range.startDate || date > range.endDate) continue;
    t.earnings += row.metrics.ESTIMATED_EARNINGS ?? 0;
    t.pageViews += row.metrics.PAGE_VIEWS ?? 0;
    t.impressions += row.metrics.IMPRESSIONS ?? 0;
    t.clicks += row.metrics.CLICKS ?? 0;
  }
  return t;
}

/** Page views drive some dimensions; others (ad units, formats, networks) only have impressions. */
const PAGE_VIEW_DIMENSIONS = new Set([
  "PAGE_URL",
  "DOMAIN_NAME",
  "OWNED_SITE_DOMAIN_NAME",
  "COUNTRY_NAME",
  "PLATFORM_TYPE_NAME",
  "URL_CHANNEL_NAME",
]);

export function registerInsightTools(server: McpServer): void {
  server.registerTool(
    "adsense_earnings_overview",
    {
      title: "AdSense earnings overview",
      description:
        "Start here for any 'how is AdSense doing' question. Earnings, page views, page RPM and CTR for today " +
        "so far, yesterday, the last 7 and 28 days (each against the period before), month to date and last " +
        "month, plus a daily trend and the top earning domains.",
      inputSchema: {
        account: accountField,
        trendDays: z.number().int().min(0).max(60).default(14).describe("Days of daily trend to show (0 to skip)."),
      },
      annotations: READ_ONLY,
    },
    guard(async ({ account, trendDays }) => {
      const acct = await resolveAccount(account);
      const now = today();
      const lastMonth = presetRange("last_month", now);
      const earliest = [addDays(now, -56), lastMonth.startDate, addDays(now, -trendDays)].sort()[0]!;

      // One daily report covers every window; the summaries are sums over it,
      // with ratios recomputed from the sums rather than averaged.
      const daily = parseReport(
        await generateReport(acct, {
          dateRange: { startDate: earliest, endDate: now },
          dimensions: ["DATE"],
          metrics: ["ESTIMATED_EARNINGS", "PAGE_VIEWS", "IMPRESSIONS", "CLICKS"],
          orderBy: ["+DATE"],
          limit: 1000,
        }),
      );
      const cur = daily.currency;

      const last7 = presetRange("last_7_days", now);
      const last28 = presetRange("last_28_days", now);
      const windows: Array<[string, DateRange, DateRange | undefined]> = [
        ["Today (partial)", presetRange("today", now), undefined],
        ["Yesterday", presetRange("yesterday", now), { startDate: addDays(now, -2), endDate: addDays(now, -2) }],
        ["Last 7 days", last7, precedingRange(last7)],
        ["Last 28 days", last28, precedingRange(last28)],
        ["Month to date", presetRange("month_to_date", now), undefined],
        ["Last month", lastMonth, undefined],
      ];

      const summary = table(
        ["window", "dates", "earnings", "vsPrior", "pageViews", "pageRPM", "clicks", "CTR"],
        windows.map(([label, range, prior]) => {
          const t = sumDays(daily, range);
          const p = prior ? sumDays(daily, prior) : undefined;
          return [
            label,
            describeRange(range),
            money(t.earnings, cur),
            p ? changePct(t.earnings, p.earnings) : "",
            num(t.pageViews),
            money(rpm(t.earnings, t.pageViews), cur),
            num(t.clicks),
            t.pageViews > 0 ? pct(t.clicks / t.pageViews) : "-",
          ];
        }),
      );

      const parts = [`AdSense overview (${acct.replace(/^accounts\//, "")}, ${cur})\n\n${summary}`];

      // Explain the 28-day change: earnings = page views x RPM, so split the
      // change exactly into a traffic effect and a yield effect.
      const t28 = sumDays(daily, last28);
      const p28 = sumDays(daily, precedingRange(last28));
      const rpmNow = rpm(t28.earnings, t28.pageViews);
      const rpmBefore = rpm(p28.earnings, p28.pageViews);
      const trafficEffect = ((t28.pageViews - p28.pageViews) * rpmBefore) / 1000;
      const yieldEffect = (t28.pageViews * (rpmNow - rpmBefore)) / 1000;
      if (p28.earnings > 0 || t28.earnings > 0) {
        parts.push(
          `LAST 28 DAYS vs PRIOR 28: ${signedMoney(t28.earnings - p28.earnings, cur)} ` +
            `(${changePct(t28.earnings, p28.earnings)})\n` +
            `  traffic effect: ${signedMoney(trafficEffect, cur)}  (page views ${changePct(t28.pageViews, p28.pageViews)})\n` +
            `  yield effect:   ${signedMoney(yieldEffect, cur)}  (page RPM ${money(rpmBefore, cur)} -> ${money(rpmNow, cur)})`,
        );
      }

      if (trendDays > 0) {
        const from = addDays(now, -trendDays + 1);
        const trendRows = daily.rows
          .filter((r) => r.dims.DATE! >= from)
          .map((r) => {
            const e = r.metrics.ESTIMATED_EARNINGS ?? 0;
            const pv = r.metrics.PAGE_VIEWS ?? 0;
            return [r.dims.DATE!, money(e, cur), num(pv), money(rpm(e, pv), cur)];
          });
        parts.push(`DAILY\n${table(["date", "earnings", "pageViews", "pageRPM"], trendRows)}`);
      }

      try {
        const domains = parseReport(
          await generateReport(acct, {
            dateRange: last28,
            dimensions: ["DOMAIN_NAME"],
            metrics: ["ESTIMATED_EARNINGS", "PAGE_VIEWS"],
            orderBy: ["-ESTIMATED_EARNINGS"],
            limit: 10,
          }),
        );
        if (domains.rows.length > 0) {
          parts.push(
            `TOP DOMAINS, last 28 days\n` +
              table(
                ["domain", "earnings", "share", "pageViews", "pageRPM"],
                domains.rows.map((r) => {
                  const e = r.metrics.ESTIMATED_EARNINGS ?? 0;
                  const pv = r.metrics.PAGE_VIEWS ?? 0;
                  return [
                    r.dims.DOMAIN_NAME!,
                    money(e, cur),
                    t28.earnings > 0 ? pct(e / t28.earnings) : "-",
                    num(pv),
                    money(rpm(e, pv), cur),
                  ];
                }),
              ),
          );
        }
      } catch {
        /* The domain split is a nice-to-have; the overview stands without it. */
      }

      parts.push(
        "Estimated earnings for today and the last couple of days can still move; finalized earnings settle " +
          "after the month closes.",
      );
      return ok(parts.join("\n\n"));
    }),
  );

  server.registerTool(
    "adsense_compare_periods",
    {
      title: "Compare AdSense earnings between periods",
      description:
        "What changed: earnings for two windows broken down by page, domain, country, device, ad unit or " +
        "format, with the biggest losses and gains listed separately. The headline change is split exactly into " +
        "a traffic effect (more or fewer page views) and a yield effect (higher or lower page RPM), which tells " +
        "you whether to look at traffic or at ads. Defaults to the last 28 days against the 28 before.",
      inputSchema: {
        account: accountField,
        dimension: breakdownDimensionField.default("PAGE_URL"),
        ...dateFields,
        compareStartDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Start of the baseline window. Defaults to the equal-length window just before."),
        compareEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End of the baseline window."),
        limit: z.number().int().min(1).max(100).default(10).describe("Rows to show in each of losses and gains."),
      },
      annotations: READ_ONLY,
    },
    guard(async ({ account, dimension, startDate, endDate, range, compareStartDate, compareEndDate, limit }) => {
      const acct = await resolveAccount(account);
      const current = resolveDateRange({ startDate, endDate, range });
      const baseline =
        compareStartDate && compareEndDate
          ? { startDate: compareStartDate, endDate: compareEndDate }
          : precedingRange(current);

      const volume = PAGE_VIEW_DIMENSIONS.has(dimension) ? "PAGE_VIEWS" : "IMPRESSIONS";
      const fetchBreakdown = (dateRange: DateRange) =>
        generateReport(acct, {
          dateRange,
          dimensions: [dimension],
          metrics: ["ESTIMATED_EARNINGS", volume],
          orderBy: ["-ESTIMATED_EARNINGS"],
          limit: 10_000,
        }).then(parseReport);
      const fetchTotals = (dateRange: DateRange) =>
        generateReport(acct, { dateRange, metrics: ["ESTIMATED_EARNINGS", "PAGE_VIEWS"] }).then(parseReport);

      const [curRows, baseRows, curTotals, baseTotals] = await Promise.all([
        fetchBreakdown(current),
        fetchBreakdown(baseline),
        fetchTotals(current),
        fetchTotals(baseline),
      ]);
      const cur = curTotals.currency;

      const total = (r: ParsedReport, m: string) => r.rows[0]?.metrics[m] ?? r.totals?.[m] ?? 0;
      const e1 = total(curTotals, "ESTIMATED_EARNINGS");
      const e0 = total(baseTotals, "ESTIMATED_EARNINGS");
      const pv1 = total(curTotals, "PAGE_VIEWS");
      const pv0 = total(baseTotals, "PAGE_VIEWS");
      const rpm1 = rpm(e1, pv1);
      const rpm0 = rpm(e0, pv0);

      const parts = [
        `Earnings by ${dimension}: ${describeRange(current)} vs ${describeRange(baseline)}`,
        `TOTAL: ${money(e1, cur)} vs ${money(e0, cur)}  ${signedMoney(e1 - e0, cur)} (${changePct(e1, e0)})\n` +
          `  traffic effect: ${signedMoney(((pv1 - pv0) * rpm0) / 1000, cur)}  (page views ${num(pv0)} -> ${num(pv1)}, ${changePct(pv1, pv0)})\n` +
          `  yield effect:   ${signedMoney((pv1 * (rpm1 - rpm0)) / 1000, cur)}  (page RPM ${money(rpm0, cur)} -> ${money(rpm1, cur)})`,
      ];

      const keys = new Map<string, { e1: number; e0: number; v1: number; v0: number }>();
      for (const r of curRows.rows) {
        keys.set(r.dims[dimension]!, { e1: r.metrics.ESTIMATED_EARNINGS ?? 0, e0: 0, v1: r.metrics[volume] ?? 0, v0: 0 });
      }
      for (const r of baseRows.rows) {
        const k = r.dims[dimension]!;
        const entry = keys.get(k) ?? { e1: 0, e0: 0, v1: 0, v0: 0 };
        entry.e0 = r.metrics.ESTIMATED_EARNINGS ?? 0;
        entry.v0 = r.metrics[volume] ?? 0;
        keys.set(k, entry);
      }

      const entries = [...keys.entries()].map(([key, v]) => ({ key, ...v, delta: v.e1 - v.e0 }));
      const label = (k: string) => (dimension === "PAGE_URL" ? shortenUrl(k) : k);
      const volLabel = volume === "PAGE_VIEWS" ? "pageViews" : "impressions";
      const render = (rows: typeof entries) =>
        table(
          [dimension, "earnings", "before", "change", "%", volLabel, "before"],
          rows.map((r) => [
            label(r.key),
            money(r.e1, cur),
            money(r.e0, cur),
            signedMoney(r.delta, cur),
            changePct(r.e1, r.e0),
            num(r.v1),
            num(r.v0),
          ]),
        );

      const losses = entries.filter((e) => e.delta < 0).sort((a, b) => a.delta - b.delta);
      const gains = entries.filter((e) => e.delta > 0).sort((a, b) => b.delta - a.delta);

      parts.push(
        `LOSSES (${losses.length}, ${signedMoney(losses.reduce((s, e) => s + e.delta, 0), cur)})\n` +
          render(losses.slice(0, limit)) +
          truncationNotice(Math.min(limit, losses.length), losses.length),
      );
      parts.push(
        `GAINS (${gains.length}, ${signedMoney(gains.reduce((s, e) => s + e.delta, 0), cur)})\n` +
          render(gains.slice(0, limit)) +
          truncationNotice(Math.min(limit, gains.length), gains.length),
      );

      return ok(parts.join("\n\n"));
    }),
  );

  server.registerTool(
    "adsense_top_pages",
    {
      title: "Top earning pages",
      description:
        "Which pages earn the money: earnings, page views, page RPM, impressions, clicks and share of total per " +
        "page URL. Sort by earnings, page views or RPM. Use urlContains to scope to one site or section.",
      inputSchema: {
        account: accountField,
        ...dateFields,
        urlContains: z
          .string()
          .optional()
          .describe("Only pages whose URL contains this, e.g. 'timeline.starwars.guide' or '/characters/'."),
        sortBy: z.enum(["earnings", "page_views", "rpm"]).default("earnings"),
        limit: z.number().int().min(1).max(500).default(25),
      },
      annotations: READ_ONLY,
    },
    guard(async ({ account, startDate, endDate, range, urlContains, sortBy, limit }) => {
      const acct = await resolveAccount(account);
      const dateRange = resolveDateRange({ startDate, endDate, range });
      const order = { earnings: "-ESTIMATED_EARNINGS", page_views: "-PAGE_VIEWS", rpm: "-PAGE_VIEWS_RPM" }[sortBy];

      const report = parseReport(
        await generateReport(acct, {
          dateRange,
          dimensions: ["PAGE_URL"],
          metrics: ["ESTIMATED_EARNINGS", "PAGE_VIEWS", "PAGE_VIEWS_RPM", "IMPRESSIONS", "CLICKS"],
          filters: urlContains ? [`PAGE_URL=@${escapeFilterValue(urlContains)}`] : undefined,
          orderBy: [order],
          limit,
        }),
      );

      const header = `Top pages by ${sortBy.replace("_", " ")}, ${describeRange(dateRange)}${urlContains ? ` (URL contains "${urlContains}")` : ""}`;
      if (report.rows.length === 0) return ok(`${header}\n\n${EMPTY_HINT}`);

      const cur = report.currency;
      const totalEarnings = report.totals?.ESTIMATED_EARNINGS ?? 0;
      const body = table(
        ["page", "earnings", "share", "pageViews", "pageRPM", "impressions", "clicks"],
        report.rows.map((r) => [
          shortenUrl(r.dims.PAGE_URL!),
          money(r.metrics.ESTIMATED_EARNINGS ?? 0, cur),
          totalEarnings > 0 ? pct((r.metrics.ESTIMATED_EARNINGS ?? 0) / totalEarnings) : "-",
          num(r.metrics.PAGE_VIEWS ?? 0),
          money(r.metrics.PAGE_VIEWS_RPM ?? 0, cur),
          num(r.metrics.IMPRESSIONS ?? 0),
          num(r.metrics.CLICKS ?? 0),
        ]),
      );

      const totalsLine = report.totals
        ? `\n\nAll matching pages: ${money(totalEarnings, cur)} from ${num(report.totals.PAGE_VIEWS ?? 0)} page views ` +
          `(page RPM ${money(rpm(totalEarnings, report.totals.PAGE_VIEWS ?? 0), cur)})`
        : "";

      return ok(`${header}\n\n${body}${truncationNotice(report.rows.length, report.totalMatchedRows)}${totalsLine}`);
    }),
  );

  server.registerTool(
    "adsense_rpm_opportunities",
    {
      title: "Pages that under-earn their traffic",
      description:
        "The fix list: pages with real traffic whose page RPM falls well below this account's own median page " +
        "RPM, ranked by the money left on the table (page views x RPM gap). Also flags pages with traffic but no " +
        "ad impressions at all. Calibrated against this account's median, not an industry benchmark, so " +
        "'under-earning' means under-earning for these sites.",
      inputSchema: {
        account: accountField,
        ...dateFields,
        urlContains: z.string().optional().describe("Only pages whose URL contains this."),
        minPageViews: z
          .number()
          .int()
          .min(1)
          .default(200)
          .describe("Ignore pages below this many page views — their RPM is noise."),
        threshold: z
          .number()
          .min(0.05)
          .max(0.95)
          .default(0.5)
          .describe("Flag pages whose RPM is below this fraction of the median. 0.5 = less than half the median."),
        limit: z.number().int().min(1).max(200).default(20),
      },
      annotations: READ_ONLY,
    },
    guard(async ({ account, startDate, endDate, range, urlContains, minPageViews, threshold, limit }) => {
      const acct = await resolveAccount(account);
      const dateRange = resolveDateRange({ startDate, endDate, range });

      const report = parseReport(
        await generateReport(acct, {
          dateRange,
          dimensions: ["PAGE_URL"],
          metrics: ["ESTIMATED_EARNINGS", "PAGE_VIEWS", "IMPRESSIONS"],
          filters: urlContains ? [`PAGE_URL=@${escapeFilterValue(urlContains)}`] : undefined,
          orderBy: ["-PAGE_VIEWS"],
          limit: 10_000,
        }),
      );
      const cur = report.currency;

      const pages = report.rows
        .map((r) => {
          const earnings = r.metrics.ESTIMATED_EARNINGS ?? 0;
          const pageViews = r.metrics.PAGE_VIEWS ?? 0;
          return { url: r.dims.PAGE_URL!, earnings, pageViews, impressions: r.metrics.IMPRESSIONS ?? 0, rpm: rpm(earnings, pageViews) };
        })
        .filter((p) => p.pageViews >= minPageViews);

      const header = `RPM opportunities, ${describeRange(dateRange)}${urlContains ? ` (URL contains "${urlContains}")` : ""}`;
      if (pages.length < 3) {
        return ok(
          `${header}\n\nOnly ${pages.length} page${pages.length === 1 ? "" : "s"} reached ${minPageViews} page views — ` +
            `too few to establish a median. Lower minPageViews or widen the date range.`,
        );
      }

      const medianRpm = median(pages.map((p) => p.rpm));
      const cutoff = medianRpm * threshold;
      const flagged = pages
        .filter((p) => p.rpm < cutoff)
        .map((p) => ({ ...p, gap: (p.pageViews * (medianRpm - p.rpm)) / 1000 }))
        .sort((a, b) => b.gap - a.gap);
      const noAds = flagged.filter((p) => p.impressions === 0);

      const parts = [
        header,
        `Baseline: ${pages.length} pages with >= ${num(minPageViews)} page views, median page RPM ${money(medianRpm, cur)}. ` +
          `Flagging RPM below ${money(cutoff, cur)}.`,
      ];

      if (flagged.length === 0) {
        parts.push("No page falls below the threshold — yield is even across pages with traffic.");
        return ok(parts.join("\n\n"));
      }

      const totalGap = flagged.reduce((s, p) => s + p.gap, 0);
      parts.push(
        `UNDER-EARNING (${flagged.length} pages, ~${money(totalGap, cur)} below median yield)\n` +
          table(
            ["page", "pageViews", "earnings", "pageRPM", "vsMedian", "impressions", "gap"],
            flagged.slice(0, limit).map((p) => [
              shortenUrl(p.url),
              num(p.pageViews),
              money(p.earnings, cur),
              money(p.rpm, cur),
              medianRpm > 0 ? pct(p.rpm / medianRpm) : "-",
              num(p.impressions),
              money(p.gap, cur),
            ]),
          ) +
          truncationNotice(Math.min(limit, flagged.length), flagged.length),
      );

      if (noAds.length > 0) {
        parts.push(
          `${noAds.length} of these served no ad impressions at all — check whether ads are excluded on those pages ` +
            `(Auto ads page exclusions, a template without ad slots, or the page loading before ads can render).`,
        );
      }
      parts.push(
        "Common causes of low page RPM: few or no ad slots on that template, ads placed below the fold, very short " +
          "sessions, or traffic from low-value countries. adsense_run_report with filters ['PAGE_URL==<url>'] and " +
          "dimensions like COUNTRY_NAME or AD_FORMAT_NAME shows which.",
      );
      return ok(parts.join("\n\n"));
    }),
  );
}
