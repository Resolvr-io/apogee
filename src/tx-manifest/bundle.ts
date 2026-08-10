export const TX_MANIFEST_BUNDLE_SCHEMA = "apogee-tx-manifest-bundle/v1" as const;
export const TX_MANIFEST_BUNDLE_HASH_TAG = "apogee/tx-manifest-bundle/v1" as const;

export const TX_MANIFEST_PINNED_REVISIONS = Object.freeze({
  elipDraft: "bb1e78990a60396837340b54bb6ccd1c497cb576",
  referenceRuntime: "1cbb5101833f35156f3581a9666a4b12236cd5d2",
  referenceSpec: "1a8d0b759853a00fef5f74351b64a602e2ba7a6f",
  simplicityHl: "9e77379d343e76eb92cb57c2668af9f8e0c4f46b",
  simplicityLending: "8f8ace33963788a0ed901c160a1187f8489e2c55",
});

export type TxManifestBundle = {
  schema: typeof TX_MANIFEST_BUNDLE_SCHEMA;
  manifestSpec: {
    id: "elip-205-draft";
    revision: string;
  };
  compiler: {
    id: "simplicityhl";
    revision: string;
    debugSymbols: boolean;
  };
  extensions: string[];
  manifest: Record<string, unknown>;
  /** Canonical, relative POSIX path to the exact UTF-8 source text. */
  sources: Record<string, string>;
};

export type TxManifestBundleInspection = {
  manifestVersion: string;
  protocol: string;
  actions: string[];
  sourcePaths: string[];
};

/**
 * Strictly normalize the execution-critical bundle before hashing or loading it.
 * Source contents are deliberately not newline-normalized: debug-symbol builds may
 * commit source positions into the compiled Simplicity program.
 */
export function normalizeTxManifestBundle(value: unknown): TxManifestBundle {
  const bundle = object(value, "bundle");
  exactKeys(
    bundle,
    ["schema", "manifestSpec", "compiler", "extensions", "manifest", "sources"],
    "bundle",
  );
  if (bundle.schema !== TX_MANIFEST_BUNDLE_SCHEMA) {
    throw new TypeError(`bundle.schema must be ${TX_MANIFEST_BUNDLE_SCHEMA}.`);
  }

  const manifestSpec = object(bundle.manifestSpec, "bundle.manifestSpec");
  exactKeys(manifestSpec, ["id", "revision"], "bundle.manifestSpec");
  if (manifestSpec.id !== "elip-205-draft") {
    throw new TypeError("bundle.manifestSpec.id must be elip-205-draft.");
  }

  const compiler = object(bundle.compiler, "bundle.compiler");
  exactKeys(compiler, ["id", "revision", "debugSymbols"], "bundle.compiler");
  if (compiler.id !== "simplicityhl") {
    throw new TypeError("bundle.compiler.id must be simplicityhl.");
  }
  if (typeof compiler.debugSymbols !== "boolean") {
    throw new TypeError("bundle.compiler.debugSymbols must be a boolean.");
  }

  const extensions = stringArray(bundle.extensions, "bundle.extensions").sort();
  if (new Set(extensions).size !== extensions.length) {
    throw new TypeError("bundle.extensions must not contain duplicates.");
  }

  const manifest = object(bundle.manifest, "bundle.manifest");
  nonEmptyString(manifest.manifest_version, "bundle.manifest.manifest_version");
  nonEmptyString(manifest.protocol, "bundle.manifest.protocol");

  const rawSources = object(bundle.sources, "bundle.sources");
  const sources: Record<string, string> = {};
  for (const [rawPath, source] of Object.entries(rawSources)) {
    if (typeof source !== "string") {
      throw new TypeError(`bundle.sources[${JSON.stringify(rawPath)}] must be a string.`);
    }
    const path = canonicalTxManifestSourcePath(rawPath);
    if (Object.hasOwn(sources, path)) {
      throw new TypeError(`bundle.sources contains duplicate canonical path ${path}.`);
    }
    sources[path] = source;
  }
  if (Object.keys(sources).length === 0) {
    throw new TypeError("bundle.sources must contain at least one .simf source.");
  }

  for (const sourcePath of directManifestSourcePaths(manifest)) {
    if (!Object.hasOwn(sources, sourcePath)) {
      throw new TypeError(`Manifest references missing bundle source ${sourcePath}.`);
    }
  }
  rejectUnsupportedSourceImports(sources);

  return {
    schema: TX_MANIFEST_BUNDLE_SCHEMA,
    manifestSpec: {
      id: "elip-205-draft",
      revision: gitRevision(manifestSpec.revision, "bundle.manifestSpec.revision"),
    },
    compiler: {
      id: "simplicityhl",
      revision: gitRevision(compiler.revision, "bundle.compiler.revision"),
      debugSymbols: compiler.debugSymbols,
    },
    extensions,
    manifest: cloneJsonObject(manifest),
    sources,
  } satisfies TxManifestBundle;
}

/**
 * Bundle v1 has no import resolver. Reject import-like declarations instead of
 * allowing a compiler to consult a filesystem or silently resolve ambient code.
 */
function rejectUnsupportedSourceImports(sources: Record<string, string>): void {
  const declaration = /^\s*(?:import|include|mod)\b/m;
  for (const [path, source] of Object.entries(sources)) {
    if (declaration.test(source)) {
      throw new TypeError(
        `Bundle source ${path} declares an import, but bundle v1 supports only closed single-file sources.`,
      );
    }
  }
}

export function inspectTxManifestBundle(value: unknown): TxManifestBundleInspection {
  const bundle = normalizeTxManifestBundle(value);
  return {
    manifestVersion: bundle.manifest.manifest_version as string,
    protocol: bundle.manifest.protocol as string,
    actions: manifestActionNames(bundle.manifest),
    sourcePaths: Object.keys(bundle.sources).sort(),
  };
}

/** Tagged SHA-256 over the complete canonical bundle. */
export async function txManifestBundleHash(
  value: unknown,
): Promise<`sha256:${string}`> {
  const bundle = normalizeTxManifestBundle(value);
  const preimage = new TextEncoder().encode(canonicalJson(bundle));
  const tagHash = await sha256(new TextEncoder().encode(TX_MANIFEST_BUNDLE_HASH_TAG));
  const taggedPreimage = new Uint8Array(tagHash.length * 2 + preimage.length);
  taggedPreimage.set(tagHash, 0);
  taggedPreimage.set(tagHash, tagHash.length);
  taggedPreimage.set(preimage, tagHash.length * 2);
  return `sha256:${hex(await sha256(taggedPreimage))}`;
}

export async function taggedCanonicalJsonHash(
  tag: string,
  value: unknown,
): Promise<`sha256:${string}`> {
  const preimage = new TextEncoder().encode(canonicalJson(value));
  const tagHash = await sha256(new TextEncoder().encode(tag));
  const taggedPreimage = new Uint8Array(tagHash.length * 2 + preimage.length);
  taggedPreimage.set(tagHash, 0);
  taggedPreimage.set(tagHash, tagHash.length);
  taggedPreimage.set(preimage, tagHash.length * 2);
  return `sha256:${hex(await sha256(taggedPreimage))}`;
}

/** RFC-8785-shaped subset used by bundle v1: JSON plus finite safe integers only. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("Bundle JSON numbers must be safe integers; encode amounts as strings.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Bundle must contain only JSON values.");
}

export function canonicalTxManifestSourcePath(rawPath: string): string {
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.includes("\0")) {
    throw new TypeError("Bundle source paths must be non-empty strings without NUL bytes.");
  }
  if (rawPath.includes("\\") || rawPath.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(rawPath)) {
    throw new TypeError(`Bundle source path must be relative POSIX syntax: ${rawPath}.`);
  }
  const path = rawPath.startsWith("./") ? rawPath.slice(2) : rawPath;
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new TypeError(`Bundle source path is not canonical: ${rawPath}.`);
  }
  if (!path.endsWith(".simf")) {
    throw new TypeError(`Bundle source path must end in .simf: ${rawPath}.`);
  }
  return path;
}

function directManifestSourcePaths(value: unknown): Set<string> {
  const paths = new Set<string>();
  walk(value, (entry) => {
    if (entry.type === "simplicity" && typeof entry.source === "string") {
      paths.add(canonicalTxManifestSourcePath(entry.source));
    }
  });
  return paths;
}

function manifestActionNames(manifest: Record<string, unknown>): string[] {
  const actions = new Set<string>();
  addKeys(actions, manifest.actions);
  if (isObject(manifest.contract_templates)) {
    for (const template of Object.values(manifest.contract_templates)) {
      if (isObject(template)) addKeys(actions, template.actions);
    }
  }
  return [...actions].sort();
}

function addKeys(target: Set<string>, value: unknown): void {
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) target.add(key);
}

function walk(value: unknown, visitor: (value: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visitor);
    return;
  }
  if (!isObject(value)) return;
  visitor(value);
  for (const entry of Object.values(value)) walk(entry, visitor);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const input = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(input).set(bytes);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(canonicalJson(value)) as Record<string, unknown>;
}

function gitRevision(value: unknown, path: string): string {
  const revision = nonEmptyString(value, path);
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new TypeError(`${path} must be a full lowercase Git commit hash.`);
  }
  return revision;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array.`);
  return value.map((entry, index) => nonEmptyString(entry, `${path}[${index}]`));
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string.`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: string[], path: string): void {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) throw new TypeError(`${path} contains unknown field ${key}.`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${path}.${key} is required.`);
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) throw new TypeError(`${path} must be an object.`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
