// SimplicityHL witness values — turning a manifest's declared witness
// (`{ simplicity_type: "Either<u32, u32>", value: "Left(0)" }`) into the typed
// lwk value the engine feeds to `SimplicityProgram.finalizeTransaction`.
//
// Scope is the KEYLESS subset that keyless covenant spends use:
// unsigned integers, bool, `Either<L, R>`, and `Option<T>`, with LITERAL values.
// Anything outside it (signatures, field references, tuples, byte arrays) is
// refused loudly rather than mis-encoded — a wrong witness produces a transaction
// the covenant rejects only after the user has approved it.
//
// Like covenant.ts, the lwk module is injected so this is unit-testable in Node
// against the pkg_node build.

import type * as Lwk from "lwk_wasm";
import type { PlannedWitness } from "./runner";

/** Minimal slice of lwk_wasm this file needs — lets a test inject pkg_node. */
export type WitnessLwk = Pick<
  typeof Lwk,
  "SimplicityType" | "SimplicityTypedValue" | "SimplicityWitnessValues"
>;

/** Raised for a witness we can't encode. The message reaches the dapp. */
export class WitnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WitnessError";
  }
}

/** Split a comma-separated generic argument list at the TOP level (ignore nested `<...>`). */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "<") depth++;
    else if (c === ">") depth--;
    else if (c === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts.map((p) => p.trim());
}

/** If `t` is `Name<...>`, return the inside; else null. */
function unwrapGeneric(t: string, name: string): string | null {
  const trimmed = t.trim();
  if (!trimmed.startsWith(name)) return null;
  const rest = trimmed.slice(name.length).trim();
  if (!rest.startsWith("<") || !rest.endsWith(">")) return null;
  return rest.slice(1, -1).trim();
}

/** If `v` is `Name(...)`, return the inside; else null. `Name` with no parens → "". */
function unwrapCall(v: string, name: string): string | null {
  const trimmed = v.trim();
  if (trimmed === name || trimmed === `${name}()`) return "";
  if (!trimmed.startsWith(name)) return null;
  const rest = trimmed.slice(name.length).trim();
  if (!rest.startsWith("(") || !rest.endsWith(")")) return null;
  return rest.slice(1, -1).trim();
}

const UINT_BITS: Record<string, number> = { u1: 1, u8: 8, u16: 16, u32: 32, u64: 64 };

/** Build an lwk `SimplicityType` from a type string (recursive subset). */
export function buildType(lwk: WitnessLwk, typeStr: string): Lwk.SimplicityType {
  const t = typeStr.trim();
  switch (t) {
    case "u1":
      return lwk.SimplicityType.u1();
    case "u8":
      return lwk.SimplicityType.u8();
    case "u16":
      return lwk.SimplicityType.u16();
    case "u32":
      return lwk.SimplicityType.u32();
    case "u64":
      return lwk.SimplicityType.u64();
    case "u128":
      return lwk.SimplicityType.u128();
    case "u256":
      return lwk.SimplicityType.u256();
    case "bool":
      return lwk.SimplicityType.boolean();
  }
  const either = unwrapGeneric(t, "Either");
  if (either !== null) {
    const parts = splitTopLevel(either);
    if (parts.length !== 2) throw new WitnessError(`Either needs two type args, got "${typeStr}".`);
    return lwk.SimplicityType.either(buildType(lwk, parts[0]), buildType(lwk, parts[1]));
  }
  const option = unwrapGeneric(t, "Option");
  if (option !== null) {
    return lwk.SimplicityType.option(buildType(lwk, option));
  }
  throw new WitnessError(`Unsupported Simplicity type "${typeStr}".`);
}

/** Build an unsigned-integer typed value, accepting decimal or 0x-hex. */
function buildUint(lwk: WitnessLwk, type: string, raw: string): Lwk.SimplicityTypedValue {
  const v = raw.trim();
  const isHex = v.startsWith("0x") || v.startsWith("0X");
  const n = isHex ? BigInt(v) : /^[0-9]+$/.test(v) ? BigInt(v) : null;
  if (n === null) throw new WitnessError(`Expected an integer for ${type}, got "${raw}".`);
  const bits = UINT_BITS[type];
  if (n < 0n || n > (1n << BigInt(bits)) - 1n) {
    throw new WitnessError(`Value ${v} is out of range for ${type}.`);
  }
  switch (type) {
    case "u8":
      return lwk.SimplicityTypedValue.fromU8(Number(n));
    case "u16":
      return lwk.SimplicityTypedValue.fromU16(Number(n));
    case "u32":
      return lwk.SimplicityTypedValue.fromU32(Number(n));
    case "u64":
      return lwk.SimplicityTypedValue.fromU64(n);
    default:
      // u1 has no dedicated constructor; lwk's generic parser handles it.
      return lwk.SimplicityTypedValue.parse(n.toString(), buildType(lwk, type));
  }
}

/**
 * Build a typed value from a type + literal value string (recursive subset).
 *
 * `Either<L, R>` picks the branch from the value's `Left(...)`/`Right(...)` head
 * and supplies the OTHER branch's type, exactly as lwk's `.left`/`.right` require.
 */
export function buildValue(
  lwk: WitnessLwk,
  typeStr: string,
  valueStr: string,
): Lwk.SimplicityTypedValue {
  const t = typeStr.trim();

  const either = unwrapGeneric(t, "Either");
  if (either !== null) {
    const parts = splitTopLevel(either);
    if (parts.length !== 2) throw new WitnessError(`Either needs two type args, got "${typeStr}".`);
    const [leftType, rightType] = parts;
    const leftInner = unwrapCall(valueStr, "Left");
    if (leftInner !== null) {
      return lwk.SimplicityTypedValue.left(
        buildValue(lwk, leftType, leftInner),
        buildType(lwk, rightType),
      );
    }
    const rightInner = unwrapCall(valueStr, "Right");
    if (rightInner !== null) {
      return lwk.SimplicityTypedValue.right(
        buildType(lwk, leftType),
        buildValue(lwk, rightType, rightInner),
      );
    }
    throw new WitnessError(`Expected Left(..)/Right(..) for ${typeStr}, got "${valueStr}".`);
  }

  const option = unwrapGeneric(t, "Option");
  if (option !== null) {
    if (valueStr.trim() === "None" || valueStr.trim() === "None()") {
      return lwk.SimplicityTypedValue.none(buildType(lwk, option));
    }
    const someInner = unwrapCall(valueStr, "Some");
    if (someInner !== null) return lwk.SimplicityTypedValue.some(buildValue(lwk, option, someInner));
    throw new WitnessError(`Expected Some(..)/None for ${typeStr}, got "${valueStr}".`);
  }

  if (t === "bool") {
    const v = valueStr.trim();
    if (v !== "true" && v !== "false") {
      throw new WitnessError(`Expected true/false for bool, got "${valueStr}".`);
    }
    return lwk.SimplicityTypedValue.fromBoolean(v === "true");
  }

  if (t in UINT_BITS) return buildUint(lwk, t, valueStr);

  throw new WitnessError(`Unsupported Simplicity witness type "${typeStr}".`);
}

/**
 * Build the `SimplicityWitnessValues` for a covenant input's witnesses, in the
 * order the manifest declared them.
 */
export function buildWitnessValues(
  lwk: WitnessLwk,
  witnesses: PlannedWitness[],
): Lwk.SimplicityWitnessValues {
  let wv = new lwk.SimplicityWitnessValues();
  for (const w of witnesses) {
    wv = wv.addValue(w.name, buildValue(lwk, w.simplicityType, w.value));
  }
  return wv;
}
