import { describe, expect, it } from "vitest";
import { BIP39_ENGLISH_WORDLIST } from "./bip39-english-wordlist";
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

// The wordlist's correctness is the whole basis of this encoding: a single
// wrong or shifted word silently produces a QR that restores a DIFFERENT
// wallet, discovered only when someone needs the backup. The file header
// claims provenance in a comment; these assertions make it machine-checked.
describe("BIP39_ENGLISH_WORDLIST", () => {
  it("is byte-identical to the official bip-0039/english.txt", async () => {
    // Digest of the canonical file (newline-separated, trailing newline) from
    // github.com/bitcoin/bips. Pinning it means an edit to the embedded list
    // has to survive an external check, not just an internally-consistent one.
    const bytes = new TextEncoder().encode(`${BIP39_ENGLISH_WORDLIST.join("\n")}\n`);
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(digest).toBe("2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda");
  });

  it("holds 2048 sorted, unique words with unique four-letter prefixes", () => {
    expect(BIP39_ENGLISH_WORDLIST).toHaveLength(2048);
    expect([...BIP39_ENGLISH_WORDLIST]).toEqual([...BIP39_ENGLISH_WORDLIST].sort());
    expect(new Set(BIP39_ENGLISH_WORDLIST).size).toBe(2048);
    // BIP-39's defining property. Catches a transposition or one-letter typo
    // that length and sort checks both slide past.
    expect(new Set(BIP39_ENGLISH_WORDLIST.map((w) => w.slice(0, 4))).size).toBe(2048);
    expect(BIP39_ENGLISH_WORDLIST[0]).toBe("abandon");
    expect(BIP39_ENGLISH_WORDLIST[2047]).toBe("zoo");
  });
});

describe("encodeStandardSeedQr", () => {
  it("matches the known digit encoding for a fixed 12-word phrase", () => {
    expect(encodeStandardSeedQr(PHRASE)).toBe(DIGITS);
  });

  it("round-trips a 24-word phrase", () => {
    const words = Array.from({ length: 23 }, () => "abandon").concat("art");
    const phrase = words.join(" ");
    expect(decodeStandardSeedQr(encodeStandardSeedQr(phrase))).toBe(phrase);
  });

  // The published all-0x7f BIP-39 vector. Every fixture above uses a low index,
  // so this is the only case that exercises full four-digit indices, and the
  // mnemonic itself comes from the spec rather than from our own encoder.
  it("encodes the published all-0x7f test vector", () => {
    const phrase =
      "legal winner thank year wave sausage worth useful legal winner thank yellow";
    expect(encodeStandardSeedQr(phrase)).toBe(
      "101920151790203919831533203119191019201517902040",
    );
  });

  it("normalizes case, since the wordlist is lowercase and casing means nothing", () => {
    expect(encodeStandardSeedQr("Abandon ABANDON abandon".repeat(1))).toBe("000000000000");
  });

  it("reports the position of a bad word, never the word itself", () => {
    // A thrown message can reach a log or console, so it must not carry seed
    // material.
    expect(() => encodeStandardSeedQr("abandon abandon notaword")).toThrow(
      "Word 3 is not in the BIP-39 English wordlist.",
    );
    expect(() => encodeStandardSeedQr("abandon abandon notaword")).not.toThrow(
      /notaword/,
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
    expect(() => decodeStandardSeedQr("123")).toThrow("multiple of 4");
  });

  it("blames Apogee's own 12-or-24 limit, not the backup", () => {
    // 15/18/21 words are valid BIP-39 and SeedSigner emits them, so the message
    // must not suggest the user's backup is corrupt.
    expect(() => decodeStandardSeedQr("0000".repeat(15))).toThrow(
      "Apogee restores 12- or 24-word phrases; this SeedQR holds 15.",
    );
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
