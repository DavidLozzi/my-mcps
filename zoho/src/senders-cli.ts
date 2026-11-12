#!/usr/bin/env node
/**
 * Track every sender the mailbox has heard from, and report new ones
 * (`npm run senders -- inventory|check`).
 *
 *   inventory  Record the sender of every message in every folder except Sent
 *              and Drafts. Trash counts, so purged senders stay known.
 *   check      Look at INBOX mail that arrived since the last run and list
 *              senders never seen before, split into subscriptions (the message
 *              carries List-Unsubscribe, List-Id, or Precedence: bulk/list) and
 *              everyone else. New senders are then added to the inventory.
 *              Mail from senders marked unsubscribed is reported too.
 *   unsubscribed <address>...
 *              Mark senders as unsubscribed (adding them if unknown).
 *
 * State lives beside accounts.json as senders-<account>.json (mode 600).
 * Read-only against the mailbox: folders are opened with EXAMINE.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImapFlow } from "imapflow";
import { configDir, resolveAccount, selfAddresses, type Account } from "./config.js";
import { closeAll, findSpecial, isSelectable, listFolders, withClient, withMailbox } from "./imap.js";
import { describeError } from "./lib/errors.js";

interface Sender {
  name: string;
  first: string;
  last: string;
  count: number;
  subscription: boolean;
  /** When the user said they unsubscribed; mail after this is reported. */
  unsubscribed?: string;
}

/** "2026-11-10 08:17" in the Mac's local time. */
function localTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface State {
  account: string;
  updated: string;
  inbox?: { uidValidity: string; lastUid: number; checked?: string };
  senders: Record<string, Sender>;
}

interface Seen {
  uid: number;
  address: string;
  name: string;
  subject: string;
  date: string;
  subscription: boolean;
}

const LIST_HEADERS = ["list-unsubscribe", "list-id", "precedence"];

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function statePath(account: Account): string {
  return join(configDir(), `senders-${account.name}.json`);
}

function readState(account: Account): State {
  const path = statePath(account);
  if (!existsSync(path)) return { account: account.email, updated: "", senders: {} };
  return JSON.parse(readFileSync(path, "utf8")) as State;
}

function writeState(account: Account, state: State): void {
  state.updated = new Date().toISOString();
  writeFileSync(statePath(account), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

function isSubscription(headers: Buffer | undefined): boolean {
  const text = headers?.toString("utf8").toLowerCase() ?? "";
  return /^(list-unsubscribe|list-id):/m.test(text) || /^precedence:\s*(bulk|list)/m.test(text);
}

/** Every message in a folder (or those after a UID), with sender and list headers. */
async function scan(client: ImapFlow, range: string, self: Set<string>): Promise<Seen[]> {
  const out: Seen[] = [];
  for await (const m of client.fetch(range, { uid: true, envelope: true, headers: LIST_HEADERS }, { uid: true })) {
    const from = m.envelope?.from?.[0];
    const address = from?.address?.toLowerCase();
    if (!address || self.has(address)) continue;
    out.push({
      uid: m.uid,
      address,
      name: from?.name ?? "",
      subject: m.envelope?.subject ?? "(no subject)",
      date: new Date(m.envelope?.date ?? Date.now()).toISOString(),
      subscription: isSubscription(m.headers),
    });
  }
  return out;
}

function record(state: State, seen: Seen): boolean {
  const known = state.senders[seen.address];
  if (known) {
    known.count++;
    if (seen.date > known.last) known.last = seen.date;
    if (seen.date < known.first) known.first = seen.date;
    if (seen.name) known.name = seen.name;
    known.subscription ||= seen.subscription;
    return false;
  }
  state.senders[seen.address] = { name: seen.name, first: seen.date, last: seen.date, count: 1, subscription: seen.subscription };
  return true;
}

async function inventory(account: Account): Promise<void> {
  const state = readState(account);
  const self = selfAddresses(account);
  const counts = new Map<string, Sender>(Object.entries(state.senders));
  state.senders = {};
  const folders = await withClient(account, async (c) => {
    const skip = new Set([(await findSpecial(c, "\\Sent"))?.path, (await findSpecial(c, "\\Drafts"))?.path]);
    return (await listFolders(c)).filter((f) => isSelectable(f) && !skip.has(f.path) && !/^sent messages$/i.test(f.name));
  });
  let total = 0;
  for (const f of folders) {
    const seen = await withMailbox(
      account,
      f.path,
      async (c) => {
        const mb = c.mailbox;
        const box = mb && typeof mb === "object" ? mb : undefined;
        if (f.path.toUpperCase() === "INBOX" && box) {
          const uids = (await c.search({ all: true }, { uid: true })) || [];
          state.inbox = { uidValidity: String(box.uidValidity), lastUid: uids.length ? Math.max(...uids) : 0 };
        }
        return box && box.exists > 0 ? scan(c, "1:*", self) : [];
      },
      { readOnly: true },
    );
    for (const s of seen) record(state, s);
    total += seen.length;
    console.log(`  ${f.path}: ${seen.length} messages`);
  }
  // Keep senders recorded earlier whose mail has since been purged for good.
  for (const [address, s] of counts) state.senders[address] ??= s;
  writeState(account, state);
  const subs = Object.values(state.senders).filter((s) => s.subscription).length;
  console.log(`\n${total} messages scanned. ${Object.keys(state.senders).length} known senders (${subs} send list mail).`);
  console.log(`Saved to ${statePath(account)}.`);
}

async function check(account: Account): Promise<void> {
  const state = readState(account);
  if (!state.inbox) throw new Error("No inventory yet. Run `npm run senders -- inventory` first.");
  const self = selfAddresses(account);
  const prior = state.inbox;
  const seen = await withMailbox(
    account,
    "INBOX",
    async (c) => {
      const mb = c.mailbox;
      if (!mb || typeof mb !== "object") return [];
      const validity = String(mb.uidValidity);
      let range = `${prior.lastUid + 1}:*`;
      if (validity !== prior.uidValidity) {
        // UIDs were reset; fall back to everything since the last run.
        const since = new Date(state.updated || Date.now() - 864e5);
        const uids = (await c.search({ since }, { uid: true })) || [];
        range = uids.length ? uids.join(",") : "";
      }
      // "N:*" always returns the newest message even when N is past it, so filter.
      const found = range ? (await scan(c, range, self)).filter((s) => validity !== prior.uidValidity || s.uid > prior.lastUid) : [];
      const uids = (await c.search({ all: true }, { uid: true })) || [];
      state.inbox = {
        uidValidity: validity,
        lastUid: Math.max(prior.lastUid, ...uids, ...found.map((s) => s.uid)),
        checked: new Date().toISOString(),
      };
      return found;
    },
    { readOnly: true },
  );

  const fresh = new Map<string, Seen[]>();
  const ignoring = new Map<string, Seen[]>();
  for (const s of seen.sort((a, b) => a.date.localeCompare(b.date))) {
    const cut = state.senders[s.address]?.unsubscribed;
    if (cut && s.date > cut) ignoring.set(s.address, [...(ignoring.get(s.address) ?? []), s]);
    const isNew = !state.senders[s.address] || fresh.has(s.address);
    if (isNew) fresh.set(s.address, [...(fresh.get(s.address) ?? []), s]);
    record(state, s);
  }
  writeState(account, state);

  const groups = [...fresh.values()];
  const subs = groups.filter((g) => g.some((s) => s.subscription));
  const others = groups.filter((g) => !g.some((s) => s.subscription));
  const line = (g: Seen[]) => {
    const s = g[g.length - 1];
    const who = s.name ? `${s.name} <${s.address}>` : s.address;
    return `  ${who}\n    "${s.subject}"${g.length > 1 ? ` (+${g.length - 1} more)` : ""}  ${localTime(s.date)}`;
  };
  const since = prior.checked ? ` since ${localTime(prior.checked)}` : " since the last run";
  console.log(`Check at ${localTime(new Date().toISOString())}: ${seen.length} new inbox message${seen.length === 1 ? "" : "s"}${since}.`);
  console.log(`\nNEW SUBSCRIPTIONS (${subs.length})`);
  console.log(subs.length ? subs.map(line).join("\n") : "  none");
  console.log(`\nOTHER NEW SENDERS (${others.length})`);
  console.log(others.length ? others.map(line).join("\n") : "  none");
  console.log(`\nSTILL SENDING AFTER UNSUBSCRIBE (${ignoring.size})`);
  console.log(ignoring.size ? [...ignoring.values()].map(line).join("\n") : "  none");
}

async function unsubscribed(account: Account): Promise<void> {
  const addresses = process.argv.slice(3).filter((a) => a.includes("@")).map((a) => a.toLowerCase());
  if (addresses.length === 0) throw new Error("Give one or more addresses.");
  const state = readState(account);
  const now = new Date().toISOString();
  for (const address of addresses) {
    const known = state.senders[address];
    state.senders[address] = { ...(known ?? { name: "", first: now, last: now, count: 0, subscription: true }), unsubscribed: now };
    console.log(`  ${address}${known ? "" : " (not seen before, added)"}`);
  }
  writeState(account, state);
  console.log(`Marked ${addresses.length} sender${addresses.length === 1 ? "" : "s"} unsubscribed.`);
}

const command = process.argv[2];
const account = resolveAccount(flag("account"));
const run = command === "inventory" ? inventory : command === "check" ? check : command === "unsubscribed" ? unsubscribed : undefined;
if (!run) {
  console.error("Usage: npm run senders -- inventory|check|unsubscribed <address>... [--account <name>]");
  process.exit(2);
}
run(account)
  .catch((err: unknown) => {
    console.error(describeError(err));
    process.exitCode = 1;
  })
  .finally(() => closeAll());
