# adsense — Google AdSense MCP server

Local stdio MCP server giving Claude read-only access to Google AdSense (Management API v2) for
earnings analysis and ad yield optimization.

Beyond wrapping the API, it ships analysis tools that answer the questions you actually have —
how earnings are trending, whether a change came from traffic or from RPM, which pages earn, which
pages waste the traffic they get, and whether AdSense is restricting anything.

## Tools

### Analysis

| Tool | Answers |
|---|---|
| `adsense_earnings_overview` | How is AdSense doing — today, yesterday, 7d, 28d (vs prior), month to date, last month, daily trend, top domains |
| `adsense_compare_periods` | What changed, losses and gains separately, by page/domain/country/device/ad unit/format — with the total split into a **traffic effect** and a **yield effect** |
| `adsense_top_pages` | Which pages earn, with page views, page RPM and share of total |
| `adsense_rpm_opportunities` | Pages with traffic whose page RPM is far below **this account's own** median — the fix list, ranked by money left on the table |
| `adsense_ad_units` | Manual ad units with state, size and performance; flags active units serving nothing |
| `adsense_account_health` | Alerts (ads.txt, payment holds) and policy issues with their enforcement action |

The traffic/yield split is exact: earnings = page views × page RPM / 1000, so the change is
`Δpage views × old RPM` plus `new page views × ΔRPM`. A drop that is all traffic is an SEO or
distribution question; a drop that is all yield is an ads question.

### Account and raw API

| Tool | Endpoint |
|---|---|
| `adsense_list_accounts` | `accounts.list` — publisher ids, state, time zone, pending tasks |
| `adsense_sites` | `accounts.sites.list` — approval state and Auto ads per site |
| `adsense_payments` | `accounts.payments.list` — unpaid balance and payment history |
| `adsense_run_report` | `accounts.reports.generate` — any dimensions, metrics, filters, sorting |
| `adsense_report_fields` | Static reference of common metric and dimension names (AdSense has no metadata endpoint) |

Every tool is read-only. The OAuth scope is `adsense.readonly`, so nothing here can change your
AdSense account even in principle.

## Setup

### 1. OAuth client

The Desktop app OAuth client already used for `gsc` and `ga4` works. In
[Google Cloud Console](https://console.cloud.google.com/), in that client's project:

1. Enable the **AdSense Management API**.
2. Make sure your Google account is a **test user** on the OAuth consent screen.
3. Drop the client JSON into `adsense/.credentials/` (as `credentials.json`, or under its downloaded
   `client_secret_….json` name). Copying `ga4/.credentials/credentials.json` is fine.

Alternatively set `ADSENSE_CLIENT_ID` and `ADSENSE_CLIENT_SECRET` in the environment.

### 2. Install and authorize

```bash
cd adsense
npm install
npm run auth
```

This opens your browser once, then caches a refresh token to `adsense/.credentials/token.json`
(mode `0600`) and prints the AdSense accounts it can see. The MCP server itself never runs a
browser flow — a stdio server has no terminal to drive one.

> `.credentials/` is gitignored at the repo root. Both files grant access to your AdSense data —
> keep them out of any commit.

### 3. Register with Claude Code

```bash
claude mcp add adsense -- node /absolute/path/to/my-mcps/adsense/dist/index.js
```

The repo's root `.mcp.json` already registers it when working inside `my-mcps`.

## Usage notes

**`account` is optional.** Nearly every publisher has one AdSense account, so tools use it
automatically. With several, pass `pub-1234567890123456` (`ca-pub-…` and `accounts/pub-…` work too).

**Today is partial.** Estimated earnings accrue all day and can still move for a couple of days.
Multi-day ranges end yesterday; only `today` and `month_to_date` include today. Every range is sent
to the API as explicit dates in the account's time zone, so comparisons line up exactly.

**Field names are UPPER_SNAKE_CASE enums** — `ESTIMATED_EARNINGS`, `PAGE_VIEWS_RPM`, `DOMAIN_NAME`.
`adsense_report_fields` lists the common ones; lowercase input is upper-cased for you.

**Filters use AdSense syntax:** `COUNTRY_CODE==US`, `PAGE_URL=@/blog/` (contains), `!=` and `!@` to
negate, a comma inside one expression ORs values, and multiple filters AND together.

**Auto ads have no ad unit.** Their earnings appear in every total and page/domain breakdown, but
not against any unit in `adsense_ad_units`.

## Environment variables

| Variable | Purpose |
|---|---|
| `ADSENSE_CLIENT_ID` / `ADSENSE_CLIENT_SECRET` | OAuth client, instead of `credentials.json` |
| `ADSENSE_CONFIG_DIR` | Relocate the credentials directory (default `adsense/.credentials`) |
| `ADSENSE_ACCESS_TOKEN` | Use a token minted elsewhere; skips the cached-token flow |
| `ADSENSE_API_BASE` | Point at a different API host (used by the tests) |

## Development

```bash
npm run build     # compile to dist/
npm run dev       # tsc --watch
npm test          # contract + analysis tests against a stub API, no network
npm run inspect   # open the MCP Inspector against the built server
```

`npm test` runs offline: `test/smoke.mjs` checks the tool contract and the unauthenticated path,
`test/credentials.mjs` covers OAuth client discovery, and `test/e2e.mjs` drives every tool against
a stub AdSense API whose correct answers are known by construction — the traffic/yield split, the
median-RPM opportunity list, losses and gains including vanished pages, and the 400 error path.
