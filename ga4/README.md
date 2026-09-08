# ga4 — Google Analytics 4 MCP server

Local stdio MCP server giving Claude direct access to Google Analytics 4 for traffic analysis and
site optimization.

Beyond wrapping the API, it ships analysis tools that answer the questions you actually have —
how the site is doing right now versus last month, what specifically changed, which pages waste
the traffic they get, which channels convert rather than merely deliver, and where users abandon
a flow.

## Tools

### Analysis

| Tool | Answers |
|---|---|
| `ga4_traffic_overview` | How is the site doing — headline metrics with period-over-period change, trend, channel split |
| `ga4_compare_periods` | What specifically changed, losses and gains separately, by page/channel/country/device |
| `ga4_top_pages` | What people actually read, with engagement time and key events in the same table |
| `ga4_acquisition` | Which sources convert, ranked by key events per session rather than volume |
| `ga4_landing_page_opportunities` | Which landing pages underperform **this site's own** median — the fix list |
| `ga4_funnel` | Where users drop out of a sequence you define (events or page paths) |
| `ga4_realtime` | Who is on the site in the last 30–60 minutes |

`ga4_landing_page_opportunities` calibrates against this property's own median engagement or
key-event rate rather than an industry benchmark, so "underperforming" means underperforming for
this site, and the output stays meaningful whatever the niche.

### Discovery and raw API

| Tool | Endpoint |
|---|---|
| `ga4_list_properties` | Admin `accountSummaries.list` — **call this first** for the numeric property id |
| `ga4_get_metadata` | Data `properties.getMetadata` — every dimension and metric this property supports, custom ones included |
| `ga4_check_compatibility` | Data `properties.checkCompatibility` — can these fields be queried together |
| `ga4_run_report` | Data `properties.runReport` — arbitrary dimensions, metrics, filters, sorting |
| `ga4_describe_property` | Admin property + data streams, key events, custom dimensions/metrics, retention |

Every tool is read-only. Nothing here writes to your Analytics configuration.

## Setup

### 1. Create an OAuth client

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create (or pick) a project.
   The one already used for `gsc` is fine.
2. Enable both the **Google Analytics Data API** and the **Google Analytics Admin API**.
3. Under *APIs & Services → OAuth consent screen*, configure the screen and add your own Google
   account as a **test user** (an unpublished app only works for listed test users).
4. Under *Credentials*, create an **OAuth client ID** of type **Desktop app**.
5. Drop the downloaded JSON into `ga4/.credentials/`. Either name works — `credentials.json`, or
   the `client_secret_….apps.googleusercontent.com.json` name Google gives it.

Alternatively set `GA4_CLIENT_ID` and `GA4_CLIENT_SECRET` in the environment instead of the file.

### 2. Install and authorize

```bash
cd ga4
mkdir -p .credentials      # drop the downloaded OAuth JSON in here
chmod 700 .credentials
npm install
npm run auth
```

This opens your browser once, then caches a refresh token to `ga4/.credentials/token.json`
(mode `0600`) and prints the properties it can now see. The MCP server itself never runs a browser
flow — a stdio server has no terminal to drive one — so this step happens out of band.

> **Scope.** The consent flow requests `analytics.edit`, which permits reading *and* changing GA4
> configuration. No tool in this server writes anything, so the wider grant exists only to avoid a
> second consent round if a write tool is ever added. To grant read-only access instead, change
> `SCOPE` in `src/auth.ts` to `https://www.googleapis.com/auth/analytics.readonly` and re-run
> `npm run auth`.
>
> `.credentials/` is gitignored at the repo root. Both files grant access to your Analytics
> account — keep them out of any commit, and out of any other checkout you share.

### 3. Register with Claude Code

```bash
claude mcp add ga4 -- node /absolute/path/to/my-mcps/ga4/dist/index.js
```

The repo also ships a `.mcp.json` at its root, so the server is available automatically when
working inside `my-mcps`.

## Usage notes

**Property ids are numeric.** `ga4_list_properties` gives you `123456789`. A `G-XXXXXXX`
measurement id identifies a *data stream*, not a property, and is rejected before any API call.

**Field names are API names, not UI labels.** GA4 calls them `activeUsers`,
`sessionDefaultChannelGroup`, `screenPageViews`. `ga4_get_metadata` lists exactly what this
property supports — including its custom dimensions — and `ga4_check_compatibility` says whether a
combination is legal before you spend quota discovering it is not.

**`conversions` became `keyEvents`.** Older properties only have the former. The analysis tools
detect a rejection, retry without the metric, and say so in a footnote rather than failing.

**Data is complete through yesterday.** Every tool defaults its end date to yesterday; today is
always a partial day. Use `range` for relative windows (`last_7_days`, `last_28_days`,
`last_30_days`, `last_3_months`, `last_6_months`, `last_12_months`).

**Empty results are usually configuration, not a bug.** Zero conversions means no key events are
configured; nothing before a certain date means the property's event-data retention is set to 2
months. `ga4_describe_property` reports both.

**Two accuracy caveats are surfaced automatically.** GA4 collapses high-cardinality reports into an
`(other)` row and withholds rows on demographic dimensions to protect individuals; where either
happened, the tool output says so under `NOTES` instead of quietly understating the numbers.

**Quotas.** Standard properties get 200,000 core tokens/day, 40,000/hour, 14,000/hour per project,
and 10 concurrent requests. Cost scales with rows, dimensions, and days per request; the tools warn
when a bucket drops below 20% remaining.

## Environment variables

| Variable | Purpose |
|---|---|
| `GA4_CLIENT_ID` / `GA4_CLIENT_SECRET` | OAuth client, instead of `credentials.json` |
| `GA4_CONFIG_DIR` | Relocate the credentials directory (default `ga4/.credentials`) |
| `GA4_ACCESS_TOKEN` | Use a token minted elsewhere; skips the cached-token flow |
| `GA4_DATA_API_BASE` | Point at a different Data API host (used by the tests) |
| `GA4_ADMIN_API_BASE` | Point at a different Admin API host (used by the tests) |

## Development

```bash
npm run build     # compile to dist/
npm run dev       # tsc --watch
npm test          # contract + analysis tests against a stub API, no network
npm run inspect   # open the MCP Inspector against the built server
```

`npm test` runs entirely offline: `test/smoke.mjs` checks the tool contract and the unauthenticated
error path, `test/credentials.mjs` covers OAuth client discovery, and `test/e2e.mjs` drives every
analysis tool against a stub GA4 API whose correct answers are known by construction — including
the `(other)` cardinality warning, the `keyEvents` fallback, and the invalid-metric error path. The
stub echoes back whichever metrics the server requested, in request order, so a column-mapping bug
shows up as a wrong number rather than being masked by a fixed response.

`ga4_funnel` uses the Data API **v1alpha** funnel endpoint — the only version that exposes funnels.
It works today, but Google can change v1alpha without notice; nothing else here leaves v1beta.
