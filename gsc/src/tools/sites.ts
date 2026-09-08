import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listSites } from "../client.js";
import { guard, ok } from "../lib/tool.js";
import { table } from "../lib/format.js";

export function registerSiteTools(server: McpServer): void {
  server.registerTool(
    "gsc_list_sites",
    {
      title: "List Search Console properties",
      description:
        "List every Search Console property this Google account can access, with its permission level. " +
        "Returns the exact siteUrl strings that all other gsc_* tools require — call this first when the " +
        "property is unknown, since URL-prefix properties need a trailing slash and domain properties use " +
        "the sc-domain: prefix. Does not return any traffic data; use gsc_search_analytics for that.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async () => {
      const sites = await listSites();

      if (sites.length === 0) {
        return ok(
          "This Google account has no Search Console properties. Add and verify a property at https://search.google.com/search-console.",
        );
      }

      return ok(
        table(
          ["siteUrl", "permission"],
          sites.map((s) => [s.siteUrl, s.permissionLevel]),
        ),
      );
    }),
  );
}
