import type { RouletteTerms } from "./roulette-requirements";
import {
  SIMPLICITY_ROULETTE_V1_CMR,
  SIMPLICITY_ROULETTE_V1_TAPLEAF_HASH,
} from "./builtins/simplicity-roulette-v1";
import {
  compileTxManifestCovenant,
  type TxManifestCovenantCommitments,
  type TxManifestCovenantCompileSpec,
  type TxManifestCovenantFinalizeSpec,
} from "./runtime";

const ZERO = "00".repeat(32);
const STATE_TAG = "8a8292fd9c81ece6190ef425fc745f161f70cdd1733033b34b61ee25e9b90506";
const TERMS_TAG = "7ed114edf4d1ea453f94a864fb8783a5ee3d95ba81e8482a323088de0a8f4d5d";
const SECRET_TAG = "3133afa8be56c1678fb58d64cbd95f209a4783a6383f3dfaf486560f1666a040";
const OUTCOME_TAG = "3770f72d22053d3c14aeddbb489b735f6b3f7222a683931c718df6154b178266";

export type RouletteCovenantState = {
  phase: 0 | 1;
  roundId: string;
  /** LWK/display byte order. Converted exactly once at the Simplicity boundary. */
  assetId: string;
  playerScriptHash: string;
  houseScriptHash: string;
  secretCommitment: string;
  betKind: number;
  betSelection: number;
  stake: string;
  bond: string;
  openExpiry: number;
  minRevealAge: number;
  revealExpiry: number;
  houseNonce: string;
  houseCollateral: string;
};

export type RouletteSpendPath =
  | { action: "take"; houseNonce: string; houseScriptHash: string; houseCollateral: string; houseInputIndex: number }
  | { action: "cancel" }
  | { action: "settle"; playerSecret: string }
  | { action: "forfeit" };

type Compile = (spec: TxManifestCovenantCompileSpec) => Promise<TxManifestCovenantCommitments>;

export async function compileRouletteV1State(
  source: string,
  state: RouletteCovenantState,
  network: TxManifestCovenantCompileSpec["network"],
  compile: Compile = compileTxManifestCovenant,
): Promise<{ covenant: TxManifestCovenantCommitments; stateWord: string }> {
  const stateWord = await rouletteStateWord(state);
  const covenant = await compile({
    source,
    arguments: {},
    extra_leaf_payloads: [stateWord],
    network,
    // The canonical roulette program is the non-debug simc 0.7.0 build.
    // Older SimplicityHL frontends can alter CMR when debug symbols are on.
    include_debug_symbols: false,
  });
  if (
    covenant.cmr !== SIMPLICITY_ROULETTE_V1_CMR ||
    covenant.tapleaf_hash !== SIMPLICITY_ROULETTE_V1_TAPLEAF_HASH
  ) {
    throw new Error("The roulette compiler commitment does not match the reviewed v1 program.");
  }
  return { stateWord, covenant };
}

export function rouletteFinalizeExecution(
  source: string,
  state: RouletteCovenantState,
  stateWord: string,
  path: RouletteSpendPath,
  inputIndex: number,
  genesisHash: string,
): Omit<TxManifestCovenantFinalizeSpec, "pset"> {
  return {
    source,
    arguments: {},
    extra_leaf_payloads: [stateWord],
    witnesses: rouletteWitnesses(state, path),
    input_index: inputIndex,
    genesis_hash: genesisHash,
    include_debug_symbols: false,
  };
}

export function rouletteWitnesses(
  state: RouletteCovenantState,
  path: RouletteSpendPath,
): NonNullable<TxManifestCovenantFinalizeSpec["witnesses"]> {
  return {
    PHASE: witness(String(state.phase)),
    ROUND_ID: witness(hexValue(state.roundId, "roundId")),
    ASSET_ID: witness(hexValue(reverseAssetId(state.assetId), "assetId")),
    PLAYER_SCRIPT_HASH: witness(hexValue(state.playerScriptHash, "playerScriptHash")),
    HOUSE_SCRIPT_HASH: witness(hexValue(state.houseScriptHash, "houseScriptHash")),
    SECRET_COMMITMENT: witness(hexValue(state.secretCommitment, "secretCommitment")),
    BET_KIND: witness(String(state.betKind)),
    BET_SELECTION: witness(String(state.betSelection)),
    STAKE: witness(state.stake),
    BOND: witness(state.bond),
    OPEN_EXPIRY: witness(String(state.openExpiry)),
    MIN_REVEAL_AGE: witness(String(state.minRevealAge)),
    REVEAL_EXPIRY: witness(String(state.revealExpiry)),
    HOUSE_NONCE: witness(hexValue(state.houseNonce, "houseNonce")),
    HOUSE_COLLATERAL: witness(state.houseCollateral),
    PATH: witness(pathValue(path)),
  };
}

export async function rouletteScriptHash(scriptPubKey: string): Promise<string> {
  if (!/^(?:[0-9a-f]{2})+$/.test(scriptPubKey)) throw new Error("Payout script must be lowercase even-length hex.");
  return hex(await sha256(bytes(scriptPubKey)));
}

/** Tagged TERMS hash used by both secret commitment and unbiased outcome. */
export async function rouletteTermsHash(terms: Omit<RouletteCovenantState,
  "phase" | "playerScriptHash" | "houseScriptHash" | "secretCommitment" | "houseNonce" | "houseCollateral"
>): Promise<string> {
  return tagged(TERMS_TAG, concat(
    fixed32(terms.roundId, "roundId"),
    fixed32(reverseAssetId(terms.assetId), "assetId"),
    u(terms.betKind, 4, "betKind"),
    u(terms.betSelection, 4, "betSelection"),
    decimal(terms.stake, 8, "stake"),
    decimal(terms.bond, 8, "bond"),
    u(terms.openExpiry, 2, "openExpiry"),
    u(terms.minRevealAge, 2, "minRevealAge"),
    u(terms.revealExpiry, 2, "revealExpiry"),
  ));
}

export async function rouletteSecretCommitment(
  terms: Parameters<typeof rouletteTermsHash>[0],
  playerSecret: string,
): Promise<string> {
  const termsHash = await rouletteTermsHash(terms);
  return tagged(SECRET_TAG, concat(
    fixed32(terms.roundId, "roundId"),
    fixed32(termsHash, "termsHash"),
    fixed32(playerSecret, "playerSecret"),
  ));
}

export async function rouletteStateWord(state: RouletteCovenantState): Promise<string> {
  return tagged(STATE_TAG, concat(
    u(state.phase, 4, "phase"),
    fixed32(state.roundId, "roundId"),
    fixed32(reverseAssetId(state.assetId), "assetId"),
    fixed32(state.playerScriptHash, "playerScriptHash"),
    fixed32(state.houseScriptHash, "houseScriptHash"),
    fixed32(state.secretCommitment, "secretCommitment"),
    u(state.betKind, 4, "betKind"),
    u(state.betSelection, 4, "betSelection"),
    decimal(state.stake, 8, "stake"),
    decimal(state.bond, 8, "bond"),
    u(state.openExpiry, 2, "openExpiry"),
    u(state.minRevealAge, 2, "minRevealAge"),
    u(state.revealExpiry, 2, "revealExpiry"),
    fixed32(state.houseNonce, "houseNonce"),
    decimal(state.houseCollateral, 8, "houseCollateral"),
  ));
}

export async function rouletteOutcome(
  state: RouletteCovenantState,
  playerSecret: string,
): Promise<number> {
  const termsHash = await rouletteTermsHash(state);
  for (let counter = 0; counter <= 1; counter += 1) {
    const block = bytes(await tagged(OUTCOME_TAG, concat(
      fixed32(state.roundId, "roundId"),
      fixed32(termsHash, "termsHash"),
      fixed32(playerSecret, "playerSecret"),
      fixed32(state.houseNonce, "houseNonce"),
      u(counter, 4, "counter"),
    )));
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let offset = 0; offset < 32; offset += 4) {
      const cursor = view.getUint32(offset, false);
      if (cursor < 4_294_967_289) return cursor % 37;
    }
  }
  throw new Error("Roulette rejection sampler exhausted its two bounded blocks.");
}

export function roulettePayouts(state: RouletteCovenantState, pocket: number): {
  playerAmount: string;
  houseAmount: string;
} {
  if (!Number.isInteger(pocket) || pocket < 0 || pocket > 36) throw new Error("Roulette pocket is out of range.");
  const openAmount = BigInt(state.stake) + BigInt(state.bond);
  const activeAmount = openAmount + BigInt(state.houseCollateral);
  const playerReturn = betWins(state.betKind, state.betSelection, pocket)
    ? BigInt(state.stake) * BigInt(payoutOdds(state.betKind) + 1)
    : 0n;
  const playerAmount = BigInt(state.bond) + playerReturn;
  if (playerAmount > activeAmount) throw new Error("Roulette payout exceeds the ACTIVE covenant amount.");
  return { playerAmount: playerAmount.toString(), houseAmount: (activeAmount - playerAmount).toString() };
}

export function rouletteOpenState(terms: RouletteTerms, playerScriptHash: string): RouletteCovenantState {
  return {
    phase: 0,
    roundId: terms.roundId,
    assetId: terms.assetId,
    playerScriptHash,
    houseScriptHash: ZERO,
    secretCommitment: terms.secretCommitment,
    betKind: terms.betKind,
    betSelection: terms.betSelection,
    stake: terms.stake,
    bond: terms.bond,
    openExpiry: terms.openExpiry,
    minRevealAge: terms.minRevealAge,
    revealExpiry: terms.revealExpiry,
    houseNonce: ZERO,
    houseCollateral: "0",
  };
}

export function rouletteActiveState(
  open: RouletteCovenantState,
  houseScriptHash: string,
  houseNonce: string,
  houseCollateral: string,
): RouletteCovenantState {
  return { ...open, phase: 1, houseScriptHash, houseNonce, houseCollateral };
}

export function reverseAssetId(assetId: string): string {
  return hex(fixed32(assetId, "assetId").reverse());
}

function pathValue(path: RouletteSpendPath): string {
  switch (path.action) {
    case "take":
      return `Left(Left((${hexValue(path.houseNonce, "houseNonce")}, ${hexValue(path.houseScriptHash, "houseScriptHash")}, ${path.houseCollateral}, ${path.houseInputIndex})))`;
    case "cancel": return "Left(Right(()))";
    case "settle": return `Right(Left(${hexValue(path.playerSecret, "playerSecret")}))`;
    case "forfeit": return "Right(Right(()))";
  }
}

function witness(value: string): { type: "simplicityhl"; value: string } {
  return { type: "simplicityhl", value };
}

function hexValue(value: string, label: string): string {
  return `0x${hex(fixed32(value, label))}`;
}

function payoutOdds(kind: number): number {
  return kind === 0 ? 35 : kind === 7 || kind === 8 ? 2 : 1;
}

function betWins(kind: number, selection: number, pocket: number): boolean {
  if (kind === 0) return pocket === selection;
  if (pocket === 0) return false;
  if (kind === 1) return new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]).has(pocket);
  if (kind === 2) return !betWins(1, 0, pocket);
  if (kind === 3) return pocket % 2 === 1;
  if (kind === 4) return pocket % 2 === 0;
  if (kind === 5) return pocket <= 18;
  if (kind === 6) return pocket >= 19;
  if (kind === 7) return Math.floor((pocket - 1) / 12) + 1 === selection;
  return ((pocket - 1) % 3) + 1 === selection;
}

async function tagged(tag: string, payload: Uint8Array): Promise<string> {
  const tagBytes = fixed32(tag, "tag");
  return hex(await sha256(concat(tagBytes, tagBytes, payload)));
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  const input = new ArrayBuffer(value.byteLength);
  new Uint8Array(input).set(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}

function decimal(value: string, width: number, label: string): Uint8Array {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be a decimal integer.`);
  return big(BigInt(value), width, label);
}

function u(value: number, width: number, label: string): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be an unsigned integer.`);
  return big(BigInt(value), width, label);
}

function big(value: bigint, width: number, label: string): Uint8Array {
  if (value < 0n || value >= 1n << BigInt(width * 8)) throw new Error(`${label} does not fit u${width * 8}.`);
  return bytes(value.toString(16).padStart(width * 2, "0"));
}

function fixed32(value: string, label: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be 32-byte lowercase hex.`);
  return bytes(value);
}

function bytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
