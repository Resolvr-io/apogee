import type { TxManifestBundleHash } from "./registry";

const MAGIC = "54584d46"; // ASCII "TXMF"
const VERSION = "01";
const ACTION_TAG_BYTES = 16;
const PAYLOAD_BYTES = 4 + 1 + 32 + ACTION_TAG_BYTES;
const ACTION_HASH_TAG = "tx-manifest/action/v1";

export const TX_MANIFEST_ACTION_HINT_V1 = "txmf-v1" as const;

export type TxManifestActionHint = {
  version: 1;
  bundleHash: TxManifestBundleHash;
  actionTag: string;
};

/**
 * Return the compact action discriminator committed by a TXMF v1 marker.
 * The exact bundle hash occupies the first fixed-width field, so no separator
 * is needed between it and the UTF-8 action identifier.
 */
export async function txManifestActionTag(
  bundleHash: TxManifestBundleHash,
  action: string,
): Promise<string> {
  const bundle = bundleHashBytes(bundleHash);
  if (action.length === 0) throw new TypeError("TX Manifest action must not be empty.");
  const actionBytes = new TextEncoder().encode(action);
  const preimage = new Uint8Array(bundle.length + actionBytes.length);
  preimage.set(bundle, 0);
  preimage.set(actionBytes, bundle.length);
  return hex((await taggedHash(ACTION_HASH_TAG, preimage)).slice(0, ACTION_TAG_BYTES));
}

/** Encode the 53-byte payload carried in one OP_RETURN data push. */
export async function encodeTxManifestActionHint(
  bundleHash: TxManifestBundleHash,
  action: string,
): Promise<string> {
  const bundle = bundleHash.slice("sha256:".length);
  return `${MAGIC}${VERSION}${bundle}${await txManifestActionTag(bundleHash, action)}`;
}

/** Build the canonical single-push OP_RETURN script for a TXMF v1 hint. */
export async function txManifestActionHintScript(
  bundleHash: TxManifestBundleHash,
  action: string,
): Promise<string> {
  const payload = await encodeTxManifestActionHint(bundleHash, action);
  return `6a${PAYLOAD_BYTES.toString(16).padStart(2, "0")}${payload}`;
}

/** Decode one data push. Unknown versions and malformed records are ignored. */
export function decodeTxManifestActionHint(payload: string): TxManifestActionHint | null {
  const normalized = payload.toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length !== PAYLOAD_BYTES * 2) return null;
  if (!normalized.startsWith(`${MAGIC.toLowerCase()}${VERSION}`)) return null;
  const bundleStart = (4 + 1) * 2;
  const bundleEnd = bundleStart + 32 * 2;
  return {
    version: 1,
    bundleHash: `sha256:${normalized.slice(bundleStart, bundleEnd)}`,
    actionTag: normalized.slice(bundleEnd),
  };
}

/**
 * Inspect every pushed datum in an OP_RETURN script. The marker's output index
 * and push index are intentionally irrelevant to recovery.
 */
export function txManifestActionHintsFromScript(scriptHex: string): TxManifestActionHint[] {
  const bytes = parseHex(scriptHex);
  if (!bytes || bytes[0] !== 0x6a) return [];
  const hints: TxManifestActionHint[] = [];
  let cursor = 1;
  while (cursor < bytes.length) {
    const push = readPush(bytes, cursor);
    if (!push) return hints;
    cursor = push.next;
    const hint = decodeTxManifestActionHint(hex(push.data));
    if (hint) hints.push(hint);
  }
  return hints;
}

export async function txManifestActionHintMatches(
  hint: TxManifestActionHint,
  action: string,
): Promise<boolean> {
  return hint.actionTag === await txManifestActionTag(hint.bundleHash, action);
}

async function taggedHash(tag: string, preimage: Uint8Array): Promise<Uint8Array> {
  const tagHash = await sha256(new TextEncoder().encode(tag));
  const taggedPreimage = new Uint8Array(tagHash.length * 2 + preimage.length);
  taggedPreimage.set(tagHash, 0);
  taggedPreimage.set(tagHash, tagHash.length);
  taggedPreimage.set(preimage, tagHash.length * 2);
  return sha256(taggedPreimage);
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  const input = new ArrayBuffer(value.byteLength);
  new Uint8Array(input).set(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}

function bundleHashBytes(bundleHash: TxManifestBundleHash): Uint8Array {
  if (!/^sha256:[0-9a-f]{64}$/.test(bundleHash)) {
    throw new TypeError("Invalid TX Manifest bundle hash.");
  }
  return parseHex(bundleHash.slice("sha256:".length))!;
}

function readPush(
  bytes: Uint8Array,
  offset: number,
): { data: Uint8Array; next: number } | null {
  const opcode = bytes[offset];
  if (opcode === undefined) return null;
  let length: number;
  let dataStart: number;
  if (opcode <= 0x4b) {
    length = opcode;
    dataStart = offset + 1;
  } else if (opcode === 0x4c) {
    const pushedLength = bytes[offset + 1];
    if (pushedLength === undefined) return null;
    length = pushedLength;
    dataStart = offset + 2;
  } else if (opcode === 0x4d) {
    const low = bytes[offset + 1];
    const high = bytes[offset + 2];
    if (low === undefined || high === undefined) return null;
    length = low | (high << 8);
    dataStart = offset + 3;
  } else {
    return null;
  }
  const next = dataStart + length;
  if (next > bytes.length) return null;
  return { data: bytes.slice(dataStart, next), next };
}

function parseHex(value: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
