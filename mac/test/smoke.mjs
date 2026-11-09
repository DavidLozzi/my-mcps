import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "dist", "index.js");
chmodSync(join(HERE, "stub-helper.mjs"), 0o755);

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

// Point at a helper that cannot exist, so nothing here touches real Reminders.
const client = await connect({ MAC_HELPER_PATH: "/nonexistent/mac-helper" });

const { tools } = await client.listTools();
console.log(`TOOLS (${tools.length}):`);
for (const t of tools) {
  const a = t.annotations ?? {};
  const flags = [a.readOnlyHint ? "readOnly" : "write", a.destructiveHint ? "DESTRUCTIVE" : null]
    .filter(Boolean)
    .join(",");
  console.log(
    `  ${t.name.padEnd(26)} [${flags}]  ${(t.title ?? "").padEnd(26)} params: ${Object.keys(t.inputSchema.properties ?? {}).length}`,
  );
}

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

console.log("\nCONTRACT:");
expect("all 17 tools registered", tools.length === 17);
expect("every tool has a title", tools.every((t) => t.title));
expect("every tool has a description", tools.every((t) => (t.description ?? "").length > 40));
expect(
  "every tool name is reminders_- or calendar_-prefixed",
  tools.every((t) => t.name.startsWith("reminders_") || t.name.startsWith("calendar_")),
);
expect(
  "read tools are marked read-only",
  [
    "reminders_list_lists", "reminders_list", "reminders_get",
    "calendar_list_calendars", "calendar_list_events", "calendar_get_event", "calendar_find_free_time",
  ].every((n) => byName[n]?.annotations?.readOnlyHint),
);
expect(
  "write tools are not marked read-only",
  [
    "reminders_create", "reminders_update", "reminders_complete", "reminders_delete", "reminders_create_list",
    "calendar_create_event", "calendar_update_event", "calendar_delete_events", "calendar_create_calendar",
    "calendar_delete_calendar",
  ].every((n) => byName[n]?.annotations?.readOnlyHint === false),
);
expect(
  "only the delete tools are destructive",
  tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort().join() ===
    "calendar_delete_calendar,calendar_delete_events,reminders_delete",
);

console.log("\nMISSING HELPER:");
const res = await client.callTool({ name: "reminders_list_lists", arguments: {} });
console.log("  " + res.content[0].text);
expect("returns isError rather than throwing", res.isError === true);
expect("tells the user exactly what to run", res.content[0].text.includes("npm run build"));

const second = await client.callTool({ name: "reminders_list", arguments: {} });
expect("transport survives a failed call", second.isError === true);

console.log("\nINPUT VALIDATION:");
const badDue = await client.callTool({ name: "reminders_create", arguments: { title: "x", due: "next tuesday" } });
expect("rejects a natural-language due date before calling the helper", badDue.isError === true);
expect("the rejection is about the date format, not the helper", !badDue.content[0].text.includes("npm run build"));
const badStart = await client.callTool({ name: "calendar_create_event", arguments: { title: "x", start: "tomorrow 3pm" } });
expect("rejects a natural-language event start before calling the helper", badStart.isError === true &&
  !badStart.content[0].text.includes("npm run build"));

await client.close();

console.log("\nCRASHED HELPER:");
const crashed = await connect({
  MAC_HELPER_PATH: join(HERE, "stub-helper.mjs"),
  STUB_MODE: "crash",
  STUB_FIXTURES: "/nonexistent",
});
const crash = await crashed.callTool({ name: "reminders_list_lists", arguments: {} });
console.log("  " + crash.content[0].text);
expect("surfaces the crash as a tool error", crash.isError === true);
expect("includes the helper's stderr", crash.content[0].text.includes("Symbol not found"));
await crashed.close();

console.log(`\n${failures === 0 ? "ALL ASSERTIONS PASSED" : `${failures} ASSERTION(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
