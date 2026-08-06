import { describe, expect, it } from "vitest";
import { extractElementsTxOut } from "./elements-txout";

const EXPLICIT_TXOUT =
  "016d521c38ec1ea15734ae22b7c46064412829c0d0579f0a713d1c04ede979026f" +
  "01000000000001e240" +
  "00" +
  "16" +
  "0014272f557c30d2f520b6d4ae1dbdddaaf08708939f";

describe("extractElementsTxOut", () => {
  it("extracts the exact non-witness TxOut serialization", () => {
    const tx = transaction([EXPLICIT_TXOUT]);
    expect(hex(extractElementsTxOut(tx, 0))).toBe(EXPLICIT_TXOUT);
  });

  it("selects a confidential output without including its output witness", () => {
    const confidential =
      `0a${"11".repeat(32)}` +
      `08${"22".repeat(32)}` +
      `02${"33".repeat(32)}` +
      "16" +
      "00144444444444444444444444444444444444444444";
    const tx = transaction([EXPLICIT_TXOUT, confidential], {
      witness: true,
      outputWitness: "01aa01bb",
    });
    expect(hex(extractElementsTxOut(tx, 1))).toBe(confidential);
  });

  it("accepts an explicit 32-byte nonce", () => {
    const explicitNonce = EXPLICIT_TXOUT.replace("00160014", `01${"55".repeat(32)}160014`);
    expect(hex(extractElementsTxOut(transaction([explicitNonce]), 0))).toBe(explicitNonce);
  });

  it("skips issuance data while locating the output vector", () => {
    const issuanceInput =
      "00".repeat(32) +
      "00000080" +
      "00" +
      "ffffffff" +
      "00".repeat(32) +
      "11".repeat(32) +
      "010000000000000001" +
      "00";
    const tx = bytes(`020000000001${issuanceInput}01${EXPLICIT_TXOUT}00000000`);
    expect(hex(extractElementsTxOut(tx, 0))).toBe(EXPLICIT_TXOUT);
  });

  it("rejects malformed or out-of-range requests", () => {
    const tx = transaction([EXPLICIT_TXOUT]);
    expect(() => extractElementsTxOut(tx, 1)).toThrow("out of range");
    expect(() => extractElementsTxOut(tx.slice(0, -5), 0)).toThrow("truncated");
    expect(() => extractElementsTxOut(tx, -1)).toThrow("invalid Elements output index");
  });
});

function transaction(
  outputs: string[],
  options: { witness?: boolean; outputWitness?: string } = {},
): Uint8Array {
  const coinbaseInput = `${"00".repeat(32)}ffffffff00ffffffff`;
  const outputVector = `${compactSize(outputs.length)}${outputs.join("")}`;
  const base = `02000000${options.witness ? "01" : "00"}01${coinbaseInput}${outputVector}00000000`;
  if (!options.witness) return bytes(base);
  // One empty input witness (four empty vectors), then one output witness per
  // output (surjection proof + rangeproof). Only the trailing bytes need to be
  // structurally plausible because the extractor intentionally stops earlier.
  return bytes(`${base}00000000${options.outputWitness ?? "0000"}`);
}

function compactSize(value: number): string {
  if (value >= 0xfd) throw new Error("test helper only supports small vectors");
  return value.toString(16).padStart(2, "0");
}

function bytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
