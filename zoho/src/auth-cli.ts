#!/usr/bin/env node
/**
 * Add or replace a Zoho account (`npm run auth`). Run separately from the MCP
 * server because a stdio server has no terminal to prompt on.
 *
 * Interactive by default. For scripting: --name, --email, --default, and the
 * app password on stdin when stdin is not a terminal.
 */
import { createInterface } from "node:readline/promises";
import { accountsPath, readAccountConfigs, writeAccountConfigs, type Account, type AccountConfig } from "./config.js";
import { withClient, closeAll } from "./imap.js";
import { describeError } from "./lib/errors.js";
import { verifySmtp } from "./smtp.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function ask(question: string, fallback?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `)).trim();
  rl.close();
  return answer || fallback || "";
}

/** Read a line without echoing it, so the password never shows on screen. */
async function askSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  process.stdout.write(`${question}: `);
  return new Promise((resolve) => {
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (key: string) => {
      for (const ch of key) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          // Drop bracketed-paste markers (ESC[200~ … ESC[201~), other control
          // characters, and the spaces Zoho shows between password groups.
          resolve(value.replace(/\u001b\[20[01]~/g, "").replace(/[\u0000-\u001f\u007f\s]+/g, ""));
          return;
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const existing = readAccountConfigs();
  const interactive = process.stdin.isTTY;

  console.log("Add a Zoho Mail account.\n");
  if (interactive) {
    console.log(
      "Before you start:\n" +
        "  1. Zoho Mail > Settings > Mail Accounts > IMAP: turn IMAP access on.\n" +
        "  2. accounts.zoho.com > Security > App Passwords: generate one for \"Claude MCP\".\n" +
        "     (Your normal password will not work when two-factor sign-in is on.)\n",
    );
  }

  const email = flag("email") ?? (await ask("Zoho email address"));
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error(`"${email}" is not an email address.`);
  const prior = existing.find((a) => a.email.toLowerCase() === email.toLowerCase());
  const suggested = prior?.name ?? email.split("@")[0];
  const name = flag("name") ?? (interactive ? await ask("Short name for this account", suggested) : suggested);
  const fromName = flag("from-name") ?? (interactive ? await ask("Display name on sent mail (optional)", prior?.fromName) : prior?.fromName);
  const appPassword = await askSecret("App-specific password");
  if (!appPassword) throw new Error("No password given.");

  const personal = email.toLowerCase().endsWith("@zoho.com") || email.toLowerCase().endsWith("@zohomail.com");
  const config: AccountConfig = {
    ...prior,
    name,
    email,
    appPassword,
    fromName: fromName || undefined,
    // Custom-domain (organization) mailboxes use the "pro" hosts.
    imapHost: flag("imap-host") ?? prior?.imapHost ?? (personal ? undefined : "imappro.zoho.com"),
    smtpHost: flag("smtp-host") ?? prior?.smtpHost ?? (personal ? undefined : "smtppro.zoho.com"),
  };
  const account: Account = {
    ...config,
    imapHost: config.imapHost ?? "imap.zoho.com",
    imapPort: config.imapPort ?? 993,
    smtpHost: config.smtpHost ?? "smtp.zoho.com",
    smtpPort: config.smtpPort ?? 465,
  };

  console.log(`\nPassword received: ${appPassword.length} characters.`);
  // Zoho serves some custom-domain mailboxes from the personal hosts and vice
  // versa, so when no host was given explicitly, fall back to the other pair.
  const hostPairs: [string, string][] = [[account.imapHost, account.smtpHost]];
  if (!flag("imap-host") && !prior?.imapHost) {
    const swap = account.imapHost.startsWith("imappro.")
      ? ["imap.zoho.com", "smtp.zoho.com"]
      : ["imappro.zoho.com", "smtppro.zoho.com"];
    hostPairs.push(swap as [string, string]);
  }
  let lastErr: unknown;
  for (const [imapHost, smtpHost] of hostPairs) {
    process.stdout.write(`Checking IMAP login at ${imapHost}… `);
    try {
      const candidate = { ...account, name: `${account.name}@${imapHost}`, imapHost, smtpHost };
      const count = await withClient(candidate, async (c) => (await c.list()).length);
      console.log(`ok (${count} folders)`);
      account.imapHost = imapHost;
      account.smtpHost = smtpHost;
      config.imapHost = imapHost === "imap.zoho.com" ? undefined : imapHost;
      config.smtpHost = smtpHost === "smtp.zoho.com" ? undefined : smtpHost;
      lastErr = undefined;
      break;
    } catch (err) {
      const e = err as { responseText?: string; serverResponseCode?: string };
      console.log(`FAILED${e.responseText ? ` — Zoho said: "${e.responseText}"` : e.serverResponseCode ? ` — ${e.serverResponseCode}` : ""}`);
      lastErr = err;
    }
  }
  if (lastErr) throw new Error(describeError(lastErr));
  process.stdout.write(`Checking SMTP login at ${account.smtpHost}… `);
  try {
    await verifySmtp(account);
    console.log("ok");
  } catch (err) {
    console.log("FAILED");
    throw new Error(describeError(err));
  }

  const others = existing.filter((a) => a.email.toLowerCase() !== email.toLowerCase() && a.name.toLowerCase() !== name.toLowerCase());
  const makeDefault = process.argv.includes("--default") || others.length === 0 || (prior?.default ?? false);
  const next = [...others.map((a) => (makeDefault ? { ...a, default: undefined } : a)), { ...config, default: makeDefault || undefined }];
  writeAccountConfigs(next);
  console.log(`\nSaved "${name}" to ${accountsPath()}${makeDefault ? " as the default account" : ""}.`);
  console.log(`${next.length} account${next.length === 1 ? "" : "s"} configured. Restart Claude Code to pick up changes.`);
}

main()
  .catch((err: unknown) => {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => closeAll());
