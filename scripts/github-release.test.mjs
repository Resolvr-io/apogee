import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GitHubReleaseError,
  createGitHubClient,
  downloadPublishedAsset,
  inspectRelease,
  publishRelease,
  validateIdentity,
} from "./github-release.mjs";

const TAG = "v0.8.0";
const SHA = "1234567890abcdef1234567890abcdef12345678";

test("validateIdentity accepts only an exact stable tag and full SHA", () => {
  assert.deepEqual(validateIdentity(TAG, SHA.toUpperCase()), { tag: TAG, sha: SHA });
  assert.throws(() => validateIdentity("0.8.0", SHA), /exact stable/);
  assert.throws(() => validateIdentity("v0.8.0-rc.1", SHA), /exact stable/);
  assert.throws(() => validateIdentity(TAG, SHA.slice(0, -1)), /40 hexadecimal/);
});

test("inspectRelease rejects a tag that points at another commit", async () => {
  const client = {
    owner: "Resolvr-io",
    repo: "apogee",
    async request(path) {
      if (path.includes("/git/ref/tags/")) {
        return { object: { type: "commit", sha: "f".repeat(40) } };
      }
      if (path.includes("/releases?")) return [];
      throw new Error(`unexpected path ${path}`);
    },
  };

  await assert.rejects(() => inspectRelease(client, TAG, SHA), /already points/);
});

test("inspectRelease rejects a tagless draft instead of treating it as a checkpoint", async () => {
  const client = {
    owner: "Resolvr-io",
    repo: "apogee",
    async request(path) {
      if (path.includes("/git/ref/tags/")) {
        throw new GitHubReleaseError("missing", { status: 404 });
      }
      if (path.includes("/releases?")) {
        return [{
          id: 41,
          tag_name: TAG,
          target_commitish: SHA,
          draft: true,
        }];
      }
      throw new Error(`unexpected path ${path}`);
    },
  };

  await assert.rejects(
    () => inspectRelease(client, TAG, SHA),
    /draft release .* without a resolvable tag/,
  );
});

test("inspectRelease paginates release lookup", async () => {
  let releasePages = 0;
  const client = {
    owner: "Resolvr-io",
    repo: "apogee",
    async request(path) {
      if (path.includes("/git/ref/tags/")) {
        return { object: { type: "commit", sha: SHA } };
      }
      if (path.includes("/releases?")) {
        releasePages += 1;
        if (path.endsWith("&page=1")) {
          return Array.from({ length: 100 }, (_, index) => ({
            tag_name: `v0.0.${index}`,
          }));
        }
        return [{
          id: 42,
          tag_name: TAG,
          target_commitish: SHA,
          name: `Apogee ${TAG}`,
          draft: false,
          immutable: true,
          html_url: `https://github.com/Resolvr-io/apogee/releases/tag/${TAG}`,
        }];
      }
      throw new Error(`unexpected path ${path}`);
    },
  };

  const result = await inspectRelease(client, TAG, SHA);
  assert.equal(result.release.id, 42);
  assert.equal(releasePages, 2);
});

test("GitHub GET retries use backoff when Retry-After is absent", async () => {
  const delays = [];
  let attempts = 0;
  const client = createGitHubClient({
    token: "test-token",
    repository: "Resolvr-io/apogee",
    sleepImpl: async (milliseconds) => delays.push(milliseconds),
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: false,
          status: 503,
          headers: { get: () => null },
          text: async () => "temporarily unavailable",
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      };
    },
  });

  assert.deepEqual(await client.request("/test"), { ok: true });
  assert.deepEqual(delays, [250]);
});

function createStatefulClient() {
  const state = {
    tagSha: null,
    release: null,
    assets: new Map(),
    mutations: [],
  };

  const client = {
    owner: "Resolvr-io",
    repo: "apogee",
    async request(path, options = {}) {
      const method = options.method ?? "GET";
      if (path.endsWith("/immutable-releases")) return { enabled: true };

      if (path.includes("/git/ref/tags/")) {
        if (!state.tagSha) throw new GitHubReleaseError("missing", { status: 404 });
        return { object: { type: "commit", sha: state.tagSha } };
      }

      if (path.endsWith("/git/refs") && method === "POST") {
        const payload = JSON.parse(options.body);
        state.tagSha = payload.sha;
        state.mutations.push("create-tag");
        return { ref: payload.ref, object: { type: "commit", sha: payload.sha } };
      }

      if (path.includes("/releases?")) return state.release ? [structuredClone(state.release)] : [];

      if (path.endsWith("/releases") && method === "POST") {
        const payload = JSON.parse(options.body);
        state.release = {
          id: 42,
          tag_name: payload.tag_name,
          target_commitish: payload.target_commitish,
          name: payload.name,
          body: payload.body,
          draft: true,
          prerelease: false,
          immutable: false,
          html_url: `https://github.com/Resolvr-io/apogee/releases/tag/${payload.tag_name}`,
          assets: [],
        };
        state.mutations.push("create-release");
        return structuredClone(state.release);
      }

      if (path.includes("uploads.github.com") && method === "POST") {
        const name = new URL(path).searchParams.get("name");
        const asset = {
          id: state.assets.size + 1,
          name,
          url: `https://api.github.test/assets/${state.assets.size + 1}`,
        };
        const bytes = Buffer.from(options.body);
        state.assets.set(asset.url, bytes);
        state.release.assets.push(asset);
        state.mutations.push(`upload:${name}`);
        return structuredClone(asset);
      }

      if (path.startsWith("https://api.github.test/assets/")) {
        return Buffer.from(state.assets.get(path));
      }

      if (/\/releases\/42$/.test(path) && method === "PATCH") {
        state.release.draft = false;
        state.release.immutable = true;
        state.mutations.push("publish-release");
        return structuredClone(state.release);
      }

      throw new Error(`unexpected ${method} ${path}`);
    },
  };

  return { client, state };
}

test("publishRelease creates an immutable release once and safely resumes it", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "apogee-github-release-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const notesPath = join(directory, "notes.md");
  const assetPath = join(directory, "apogee-0.8.0-chrome.zip");
  await writeFile(notesPath, "# Apogee v0.8.0\n\n- Ready.\n");
  await writeFile(assetPath, "fixed archive bytes");
  const { client, state } = createStatefulClient();

  const first = await publishRelease(client, {
    tag: TAG,
    sha: SHA,
    notesPath,
    assetPaths: [assetPath],
  });
  assert.equal(first.immutable, true);
  assert.deepEqual(state.mutations, [
    "create-tag",
    "create-release",
    "upload:apogee-0.8.0-chrome.zip",
    "publish-release",
  ]);

  const second = await publishRelease(client, {
    tag: TAG,
    sha: SHA,
    notesPath,
    assetPaths: [assetPath],
  });
  assert.equal(second.assets[0].reused, true);
  assert.equal(state.mutations.length, 4, "resume must not repeat any mutation");
});

test("publishRelease refuses to publish an unapproved draft asset", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "apogee-github-extra-asset-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const notesPath = join(directory, "notes.md");
  const assetPath = join(directory, "apogee-0.8.0-chrome.zip");
  await writeFile(notesPath, "# Apogee v0.8.0\n\n- Ready.\n");
  await writeFile(assetPath, "fixed archive bytes");
  const { client, state } = createStatefulClient();
  state.tagSha = SHA;
  state.release = {
    id: 42,
    tag_name: TAG,
    target_commitish: SHA,
    name: `Apogee ${TAG}`,
    body: "# Apogee v0.8.0\n\n- Ready.\n",
    draft: true,
    prerelease: false,
    immutable: false,
    html_url: `https://github.com/Resolvr-io/apogee/releases/tag/${TAG}`,
    assets: [{ id: 99, name: "unapproved.txt", url: "https://api.github.test/assets/99" }],
  };
  state.assets.set("https://api.github.test/assets/99", Buffer.from("unexpected"));

  await assert.rejects(
    () => publishRelease(client, { tag: TAG, sha: SHA, notesPath, assetPaths: [assetPath] }),
    /contains unapproved asset/,
  );
  assert.deepEqual(state.mutations, []);
  assert.equal(state.release.draft, true);
});

test("downloadPublishedAsset verifies the release asset before writing it", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "apogee-github-download-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const notesPath = join(directory, "notes.md");
  const assetPath = join(directory, "apogee-0.8.0-chrome.zip");
  const outputPath = join(directory, "downloaded.zip");
  const bytes = Buffer.from("fixed archive bytes");
  await writeFile(notesPath, "# Apogee v0.8.0\n\n- Ready.\n");
  await writeFile(assetPath, bytes);
  const { client } = createStatefulClient();
  await publishRelease(client, { tag: TAG, sha: SHA, notesPath, assetPaths: [assetPath] });
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex");

  const result = await downloadPublishedAsset(client, {
    tag: TAG,
    sha: SHA,
    assetName: "apogee-0.8.0-chrome.zip",
    outputPath,
    expectedSha256,
  });

  assert.equal(result.sha256, expectedSha256);
  assert.deepEqual(await readFile(outputPath), bytes);
});
