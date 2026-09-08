/**
 * End-to-end exercise of the analysis tools against a stub Search Console API
 * serving synthetic rows with known-correct answers.
 */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const SITE = "https://example.com/";

// Deterministic fixtures. Each row is designed so the expected verdict is obvious.
const QUERY_ROWS = [
  // striking distance: position 5-20, impressions >= 50
  { keys: ["blue widgets"], clicks: 12, impressions: 900, ctr: 0.0133, position: 8.4 },
  { keys: ["widget pricing"], clicks: 5, impressions: 400, ctr: 0.0125, position: 14.2 },
  { keys: ["cheap widgets"], clicks: 2, impressions: 60, ctr: 0.0333, position: 19.8 },
  // too good already (pos < 5) -> excluded
  { keys: ["acme widgets"], clicks: 300, impressions: 1000, ctr: 0.3, position: 1.2 },
  // too deep (pos > 20) -> excluded
  { keys: ["widget wholesale"], clicks: 1, impressions: 500, ctr: 0.002, position: 44.0 },
  // too few impressions -> excluded
  { keys: ["obscure widget"], clicks: 0, impressions: 10, ctr: 0, position: 9.0 },
];

// Position-3 cohort: five rows at ~28% CTR establish the site baseline,
// one outlier at 2% must be flagged.
const CTR_ROWS = [
  { keys: ["https://example.com/a"], clicks: 280, impressions: 1000, ctr: 0.28, position: 3.0 },
  { keys: ["https://example.com/b"], clicks: 270, impressions: 1000, ctr: 0.27, position: 3.1 },
  { keys: ["https://example.com/c"], clicks: 290, impressions: 1000, ctr: 0.29, position: 2.9 },
  { keys: ["https://example.com/d"], clicks: 285, impressions: 1000, ctr: 0.285, position: 3.0 },
  { keys: ["https://example.com/e"], clicks: 275, impressions: 1000, ctr: 0.275, position: 3.2 },
  { keys: ["https://example.com/BAD-TITLE"], clicks: 20, impressions: 1000, ctr: 0.02, position: 3.0 },
];

const CANNIBAL_ROWS = [
  // one query, three pages splitting clicks -> flagged
  { keys: ["widget guide", "https://example.com/guide"], clicks: 40, impressions: 500, ctr: 0.08, position: 6.0 },
  { keys: ["widget guide", "https://example.com/blog/guide"], clicks: 35, impressions: 450, ctr: 0.077, position: 8.0 },
  { keys: ["widget guide", "https://example.com/docs/guide"], clicks: 30, impressions: 400, ctr: 0.075, position: 11.0 },
  // one query, one dominant page (95% of clicks) -> NOT flagged
  { keys: ["acme widgets", "https://example.com/"], clicks: 190, impressions: 800, ctr: 0.2375, position: 1.1 },
  { keys: ["acme widgets", "https://example.com/about"], clicks: 10, impressions: 200, ctr: 0.05, position: 18.0 },
];

const COMPARE_CURRENT = [
  { keys: ["https://example.com/dropped"], clicks: 10, impressions: 500, ctr: 0.02, position: 15.0 },
  { keys: ["https://example.com/grew"], clicks: 200, impressions: 1000, ctr: 0.2, position: 2.0 },
  { keys: ["https://example.com/brand-new"], clicks: 50, impressions: 300, ctr: 0.166, position: 5.0 },
];
const COMPARE_BASELINE = [
  { keys: ["https://example.com/dropped"], clicks: 150, impressions: 900, ctr: 0.166, position: 4.0 },
  { keys: ["https://example.com/grew"], clicks: 100, impressions: 800, ctr: 0.125, position: 4.0 },
];

// Which fixture set the stub serves; flipped by the harness before each check.
let mode = "default";

const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://localhost");
    const json = (obj) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(obj));

    if (url.pathname.startsWith("/mode/")) {
      mode = url.pathname.slice("/mode/".length);
      return json({ mode });
    }

    if (url.pathname === "/webmasters/v3/sites") {
      return json({ siteEntry: [{ siteUrl: SITE, permissionLevel: "siteOwner" }] });
    }

    if (url.pathname.includes("/searchAnalytics/query")) {
      const q = JSON.parse(body || "{}");
      const dims = q.dimensions ?? [];
      // The client pages until a short page comes back, so serve the fixture
      // only on the first page.
      if ((q.startRow ?? 0) > 0) return json({ rows: [] });

      if (mode === "compare") {
        // The two periods are distinguished by their start date; the baseline
        // window is the earlier one.
        return json({ rows: q.startDate < "2026-08-09" ? COMPARE_BASELINE : COMPARE_CURRENT });
      }
      if (dims.length === 2 && dims[0] === "QUERY") return json({ rows: CANNIBAL_ROWS });
      if (dims[0] === "PAGE") return json({ rows: CTR_ROWS });
      if (dims[0] === "QUERY") return json({ rows: QUERY_ROWS });
      return json({ rows: [] });
    }

    res.writeHead(404).end("{}");
  });
});

await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const port = stub.address().port;

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  env: {
    ...process.env,
    GSC_API_BASE: `http://127.0.0.1:${port}`,
    GSC_ACCESS_TOKEN: "stub-token",
  },
});

const client = new Client({ name: "e2e", version: "1.0.0" });
await client.connect(transport);

let failures = 0;
async function check(label, name, args, assertions) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content[0].text;
  console.log(`\n${"=".repeat(72)}\n${label}\n${"=".repeat(72)}`);
  console.log(text);
  for (const [desc, fn] of assertions) {
    const passed = fn(text, res);
    if (!passed) failures++;
    console.log(`  ${passed ? "PASS" : "FAIL"}: ${desc}`);
  }
}

await check("gsc_list_sites", "gsc_list_sites", {}, [
  ["lists the stub property", (t) => t.includes(SITE) && t.includes("siteOwner")],
]);

await check("gsc_striking_distance", "gsc_striking_distance", { siteUrl: SITE, includePages: false }, [
  ["includes pos-8.4 query", (t) => t.includes("blue widgets")],
  ["includes pos-14.2 query", (t) => t.includes("widget pricing")],
  ["excludes pos-1.2 (already ranking)", (t) => !t.includes("acme widgets")],
  ["excludes pos-44 (too deep)", (t) => !t.includes("widget wholesale")],
  ["excludes 10-impression noise", (t) => !t.includes("obscure widget")],
  ["sorted by impressions desc", (t) => t.indexOf("blue widgets") < t.indexOf("widget pricing")],
]);

await check("gsc_low_ctr_pages", "gsc_low_ctr_pages", { siteUrl: SITE, dimension: "PAGE" }, [
  ["flags the 2%-CTR outlier", (t) => t.includes("BAD-TITLE")],
  ["does not flag the ~28% cohort", (t) => !t.includes("example.com/a ")],
  // Median of the six position-3 CTRs is 27.75%, derived from the site's own
  // rows rather than the fallback curve.
  ["uses the site-derived baseline (27.75%)", (t) => /BAD-TITLE.*\s27\.75%\s/.test(t)],
  ["no curve footnote when no row used the curve", (t) => !t.includes("generic CTR curve")],
  ["lost clicks = 1000 * (0.2775 - 0.02) = 258", (t) => /BAD-TITLE.*\s258\s/.test(t)],
]);

await check("gsc_find_cannibalization", "gsc_find_cannibalization", { siteUrl: SITE }, [
  ["flags the 3-way split", (t) => t.includes("widget guide")],
  ["lists all three competing pages", (t) => t.includes("/guide") && t.includes("/blog/guide") && t.includes("/docs/guide")],
  ["does not flag the dominant-winner query", (t) => !t.includes('"acme widgets"')],
]);

await fetch(`http://127.0.0.1:${port}/mode/compare`);
await check(
  "gsc_compare_periods",
  "gsc_compare_periods",
  { siteUrl: SITE, dimension: "PAGE", range: "last_28_days" },
  [
    ["reports the -140 click loss", (t) => t.includes("/dropped") && t.includes("(-140)")],
    ["reports the +100 click gain", (t) => t.includes("/grew") && t.includes("(+100)")],
    ["marks the page with no baseline as new", (t) => /brand-new.*\bnew\b/.test(t)],
    ["separates losses from gains", (t) => t.includes("TOP LOSSES") && t.includes("TOP GAINS")],
    ["losses listed before gains", (t) => t.indexOf("TOP LOSSES") < t.indexOf("TOP GAINS")],
    ["site totals reflect 250 -> 260 clicks", (t) => t.includes("250 -> 260")],
    ["position improvement shown as positive", (t) => /grew.*4\.0 -> 2\.0 \(\+2\.0\)/.test(t)],
  ],
);

console.log(`\n${"=".repeat(72)}`);
console.log(failures === 0 ? `ALL ASSERTIONS PASSED` : `${failures} ASSERTION(S) FAILED`);

await client.close();
stub.close();
process.exit(failures === 0 ? 0 : 1);
