import type { PublicWalletDescriptorDTO } from "./protocol";

// BIP-380 descriptor checksum constants. Keep this implementation local to the
// engine: descriptor projection is a security boundary and must not depend on
// page-supplied parsing or string replacement.
const INPUT_CHARSET =
  "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
const CHECKSUM_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
/** The only blinding policy this module will project, and the single source for
 *  that predicate (see slip77KeyOf). */
const SLIP77_POLICY = /^slip77\(([0-9a-f]{64})\)$/;
const GENERATOR = [
  0xf5dee51989n,
  0xa9fdca3312n,
  0x1bab10e32dn,
  0x3706b1677an,
  0x644d626ffdn,
] as const;

/**
 * Project an LWK-canonicalized SLIP-77 CT descriptor to its ordinary public
 * output descriptor. The caller MUST validate/canonicalize with
 * `WolletDescriptor` before calling this function.
 *
 * Only SLIP-77 is accepted: removing its independent master blinding key leaves
 * a descriptor that can derive scripts but cannot derive confidential
 * addresses or unblind outputs. Other blinding policies fail closed because an
 * ordinary descriptor can itself be view-capable (for example ELIP-151).
 */
export function publicWalletDescriptor(
  canonicalCtDescriptor: string,
): PublicWalletDescriptorDTO {
  const payload = descriptorPayload(canonicalCtDescriptor);
  const [blindingPolicy, ordinaryDescriptor] = parseOuterCt(payload);

  if (!SLIP77_POLICY.test(blindingPolicy)) {
    throw new Error("This wallet's blinding policy cannot be safely disclosed as a public descriptor.");
  }
  if (ordinaryDescriptor.includes("ct(")) {
    throw new Error("Nested confidential descriptors cannot be disclosed.");
  }
  if (!ordinaryDescriptor.includes("<0;1>/*")) {
    throw new Error("This wallet does not have a BIP-389 external/internal multipath descriptor.");
  }
  assertNoPrivateSpendKeys(ordinaryDescriptor);

  return {
    descriptor: withDescriptorChecksum(ordinaryDescriptor),
    standardsUsed: descriptorStandards(ordinaryDescriptor),
  };
}

/** Add the BIP-380 checksum to an output descriptor payload. */
export function withDescriptorChecksum(payload: string): string {
  const symbols = expandChecksumSymbols(payload);
  const checksum = descriptorPolymod([...symbols, 0, 0, 0, 0, 0, 0, 0, 0]) ^ 1n;
  let suffix = "";
  for (let index = 0; index < 8; index += 1) {
    suffix += CHECKSUM_CHARSET[Number((checksum >> BigInt(5 * (7 - index))) & 31n)];
  }
  return `${payload}#${suffix}`;
}

function descriptorPayload(descriptor: string): string {
  const separator = descriptor.lastIndexOf("#");
  if (separator === -1) return descriptor;
  if (separator !== descriptor.length - 9) {
    throw new Error("The canonical descriptor has a malformed checksum.");
  }
  return descriptor.slice(0, separator);
}

/** Split `ct(<blinding policy>,<descriptor>)` at its top-level comma.
 *  Exported for the user-facing wallet export (src/lib/wallet-export.ts),
 *  which needs the same split to surface the blinding policy and the inner
 *  descriptor separately. Deliberately shared rather than reimplemented:
 *  descriptor projection is a security boundary, and a second parser that
 *  disagreed with this one is exactly how a blinding key leaks into a payload
 *  that promised not to carry it. */
export function parseOuterCtDescriptor(
  payload: string,
): [blindingPolicy: string, descriptor: string] {
  return parseOuterCt(payload);
}

/** The descriptor body with any BIP-380 checksum removed. Exported for the
 *  same caller and the same reason. */
export function stripDescriptorChecksum(descriptor: string): string {
  return descriptorPayload(descriptor);
}

/** The SLIP-77 master blinding key, or null for any other blinding policy.
 *
 *  Exported so no caller has to restate the predicate. It was briefly written
 *  twice — here and in the wallet export — and while a divergence could not leak
 *  the key (the split is what protects it), it would desync "this wallet has a
 *  master blinding key" from "this wallet has a public descriptor", which are
 *  the same fact. */
export function slip77KeyOf(blindingPolicy: string): string | null {
  return SLIP77_POLICY.exec(blindingPolicy)?.[1] ?? null;
}

/** Reject a descriptor carrying an extended private key. Exported alongside the
 *  split because a caller that reuses the parsing and not this check gets the
 *  most dangerous possible value with none of the defence: see the wallet
 *  export, which surfaces the extended key as a separate field. */
export function assertNoPrivateSpendKeysIn(descriptor: string): void {
  assertNoPrivateSpendKeys(descriptor);
}

function parseOuterCt(payload: string): [blindingPolicy: string, descriptor: string] {
  if (!payload.startsWith("ct(") || !payload.endsWith(")")) {
    throw new Error("Expected a confidential wallet descriptor.");
  }

  const body = payload.slice(3, -1);
  let depth = 0;
  let separator = -1;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth < 0) throw new Error("Malformed confidential wallet descriptor.");
    }
    if (character === "," && depth === 0) {
      if (separator !== -1) throw new Error("Malformed confidential wallet descriptor.");
      separator = index;
    }
  }
  if (depth !== 0 || separator <= 0 || separator === body.length - 1) {
    throw new Error("Malformed confidential wallet descriptor.");
  }
  return [body.slice(0, separator), body.slice(separator + 1)];
}

function assertNoPrivateSpendKeys(descriptor: string): void {
  // BIP-380 private key expressions are WIF or extended private keys. Raw
  // 32-byte hex is not a private-key encoding in a BIP-380 key expression and
  // may legitimately be an x-only public key.
  const extendedPrivate =
    /(?:^|[^A-Za-z0-9])(?:xprv|tprv|yprv|zprv|Yprv|Zprv|uprv|vprv|Uprv|Vprv)[1-9A-HJ-NP-Za-km-z]+/;
  const wifPrivate = /(?:^|[^1-9A-HJ-NP-Za-km-z])(?:[5KL][1-9A-HJ-NP-Za-km-z]{50,51}|[9c][1-9A-HJ-NP-Za-km-z]{50,51})(?:$|[^1-9A-HJ-NP-Za-km-z])/;
  if (extendedPrivate.test(descriptor) || wifPrivate.test(descriptor)) {
    throw new Error("Private spend keys cannot be disclosed as a public descriptor.");
  }
}

function descriptorStandards(descriptor: string): string[] {
  const standards = ["bip-0032", "bip-0044", "slip-0044"];
  if (descriptor.startsWith("elsh(elwpkh(")) standards.push("bip-0049");
  else if (descriptor.startsWith("elwpkh(")) standards.push("bip-0084");
  else if (descriptor.startsWith("eltr(")) standards.push("bip-0086");
  standards.push("bip-0380", "bip-0389");
  return standards;
}

function expandChecksumSymbols(value: string): number[] {
  const groups: number[] = [];
  const symbols: number[] = [];
  for (const character of value) {
    const position = INPUT_CHARSET.indexOf(character);
    if (position === -1) throw new Error("Descriptor contains a character outside BIP-380.");
    symbols.push(position & 31);
    groups.push(position >> 5);
    if (groups.length === 3) {
      symbols.push(groups[0] * 9 + groups[1] * 3 + groups[2]);
      groups.length = 0;
    }
  }
  if (groups.length === 1) symbols.push(groups[0]);
  if (groups.length === 2) symbols.push(groups[0] * 3 + groups[1]);
  return symbols;
}

function descriptorPolymod(symbols: readonly number[]): bigint {
  let checksum = 1n;
  for (const value of symbols) {
    const top = checksum >> 35n;
    checksum = ((checksum & 0x7ffffffffn) << 5n) ^ BigInt(value);
    for (let index = 0; index < GENERATOR.length; index += 1) {
      if (((top >> BigInt(index)) & 1n) !== 0n) checksum ^= GENERATOR[index];
    }
  }
  return checksum;
}
