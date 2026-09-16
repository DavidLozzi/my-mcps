#!/usr/bin/env node
/**
 * macOS grants Reminders access to the app that launched a process, and only
 * shows the prompt when something asks. Run this from the same app that will
 * host the MCP server (Terminal, iTerm, Claude) so the prompt appears there
 * rather than stalling the first tool call.
 */
import { HelperError, runHelper } from "./helper.js";

async function main(): Promise<void> {
  const before = await runHelper<{ reminders: string }>("status");
  if (before.reminders === "full_access") {
    console.log("Reminders access is already granted. Nothing to do.");
    return;
  }

  console.log("Requesting Reminders access — answer the macOS dialog if one appears.");
  const after = await runHelper<{ reminders: string }>("authorize");
  console.log(`Reminders access: ${after.reminders}. Restart the MCP server if it is already running.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof HelperError || err instanceof Error ? err.message : String(err));
  process.exit(1);
});
