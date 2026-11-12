#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeAll } from "./imap.js";
import { registerAccountTools } from "./tools/accounts.js";
import { registerComposeTools } from "./tools/compose.js";
import { registerFolderTools } from "./tools/folders.js";
import { registerMessageTools } from "./tools/messages.js";
import { registerOrganizeTools } from "./tools/organize.js";

const server = new McpServer(
  { name: "zoho", version: "0.1.0" },
  {
    instructions:
      "The user's own Zoho Mail, over IMAP and SMTP. Changes are real: they show up in Zoho's web and phone apps, " +
      "and sent mail cannot be recalled. Find before you act — email_list, email_search, and email_get_thread " +
      "return the ids every other tool needs; never invent one, and use the new ids a move returns. Start a " +
      "'what's in my email' question with email_mailbox_summary, then email_list with unreadOnly. Read with " +
      "email_get (it does not mark read unless asked). Before email_send, email_reply, email_forward, or " +
      "email_send_draft, show the user the recipients and text and get a yes — or pass saveAsDraft:true so they " +
      "can review it in Zoho. 'Delete' means email_trash; only use email_delete_permanently or email_empty_folder " +
      "when the user explicitly wants mail gone for good. email_bulk_action previews first and changes nothing " +
      "until called again with confirm:true — show the preview to the user before confirming. Dates are " +
      "YYYY-MM-DD in local time. With several accounts, email_list_accounts names them; pass account to choose.",
  },
);

registerAccountTools(server);
registerFolderTools(server);
registerMessageTools(server);
registerOrganizeTools(server);
registerComposeTools(server);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  const shutdown = () => {
    closeAll().finally(() => process.exit(0));
  };
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err: unknown) => {
  // stdout is the MCP transport; diagnostics must go to stderr.
  console.error(`zoho-mcp failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
