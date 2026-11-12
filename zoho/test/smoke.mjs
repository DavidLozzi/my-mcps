/**
 * Contract checks that need no network: every tool registers with a title,
 * description, and honest annotations; a missing or broken account config
 * comes back as an actionable tool error; and the transport survives it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "dist", "index.js");

let failures = 0;
const expect = (desc, condition) => {
  if (!condition) failures++;
  console.log(`  ${condition ? "PASS" : "FAIL"}: ${desc}`);
};

async function connect(env) {
  const transport = new StdioClientTransport({ command: "node", args: [SERVER], env: { ...process.env, ...env } });
  const client = new Client({ name: "smoke", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

const empty = mkdtempSync(join(tmpdir(), "zoho-smoke-"));
const client = await connect({ ZOHO_CONFIG_DIR: empty });

const { tools } = await client.listTools();
console.log(`TOOLS (${tools.length}):`);
for (const t of tools) {
  const a = t.annotations ?? {};
  const flags = [a.readOnlyHint ? "readOnly" : "write", a.destructiveHint ? "DESTRUCTIVE" : null].filter(Boolean).join(",");
  console.log(`  ${t.name.padEnd(28)} [${flags}]  ${(t.title ?? "").padEnd(32)} params: ${Object.keys(t.inputSchema.properties ?? {}).length}`);
}
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

console.log("\nCONTRACT:");
const EXPECTED = [
  "email_list_accounts", "email_list_folders", "email_create_folder", "email_rename_folder", "email_delete_folder",
  "email_quota", "email_list", "email_search", "email_get", "email_get_thread", "email_get_raw",
  "email_download_attachment", "email_mailbox_summary", "email_mark", "email_set_keywords", "email_move",
  "email_copy", "email_archive", "email_trash", "email_mark_spam", "email_not_spam", "email_delete_permanently",
  "email_empty_folder", "email_bulk_action", "email_send", "email_reply", "email_forward", "email_save_draft",
  "email_update_draft", "email_send_draft", "email_unsubscribe",
];
expect(`all ${EXPECTED.length} tools registered`, EXPECTED.every((n) => byName[n]) && tools.length === EXPECTED.length);
expect("every tool has a title", tools.every((t) => t.title));
expect("every tool has a description", tools.every((t) => (t.description ?? "").length > 40));
expect("every tool name is email_-prefixed", tools.every((t) => t.name.startsWith("email_")));
expect(
  "read tools are marked read-only",
  ["email_list_accounts", "email_list_folders", "email_quota", "email_list", "email_search", "email_get_thread",
    "email_get_raw", "email_mailbox_summary"].every((n) => byName[n]?.annotations?.readOnlyHint),
);
expect(
  "sending and moving tools are not read-only",
  ["email_send", "email_reply", "email_forward", "email_send_draft", "email_move", "email_trash", "email_mark",
    "email_bulk_action", "email_unsubscribe"].every((n) => byName[n]?.annotations?.readOnlyHint === false),
);
expect(
  "only the permanent-loss tools are destructive",
  tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort().join() ===
    "email_delete_folder,email_delete_permanently,email_empty_folder",
);

console.log("\nNO ACCOUNTS:");
const res = await client.callTool({ name: "email_list_folders", arguments: {} });
console.log("  " + res.content[0].text);
expect("returns isError rather than throwing", res.isError === true);
expect("tells the user exactly what to run", res.content[0].text.includes("npm run auth"));
const second = await client.callTool({ name: "email_list", arguments: {} });
expect("transport survives a failed call", second.isError === true);

console.log("\nINPUT VALIDATION:");
const badDate = await client.callTool({ name: "email_search", arguments: { since: "last week" } });
expect("rejects a natural-language date", badDate.isError === true && !badDate.content[0].text.includes("npm run auth"));
const badId = await client.callTool({ name: "email_get", arguments: { id: "12345" } });
console.log("  " + badId.content[0].text);
expect("rejects a made-up id with guidance", badId.isError === true && badId.content[0].text.includes("email_list"));
const unfiltered = await client.callTool({ name: "email_bulk_action", arguments: { action: "trash" } });
expect("bulk action refuses to run without a filter", unfiltered.isError === true && unfiltered.content[0].text.includes("filter"));
await client.close();

console.log("\nUNREACHABLE SERVER:");
const dead = mkdtempSync(join(tmpdir(), "zoho-smoke-"));
writeFileSync(
  join(dead, "accounts.json"),
  JSON.stringify([{ name: "dead", email: "me@zoho.com", appPassword: "x", imapHost: "127.0.0.1", imapPort: 1 }]),
);
const deadClient = await connect({ ZOHO_CONFIG_DIR: dead });
const refused = await deadClient.callTool({ name: "email_list", arguments: {} });
console.log("  " + refused.content[0].text);
expect("connection failure is a readable tool error", refused.isError === true && refused.content[0].text.includes("ECONNREFUSED"));
const unknown = await deadClient.callTool({ name: "email_list", arguments: { account: "nope" } });
expect("unknown account names the configured ones", unknown.isError === true && unknown.content[0].text.includes("dead"));
await deadClient.close();

console.log("\nMALFORMED CONFIG:");
writeFileSync(join(dead, "accounts.json"), "{ not json");
const brokenClient = await connect({ ZOHO_CONFIG_DIR: dead });
const broken = await brokenClient.callTool({ name: "email_list", arguments: {} });
expect("bad JSON is reported with its path", broken.isError === true && broken.content[0].text.includes("accounts.json"));
await brokenClient.close();

rmSync(empty, { recursive: true, force: true });
rmSync(dead, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL ASSERTIONS PASSED" : `${failures} ASSERTION(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
