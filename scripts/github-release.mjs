#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const API_VERSION = "2026-03-10";
const API_ROOT = "https://api.github.com";
const UPLOAD_ROOT = "https://uploads.github.com";
const STABLE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const FULL_SHA = /^[0-9a-f]{40}$/i;

export class GitHubReleaseError extends Error {
  constructor(message, { status, response } = {}) {
    super(message);
    this.name = "GitHubReleaseError";
    this.status = status;
    this.response = response;
  }
}

export function validateIdentity(tag, sha) {
  if (!STABLE_TAG.test(tag)) {
    throw new GitHubReleaseError(`release tag must be an exact stable vX.Y.Z tag, got ${JSON.stringify(tag)}`);
  }
  if (!FULL_SHA.test(sha)) {
    throw new GitHubReleaseError("release SHA must contain exactly 40 hexadecimal characters");
  }
  return { tag, sha: sha.toLowerCase() };
}

export function splitRepository(repository) {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => !part)) {
    throw new GitHubReleaseError(`GITHUB_REPOSITORY must be owner/name, got ${JSON.stringify(repository)}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

function normalizeNotes(notes) {
  return `${notes.replace(/\r\n/g, "\n").trimEnd()}\n`;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function getRetryDelay(response, attempt) {
  const rawRetryAfter = response.headers.get("retry-after");
  if (rawRetryAfter !== null) {
    const seconds = Number(rawRetryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const date = Date.parse(rawRetryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return 250 * 2 ** (attempt - 1);
}

function responseMessage(method, url, response, body) {
  const details = typeof body === "string" ? body : JSON.stringify(body);
  return `${method} ${url} failed with ${response.status}${details ? `: ${details}` : ""}`;
}

export function createGitHubClient({ token, repository, fetchImpl = globalThis.fetch, sleepImpl = sleep }) {
  if (!token) throw new GitHubReleaseError("a GitHub token is required");
  const { owner, repo } = splitRepository(repository);

  async function request(path, { method = "GET", body, headers = {}, binary = false, retryGet = true } = {}) {
    const url = path.startsWith("https://") ? path : `${API_ROOT}${path}`;
    const attempts = method === "GET" && retryGet ? 4 : 1;
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          redirect: "follow",
          headers: {
            Accept: binary ? "application/octet-stream" : "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": "apogee-release-workflow",
            ...headers,
          },
          body,
        });
      } catch (error) {
        lastError = error;
        if (attempt === attempts) {
          throw new GitHubReleaseError(`${method} ${url} failed before receiving a response: ${error.message}`);
        }
        await sleepImpl(250 * 2 ** (attempt - 1));
        continue;
      }

      if (response.ok) {
        if (response.status === 204) return null;
        return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
      }

      let parsed;
      const text = await response.text();
      try {
        parsed = text ? JSON.parse(text) : "";
      } catch {
        parsed = text;
      }

      const transient = response.status === 429 || response.status >= 500;
      if (attempt < attempts && transient) {
        await sleepImpl(getRetryDelay(response, attempt));
        continue;
      }

      throw new GitHubReleaseError(responseMessage(method, url, response, parsed), {
        status: response.status,
        response: parsed,
      });
    }

    throw lastError;
  }

  return { owner, repo, request };
}

async function getTagReference(client, tag) {
  try {
    return await client.request(
      `/repos/${encodeURIComponent(client.owner)}/${encodeURIComponent(client.repo)}/git/ref/tags/${encodeURIComponent(tag)}`,
    );
  } catch (error) {
    if (error instanceof GitHubReleaseError && error.status === 404) return null;
    throw error;
  }
}

async function peelGitObject(client, object) {
  let current = object;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current.type === "commit") return current.sha.toLowerCase();
    if (current.type !== "tag") {
      throw new GitHubReleaseError(`tag points to unsupported Git object type ${JSON.stringify(current.type)}`);
    }
    const annotated = await client.request(
      `/repos/${encodeURIComponent(client.owner)}/${encodeURIComponent(client.repo)}/git/tags/${current.sha}`,
    );
    current = annotated.object;
  }
  throw new GitHubReleaseError("annotated tag chain is unexpectedly deep");
}

async function getRelease(client, tag) {
  const matches = [];
  for (let page = 1; page <= 100; page += 1) {
    const releases = await client.request(
      `/repos/${encodeURIComponent(client.owner)}/${encodeURIComponent(client.repo)}/releases?per_page=100&page=${page}`,
    );
    if (!Array.isArray(releases)) {
      throw new GitHubReleaseError("GitHub returned a non-array release listing");
    }
    matches.push(...releases.filter((release) => release.tag_name === tag));
    if (releases.length < 100) break;
    if (page === 100) {
      throw new GitHubReleaseError("release lookup exceeded 10,000 GitHub Releases");
    }
  }
  if (matches.length > 1) {
    throw new GitHubReleaseError(`multiple GitHub releases use tag ${tag}`);
  }
  return matches[0] ?? null;
}

export async function inspectRelease(client, tagInput, shaInput) {
  const { tag, sha } = validateIdentity(tagInput, shaInput);
  const [reference, release] = await Promise.all([getTagReference(client, tag), getRelease(client, tag)]);
  const tagSha = reference ? await peelGitObject(client, reference.object) : null;

  if (tagSha && tagSha !== sha) {
    throw new GitHubReleaseError(`tag ${tag} already points to ${tagSha}, not requested SHA ${sha}`);
  }
  if (release && !tagSha) {
    throw new GitHubReleaseError(
      `${release.draft ? "draft" : "published"} release ${tag} exists without a resolvable tag; only a tag created before the release is a valid checkpoint`,
    );
  }

  return {
    tag,
    sha,
    checkpoint: Boolean(reference),
    tagExists: Boolean(reference),
    tagSha,
    release: release
      ? {
          id: release.id,
          draft: release.draft,
          immutable: release.immutable ?? false,
          htmlUrl: release.html_url,
          targetCommitish: release.target_commitish,
          name: release.name,
        }
      : null,
  };
}

async function ensureTag(client, tag, sha) {
  const existing = await getTagReference(client, tag);
  if (existing) {
    const existingSha = await peelGitObject(client, existing.object);
    if (existingSha !== sha) {
      throw new GitHubReleaseError(`tag ${tag} already points to ${existingSha}, not ${sha}`);
    }
    return;
  }

  try {
    await client.request(`/repos/${encodeURIComponent(client.owner)}/${encodeURIComponent(client.repo)}/git/refs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: `refs/tags/${tag}`, sha }),
    });
  } catch (error) {
    // A connection can disappear after GitHub commits the ref. Reconcile the
    // observable state before deciding whether the non-idempotent POST failed.
    const reconciled = await getTagReference(client, tag);
    if (!reconciled || (await peelGitObject(client, reconciled.object)) !== sha) throw error;
  }
}

async function assertImmutableReleasesEnabled(client) {
  try {
    const result = await client.request(
      `/repos/${encodeURIComponent(client.owner)}/${encodeURIComponent(client.repo)}/immutable-releases`,
    );
    if (result?.enabled !== true) throw new GitHubReleaseError("GitHub release immutability is not enabled");
  } catch (error) {
    if (error instanceof GitHubReleaseError && error.status === 404) {
      throw new GitHubReleaseError("GitHub release immutability is not enabled");
    }
    throw error;
  }
}

async function ensureDraftRelease(client, { tag, sha, title, notes }) {
  const existing = await getRelease(client, tag);
  if (existing) return existing;

  try {
    return await client.request(`/repos/${encodeURIComponent(client.owner)}/${encodeURIComponent(client.repo)}/releases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: sha,
        name: title,
        body: notes,
        draft: true,
        prerelease: false,
      }),
    });
  } catch (error) {
    const reconciled = await getRelease(client, tag);
    if (!reconciled) throw error;
    return reconciled;
  }
}

function assertReleaseMetadata(release, { tag, title, notes }) {
  if (release.tag_name !== tag) throw new GitHubReleaseError(`release has unexpected tag ${release.tag_name}`);
  if (release.name !== title) throw new GitHubReleaseError(`release ${tag} has unexpected title ${JSON.stringify(release.name)}`);
  if (release.prerelease !== false) {
    throw new GitHubReleaseError(`release ${tag} must not be a prerelease`);
  }
  if (normalizeNotes(release.body ?? "") !== normalizeNotes(notes)) {
    throw new GitHubReleaseError(`release ${tag} notes differ from the committed release notes`);
  }
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function contentType(filename) {
  if (filename.endsWith(".zip")) return "application/zip";
  if (filename.endsWith(".json")) return "application/json";
  return "text/plain; charset=utf-8";
}

async function downloadAsset(client, asset) {
  return client.request(asset.url, { binary: true });
}

async function ensureAsset(client, release, filename) {
  const bytes = await readFile(filename);
  const expectedHash = sha256(bytes);
  const name = basename(filename);
  const matches = (release.assets ?? []).filter((asset) => asset.name === name);
  if (matches.length > 1) throw new GitHubReleaseError(`release contains duplicate asset name ${name}`);

  if (matches.length === 1) {
    const actualHash = sha256(await downloadAsset(client, matches[0]));
    if (actualHash !== expectedHash) {
      throw new GitHubReleaseError(`existing release asset ${name} has SHA-256 ${actualHash}, expected ${expectedHash}`);
    }
    return { name, sha256: expectedHash, reused: true };
  }

  if (!release.draft) {
    throw new GitHubReleaseError(`published release ${release.tag_name} is missing immutable asset ${name}`);
  }

  const uploadUrl = `${UPLOAD_ROOT}/repos/${encodeURIComponent(client.owner)}/${encodeURIComponent(client.repo)}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
  let uploaded;
  try {
    uploaded = await client.request(uploadUrl, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": contentType(name),
        "Content-Length": String(bytes.length),
      },
      body: bytes,
    });
  } catch (error) {
    const refreshed = await getRelease(client, release.tag_name);
    const candidates = (refreshed?.assets ?? []).filter((asset) => asset.name === name);
    if (candidates.length !== 1) throw error;
    uploaded = candidates[0];
  }

  const actualHash = sha256(await downloadAsset(client, uploaded));
  if (actualHash !== expectedHash) {
    throw new GitHubReleaseError(`uploaded release asset ${name} has SHA-256 ${actualHash}, expected ${expectedHash}`);
  }
  return { name, sha256: expectedHash, reused: false };
}

export async function publishRelease(client, { tag: tagInput, sha: shaInput, notesPath, assetPaths }) {
  const { tag, sha } = validateIdentity(tagInput, shaInput);
  if (!notesPath) throw new GitHubReleaseError("--notes is required");
  if (!assetPaths?.length) throw new GitHubReleaseError("at least one --asset is required");
  const resolvedAssetPaths = assetPaths.map((entry) => resolve(entry));
  const expectedAssetNames = resolvedAssetPaths.map((entry) => basename(entry));
  if (new Set(expectedAssetNames).size !== expectedAssetNames.length) {
    throw new GitHubReleaseError("release asset basenames must be unique");
  }
  const expectedAssetSet = new Set(expectedAssetNames);
  const title = `Apogee ${tag}`;
  const notes = normalizeNotes(await readFile(notesPath, "utf8"));

  await assertImmutableReleasesEnabled(client);
  await ensureTag(client, tag, sha);
  let release = await ensureDraftRelease(client, { tag, sha, title, notes });
  assertReleaseMetadata(release, { tag, title, notes });
  const unexpectedAssets = (release.assets ?? [])
    .map((asset) => asset.name)
    .filter((name) => !expectedAssetSet.has(name));
  if (unexpectedAssets.length > 0) {
    throw new GitHubReleaseError(
      `release ${tag} contains unapproved asset(s): ${unexpectedAssets.join(", ")}`,
    );
  }

  const tagReference = await getTagReference(client, tag);
  if (!tagReference || (await peelGitObject(client, tagReference.object)) !== sha) {
    throw new GitHubReleaseError(`tag ${tag} did not resolve to ${sha} after creation`);
  }

  const assets = [];
  for (const filename of resolvedAssetPaths) {
    release = await getRelease(client, tag);
    assets.push(await ensureAsset(client, release, filename));
  }

  release = await getRelease(client, tag);
  const actualAssetNames = (release.assets ?? []).map((asset) => asset.name).sort();
  const exactExpectedAssetNames = [...expectedAssetNames].sort();
  if (JSON.stringify(actualAssetNames) !== JSON.stringify(exactExpectedAssetNames)) {
    throw new GitHubReleaseError(
      `release ${tag} asset set does not exactly match the approved assets`,
    );
  }
  if (release.draft) {
    try {
      release = await client.request(
        `/repos/${encodeURIComponent(client.owner)}/${encodeURIComponent(client.repo)}/releases/${release.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ draft: false, make_latest: "true" }),
        },
      );
    } catch (error) {
      const reconciled = await getRelease(client, tag);
      if (!reconciled || reconciled.draft) throw error;
      release = reconciled;
    }
  }

  assertReleaseMetadata(release, { tag, title, notes });
  if (release.draft) throw new GitHubReleaseError(`release ${tag} is still a draft`);
  if (release.immutable !== true) {
    throw new GitHubReleaseError(`release ${tag} was published but GitHub does not report it as immutable`);
  }

  return { tag, sha, releaseId: release.id, releaseUrl: release.html_url, immutable: true, assets };
}

export async function downloadPublishedAsset(client, { tag: tagInput, sha: shaInput, assetName, outputPath, expectedSha256 }) {
  const { tag, sha } = validateIdentity(tagInput, shaInput);
  const state = await inspectRelease(client, tag, sha);
  if (!state.release || state.release.draft || state.release.immutable !== true) {
    throw new GitHubReleaseError(`release ${tag} is not published and immutable`);
  }
  const release = await getRelease(client, tag);
  const matches = (release.assets ?? []).filter((asset) => asset.name === assetName);
  if (matches.length !== 1) {
    throw new GitHubReleaseError(`release ${tag} must contain exactly one asset named ${assetName}`);
  }
  const bytes = await downloadAsset(client, matches[0]);
  const actualHash = sha256(bytes);
  if (expectedSha256 && actualHash !== expectedSha256.toLowerCase()) {
    throw new GitHubReleaseError(`release asset ${assetName} has SHA-256 ${actualHash}, expected ${expectedSha256}`);
  }
  await writeFile(outputPath, bytes, { flag: "wx" });
  return { tag, sha, assetName, outputPath, sha256: actualHash };
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const values = { asset: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith("--")) throw new GitHubReleaseError(`unexpected argument ${argument}`);
    const key = argument.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new GitHubReleaseError(`${argument} requires a value`);
    index += 1;
    if (key === "asset") values.asset.push(value);
    else if (values[key] !== undefined) throw new GitHubReleaseError(`${argument} was provided more than once`);
    else values[key] = value;
  }
  return { command, values };
}

async function main() {
  const { command, values } = parseArguments(process.argv.slice(2));
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const client = createGitHubClient({ token, repository: process.env.GITHUB_REPOSITORY });
  let result;

  if (command === "inspect") {
    result = await inspectRelease(client, values.tag, values.sha);
  } else if (command === "publish") {
    result = await publishRelease(client, {
      tag: values.tag,
      sha: values.sha,
      notesPath: values.notes,
      assetPaths: values.asset,
    });
  } else if (command === "download") {
    result = await downloadPublishedAsset(client, {
      tag: values.tag,
      sha: values.sha,
      assetName: values.name,
      outputPath: values.output,
      expectedSha256: values.sha256,
    });
  } else {
    throw new GitHubReleaseError("usage: github-release.mjs <inspect|publish|download> [options]");
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`github-release: ${error.message}`);
    if (error.response) console.error(JSON.stringify(error.response, null, 2));
    process.exitCode = 1;
  });
}
