#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSiteTools } from "./tools/sites.js";
import { registerSearchAnalyticsTool } from "./tools/search-analytics.js";
import { registerSitemapTools } from "./tools/sitemaps.js";
import { registerUrlInspectionTool } from "./tools/url-inspection.js";
import { registerSeoInsightTools } from "./tools/seo-insights.js";

const server = new McpServer(
  { name: "gsc", version: "0.1.0" },
  {
    instructions:
      "Google Search Console access for SEO and indexing work. Call gsc_list_sites first to get exact " +
      "siteUrl values — every other tool needs one verbatim. Search Console data lags 2-3 days, so date " +
      "defaults already back off from today. For analysis, prefer the purpose-built tools " +
      "(gsc_striking_distance, gsc_low_ctr_pages, gsc_compare_periods, gsc_find_cannibalization) over " +
      "assembling the same thing from raw gsc_search_analytics calls.",
  },
);

registerSiteTools(server);
registerSearchAnalyticsTool(server);
registerUrlInspectionTool(server);
registerSitemapTools(server);
registerSeoInsightTools(server);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  // stdout is the MCP transport; diagnostics must go to stderr.
  console.error(`gsc-mcp failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
