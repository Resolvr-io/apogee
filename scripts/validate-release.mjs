#!/usr/bin/env node

import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const PLACEHOLDER_PATTERN = /(?:tbd|todo|placeholder)/i;

export class ReleaseValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseValidationError";
  }
}

export function normalizeReleaseTag(tag) {
  if (typeof tag !== "string" || !RELEASE_TAG_PATTERN.test(tag)) {
    throw new ReleaseValidationError(
      `Release tag must be an exact stable tag in the form vX.Y.Z; received ${JSON.stringify(tag)}.`,
    );
  }

  return tag;
}

export function normalizeCommitSha(sha) {
  if (typeof sha !== "string" || !COMMIT_SHA_PATTERN.test(sha)) {
    throw new ReleaseValidationError(
      "Commit SHA must be exactly 40 hexadecimal characters.",
    );
  }

  return sha.toLowerCase();
}

export function validateReleaseNotes(contents, tag) {
  const expectedHeading = `# Apogee ${tag}`;
  const withoutBom = contents.replace(/^\uFEFF/, "");
  const lines = withoutBom.split(/\r?\n/);
  const firstNonblankIndex = lines.findIndex((line) => line.trim() !== "");

  if (firstNonblankIndex === -1) {
    throw new ReleaseValidationError("Release notes are empty.");
  }

  if (lines[firstNonblankIndex] !== expectedHeading) {
    throw new ReleaseValidationError(
      `The first nonblank release-notes line must be exactly ${JSON.stringify(expectedHeading)}.`,
    );
  }

  if (PLACEHOLDER_PATTERN.test(withoutBom)) {
    throw new ReleaseValidationError(
      "Release notes must not contain TBD, TODO, or placeholder text.",
    );
  }

  const visibleBody = lines
    .slice(firstNonblankIndex + 1)
    .join("\n")
    .replace(/<!--[\s\S]*?-->/g, "");

  const hasMeaningfulBody = visibleBody.split("\n").some((line) => {
    const trimmed = line.trim();
    if (
      trimmed === "" ||
      /^#{1,6}(?:\s|$)/.test(trimmed) ||
      /^(?:[-*_]\s*){3,}$/.test(trimmed) ||
      /^```/.test(trimmed)
    ) {
      return false;
    }

    return /[\p{L}\p{N}]/u.test(trimmed);
  });

  if (!hasMeaningfulBody) {
    throw new ReleaseValidationError(
      "Release notes must contain meaningful non-heading content.",
    );
  }
}

export function validateManifestVersionSource(contents) {
  const packageImport = contents.match(
    /import\s+([A-Za-z_$][\w$]*)\s+from\s+["']\.\/package\.json["'][^;]*;/,
  );
  if (!packageImport) {
    throw new ReleaseValidationError(
      "manifest.config.ts must import its version source from ./package.json.",
    );
  }

  const packageIdentifier = escapeRegularExpression(packageImport[1]);
  const versionProperty = new RegExp(`\\bversion\\s*:\\s*${packageIdentifier}\\.version\\b`);
  if (!versionProperty.test(contents)) {
    throw new ReleaseValidationError(
      "manifest.config.ts must derive the Chrome manifest version from package.json.",
    );
  }
}

export async function validateRelease({ rootDir, tag, sha, headSha }) {
  const repositoryRoot = resolve(rootDir);
  const normalizedTag = normalizeReleaseTag(tag);
  const normalizedSha = normalizeCommitSha(sha);
  const version = normalizedTag.slice(1);

  const packagePath = resolve(repositoryRoot, "package.json");
  const packageJson = await readJsonFile(packagePath, "package.json");
  if (packageJson.version !== version) {
    throw new ReleaseValidationError(
      `package.json version ${JSON.stringify(packageJson.version)} does not match tag ${normalizedTag}.`,
    );
  }

  const resolvedHeadSha = normalizeCommitSha(
    headSha ?? (await readCheckedOutHead(repositoryRoot)),
  );
  if (resolvedHeadSha !== normalizedSha) {
    throw new ReleaseValidationError(
      `Checked-out HEAD ${resolvedHeadSha} does not match requested commit ${normalizedSha}.`,
    );
  }

  const manifestPath = resolve(repositoryRoot, "manifest.config.ts");
  const manifestSource = await readRequiredFile(manifestPath, "manifest.config.ts");
  validateManifestVersionSource(manifestSource);

  const notesRelativePath = `release-notes/${normalizedTag}.md`;
  const notesPath = resolve(repositoryRoot, notesRelativePath);
  const notes = await readRequiredFile(notesPath, notesRelativePath);
  validateReleaseNotes(notes, normalizedTag);

  return {
    tag: normalizedTag,
    version,
    sha: normalizedSha,
    releaseNotesPath: toPosixPath(relative(repositoryRoot, notesPath)),
  };
}

export async function writeGitHubOutputs(outputPath, result) {
  const values = {
    tag: result.tag,
    version: result.version,
    sha: result.sha,
    release_notes_path: result.releaseNotesPath,
  };
  const lines = Object.entries(values).map(([name, value]) => `${name}=${value}`);
  await appendFile(outputPath, `${lines.join("\n")}\n`, "utf8");
}

export async function runCli(args, environment = process.env) {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h", default: false },
      tag: { type: "string" },
      sha: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(
      "Usage: node scripts/validate-release.mjs --tag vX.Y.Z --sha <40-character commit SHA>\n",
    );
    return undefined;
  }

  if (values.tag === undefined || values.sha === undefined) {
    throw new ReleaseValidationError("Both --tag and --sha are required.");
  }

  const result = await validateRelease({
    rootDir: process.cwd(),
    tag: values.tag,
    sha: values.sha,
  });

  if (environment.GITHUB_OUTPUT) {
    await writeGitHubOutputs(environment.GITHUB_OUTPUT, result);
  }

  process.stdout.write(
    `Validated ${result.tag} at ${result.sha}; release notes: ${result.releaseNotesPath}\n`,
  );
  return result;
}

async function readCheckedOutHead(repositoryRoot) {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      repositoryRoot,
      "rev-parse",
      "--verify",
      "HEAD",
    ]);
    return stdout.trim();
  } catch (error) {
    throw new ReleaseValidationError(
      `Unable to resolve the checked-out Git HEAD: ${errorMessage(error)}.`,
    );
  }
}

async function readJsonFile(path, displayName) {
  const contents = await readRequiredFile(path, displayName);
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new ReleaseValidationError(
      `${displayName} is not valid JSON: ${errorMessage(error)}.`,
    );
  }
}

async function readRequiredFile(path, displayName) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new ReleaseValidationError(`Required file ${displayName} does not exist.`);
    }
    throw new ReleaseValidationError(`Unable to read ${displayName}: ${errorMessage(error)}.`);
  }
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPosixPath(path) {
  return sep === "/" ? path : path.split(sep).join("/");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function escapeWorkflowCommand(value) {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
const thisPath = fileURLToPath(import.meta.url);
if (invokedPath === thisPath) {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    const message = errorMessage(error);
    if (process.env.GITHUB_ACTIONS === "true") {
      process.stderr.write(
        `::error title=Release validation failed::${escapeWorkflowCommand(message)}\n`,
      );
    } else {
      process.stderr.write(`Release validation failed: ${message}\n`);
    }
    process.exitCode = 1;
  }
}
