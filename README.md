# my-mcps

Collection of custom Model Context Protocol (MCP) servers.

## Servers

| Server | What it does |
|---|---|
| [gsc](./gsc) | Google Search Console — SEO analysis, index diagnostics, sitemaps |
| [ga4](./ga4) | Google Analytics 4 — traffic analysis, acquisition, funnels, optimization |
| [adsense](./adsense) | Google AdSense — earnings, page RPM, traffic vs yield changes, ad units, policy |
| [mac](./mac) | macOS apps — Reminders and Calendar (via EventKit) |
| [zoho](./zoho) | Zoho Mail over IMAP/SMTP — read, search, organize, send, multiple accounts |

## Using these with Claude Code

`.mcp.json` at the repo root registers every server here, so they are available when working
inside this repo. It resolves paths from `MY_MCPS_ROOT`, defaulting to this checkout's location —
set that variable if you clone elsewhere.

To use a server from anywhere, register it globally:

```bash
claude mcp add gsc -- node /absolute/path/to/my-mcps/gsc/dist/index.js
claude mcp add ga4 -- node /absolute/path/to/my-mcps/ga4/dist/index.js
claude mcp add adsense -- node /absolute/path/to/my-mcps/adsense/dist/index.js
claude mcp add mac -- node /absolute/path/to/my-mcps/mac/dist/index.js
claude mcp add zoho -- node /absolute/path/to/my-mcps/zoho/dist/index.js
```

Each server has its own README with setup and auth steps. Build before first use — the registered
command points at compiled output in `dist/`.
