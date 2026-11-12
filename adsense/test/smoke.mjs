import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

// Point at a config dir that cannot exist and strip any real token, so this
// exercises the unauthenticated path regardless of the developer's machine.
const env = { ...process.env, ADSENSE_CONFIG_DIR: "/nonexistent/adsense-smoke" };
delete env.ADSENSE_ACCESS_TOKEN;
delete env.ADSENSE_CLIENT_ID;
delete env.ADSENSE_CLIENT_SECRET;
delete env.ADSENSE_API_BASE;

const transport = new StdioClientTransport({ command: "node", args: [SERVER], env });
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

let failures = 0;
const expect = (desc, condition) => {
  if (!condition) failures++;
  console.log(`  ${condition ? "PASS" : "FAIL"}: ${desc}`);
};

const { tools } = await client.listTools();
console.log(`TOOLS (${tools.length}):`);
for (const t of tools) {
  console.log(`  ${t.name.padEnd(30)} ${(t.title ?? "").padEnd(42)} params: ${Object.keys(t.inputSchema.properties ?? {}).length}`);
}

console.log("\nCONTRACT:");
expect("all 11 tools registered", tools.length === 11);
expect("every tool has a title", tools.every((t) => t.title));
expect("every tool has a description", tools.every((t) => (t.description ?? "").length > 40));
expect("every tool name is <= 64 chars", tools.every((t) => t.name.length <= 64));
expect("every tool name is adsense_-prefixed", tools.every((t) => t.name.startsWith("adsense_")));
expect("nothing is a write tool", tools.every((t) => t.annotations?.readOnlyHint === true));
expect("nothing is destructive", tools.every((t) => !t.annotations?.destructiveHint));
expect(
  "every account-scoped tool takes an optional account",
  tools
    .filter((t) => !["adsense_list_accounts", "adsense_report_fields"].includes(t.name))
    .every((t) => "account" in (t.inputSchema.properties ?? {}) && !(t.inputSchema.required ?? []).includes("account")),
);

// An unauthenticated call must surface as a tool error, not kill the transport.
console.log("\nUNAUTH PATH:");
const res = await client.callTool({ name: "adsense_list_accounts", arguments: {} });
console.log("  " + res.content[0].text.split("\n").join("\n  "));
expect("returns isError rather than throwing", res.isError === true);
expect("tells the user exactly what to run", res.content[0].text.includes("npm run auth"));

const second = await client.callTool({ name: "adsense_earnings_overview", arguments: {} });
expect("transport survives a failed call", second.isError === true);

console.log("\nBAD ACCOUNT ID:");
const bad = await client.callTool({ name: "adsense_top_pages", arguments: { account: "G-ABC123" } });
console.log("  " + bad.content[0].text.split("\n").join("\n  "));
expect("rejects a malformed publisher id before calling Google", bad.isError === true);
expect("explains what a publisher id looks like", bad.content[0].text.includes("pub-"));

console.log("\nOFFLINE TOOL:");
const fields = await client.callTool({ name: "adsense_report_fields", arguments: {} });
expect("field reference works without auth", !fields.isError && fields.content[0].text.includes("PAGE_VIEWS_RPM"));

console.log(`\n${failures === 0 ? "ALL ASSERTIONS PASSED" : `${failures} ASSERTION(S) FAILED`}`);

await client.close();
process.exit(failures === 0 ? 0 : 1);
