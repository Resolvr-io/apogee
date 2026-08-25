// Key slots for vault format v3 (see docs/passkey-unlock.md §1). Every payload
// — each mnemonic envelope, the DEK check — is encrypted under one random data
// key (the DEK); the store's `slots[]` array holds one wrapped copy of the DEK
// per unlock factor. Today exactly one factor exists (the password); a passkey
// slot joins in a later phase without touching anything here but the union.
//
// The point of the indirection: changing the password re-wraps 32 bytes, and
// adding or removing a passkey touches one slot — no ciphertext ever moves, so
// no operation can forget a wrap site and leave data under a key nobody holds.
//
// Pure — WebCrypto only, no browser.* — so the wrap/unwrap semantics are unit-
// testable in plain Node (keystore.ts itself is not loadable there).

import {
  type Enc,
  type Kdf,
  base64ToBytes,
  bytesToBase64,
  decryptBytes,
  deriveKey,
  encryptBytes,
  exportKeyRaw,
  importKeyRaw,
} from "./crypto";

/** A slot wrapping the DEK under the password: the PBKDF2 descriptor plus the
 *  wrapped key. `id` is random per slot and baked into the wrap's AAD, so a
 *  wrapped key can never be transplanted into another slot's record. */
export interface PasswordSlot {
  type: "password";
  id: string;
  kdf: Kdf;
  wrappedDek: Enc;
}

export type KeySlot = PasswordSlot;

export function dekSlotAad(slotId: string): string {
  return `apogee:dek-slot:v3:${slotId}`;
}

export function dekCheckAad(): string {
  return "apogee:verifier-dek:v3";
}

/** A fresh random DEK. Extractable because it must be wrapped into slots and
 *  stashed in the session cache; it is never persisted anywhere in the clear. */
export async function generateDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

/** Seal the DEK under a key-encrypting key, bound to this slot's identity. */
export async function wrapDek(dek: CryptoKey, kek: CryptoKey, slotId: string): Promise<Enc> {
  // exportKeyRaw/importKeyRaw speak base64; the envelope speaks bytes.
  return encryptBytes(kek, base64ToBytes(await exportKeyRaw(dek)), dekSlotAad(slotId));
}

/** Open a slot back into the DEK. Throws (OperationError) on a wrong key or an
 *  AAD mismatch — i.e. a wrong password, or a wrapped key moved between slots. */
export async function unwrapDek(kek: CryptoKey, slot: KeySlot): Promise<CryptoKey> {
  // importKeyRaw length-checks the decode; a corrupted envelope fails here,
  // at the slot, rather than as a shorter key failing later and far away.
  const raw = await decryptBytes(kek, slot.wrappedDek, dekSlotAad(slot.id));
  return importKeyRaw(bytesToBase64(raw));
}

/** Build the password slot for a fresh vault: derive the KEK, wrap the DEK. */
export async function makePasswordSlot(
  password: string,
  kdf: Kdf,
  dek: CryptoKey,
): Promise<PasswordSlot> {
  return makePasswordSlotWithKey(await deriveKey(password, kdf), kdf, dek);
}

/** The same slot from an ALREADY-derived key — the v2→v3 migration has the
 *  key but never the plaintext password, and must reuse the v2 KDF descriptor
 *  (a format migration never changes the password). */
export async function makePasswordSlotWithKey(
  kek: CryptoKey,
  kdf: Kdf,
  dek: CryptoKey,
): Promise<PasswordSlot> {
  const id = `s_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  return { type: "password", id, kdf, wrappedDek: await wrapDek(dek, kek, id) };
}

/** Whether two keys are the same bytes — used by the v2→v3 migration's
 *  byte-verify (the DEK that comes back out of the new slot must be the DEK
 *  that went in) and by tests. String comparison, not constant-time: both
 *  operands are values this device just produced, not secrets under guess. */
export async function sameKey(a: CryptoKey, b: CryptoKey): Promise<boolean> {
  return (await exportKeyRaw(a)) === (await exportKeyRaw(b));
}
