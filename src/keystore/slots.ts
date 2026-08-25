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
  checkVerifier,
  decryptBytes,
  deriveKey,
  encryptBytes,
  exportKeyRaw,
  importKeyRaw,
  randomBytes,
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

/** Where a passkey lives, captured at enrollment from
 *  `authenticatorAttachment` (which outranks the transports hint — hybrid
 *  covers phones and synced platform passkeys alike). It can never be fetched
 *  retroactively without another ceremony, so it is frozen into the slot. */
export type PasskeyKind = "device" | "cross-device" | "security-key";

/** A slot wrapping the DEK under a passkey: the PRF output of the WebAuthn
 *  credential (run through HKDF, see derivePasskeyKek) is the key. The salts:
 *  `prfSalt` is ONE PER VAULT, not per credential — a get() carries exactly one
 *  salt, so per-credential salts would mean one authenticator tap per enrolled
 *  device; the PRF is already keyed by the credential's own secret, so a shared
 *  salt still yields a distinct output per passkey. Nothing here is secret:
 *  each field is only what's needed to ask the authenticator again and open
 *  the answer. */
export interface PasskeySlot {
  type: "passkey";
  id: string;
  credentialId: string; // base64 WebAuthn credential id
  prfSalt: string; // base64, shared by every passkey slot of this vault
  hkdfSalt: string; // base64, this slot's HKDF salt
  kind: PasskeyKind;
  addedAt: number;
  wrappedDek: Enc;
}

export type KeySlot = PasswordSlot | PasskeySlot;

/** Version-parameterized like every other AAD in the scheme (see keystore.ts):
 *  the slot wraps and the DEK check are the two envelopes a future format bump
 *  must re-bind, so they take the version rather than hardcoding this one. */
export function dekSlotAad(version: number, slotId: string): string {
  return `apogee:dek-slot:v${version}:${slotId}`;
}

export function dekCheckAad(version: number): string {
  return `apogee:verifier-dek:v${version}`;
}

/** The AAD scheme version this module's wraps write today. */
const SLOT_AAD_VERSION = 3;

/** HKDF `info` — domain-separates this derivation from any other use the same
 *  credential's PRF output might ever be put to. */
const PASSKEY_KEK_INFO = "apogee:passkey-kek:v1";

/**
 * The passkey KEK: HKDF-SHA-256 over the authenticator's 32 PRF bytes. HKDF,
 * not PBKDF2 — PBKDF2's iterations exist to slow down guessing a low-entropy
 * secret, and the PRF output is already 32 uniformly random bytes an attacker
 * cannot brute-force toward. The KEK is NON-EXTRACTABLE: it never needs to
 * survive a restart, because what persists is the DEK it unwraps.
 */
export async function derivePasskeyKek(
  prfOutput: Uint8Array<ArrayBuffer>,
  hkdfSalt: string,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", prfOutput, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: base64ToBytes(hkdfSalt),
      info: new TextEncoder().encode(PASSKEY_KEK_INFO),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false, // non-extractable by design
    ["encrypt", "decrypt"],
  );
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
  return encryptBytes(kek, base64ToBytes(await exportKeyRaw(dek)), dekSlotAad(SLOT_AAD_VERSION, slotId));
}

/** Open a slot back into the DEK. Throws (OperationError) on a wrong key or an
 *  AAD mismatch — i.e. a wrong password, or a wrapped key moved between slots. */
export async function unwrapDek(kek: CryptoKey, slot: KeySlot): Promise<CryptoKey> {
  // importKeyRaw length-checks the decode; a corrupted envelope fails here,
  // at the slot, rather than as a shorter key failing later and far away.
  const raw = await decryptBytes(kek, slot.wrappedDek, dekSlotAad(SLOT_AAD_VERSION, slot.id));
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
  const id = newSlotId();
  return { type: "password", id, kdf, wrappedDek: await wrapDek(dek, kek, id) };
}

/** Build a passkey slot from a ceremony's outcome: the KEK already derived
 *  from the PRF evaluation, plus the descriptors needed to ask again. The
 *  ceremony itself (browser-only) lives elsewhere; this is the pure half. */
export async function makePasskeySlot(
  kek: CryptoKey,
  dek: CryptoKey,
  meta: { credentialId: string; prfSalt: string; hkdfSalt: string; kind: PasskeyKind },
): Promise<PasskeySlot> {
  const id = newSlotId();
  return {
    type: "passkey",
    id,
    ...meta,
    addedAt: Date.now(),
    wrappedDek: await wrapDek(dek, kek, id),
  };
}

function newSlotId(): string {
  return `s_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * The pure core of enrollment: derive the KEK from a ceremony's PRF output,
 * wrap the DEK, and byte-verify that the new slot unwraps back to the live DEK
 * before the caller persists anything. `prfSalt` is the vault-wide salt — the
 * caller supplies the existing one, or mints the vault's first.
 */
export async function enrollPasskeySlot(
  dek: CryptoKey,
  prfOutput: Uint8Array<ArrayBuffer>,
  meta: { credentialId: string; kind: PasskeyKind },
  prfSalt: string,
): Promise<PasskeySlot> {
  const hkdfSalt = bytesToBase64(randomBytes(32));
  const kek = await derivePasskeyKek(prfOutput, hkdfSalt);
  const slot = await makePasskeySlot(kek, dek, {
    credentialId: meta.credentialId,
    prfSalt,
    hkdfSalt,
    kind: meta.kind,
  });
  if (!(await sameKey(dek, await unwrapDek(kek, slot)))) {
    throw new Error("passkey enrollment verify failed: slot does not unwrap to the DEK");
  }
  return slot;
}

/** The vault-wide PRF salt, taken from any enrolled passkey slot, or a fresh
 *  one for the vault's first. Per-VAULT by design: a get() carries exactly one
 *  salt, so per-credential salts would cost one authenticator tap per enrolled
 *  device; the PRF is already keyed by the credential's own secret, so a shared
 *  salt still yields a distinct output per passkey. */
export function vaultPrfSalt(slots: KeySlot[]): string {
  const existing = slots.find((s): s is PasskeySlot => s.type === "passkey");
  return existing ? existing.prfSalt : bytesToBase64(randomBytes(32));
}

/**
 * The pure core of passkey unlock: try one PRF evaluation against every
 * enrolled passkey slot; return the DEK if one opens AND passes the DEK-bound
 * check, null otherwise. Null rather than throw: a failed unwrap carries no
 * information (the throttle's job is a guessable secret, not this), and the
 * caller decides what a miss means. A slot whose prfSalt disagrees with the
 * salt the evaluation used simply fails to open — same outcome as the refusal.
 */
export async function openPasskeyDek(
  slots: KeySlot[],
  prfOutput: Uint8Array<ArrayBuffer>,
  dekCheck: Enc,
): Promise<CryptoKey | null> {
  for (const slot of slots) {
    if (slot.type !== "passkey") continue;
    try {
      const opened = await unwrapDek(await derivePasskeyKek(prfOutput, slot.hkdfSalt), slot);
      if (await checkVerifier(opened, dekCheck, dekCheckAad(SLOT_AAD_VERSION))) return opened;
    } catch {
      continue; // this slot doesn't open under this evaluation — try the next
    }
  }
  return null;
}


/** Whether two keys are the same bytes — used by the v2→v3 migration's
 *  byte-verify (the DEK that comes back out of the new slot must be the DEK
 *  that went in) and by tests. String comparison, not constant-time: both
 *  operands are values this device just produced, not secrets under guess. */
export async function sameKey(a: CryptoKey, b: CryptoKey): Promise<boolean> {
  return (await exportKeyRaw(a)) === (await exportKeyRaw(b));
}
