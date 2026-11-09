# my-mcps

Collection of custom Model Context Protocol (MCP) servers.

## Servers

| Server | What it does |
|---|---|
| [gsc](./gsc) | Google Search Console — SEO analysis, index diagnostics, sitemaps |
| [ga4](./ga4) | Google Analytics 4 — traffic analysis, acquisition, funnels, optimization |
| [mac](./mac) | macOS apps — Reminders and Calendar (via EventKit) |

## Using these with Claude Code

`.mcp.json` at the repo root registers every server here, so they are available when working
inside this repo. It resolves paths from `MY_MCPS_ROOT`, defaulting to this checkout's location —
set that variable if you clone elsewhere.

To use a server from anywhere, register it globally:

```bash
claude mcp add gsc -- node /absolute/path/to/my-mcps/gsc/dist/index.js
claude mcp add ga4 -- node /absolute/path/to/my-mcps/ga4/dist/index.js
claude mcp add mac -- node /absolute/path/to/my-mcps/mac/dist/index.js
```

Each server has its own README with setup and auth steps. Build before first use — the registered
command points at compiled output in `dist/`.
