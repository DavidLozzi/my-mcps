import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runRealtimeReport } from "../client.js";
import { guard, ok } from "../lib/tool.js";
import { renderReportTable, reportWarnings } from "../lib/report.js";
import { buildFilterExpression, filtersCombineField, filtersField, propertyIdField } from "./shared.js";

/**
 * The realtime surface supports a much smaller field set than core reporting,
 * and a name that is valid in ga4_run_report is often rejected here — so this
 * tool offers an allowlist rather than free-text names.
 */
const realtimeDimensionSchema = z.enum([
  "unifiedScreenName",
  "eventName",
  "country",
  "city",
  "deviceCategory",
  "platform",
  "audienceName",
  "appVersion",
  "streamName",
  "minutesAgo",
]);

const realtimeMetricSchema = z.enum([
  "activeUsers",
  "screenPageViews",
  "eventCount",
  "conversions",
  "keyEvents",
]);

export function registerRealtimeTool(server: McpServer): void {
  server.registerTool(
    "ga4_realtime",
    {
      title: "Realtime active users",
      description:
        "Who is on the site right now, from the last 30 minutes (or up to 60), broken down by page, event, " +
        "country, or device. Use this for 'is the traffic spike happening now', 'did the deploy break tracking', " +
        "or 'is anyone hitting the new page' — not for trends, since the realtime surface has no history and " +
        "supports far fewer fields than ga4_run_report.",
      inputSchema: {
        propertyId: propertyIdField,
        dimensions: z
          .array(realtimeDimensionSchema)
          .max(3)
          .default(["unifiedScreenName"])
          .describe("Group by these. Use minutesAgo to see the shape of the last half hour."),
        metrics: z
          .array(realtimeMetricSchema)
          .min(1)
          .max(4)
          .default(["activeUsers"])
          .describe("Realtime metrics to report."),
        minutes: z
          .number()
          .int()
          .min(1)
          .max(60)
          .default(30)
          .describe("How many minutes back to look. GA4 keeps at most 30 minutes for most properties, 60 for some."),
        dimensionFilters: filtersField,
        dimensionFiltersCombine: filtersCombineField,
        limit: z.number().int().min(1).max(200).default(25).describe("Maximum rows."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const res = await runRealtimeReport({
        propertyId: args.propertyId,
        dimensions: args.dimensions,
        metrics: args.metrics,
        minuteRanges: [{ startMinutesAgo: args.minutes, endMinutesAgo: 0 }],
        dimensionFilter: buildFilterExpression(args.dimensionFilters, args.dimensionFiltersCombine),
        orderBys: [{ metric: { metricName: args.metrics[0]! }, desc: true }],
        limit: args.limit,
      });

      const header = `${args.propertyId} — realtime, last ${args.minutes} minutes`;
      const rows = res.rows ?? [];

      if (rows.length === 0) {
        return ok(
          `${header}\n\nNo active users right now. If the site definitely has traffic, check that the data ` +
            `stream is still installed — ga4_describe_property lists the streams and their measurement ids.`,
        );
      }

      return ok(`${header}\n\n${renderReportTable(res, { cap: args.limit })}${reportWarnings(res)}`);
    }),
  );
}
