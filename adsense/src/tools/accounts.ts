import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  formatGoogleDate,
  listAccounts,
  listAlerts,
  listPayments,
  listPolicyIssues,
  listSites,
  resolveAccount,
} from "../client.js";
import { guard, ok } from "../lib/tool.js";
import { num, table } from "../lib/format.js";
import { accountField } from "./shared.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

export function registerAccountTools(server: McpServer): void {
  server.registerTool(
    "adsense_list_accounts",
    {
      title: "List AdSense accounts",
      description:
        "Every AdSense account this login can reach, with its publisher id (pub-…), state, time zone and any " +
        "pending setup tasks. Other tools pick the account automatically when there is only one, so this is " +
        "mainly for confirming which account is connected or disambiguating several.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    guard(async () => {
      const accounts = await listAccounts();
      if (accounts.length === 0) {
        return ok(
          "This Google account has no AdSense accounts. Either a different Google account was used during " +
            "`npm run auth`, or AdSense was never set up for it.",
        );
      }

      const rows = accounts.map((a) => [
        (a.name ?? "").replace(/^accounts\//, ""),
        a.displayName ?? "",
        a.state ?? "",
        a.timeZone?.id ?? "",
        a.premium ? "yes" : "no",
        (a.pendingTasks ?? []).join(", ") || "-",
      ]);

      return ok(
        table(["account", "name", "state", "timeZone", "premium", "pendingTasks"], rows) +
          "\n\nReports use each account's own time zone.",
      );
    }),
  );

  server.registerTool(
    "adsense_sites",
    {
      title: "List AdSense sites",
      description:
        "Sites registered in AdSense with their approval state (READY, GETTING_READY, REQUIRES_REVIEW, " +
        "NEEDS_ATTENTION) and whether Auto ads are on. Use when a site earns nothing — it may not be approved — " +
        "or to check which domains are set up.",
      inputSchema: { account: accountField },
      annotations: READ_ONLY,
    },
    guard(async ({ account }) => {
      const acct = await resolveAccount(account);
      const sites = await listSites(acct);
      if (sites.length === 0) return ok("No sites are registered on this AdSense account.");

      const rows = sites
        .sort((a, b) => (a.domain ?? "").localeCompare(b.domain ?? ""))
        .map((s) => [s.domain ?? "", s.state ?? "", s.autoAdsEnabled ? "on" : "off", s.reportingDimensionId ?? ""]);

      const notReady = sites.filter((s) => s.state && s.state !== "READY");
      const note =
        notReady.length > 0
          ? `\n\n${notReady.length} site${notReady.length === 1 ? " is" : "s are"} not READY — ads will not serve ` +
            `(or serve limited) there until AdSense approves ${notReady.length === 1 ? "it" : "them"}. ` +
            `NEEDS_ATTENTION usually means a policy or ads.txt issue; adsense_account_health has details.`
          : "";

      return ok(table(["domain", "state", "autoAds", "siteId"], rows) + note);
    }),
  );

  server.registerTool(
    "adsense_account_health",
    {
      title: "AdSense alerts and policy issues",
      description:
        "Everything AdSense is warning about: account alerts (ads.txt problems, payment holds, low-value " +
        "content notices) and policy issues with the affected site or page, the enforcement action " +
        "(warned, ad serving restricted or disabled) and whether a fix is required. Check this first when " +
        "earnings drop suddenly or a site stops serving ads.",
      inputSchema: { account: accountField },
      annotations: READ_ONLY,
    },
    guard(async ({ account }) => {
      const acct = await resolveAccount(account);
      const [alerts, issues] = await Promise.all([listAlerts(acct), listPolicyIssues(acct)]);

      const parts: string[] = [];

      if (alerts.length === 0) {
        parts.push("ALERTS\n  None.");
      } else {
        const order = ["SEVERE", "WARNING", "INFO"];
        alerts.sort((a, b) => order.indexOf(a.severity ?? "") - order.indexOf(b.severity ?? ""));
        parts.push(
          `ALERTS (${alerts.length})\n` +
            alerts.map((a) => `  [${a.severity ?? "?"}] ${a.type ?? ""}: ${a.message ?? ""}`).join("\n"),
        );
      }

      if (issues.length === 0) {
        parts.push("POLICY ISSUES\n  None.");
      } else {
        const lines = issues.map((i) => {
          const where = i.uri ?? i.siteSection ?? i.site ?? "(account)";
          const topics = (i.policyTopics ?? [])
            .map((t) => `${t.topic ?? "?"}${t.mustFix ? " (must fix)" : ""}`)
            .join(", ");
          const dates = [
            i.firstDetectedDate ? `first ${formatGoogleDate(i.firstDetectedDate)}` : "",
            i.lastDetectedDate ? `last ${formatGoogleDate(i.lastDetectedDate)}` : "",
            i.warningEscalationDate ? `escalates ${formatGoogleDate(i.warningEscalationDate)}` : "",
          ]
            .filter(Boolean)
            .join(", ");
          const requests = i.adRequestCount ? `, ${num(Number(i.adRequestCount))} ad requests affected` : "";
          return `  ${i.action ?? "?"} — ${where}\n    ${topics || "(no topic given)"}${requests}${dates ? `\n    ${dates}` : ""}`;
        });
        parts.push(`POLICY ISSUES (${issues.length})\n${lines.join("\n")}`);
      }

      return ok(parts.join("\n\n"));
    }),
  );

  server.registerTool(
    "adsense_payments",
    {
      title: "AdSense balance and payments",
      description:
        "The current unpaid balance and payment history. AdSense pays monthly once the balance passes the " +
        "payment threshold, and the balance only finalizes a few days after each month closes.",
      inputSchema: { account: accountField },
      annotations: READ_ONLY,
    },
    guard(async ({ account }) => {
      const acct = await resolveAccount(account);
      const payments = await listPayments(acct);
      if (payments.length === 0) return ok("No balance or payments recorded on this account yet.");

      const unpaid = payments.filter((p) => (p.name ?? "").endsWith("/unpaid"));
      const paid = payments
        .filter((p) => !(p.name ?? "").endsWith("/unpaid"))
        .sort((a, b) => formatGoogleDate(b.date).localeCompare(formatGoogleDate(a.date)));

      const parts: string[] = [];
      parts.push(`UNPAID BALANCE: ${unpaid[0]?.amount ?? "none"}`);
      parts.push(
        paid.length === 0
          ? "No payments issued yet."
          : `PAYMENTS (${paid.length})\n` + table(["date", "amount"], paid.map((p) => [formatGoogleDate(p.date), p.amount ?? ""])),
      );
      return ok(parts.join("\n\n"));
    }),
  );
}
