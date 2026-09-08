import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runFunnelReport, type FunnelStepSpec } from "../client.js";
import { guard, ok } from "../lib/tool.js";
import { num, pct, table } from "../lib/format.js";
import { describeRange, resolveDateRange } from "../lib/dates.js";
import { dateFields, propertyIdField } from "./shared.js";

export function registerFunnelTool(server: McpServer): void {
  server.registerTool(
    "ga4_funnel",
    {
      title: "Funnel drop-off between steps",
      description:
        "Step-by-step drop-off through a sequence you define — how many users reached each step and what share " +
        "was lost at every transition. Each step matches either an event name (e.g. view_item, add_to_cart, " +
        "purchase) or a page path substring, so it works for signup flows and checkout alike. Use this when the " +
        "question is where users abandon a process, rather than which pages underperform overall " +
        "(ga4_landing_page_opportunities). Runs on the GA4 Data API v1alpha funnel endpoint, which Google may change.",
      inputSchema: {
        propertyId: propertyIdField,
        ...dateFields,
        steps: z
          .array(
            z.object({
              name: z.string().describe("Label for this step, e.g. 'Viewed pricing'."),
              eventName: z
                .string()
                .optional()
                .describe("GA4 event name that completes this step, e.g. add_to_cart. Get real names from ga4_run_report on the eventName dimension."),
              pagePath: z
                .string()
                .optional()
                .describe("Page path substring that completes this step instead of an event, e.g. '/checkout'."),
            }),
          )
          .min(2)
          .max(10)
          .describe("Ordered funnel steps. Users must complete them in this order to advance."),
        breakdownDimension: z
          .string()
          .optional()
          .describe(
            "Optional dimension to split every step by, e.g. deviceCategory or sessionDefaultChannelGroup — shows which segment abandons.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const range = resolveDateRange(args);
      const steps = args.steps as FunnelStepSpec[];

      const res = await runFunnelReport(
        args.propertyId,
        steps,
        range.startDate,
        range.endDate,
        args.breakdownDimension,
      );

      const funnelRows = res.funnelTable?.rows ?? [];
      const header =
        `Funnel — ${args.propertyId} — ${describeRange(range)}\n` +
        steps.map((s, i) => `  ${i + 1}. ${s.name} (${s.pagePath ? `path contains ${s.pagePath}` : `event ${s.eventName ?? s.name}`})`).join("\n");

      if (funnelRows.length === 0) {
        return ok(
          `${header}\n\nNo users entered the funnel. Usually a step name that does not match a real event — ` +
            `run ga4_run_report with dimensions ['eventName'] and metric eventCount to see the events this ` +
            `property actually collects.`,
        );
      }

      // The funnel table's dimension columns are [stepLabel] or [breakdown,
      // stepLabel]; the first metric is the active user count at that step.
      const dimHeaders = (res.funnelTable?.dimensionHeaders ?? []).map((h) => h.name ?? "");
      const metHeaders = (res.funnelTable?.metricHeaders ?? []).map((h) => h.name ?? "");

      const parsed = funnelRows.map((row) => ({
        dims: dimHeaders.map((_, i) => row.dimensionValues?.[i]?.value ?? ""),
        users: Number(row.metricValues?.[0]?.value ?? 0),
      }));

      // Without a breakdown there is one row per step, so drop-off is simply the
      // change against the previous row.
      if (!args.breakdownDimension) {
        const first = parsed[0]?.users ?? 0;
        const body = parsed.map((row, i) => {
          const previous = i === 0 ? row.users : parsed[i - 1]!.users;
          const dropped = previous - row.users;
          return [
            row.dims[row.dims.length - 1] ?? `step ${i + 1}`,
            num(row.users),
            i === 0 ? "-" : `${num(dropped)} (${pct(previous > 0 ? dropped / previous : 0)})`,
            first > 0 ? pct(row.users / first) : "-",
          ];
        });

        const worst = parsed
          .map((row, i) => ({
            step: row.dims[row.dims.length - 1] ?? `step ${i + 1}`,
            rate: i === 0 || parsed[i - 1]!.users === 0 ? 0 : (parsed[i - 1]!.users - row.users) / parsed[i - 1]!.users,
          }))
          .sort((a, b) => b.rate - a.rate)[0];

        return ok(
          `${header}\n\n` +
            table(["step", "users", "dropped here", "% of entrants"], body) +
            (worst && worst.rate > 0
              ? `\n\nBiggest leak: "${worst.step}" loses ${pct(worst.rate)} of the users who reached the step before it.`
              : ""),
        );
      }

      const body = parsed.map((row) => [...row.dims, num(row.users)]);
      return ok(`${header}\n\n${table([...dimHeaders, metHeaders[0] ?? "activeUsers"], body)}`);
    }),
  );
}
