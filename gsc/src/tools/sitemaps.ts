import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { deleteSitemap, getSitemap, listSitemaps, submitSitemap, type Sitemap } from "../client.js";
import { guard, ok } from "../lib/tool.js";
import { shortenUrl, table } from "../lib/format.js";

const siteUrlSchema = z
  .string()
  .describe("Property, exactly as returned by gsc_list_sites.");

const feedpathSchema = z
  .string()
  .url()
  .describe(
    "Full absolute URL of the sitemap, e.g. https://example.com/sitemap.xml — not a relative path.",
  );

function describeSitemap(s: Sitemap): string {
  const lines = [
    `path:           ${s.path}`,
    `type:           ${s.type ?? "unknown"}`,
    `sitemap index:  ${s.isSitemapsIndex ? "yes" : "no"}`,
    `pending:        ${s.isPending ? "yes" : "no"}`,
    `last submitted: ${s.lastSubmitted ?? "never"}`,
    `last downloaded:${s.lastDownloaded ?? "never"}`,
    `errors:         ${s.errors ?? "0"}`,
    `warnings:       ${s.warnings ?? "0"}`,
  ];

  if (s.contents?.length) {
    lines.push("", "contents:");
    for (const c of s.contents) {
      lines.push(`  ${c.type}: ${c.submitted ?? "0"} submitted, ${c.indexed ?? "0"} indexed`);
    }
  }

  return lines.join("\n");
}

export function registerSitemapTools(server: McpServer): void {
  server.registerTool(
    "gsc_list_sitemaps",
    {
      title: "List sitemaps",
      description:
        "List sitemaps submitted for a property, with submission time, download time, and error/warning counts. " +
        "Use this to confirm Google is still fetching your sitemap and to spot sitemaps erroring silently. " +
        "For the per-type submitted/indexed breakdown of one sitemap, use gsc_get_sitemap.",
      inputSchema: {
        siteUrl: siteUrlSchema,
        sitemapIndex: z
          .string()
          .url()
          .optional()
          .describe(
            "Full URL of a sitemap index. When set, lists the child sitemaps inside that index instead of the property's top-level sitemaps.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ siteUrl, sitemapIndex }) => {
      const sitemaps = await listSitemaps(siteUrl, sitemapIndex);

      if (sitemaps.length === 0) {
        return ok(
          `No sitemaps submitted for ${siteUrl}. Submit one with gsc_submit_sitemap to help Google discover pages faster.`,
        );
      }

      return ok(
        table(
          ["path", "type", "submitted", "downloaded", "errors", "warnings", "pending"],
          sitemaps.map((s) => [
            shortenUrl(s.path, 60),
            s.type ?? "-",
            s.lastSubmitted?.slice(0, 10) ?? "never",
            s.lastDownloaded?.slice(0, 10) ?? "never",
            s.errors ?? "0",
            s.warnings ?? "0",
            s.isPending ? "yes" : "no",
          ]),
        ),
      );
    }),
  );

  server.registerTool(
    "gsc_get_sitemap",
    {
      title: "Get one sitemap",
      description:
        "Full detail for a single submitted sitemap, including the per-content-type submitted vs indexed counts " +
        "that reveal how much of the sitemap Google actually indexed. Use gsc_list_sitemaps first to find the exact path.",
      inputSchema: { siteUrl: siteUrlSchema, feedpath: feedpathSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ siteUrl, feedpath }) => ok(describeSitemap(await getSitemap(siteUrl, feedpath)))),
  );

  server.registerTool(
    "gsc_submit_sitemap",
    {
      title: "Submit a sitemap",
      description:
        "Submit or resubmit a sitemap to Search Console, prompting Google to re-fetch it. Safe to repeat — " +
        "resubmitting an already-submitted sitemap just refreshes it. Does not force reindexing of the URLs inside.",
      inputSchema: { siteUrl: siteUrlSchema, feedpath: feedpathSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ siteUrl, feedpath }) => {
      await submitSitemap(siteUrl, feedpath);
      return ok(
        `Submitted ${feedpath} for ${siteUrl}. Google fetches asynchronously — check gsc_get_sitemap in a few hours for the download time and error counts.`,
      );
    }),
  );

  server.registerTool(
    "gsc_delete_sitemap",
    {
      title: "Delete a sitemap",
      description:
        "Remove a sitemap from Search Console. This unsubmits it — Google stops using it for discovery. " +
        "It does not delete the file from the server, and it does not deindex the URLs it contained.",
      inputSchema: { siteUrl: siteUrlSchema, feedpath: feedpathSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    guard(async ({ siteUrl, feedpath }) => {
      await deleteSitemap(siteUrl, feedpath);
      return ok(`Removed ${feedpath} from ${siteUrl}.`);
    }),
  );
}
