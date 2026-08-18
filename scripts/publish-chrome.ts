// Chrome Web Store publisher — API v2, zero dependencies.
//
// The v1.1 API (and the OAuth refresh-token auth model every marketplace
// upload action still carries) is deprecated and stops working 2026-10-15.
// v2 authenticates with a Google service account, which node's builtins can
// do unaided: sign an RS256 JWT with the account key, exchange it for an
// access token, upload the zip, then request publish. No third-party code in
// the publish path — same posture as the SHA-pinned CI actions.
//
// Run via Node's native TS support: `node scripts/publish-chrome.ts <zip>`
//   ZIP=… CWS_SERVICE_ACCOUNT_JSON="$(cat sa.json)" \
//   CWS_PUBLISHER_ID=… CWS_ITEM_ID=… node scripts/publish-chrome.ts apogee-chrome.zip
// Flags: --no-publish (upload a draft only — the rehearsal path),
//        --percentage N (staged rollout; can be raised later without a
//        re-review via the dashboard's setDeployPercentage).
// Setup walkthrough: docs/release-automation.md.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const API = "https://chromewebstore.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/chromewebstore";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`missing required env: ${name} (see docs/release-automation.md)`);
    process.exit(1);
  }
  return value;
}

/** Service-account key → OAuth2 access token (JWT bearer grant, RS256). */
async function accessToken(sa: {
  client_email: string;
  private_key: string;
  token_uri: string;
}): Promise<string> {
  const enc = (data: string | Buffer): string => Buffer.from(data).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  const header = enc(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = enc(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: sa.token_uri,
      iat,
      exp: iat + 600,
    }),
  );
  const unsigned = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${enc(signer.sign(sa.private_key))}`;

  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error(`token exchange returned no access_token`);
  return json.access_token;
}

async function main(): Promise<void> {
  const zip = process.argv[2];
  if (!zip || zip.startsWith("--")) {
    console.error("usage: node scripts/publish-chrome.ts <zip> [--no-publish] [--percentage N]");
    process.exit(1);
  }
  const doPublish = !process.argv.includes("--no-publish");
  const pctArg = process.argv.find((a) => a.startsWith("--percentage"));
  const percentage = pctArg ? Number(pctArg.split("=")[1] ?? pctArg.split(" ")[1]) : 100;
  if (!Number.isInteger(percentage) || percentage < 0 || percentage > 100) {
    throw new Error("--percentage must be an integer 0-100");
  }

  const sa = JSON.parse(requireEnv("CWS_SERVICE_ACCOUNT_JSON")) as Parameters<
    typeof accessToken
  >[0];
  const publisherId = requireEnv("CWS_PUBLISHER_ID");
  const itemId = requireEnv("CWS_ITEM_ID");
  const token = await accessToken(sa);
  const name = `publishers/${publisherId}/items/${itemId}`;

  // Upload replaces the item's draft package; it publishes nothing by itself.
  const upload = await fetch(`${API}/upload/v2/${name}:upload`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/zip" },
    body: readFileSync(zip),
  });
  if (!upload.ok) throw new Error(`upload failed: ${upload.status} ${await upload.text()}`);
  const uploaded = (await upload.json()) as { uploadState?: string; crxVersion?: string };
  console.log(`uploaded (state=${uploaded.uploadState}, manifest version=${uploaded.crxVersion})`);

  if (!doPublish) {
    console.log("--no-publish: draft staged in the dashboard, nothing submitted");
    return;
  }

  // Publish submits the draft to the store's review queue. DEFAULT_PUBLISH is
  // the public channel; review itself is asynchronous on Google's side.
  const publish = await fetch(`${API}/v2/${name}:publish`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      publishType: "DEFAULT_PUBLISH",
      deployInfos: [{ deployPercentage: percentage }],
    }),
  });
  if (!publish.ok) throw new Error(`publish failed: ${publish.status} ${await publish.text()}`);
  const result = (await publish.json()) as { state?: string };
  console.log(`publish requested (state=${result.state}, rollout=${percentage}%)`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
