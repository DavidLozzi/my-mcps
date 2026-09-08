/**
 * End-to-end exercise of the analysis tools against a stub GA4 API serving
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
const PROPERTY = "123456789";

const METRIC_TYPES = {
  sessions: "TYPE_INTEGER",
  engagedSessions: "TYPE_INTEGER",
  activeUsers: "TYPE_INTEGER",
  newUsers: "TYPE_INTEGER",
  screenPageViews: "TYPE_INTEGER",
  eventCount: "TYPE_INTEGER",
  keyEvents: "TYPE_INTEGER",
  engagementRate: "TYPE_FLOAT",
  averageSessionDuration: "TYPE_SECONDS",
  userEngagementDuration: "TYPE_SECONDS",
  totalRevenue: "TYPE_CURRENCY",
};

// ---------------------------------------------------------------------------
// Fixtures. Each is designed so the expected verdict is arithmetic, not taste.
// ---------------------------------------------------------------------------

// keyEvent rates: .10 .11 .09 .105 .095 .01 .10 -> median .10, threshold .05,
// so only /bad-keyevents is flagged, costing 1000 * (.10 - .01) = 90.
// engagement rates: .60 .62 .60 .60 .60 .59 .05 -> median .60, threshold .30,
// so only /bad-engagement is flagged, costing 1000 * (.60 - .05) = 550.
const LANDING = [
  { key: "/a", sessions: 1000, engagedSessions: 600, keyEvents: 100, userEngagementDuration: 60000 },
  { key: "/b", sessions: 1000, engagedSessions: 620, keyEvents: 110, userEngagementDuration: 62000 },
  { key: "/c", sessions: 1000, engagedSessions: 600, keyEvents: 90, userEngagementDuration: 59000 },
  { key: "/d", sessions: 1000, engagedSessions: 600, keyEvents: 105, userEngagementDuration: 61000 },
  { key: "/e", sessions: 1000, engagedSessions: 600, keyEvents: 95, userEngagementDuration: 60000 },
  { key: "/bad-keyevents", sessions: 1000, engagedSessions: 590, keyEvents: 10, userEngagementDuration: 58000 },
  { key: "/bad-engagement", sessions: 1000, engagedSessions: 50, keyEvents: 100, userEngagementDuration: 4000 },
];

// 100 users spending 3000 seconds -> 30s of engagement each.
const PAGES = [
  { key: "/popular", screenPageViews: 5000, activeUsers: 100, userEngagementDuration: 3000, keyEvents: 40 },
  { key: "/second", screenPageViews: 2500, activeUsers: 400, userEngagementDuration: 40000, keyEvents: 20 },
  { key: "/quiet", screenPageViews: 100, activeUsers: 90, userEngagementDuration: 450, keyEvents: 1 },
];

// Paid converts at .20/session against Organic's .02; Referral is below the
// sessions floor and must not appear at all.
const CHANNELS = [
  { key: "Organic Search", sessions: 1000, engagedSessions: 600, activeUsers: 800, keyEvents: 20, totalRevenue: 500 },
  { key: "Paid Search", sessions: 100, engagedSessions: 70, activeUsers: 90, keyEvents: 20, totalRevenue: 900 },
  { key: "Referral", sessions: 5, engagedSessions: 3, activeUsers: 5, keyEvents: 2, totalRevenue: 10 },
];

const COMPARE_CURRENT = [
  { key: "/dropped", sessions: 10 },
  { key: "/grew", sessions: 200 },
  { key: "/brand-new", sessions: 50 },
];
const COMPARE_BASELINE = [
  { key: "/dropped", sessions: 150 },
  { key: "/grew", sessions: 100 },
];

const TOTALS_CURRENT = [
  { sessions: 1100, activeUsers: 900, newUsers: 400, screenPageViews: 3000, engagementRate: 0.62, averageSessionDuration: 95, keyEvents: 55 },
];
const TOTALS_BASELINE = [
  { sessions: 1000, activeUsers: 850, newUsers: 380, screenPageViews: 2800, engagementRate: 0.6, averageSessionDuration: 90, keyEvents: 50 },
];

const TREND = [
  { key: "20260901", sessions: 300, activeUsers: 250, keyEvents: 15 },
  { key: "20260902", sessions: 400, activeUsers: 320, keyEvents: 20 },
  { key: "20260903", sessions: 400, activeUsers: 330, keyEvents: 20 },
];

const REALTIME = [
  { key: "/live-page", activeUsers: 12 },
  { key: "/other", activeUsers: 3 },
];

const METADATA = {
  dimensions: [
    { apiName: "pagePath", uiName: "Page path", description: "The portion of the URL after the domain.", category: "Page / screen" },
    { apiName: "landingPage", uiName: "Landing page", description: "The page path of the session's first pageview.", category: "Page / screen" },
    { apiName: "customUser:plan_tier", uiName: "Plan tier", description: "Subscription tier.", customDefinition: true, category: "Custom" },
  ],
  metrics: [
    { apiName: "sessions", uiName: "Sessions", type: "TYPE_INTEGER", description: "The number of sessions.", category: "Session" },
    { apiName: "totalRevenue", uiName: "Total revenue", type: "TYPE_CURRENCY", description: "Sum of revenue.", category: "Revenue" },
  ],
};

const FUNNEL_ROWS = [
  { step: "1. Viewed pricing", users: 1000 },
  { step: "2. Started signup", users: 400 },
  { step: "3. Completed signup", users: 380 },
];

/** Which fixture variant the stub serves; flipped by the harness before a check. */
let mode = "default";

const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://localhost");
    const json = (obj, status = 200) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(obj));

    if (url.pathname.startsWith("/mode/")) {
      mode = url.pathname.slice("/mode/".length);
      return json({ mode });
    }

    // --- Admin API -------------------------------------------------------
    if (url.pathname === "/v1beta/accountSummaries") {
      return json({
        accountSummaries: [
          {
            displayName: "Acme Inc",
            account: "accounts/555",
            propertySummaries: [
              { property: `properties/${PROPERTY}`, displayName: "acme.com - GA4", propertyType: "PROPERTY_TYPE_ORDINARY" },
            ],
          },
        ],
      });
    }
    if (url.pathname === `/v1beta/properties/${PROPERTY}`) {
      return json({
        name: `properties/${PROPERTY}`,
        displayName: "acme.com - GA4",
        propertyType: "PROPERTY_TYPE_ORDINARY",
        timeZone: "America/New_York",
        currencyCode: "USD",
        industryCategory: "TECHNOLOGY",
        serviceLevel: "GOOGLE_ANALYTICS_STANDARD",
        createTime: "2023-04-01T12:00:00Z",
      });
    }
    if (url.pathname.endsWith("/dataRetentionSettings")) {
      return json({ eventDataRetention: "TWO_MONTHS", resetUserDataOnNewActivity: true });
    }
    if (url.pathname.endsWith("/dataStreams")) {
      return json({
        dataStreams: [
          { displayName: "Web", type: "WEB_DATA_STREAM", webStreamData: { measurementId: "G-ABC123", defaultUri: "https://acme.com" } },
        ],
      });
    }
    if (url.pathname.endsWith("/keyEvents")) {
      // Deliberately empty: the tool must say so rather than show "(0)" alone.
      return json({});
    }
    if (url.pathname.endsWith("/customDimensions")) {
      return json({
        customDimensions: [
          { parameterName: "plan_tier", displayName: "Plan tier", scope: "USER", description: "Subscription tier" },
        ],
      });
    }
    if (url.pathname.endsWith("/customMetrics")) {
      return json({});
    }

    // --- Data API --------------------------------------------------------
    if (url.pathname.endsWith("/metadata")) {
      return json(METADATA);
    }

    if (url.pathname.endsWith(":checkCompatibility")) {
      const q = JSON.parse(body || "{}");
      const requested = (q.dimensions ?? []).map((d) => d.name);
      // sessions is compatible with everything here; itemRevenue never is.
      const dimensionCompatibilities = requested
        .filter((name) => name !== "itemName")
        .map((name) => ({ dimensionMetadata: { apiName: name }, compatibility: "COMPATIBLE" }));
      return json({
        dimensionCompatibilities,
        metricCompatibilities: (q.metrics ?? [])
          .map((m) => m.name)
          .filter((name) => name !== "itemRevenue")
          .map((name) => ({ metricMetadata: { apiName: name }, compatibility: "COMPATIBLE" })),
      });
    }

    if (url.pathname.endsWith(":runRealtimeReport")) {
      const q = JSON.parse(body || "{}");
      return json(report(q, REALTIME, ["unifiedScreenName"]));
    }

    if (url.pathname.endsWith(":runFunnelReport")) {
      return json({
        funnelTable: {
          dimensionHeaders: [{ name: "funnelStepName" }],
          metricHeaders: [{ name: "activeUsers", type: "TYPE_INTEGER" }],
          rows: FUNNEL_ROWS.map((r) => ({
            dimensionValues: [{ value: r.step }],
            metricValues: [{ value: String(r.users) }],
          })),
        },
      });
    }

    if (url.pathname.endsWith(":runReport")) {
      const q = JSON.parse(body || "{}");
      const dims = (q.dimensions ?? []).map((d) => d.name);
      const metrics = (q.metrics ?? []).map((m) => m.name);

      // A property that predates the keyEvents metric answers with a 400 naming
      // it — the server must drop the metric and retry rather than give up.
      if (mode === "nokeyevents" && metrics.includes("keyEvents")) {
        return json({ error: { message: "Field keyEvents is not a valid metric.", status: "INVALID_ARGUMENT" } }, 400);
      }
      const unknown = metrics.find((name) => !(name in METRIC_TYPES));
      if (unknown) {
        return json({ error: { message: `Field ${unknown} is not a valid metric.`, status: "INVALID_ARGUMENT" } }, 400);
      }

      // The client pages until a short page comes back, so serve fixtures only
      // on the first page.
      if (Number(q.offset ?? 0) > 0) return json(report(q, [], dims));

      const extra =
        mode === "cardinality"
          ? { metadata: { dataLossFromOtherRow: true, currencyCode: "USD", timeZone: "America/New_York" } }
          : {};

      if (dims.length === 0) {
        const isBaseline = q.dateRanges[0].startDate < "2026-08-09";
        return json(report(q, isBaseline ? TOTALS_BASELINE : TOTALS_CURRENT, dims, extra));
      }
      if (dims[0] === "date" || dims[0] === "yearWeek" || dims[0] === "yearMonth") {
        return json(report(q, TREND, dims, extra));
      }
      if (dims[0] === "sessionDefaultChannelGroup" || dims[0] === "sessionSourceMedium") {
        return json(report(q, CHANNELS, dims, extra));
      }
      if (dims[0] === "landingPage") {
        return json(report(q, LANDING, dims, extra));
      }
      if (dims[0] === "pagePath") {
        if (mode === "compare") {
          const isBaseline = q.dateRanges[0].startDate < "2026-08-09";
          return json(report(q, isBaseline ? COMPARE_BASELINE : COMPARE_CURRENT, dims, extra));
        }
        return json(report(q, PAGES, dims, extra));
      }
      return json(report(q, [], dims, extra));
    }

    res.writeHead(404).end("{}");
  });
});

/**
 * Build a RunReportResponse for `records` shaped to exactly the dimensions and
 * metrics the request asked for, so a column-order bug in the server shows up
 * as a wrong number rather than being masked by a fixed fixture.
 */
function report(q, records, dims, extra = {}) {
  const metrics = (q.metrics ?? []).map((m) => m.name);
  const rows = records.map((record) => ({
    dimensionValues: dims.map(() => ({ value: record.key ?? "" })),
    metricValues: metrics.map((name) => ({ value: String(record[name] ?? 0) })),
  }));

  const totals = (q.metricAggregations ?? []).includes("TOTAL")
    ? [
        {
          dimensionValues: dims.map(() => ({ value: "RESERVED_TOTAL" })),
          metricValues: metrics.map((name) => ({
            value: String(records.reduce((sum, r) => sum + (r[name] ?? 0), 0)),
          })),
        },
      ]
    : undefined;

  return {
    dimensionHeaders: dims.map((name) => ({ name })),
    metricHeaders: metrics.map((name) => ({ name, type: METRIC_TYPES[name] ?? "TYPE_INTEGER" })),
    rows,
    ...(totals ? { totals } : {}),
    rowCount: rows.length,
    propertyQuota: {
      tokensPerDay: { consumed: 100, remaining: 199_900 },
      tokensPerHour: { consumed: 10, remaining: 39_990 },
    },
    ...extra,
  };
}

await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const port = stub.address().port;
const base = `http://127.0.0.1:${port}`;

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  env: {
    ...process.env,
    GA4_DATA_API_BASE: base,
    GA4_ADMIN_API_BASE: base,
    GA4_ACCESS_TOKEN: "stub-token",
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
    let passed = false;
    try {
      passed = fn(text, res);
    } catch {
      passed = false;
    }
    if (!passed) failures++;
    console.log(`  ${passed ? "PASS" : "FAIL"}: ${desc}`);
  }
}
const setMode = (next) => fetch(`${base}/mode/${next}`);

await check("ga4_list_properties", "ga4_list_properties", {}, [
  ["lists the stub property id", (t) => t.includes(PROPERTY)],
  ["names the account", (t) => t.includes("Acme Inc")],
]);

await check("ga4_describe_property", "ga4_describe_property", { propertyId: PROPERTY }, [
  ["reports the retention window", (t) => t.toLowerCase().includes("two months")],
  ["lists the web stream and measurement id", (t) => t.includes("G-ABC123")],
  ["explains that no key events are configured", (t) => t.includes("None configured")],
  ["lists the custom dimension", (t) => t.includes("plan_tier")],
]);

await check("ga4_get_metadata (search)", "ga4_get_metadata", { propertyId: PROPERTY, search: "landing" }, [
  ["finds the matching dimension", (t) => t.includes("landingPage")],
  ["excludes non-matching ones", (t) => !t.includes("totalRevenue")],
]);

await check("ga4_get_metadata (customOnly)", "ga4_get_metadata", { propertyId: PROPERTY, customOnly: true }, [
  ["returns only the custom dimension", (t) => t.includes("plan_tier") && !t.includes("pagePath")],
]);

await check(
  "ga4_check_compatibility",
  "ga4_check_compatibility",
  { propertyId: PROPERTY, dimensions: ["pagePath", "itemName"], metrics: ["sessions"] },
  [
    ["flags the incompatible dimension", (t) => t.includes("INCOMPATIBLE") && t.includes("itemName")],
    ["does not blame the compatible ones", (t) => !/INCOMPATIBLE.*pagePath/s.test(t.split("\n")[0])],
  ],
);

await check("ga4_top_pages", "ga4_top_pages", { propertyId: PROPERTY, limit: 10 }, [
  ["ranks the most-viewed page first", (t) => t.indexOf("/popular") < t.indexOf("/second")],
  ["renders view counts with separators", (t) => t.includes("5,000")],
  ["derives engagement per user (3000s / 100 users = 30s)", (t) => /\/popular.*\b30s\b/.test(t)],
  ["keeps the keyEvents column", (t) => t.includes("keyEvents")],
]);

await check("ga4_acquisition", "ga4_acquisition", { propertyId: PROPERTY }, [
  ["ranks by conversion efficiency, not volume", (t) => t.indexOf("Paid Search") < t.indexOf("Organic Search")],
  ["excludes sources below minSessions", (t) => !t.includes("Referral")],
  ["shows Paid's 0.200 key events per session", (t) => /Paid Search.*0\.200/.test(t)],
  ["reports the property-wide rate for context", (t) => t.includes("key events per session: 0.036")],
]);

await check(
  "ga4_landing_page_opportunities (keyEvents)",
  "ga4_landing_page_opportunities",
  { propertyId: PROPERTY, basis: "keyEvents" },
  [
    ["flags the 1%-rate page", (t) => t.includes("/bad-keyevents")],
    ["does not flag the healthy cohort", (t) => !t.includes("/bad-engagement")],
    ["uses the property median of 10.00%", (t) => t.includes("10.00%")],
    ["values the gap at 1000 * (0.10 - 0.01) = 90", (t) => /\/bad-keyevents.*\s90\s/.test(t)],
  ],
);

await check(
  "ga4_landing_page_opportunities (engagement)",
  "ga4_landing_page_opportunities",
  { propertyId: PROPERTY, basis: "engagement" },
  [
    ["flags the 5%-engagement page", (t) => t.includes("/bad-engagement")],
    ["does not flag the low-conversion page on this basis", (t) => !t.includes("/bad-keyevents")],
    ["values the gap at 1000 * (0.60 - 0.05) = 550", (t) => /\/bad-engagement.*\s550\s/.test(t)],
  ],
);

await check("ga4_traffic_overview", "ga4_traffic_overview", { propertyId: PROPERTY, range: "last_28_days" }, [
  ["reports the headline metrics", (t) => t.includes("HEADLINE") && t.includes("activeUsers")],
  ["compares against the preceding period", (t) => t.includes("1,100") && t.includes("1,000")],
  ["computes the session change as +100 / 10.0%", (t) => /sessions.*\+100.*10\.0%/.test(t)],
  ["renders engagement rate as a percentage", (t) => t.includes("62.00%")],
  ["renders average duration as a duration", (t) => /averageSessionDuration.*1m 35s/.test(t)],
  ["includes the trend section", (t) => t.includes("TREND by date")],
  ["includes the channel split", (t) => t.includes("CHANNELS") && t.includes("Organic Search")],
]);

await setMode("compare");
await check(
  "ga4_compare_periods",
  "ga4_compare_periods",
  { propertyId: PROPERTY, dimension: "pagePath", metric: "sessions", range: "last_28_days" },
  [
    ["reports the -140 session loss", (t) => t.includes("/dropped") && t.includes("-140")],
    ["reports the +100 session gain", (t) => t.includes("/grew") && t.includes("+100")],
    ["marks the page with no baseline as new", (t) => /brand-new.*\bnew\b/.test(t)],
    ["separates losses from gains", (t) => t.includes("TOP LOSSES") && t.includes("TOP GAINS")],
    ["losses listed before gains", (t) => t.indexOf("TOP LOSSES") < t.indexOf("TOP GAINS")],
    ["property totals reflect 250 -> 260 sessions", (t) => t.includes("250 -> 260")],
  ],
);

await setMode("cardinality");
await check("cardinality warning", "ga4_top_pages", { propertyId: PROPERTY }, [
  ["warns that rows were collapsed into (other)", (t) => t.includes("(other)")],
  ["explains totals are understated", (t) => t.includes("understate")],
]);

await setMode("nokeyevents");
await check("keyEvents fallback", "ga4_top_pages", { propertyId: PROPERTY }, [
  ["still returns data without the unsupported metric", (t) => t.includes("/popular")],
  ["drops the keyEvents column", (t) => !t.includes("keyEvents |") && !/\bkeyEvents\b\s*$/m.test(t)],
  ["says the property does not support it", (t) => t.includes("does not support keyEvents")],
]);

await setMode("default");
await check(
  "invalid metric name",
  "ga4_run_report",
  { propertyId: PROPERTY, metrics: ["sessionz"] },
  [
    ["surfaces the failure as a tool error", (t, res) => res.isError === true],
    ["quotes Google's message", (t) => t.includes("sessionz")],
    ["points at the tool that lists real names", (t) => t.includes("ga4_get_metadata")],
    ["points at the compatibility checker", (t) => t.includes("ga4_check_compatibility")],
  ],
);

await check(
  "ga4_run_report (time series)",
  "ga4_run_report",
  {
    propertyId: PROPERTY,
    metrics: ["sessions", "activeUsers"],
    dimensions: ["date"],
    orderByDimension: "date",
    descending: false,
  },
  [
    ["renders the series", (t) => t.includes("20260901") && t.includes("20260903")],
    ["reports totals across rows", (t) => t.includes("sessions: 1,100")],
  ],
);

await check(
  "ga4_run_report (filtered)",
  "ga4_run_report",
  {
    propertyId: PROPERTY,
    metrics: ["sessions"],
    dimensions: ["pagePath"],
    dimensionFilters: [{ fieldName: "pagePath", match: "BEGINS_WITH", value: "/pop" }],
  },
  [["accepts a filter clause without erroring", (t, res) => res.isError !== true]],
);

await check("ga4_realtime", "ga4_realtime", { propertyId: PROPERTY }, [
  ["reports the live page", (t) => t.includes("/live-page")],
  ["states the window", (t) => t.includes("last 30 minutes")],
]);

await check(
  "ga4_funnel",
  "ga4_funnel",
  {
    propertyId: PROPERTY,
    steps: [
      { name: "Viewed pricing", pagePath: "/pricing" },
      { name: "Started signup", eventName: "signup_start" },
      { name: "Completed signup", eventName: "signup_complete" },
    ],
  },
  [
    ["lists every step", (t) => t.includes("Viewed pricing") && t.includes("Completed signup")],
    ["computes the 60% drop at step 2", (t) => /Started signup.*60\.00%/.test(t)],
    ["names the biggest leak", (t) => t.includes("Biggest leak") && t.includes("Started signup")],
    ["shows share of entrants", (t) => t.includes("38.00%")],
  ],
);

console.log(`\n${"=".repeat(72)}`);
console.log(failures === 0 ? "ALL ASSERTIONS PASSED" : `${failures} ASSERTION(S) FAILED`);

await client.close();
stub.close();
process.exit(failures === 0 ? 0 : 1);
