#!/usr/bin/env node
/**
 * One-time browser consent flow. Run separately from the MCP server (`npm run
 * auth`) because a stdio server has no TTY and cannot drive a browser.
 *
 * Google removed the out-of-band flow, so this binds a loopback listener on an
 * ephemeral port and uses it as the redirect URI.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { AddressInfo } from "node:net";
import {
  SCOPE,
  createOAuthClient,
  loadClientCredentials,
  saveToken,
  tokenPath,
} from "./auth.js";

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  const child = spawn(command, [url], { detached: true, stdio: "ignore", shell: process.platform === "win32" });
  child.on("error", () => {
    /* Falls back to the printed URL. */
  });
  child.unref();
}

const HTML_OK = `<!doctype html><meta charset="utf-8"><title>Connected</title>
<body style="font:16px system-ui;padding:3rem;max-width:32rem">
<h1>Google Analytics connected</h1>
<p>You can close this tab and return to the terminal.</p>`;

const HTML_ERR = (msg: string) => `<!doctype html><meta charset="utf-8"><title>Failed</title>
<body style="font:16px system-ui;padding:3rem;max-width:32rem">
<h1>Authorization failed</h1><p>${msg}</p>`;

async function waitForCode(
  server: ReturnType<typeof createServer>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out after 5 minutes waiting for consent.")),
      5 * 60_000,
    );

    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "content-type": "text/html" }).end(HTML_ERR(error));
        clearTimeout(timeout);
        reject(new Error(`Google returned: ${error}`));
        return;
      }
      if (!code) {
        res.writeHead(400, { "content-type": "text/html" }).end(HTML_ERR("No code in callback."));
        return;
      }

      res.writeHead(200, { "content-type": "text/html" }).end(HTML_OK);
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

interface PropertySummary {
  property?: string;
  displayName?: string;
  propertyType?: string;
}

interface AccountSummary {
  displayName?: string;
  propertySummaries?: PropertySummary[];
}

async function main(): Promise<void> {
  const credentials = await loadClientCredentials();

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${port}`;

  const client = createOAuthClient(credentials, redirectUri);
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: [SCOPE],
    // Force the consent screen so Google reissues a refresh token even when
    // this account has already granted the scope.
    prompt: "consent",
  });

  console.log("Opening your browser to authorize Google Analytics access.");
  console.log(`If it does not open, visit:\n\n  ${authUrl}\n`);
  openBrowser(authUrl);

  try {
    const code = await waitForCode(server);
    const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });

    if (!tokens.refresh_token) {
      throw new Error(
        "Google did not return a refresh token. Revoke this app at " +
          "https://myaccount.google.com/permissions and run `npm run auth` again.",
      );
    }

    await saveToken(tokens);
    console.log(`\nToken saved to ${tokenPath()} (mode 0600).`);

    // Prove the grant works before declaring success: list the properties this
    // account can actually reach.
    client.setCredentials(tokens);
    const { token } = await client.getAccessToken();
    const res = await fetch("https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200", {
      headers: { authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const body = await res.text();
      console.log(
        `\nAuthorized, but listing properties failed (${res.status}): ${body.slice(0, 300)}\n\n` +
          `If this mentions an API not being enabled, enable the Google Analytics Admin API ` +
          `and Google Analytics Data API in the Cloud project that owns this OAuth client.`,
      );
      return;
    }

    const body = (await res.json()) as { accountSummaries?: AccountSummary[] };
    const accounts = body.accountSummaries ?? [];
    const propertyCount = accounts.reduce((n, a) => n + (a.propertySummaries?.length ?? 0), 0);

    if (propertyCount === 0) {
      console.log("\nAuthorized, but this account has no Google Analytics properties.");
      return;
    }

    console.log(`\nVerified access to ${propertyCount} propert${propertyCount === 1 ? "y" : "ies"}:`);
    for (const account of accounts) {
      console.log(`  ${account.displayName ?? "(unnamed account)"}`);
      for (const property of account.propertySummaries ?? []) {
        const id = (property.property ?? "").replace(/^properties\//, "");
        console.log(`    ${id.padEnd(12)} ${property.displayName ?? "(unnamed)"}`);
      }
    }
  } finally {
    server.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
