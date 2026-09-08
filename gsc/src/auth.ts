import { OAuth2Client } from "google-auth-library";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const SCOPE = "https://www.googleapis.com/auth/webmasters";

/** Absolute path to the gsc package root, used in the "run npm run auth" hint. */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function configDir(): string {
  return process.env.GSC_CONFIG_DIR ?? join(homedir(), ".config", "gsc-mcp");
}

export function tokenPath(): string {
  return join(configDir(), "token.json");
}

export function credentialsPath(): string {
  return join(configDir(), "credentials.json");
}

export class NotAuthenticatedError extends Error {
  constructor(reason: string) {
    super(
      `${reason}\n\nTo authenticate, run:\n  cd ${PACKAGE_ROOT} && npm run auth`,
    );
    this.name = "NotAuthenticatedError";
  }
}

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * OAuth client id/secret come from the environment, or from the JSON file
 * downloaded out of Google Cloud Console (which wraps them in an "installed"
 * or "web" envelope depending on the client type).
 */
export async function loadClientCredentials(): Promise<ClientCredentials> {
  const envId = process.env.GSC_CLIENT_ID;
  const envSecret = process.env.GSC_CLIENT_SECRET;
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret };
  }

  let raw: string;
  try {
    raw = await readFile(credentialsPath(), "utf8");
  } catch {
    throw new NotAuthenticatedError(
      `No OAuth client credentials found. Set GSC_CLIENT_ID and GSC_CLIENT_SECRET, ` +
        `or download your Desktop app OAuth client JSON to ${credentialsPath()}.`,
    );
  }

  const parsed = JSON.parse(raw) as Record<string, any>;
  const envelope = parsed.installed ?? parsed.web ?? parsed;
  const clientId = envelope.client_id;
  const clientSecret = envelope.client_secret;

  if (!clientId || !clientSecret) {
    throw new NotAuthenticatedError(
      `${credentialsPath()} is missing client_id / client_secret. ` +
        `Re-download the OAuth client JSON from Google Cloud Console.`,
    );
  }

  return { clientId, clientSecret };
}

/** Mirrors google-auth-library's Credentials, which uses null rather than undefined. */
interface StoredToken {
  refresh_token?: string | null;
  access_token?: string | null;
  expiry_date?: number | null;
  scope?: string;
}

async function loadStoredToken(): Promise<StoredToken> {
  let raw: string;
  try {
    raw = await readFile(tokenPath(), "utf8");
  } catch {
    throw new NotAuthenticatedError(`No cached token at ${tokenPath()}.`);
  }

  const token = JSON.parse(raw) as StoredToken;
  if (!token.refresh_token) {
    throw new NotAuthenticatedError(
      `Cached token at ${tokenPath()} has no refresh_token.`,
    );
  }
  return token;
}

export async function saveToken(token: StoredToken): Promise<void> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  // Mode 0600 — this file grants access to the account's Search Console data.
  await writeFile(tokenPath(), JSON.stringify(token, null, 2), { mode: 0o600 });
}

export function createOAuthClient(
  credentials: ClientCredentials,
  redirectUri?: string,
): OAuth2Client {
  return new OAuth2Client({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri,
  });
}

let cachedClient: OAuth2Client | undefined;

/**
 * The authenticated client used by the server. Never runs an interactive flow:
 * a stdio server has no TTY and the host would time out waiting on a browser.
 * Consent happens once, out of band, via `npm run auth`.
 */
export async function getAuthenticatedClient(): Promise<OAuth2Client> {
  if (cachedClient) return cachedClient;

  const credentials = await loadClientCredentials();
  const stored = await loadStoredToken();
  const client = createOAuthClient(credentials);

  client.setCredentials(stored);

  // Google rotates refresh tokens occasionally; persist whatever comes back so
  // the cached copy does not silently go stale.
  client.on("tokens", (tokens) => {
    void saveToken({
      ...stored,
      ...tokens,
      refresh_token: tokens.refresh_token ?? stored.refresh_token,
    });
  });

  cachedClient = client;
  return client;
}

export async function getAccessToken(): Promise<string> {
  // Escape hatch for supplying a token minted elsewhere (gcloud, CI, a stub
  // API during testing). Bypasses the cached-token flow entirely.
  const preset = process.env.GSC_ACCESS_TOKEN;
  if (preset) return preset;

  const client = await getAuthenticatedClient();
  try {
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("empty access token");
    return token;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new NotAuthenticatedError(
      `Could not refresh the access token (${detail}). The refresh token may have been revoked.`,
    );
  }
}
