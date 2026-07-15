// Password-based key wrapping with WebCrypto (no dependencies, no wasm).
// Derives an AES-GCM key from the user's password via PBKDF2 and uses it to
// encrypt the BIP-39 mnemonic at rest. The derived CryptoKey never leaves
// WebCrypto; only the decrypted mnemonic is sensitive in-memory material.
//
// Pure — safe to run in the service worker, the offscreen document, or a page.

const DEFAULT_ITERATIONS = 600_000; // PBKDF2 rounds — high to offset weak passwords
const SALT_BYTES = 16;
const IV_BYTES = 12; // AES-GCM standard nonce length
const VERIFIER_PLAINTEXT = "apogee-keystore-v1";

const subtle = crypto.subtle;

/** A self-describing KDF descriptor, stored alongside the ciphertext. */
export interface Kdf {
  name: "PBKDF2";
  hash: "SHA-256";
  iterations: number;
  salt: string; // base64
}

/** AES-GCM ciphertext envelope. */
export interface Enc {
  iv: string; // base64
  ct: string; // base64
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

// ---- base64 helpers (work in worker and page contexts) ----
export function bytesToBase64(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    binary += String.fromCharCode(...arr.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function utf8(str: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(str);
}

/** Generate a fresh KDF descriptor (one per keystore). */
export function newKdf(iterations = DEFAULT_ITERATIONS): Kdf {
  return {
    name: "PBKDF2",
    hash: "SHA-256",
    iterations,
    salt: bytesToBase64(randomBytes(SALT_BYTES)),
  };
}

/**
 * Derive an AES-GCM key from a password + KDF descriptor. Extractable so it
 * can be stashed in chrome.storage.session (memory-only) to survive SW
 * eviction without re-prompting for the password.
 */
export async function deriveKey(password: string, kdf: Kdf): Promise<CryptoKey> {
  const baseKey = await subtle.importKey("raw", utf8(password), "PBKDF2", false, [
    "deriveKey",
  ]);
  return subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: base64ToBytes(kdf.salt),
      iterations: kdf.iterations,
      hash: kdf.hash,
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

/** Export/import the derived key as raw base64 for the session cache. */
export async function exportKeyRaw(key: CryptoKey): Promise<string> {
  return bytesToBase64(await subtle.exportKey("raw", key));
}
export async function importKeyRaw(b64: string): Promise<CryptoKey> {
  return subtle.importKey("raw", base64ToBytes(b64), { name: "AES-GCM" }, true, [
    "encrypt",
    "decrypt",
  ]);
}

/** Encrypt raw bytes → { iv, ct }. A fresh IV is generated per call. `aad`, when
 *  given, is bound as AES-GCM additional authenticated data (see keystore). */
export async function encryptBytes(
  key: CryptoKey,
  bytes: Uint8Array<ArrayBuffer>,
  aad?: string,
): Promise<Enc> {
  const iv = randomBytes(IV_BYTES);
  const algo: AesGcmParams = { name: "AES-GCM", iv };
  if (aad) algo.additionalData = utf8(aad);
  const ct = await subtle.encrypt(algo, key, bytes);
  return { iv: bytesToBase64(iv), ct: bytesToBase64(ct) };
}

/** Decrypt { iv, ct } → Uint8Array. Throws (OperationError) on wrong key/tamper
 *  or an `aad` mismatch. */
export async function decryptBytes(key: CryptoKey, enc: Enc, aad?: string): Promise<Uint8Array> {
  const algo: AesGcmParams = { name: "AES-GCM", iv: base64ToBytes(enc.iv) };
  if (aad) algo.additionalData = utf8(aad);
  const plain = await subtle.decrypt(algo, key, base64ToBytes(enc.ct));
  return new Uint8Array(plain);
}

export async function encryptString(key: CryptoKey, str: string, aad?: string): Promise<Enc> {
  return encryptBytes(key, utf8(str), aad);
}
export async function decryptString(key: CryptoKey, enc: Enc, aad?: string): Promise<string> {
  return new TextDecoder().decode(await decryptBytes(key, enc, aad));
}

/** A verifier rejects a wrong password instantly without decrypting a wallet. */
export async function makeVerifier(key: CryptoKey, aad?: string): Promise<Enc> {
  return encryptBytes(key, utf8(VERIFIER_PLAINTEXT), aad);
}
export async function checkVerifier(key: CryptoKey, verifier: Enc, aad?: string): Promise<boolean> {
  try {
    const bytes = await decryptBytes(key, verifier, aad);
    return new TextDecoder().decode(bytes) === VERIFIER_PLAINTEXT;
  } catch {
    return false; // OperationError ⇒ wrong password or aad mismatch
  }
}
