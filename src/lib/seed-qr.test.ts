import { describe, expect, it } from "vitest";
import {
  decodeScannedSeedPhrase,
  decodeStandardSeedQr,
  encodeStandardSeedQr,
} from "./seed-qr";

// Same fixture phrase used by qr-secret.test.ts. "abandon" is wordlist index
// 0 and "about" is index 3, so the known-vector digit string below is exact,
// not just round-tripped through our own encoder.
const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const DIGITS = "000000000000000000000000000000000000000000000003";

describe("encodeStandardSeedQr", () => {
  it("matches the known digit encoding for a fixed 12-word phrase", () => {
    expect(encodeStandardSeedQr(PHRASE)).toBe(DIGITS);
  });

  it("round-trips a 24-word phrase", () => {
    const words = Array.from({ length: 23 }, () => "abandon").concat("art");
    const phrase = words.join(" ");
    expect(decodeStandardSeedQr(encodeStandardSeedQr(phrase))).toBe(phrase);
  });

  it("rejects a word outside the wordlist", () => {
    expect(() => encodeStandardSeedQr("abandon abandon notaword")).toThrow(
      "not a word in the BIP-39 English wordlist",
    );
  });
});

describe("decodeStandardSeedQr", () => {
  it("decodes the known digit string back to words", () => {
    expect(decodeStandardSeedQr(DIGITS)).toBe(PHRASE);
  });

  it("rejects a non-digit string", () => {
    expect(() => decodeStandardSeedQr("abandon abandon")).toThrow("Not a Standard SeedQR");
  });

  it("rejects a length that is not a multiple of 4", () => {
    expect(() => decodeStandardSeedQr("123")).toThrow("Not a Standard SeedQR");
  });

  it("rejects a word count other than 12 or 24", () => {
    expect(() => decodeStandardSeedQr("0000".repeat(11))).toThrow("not a valid mnemonic length");
  });

  it("rejects a word index outside the wordlist", () => {
    expect(() => decodeStandardSeedQr("2047".repeat(11) + "2048")).toThrow(
      "outside the BIP-39 English wordlist",
    );
  });
});

describe("decodeScannedSeedPhrase", () => {
  it("decodes a Standard SeedQR digit payload", () => {
    expect(decodeScannedSeedPhrase(DIGITS)).toBe(PHRASE);
  });

  it("passes through a plain-word payload unchanged", () => {
    expect(decodeScannedSeedPhrase(PHRASE)).toBe(PHRASE);
  });
});
