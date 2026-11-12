import { ZohoError } from "./errors.js";

/**
 * A message id names one message in one folder of one account. IMAP UIDs are
 * only meaningful together with the folder's UIDVALIDITY, so that rides along
 * too: if the server ever renumbers the folder, an old id fails loudly instead
 * of silently pointing at a different message.
 */
export interface MessageRef {
  account: string;
  folder: string;
  uidValidity: string;
  uid: number;
}

const PREFIX = "m_";

export function encodeId(ref: MessageRef): string {
  const payload = JSON.stringify([ref.account, ref.folder, ref.uidValidity, ref.uid]);
  return PREFIX + Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeId(id: string): MessageRef {
  const bad = () => new ZohoError(`"${id}" is not a message id. Use an id from email_list or email_search.`);
  if (!id.startsWith(PREFIX)) throw bad();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(id.slice(PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 4 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string" ||
    typeof parsed[2] !== "string" ||
    !Number.isInteger(parsed[3])
  ) {
    throw bad();
  }
  return { account: parsed[0], folder: parsed[1], uidValidity: parsed[2], uid: parsed[3] };
}

export interface FolderGroup {
  account: string;
  folder: string;
  uidValidity: string;
  uids: number[];
}

/** Group a batch of ids by account and folder, so each folder is opened once. */
export function groupIds(ids: string[]): FolderGroup[] {
  const groups = new Map<string, FolderGroup>();
  for (const id of ids) {
    const ref = decodeId(id);
    const key = JSON.stringify([ref.account, ref.folder]);
    let group = groups.get(key);
    if (!group) {
      group = { account: ref.account, folder: ref.folder, uidValidity: ref.uidValidity, uids: [] };
      groups.set(key, group);
    } else if (group.uidValidity !== ref.uidValidity) {
      throw staleError(ref.folder);
    }
    if (!group.uids.includes(ref.uid)) group.uids.push(ref.uid);
  }
  return [...groups.values()];
}

export function staleError(folder: string): ZohoError {
  return new ZohoError(
    `The server renumbered folder "${folder}" since this id was issued, so it no longer identifies a message. ` +
      `List or search again for fresh ids.`,
  );
}

export function checkValidity(folder: string, expected: string, actual: bigint): void {
  if (String(actual) !== expected) throw staleError(folder);
}
