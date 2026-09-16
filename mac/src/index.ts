#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerReminderTools } from "./tools/reminders.js";

const server = new McpServer(
  { name: "mac", version: "0.1.0" },
  {
    instructions:
      "Access to the user's own Mac apps, starting with Reminders, which syncs to their iPhone and other devices " +
      "— so changes are real and visible everywhere. Find before you act: reminders_list returns the ids every " +
      "write tool needs; never guess one. Dates are the Mac's local time: YYYY-MM-DD for all-day, " +
      "YYYY-MM-DDTHH:MM for a specific time. For \"what do I need to do\", call reminders_list with " +
      "due=today_and_overdue. Prefer reminders_complete over reminders_delete for finished items, and only delete " +
      "when asked. List names can repeat across accounts; reminders_list_lists shows ids to disambiguate.",
  },
);

registerReminderTools(server);

async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("this server only runs on macOS");
  }
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  // stdout is the MCP transport; diagnostics must go to stderr.
  console.error(`mac-mcp failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
