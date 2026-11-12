/**
 * End-to-end exercise of the tools against a stub AdSense API serving
 * synthetic rows with known-correct answers. The stub echoes back whatever
 * metrics the server asked for, in the order it asked, so the assertions test
 * real column handling rather than a hardcoded response shape.
 */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const ACCOUNT = "pub-1111111111111111";

const METRIC_TYPES = {
  ESTIMATED_EARNINGS: "METRIC_CURRENCY",
  PAGE_VIEWS_RPM: "METRIC_CURRENCY",
  PAGE_VIEWS: "METRIC_TALLY",
  IMPRESSIONS: "METRIC_TALLY",
  CLICKS: "METRIC_TALLY",
  PAGE_VIEWS_CTR: "METRIC_RATIO",
};

// ---------------------------------------------------------------------------
// Fixtures. Each is designed so the expected verdict is arithmetic, not taste.
// ---------------------------------------------------------------------------

const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const shift = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return iso(d);
};
// Last 28 days end yesterday, so the current window starts 28 days ago.
const CURRENT_START = shift(-28);

// Every day has 100 page views. Inside the last 28 days (and today) a day earns
// $1.00 (RPM $10); before that $0.50 (RPM $5). So 28d vs prior 28d is $28 vs
// $14: a +$14 change that is entirely yield, with zero traffic effect.
const dayRow = (date) => {
  const current = date >= CURRENT_START;
  return { ESTIMATED_EARNINGS: current ? 1 : 0.5, PAGE_VIEWS: 100, IMPRESSIONS: 200, CLICKS: 2 };
};

// Page RPMs among pages with >= 200 views: 10,10,10,10,10,2,0 -> median 10,
// cutoff 5. /low gaps 1000 * (10-2)/1000 = $8; /noads 500 * 10/1000 = $5.
// /tiny has too few views to count.
const PAGES_CURRENT = [
  ...["/a", "/b", "/c", "/d", "/e"].map((p) => ({ key: p, ESTIMATED_EARNINGS: 10, PAGE_VIEWS: 1000, IMPRESSIONS: 3000, CLICKS: 10 })),
  { key: "/low", ESTIMATED_EARNINGS: 2, PAGE_VIEWS: 1000, IMPRESSIONS: 900, CLICKS: 1 },
  { key: "/noads", ESTIMATED_EARNINGS: 0, PAGE_VIEWS: 500, IMPRESSIONS: 0, CLICKS: 0 },
  { key: "/tiny", ESTIMATED_EARNINGS: 0, PAGE_VIEWS: 10, IMPRESSIONS: 0, CLICKS: 0 },
].map((p) => ({ ...p, key: `https://site.example${p.key}` }));

// Against the current pages: /low lost $4, /gone lost $3, /a gained $5.
const PAGES_BASELINE = [
  { key: "/a", ESTIMATED_EARNINGS: 5, PAGE_VIEWS: 900 },
  ...["/b", "/c", "/d", "/e"].map((p) => ({ key: p, ESTIMATED_EARNINGS: 10, PAGE_VIEWS: 1000 })),
  { key: "/low", ESTIMATED_EARNINGS: 6, PAGE_VIEWS: 1000 },
  { key: "/gone", ESTIMATED_EARNINGS: 3, PAGE_VIEWS: 400 },
].map((p) => ({ ...p, key: `https://site.example${p.key}` }));

const AD_UNIT_PERF = [{ key: "ca-pub-1111111111111111:100", ESTIMATED_EARNINGS: 12.5, IMPRESSIONS: 5000, CLICKS: 50 }];

const DOMAINS = [
  { key: "timeline.site.example", ESTIMATED_EARNINGS: 20, PAGE_VIEWS: 2000 },
  { key: "site.example", ESTIMATED_EARNINGS: 8, PAGE_VIEWS: 800 },
];

function datesBetween(start, end) {
  const out = [];
  const d = new Date(`${start}T00:00:00`);
  while (iso(d) <= end) {
    out.push(iso(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

const requests = [];

function report(url) {
  const q = url.searchParams;
  const metrics = q.getAll("metrics");
  const dims = q.getAll("dimensions");
  const date = (p) =>
    `${q.get(`${p}.year`)}-${q.get(`${p}.month`).padStart(2, "0")}-${q.get(`${p}.day`).padStart(2, "0")}`;
  const start = date("startDate");
  const end = date("endDate");
  requests.push({ metrics, dims, start, end, filters: q.getAll("filters"), orderBy: q.getAll("orderBy") });

  if (metrics.includes("BOGUS")) {
    return [400, { error: { message: "Invalid metric: BOGUS", status: "INVALID_ARGUMENT" } }];
  }

  let rows;
  const dim = dims[0];
  if (dim === "DATE") {
    rows = datesBetween(start, end).map((d) => ({ key: d, ...dayRow(d) }));
  } else if (dim === "PAGE_URL") {
    rows = end >= CURRENT_START ? PAGES_CURRENT : PAGES_BASELINE;
    const contains = q.getAll("filters").find((f) => f.startsWith("PAGE_URL=@"));
    if (contains) rows = rows.filter((r) => r.key.includes(contains.slice("PAGE_URL=@".length)));
  } else if (dim === "AD_UNIT_ID") {
    rows = AD_UNIT_PERF;
  } else if (dim === "DOMAIN_NAME") {
    rows = DOMAINS;
  } else if (!dim) {
    const days = datesBetween(start, end).map(dayRow);
    const sum = {};
    for (const m of metrics) sum[m] = days.reduce((s, d) => s + (d[m] ?? 0), 0);
    rows = [sum];
  } else {
    rows = [];
  }

  const sortKey = q.getAll("orderBy")[0];
  if (sortKey && sortKey.slice(1) in METRIC_TYPES) {
    const m = sortKey.slice(1);
    const dir = sortKey[0] === "-" ? -1 : 1;
    rows = [...rows].sort((a, b) => dir * ((a[m] ?? 0) - (b[m] ?? 0)));
  }
  const limit = Number(q.get("limit") ?? 100000);
  const shown = rows.slice(0, limit);

  const headers = [
    ...dims.map((name) => ({ name, type: "DIMENSION" })),
    ...metrics.map((name) => ({
      name,
      type: METRIC_TYPES[name] ?? "METRIC_TALLY",
      ...(METRIC_TYPES[name] === "METRIC_CURRENCY" ? { currencyCode: "USD" } : {}),
    })),
  ];
  const cellValue = (row, m) =>
    m === "PAGE_VIEWS_RPM" ? (row.PAGE_VIEWS ? (row.ESTIMATED_EARNINGS / row.PAGE_VIEWS) * 1000 : 0) : (row[m] ?? 0);
  const toCells = (row) => [
    ...dims.map(() => ({ value: row.key })),
    ...metrics.map((m) => ({ value: String(cellValue(row, m)) })),
  ];
  const totalsRow = {};
  for (const m of metrics) totalsRow[m] = rows.reduce((s, r) => s + (r[m] ?? 0), 0);
  totalsRow.PAGE_VIEWS = rows.reduce((s, r) => s + (r.PAGE_VIEWS ?? 0), 0);
  totalsRow.ESTIMATED_EARNINGS = rows.reduce((s, r) => s + (r.ESTIMATED_EARNINGS ?? 0), 0);

  return [
    200,
    {
      headers,
      rows: shown.map((r) => ({ cells: toCells(r) })),
      totals: { cells: [...dims.map(() => ({})), ...metrics.map((m) => ({ value: String(cellValue(totalsRow, m)) }))] },
      totalMatchedRows: String(rows.length),
    },
  ];
}

const stub = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const json = (status, obj) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(obj));
  const p = url.pathname;

  if (p === "/v2/accounts") {
    return json(200, {
      accounts: [{ name: `accounts/${ACCOUNT}`, displayName: "Test Publisher", state: "READY", timeZone: { id: "America/New_York" } }],
    });
  }
  if (p === `/v2/accounts/${ACCOUNT}/reports:generate`) return json(...report(url));
  if (p === `/v2/accounts/${ACCOUNT}/adclients`) {
    return json(200, { adClients: [{ name: `accounts/${ACCOUNT}/adclients/ca-${ACCOUNT}`, productCode: "AFC", state: "READY" }] });
  }
  if (p === `/v2/accounts/${ACCOUNT}/adclients/ca-${ACCOUNT}/adunits`) {
    return json(200, {
      adUnits: [
        { displayName: "Sidebar", state: "ACTIVE", reportingDimensionId: "ca-pub-1111111111111111:100", contentAdsSettings: { type: "DISPLAY", size: "300x250" } },
        { displayName: "Footer", state: "ACTIVE", reportingDimensionId: "ca-pub-1111111111111111:200", contentAdsSettings: { type: "DISPLAY", size: "728x90" } },
        { displayName: "Old", state: "ARCHIVED", reportingDimensionId: "ca-pub-1111111111111111:300" },
      ],
    });
  }
  if (p === `/v2/accounts/${ACCOUNT}/sites`) {
    return json(200, {
      sites: [
        { domain: "site.example", state: "READY", autoAdsEnabled: true },
        { domain: "new.example", state: "GETTING_READY", autoAdsEnabled: false },
      ],
    });
  }
  if (p === `/v2/accounts/${ACCOUNT}/alerts`) {
    return json(200, { alerts: [{ severity: "INFO", type: "TIP", message: "Try anchor ads" }, { severity: "SEVERE", type: "ADS_TXT", message: "ads.txt missing on new.example" }] });
  }
  if (p === `/v2/accounts/${ACCOUNT}/policyIssues`) {
    return json(200, {
      policyIssues: [
        { uri: "https://site.example/bad", action: "AD_SERVING_RESTRICTED", adRequestCount: "1200", policyTopics: [{ topic: "Valuable inventory", mustFix: true }], firstDetectedDate: { year: 2026, month: 10, day: 3 } },
      ],
    });
  }
  if (p === `/v2/accounts/${ACCOUNT}/payments`) {
    return json(200, {
      payments: [
        { name: `accounts/${ACCOUNT}/payments/unpaid`, amount: "$42.10" },
        { name: `accounts/${ACCOUNT}/payments/2026-09-21`, amount: "$105.00", date: { year: 2026, month: 9, day: 21 } },
        { name: `accounts/${ACCOUNT}/payments/2026-10-21`, amount: "$118.20", date: { year: 2026, month: 10, day: 21 } },
      ],
    });
  }
  json(404, { error: { message: `stub has no route for ${p}` } });
});

await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${stub.address().port}`;

const env = { ...process.env, ADSENSE_API_BASE: base, ADSENSE_ACCESS_TOKEN: "stub-token" };
const client = new Client({ name: "e2e", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: [SERVER], env }));

let failures = 0;
const expect = (desc, condition) => {
  if (!condition) failures++;
  console.log(`  ${condition ? "PASS" : "FAIL"}: ${desc}`);
};
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { text: res.content[0].text, isError: res.isError === true };
};
const lineWith = (text, needle) => text.split("\n").find((l) => l.includes(needle)) ?? "";

console.log("OVERVIEW:");
const overview = await call("adsense_earnings_overview");
expect("succeeds without an explicit account", !overview.isError);
expect("yesterday earned $1.00", lineWith(overview.text, "Yesterday").includes("$1.00"));
expect("last 7 days earned $7.00", lineWith(overview.text, "Last 7 days").includes("$7.00"));
expect("last 28 days doubled ($28.00, +100.0%)", /\$28\.00\s+\+100\.0%/.test(lineWith(overview.text, "Last 28 days")));
expect("page RPM recomputed from sums ($10.00)", lineWith(overview.text, "Last 28 days").includes("$10.00"));
expect("change attributed to yield, not traffic", lineWith(overview.text, "yield effect").includes("+$14.00") && lineWith(overview.text, "traffic effect").includes("$0.00"));
expect("lists top domains", overview.text.includes("timeline.site.example"));
expect("sends CUSTOM dates in one daily call", requests.some((r) => r.dims[0] === "DATE"));

console.log("\nCOMPARE:");
const cmp = await call("adsense_compare_periods", { dimension: "PAGE_URL" });
expect("succeeds", !cmp.isError);
const losses = cmp.text.slice(cmp.text.indexOf("LOSSES"), cmp.text.indexOf("GAINS"));
const gains = cmp.text.slice(cmp.text.indexOf("GAINS"));
expect("biggest loss is /low at -$4.00", losses.split("\n")[3]?.includes("/low") && losses.includes("-$4.00"));
expect("vanished page /gone counted as a -$3.00 loss", lineWith(losses, "/gone").includes("-$3.00"));
expect("/a is a +$5.00 gain", lineWith(gains, "/a").includes("+$5.00"));
expect("unchanged pages are in neither list", !cmp.text.includes("site.example/b"));
expect("headline decomposition present", cmp.text.includes("yield effect:   +$14.00"));

console.log("\nTOP PAGES:");
const top = await call("adsense_top_pages", { limit: 3 });
expect("succeeds", !top.isError);
const firstPage = top.text.split("\n")[4] ?? "";
expect("sorted by earnings, $10.00 pages first", firstPage.includes("$10.00"));
expect("reports truncation", top.text.includes("Showing 3 of 8"));
const filtered = await call("adsense_top_pages", { urlContains: "/low" });
expect("urlContains sent as a contains filter", requests.at(-1).filters[0] === "PAGE_URL=@/low");
expect("filter applied", filtered.text.includes("/low") && !filtered.text.includes("site.example/a"));

console.log("\nRPM OPPORTUNITIES:");
const opp = await call("adsense_rpm_opportunities");
expect("succeeds", !opp.isError);
expect("median page RPM is $10.00", opp.text.includes("median page RPM $10.00"));
expect("flags exactly 2 pages worth ~$13.00", opp.text.includes("UNDER-EARNING (2 pages, ~$13.00"));
expect("/low first with an $8.00 gap", (opp.text.split("UNDER-EARNING")[1].split("\n")[3] ?? "").includes("/low") && lineWith(opp.text, "/low").includes("$8.00"));
expect("/noads flagged as serving no impressions", opp.text.includes("1 of these served no ad impressions"));
expect("/tiny ignored under minPageViews", !opp.text.includes("/tiny"));

console.log("\nRUN REPORT:");
const raw = await call("adsense_run_report", { metrics: ["clicks", "estimated_earnings"], dimensions: ["page_url"], limit: 2 });
expect("succeeds", !raw.isError);
expect("names upper-cased before sending", requests.at(-1).metrics.join() === "CLICKS,ESTIMATED_EARNINGS");
expect("default sort is first metric descending", requests.at(-1).orderBy[0] === "-CLICKS");
expect("columns follow requested order", lineWith(raw.text, "PAGE_URL").replace(/\s+/g, " ").includes("PAGE_URL CLICKS ESTIMATED_EARNINGS"));
expect("totals rendered", raw.text.includes("TOTALS"));
const bogus = await call("adsense_run_report", { metrics: ["BOGUS"] });
expect("API 400 surfaces as a tool error", bogus.isError);
expect("400 points at the field reference", bogus.text.includes("adsense_report_fields"));
const daily = await call("adsense_run_report", { metrics: ["ESTIMATED_EARNINGS"], dimensions: ["DATE"], range: "last_7_days" });
expect("DATE grouping sorts chronologically", requests.at(-1).orderBy[0] === "+DATE");
expect("7 daily rows", (daily.text.match(/^\d{4}-\d{2}-\d{2}\s/gm) ?? []).length === 7);

console.log("\nINVENTORY AND ACCOUNT:");
const units = await call("adsense_ad_units");
expect("joins performance onto the unit by id", lineWith(units.text, "Sidebar").includes("$12.50"));
expect("flags the idle active unit", units.text.includes("1 ACTIVE unit has no impressions") && units.text.includes("Footer"));
expect("hides archived units by default", !units.text.includes("Old"));
const sites = await call("adsense_sites");
expect("flags the site not yet approved", sites.text.includes("1 site is not READY"));
const health = await call("adsense_account_health");
expect("severe alerts listed before info", health.text.indexOf("SEVERE") < health.text.indexOf("INFO"));
expect("policy issue shows action and must-fix", health.text.includes("AD_SERVING_RESTRICTED") && health.text.includes("(must fix)"));
const pay = await call("adsense_payments");
expect("unpaid balance shown", pay.text.includes("UNPAID BALANCE: $42.10"));
expect("payments newest first", pay.text.indexOf("2026-10-21") < pay.text.indexOf("2026-09-21"));
const prefixed = await call("adsense_payments", { account: `ca-${ACCOUNT}` });
expect("accepts a ca-pub id", !prefixed.isError);

console.log(`\n${failures === 0 ? "ALL ASSERTIONS PASSED" : `${failures} ASSERTION(S) FAILED`}`);
await client.close();
stub.close();
process.exit(failures === 0 ? 0 : 1);
