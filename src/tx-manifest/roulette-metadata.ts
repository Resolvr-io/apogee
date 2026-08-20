import type { TxManifestOutpoint } from "./requirements";
import {
  SIMPLICITY_ROULETTE_V1_CANCEL,
  SIMPLICITY_ROULETTE_V1_CLAIM_PAYOUT,
  SIMPLICITY_ROULETTE_V1_FORFEIT,
  SIMPLICITY_ROULETTE_V1_OPEN,
  SIMPLICITY_ROULETTE_V1_SETTLE,
  SIMPLICITY_ROULETTE_V1_TAKE,
} from "./builtins/simplicity-roulette-v1/actions";
import { txManifestActionHintScript } from "./action-hint";
import type { TxManifestBundleHash } from "./registry";

const MAGIC = "524c5431"; // ASCII "RLT1"
const VERSION = 1;
const HEADER_BYTES = 16;
const MAX_DATA_BYTES = 80;
const MAX_CHUNK_BYTES = MAX_DATA_BYTES - HEADER_BYTES;
const MAX_CHUNKS = 4;

export const ROULETTE_METADATA_V1 = "roulette-metadata-v1" as const;

export type RouletteMetadata =
  | {
      action: "open";
      roundId: string;
      assetId: string;
      playerPayoutScript: string;
      secretCommitment: string;
      betKind: number;
      betSelection: number;
      stake: string;
      bond: string;
      openExpiry: number;
      minRevealAge: number;
      revealExpiry: number;
      covenantVout: number;
    }
  | {
      action: "take";
      roundId: string;
      previous: TxManifestOutpoint;
      housePayoutScript: string;
      houseNonce: string;
      houseCollateral: string;
      covenantVout: number;
    }
  | {
      action: "settle";
      roundId: string;
      previous: TxManifestOutpoint;
      playerSecret: string;
      pocket: number;
    }
  | {
      action: "cancel" | "forfeit";
      roundId: string;
      previous: TxManifestOutpoint;
    }
  | {
      action: "claimPayout";
      roundId: string;
      previous: TxManifestOutpoint;
    };

const ACTION_CODES: Readonly<Record<RouletteMetadata["action"], number>> = {
  open: 0,
  take: 1,
  settle: 2,
  cancel: 3,
  forfeit: 4,
  claimPayout: 5,
};

const ACTION_NAMES: Readonly<Record<RouletteMetadata["action"], string>> = {
  open: SIMPLICITY_ROULETTE_V1_OPEN,
  take: SIMPLICITY_ROULETTE_V1_TAKE,
  settle: SIMPLICITY_ROULETTE_V1_SETTLE,
  cancel: SIMPLICITY_ROULETTE_V1_CANCEL,
  forfeit: SIMPLICITY_ROULETTE_V1_FORFEIT,
  claimPayout: SIMPLICITY_ROULETTE_V1_CLAIM_PAYOUT,
};

const ACTIONS = ["open", "take", "settle", "cancel", "forfeit", "claimPayout"] as const;
const BODY_BYTES: Readonly<Record<RouletteMetadata["action"], number>> = {
  open: 146,
  take: 134,
  settle: 101,
  cancel: 68,
  forfeit: 68,
  claimPayout: 68,
};

export type LocatedRouletteMetadata = {
  metadata: RouletteMetadata;
  chunkStartVout: number;
  chunkEndVout: number;
  txManifestVout: number;
};

/**
 * Encode one logical roulette record as a bounded canonical OP_RETURN chunk set.
 * The immediately-following TXMF output supplies the bundle/action namespace.
 */
export async function rouletteMetadataScripts(metadata: RouletteMetadata): Promise<string[]> {
  const body = encodeBody(metadata);
  const chunks = Math.ceil(body.length / MAX_CHUNK_BYTES);
  if (chunks < 1 || chunks > MAX_CHUNKS) {
    throw new Error(`Roulette metadata requires ${chunks} chunks; the v1 limit is ${MAX_CHUNKS}.`);
  }
  const tag = bytes(metadata.roundId).slice(0, 4);
  const checksum = (await sha256(concat(
    Uint8Array.of(VERSION, ACTION_CODES[metadata.action]),
    body,
  ))).slice(0, 4);
  return Array.from({ length: chunks }, (_, index) => {
    const payload = concat(
      bytes(MAGIC),
      Uint8Array.of(VERSION, ACTION_CODES[metadata.action], index, chunks),
      tag,
      checksum,
      body.slice(index * MAX_CHUNK_BYTES, (index + 1) * MAX_CHUNK_BYTES),
    );
    return opReturn(payload);
  });
}

/** Strict inverse used by history, ClaimPayout, and the registered indexer adapter. */
export async function decodeRouletteTransactionMetadata(
  outputScripts: readonly string[],
  bundleHash: TxManifestBundleHash,
): Promise<LocatedRouletteMetadata | null> {
  const parsed = outputScripts.map((script, outputIndex) => ({
    outputIndex,
    script,
    payload: canonicalPayload(script),
  }));
  const roulette = parsed.filter(({ payload }) => hex(payload ?? new Uint8Array()).startsWith(MAGIC));
  if (roulette.length === 0) return null;
  const first = header(roulette[0]!.payload!, roulette[0]!.outputIndex);
  if (first.index !== 0 || roulette.length !== first.total) throw new Error("RLT1 chunk count or first index is invalid.");
  const bodies: Uint8Array[] = [];
  for (let index = 0; index < first.total; index += 1) {
    const item = roulette[index]!;
    const next = header(item.payload!, item.outputIndex);
    if (
      item.outputIndex !== roulette[0]!.outputIndex + index ||
      next.version !== first.version || next.actionCode !== first.actionCode ||
      next.index !== index || next.total !== first.total || next.roundTag !== first.roundTag ||
      next.checksum !== first.checksum ||
      (index < first.total - 1 && next.body.length !== MAX_CHUNK_BYTES)
    ) throw new Error("RLT1 chunks are noncanonical or inconsistent.");
    bodies.push(next.body);
  }
  const action = ACTIONS[first.actionCode];
  if (!action) throw new Error("RLT1 action code is unknown.");
  const body = concat(...bodies);
  if (body.length !== BODY_BYTES[action] || first.total !== Math.ceil(body.length / MAX_CHUNK_BYTES)) {
    throw new Error("RLT1 action body length is noncanonical.");
  }
  if (hex(body.slice(0, 4)) !== first.roundTag) throw new Error("RLT1 round tag mismatch.");
  const checksum = hex((await sha256(concat(Uint8Array.of(VERSION, first.actionCode), body))).slice(0, 4));
  if (checksum !== first.checksum) throw new Error("RLT1 checksum mismatch.");
  const txManifestVout = roulette[0]!.outputIndex + first.total;
  if (outputScripts[txManifestVout] !== await txManifestActionHintScript(bundleHash, ACTION_NAMES[action])) {
    throw new Error("RLT1 is not immediately authenticated by its canonical TXMF action marker.");
  }
  return {
    metadata: decodeBody(action, body),
    chunkStartVout: roulette[0]!.outputIndex,
    chunkEndVout: roulette.at(-1)!.outputIndex,
    txManifestVout,
  };
}

type Header = {
  version: number;
  actionCode: number;
  index: number;
  total: number;
  roundTag: string;
  checksum: string;
  body: Uint8Array;
};

function header(payload: Uint8Array, outputIndex: number): Header {
  if (payload.length <= HEADER_BYTES || payload.length > MAX_DATA_BYTES || hex(payload.slice(0, 4)) !== MAGIC) {
    throw new Error(`Output ${outputIndex} is not a canonical RLT1 chunk.`);
  }
  if (payload[4] !== VERSION || !payload[7] || payload[7]! > MAX_CHUNKS) throw new Error("RLT1 version or chunk count is unsupported.");
  return {
    version: payload[4]!,
    actionCode: payload[5]!,
    index: payload[6]!,
    total: payload[7]!,
    roundTag: hex(payload.slice(8, 12)),
    checksum: hex(payload.slice(12, 16)),
    body: payload.slice(HEADER_BYTES),
  };
}

function decodeBody(action: RouletteMetadata["action"], body: Uint8Array): RouletteMetadata {
  const roundId = hex(body.slice(0, 32));
  if (action === "open") {
    const decoded = {
      action,
      roundId,
      assetId: hex(body.slice(32, 64)),
      playerPayoutScript: hex(body.slice(64, 86)),
      secretCommitment: hex(body.slice(86, 118)),
      betKind: number(body.slice(118, 119)),
      betSelection: number(body.slice(119, 120)),
      stake: big(body.slice(120, 128)).toString(),
      bond: big(body.slice(128, 136)).toString(),
      openExpiry: number(body.slice(136, 138)),
      minRevealAge: number(body.slice(138, 140)),
      revealExpiry: number(body.slice(140, 142)),
      covenantVout: number(body.slice(142, 146)),
    } satisfies RouletteMetadata;
    p2wpkh(decoded.playerPayoutScript, "playerPayoutScript");
    if (decoded.stake === "0") throw new Error("RLT1 Open stake must be positive.");
    if (decoded.betKind > 8 || (decoded.betKind === 0
      ? decoded.betSelection > 36
      : decoded.betKind >= 7
        ? decoded.betSelection < 1 || decoded.betSelection > 3
        : decoded.betSelection !== 0)) {
      throw new Error("RLT1 Open bet selection is invalid.");
    }
    if (decoded.openExpiry < 1 || decoded.minRevealAge < 1 || decoded.revealExpiry <= decoded.minRevealAge) {
      throw new Error("RLT1 Open relative delays are invalid.");
    }
    if (decoded.covenantVout !== 0) throw new Error("RLT1 Open covenant output must be vout zero.");
    return decoded;
  }
  const previous = decodeOutpoint(body.slice(32, 68));
  if (action === "take") {
    const decoded = {
      action,
      roundId,
      previous,
      housePayoutScript: hex(body.slice(68, 90)),
      houseNonce: hex(body.slice(90, 122)),
      houseCollateral: big(body.slice(122, 130)).toString(),
      covenantVout: number(body.slice(130, 134)),
    } satisfies RouletteMetadata;
    p2wpkh(decoded.housePayoutScript, "housePayoutScript");
    if (/^0+$/.test(decoded.houseNonce) || decoded.houseCollateral === "0") {
      throw new Error("RLT1 Take nonce and collateral must be nonzero.");
    }
    if (decoded.covenantVout !== 0) throw new Error("RLT1 Take covenant output must be vout zero.");
    return decoded;
  }
  if (action === "settle") {
    const decoded = {
      action,
      roundId,
      previous,
      playerSecret: hex(body.slice(68, 100)),
      pocket: number(body.slice(100, 101)),
    } satisfies RouletteMetadata;
    if (decoded.pocket > 36) throw new Error("RLT1 Settle pocket is invalid.");
    return decoded;
  }
  return { action, roundId, previous };
}

function decodeOutpoint(value: Uint8Array): TxManifestOutpoint {
  return { txid: hex(value.slice(0, 32).reverse()), vout: number(value.slice(32, 36).reverse()) };
}

function canonicalPayload(script: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/.test(script)) return null;
  const encoded = bytes(script);
  if (encoded[0] !== 0x6a || encoded.length < 3) return null;
  const opcode = encoded[1]!;
  const length = opcode <= 0x4b ? opcode : opcode === 0x4c ? encoded[2]! : -1;
  const start = opcode <= 0x4b ? 2 : 3;
  if (length < 1 || length > MAX_DATA_BYTES || start + length !== encoded.length) return null;
  const payload = encoded.slice(start);
  return opReturn(payload) === script ? payload : null;
}

function number(value: Uint8Array): number {
  const decoded = big(value);
  if (decoded > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("RLT1 integer exceeds JavaScript safe range.");
  return Number(decoded);
}

function big(value: Uint8Array): bigint {
  const encoded = hex(value);
  return encoded ? BigInt(`0x${encoded}`) : 0n;
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  const input = new ArrayBuffer(value.byteLength);
  new Uint8Array(input).set(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}

function encodeBody(metadata: RouletteMetadata): Uint8Array {
  const common = [fixed32(metadata.roundId, "roundId")];
  switch (metadata.action) {
    case "open":
      return concat(
        ...common,
        fixed32(metadata.assetId, "assetId"),
        p2wpkh(metadata.playerPayoutScript, "playerPayoutScript"),
        fixed32(metadata.secretCommitment, "secretCommitment"),
        unsigned(metadata.betKind, 1, "betKind"),
        unsigned(metadata.betSelection, 1, "betSelection"),
        decimal(metadata.stake, 8, "stake"),
        decimal(metadata.bond, 8, "bond"),
        unsigned(metadata.openExpiry, 2, "openExpiry"),
        unsigned(metadata.minRevealAge, 2, "minRevealAge"),
        unsigned(metadata.revealExpiry, 2, "revealExpiry"),
        unsigned(metadata.covenantVout, 4, "covenantVout"),
      );
    case "take":
      return concat(
        ...common,
        outpoint(metadata.previous),
        p2wpkh(metadata.housePayoutScript, "housePayoutScript"),
        fixed32(metadata.houseNonce, "houseNonce"),
        decimal(metadata.houseCollateral, 8, "houseCollateral"),
        unsigned(metadata.covenantVout, 4, "covenantVout"),
      );
    case "settle":
      return concat(
        ...common,
        outpoint(metadata.previous),
        fixed32(metadata.playerSecret, "playerSecret"),
        unsigned(metadata.pocket, 1, "pocket"),
      );
    case "cancel":
    case "forfeit":
    case "claimPayout":
      return concat(...common, outpoint(metadata.previous));
  }
}

function outpoint(value: TxManifestOutpoint): Uint8Array {
  // Transaction ids are displayed in reverse consensus serialization order.
  return concat(fixed32(value.txid, "txid").reverse(), unsigned(value.vout, 4, "vout", true));
}

function opReturn(payload: Uint8Array): string {
  if (payload.length > MAX_DATA_BYTES) throw new Error("Roulette metadata exceeds the relay target.");
  const push = payload.length <= 0x4b
    ? Uint8Array.of(payload.length)
    : Uint8Array.of(0x4c, payload.length);
  return hex(concat(Uint8Array.of(0x6a), push, payload));
}

function fixed32(value: string, label: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be 32-byte lowercase hex.`);
  return bytes(value);
}

function p2wpkh(value: string, label: string): Uint8Array {
  if (!/^0014[0-9a-f]{40}$/.test(value)) throw new Error(`${label} must be a canonical P2WPKH script.`);
  return bytes(value);
}

function decimal(value: string, width: number, label: string): Uint8Array {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be an unsigned decimal string.`);
  return bigint(BigInt(value), width, label);
}

function unsigned(
  value: number,
  width: number,
  label: string,
  littleEndian = false,
): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be an unsigned integer.`);
  const encoded = bigint(BigInt(value), width, label);
  return littleEndian ? encoded.reverse() : encoded;
}

function bigint(value: bigint, width: number, label: string): Uint8Array {
  if (value < 0n || value >= 1n << BigInt(width * 8)) throw new Error(`${label} does not fit u${width * 8}.`);
  return bytes(value.toString(16).padStart(width * 2, "0"));
}

function bytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
