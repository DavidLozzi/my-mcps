#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAccountTools } from "./tools/accounts.js";
import { registerInventoryTools } from "./tools/inventory.js";
import { registerReportTools } from "./tools/reports.js";
import { registerInsightTools } from "./tools/insights.js";

const server = new McpServer(
  { name: "adsense", version: "0.1.0" },
  {
    instructions:
      "Google AdSense access for earnings analysis and ad yield optimization. Every tool picks the AdSense " +
      "account automatically when the login has only one; otherwise pass account as pub-…. Start any 'how is " +
      "AdSense doing' question with adsense_earnings_overview. Use adsense_compare_periods for what changed (it " +
      "splits the change into traffic and RPM effects), adsense_top_pages for which pages earn, " +
      "adsense_rpm_opportunities for pages that under-earn their traffic, adsense_ad_units for manual ad unit " +
      "performance, and adsense_account_health first when earnings drop suddenly or ads stop serving. " +
      "adsense_run_report is the escape hatch; its field names are UPPER_SNAKE_CASE enums listed by " +
      "adsense_report_fields, never guessed. Today's estimated earnings are partial, so multi-day ranges end " +
      "yesterday by default. All tools are read-only.",
  },
);

registerAccountTools(server);
registerInventoryTools(server);
registerReportTools(server);
registerInsightTools(server);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  // stdout is the MCP transport; diagnostics must go to stderr.
  console.error(`adsense-mcp failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
