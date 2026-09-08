import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

// Point at a config dir that cannot exist and strip any real token, so this
// exercises the unauthenticated path regardless of the developer's machine.
const env = { ...process.env, GA4_CONFIG_DIR: "/nonexistent/ga4-smoke" };
delete env.GA4_ACCESS_TOKEN;
delete env.GA4_CLIENT_ID;
delete env.GA4_CLIENT_SECRET;
delete env.GA4_DATA_API_BASE;
delete env.GA4_ADMIN_API_BASE;

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
  const a = t.annotations ?? {};
  const flags = [a.readOnlyHint ? "readOnly" : "write", a.destructiveHint ? "DESTRUCTIVE" : null]
    .filter(Boolean)
    .join(",");
  console.log(
    `  ${t.name.padEnd(32)} [${flags}]  ${(t.title ?? "").padEnd(38)} params: ${Object.keys(t.inputSchema.properties ?? {}).length}`,
  );
}

console.log("\nCONTRACT:");
expect("all 12 tools registered", tools.length === 12);
expect("every tool has a title", tools.every((t) => t.title));
expect("every tool has a description", tools.every((t) => (t.description ?? "").length > 40));
expect("every tool name is <= 64 chars", tools.every((t) => t.name.length <= 64));
expect("every tool name is ga4_-prefixed", tools.every((t) => t.name.startsWith("ga4_")));
// The token carries analytics.edit, so nothing here may mutate the account.
expect("nothing is a write tool", tools.every((t) => t.annotations?.readOnlyHint === true));
expect("nothing is destructive", tools.every((t) => !t.annotations?.destructiveHint));
expect(
  "every property-scoped tool takes propertyId",
  tools
    .filter((t) => t.name !== "ga4_list_properties")
    .every((t) => Object.keys(t.inputSchema.properties ?? {}).includes("propertyId")),
);

// An unauthenticated call must surface as a tool error, not kill the transport.
console.log("\nUNAUTH PATH:");
const res = await client.callTool({ name: "ga4_list_properties", arguments: {} });
console.log("  " + res.content[0].text.split("\n").join("\n  "));
expect("returns isError rather than throwing", res.isError === true);
expect("tells the user exactly what to run", res.content[0].text.includes("npm run auth"));

// The transport must still be alive after that failure.
const second = await client.callTool({ name: "ga4_list_properties", arguments: {} });
expect("transport survives a failed call", second.isError === true);

console.log("\nBAD PROPERTY ID:");
const bad = await client.callTool({
  name: "ga4_top_pages",
  arguments: { propertyId: "G-ABC123XYZ" },
});
console.log("  " + bad.content[0].text.split("\n").join("\n  "));
expect("rejects a measurement id before calling Google", bad.isError === true);
expect("explains what a property id looks like", bad.content[0].text.includes("ga4_list_properties"));

console.log(`\n${failures === 0 ? "ALL ASSERTIONS PASSED" : `${failures} ASSERTION(S) FAILED`}`);

await client.close();
process.exit(failures === 0 ? 0 : 1);
