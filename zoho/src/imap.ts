import { ImapFlow, type ListResponse, type MailboxObject } from "imapflow";
import type { Account } from "./config.js";
import { ZohoError } from "./lib/errors.js";

/** Close a connection nobody has used for this long. */
const IDLE_CLOSE_MS = 5 * 60 * 1000;

interface Pooled {
  client: Promise<ImapFlow>;
  resolved?: ImapFlow;
  timer?: NodeJS.Timeout;
}

const pool = new Map<string, Pooled>();

function evict(name: string, client?: ImapFlow): void {
  const entry = pool.get(name);
  if (!entry) return;
  clearTimeout(entry.timer);
  pool.delete(name);
  client?.logout().catch(() => client.close());
}

async function open(account: Account): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: true,
    auth: { user: account.email, pass: account.appPassword },
    logger: false,
    clientInfo: { name: "zoho-mcp", version: "0.1.0" },
    // Test suite only: its local mock servers use a self-signed certificate.
    ...(process.env.ZOHO_TEST_INSECURE_TLS === "1" ? { tls: { rejectUnauthorized: false } } : {}),
  });
  // An unhandled 'error' event would crash the process. Drop this connection
  // from the pool (only if it is still the pooled one) and the next call reconnects.
  const drop = () => {
    if (pool.get(account.name)?.resolved === client) evict(account.name);
  };
  client.on("error", drop);
  client.on("close", drop);
  await client.connect();
  return client;
}

async function getClient(account: Account): Promise<ImapFlow> {
  let entry = pool.get(account.name);
  if (entry) {
    const client = await entry.client.catch(() => undefined);
    if (client?.usable) {
      touch(account.name, client);
      return client;
    }
    evict(account.name, client);
  }
  entry = { client: open(account) };
  pool.set(account.name, entry);
  try {
    const client = await entry.client;
    entry.resolved = client;
    touch(account.name, client);
    return client;
  } catch (err) {
    pool.delete(account.name);
    throw err;
  }
}

function touch(name: string, client: ImapFlow): void {
  const entry = pool.get(name);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => evict(name, client), IDLE_CLOSE_MS);
  entry.timer.unref();
}

export async function closeAll(): Promise<void> {
  await Promise.all(
    [...pool.entries()].map(async ([name, entry]) => {
      clearTimeout(entry.timer);
      pool.delete(name);
      const client = await entry.client.catch(() => undefined);
      await client?.logout().catch(() => undefined);
    }),
  );
}

export async function withClient<T>(account: Account, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = await getClient(account);
  return fn(client);
}

/**
 * Run fn with `path` selected. readOnly uses EXAMINE, so reading a message can
 * never mark it seen as a side effect.
 */
export async function withMailbox<T>(
  account: Account,
  path: string,
  fn: (client: ImapFlow, mailbox: MailboxObject) => Promise<T>,
  options: { readOnly?: boolean } = {},
): Promise<T> {
  const client = await getClient(account);
  const lock = await client.getMailboxLock(path, { readOnly: options.readOnly ?? false });
  try {
    return await fn(client, client.mailbox as MailboxObject);
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export type SpecialUse = "\\Inbox" | "\\Sent" | "\\Drafts" | "\\Trash" | "\\Junk" | "\\Archive";

const SPECIAL_ALIASES: Record<string, SpecialUse> = {
  inbox: "\\Inbox",
  sent: "\\Sent",
  "sent mail": "\\Sent",
  "sent items": "\\Sent",
  drafts: "\\Drafts",
  draft: "\\Drafts",
  trash: "\\Trash",
  deleted: "\\Trash",
  bin: "\\Trash",
  spam: "\\Junk",
  junk: "\\Junk",
  archive: "\\Archive",
  archives: "\\Archive",
};

export async function listFolders(client: ImapFlow): Promise<ListResponse[]> {
  return client.list();
}

function selectable(f: ListResponse): boolean {
  return !f.flags.has("\\Noselect") && !f.flags.has("\\NonExistent");
}

export async function findSpecial(client: ImapFlow, use: SpecialUse): Promise<ListResponse | undefined> {
  const folders = await listFolders(client);
  if (use === "\\Inbox") return folders.find((f) => f.path.toUpperCase() === "INBOX");
  return folders.find((f) => f.specialUse === use && selectable(f));
}

/** The special folder, created under a sensible name when the server has none. */
export async function ensureSpecial(client: ImapFlow, use: SpecialUse, fallbackName: string): Promise<string> {
  const found = await findSpecial(client, use);
  if (found) return found.path;
  const created = await client.mailboxCreate(fallbackName);
  return created.path;
}

/**
 * Accept what a person would type — an exact path, a folder name in any case,
 * or a role like "sent" or "spam" — and return the server's path.
 */
export async function resolveFolder(client: ImapFlow, ref: string | undefined): Promise<string> {
  if (!ref || ref.toUpperCase() === "INBOX") return "INBOX";
  const folders = (await listFolders(client)).filter(selectable);
  const exact = folders.find((f) => f.path === ref);
  if (exact) return exact.path;
  const key = ref.toLowerCase();
  const byPath = folders.filter((f) => f.path.toLowerCase() === key);
  if (byPath.length === 1) return byPath[0].path;
  const role = SPECIAL_ALIASES[key];
  if (role) {
    const special = role === "\\Inbox" ? folders.find((f) => f.path.toUpperCase() === "INBOX") : folders.find((f) => f.specialUse === role);
    if (special) return special.path;
  }
  const byName = folders.filter((f) => f.name.toLowerCase() === key);
  if (byName.length === 1) return byName[0].path;
  if (byName.length > 1) {
    throw new ZohoError(`"${ref}" matches several folders: ${byName.map((f) => f.path).join(", ")}. Pass the full path.`);
  }
  throw new ZohoError(`No folder "${ref}". Folders: ${folders.map((f) => f.path).join(", ")}.`);
}

export function isSelectable(f: ListResponse): boolean {
  return selectable(f);
}
