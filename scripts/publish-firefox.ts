// AMO (addons.mozilla.org) publisher — REST API v5, zero dependencies.
//
// Two steps, exactly what web-ext does internally but without its dependency
// tree: POST the zip to /addons/upload/ for validation, then create the
// version on the add-on, which submits it to Mozilla's review queue. Auth is
// a short-lived HS256 JWT minted from the AMO API key/secret — node builtins
// again, no third-party code in the publish path.
//
// Run via Node's native TS support: `node scripts/publish-firefox.ts <zip> <slug>`
//   AMO_API_KEY=… AMO_API_SECRET=… node scripts/publish-firefox.ts apogee-firefox.zip apogee
// The slug is the listing's last path segment: addons.mozilla.org/firefox/addon/<slug>/
// Setup walkthrough: docs/release-automation.md.
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const API = "https://addons.mozilla.org/api/v5";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`missing required env: ${name} (see docs/release-automation.md)`);
    process.exit(1);
  }
  return value;
}

/** AMO authenticates requests with a 5-minute HS256 JWT signed by the API key. */
function jwt(key: string, secret: string): string {
  const enc = (data: string): string => Buffer.from(data).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  const header = enc(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims = enc(
    JSON.stringify({ iss: key, jti: randomUUID(), iat, exp: iat + 300 }),
  );
  const sig = enc(createHmac("sha256", secret).update(`${header}.${claims}`).digest());
  return `${header}.${claims}.${sig}`;
}

async function main(): Promise<void> {
  const [zip, slug] = process.argv.slice(2);
  if (!zip || !slug) {
    console.error("usage: node scripts/publish-firefox.ts <zip> <slug>");
    process.exit(1);
  }
  const key = requireEnv("AMO_API_KEY");
  const secret = requireEnv("AMO_API_SECRET");
  const auth = { authorization: `JWT ${jwt(key, secret)}` };

  // Step 1: hand AMO the package; it validates and parses the manifest version.
  const form = new FormData();
  form.append(
    "upload",
    new Blob([readFileSync(zip)], { type: "application/zip" }),
    zip,
  );
  form.append("channel", "listed");
  const uploadRes = await fetch(`${API}/addons/upload/`, { method: "POST", headers: auth, body: form });
  if (!uploadRes.ok) throw new Error(`upload failed: ${uploadRes.status} ${await uploadRes.text()}`);
  let detail = (await uploadRes.json()) as {
    uuid: string;
    valid?: boolean;
    processed?: boolean;
    url: string;
    validation_results?: unknown;
    parsed_version?: string;
  };

  // Validation is async: poll the returned detail URL until it settles.
  while (!detail.processed) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const poll = await fetch(detail.url, { headers: auth });
    if (!poll.ok) throw new Error(`validation poll failed: ${poll.status}`);
    detail = (await poll.json()) as typeof detail;
  }
  console.log(`validated (manifest version=${detail.parsed_version})`);
  if (!detail.valid) {
    console.error(JSON.stringify(detail.validation_results, null, 2));
    throw new Error("AMO validation rejected the package — fix and re-submit");
  }

  // Step 2: create the version on the add-on. This is the submission — it
  // lands in the review queue; publishing happens when Mozilla approves.
  const versionRes = await fetch(`${API}/addons/addon/${slug}/versions/`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ upload: detail.uuid }),
  });
  if (!versionRes.ok) throw new Error(`version submit failed: ${versionRes.status} ${await versionRes.text()}`);
  const submitted = (await versionRes.json()) as { version?: { version?: string } };
  console.log(`submitted v${submitted.version?.version} — awaiting AMO review`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
