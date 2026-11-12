import type { ImapFlow, MailboxObject } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { resolveAccount, type Account } from "./config.js";
import { withClient, withMailbox } from "./imap.js";
import { ZohoError } from "./lib/errors.js";
import { checkValidity, decodeId, encodeId, groupIds, type MessageRef } from "./lib/ids.js";
import { toSummary, type Summary } from "./lib/render.js";

export const SUMMARY_QUERY = { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true } as const;

export function idFor(account: Account, mailbox: MailboxObject, uid: number): string {
  return encodeId({ account: account.name, folder: mailbox.path, uidValidity: String(mailbox.uidValidity), uid });
}

/** Fetch summaries for UIDs in the open mailbox, newest first. */
export async function fetchSummaries(
  client: ImapFlow,
  account: Account,
  mailbox: MailboxObject,
  uids: number[],
): Promise<Summary[]> {
  if (uids.length === 0) return [];
  const msgs = await client.fetchAll(uids, SUMMARY_QUERY, { uid: true });
  return msgs
    .map((m) => toSummary(m, mailbox.path, idFor(account, mailbox, m.uid)))
    .sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0) || b.uid - a.uid);
}

export interface LoadedMessage {
  ref: MessageRef;
  account: Account;
  id: string;
  flags: Set<string>;
  source: Buffer;
  parsed: ParsedMail;
}

/** Load and parse one message by id without changing its flags. */
export async function loadMessage(id: string): Promise<LoadedMessage> {
  const ref = decodeId(id);
  const account = resolveAccount(ref.account);
  const msg = await withMailbox(
    account,
    ref.folder,
    async (client, mailbox) => {
      checkValidity(ref.folder, ref.uidValidity, mailbox.uidValidity);
      return client.fetchOne(String(ref.uid), { uid: true, flags: true, source: true }, { uid: true });
    },
    { readOnly: true },
  );
  if (!msg || !msg.source) {
    throw new ZohoError(`Message not found in ${ref.folder} — it may have been moved or deleted. Search again for a fresh id.`);
  }
  const parsed = await simpleParser(msg.source, { skipImageLinks: true });
  return { ref, account, id, flags: msg.flags ?? new Set(), source: msg.source, parsed };
}

/**
 * Run fn once per folder for a batch of ids, with the folder opened read-write.
 * Every id is decoded and every folder's UIDVALIDITY checked before fn runs on
 * any of them, so a stale id fails the batch rather than half of it.
 */
export async function forEachFolder<T>(
  ids: string[],
  fn: (client: ImapFlow, mailbox: MailboxObject, uids: number[], account: Account) => Promise<T>,
): Promise<T[]> {
  const groups = groupIds(ids);
  const accounts = groups.map((g) => resolveAccount(g.account));
  for (const [i, group] of groups.entries()) {
    const status = await withClient(accounts[i], (c) => c.status(group.folder, { uidValidity: true }));
    if (!status || status.uidValidity === undefined) {
      throw new ZohoError(`Folder "${group.folder}" no longer exists. Search again for fresh ids.`);
    }
    checkValidity(group.folder, group.uidValidity, status.uidValidity);
  }
  const results: T[] = [];
  for (const [i, group] of groups.entries()) {
    results.push(
      await withMailbox(accounts[i], group.folder, async (client, mailbox) => {
        checkValidity(group.folder, group.uidValidity, mailbox.uidValidity);
        return fn(client, mailbox, group.uids, accounts[i]);
      }),
    );
  }
  return results;
}
