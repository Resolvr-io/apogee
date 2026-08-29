import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, beforeEach, describe, test } from "node:test";

import {
  normalizeCommitSha,
  normalizeReleaseTag,
  validateManifestVersionSource,
  validateRelease,
  validateReleaseNotes,
} from "./validate-release.mjs";

const SCRIPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "validate-release.mjs");
const VALID_SHA = "0123456789abcdef0123456789abcdef01234567";
const temporaryDirectories = [];
let fixtureRoot;

beforeEach(async () => {
  fixtureRoot = await mkdtemp(resolve(tmpdir(), "apogee-release-validation-"));
  temporaryDirectories.push(fixtureRoot);
  await writeFixture(fixtureRoot);
});

after(async () => {
  await Promise.all(temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe("release inputs", () => {
  test("accepts an exact stable tag and normalizes an uppercase SHA", () => {
    assert.equal(normalizeReleaseTag("v0.8.0"), "v0.8.0");
    assert.equal(normalizeCommitSha(VALID_SHA.toUpperCase()), VALID_SHA);
  });

  test("rejects malformed, prerelease, and non-canonical tags", () => {
    for (const tag of [
      "0.8.0",
      "V0.8.0",
      "v0.8",
      "v0.8.0-rc.1",
      "v0.8.0+build",
      "v00.8.0",
      " v0.8.0",
    ]) {
      assert.throws(() => normalizeReleaseTag(tag), /exact stable tag/);
    }
  });

  test("rejects abbreviated and non-hexadecimal SHAs", () => {
    assert.throws(() => normalizeCommitSha("0123456"), /exactly 40 hexadecimal/);
    assert.throws(() => normalizeCommitSha(`${VALID_SHA.slice(0, 39)}z`), /exactly 40 hexadecimal/);
  });
});

describe("release notes", () => {
  test("accepts blank lines before the exact heading and a substantive bullet", () => {
    assert.doesNotThrow(() =>
      validateReleaseNotes("\n# Apogee v0.8.0\n\n- Fix wallet synchronization.\n", "v0.8.0"),
    );
  });

  test("requires the exact first nonblank heading", () => {
    assert.throws(
      () => validateReleaseNotes("# Apogee 0.8.0\n\n- A change\n", "v0.8.0"),
      /first nonblank.*exactly/,
    );
    assert.throws(
      () => validateReleaseNotes(" # Apogee v0.8.0\n\n- A change\n", "v0.8.0"),
      /first nonblank.*exactly/,
    );
  });

  test("rejects heading-only and hidden-comment-only notes", () => {
    assert.throws(
      () => validateReleaseNotes("# Apogee v0.8.0\n\n## Changes\n", "v0.8.0"),
      /meaningful non-heading/,
    );
    assert.throws(
      () => validateReleaseNotes("# Apogee v0.8.0\n<!-- add notes later -->\n", "v0.8.0"),
      /meaningful non-heading/,
    );
  });

  test("rejects placeholder markers case-insensitively", () => {
    for (const marker of ["TBD", "todo", "PlaceHolder", "TODOs remain"]) {
      assert.throws(
        () => validateReleaseNotes(`# Apogee v0.8.0\n\n- ${marker}\n`, "v0.8.0"),
        /must not contain/,
      );
    }
  });
});

describe("repository validation", () => {
  test("returns normalized, workflow-ready release metadata", async () => {
    const result = await validateRelease({
      rootDir: fixtureRoot,
      tag: "v0.8.0",
      sha: VALID_SHA.toUpperCase(),
      headSha: VALID_SHA,
    });

    assert.deepEqual(result, {
      tag: "v0.8.0",
      version: "0.8.0",
      sha: VALID_SHA,
      releaseNotesPath: "release-notes/v0.8.0.md",
    });
  });

  test("rejects package/tag and checkout/request mismatches", async () => {
    await assert.rejects(
      validateRelease({ rootDir: fixtureRoot, tag: "v0.9.0", sha: VALID_SHA, headSha: VALID_SHA }),
      /package\.json version.*does not match/,
    );
    await assert.rejects(
      validateRelease({
        rootDir: fixtureRoot,
        tag: "v0.8.0",
        sha: VALID_SHA,
        headSha: "1123456789abcdef0123456789abcdef01234567",
      }),
      /Checked-out HEAD.*does not match/,
    );
  });

  test("requires the release-notes file for the requested tag", async () => {
    await rm(resolve(fixtureRoot, "release-notes/v0.8.0.md"));

    await assert.rejects(
      validateRelease({
        rootDir: fixtureRoot,
        tag: "v0.8.0",
        sha: VALID_SHA,
        headSha: VALID_SHA,
      }),
      /Required file release-notes\/v0\.8\.0\.md does not exist/,
    );
  });

  test("requires the manifest to derive its version from package.json", () => {
    assert.throws(
      () => validateManifestVersionSource("export default { version: '0.8.0' };"),
      /must import its version source/,
    );
    assert.throws(
      () => validateManifestVersionSource('import pkg from "./package.json"; export default { version: "0.8.0" };'),
      /must derive.*package\.json/,
    );
  });

  test("the CLI checks Git HEAD and writes canonical GitHub outputs", async () => {
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: fixtureRoot });
    execFileSync("git", ["add", "."], { cwd: fixtureRoot });
    execFileSync(
      "git",
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Apogee Test",
        "-c",
        "user.email=apogee-test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "test fixture",
      ],
      { cwd: fixtureRoot },
    );
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixtureRoot,
      encoding: "utf8",
    }).trim();
    const outputPath = resolve(fixtureRoot, "github-output.txt");

    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--tag", "v0.8.0", "--sha", head.toUpperCase()],
      {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: outputPath },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Validated v0\\.8\\.0 at ${head}`));
    assert.equal(
      await readFile(outputPath, "utf8"),
      `tag=v0.8.0\nversion=0.8.0\nsha=${head}\nrelease_notes_path=release-notes/v0.8.0.md\n`,
    );
  });
});

async function writeFixture(rootDir) {
  await mkdir(resolve(rootDir, "release-notes"), { recursive: true });
  await writeFile(
    resolve(rootDir, "package.json"),
    `${JSON.stringify({ name: "apogee", version: "0.8.0", type: "module" }, null, 2)}\n`,
  );
  await writeFile(
    resolve(rootDir, "manifest.config.ts"),
    'import pkg from "./package.json";\nexport default { version: pkg.version };\n',
  );
  await writeFile(
    resolve(rootDir, "release-notes/v0.8.0.md"),
    "# Apogee v0.8.0\n\n- A real release note.\n",
  );
}
