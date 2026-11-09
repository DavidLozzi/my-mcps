import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * EventKit is only reachable from native code, so every store operation runs
 * through the compiled Swift helper beside this file. It speaks one JSON object
 * in on stdin and one JSON object out on stdout per invocation.
 */

const DEFAULT_HELPER = join(dirname(fileURLToPath(import.meta.url)), "mac-helper");

// The first call on a fresh machine blocks on the macOS permission dialog,
// which a person has to notice and click, so allow far longer than a fetch needs.
const TIMEOUT_MS = 90_000;

export class HelperError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HelperError";
  }
}

export function helperPath(): string {
  return process.env.MAC_HELPER_PATH ?? DEFAULT_HELPER;
}

/** Turn the helper's terse failure codes into something the user can act on. */
function explain(code: string, message: string): string {
  switch (code) {
    case "access_denied":
      return (
        `${message} Grant it in System Settings → Privacy & Security → ` +
        `${message.startsWith("Calendar") ? "Calendars" : "Reminders"} and enable mac-helper. If it is not ` +
        "listed, run `npm run authorize` in the mac/ directory from any terminal and click Allow on the macOS " +
        "prompts, then restart the MCP server."
      );
    case "not_found":
      return `${message} Ids come from reminders_list; a deleted or completed-and-cleared reminder no longer resolves.`;
    case "list_not_found":
    case "ambiguous_list":
      return `${message} reminders_list_lists shows every list with its id.`;
    case "event_not_found":
      return (
        `${message} Ids come from calendar_list_events, and a repeating event's id names one occurrence; ` +
        "a deleted event or a moved occurrence no longer resolves."
      );
    case "calendar_not_found":
    case "ambiguous_calendar":
      return `${message} calendar_list_calendars shows every calendar with its id.`;
    default:
      return message;
  }
}

export async function runHelper<T>(command: string, input: object = {}): Promise<T> {
  const path = helperPath();
  if (!existsSync(path)) {
    throw new HelperError(
      "helper_missing",
      `The EventKit helper is not built (expected ${path}). Run \`npm run build\` in the mac/ directory; ` +
        "it needs the Xcode command line tools for swiftc.",
    );
  }

  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn(path, [command], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new HelperError(
          "timeout",
          `The EventKit helper did not answer within ${TIMEOUT_MS / 1000}s. If a macOS permission dialog ` +
            "is open, answer it and retry.",
        ),
      );
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new HelperError("spawn_failed", `Could not run the EventKit helper: ${err.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        // A crash here is almost always TCC killing a process that touched
        // Reminders or Calendar without a usage description, or a missing dylib.
        const detail = stderr.trim().split("\n").slice(-3).join(" ") || `exit ${code ?? signal}`;
        reject(new HelperError("helper_crashed", `The EventKit helper crashed: ${detail}`));
      }
    });

    child.stdin.end(JSON.stringify(input));
  });

  let parsed: { ok: boolean; data?: T; code?: string; message?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HelperError("bad_response", `The EventKit helper returned unreadable output: ${raw.slice(0, 200)}`);
  }

  if (!parsed.ok) {
    const code = parsed.code ?? "unknown";
    throw new HelperError(code, explain(code, parsed.message ?? "The EventKit helper reported an error."));
  }
  return parsed.data as T;
}
