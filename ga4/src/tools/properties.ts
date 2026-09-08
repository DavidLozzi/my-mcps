import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listProperties } from "../client.js";
import { guard, ok } from "../lib/tool.js";
import { table } from "../lib/format.js";

export function registerPropertyTools(server: McpServer): void {
  server.registerTool(
    "ga4_list_properties",
    {
      title: "List Google Analytics properties",
      description:
        "Every Google Analytics account and GA4 property this login can reach, with the numeric property id " +
        "each other tool needs. Call this first — the id shown in the GA4 UI URL and the G-XXXXXXX measurement " +
        "id are different things, and guessing produces a 403.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async () => {
      const accounts = await listProperties();
      const rows = accounts.flatMap((account) =>
        (account.propertySummaries ?? []).map((property) => [
          (property.property ?? "").replace(/^properties\//, ""),
          property.displayName ?? "(unnamed)",
          account.displayName ?? "(unnamed account)",
          (property.propertyType ?? "").replace(/^PROPERTY_TYPE_/, ""),
        ]),
      );

      if (rows.length === 0) {
        return ok(
          "This Google account has no Analytics properties. Either the wrong account was used during " +
            "`npm run auth`, or it has not been granted access to any property.",
        );
      }

      return ok(
        `${rows.length} propert${rows.length === 1 ? "y" : "ies"} across ${accounts.length} account${accounts.length === 1 ? "" : "s"}\n\n` +
          table(["propertyId", "property", "account", "type"], rows) +
          `\n\nPass propertyId to any other ga4_* tool.`,
      );
    }),
  );
}
