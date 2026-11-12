/**
 * End-to-end run of the real server against local mock IMAP (hoodiecrow) and
 * SMTP (smtp-server) servers over TLS, covering read, search, organize, draft,
 * send, reply, forward, bulk and unsubscribe flows. Nothing touches Zoho.
 */
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const require = createRequire(import.meta.url);
const hoodiecrow = require("hoodiecrow-imap");
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "dist", "index.js");
const CERT_DIR = join(dirname(require.resolve("hoodiecrow-imap/package.json")), "cert");
const TLS = { key: readFileSync(join(CERT_DIR, "server.key")), cert: readFileSync(join(CERT_DIR, "server.crt")) };

let failures = 0;
const expect = (desc, condition) => {
  if (!condition) failures++;
  console.log(`  ${condition ? "PASS" : "FAIL"}: ${desc}`);
};

// ---------------------------------------------------------------------------
// Mock unsubscribe endpoint
// ---------------------------------------------------------------------------
const unsubscribeHits = [];
const http = createHttpServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    unsubscribeHits.push({ method: req.method, url: req.url, body });
    res.writeHead(200).end("ok");
  });
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const HTTP_PORT = http.address().port;

// ---------------------------------------------------------------------------
// Mock IMAP
// ---------------------------------------------------------------------------
const crlf = (lines) => lines.join("\r\n");
const msg = (headers, body) => crlf([...headers, "", body, ""]);

const NEWSLETTER = msg(
  [
    "From: Shop News <news@shop.example>",
    "To: me@zoho.com",
    "Subject: Weekly deals",
    "Message-ID: <news1@shop.example>",
    "Date: Sat, 07 Nov 2026 09:00:00 +0000",
    `List-Unsubscribe: <mailto:unsub@shop.example?subject=stop>, <https://127.0.0.1:${HTTP_PORT}/u/1>`,
    "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
  ],
  "Big savings.",
);
const NEWSLETTER2 = msg(
  ["From: Shop News <news@shop.example>", "To: me@zoho.com", "Subject: Flash sale", "Message-ID: <news2@shop.example>", "Date: Sun, 08 Nov 2026 09:00:00 +0000"],
  "Even bigger savings.",
);
const JANE = crlf([
  "From: Jane Doe <jane@example.com>",
  "To: me@zoho.com",
  "Cc: bob@example.com",
  "Subject: Trip plans",
  "Message-ID: <jane2@example.com>",
  "In-Reply-To: <me1@zoho.com>",
  "References: <me1@zoho.com>",
  "Date: Sun, 08 Nov 2026 15:00:00 +0000",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b1"',
  "",
  "--b1",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Itinerary attached.",
  "",
  "> earlier text",
  "--b1",
  'Content-Type: text/plain; name="itinerary.txt"',
  'Content-Disposition: attachment; filename="itinerary.txt"',
  "",
  "Day 1: fly",
  "--b1--",
  "",
]);
const MINE = msg(
  ["From: me@zoho.com", "To: Jane Doe <jane@example.com>", "Subject: Trip plans", "Message-ID: <me1@zoho.com>", "Date: Sat, 07 Nov 2026 12:00:00 +0000"],
  "Where should we go?",
);

const imap = hoodiecrow({
  secureConnection: true,
  credentials: TLS,
  plugins: ["SPECIAL-USE", "UIDPLUS", "MOVE", "ID", "LITERALPLUS", "QUOTA"],
  users: { "me@zoho.com": { password: "app-pass" } },
  storage: {
    INBOX: {
      messages: [
        { raw: NEWSLETTER, flags: ["\\Seen"] },
        { raw: NEWSLETTER2, flags: [] },
        { raw: JANE, flags: [] },
      ],
    },
    "": {
      separator: "/",
      folders: {
        Sent: { "special-use": "\\Sent", messages: [{ raw: MINE, flags: ["\\Seen"] }] },
        Drafts: { "special-use": "\\Drafts" },
        Trash: { "special-use": "\\Trash" },
        Spam: { "special-use": "\\Junk" },
        Work: {},
      },
    },
  },
});
await new Promise((r) => imap.listen(0, "127.0.0.1", r));
const IMAP_PORT = imap.address().port;

// ---------------------------------------------------------------------------
// Mock SMTP — records what it is sent. Zoho files sent mail in Sent itself;
// this mock does not, so the server's own fallback append is what is tested.
// ---------------------------------------------------------------------------
const outbox = [];
const smtp = new SMTPServer({
  secure: true,
  ...TLS,
  authMethods: ["PLAIN", "LOGIN"],
  onAuth(auth, _session, cb) {
    if (auth.username === "me@zoho.com" && auth.password === "app-pass") cb(null, { user: auth.username });
    else cb(new Error("Invalid credentials"));
  },
  onData(stream, session, cb) {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", async () => {
      const raw = Buffer.concat(chunks);
      outbox.push({ rcpt: session.envelope.rcptTo.map((r) => r.address), raw, parsed: await simpleParser(raw) });
      cb();
    });
  },
  logger: false,
});
// Clients that only verify or drop the connection early are not test failures.
smtp.on("error", () => {});
await new Promise((r) => smtp.listen(0, "127.0.0.1", r));
const SMTP_PORT = smtp.server.address().port;

// ---------------------------------------------------------------------------
// Server under test
// ---------------------------------------------------------------------------
const configDir = mkdtempSync(join(tmpdir(), "zoho-e2e-"));
const downloads = mkdtempSync(join(tmpdir(), "zoho-e2e-dl-"));
writeFileSync(
  join(configDir, "accounts.json"),
  JSON.stringify([
    {
      name: "personal",
      email: "me@zoho.com",
      appPassword: "app-pass",
      fromName: "Me",
      imapHost: "127.0.0.1",
      imapPort: IMAP_PORT,
      smtpHost: "127.0.0.1",
      smtpPort: SMTP_PORT,
      default: true,
    },
    { name: "wrong", email: "other@zoho.com", appPassword: "nope", imapHost: "127.0.0.1", imapPort: IMAP_PORT },
  ]),
);
// The one-click unsubscribe endpoint is https with the same self-signed cert.
const https = (await import("node:https")).createServer(TLS, (req, res) => http.emit("request", req, res));
http.close();
await new Promise((r) => https.listen(HTTP_PORT, "127.0.0.1", r));

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  env: { ...process.env, ZOHO_CONFIG_DIR: configDir, ZOHO_TEST_INSECURE_TLS: "1", NODE_TLS_REJECT_UNAUTHORIZED: "0" },
  stderr: "pipe",
});
const client = new Client({ name: "e2e", version: "1.0.0" });
await client.connect(transport);

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { text: res.content[0].text, isError: res.isError === true };
};
const ids = (text) => [...text.matchAll(/id: (m_[A-Za-z0-9_-]+)/g)].map((m) => m[1]);

try {
  console.log("ACCOUNTS:");
  const accounts = await call("email_list_accounts", { check: true });
  console.log(accounts.text.split("\n").map((l) => "    " + l).join("\n"));
  expect("default account logs in", /personal \(default\).*login ok/.test(accounts.text));
  expect("bad password is reported with the fix", /wrong.*LOGIN FAILED.*app-specific password/.test(accounts.text));

  console.log("\nFOLDERS:");
  const folders = await call("email_list_folders");
  console.log(folders.text.split("\n").map((l) => "    " + l).join("\n"));
  expect("shows roles", folders.text.includes("Sent [sent]") && folders.text.includes("Spam [spam]"));
  expect("shows unread counts", /INBOX \[inbox\]\s+3 messages, 2 unread/.test(folders.text));
  const created = await call("email_create_folder", { name: "Receipts", parent: "Work" });
  expect("creates a nested folder", created.text.includes("Work/Receipts"));
  const renamed = await call("email_rename_folder", { folder: "Work/Receipts", newName: "Bills" });
  expect("renames it", renamed.text.includes("Work/Bills"));
  const sysRename = await call("email_rename_folder", { folder: "sent", newName: "X" });
  expect("refuses to rename a system folder", sysRename.isError && sysRename.text.includes("system folder"));

  console.log("\nLIST & SUMMARY:");
  const list = await call("email_list", { limit: 2 });
  console.log(list.text.split("\n").map((l) => "    " + l).join("\n"));
  expect("newest first", list.text.indexOf("Trip plans") < list.text.indexOf("Flash sale"));
  expect("pages", list.text.includes("1 more — pass offset:2"));
  expect("marks unread and attachment", /Trip plans\n\s+UNREAD\s+\[attachment\]/.test(list.text));
  const unread = await call("email_list", { unreadOnly: true });
  expect("unreadOnly filters", ids(unread.text).length === 2);
  const summary = await call("email_mailbox_summary");
  console.log(summary.text.split("\n").map((l) => "    " + l).join("\n"));
  expect("summary counts unread", summary.text.includes("Inbox: 2 unread"));

  console.log("\nSEARCH:");
  const fromShop = await call("email_search", { from: "shop.example" });
  expect("from filter", ids(fromShop.text).length === 2);
  const withAtt = await call("email_search", { hasAttachment: true });
  expect("attachment filter", ids(withAtt.text).length === 1 && withAtt.text.includes("Trip plans"));
  const everywhere = await call("email_search", { subject: "Trip plans", allFolders: true });
  expect("allFolders finds inbox and sent", ids(everywhere.text).length === 2 && everywhere.text.includes("in Sent"));
  const none = await call("email_search", { subject: "nonexistent zzz" });
  expect("no matches is not an error", !none.isError && none.text.startsWith("No messages"));

  const janeId = ids(withAtt.text)[0];

  console.log("\nREAD:");
  const got = await call("email_get", { id: janeId });
  console.log(got.text.split("\n").map((l) => "    " + l).join("\n"));
  expect("headers and body", got.text.includes("From:    Jane Doe <jane@example.com>") && got.text.includes("Itinerary attached."));
  expect("lists the attachment", got.text.includes("1. itinerary.txt"));
  const stillUnread = await call("email_list", { unreadOnly: true });
  expect("reading does not mark read", ids(stillUnread.text).length === 2);
  const raw = await call("email_get_raw", { id: janeId });
  expect("raw headers only", raw.text.includes("Message-ID: <jane2@example.com>") && !raw.text.includes("Day 1"));
  const dl = await call("email_download_attachment", { id: janeId, index: 1, directory: downloads });
  const savedPath = dl.text.split("\n")[1];
  expect("saves the attachment", existsSync(savedPath) && readFileSync(savedPath, "utf8").includes("Day 1"));
  const dl2 = await call("email_download_attachment", { id: janeId, index: 1, directory: downloads });
  expect("never overwrites", dl2.text.includes("itinerary (1).txt"));

  const thread = await call("email_get_thread", { id: janeId });
  console.log(thread.text.split("\n").map((l) => "    " + l).join("\n"));
  expect("thread includes my sent message, oldest first", /\[1\/2\].*me@zoho\.com[\s\S]*\[2\/2\].*Jane/.test(thread.text));
  expect("thread strips quoted history", !thread.text.includes("> earlier text"));

  console.log("\nORGANIZE:");
  const marked = await call("email_mark", { ids: [janeId], read: true, flagged: true });
  expect("marks read+flagged", marked.text.includes("1 message read, flagged"));
  const flaggedSearch = await call("email_search", { flagged: true });
  expect("flag is visible to search", ids(flaggedSearch.text).length === 1);
  const kw = await call("email_set_keywords", { ids: [janeId], add: ["travel"] });
  expect("adds a keyword", !kw.isError);
  const byKw = await call("email_search", { keyword: "travel" });
  expect("keyword is searchable", ids(byKw.text).length === 1);

  const copied = await call("email_copy", { ids: [janeId], folder: "Work" });
  expect("copy returns new ids", /Copied 1 message from INBOX to Work[\s\S]*New ids:\nm_/.test(copied.text));
  const copyId = copied.text.match(/\n(m_[A-Za-z0-9_-]+)/)[1];
  const archived = await call("email_archive", { ids: [copyId] });
  expect("archive creates Archive when missing", archived.text.includes("to Archive"));
  const archivedId = archived.text.match(/\n(m_[A-Za-z0-9_-]+)/)[1];
  const stale = await call("email_get", { id: copyId });
  expect("an id from before a move no longer resolves", stale.isError);
  const trashed = await call("email_trash", { ids: [archivedId] });
  expect("trash moves to Trash", trashed.text.includes("to Trash"));
  const trashedId = trashed.text.match(/\n(m_[A-Za-z0-9_-]+)/)[1];
  const spam = await call("email_mark_spam", { ids: [trashedId] });
  const spamId = spam.text.match(/\n(m_[A-Za-z0-9_-]+)/)[1];
  expect("spam moves to Spam", spam.text.includes("to Spam"));
  const rescued = await call("email_not_spam", { ids: [spamId] });
  const rescuedId = rescued.text.match(/\n(m_[A-Za-z0-9_-]+)/)[1];
  expect("not spam returns to INBOX", rescued.text.includes("to INBOX"));
  const purged = await call("email_delete_permanently", { ids: [rescuedId] });
  expect("permanent delete", purged.text.includes("Permanently deleted 1 message from INBOX"));
  const inboxAfter = await call("email_list");
  expect("inbox back to 3", inboxAfter.text.includes("of 3 messages"));

  console.log("\nBULK:");
  const preview = await call("email_bulk_action", { from: "shop.example", action: "archive" });
  console.log(preview.text.split("\n").slice(0, 2).map((l) => "    " + l).join("\n"));
  expect("previews without changing", preview.text.startsWith("PREVIEW") && preview.text.includes("2 messages"));
  const inboxStill = await call("email_list");
  expect("preview changed nothing", inboxStill.text.includes("of 3 messages"));

  console.log("\nUNSUBSCRIBE:");
  const weekly = ids((await call("email_search", { subject: "Weekly deals" })).text)[0];
  const unsub = await call("email_unsubscribe", { id: weekly });
  console.log("    " + unsub.text);
  expect("one-click POST sent", unsubscribeHits.length === 1 && unsubscribeHits[0].method === "POST" && unsubscribeHits[0].body === "List-Unsubscribe=One-Click");
  const unsubMail = await call("email_unsubscribe", { id: weekly, method: "mailto" });
  console.log("    " + unsubMail.text);
  expect("mailto method sends an email", !unsubMail.isError && outbox.at(-1)?.rcpt.join() === "unsub@shop.example" && outbox.at(-1).parsed.subject === "stop");

  const confirmed = await call("email_bulk_action", { from: "shop.example", action: "archive", confirm: true });
  expect("confirmed bulk archive", confirmed.text.includes("Moved 2 messages") && confirmed.text.includes("to Archive"));

  console.log("\nSEND:");
  const before = outbox.length;
  const sent = await call("email_send", {
    to: ["Pat <pat@example.com>"],
    bcc: ["hidden@example.com"],
    subject: "Hello from MCP",
    body: "Plain body",
  });
  console.log(sent.text.split("\n").map((l) => "    " + l).join("\n"));
  const out = outbox[before];
  expect("delivered to to+bcc", out?.rcpt.sort().join() === "hidden@example.com,pat@example.com");
  expect("Bcc hidden in the message", out && !/^bcc:/im.test(out.raw.toString()));
  expect("From has display name", out?.parsed.from?.value[0].name === "Me" && out.parsed.from.value[0].address === "me@zoho.com");
  expect("copy appended to Sent when the server did not file one", sent.text.includes("copy appended to Sent"));
  const sentFolder = await call("email_search", { folder: "sent", subject: "Hello from MCP" });
  expect("Sent now holds it", ids(sentFolder.text).length === 1);
  const noRcpt = await call("email_send", { subject: "x", body: "y" });
  expect("refuses to send with no recipients", noRcpt.isError);

  console.log("\nREPLY & FORWARD:");
  const replyAll = await call("email_reply", { id: janeId, all: true, body: "Looks great!" });
  const reply = outbox.at(-1);
  expect("reply-all addressed to Jane, cc Bob, not me", reply.parsed.to.text.includes("jane@example.com") && reply.parsed.cc.text.includes("bob@example.com") && !reply.rcpt.includes("me@zoho.com"));
  expect("reply threads", reply.parsed.inReplyTo === "<jane2@example.com>" && [].concat(reply.parsed.references).includes("<me1@zoho.com>"));
  expect("reply subject and quote", reply.parsed.subject === "Re: Trip plans" && reply.parsed.text.includes("> Itinerary attached."));
  expect("reply call succeeded", !replyAll.isError);
  const answered = await call("email_search", { answered: true });
  expect("original marked replied", ids(answered.text).includes(janeId));

  const fwd = await call("email_forward", { id: janeId, to: ["sam@example.com"], note: "FYI" });
  const forward = outbox.at(-1);
  expect("forward keeps attachment", !fwd.isError && forward.parsed.attachments.some((a) => a.filename === "itinerary.txt"));
  expect("forward subject and note", forward.parsed.subject === "Fwd: Trip plans" && forward.parsed.text.startsWith("FYI"));

  console.log("\nDRAFTS:");
  const draft = await call("email_save_draft", { to: ["x@example.com"], bcc: ["y@example.com"], subject: "Draft one", body: "v1" });
  const draftId = draft.text.match(/Draft id: (m_\S+)/)[1];
  expect("draft saved without sending", outbox.at(-1) === forward);
  const updated = await call("email_update_draft", { id: draftId, body: "v2", subject: "Draft two" });
  const newDraftId = updated.text.match(/New draft id: (m_\S+)/)[1];
  const draftsList = await call("email_list", { folder: "drafts" });
  expect("update replaces the draft", ids(draftsList.text).length === 1 && draftsList.text.includes("Draft two"));
  const notDraft = await call("email_send_draft", { id: janeId });
  expect("refuses to send a non-draft", notDraft.isError);
  const sentDraft = await call("email_send_draft", { id: newDraftId });
  const fromDraft = outbox.at(-1);
  expect("draft sent with its Bcc", !sentDraft.isError && fromDraft.parsed.subject === "Draft two" && fromDraft.rcpt.includes("y@example.com"));
  expect("draft body updated", fromDraft.parsed.text.trim() === "v2");
  const draftsAfter = await call("email_list", { folder: "drafts" });
  expect("draft removed after sending", draftsAfter.text.includes("no messages"));
  const replyDraft = await call("email_reply", { id: janeId, body: "Draft reply", saveAsDraft: true });
  expect("reply can be saved as a draft", replyDraft.text.includes("Saved draft \"Re: Trip plans\""));

  console.log("\nCLEANUP TOOLS:");
  const emptyPreview = await call("email_empty_folder", { folder: "drafts" });
  expect("empty_folder refuses non-trash folders by default", emptyPreview.isError);
  await call("email_trash", { ids: [janeId] });
  const trashPreview = await call("email_empty_folder", { folder: "trash" });
  expect("empty trash previews first", trashPreview.text.includes("confirm:true"));
  const emptied = await call("email_empty_folder", { folder: "trash", confirm: true });
  expect("empties trash", emptied.text.startsWith("Emptied Trash"));
  const delFolder = await call("email_delete_folder", { folder: "Work/Bills" });
  expect("deletes a folder", delFolder.text.includes("Deleted folder Work/Bills"));
} finally {
  await client.close();
  imap.close();
  smtp.close();
  https.close();
  rmSync(configDir, { recursive: true, force: true });
  rmSync(downloads, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL ASSERTIONS PASSED" : `${failures} ASSERTION(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
