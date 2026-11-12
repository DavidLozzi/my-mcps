/**
 * Pure-function tests for the pieces most likely to be subtly wrong: message
 * ids, search translation, reply/forward addressing and threading, and the
 * MIME a sent message is built from.
 */
import { simpleParser } from "mailparser";
import { decodeId, encodeId, groupIds } from "../dist/lib/ids.js";
import { buildSearch } from "../dist/lib/search.js";
import { prefixSubject, replyRecipients, threadHeaders, replyText, forwardText } from "../dist/lib/compose.js";
import { hasAttachment, stripQuoted, unsubscribeOptions, bodyText } from "../dist/lib/render.js";
import { buildMessage } from "../dist/smtp.js";

let failures = 0;
const expect = (desc, condition) => {
  if (!condition) failures++;
  console.log(`  ${condition ? "PASS" : "FAIL"}: ${desc}`);
};
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

console.log("IDS:");
const ref = { account: "personal", folder: "Work/Clients — 2026", uidValidity: "1700000000", uid: 4242 };
const id = encodeId(ref);
expect("round-trips a folder with slashes and unicode", JSON.stringify(decodeId(id)) === JSON.stringify(ref));
expect("rejects junk", throws(() => decodeId("m_notbase64!!")) && throws(() => decodeId("4242")));
const groups = groupIds([id, encodeId({ ...ref, uid: 1 }), encodeId({ ...ref, folder: "INBOX", uid: 7 }), id]);
expect("groups by folder and de-duplicates", groups.length === 2 && groups[0].uids.join() === "4242,1");
expect(
  "mixed UIDVALIDITY in one folder fails",
  throws(() => groupIds([id, encodeId({ ...ref, uidValidity: "1", uid: 9 })])),
);

console.log("\nSEARCH:");
expect("no filters means all", buildSearch({}).all === true);
const q = buildSearch({ from: "amazon", unread: true, since: "2026-11-01", largerThanKb: 1 });
expect("unread maps to seen:false", q.seen === false);
expect("since is local midnight", q.since instanceof Date && q.since.getHours() === 0 && q.since.getDate() === 1);
expect("size in KB becomes bytes", q.larger === 1024);
expect("hasAttachment narrows on content-type", buildSearch({ hasAttachment: true }).header["content-type"] === "multipart/mixed");

console.log("\nSUBJECTS:");
expect("adds Re:", prefixSubject("Re", "Lunch") === "Re: Lunch");
expect("does not stack Re:", prefixSubject("Re", "RE: Lunch") === "RE: Lunch");
expect("does not stack Fwd:", prefixSubject("Fwd", "Fw: Lunch") === "Fw: Lunch");

const self = new Set(["me@zoho.com", "alias@me.dev"]);
const incoming = await simpleParser(
  [
    "From: Jane <jane@example.com>",
    "To: me@zoho.com, Bob <bob@example.com>",
    "Cc: alias@me.dev, carol@example.com, JANE@example.com",
    "Subject: Plans",
    "Message-ID: <m2@example.com>",
    "References: <m0@example.com> <m1@example.com>",
    "Date: Mon, 2 Nov 2026 10:00:00 -0500",
    "",
    "See you there.",
    "",
  ].join("\r\n"),
);

console.log("\nREPLY ADDRESSING:");
const single = replyRecipients(incoming, self, false);
expect("reply goes to the sender only", single.to.map((a) => a.address).join() === "jane@example.com" && single.cc.length === 0);
const all = replyRecipients(incoming, self, true);
expect("reply-all keeps others", all.cc.map((a) => a.address).sort().join() === "bob@example.com,carol@example.com");
expect("reply-all drops every self address and the sender's duplicate", !all.cc.some((a) => self.has(a.address.toLowerCase()) || /jane/i.test(a.address)));

const withReplyTo = await simpleParser("From: news@shop.com\r\nReply-To: help@shop.com\r\nTo: me@zoho.com\r\nSubject: x\r\n\r\nhi\r\n");
expect("Reply-To wins over From", replyRecipients(withReplyTo, self, false).to[0].address === "help@shop.com");

const mine = await simpleParser("From: me@zoho.com\r\nTo: dave@example.com\r\nCc: me@zoho.com\r\nSubject: x\r\n\r\nhi\r\n");
const toMine = replyRecipients(mine, self, true);
expect("replying to my own sent message goes to its recipients", toMine.to.map((a) => a.address).join() === "dave@example.com");

console.log("\nTHREADING:");
const t = threadHeaders(incoming);
expect("In-Reply-To is the original Message-ID", t.inReplyTo === "<m2@example.com>");
expect("References extends the chain", t.references.join(" ") === "<m0@example.com> <m1@example.com> <m2@example.com>");
expect("quoted reply prefixes the original", replyText(incoming, "Sounds good").includes("> See you there."));
expect("forward carries the original header block", forwardText(incoming, "FYI").includes("From: Jane <jane@example.com>"));
expect("stripQuoted removes the history", stripQuoted(replyText(incoming, "Sounds good")) === "Sounds good");

console.log("\nPARSING:");
const unsub = await simpleParser(
  "From: a@b.com\r\nList-Unsubscribe: <mailto:u@b.com?subject=stop>,\r\n <https://b.com/u/1>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\nSubject: x\r\n\r\nhi\r\n",
);
const opts = unsubscribeOptions(unsub);
expect("reads folded List-Unsubscribe with both methods", opts?.mailto[0] === "mailto:u@b.com?subject=stop" && opts?.urls[0] === "https://b.com/u/1");
expect("detects one-click", opts?.oneClick === true);
const html = await simpleParser("From: a@b.com\r\nContent-Type: text/html\r\nSubject: x\r\n\r\n<p>Hello <b>there</b></p><img src=x>\r\n");
expect("HTML-only body becomes text", bodyText(html).startsWith("Hello there") && !bodyText(html).includes("<"));
expect(
  "attachment detection ignores inline images",
  hasAttachment({ type: "multipart/mixed", childNodes: [{ type: "text/plain" }, { type: "image/png", disposition: "inline", dispositionParameters: { filename: "a.png" } }] }) === false &&
    hasAttachment({ type: "multipart/mixed", childNodes: [{ type: "text/plain" }, { type: "application/pdf", disposition: "attachment" }] }) === true,
);

console.log("\nBUILD:");
const account = { name: "p", email: "me@zoho.com", appPassword: "x", fromName: "Me", imapHost: "", imapPort: 993, smtpHost: "", smtpPort: 465 };
const mail = { to: ["jane@example.com"], bcc: ["secret@example.com"], subject: "Hi ✓", text: "Body", inReplyTo: "<m2@example.com>", references: ["<m2@example.com>"] };
const sent = await buildMessage(account, mail);
const sentText = sent.raw.toString();
expect("envelope includes Bcc", sent.envelope.to.includes("secret@example.com"));
expect("sent bytes hide Bcc", !/^bcc:/im.test(sentText));
expect("Message-ID header matches the one returned", sentText.includes(`Message-ID: ${sent.messageId}`));
expect("From uses the display name", /^From: Me <me@zoho\.com>/m.test(sentText));
expect("threading headers present", /^In-Reply-To: <m2@example\.com>/m.test(sentText));
const draft = await buildMessage(account, mail, { keepBcc: true });
expect("a draft remembers Bcc", /^bcc: secret@example\.com/im.test(draft.raw.toString()));
const reparsed = await simpleParser(sent.raw);
expect("unicode subject survives", reparsed.subject === "Hi ✓");

console.log(`\n${failures === 0 ? "ALL ASSERTIONS PASSED" : `${failures} ASSERTION(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
