#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerPropertyTools } from "./tools/properties.js";
import { registerMetadataTools } from "./tools/metadata.js";
import { registerReportTool } from "./tools/reports.js";
import { registerRealtimeTool } from "./tools/realtime.js";
import { registerInsightTools } from "./tools/insights.js";
import { registerFunnelTool } from "./tools/funnel.js";
import { registerAdminTools } from "./tools/admin.js";

const server = new McpServer(
  { name: "ga4", version: "0.1.0" },
  {
    instructions:
      "Google Analytics 4 access for traffic analysis and site optimization. Call ga4_list_properties first to " +
      "get the numeric propertyId every other tool needs — a G-XXXXXXX measurement id will not work. Never invent " +
      "dimension or metric names: they are camelCase API names that differ from the GA4 UI labels and vary by " +
      "property, so confirm them with ga4_get_metadata (and ga4_check_compatibility for an unfamiliar " +
      "combination). GA4's data is only complete through yesterday, so date defaults already back off one day. " +
      "For analysis, prefer the purpose-built tools over assembling the same thing from ga4_run_report: " +
      "ga4_traffic_overview to open any performance question, ga4_compare_periods for what changed and why, " +
      "ga4_top_pages, ga4_acquisition, ga4_landing_page_opportunities for what to fix, ga4_funnel for drop-off, " +
      "ga4_realtime for right now. When a report is empty or a conversion metric reads zero, ga4_describe_property " +
      "usually explains it (no key events configured, short data retention, missing data stream).",
  },
);

registerPropertyTools(server);
registerMetadataTools(server);
registerReportTool(server);
registerRealtimeTool(server);
registerInsightTools(server);
registerFunnelTool(server);
registerAdminTools(server);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  // stdout is the MCP transport; diagnostics must go to stderr.
  console.error(`ga4-mcp failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
