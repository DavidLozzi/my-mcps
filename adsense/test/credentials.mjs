/**
 * Credential discovery: the OAuth client JSON must be found under either the
 * tidy name or the name Google Cloud Console actually downloads it as.
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const expect = (desc, condition) => {
  if (!condition) failures++;
  console.log(`  ${condition ? "PASS" : "FAIL"}: ${desc}`);
};

const FIXTURE = JSON.stringify({
  installed: { client_id: "test-id.apps.googleusercontent.com", client_secret: "test-secret" },
});

async function loadFrom(filename, contents = FIXTURE) {
  const dir = await mkdtemp(join(tmpdir(), "adsense-creds-"));
  await writeFile(join(dir, filename), contents);
  process.env.ADSENSE_CONFIG_DIR = dir;
  // Fresh import each time so nothing is cached across cases.
  const mod = await import(`../dist/auth.js?t=${Date.now()}${Math.random()}`);
  try {
    return { ok: true, value: await mod.loadClientCredentials() };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The environment must not leak into these cases.
delete process.env.ADSENSE_CLIENT_ID;
delete process.env.ADSENSE_CLIENT_SECRET;

console.log("CREDENTIAL DISCOVERY:");

const tidy = await loadFrom("credentials.json");
expect("finds credentials.json", tidy.ok && tidy.value.clientSecret === "test-secret");

const downloaded = await loadFrom(
  "client_secret_172263160887-abc123.apps.googleusercontent.com.json",
);
expect(
  "finds the raw client_secret_*.json download name",
  downloaded.ok && downloaded.value.clientSecret === "test-secret",
);

const webEnvelope = await loadFrom(
  "credentials.json",
  JSON.stringify({ web: { client_id: "w", client_secret: "ws" } }),
);
expect("accepts a web envelope", webEnvelope.ok && webEnvelope.value.clientSecret === "ws");

const bare = await loadFrom(
  "credentials.json",
  JSON.stringify({ client_id: "b", client_secret: "bs" }),
);
expect("accepts a bare object", bare.ok && bare.value.clientSecret === "bs");

const missing = await loadFrom("unrelated.json");
expect("errors when nothing matches", !missing.ok);
expect(
  "the error names both accepted filenames",
  !missing.ok &&
    missing.error.includes("credentials.json") &&
    missing.error.includes("client_secret_"),
);

const malformed = await loadFrom("credentials.json", JSON.stringify({ installed: {} }));
expect("errors on a file with no client_id/secret", !malformed.ok);

console.log(`\n${failures === 0 ? "ALL ASSERTIONS PASSED" : `${failures} ASSERTION(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
