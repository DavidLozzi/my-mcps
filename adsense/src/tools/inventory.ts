import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { generateReport, listAdClients, listAdUnits, resolveAccount, type AdUnit } from "../client.js";
import { guard, ok } from "../lib/tool.js";
import { describeRange, resolveDateRange } from "../lib/dates.js";
import { parseReport } from "../lib/report.js";
import { money, num, pct, rpm, table } from "../lib/format.js";
import { accountField, dateFields } from "./shared.js";

export function registerInventoryTools(server: McpServer): void {
  server.registerTool(
    "adsense_ad_units",
    {
      title: "List AdSense ad units with performance",
      description:
        "Every ad client (product) and its ad units — name, state, type and size — joined with each unit's " +
        "earnings, impressions, clicks, CTR and impression RPM over the window. Surfaces active units that " +
        "served nothing (placed nowhere, or broken). Auto ads earnings are not tied to a manual ad unit, so " +
        "they appear in totals but not against any unit here.",
      inputSchema: {
        account: accountField,
        ...dateFields,
        includeArchived: z.boolean().default(false).describe("Also list ARCHIVED ad units."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ account, startDate, endDate, range, includeArchived }) => {
      const acct = await resolveAccount(account);
      const dateRange = resolveDateRange({ startDate, endDate, range });

      const clients = await listAdClients(acct);
      const units: Array<AdUnit & { product: string }> = [];
      for (const client of clients) {
        const list = await listAdUnits(client.name!);
        units.push(...list.map((u) => ({ ...u, product: client.productCode ?? "" })));
      }

      const report = parseReport(
        await generateReport(acct, {
          dateRange,
          dimensions: ["AD_UNIT_ID"],
          metrics: ["ESTIMATED_EARNINGS", "IMPRESSIONS", "CLICKS"],
          limit: 10_000,
        }),
      );
      const perf = new Map(report.rows.map((r) => [r.dims.AD_UNIT_ID!, r.metrics]));

      const shown = units.filter((u) => includeArchived || u.state !== "ARCHIVED");
      if (shown.length === 0) {
        return ok(
          `No ${includeArchived ? "" : "active "}manual ad units across ${clients.length} ad client` +
            `${clients.length === 1 ? "" : "s"} (${clients.map((c) => c.productCode).join(", ") || "none"}). ` +
            `If the site runs on Auto ads alone, that is expected — use adsense_earnings_overview instead.`,
        );
      }

      const rows = shown
        .map((u) => {
          const m = perf.get(u.reportingDimensionId ?? "") ?? {};
          const earnings = m.ESTIMATED_EARNINGS ?? 0;
          const impressions = m.IMPRESSIONS ?? 0;
          const clicks = m.CLICKS ?? 0;
          return { u, earnings, impressions, clicks };
        })
        .sort((a, b) => b.earnings - a.earnings || b.impressions - a.impressions);

      const body = table(
        ["adUnit", "state", "type", "size", "earnings", "impressions", "clicks", "CTR", "imprRPM", "id"],
        rows.map(({ u, earnings, impressions, clicks }) => [
          u.displayName ?? "",
          u.state ?? "",
          u.contentAdsSettings?.type ?? "",
          u.contentAdsSettings?.size ?? "",
          money(earnings, report.currency),
          num(impressions),
          num(clicks),
          impressions > 0 ? pct(clicks / impressions) : "-",
          money(rpm(earnings, impressions), report.currency),
          u.reportingDimensionId ?? "",
        ]),
      );

      const idle = rows.filter((r) => r.u.state === "ACTIVE" && r.impressions === 0);
      const note =
        idle.length > 0
          ? `\n\n${idle.length} ACTIVE unit${idle.length === 1 ? " has" : "s have"} no impressions in this window: ` +
            `${idle.map((r) => r.u.displayName).join(", ")}. Either the code is not on any live page or the slot is ` +
            `not rendering.`
          : "";

      return ok(`Ad units, ${describeRange(dateRange)}\n\n${body}${note}`);
    }),
  );
}
