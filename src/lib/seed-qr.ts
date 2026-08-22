// Standard SeedQR: a BIP-39 mnemonic encoded as a digit string, one 4-digit
// zero-padded wordlist index per word, concatenated. This is one of the two
// formats Blockstream Jade's camera-based seed import reads natively (the
// other, CompactSeedQR, packs the raw entropy as binary — denser but far
// easier to get subtly wrong). Spec: https://github.com/SeedSigner/seedsigner/blob/main/docs/seed_qr/README.md
import { BIP39_ENGLISH_WORDLIST } from "./bip39-english-wordlist";

const WORD_INDEX = new Map<string, number>(
  BIP39_ENGLISH_WORDLIST.map((word, index) => [word, index]),
);

/**
 * Encode a mnemonic as a Standard SeedQR digit string.
 *
 * Case is normalized because the BIP-39 English wordlist is entirely
 * lowercase, so casing carries no meaning — and the typed-restore path
 * persists a phrase without lowercasing it, which would otherwise make an
 * innocuous "Abandon" throw here.
 *
 * The error deliberately reports the word's POSITION, never its value: this
 * runs on live seed material, and an exception message can reach a log or a
 * console.
 */
export function encodeStandardSeedQr(mnemonic: string): string {
  const words = mnemonic.trim().toLowerCase().split(/\s+/);
  return words
    .map((word, position) => {
      const index = WORD_INDEX.get(word);
      if (index === undefined) {
        throw new Error(`Word ${position + 1} is not in the BIP-39 English wordlist.`);
      }
      return index.toString().padStart(4, "0");
    })
    .join("");
}

/** Decode a Standard SeedQR digit string back into a space-separated mnemonic. */
export function decodeStandardSeedQr(digits: string): string {
  if (!/^[0-9]+$/.test(digits)) {
    throw new Error("Not a Standard SeedQR digit string.");
  }
  if (digits.length % 4 !== 0) {
    throw new Error(
      "This SeedQR's digit count must be a multiple of 4 (one 4-digit index per word).",
    );
  }
  const wordCount = digits.length / 4;
  // 15/18/21 words are valid BIP-39 — the 12-or-24 restriction is Apogee's, so
  // say so rather than implying a legitimate backup is malformed.
  if (wordCount !== 12 && wordCount !== 24) {
    throw new Error(`Apogee restores 12- or 24-word phrases; this SeedQR holds ${wordCount}.`);
  }
  const words: string[] = [];
  for (let position = 0; position < digits.length; position += 4) {
    const index = Number.parseInt(digits.slice(position, position + 4), 10);
    const word = BIP39_ENGLISH_WORDLIST[index];
    if (word === undefined) {
      throw new Error(`Word index ${index} is outside the BIP-39 English wordlist.`);
    }
    words.push(word);
  }
  return words.join(" ");
}

/**
 * Recognize a scanned QR payload as either a Standard SeedQR digit string or
 * a plain space-separated mnemonic (the format Apogee itself exports today,
 * and what other wallets' plain-mnemonic QR scanners produce), returning the
 * space-separated word form either way.
 */
export function decodeScannedSeedPhrase(value: string): string {
  const trimmed = value.trim();
  if (/^[0-9]+$/.test(trimmed)) return decodeStandardSeedQr(trimmed);
  return trimmed;
}
