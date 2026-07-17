// Mnemonic keystore — the keystore-of-record. Runs in the service worker.
//
// Holds BIP-39 mnemonics encrypted at rest in chrome.storage.local, with the
// watch-only descriptor stored in cleartext so the offscreen engine can sync
// balances/addresses/history while locked. The seed is needed only to sign.
//
// Mnemonic generation/validation and descriptor derivation need lwk_wasm
// (offscreen-only), so this module does NOT call wasm: the caller (the SW
// wallet-controller) derives {mnemonic, descriptor, fingerprint} via the
// engine and hands them to addWallet() to persist.
//
// Multi-wallet and BIP-39 based. MV3 session recovery (ensureLoaded) keeps
// the keystore unlocked across service-worker eviction.

import {
  type Enc,
  type Kdf,
  checkVerifier,
  decryptString,
  deriveKey,
  encryptString,
  exportKeyRaw,
  importKeyRaw,
  makeVerifier,
  newKdf,
} from "./crypto";
import { isValidFingerprint } from "@/lib/utils";

export type LiquidNetwork = "liquid" | "liquidtestnet" | "regtest";

/**
 * Who holds the keys / signs for a wallet:
 *  - "local": a BIP-39 seed stored encrypted in this keystore (software signer).
 *  - "jade": a Blockstream Jade hardware signer — watch-only descriptor here,
 *    signing delegated to the device. No seed is stored (no `enc`).
 *  - "watch": a watch-only wallet imported from a descriptor — no seed and no
 *    signer, so it can receive and track balance but can never sign or send.
 * Absent on legacy records → "local".
 */
export type WalletSigner = "local" | "jade" | "watch";

const STORE_KEY = "apogee_keystore";
const ACTIVE_KEY = "apogee_active_wallet";
const SESSION_KEY = "apogee_session";
const THROTTLE_KEY = "apogee_unlock_throttle";
const STORE_VERSION = 2; // v2 binds AES-GCM AAD to each envelope; v1 vaults must be reset

/** A wallet record as persisted (mnemonic encrypted, descriptor cleartext). */
export interface WalletRecord {
  id: string;
  label: string;
  network: LiquidNetwork;
  signer?: WalletSigner; // absent → "local"
  descriptor: string; // ct(slip77(..),elwpkh(..)) — watch-only, cleartext
  fingerprint: string;
  enc?: Enc; // AES-GCM of the BIP-39 mnemonic — absent for hardware (jade) wallets
  createdAt: number;
}

interface StoreShape {
  version: number;
  kdf: Kdf;
  verifier: Enc;
  wallets: Record<string, WalletRecord>;
  order: string[];
}

/** Public, secret-free view of a wallet (safe to send to the UI). */
export interface WalletInfo {
  id: string;
  label: string;
  network: LiquidNetwork;
  signer: WalletSigner;
  descriptor: string;
  fingerprint: string;
  createdAt: number;
}

/** Secret-free keystore state for the UI. */
export interface KeystoreState {
  initialized: boolean;
  locked: boolean;
  activeWalletId: string | null;
  wallets: WalletInfo[];
}

/** Fields a caller supplies to persist a new wallet (derived via the engine). */
export interface NewWallet {
  mnemonic: string;
  descriptor: string;
  fingerprint: string;
  label: string;
  network: LiquidNetwork;
}

// ---- in-memory state (cleared on lock / SW eviction) ----
let derivedKey: CryptoKey | null = null;
const unlockedMnemonics = new Map<string, string>(); // walletId → mnemonic

// ---- unlock attempt throttling ----
//
// Progressive lockout against password guessing at the keyboard. Enforced HERE
// (the service worker) rather than in the UI — any extension surface can send
// wallet/unlock, so a UI-only guard would be bypassable — and persisted in
// chrome.storage.local so reopening the panel or restarting the browser doesn't
// reset it. unlock() and verifyPassword() share one counter: the reveal-seed
// step-up is the same password oracle.
//
// Curve: the first 10 attempts are free; attempts 10+ wait (fails - 9) × 5s,
// capped at 60s. At MAX_UNLOCK_FAILS the vault hard-locks: password attempts
// are refused outright and the only way forward is the forgot-password flow
// (re-import the recovery phrase, or full reset) — which stays available
// throughout, and clears this state by destroying the vault it guards.
const FREE_UNLOCK_FAILS = 10;
const UNLOCK_DELAY_STEP_MS = 5_000;
const UNLOCK_DELAY_MAX_MS = 60_000;
const MAX_UNLOCK_FAILS = 21;

interface ThrottleState {
  fails: number; // consecutive failed password attempts
  lastAt: number; // epoch ms of the most recent failure
}

/** Secret-free throttle view for the UI (countdowns + warnings). */
export interface UnlockThrottle {
  fails: number;
  retryAt: number | null; // epoch ms when the next attempt is allowed; null = now
  blocked: boolean; // hard-locked: only recovery (import/reset) can proceed
  remainingBeforeBlock: number; // attempts left until the hard lock
  warning: boolean; // in the escalation zone — the UI should show the countdown/remaining hint
}

function unlockDelayMs(fails: number): number {
  if (fails < FREE_UNLOCK_FAILS) return 0;
  return Math.min(UNLOCK_DELAY_MAX_MS, (fails - (FREE_UNLOCK_FAILS - 1)) * UNLOCK_DELAY_STEP_MS);
}

async function loadThrottle(): Promise<ThrottleState> {
  const t = await localGet<ThrottleState>(THROTTLE_KEY);
  return t && typeof t.fails === "number" && typeof t.lastAt === "number"
    ? t
    : { fails: 0, lastAt: 0 };
}

export async function getUnlockThrottle(): Promise<UnlockThrottle> {
  const t = await loadThrottle();
  const readyAt = t.lastAt + unlockDelayMs(t.fails);
  return {
    fails: t.fails,
    retryAt: readyAt > Date.now() ? readyAt : null,
    blocked: t.fails >= MAX_UNLOCK_FAILS,
    remainingBeforeBlock: Math.max(0, MAX_UNLOCK_FAILS - t.fails),
    warning: t.fails >= FREE_UNLOCK_FAILS,
  };
}

/** Refuse a password attempt while blocked or cooling down. The error codes are
 *  machine-readable so the UI can render countdowns (see wallet-client). */
async function assertAttemptAllowed(): Promise<void> {
  const t = await loadThrottle();
  if (t.fails >= MAX_UNLOCK_FAILS) throw new Error("UNLOCK_BLOCKED");
  const readyAt = t.lastAt + unlockDelayMs(t.fails);
  if (readyAt > Date.now()) throw new Error(`UNLOCK_THROTTLED:${readyAt}`);
}

async function recordUnlockFailure(): Promise<void> {
  const t = await loadThrottle();
  await localSet(THROTTLE_KEY, { fails: t.fails + 1, lastAt: Date.now() });
}

async function clearUnlockFailures(): Promise<void> {
  await chrome.storage.local.remove(THROTTLE_KEY);
}

// ---- chrome.storage helpers ----
async function localGet<T>(key: string): Promise<T | undefined> {
  const obj = await chrome.storage.local.get(key);
  return obj[key] as T | undefined;
}
async function localSet(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}
async function sessionGet<T>(key: string): Promise<T | undefined> {
  const obj = await chrome.storage.session.get(key);
  return obj[key] as T | undefined;
}
async function sessionSet(key: string, value: unknown): Promise<void> {
  await chrome.storage.session.set({ [key]: value });
}
async function sessionClear(key: string): Promise<void> {
  await chrome.storage.session.remove(key);
}

async function loadStore(): Promise<StoreShape | undefined> {
  return localGet<StoreShape>(STORE_KEY);
}
async function saveStore(store: StoreShape): Promise<void> {
  await localSet(STORE_KEY, store);
}

function genId(): string {
  return `w_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

// ---- state queries ----

export async function isInitialized(): Promise<boolean> {
  return (await loadStore()) !== undefined;
}

export function isLocked(): boolean {
  return derivedKey === null;
}

function toInfo(w: WalletRecord): WalletInfo {
  return {
    id: w.id,
    label: w.label,
    network: w.network,
    signer: w.signer ?? "local",
    descriptor: w.descriptor,
    fingerprint: w.fingerprint,
    createdAt: w.createdAt,
  };
}

export async function getState(): Promise<KeystoreState> {
  const store = await loadStore();
  if (!store) {
    return { initialized: false, locked: true, activeWalletId: null, wallets: [] };
  }
  const activeWalletId = (await localGet<string>(ACTIVE_KEY)) ?? store.order[0] ?? null;
  const wallets = store.order
    .map((id) => store.wallets[id])
    .filter((w): w is WalletRecord => Boolean(w))
    .map(toInfo);
  return { initialized: true, locked: isLocked(), activeWalletId, wallets };
}

// ---- lifecycle ----

// AES-GCM additional authenticated data (AAD) binds each ciphertext to its
// context so blobs can't be transplanted between records or version-downgraded.
// The verifier is bound to the store format version; each mnemonic is also bound
// to its wallet id — all mnemonics share one derived key, so without this a
// ciphertext could be swapped between wallet slots and still decrypt.
function verifierAad(): string {
  return `apogee:verifier:v${STORE_VERSION}`;
}
function mnemonicAad(walletId: string): string {
  return `apogee:mnemonic:v${STORE_VERSION}:${walletId}`;
}

/** Create a fresh keystore behind a password, left unlocked. No wallet yet. */
export async function initialize(password: string): Promise<void> {
  if (await isInitialized()) throw new Error("Keystore already initialized");
  const kdf = newKdf();
  const key = await deriveKey(password, kdf);
  const store: StoreShape = {
    version: STORE_VERSION,
    kdf,
    verifier: await makeVerifier(key, verifierAad()),
    wallets: {},
    order: [],
  };
  await saveStore(store);
  derivedKey = key;
  await persistSession(key);
  await clearUnlockFailures(); // fresh vault — a stale counter must not guard it
}

/** Derive the key from the password, verify it, and decrypt all mnemonics. */
export async function unlock(password: string): Promise<void> {
  const store = await loadStore();
  if (!store) throw new Error("Keystore not initialized");
  if (store.version !== STORE_VERSION) {
    throw new Error(
      "Apogee's encrypted storage format changed in this update. Reset Apogee and re-import your recovery phrase.",
    );
  }
  await assertAttemptAllowed();
  const key = await deriveKey(password, store.kdf);
  if (!(await checkVerifier(key, store.verifier, verifierAad()))) {
    await recordUnlockFailure();
    throw new Error("Incorrect password");
  }
  await clearUnlockFailures();
  unlockedMnemonics.clear();
  for (const id of store.order) {
    const w = store.wallets[id];
    if (w?.enc) unlockedMnemonics.set(id, await decryptString(key, w.enc, mnemonicAad(id))); // skip hardware (no seed)
  }
  derivedKey = key;
  await persistSession(key);
}

/** Wipe all in-memory secrets and the session cache. */
export async function lock(): Promise<void> {
  derivedKey = null;
  unlockedMnemonics.clear();
  await sessionClear(SESSION_KEY);
}

/**
 * Destroy the keystore entirely — for the "forgot password" recovery path,
 * where the encrypted vault can't be unlocked. Removes all persisted wallet
 * data on this device (the on-chain funds are untouched and recoverable from
 * the recovery phrase). Leaves the app uninitialized.
 */
export async function reset(): Promise<void> {
  derivedKey = null;
  unlockedMnemonics.clear();
  await sessionClear(SESSION_KEY);
  // THROTTLE_KEY goes too: the counter guards the vault being destroyed, and a
  // survivor would lock the user out of the NEXT vault they create/restore.
  await chrome.storage.local.remove([STORE_KEY, ACTIVE_KEY, THROTTLE_KEY]);
}

/**
 * Raw local-storage snapshot of the persisted keystore (encrypted store + active
 * id), for rolling back a destructive replace-restore if re-creation fails. The
 * in-memory unlocked state is NOT captured — a rollback lands on a locked wallet.
 */
export async function snapshotLocal(): Promise<Record<string, unknown>> {
  return chrome.storage.local.get([STORE_KEY, ACTIVE_KEY]);
}
export async function restoreLocal(snap: Record<string, unknown>): Promise<void> {
  await chrome.storage.local.set(snap);
}

/** Verify a password without changing lock state (step-up auth). Shares the
 *  unlock throttle — throws UNLOCK_THROTTLED/UNLOCK_BLOCKED while guarded. */
export async function verifyPassword(password: string): Promise<boolean> {
  const store = await loadStore();
  if (!store) return false;
  await assertAttemptAllowed();
  const key = await deriveKey(password, store.kdf);
  const ok = await checkVerifier(key, store.verifier, verifierAad());
  if (ok) await clearUnlockFailures();
  else await recordUnlockFailure();
  return ok;
}

/** Re-wrap every wallet under a new password. Requires the current one. */
export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  const store = await loadStore();
  if (!store) throw new Error("Keystore not initialized");
  const oldKey = await deriveKey(oldPassword, store.kdf);
  if (!(await checkVerifier(oldKey, store.verifier, verifierAad()))) {
    throw new Error("Incorrect password");
  }
  const kdf = newKdf();
  const newKey = await deriveKey(newPassword, kdf);
  const wallets: Record<string, WalletRecord> = {};
  for (const id of store.order) {
    const w = store.wallets[id];
    if (!w) continue;
    // Hardware wallets have no seed to re-wrap; carry them through unchanged.
    wallets[id] = w.enc
      ? {
          ...w,
          enc: await encryptString(newKey, await decryptString(oldKey, w.enc, mnemonicAad(id)), mnemonicAad(id)),
        }
      : w;
  }
  const next: StoreShape = {
    ...store,
    kdf,
    verifier: await makeVerifier(newKey, verifierAad()),
    wallets,
  };
  await saveStore(next);
  derivedKey = newKey;
  await persistSession(newKey);
}

// ---- wallet management ----

/** Persist a new wallet (caller derived descriptor/fingerprint via engine). */
export async function addWallet(w: NewWallet): Promise<WalletInfo> {
  if (isLocked() || !derivedKey) throw new Error("Keystore is locked");
  const store = await loadStore();
  if (!store) throw new Error("Keystore not initialized");

  // Dedupe by descriptor (same seed + network + path).
  const existing = store.order
    .map((id) => store.wallets[id])
    .find((rec) => rec?.descriptor === w.descriptor);
  if (existing) {
    // Restoring (or creating) the seed for a descriptor already imported as
    // watch-only upgrades that record in place to a spendable local wallet:
    // persist the encrypted seed and flip the signer, so the user isn't stuck
    // with an unspendable wallet they hold the keys for. A full local wallet
    // with the same descriptor is just a dedupe — return it unchanged.
    if (existing.signer === "watch") {
      existing.signer = "local";
      // Refresh to the seed-derived fingerprint; the watch-only import read it
      // from the descriptor's key-origin text, which lwk doesn't verify.
      existing.fingerprint = w.fingerprint;
      existing.enc = await encryptString(derivedKey, w.mnemonic, mnemonicAad(existing.id));
      await saveStore(store);
    }
    unlockedMnemonics.set(existing.id, w.mnemonic);
    return toInfo(existing);
  }

  const id = genId();
  const record: WalletRecord = {
    id,
    label: w.label,
    network: w.network,
    signer: "local",
    descriptor: w.descriptor,
    fingerprint: w.fingerprint,
    enc: await encryptString(derivedKey, w.mnemonic, mnemonicAad(id)),
    createdAt: Date.now(),
  };
  store.wallets[id] = record;
  store.order.push(id);
  await saveStore(store);
  unlockedMnemonics.set(id, w.mnemonic);
  if (store.order.length === 1) await localSet(ACTIVE_KEY, id);
  return toInfo(record);
}

/** Fields for a hardware (Jade) wallet — watch-only, no seed. */
export interface NewHardwareWallet {
  signer: WalletSigner; // "jade"
  descriptor: string; // watch-only ct-descriptor read from the device
  fingerprint: string;
  label: string;
  network: LiquidNetwork;
}

/**
 * Persist a hardware wallet: watch-only descriptor + signer kind, no encrypted
 * seed. Still requires an unlocked (password-initialized) keystore so the app's
 * lock model is uniform; signing is delegated to the device.
 */
export async function addHardwareWallet(w: NewHardwareWallet): Promise<WalletInfo> {
  if (isLocked() || !derivedKey) throw new Error("Keystore is locked");
  const store = await loadStore();
  if (!store) throw new Error("Keystore not initialized");
  // The fingerprint is what verifies the device signs for this wallet; refuse to
  // persist an empty/malformed one (it would disable the sign-time device check).
  if (!isValidFingerprint(w.fingerprint)) {
    throw new Error("Invalid hardware wallet fingerprint");
  }

  const existing = store.order
    .map((id) => store.wallets[id])
    .find((rec) => rec?.descriptor === w.descriptor);
  if (existing) return toInfo(existing);

  const id = genId();
  const record: WalletRecord = {
    id,
    label: w.label,
    network: w.network,
    signer: w.signer,
    descriptor: w.descriptor,
    fingerprint: w.fingerprint,
    createdAt: Date.now(),
  };
  store.wallets[id] = record;
  store.order.push(id);
  await saveStore(store);
  if (store.order.length === 1) await localSet(ACTIVE_KEY, id);
  return toInfo(record);
}

export async function removeWallet(id: string): Promise<void> {
  const store = await loadStore();
  if (!store || !store.wallets[id]) return;
  delete store.wallets[id];
  store.order = store.order.filter((x) => x !== id);
  await saveStore(store);
  unlockedMnemonics.delete(id);
  const active = await localGet<string>(ACTIVE_KEY);
  if (active === id) await localSet(ACTIVE_KEY, store.order[0] ?? "");
}

export async function setActiveWallet(id: string): Promise<void> {
  const store = await loadStore();
  if (!store || !store.wallets[id]) throw new Error("Unknown wallet");
  await localSet(ACTIVE_KEY, id);
}

export async function getActiveWalletId(): Promise<string | null> {
  const store = await loadStore();
  if (!store) return null;
  return (await localGet<string>(ACTIVE_KEY)) || store.order[0] || null;
}

export async function renameWallet(id: string, label: string): Promise<void> {
  const store = await loadStore();
  if (!store || !store.wallets[id]) throw new Error("Unknown wallet");
  store.wallets[id].label = label;
  await saveStore(store);
}

export async function reorderWallets(order: string[]): Promise<void> {
  const store = await loadStore();
  if (!store) return;
  const known = new Set(store.order);
  const next = order.filter((id) => known.has(id));
  for (const id of store.order) if (!next.includes(id)) next.push(id);
  store.order = next;
  await saveStore(store);
}

/** Cleartext watch-only descriptor (available while locked). */
export async function getDescriptor(id: string): Promise<string> {
  const store = await loadStore();
  const rec = store?.wallets[id];
  if (!rec) throw new Error("Unknown wallet");
  return rec.descriptor;
}

/** Decrypted mnemonic for a wallet (requires unlock). For engine + reveal. */
export function getMnemonic(id: string): string {
  if (isLocked()) throw new Error("Keystore is locked");
  const m = unlockedMnemonics.get(id);
  if (!m) throw new Error("No local seed for this wallet (hardware signer or not unlocked)");
  return m;
}

// ---- MV3 session recovery ----

async function persistSession(key: CryptoKey): Promise<void> {
  await sessionSet(SESSION_KEY, { k: await exportKeyRaw(key) });
}

/**
 * On SW wake, recover the unlocked state from the memory-only session cache
 * so signing survives service-worker eviction without re-prompting.
 */
export async function ensureLoaded(): Promise<void> {
  if (derivedKey) return;
  const sess = await sessionGet<{ k: string }>(SESSION_KEY);
  if (!sess?.k) return; // genuinely locked
  const store = await loadStore();
  if (!store || store.version !== STORE_VERSION) {
    await sessionClear(SESSION_KEY);
    return;
  }
  const key = await importKeyRaw(sess.k);
  if (!(await checkVerifier(key, store.verifier, verifierAad()))) {
    await sessionClear(SESSION_KEY); // stale session (password changed/tamper)
    return;
  }
  unlockedMnemonics.clear();
  for (const id of store.order) {
    const w = store.wallets[id];
    if (w?.enc) unlockedMnemonics.set(id, await decryptString(key, w.enc, mnemonicAad(id))); // skip hardware
  }
  derivedKey = key;
}
