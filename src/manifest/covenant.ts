// Covenant address derivation (Spec §11).
//
//   address = P2TR(internal_key = NUMS, merkle_root = tapbranch(cmr_leaf, extra_leaves...))
//
// For a single-leaf covenant (last_will, p2pk) there are no extra leaves, so the
// merkle root is just the program's CMR leaf — which is exactly what lwk_wasm's
// SimplicityProgram.createP2trAddress computes. Multi-leaf / StateTaprootBuilder
// covenants (lending_v3's stateful taproot) are deferred.
//
// This module takes the `lwk` module as a parameter rather than importing it, so
// it runs both inside the offscreen document (the real bundler build) and in a
// Node test against the pkg_node build — the derivation is the thing we most want
// an independent oracle for, and injecting lwk is what makes that testable.

import type * as Lwk from "lwk_wasm";
import type { LiquidNetwork } from "@/keystore/keystore";
import type { FieldType } from "./types";

/** BIP341 NUMS point — the unspendable internal key every covenant shares (Spec §11). */
export const NUMS_KEY = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";

/** A resolved compile parameter: a .simf param name, its manifest type, and its value. */
export interface CompileParam {
  /** The parameter name as it appears in the .simf source (e.g. "INHERITOR_PUB_KEY"). */
  name: string;
  type: FieldType;
  /** Resolved value: hex for byte types, decimal for integers, "true"/"false" for bool. */
  value: string;
}

/** Minimal slice of the lwk_wasm module this file needs — lets a test inject pkg_node. */
export type LwkLike = Pick<
  typeof Lwk,
  "SimplicityArguments" | "SimplicityTypedValue" | "SimplicityProgram" | "XOnlyPublicKey" | "Network"
>;

function strip0x(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

function lwkNetwork(lwk: LwkLike, network: LiquidNetwork): Lwk.Network {
  switch (network) {
    case "liquid":
      return lwk.Network.mainnet();
    case "liquidtestnet":
      return lwk.Network.testnet();
    case "regtest":
      // lwk's default regtest policy asset; covenant addressing doesn't depend on it.
      return lwk.Network.regtestDefault();
  }
}

/**
 * Reverse a 32-byte hex string. Elements displays asset ids (and txids) in the
 * reverse of their internal encoding, so an asset id written in a manifest is in
 * DISPLAY order and must be flipped before it goes into a covenant.
 */
function reverseHex32(hex: string): string {
  const pairs = hex.match(/../g);
  if (!pairs || pairs.length !== 32) {
    throw new Error(`expected 32 bytes of hex, got ${hex.length / 2}`);
  }
  return pairs.reverse().join("");
}

/**
 * Convert a manifest-typed value to a SimplicityHL typed value.
 *
 * Byte types (pubkey, bytes32, liquid.asset_id) are all u256-hex, but ONLY
 * `liquid.asset_id` is byte-reversed — it's the one type carried in Elements
 * display order. `pubkey` and `bytes32` pass through untouched.
 *
 * Getting this backwards fails badly and late: reversing a `bytes32` too yields a
 * perfectly valid-looking address that is simply the wrong one, and you find out
 * as a covenant rejection long after the user approved. Test vectors pin both
 * halves — an asset id reversed, a script hash not — precisely to catch it.
 */
function typedValue(lwk: LwkLike, type: FieldType, value: string): Lwk.SimplicityTypedValue {
  switch (type) {
    case "u8":
      return lwk.SimplicityTypedValue.fromU8(Number(value));
    case "u16":
      return lwk.SimplicityTypedValue.fromU16(Number(value));
    case "u32":
      return lwk.SimplicityTypedValue.fromU32(Number(value));
    case "u64":
      return lwk.SimplicityTypedValue.fromU64(BigInt(value));
    case "bool":
      return lwk.SimplicityTypedValue.fromBoolean(value === "true");
    case "bytes32":
    case "pubkey":
      return lwk.SimplicityTypedValue.fromU256Hex(strip0x(value));
    case "liquid.asset_id":
      return lwk.SimplicityTypedValue.fromU256Hex(reverseHex32(strip0x(value)));
  }
}

/** Build a SimplicityArguments from resolved compile params, in declaration order. */
export function buildArguments(lwk: LwkLike, params: CompileParam[]): Lwk.SimplicityArguments {
  let args = new lwk.SimplicityArguments();
  for (const p of params) {
    args = args.addValue(p.name, typedValue(lwk, p.type, p.value));
  }
  return args;
}

/** Compile a .simf source with resolved params and return its CMR (hex). */
export function computeCmr(
  lwk: LwkLike,
  source: string,
  params: CompileParam[],
  debugSymbols = false,
): string {
  const args = buildArguments(lwk, params);
  const program = debugSymbols
    ? lwk.SimplicityProgram.loadWithDebugSymbols(source, args, true)
    : lwk.SimplicityProgram.load(source, args);
  return program.cmr.toString();
}

/**
 * Derive the covenant address for a single-leaf Simplicity covenant.
 *
 * `debugSymbols` MUST match the protocol's toolchain: it changes the CMR and thus
 * the address. last_will/p2pk compile with it off; lending_v3 needs it on.
 */
export function deriveCovenantAddress(
  lwk: LwkLike,
  source: string,
  params: CompileParam[],
  network: LiquidNetwork,
  debugSymbols = false,
): string {
  const args = buildArguments(lwk, params);
  const program = debugSymbols
    ? lwk.SimplicityProgram.loadWithDebugSymbols(source, args, true)
    : lwk.SimplicityProgram.load(source, args);
  const nums = lwk.XOnlyPublicKey.fromString(NUMS_KEY);
  return program.createP2trAddress(nums, lwkNetwork(lwk, network)).toString();
}

/**
 * `SHA256(scriptPubKey)` of a covenant's P2TR address — the form a covenant
 * commits to when it checks *another* covenant's output (templates.md §3's
 * `lang: "tapleaf"`).
 *
 * Async because it uses WebCrypto, the one SHA-256 available in both the
 * offscreen document and Node without pulling in a dependency.
 *
 * Note the hash covers the SCRIPT, not the address text, so it is
 * network-independent — but the address is derived on a network to get there, and
 * P2TR scripts don't vary by network, so any choice gives the same digest.
 */
export async function computeCovenantScriptHash(
  lwk: LwkLike,
  source: string,
  params: CompileParam[],
  network: LiquidNetwork = "liquidtestnet",
  debugSymbols = false,
): Promise<string> {
  const args = buildArguments(lwk, params);
  const program = debugSymbols
    ? lwk.SimplicityProgram.loadWithDebugSymbols(source, args, true)
    : lwk.SimplicityProgram.load(source, args);
  const nums = lwk.XOnlyPublicKey.fromString(NUMS_KEY);
  const spk = program.createP2trAddress(nums, lwkNetwork(lwk, network)).scriptPubkey().bytes();
  const digest = await crypto.subtle.digest("SHA-256", spk as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * SYNCHRONOUS `SHA256(scriptPubKey)` of a covenant's P2TR address.
 *
 * Same result as `computeCovenantScriptHash`, but uses lwk's own
 * `Script.jet_sha256_hex()` — a plain synchronous SHA-256 over the script's
 * consensus bytes — instead of the async WebCrypto path. The runner's instance
 * resolution (templates.md §3's `compute: tapleaf`) runs
 * inside the otherwise-synchronous `planAction`, so keeping this sync avoids
 * threading async (and a Promise) through the whole planner and its tests.
 */
export function computeCovenantScriptHashSync(
  lwk: LwkLike,
  source: string,
  params: CompileParam[],
  network: LiquidNetwork = "liquidtestnet",
  debugSymbols = false,
): string {
  const args = buildArguments(lwk, params);
  const program = debugSymbols
    ? lwk.SimplicityProgram.loadWithDebugSymbols(source, args, true)
    : lwk.SimplicityProgram.load(source, args);
  const nums = lwk.XOnlyPublicKey.fromString(NUMS_KEY);
  return program.createP2trAddress(nums, lwkNetwork(lwk, network)).scriptPubkey().jet_sha256_hex();
}
