/**
 * Opt-in check against the real Zoho account in .credentials/accounts.json
 * (`npm run test:live`). Reads folders and the inbox, then sends one message to
 * the account itself, confirms it arrives in INBOX and Sent, and trashes both.
 * Pass --read-only to skip the send.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const readOnly = process.argv.includes("--read-only");
const account = process.argv.find((a) => a.startsWith("--account="))?.slice("--account=".length);

let failures = 0;
const expect = (desc, condition) => {
  if (!condition) failures++;
  console.log(`  ${condition ? "PASS" : "FAIL"}: ${desc}`);
};

const client = new Client({ name: "live", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: [SERVER] }));
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: account && !args.id && !args.ids ? { account, ...args } : args });
  return { text: res.content[0].text, isError: res.isError === true };
};
const ids = (text) => [...text.matchAll(/id: (m_[A-Za-z0-9_-]+)/g)].map((m) => m[1]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const accounts = await call("email_list_accounts", { check: true });
console.log(accounts.text + "\n");
expect("account logs in", !accounts.isError && accounts.text.includes("login ok"));

const folders = await call("email_list_folders");
console.log(folders.text + "\n");
expect("lists folders", !folders.isError && folders.text.includes("[sent]"));

const summary = await call("email_mailbox_summary");
console.log(summary.text + "\n");
expect("summarizes the inbox", !summary.isError);

const list = await call("email_list", { limit: 5 });
console.log(list.text + "\n");
expect("lists the inbox", !list.isError);
const first = ids(list.text)[0];
if (first) {
  const got = await call("email_get", { id: first, maxChars: 500 });
  expect("reads a message without error", !got.isError);
}

if (!readOnly) {
  const me = accounts.text.match(/<([^>]+)>/)[1];
  const subject = `zoho-mcp live test ${new Date().toISOString()}`;
  const sent = await call("email_send", { to: [me], subject, body: "Automated test from zoho-mcp. Safe to delete." });
  console.log(sent.text + "\n");
  expect("sends", !sent.isError);

  let inbox = [];
  for (let i = 0; i < 10 && inbox.length === 0; i++) {
    await sleep(3000);
    inbox = ids((await call("email_search", { subject })).text);
  }
  expect("arrives in INBOX", inbox.length === 1);
  const sentCopy = ids((await call("email_search", { folder: "sent", subject })).text);
  expect("exactly one copy in Sent", sentCopy.length === 1);
  const trashed = await call("email_trash", { ids: [...inbox, ...sentCopy] });
  expect("cleans up to Trash", !trashed.isError);
}

await client.close();
console.log(`\n${failures === 0 ? "ALL ASSERTIONS PASSED" : `${failures} ASSERTION(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
