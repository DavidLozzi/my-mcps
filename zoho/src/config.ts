import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ZohoError } from "./lib/errors.js";

const AccountSchema = z.object({
  name: z.string().min(1),
  email: z.email(),
  appPassword: z.string().min(1),
  fromName: z.string().optional(),
  /** Extra addresses that are also "me", so reply-all leaves them out. */
  aliases: z.array(z.string()).optional(),
  imapHost: z.string().optional(),
  imapPort: z.number().int().optional(),
  smtpHost: z.string().optional(),
  smtpPort: z.number().int().optional(),
  default: z.boolean().optional(),
});

const FileSchema = z.array(AccountSchema);

export type AccountConfig = z.infer<typeof AccountSchema>;

export interface Account extends AccountConfig {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
}

export function configDir(): string {
  return process.env.ZOHO_CONFIG_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", ".credentials");
}

export function accountsPath(): string {
  return join(configDir(), "accounts.json");
}

function withDefaults(a: AccountConfig): Account {
  return {
    ...a,
    imapHost: a.imapHost ?? process.env.ZOHO_IMAP_HOST ?? "imap.zoho.com",
    imapPort: a.imapPort ?? 993,
    smtpHost: a.smtpHost ?? process.env.ZOHO_SMTP_HOST ?? "smtp.zoho.com",
    smtpPort: a.smtpPort ?? 465,
  };
}

export function readAccountConfigs(): AccountConfig[] {
  const path = accountsPath();
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ZohoError(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = FileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ZohoError(`${path} is malformed: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

export function writeAccountConfigs(accounts: AccountConfig[]): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = accountsPath();
  writeFileSync(path, JSON.stringify(accounts, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function loadAccounts(): Account[] {
  const accounts = readAccountConfigs();
  if (accounts.length === 0) {
    throw new ZohoError(
      `No Zoho accounts configured. Run \`npm run auth\` in the zoho server directory to add one (stored in ${accountsPath()}).`,
    );
  }
  return accounts.map(withDefaults);
}

/** The named account (by name or email, case-insensitive), or the default one. */
export function resolveAccount(ref?: string): Account {
  const accounts = loadAccounts();
  if (!ref) {
    return accounts.find((a) => a.default) ?? accounts[0];
  }
  const key = ref.toLowerCase();
  const found = accounts.find((a) => a.name.toLowerCase() === key || a.email.toLowerCase() === key);
  if (!found) {
    throw new ZohoError(`No account "${ref}". Configured: ${accounts.map((a) => a.name).join(", ")}.`);
  }
  return found;
}

/** Every address that means "this account" — used to leave the sender out of reply-all. */
export function selfAddresses(account: Account): Set<string> {
  return new Set([account.email, ...(account.aliases ?? [])].map((a) => a.toLowerCase()));
}
