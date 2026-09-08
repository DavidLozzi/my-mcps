# gsc — Google Search Console MCP server

Local stdio MCP server giving Claude direct access to Google Search Console for SEO and indexing work.

Beyond wrapping the API, it ships four analysis tools that answer the questions you actually
have — which queries are one nudge from page 1, which pages are being under-clicked, what
changed since last month, and where your own pages compete with each other.

## Tools

### Analysis

| Tool | Answers |
|---|---|
| `gsc_striking_distance` | Which queries sit at positions ~5–20 with real volume — the cheapest traffic wins |
| `gsc_low_ctr_pages` | Which pages rank well but get under-clicked — the title/meta rewrite list |
| `gsc_compare_periods` | What specifically changed period over period, gainers and losers separately |
| `gsc_find_cannibalization` | Which queries have several of your pages competing, splitting clicks |

`gsc_low_ctr_pages` calibrates against **your own** site's median CTR at each position rather than
a generic industry curve, so "underperforming" means underperforming for this property. It falls
back to a static curve only where a position has fewer than five rows to learn from (marked `*`).

### Raw API

| Tool | Endpoint |
|---|---|
| `gsc_list_sites` | `sites.list` |
| `gsc_search_analytics` | `searchanalytics.query` — arbitrary dimension breakdowns |
| `gsc_inspect_url` | `urlInspection.index.inspect` — why one page isn't indexed |
| `gsc_list_sitemaps` | `sitemaps.list` |
| `gsc_get_sitemap` | `sitemaps.get` |
| `gsc_submit_sitemap` | `sitemaps.submit` |
| `gsc_delete_sitemap` | `sitemaps.delete` (destructive — unsubmits the sitemap) |

Property add/delete is deliberately not exposed.

## Setup

### 1. Create an OAuth client

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create (or pick) a project.
2. Enable the **Google Search Console API** for it.
3. Under *APIs & Services → OAuth consent screen*, configure the screen and add your own Google
   account as a **test user** (an unpublished app only works for listed test users).
4. Under *Credentials*, create an **OAuth client ID** of type **Desktop app**.
5. Download the JSON and save it to `gsc/.credentials/credentials.json`.

Alternatively set `GSC_CLIENT_ID` and `GSC_CLIENT_SECRET` in the environment instead of the file.

### 2. Install and authorize

```bash
cd gsc
mkdir -p .credentials      # then drop credentials.json in here
npm install
npm run auth
```

This opens your browser once, then caches a refresh token to `gsc/.credentials/token.json`
(mode `0600`) and prints the properties it can now see. The MCP server itself never runs a browser
flow — a stdio server has no terminal to drive one — so this step happens out of band.

> `.credentials/` is gitignored at the repo root. Both files grant access to your Search Console
> data — keep them out of any commit, and out of any other checkout you share.

### 3. Register with Claude Code

```bash
claude mcp add gsc -- node /absolute/path/to/my-mcps/gsc/dist/index.js
```

The repo also ships a `.mcp.json` at its root, so the server is available automatically when
working inside `my-mcps`.

## Usage notes

**Property names must be exact.** URL-prefix properties need a trailing slash
(`https://example.com/`); domain properties use `sc-domain:example.com`. Run `gsc_list_sites`
first — a 403 is almost always a format mismatch, and the error response lists what your account
can actually reach.

**Data lags 2–3 days.** Every tool defaults its end date to three days ago; asking for "today"
returns empty or partial rows. Use `range` for relative windows (`last_7_days`, `last_28_days`,
`last_3_months`, `last_6_months`, `last_12_months`, `last_16_months`) — Search Console retains 16
months.

**Quotas.** Roughly 1200 Search Analytics queries/minute and 40,000/day per user; URL inspection
is about 2000/day per property.

## Environment variables

| Variable | Purpose |
|---|---|
| `GSC_CLIENT_ID` / `GSC_CLIENT_SECRET` | OAuth client, instead of `credentials.json` |
| `GSC_CONFIG_DIR` | Relocate the credentials directory (default `gsc/.credentials`) |
| `GSC_ACCESS_TOKEN` | Use a token minted elsewhere; skips the cached-token flow |
| `GSC_API_BASE` | Point at a different API host (used by the tests) |

## Development

```bash
npm run build     # compile to dist/
npm run dev       # tsc --watch
npm test          # contract + analysis tests against a stub API, no network
npm run inspect   # open the MCP Inspector against the built server
```

`npm test` runs entirely offline: `test/smoke.mjs` checks the tool contract and the
unauthenticated error path, `test/e2e.mjs` drives the analysis tools against a stub Search Console
serving fixtures whose correct answers are known by construction.
