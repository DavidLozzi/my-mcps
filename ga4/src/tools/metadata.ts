import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkCompatibility, getMetadata } from "../client.js";
import { guard, ok } from "../lib/tool.js";
import { shortenUrl, table, truncationNotice } from "../lib/format.js";
import { propertyIdField } from "./shared.js";

/** The full catalog runs to several hundred entries; never dump it whole. */
const RENDER_CAP = 60;

export function registerMetadataTools(server: McpServer): void {
  server.registerTool(
    "ga4_get_metadata",
    {
      title: "List available dimensions and metrics",
      description:
        "The dimension and metric API names this property actually supports, including its own custom " +
        "dimensions and custom metrics. Use this before writing any ga4_run_report call rather than guessing " +
        "field names: GA4 uses camelCase API names that differ from the UI labels, some have been renamed " +
        "(conversions became keyEvents), and custom fields are unique per property. Always pass a `search` " +
        "term — the unfiltered catalog is hundreds of entries long.",
      inputSchema: {
        propertyId: propertyIdField,
        search: z
          .string()
          .optional()
          .describe(
            "Case-insensitive substring matched against API name, UI name, and description. e.g. 'revenue', 'landing', 'session'.",
          ),
        kind: z
          .enum(["both", "dimensions", "metrics"])
          .default("both")
          .describe("Limit results to dimensions or metrics."),
        customOnly: z
          .boolean()
          .default(false)
          .describe("Only this property's custom dimensions and metrics — what this site tracks beyond the GA4 defaults."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(RENDER_CAP)
          .describe("Maximum entries per section."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const meta = await getMetadata(args.propertyId);
      const needle = args.search?.toLowerCase();

      const matches = (entry: {
        apiName?: string;
        uiName?: string;
        description?: string;
        customDefinition?: boolean;
      }) => {
        if (args.customOnly && !entry.customDefinition) return false;
        if (!needle) return true;
        return [entry.apiName, entry.uiName, entry.description]
          .filter(Boolean)
          .some((field) => field!.toLowerCase().includes(needle));
      };

      const dimensions = (meta.dimensions ?? []).filter(matches);
      const metrics = (meta.metrics ?? []).filter(matches);

      const sections: string[] = [];

      if (args.kind !== "metrics") {
        const shown = dimensions.slice(0, args.limit);
        sections.push(
          `DIMENSIONS (${dimensions.length} match${dimensions.length === 1 ? "" : "es"})\n` +
            table(
              ["apiName", "uiName", "custom", "description"],
              shown.map((d) => [
                d.apiName ?? "",
                d.uiName ?? "",
                d.customDefinition ? "yes" : "",
                shortenUrl(d.description ?? "", 70),
              ]),
            ) +
            truncationNotice({ shown: shown.length, total: dimensions.length, hint: "Narrow `search` or raise `limit`." }),
        );
      }

      if (args.kind !== "dimensions") {
        const shown = metrics.slice(0, args.limit);
        sections.push(
          `METRICS (${metrics.length} match${metrics.length === 1 ? "" : "es"})\n` +
            table(
              ["apiName", "uiName", "type", "custom", "description"],
              shown.map((m) => [
                m.apiName ?? "",
                m.uiName ?? "",
                (m.type ?? "").replace(/^TYPE_/, ""),
                m.customDefinition ? "yes" : "",
                shortenUrl(m.description ?? "", 60),
              ]),
            ) +
            truncationNotice({ shown: shown.length, total: metrics.length, hint: "Narrow `search` or raise `limit`." }),
        );
      }

      if (dimensions.length === 0 && metrics.length === 0) {
        return ok(
          `No dimension or metric matches "${args.search ?? ""}" on this property. Try a shorter search term, ` +
            `or drop the search term to browse everything.`,
        );
      }

      return ok(
        `${args.propertyId} — available fields${args.search ? ` matching "${args.search}"` : ""}\n\n` +
          sections.join("\n\n") +
          `\n\nNot every pair can be queried together — ga4_check_compatibility tests a combination before you spend quota on it.`,
      );
    }),
  );

  server.registerTool(
    "ga4_check_compatibility",
    {
      title: "Check dimension and metric compatibility",
      description:
        "Whether a set of dimensions and metrics can legally appear in the same GA4 report, and which additional " +
        "fields would still be valid alongside them. GA4 rejects incompatible combinations (typically mixing " +
        "scopes, like an item-scoped metric with a session-scoped dimension) with an opaque 400 — run this first " +
        "when a report fails or when combining fields you have not used together before.",
      inputSchema: {
        propertyId: propertyIdField,
        dimensions: z
          .array(z.string())
          .default([])
          .describe("Dimension API names you intend to request."),
        metrics: z
          .array(z.string())
          .default([])
          .describe("Metric API names you intend to request."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const res = await checkCompatibility(args.propertyId, args.dimensions, args.metrics);

      const compatibleDimensions = (res.dimensionCompatibilities ?? [])
        .map((c) => c.dimensionMetadata?.apiName)
        .filter((name): name is string => Boolean(name));
      const compatibleMetrics = (res.metricCompatibilities ?? [])
        .map((c) => c.metricMetadata?.apiName)
        .filter((name): name is string => Boolean(name));

      const requested = [...args.dimensions, ...args.metrics];
      const compatible = new Set([...compatibleDimensions, ...compatibleMetrics]);
      const rejected = requested.filter((name) => !compatible.has(name));

      const verdict =
        requested.length === 0
          ? "No fields requested, so this lists everything queryable on the property."
          : rejected.length === 0
            ? `COMPATIBLE — [${requested.join(", ")}] can be requested together.`
            : `INCOMPATIBLE — GA4 will not return [${rejected.join(", ")}] alongside the rest of this set. ` +
              `Drop them, or split the request into separate reports.`;

      const preview = (names: string[]) =>
        names.length === 0
          ? "  (none)"
          : `  ${names.slice(0, 40).join(", ")}${names.length > 40 ? ` … +${names.length - 40} more` : ""}`;

      return ok(
        `${verdict}\n\n` +
          `Dimensions that can still be added (${compatibleDimensions.length}):\n${preview(compatibleDimensions)}\n\n` +
          `Metrics that can still be added (${compatibleMetrics.length}):\n${preview(compatibleMetrics)}`,
      );
    }),
  );
}
