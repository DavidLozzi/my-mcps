import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { accountsPath, loadAccounts } from "../config.js";
import { withClient } from "../imap.js";
import { describeError } from "../lib/errors.js";
import { guard, ok } from "../lib/tool.js";

export function registerAccountTools(server: McpServer): void {
  server.registerTool(
    "email_list_accounts",
    {
      title: "List mail accounts",
      description:
        "The Zoho mail accounts this server can use — name, address, server hosts, and which is the default. Every " +
        "other tool takes an optional `account` (name or address); omitting it uses the default. Pass check:true to " +
        "test that each account can actually log in over IMAP.",
      inputSchema: {
        check: z.boolean().default(false).describe("Log in to each account and report whether it works."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const accounts = loadAccounts();
      const defaultName = (accounts.find((a) => a.default) ?? accounts[0]).name;
      const lines = await Promise.all(
        accounts.map(async (a) => {
          let status = "";
          if (args.check) {
            try {
              await withClient(a, (c) => c.noop());
              status = "  login ok";
            } catch (err) {
              status = `  LOGIN FAILED: ${describeError(err)}`;
            }
          }
          const aliases = a.aliases?.length ? `  aliases: ${a.aliases.join(", ")}` : "";
          return `${a.name}${a.name === defaultName ? " (default)" : ""}  <${a.email}>  imap ${a.imapHost}  smtp ${a.smtpHost}${aliases}${status}`;
        }),
      );
      return ok(`${lines.join("\n")}\n\nConfigured in ${accountsPath()}. Add another with \`npm run auth\`.`);
    }),
  );
}
