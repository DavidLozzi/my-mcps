import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Ga4ApiError, getDataRetention, getProperty, listCustomDimensions, listCustomMetrics, listDataStreams, listKeyEvents } from "../client.js";
import { guard, ok } from "../lib/tool.js";
import { table } from "../lib/format.js";
import { propertyIdField } from "./shared.js";

/** A config section that 403s is missing permission, not a broken tool. */
async function section<T>(load: () => Promise<T[]>): Promise<{ items: T[]; error?: string }> {
  try {
    return { items: await load() };
  } catch (err) {
    if (err instanceof Ga4ApiError && (err.status === 403 || err.status === 404)) {
      return { items: [], error: `unavailable (${err.status})` };
    }
    throw err;
  }
}

export function registerAdminTools(server: McpServer): void {
  server.registerTool(
    "ga4_describe_property",
    {
      title: "Describe a property's configuration",
      description:
        "What this property is and what it actually tracks: time zone, currency, data retention window, data " +
        "streams and their measurement ids, configured key events, and custom dimensions and metrics. Read this " +
        "before trusting an empty or surprising report — no key events configured explains zero conversions, a " +
        "short retention window explains a long date range returning nothing, and the custom dimension list is " +
        "the only way to know what site-specific fields can be queried.",
      inputSchema: { propertyId: propertyIdField },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const [property, retention, streams, keyEvents, dimensions, metrics] = await Promise.all([
        getProperty(args.propertyId),
        section(async () => [await getDataRetention(args.propertyId)]),
        section(() => listDataStreams(args.propertyId)),
        section(() => listKeyEvents(args.propertyId)),
        section(() => listCustomDimensions(args.propertyId)),
        section(() => listCustomMetrics(args.propertyId)),
      ]);

      const retentionSetting = retention.items[0]?.eventDataRetention?.replace(/_/g, " ").toLowerCase();

      const overview = table(
        ["field", "value"],
        [
          ["propertyId", (property.name ?? "").replace(/^properties\//, "")],
          ["displayName", property.displayName ?? "-"],
          ["type", (property.propertyType ?? "-").replace(/^PROPERTY_TYPE_/, "")],
          ["serviceLevel", (property.serviceLevel ?? "-").replace(/^GOOGLE_ANALYTICS_/, "")],
          ["timeZone", property.timeZone ?? "-"],
          ["currency", property.currencyCode ?? "-"],
          ["industry", property.industryCategory ?? "-"],
          ["created", (property.createTime ?? "-").slice(0, 10)],
          ["event data retention", retentionSetting ?? retention.error ?? "-"],
        ],
      );

      const streamRows = streams.items.map((s) => [
        s.displayName ?? "-",
        (s.type ?? "").replace(/_DATA_STREAM$/, ""),
        s.webStreamData?.measurementId ??
          s.androidAppStreamData?.firebaseAppId ??
          s.iosAppStreamData?.firebaseAppId ??
          "-",
        s.webStreamData?.defaultUri ?? s.androidAppStreamData?.packageName ?? s.iosAppStreamData?.bundleId ?? "-",
      ]);

      const keyEventRows = keyEvents.items.map((k) => [
        k.eventName ?? "-",
        (k.countingMethod ?? "-").replace(/_/g, " ").toLowerCase(),
        k.custom ? "custom" : "default",
      ]);

      const dimensionRows = dimensions.items.map((d) => [
        d.parameterName ?? "-",
        d.displayName ?? "-",
        (d.scope ?? "-").toLowerCase(),
        d.description ?? "",
      ]);

      const metricRows = metrics.items.map((m) => [
        m.parameterName ?? "-",
        m.displayName ?? "-",
        (m.measurementUnit ?? "-").replace(/_/g, " ").toLowerCase(),
        (m.scope ?? "-").toLowerCase(),
      ]);

      const block = (
        title: string,
        headers: string[],
        rows: string[][],
        empty: string,
        error?: string,
      ) =>
        `${title} (${rows.length})\n` +
        (error ? `  ${error}` : rows.length === 0 ? `  ${empty}` : table(headers, rows));

      return ok(
        [
          `${property.displayName ?? args.propertyId} — configuration\n\n${overview}`,
          block("DATA STREAMS", ["stream", "type", "measurementId", "target"], streamRows, "No data streams — nothing is being collected.", streams.error),
          block(
            "KEY EVENTS",
            ["event", "counting", "origin"],
            keyEventRows,
            "None configured. Every conversion metric will read zero until key events are marked in GA4 (Admin > Events > Key events).",
            keyEvents.error,
          ),
          block(
            "CUSTOM DIMENSIONS",
            ["parameter", "name", "scope", "description"],
            dimensionRows,
            "None. Only GA4's built-in dimensions are queryable.",
            dimensions.error,
          ),
          block("CUSTOM METRICS", ["parameter", "name", "unit", "scope"], metricRows, "None.", metrics.error),
          `Custom fields are queried by their API name, not the parameter name shown here — ` +
            `ga4_get_metadata with customOnly:true lists the exact names to pass to ga4_run_report.`,
        ].join("\n\n"),
      );
    }),
  );
}
