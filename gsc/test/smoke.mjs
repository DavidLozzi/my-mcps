import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

// Point at a config dir that cannot exist and strip any real token, so this
// exercises the unauthenticated path regardless of the developer's machine.
const env = { ...process.env, GSC_CONFIG_DIR: "/nonexistent/gsc-smoke" };
delete env.GSC_ACCESS_TOKEN;
delete env.GSC_CLIENT_ID;
delete env.GSC_CLIENT_SECRET;
delete env.GSC_API_BASE;

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
  const flags = [
    a.readOnlyHint ? "readOnly" : "write",
    a.destructiveHint ? "DESTRUCTIVE" : null,
    a.idempotentHint ? "idempotent" : null,
  ].filter(Boolean).join(",");
  console.log(`  ${t.name.padEnd(26)} [${flags}]  ${(t.title ?? "").padEnd(34)} params: ${Object.keys(t.inputSchema.properties ?? {}).length}`);
}

console.log("\nCONTRACT:");
expect("all 11 tools registered", tools.length === 11);
expect("every tool has a title", tools.every((t) => t.title));
expect("every tool has a description", tools.every((t) => (t.description ?? "").length > 40));
expect("every tool name is <= 64 chars", tools.every((t) => t.name.length <= 64));
expect(
  "only gsc_delete_sitemap is destructive",
  tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).join() === "gsc_delete_sitemap",
);
expect(
  "the two write tools are not marked readOnly",
  ["gsc_submit_sitemap", "gsc_delete_sitemap"].every(
    (n) => tools.find((t) => t.name === n)?.annotations?.readOnlyHint !== true,
  ),
);

// An unauthenticated call must surface as a tool error, not kill the transport.
console.log("\nUNAUTH PATH:");
const res = await client.callTool({ name: "gsc_list_sites", arguments: {} });
console.log("  " + res.content[0].text.split("\n").join("\n  "));
expect("returns isError rather than throwing", res.isError === true);
expect("tells the user exactly what to run", res.content[0].text.includes("npm run auth"));

const after = await client.listTools();
expect("transport still alive after the error", after.tools.length === 11);

console.log(`\n${failures === 0 ? "ALL ASSERTIONS PASSED" : `${failures} ASSERTION(S) FAILED`}`);
await client.close();
process.exit(failures === 0 ? 0 : 1);
