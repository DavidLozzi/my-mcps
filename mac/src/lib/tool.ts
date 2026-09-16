import { HelperError } from "../helper.js";

export interface ToolResult {
  // The SDK's CallToolResult carries an index signature for protocol
  // extensions; without it a handler returning ToolResult is not assignable.
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Every tool handler runs through here so a thrown error becomes an MCP tool
 * error rather than an exception that tears down the stdio transport.
 */
export function guard<A>(
  handler: (args: A) => Promise<ToolResult>,
): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (err) {
      if (err instanceof HelperError) {
        return fail(err.message);
      }
      return fail(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
