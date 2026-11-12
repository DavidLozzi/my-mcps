import { OAuth2Client } from "google-auth-library";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const SCOPE = "https://www.googleapis.com/auth/adsense.readonly";

/** Absolute path to the adsense package root, used in the "run npm run auth" hint. */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Credentials live alongside the server in `adsense/.credentials/`, kept out of git
 * by the repo's .gitignore. Set ADSENSE_CONFIG_DIR to relocate them.
 */
export function configDir(): string {
  return process.env.ADSENSE_CONFIG_DIR ?? join(PACKAGE_ROOT, ".credentials");
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
 * Locate the OAuth client JSON. Google Cloud Console downloads it as
 * `client_secret_<id>.apps.googleusercontent.com.json`, so accept that name as
 * well as the tidier `credentials.json` rather than making the rename a
 * prerequisite nobody remembers.
 */
async function findCredentialsFile(): Promise<string | undefined> {
  const preferred = credentialsPath();
  try {
    await readFile(preferred, "utf8");
    return preferred;
  } catch {
    /* Fall through to the downloaded-name scan. */
  }

  try {
    const entries = await readdir(configDir());
    const match = entries.find(
      (name) => name.startsWith("client_secret") && name.endsWith(".json"),
    );
    return match ? join(configDir(), match) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * OAuth client id/secret come from the environment, or from the JSON file
 * downloaded out of Google Cloud Console (which wraps them in an "installed"
 * or "web" envelope depending on the client type).
 */
export async function loadClientCredentials(): Promise<ClientCredentials> {
  const envId = process.env.ADSENSE_CLIENT_ID;
  const envSecret = process.env.ADSENSE_CLIENT_SECRET;
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret };
  }

  const found = await findCredentialsFile();
  if (!found) {
    throw new NotAuthenticatedError(
      `No OAuth client credentials found in ${configDir()}. Set ADSENSE_CLIENT_ID and ` +
        `ADSENSE_CLIENT_SECRET, or download your Desktop app OAuth client JSON there ` +
        `(either named credentials.json, or left under its downloaded ` +
        `client_secret_*.json name).`,
    );
  }

  const parsed = JSON.parse(await readFile(found, "utf8")) as Record<string, any>;
  const envelope = parsed.installed ?? parsed.web ?? parsed;
  const clientId = envelope.client_id;
  const clientSecret = envelope.client_secret;

  if (!clientId || !clientSecret) {
    throw new NotAuthenticatedError(
      `${found} is missing client_id / client_secret. ` +
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
  // Mode 0600 — this file grants access to the account's AdSense data.
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
  const preset = process.env.ADSENSE_ACCESS_TOKEN;
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
