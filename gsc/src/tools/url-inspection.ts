import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inspectUrl, type InspectionResult } from "../client.js";
import { guard, ok } from "../lib/tool.js";

/**
 * The raw inspection response is deeply nested and mostly empty. Condense it to
 * the fields that actually drive an indexing decision.
 */
function condense(url: string, result: InspectionResult): string {
  const index = result.indexStatusResult;
  const lines: string[] = [`URL: ${url}`];

  if (!index) {
    lines.push("", "No index status returned — the URL may be outside this property.");
    return lines.join("\n");
  }

  lines.push(
    "",
    "INDEXING",
    `  verdict:         ${index.verdict ?? "unknown"}`,
    `  coverage:        ${index.coverageState ?? "unknown"}`,
    `  robots.txt:      ${index.robotsTxtState ?? "unknown"}`,
    `  indexing allowed:${index.indexingState ?? "unknown"}`,
    `  page fetch:      ${index.pageFetchState ?? "unknown"}`,
    `  crawled as:      ${index.crawledAs ?? "unknown"}`,
    `  last crawl:      ${index.lastCrawlTime ?? "never crawled"}`,
  );

  lines.push(
    "",
    "CANONICAL",
    `  google-selected: ${index.googleCanonical ?? "none"}`,
    `  user-declared:   ${index.userCanonical ?? "none"}`,
  );

  // A canonical mismatch is the usual reason a page "looks indexed" but never
  // ranks, so call it out rather than leaving it to be spotted in the fields.
  if (
    index.googleCanonical &&
    index.userCanonical &&
    index.googleCanonical !== index.userCanonical
  ) {
    lines.push(
      `  MISMATCH: Google ignored the declared canonical and indexed ${index.googleCanonical} instead.`,
    );
  }

  lines.push(
    "",
    "DISCOVERY",
    `  in sitemaps:     ${index.sitemap?.length ? index.sitemap.join(", ") : "none"}`,
    `  referring urls:  ${index.referringUrls?.length ? index.referringUrls.slice(0, 5).join(", ") : "none reported"}`,
  );

  if (result.mobileUsabilityResult) {
    const mobile = result.mobileUsabilityResult;
    lines.push("", "MOBILE USABILITY", `  verdict: ${mobile.verdict ?? "unknown"}`);
    for (const issue of mobile.issues ?? []) {
      lines.push(`  [${issue.severity ?? "?"}] ${issue.issueType ?? ""}: ${issue.message ?? ""}`);
    }
  }

  if (result.richResultsResult) {
    const rich = result.richResultsResult;
    lines.push("", "RICH RESULTS", `  verdict: ${rich.verdict ?? "unknown"}`);
    for (const detected of rich.detectedItems ?? []) {
      const issues = (detected.items ?? []).flatMap((i) => i.issues ?? []);
      lines.push(
        `  ${detected.richResultType ?? "unknown type"}: ${detected.items?.length ?? 0} item(s)` +
          (issues.length ? `, ${issues.length} issue(s)` : ""),
      );
      for (const issue of issues.slice(0, 5)) {
        lines.push(`    [${issue.severity ?? "?"}] ${issue.issueMessage ?? ""}`);
      }
    }
  }

  if (result.ampResult?.verdict) {
    lines.push("", "AMP", `  verdict: ${result.ampResult.verdict}`);
  }

  if (result.inspectionResultLink) {
    lines.push("", `Full report: ${result.inspectionResultLink}`);
  }

  return lines.join("\n");
}

export function registerUrlInspectionTool(server: McpServer): void {
  server.registerTool(
    "gsc_inspect_url",
    {
      title: "Inspect a URL's index status",
      description:
        "Google's index status for one specific URL: whether it is indexed, why not, when it was last crawled, " +
        "which canonical Google chose, mobile usability, and rich-result validity. This is the tool for " +
        "diagnosing why a single page is missing from search. It reports current state only — it cannot " +
        "request indexing. Quota is roughly 2000 inspections/day per property.",
      inputSchema: {
        siteUrl: z
          .string()
          .describe("The property that owns this URL, exactly as returned by gsc_list_sites."),
        inspectionUrl: z
          .string()
          .url()
          .describe("Full absolute URL to inspect. Must live under siteUrl."),
        languageCode: z
          .string()
          .optional()
          .describe("BCP-47 code for translated issue messages, e.g. en-US. Defaults to English."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ siteUrl, inspectionUrl, languageCode }) =>
      ok(condense(inspectionUrl, await inspectUrl(siteUrl, inspectionUrl, languageCode))),
    ),
  );
}
