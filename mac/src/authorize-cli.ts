#!/usr/bin/env node
/**
 * The helper holds its own Reminders and Calendar grants (it disclaims the
 * launching app), and macOS only prompts when something asks. Run this once
 * from any terminal so the prompts are answered up front rather than stalling
 * the first tool call.
 */
import { HelperError, runHelper } from "./helper.js";

async function main(): Promise<void> {
  const before = await runHelper<{ reminders: string; calendar: string }>("status");
  if (before.reminders === "full_access" && before.calendar === "full_access") {
    console.log("Reminders and Calendar access are already granted. Nothing to do.");
    return;
  }

  console.log("Requesting Reminders and Calendar access — answer the macOS dialogs if they appear.");
  const after = await runHelper<{ reminders: string; calendar: string }>("authorize");
  console.log(
    `Reminders access: ${after.reminders}. Calendar access: ${after.calendar}. ` +
      "Restart the MCP server if it is already running.",
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof HelperError || err instanceof Error ? err.message : String(err));
  process.exit(1);
});
