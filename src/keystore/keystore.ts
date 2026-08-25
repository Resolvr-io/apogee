// Mnemonic keystore — the keystore-of-record. Runs in the service worker.
//
// Holds BIP-39 mnemonics encrypted at rest in browser.storage.local, with the
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

import { browser } from "@/lib/ext";
import {
  type Enc,
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
import {
  type StoreShape,
  type StoreV2Shape,
  type VaultStore,
  VAULT_MIGRATIONS,
  hasMigrationPath,
  migrateStore,
  mnemonicAad as mnemonicAadFor,
  verifierAad as verifierAadFor,
} from "./migrations";
import {
  type KeySlot,
  type PasskeyKind,
  type PasskeySlot,
  type PasswordSlot,
  dekCheckAad,
  enrollPasskeySlot,
  generateDek,
  makePasswordSlotWithKey,
  openPasskeyDek,
  unwrapDek,
  vaultPrfSalt,
  wrapDek,
} from "./slots";

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
// v3 puts every payload under one random data key (the DEK) and wraps that
// key in per-factor slots (see slots.ts and docs/passkey-unlock.md §1); the
// in-memory `dek` below is that key, not the password-derived key. v2 vaults
// migrate in place while unlocked (see migrations.ts) — v1 predates public
// release and has no registered path, so those still require a reset.
const STORE_VERSION = 3;

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
  // Set by the SW router (not the keystore): auto-lock is "never", the wallet is
  // unlocked, and this panel session hasn't re-verified the password yet.
  needsStepUp?: boolean;
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
// The DEK — the single key every payload is encrypted under, unwrapped from a
// slot at unlock. The password key exists only for the unwrap and the verifier.
let dek: CryptoKey | null = null;
const unlockedMnemonics = new Map<string, string>(); // walletId → mnemonic

// ---- unlock attempt throttling ----
//
// Progressive lockout against password guessing at the keyboard. Enforced HERE
// (the service worker) rather than in the UI — any extension surface can send
// wallet/unlock, so a UI-only guard would be bypassable — and persisted in
// browser.storage.local so reopening the panel or restarting the browser doesn't
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
  await browser.storage.local.remove(THROTTLE_KEY);
}

// ---- browser.storage helpers ----
async function localGet<T>(key: string): Promise<T | undefined> {
  const obj = await browser.storage.local.get(key);
  return obj[key] as T | undefined;
}
async function localSet(key: string, value: unknown): Promise<void> {
  await browser.storage.local.set({ [key]: value });
}
async function sessionGet<T>(key: string): Promise<T | undefined> {
  const obj = await browser.storage.session.get(key);
  return obj[key] as T | undefined;
}
async function sessionSet(key: string, value: unknown): Promise<void> {
  await browser.storage.session.set({ [key]: value });
}
async function sessionClear(key: string): Promise<void> {
  await browser.storage.session.remove(key);
}

// Either shape can be on disk — v2 until an unlocked migration rewrites it.
async function loadStore(): Promise<StoreV2Shape | StoreShape | undefined> {
  return localGet<StoreV2Shape | StoreShape>(STORE_KEY);
}
// Accepts either shape: mutations of shared fields (wallets/order) can run
// against a not-yet-migrated store, and writing it back unchanged is exactly
// what it read. Envelope/key mutations are version-guarded at their sites.
async function saveStore(store: StoreV2Shape | StoreShape): Promise<void> {
  await localSet(STORE_KEY, store);
}

/** Narrow a loaded store to the current shape — valid only once its version
 *  has been checked or a migration has landed it there. */
function asCurrent(store: VaultStore): StoreShape {
  if (store.version !== STORE_VERSION) throw new Error("vault format needs upgrading");
  return store as StoreShape;
}

/** The vault's password slot. Exactly one always exists — a future passkey is
 *  an ADDITIONAL door and removing the password slot is refused at this layer
 *  (see docs/passkey-unlock.md, "the password slot is permanent"). */
function passwordSlotOf(store: StoreShape): PasswordSlot {
  const slot = store.slots.find((s): s is PasswordSlot => s.type === "password");
  if (!slot) throw new Error("vault has no password slot");
  return slot;
}

// One vault migration at a time. Each run mints a FRESH random DEK, so two
// racing runs would each persist their own store — and the loser's in-memory
// key would no longer open the winner's ciphertexts, failing every later
// decrypt until a lock/unlock. unlock() and ensureLoaded() can genuinely race:
// ensureLoaded is the first await of both SW message handlers, and a password
// unlock can arrive while one is mid-flight.
let migrationChain: Promise<unknown> = Promise.resolve();
function serializeMigration<T>(run: () => Promise<T>): Promise<T> {
  const result = migrationChain.then(run);
  migrationChain = result.then(
    () => undefined,
    () => undefined, // the other run's failure is its own caller's to report
  );
  return result;
}

/** Migrate `store` to the current version if needed, exactly once across any
 *  concurrent callers: re-reads the store inside the lock, so a caller that
 *  queued behind a finished migration adopts its result instead of minting a
 *  second DEK. The key must be verified against the on-disk store first. */
async function migrateExclusive(
  key: CryptoKey,
  store: StoreV2Shape | StoreShape,
): Promise<StoreShape> {
  return serializeMigration(async () => {
    // Re-read under the lock: another caller may have migrated while this one
    // queued. A missing store means it was reset mid-flight — treat the
    // caller's own snapshot as the thing to refuse on.
    const fresh = (await loadStore()) ?? store;
    if (fresh.version >= STORE_VERSION) return fresh as StoreShape;
    const migrated = asCurrent(await migrateStore(key, fresh, STORE_VERSION, VAULT_MIGRATIONS));
    await saveStore(migrated);
    return migrated;
  });
}

function genId(): string {
  return `w_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

// ---- state queries ----

export async function isInitialized(): Promise<boolean> {
  return (await loadStore()) !== undefined;
}

export function isLocked(): boolean {
  return dek === null;
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
// ciphertext could be swapped between wallet slots and still decrypt. The
// version-parameterized scheme lives in migrations.ts (a re-wrap needs both the
// old and the new AAD); these zero-arg forms always mean the CURRENT version.
function verifierAad(): string {
  return verifierAadFor(STORE_VERSION);
}
function mnemonicAad(walletId: string): string {
  return mnemonicAadFor(STORE_VERSION, walletId);
}

function txManifestCheckpointAad(context: string): string {
  return `apogee:tx-manifest-checkpoint:v1:${context}`;
}

async function txManifestCheckpointKey(walletId: string): Promise<CryptoKey> {
  // Deriving from the wallet seed keeps checkpoints readable after a password
  // change while still making an unlocked wallet a prerequisite for recovery.
  const mnemonic = await getMnemonic(walletId);
  const material = new TextEncoder().encode(
    `apogee:tx-manifest-checkpoint-key:v1:${walletId}:${mnemonic}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Seal an unresolved signed TX Manifest payload for durable local storage. */
export async function sealTxManifestCheckpoint(
  walletId: string,
  context: string,
  plaintext: string,
): Promise<Enc> {
  return encryptString(
    await txManifestCheckpointKey(walletId),
    plaintext,
    txManifestCheckpointAad(context),
  );
}

/** Open a durable checkpoint. This intentionally fails while the wallet is locked. */
export async function openTxManifestCheckpoint(
  walletId: string,
  context: string,
  encrypted: Enc,
): Promise<string> {
  return decryptString(
    await txManifestCheckpointKey(walletId),
    encrypted,
    txManifestCheckpointAad(context),
  );
}

/** Create a fresh keystore behind a password, left unlocked. No wallet yet. */
export async function initialize(password: string): Promise<void> {
  if (await isInitialized()) throw new Error("Keystore already initialized");
  const kdf = newKdf();
  const key = await deriveKey(password, kdf);
  const freshDek = await generateDek();
  const store: StoreShape = {
    version: STORE_VERSION,
    slots: [await makePasswordSlotWithKey(key, kdf, freshDek)],
    verifier: await makeVerifier(key, verifierAad()),
    dekCheck: await makeVerifier(freshDek, dekCheckAad(STORE_VERSION)),
    wallets: {},
    order: [],
  };
  await saveStore(store);
  dek = freshDek;
  await persistSession(freshDek);
  await clearUnlockFailures(); // fresh vault — a stale counter must not guard it
}

/** Derive the key from the password, verify it, and migrate an older vault
 *  format in place if needed. Mnemonics decrypt on demand. */
export async function unlock(password: string): Promise<void> {
  const store = await loadStore();
  if (!store) throw new Error("Keystore not initialized");
  if (store.version > STORE_VERSION) {
    // Never touch a newer vault: this build doesn't know its format, and a
    // wrong-handed write could destroy it (e.g. after downgrading the extension).
    throw new Error(
      "This vault was written by a newer version of Apogee. Update the extension, or reset Apogee and re-import your recovery phrase.",
    );
  }
  // Decide reachability BEFORE the password or the throttle: an unmigratable
  // older store (or a corrupt version field) would otherwise fail the verifier
  // check below — its AAD scheme was never written by this build — and read as
  // "Incorrect password" for the correct password, burning the attempt counter
  // toward the hard lock.
  if (store.version !== STORE_VERSION && !hasMigrationPath(store.version, STORE_VERSION, VAULT_MIGRATIONS)) {
    throw new Error(
      "Apogee's encrypted storage format changed in this update. Reset Apogee and re-import your recovery phrase.",
    );
  }
  await assertAttemptAllowed();
  // The KDF descriptor moved into the password slot in v3; a v2 store still
  // carries it at the top level.
  const kdf = "kdf" in store ? store.kdf : passwordSlotOf(asCurrent(store)).kdf;
  const key = await deriveKey(password, kdf);
  // Verify against the version ON DISK — the verifier is version-bound, and the
  // password must prove itself against the vault as it exists, pre-migration.
  if (!(await checkVerifier(key, store.verifier, verifierAadFor(store.version)))) {
    await recordUnlockFailure();
    throw new Error("Incorrect password");
  }
  await clearUnlockFailures();
  // Migration (if any) and the slot unwrap share one recovery message: a vault
  // that cannot be migrated or whose slot will not open is bricked either way,
  // and the user should see the reset-and-re-import path, not a raw
  // OperationError. Nothing is persisted unless every step succeeds, so a
  // failure leaves the old-format vault intact.
  let opened: CryptoKey;
  try {
    const vault = await migrateExclusive(key, store);
    // The password key's job ends here: it opens the password slot, and the
    // DEK that comes out is what the session holds and every payload
    // decrypts under.
    opened = await unwrapDek(key, passwordSlotOf(vault));
  } catch (err) {
    // Diagnostic only — the error is an OperationError/quota error, not key
    // material, and a bare field report of "it told me to reset" is otherwise
    // indistinguishable between a bad envelope and a failed storage write.
    console.warn("vault migration failed", err);
    throw new Error(
      "Apogee's encrypted storage format changed in this update and couldn't be upgraded in place. Reset Apogee and re-import your recovery phrase.",
    );
  }
  // Mnemonics are NOT decrypted here — getMnemonic decrypts on demand, so a
  // plaintext seed enters SW memory only while that wallet is actually in use,
  // never all wallets at once for the length of the session.
  unlockedMnemonics.clear();
  dek = opened;
  await persistSession(opened);
}

/** Wipe all in-memory secrets and the session cache. */
export async function lock(): Promise<void> {
  dek = null;
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
  dek = null;
  unlockedMnemonics.clear();
  await sessionClear(SESSION_KEY);
  // THROTTLE_KEY goes too: the counter guards the vault being destroyed, and a
  // survivor would lock the user out of the NEXT vault they create/restore.
  await browser.storage.local.remove([STORE_KEY, ACTIVE_KEY, THROTTLE_KEY]);
}

/**
 * Raw local-storage snapshot of the persisted keystore (encrypted store + active
 * id), for rolling back a destructive replace-restore if re-creation fails. The
 * in-memory unlocked state is NOT captured — a rollback lands on a locked wallet.
 */
export async function snapshotLocal(): Promise<Record<string, unknown>> {
  return browser.storage.local.get([STORE_KEY, ACTIVE_KEY]);
}
export async function restoreLocal(snap: Record<string, unknown>): Promise<void> {
  await browser.storage.local.set(snap);
}

/** Verify a password without changing lock state (step-up auth). Shares the
 *  unlock throttle — throws UNLOCK_THROTTLED/UNLOCK_BLOCKED while guarded. */
export async function verifyPassword(password: string): Promise<boolean> {
  const store = await loadStore();
  if (!store) return false;
  // These read the verifier under the CURRENT AAD scheme, which is only valid
  // for a current-version store. Both are step-up auth behind an already-
  // unlocked vault (which implies a migrated store); refuse an older one
  // explicitly rather than checking a stale scheme — a wrong-handed "false"
  // here would burn the unlock throttle for a correct password.
  if (store.version !== STORE_VERSION) throw new Error("Keystore format needs upgrading — unlock first");
  await assertAttemptAllowed();
  const key = await deriveKey(password, passwordSlotOf(asCurrent(store)).kdf);
  const ok = await checkVerifier(key, store.verifier, verifierAad());
  if (ok) await clearUnlockFailures();
  else await recordUnlockFailure();
  return ok;
}

/** Re-wrap every wallet under a new password. Requires the current one.
 *  Shares the unlock throttle — the old-password check is the same oracle. */
export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  const store = await loadStore();
  if (!store) throw new Error("Keystore not initialized");
  // Same invariant as verifyPassword — and stronger here: the re-wrap below
  // writes current-version envelopes regardless of what it read, so running it
  // against an older store would corrupt every seed in the vault.
  if (store.version !== STORE_VERSION) throw new Error("Keystore format needs upgrading — unlock first");
  await assertAttemptAllowed();
  const oldKey = await deriveKey(oldPassword, passwordSlotOf(asCurrent(store)).kdf);
  if (!(await checkVerifier(oldKey, store.verifier, verifierAad()))) {
    await recordUnlockFailure();
    throw new Error("Incorrect password");
  }
  await clearUnlockFailures();
  const current = asCurrent(store);
  const oldSlot = passwordSlotOf(current);
  // v3: the DEK is unwrapped once and re-wrapped under the new password — no
  // mnemonic ciphertext moves, which is the whole point of the slot design:
  // there is exactly one wrap site to remember, and forgetting is impossible.
  const openedDek = await unwrapDek(oldKey, oldSlot);
  const kdf = newKdf();
  const newKey = await deriveKey(newPassword, kdf);
  const slots: KeySlot[] = [];
  for (const s of current.slots) {
    slots.push(s === oldSlot ? { ...s, kdf, wrappedDek: await wrapDek(openedDek, newKey, s.id) } : s);
  }
  const next: StoreShape = {
    ...current,
    slots,
    verifier: await makeVerifier(newKey, verifierAad()),
  };
  await saveStore(next);
  // The DEK is unchanged — the vault stays unlocked and the session stays
  // valid; dekCheck and every wallet envelope are byte-identical.
  dek = openedDek;
  await persistSession(openedDek);
}

// ---- wallet management ----

/** Persist a new wallet (caller derived descriptor/fingerprint via engine). */
export async function addWallet(w: NewWallet): Promise<WalletInfo> {
  if (isLocked() || !dek) throw new Error("Keystore is locked");
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
      existing.enc = await encryptString(dek, w.mnemonic, mnemonicAad(existing.id));
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
    enc: await encryptString(dek, w.mnemonic, mnemonicAad(id)),
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
  if (isLocked() || !dek) throw new Error("Keystore is locked");
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

/** Decrypted mnemonic for a wallet (requires unlock). For engine + reveal.
 *  Decrypted on demand and cached until lock: unlock() deliberately does not
 *  warm every wallet's seed, so plaintext mnemonics exist in SW memory one at a
 *  time, only for wallets that actually sign. */
export async function getMnemonic(id: string): Promise<string> {
  if (isLocked() || !dek) throw new Error("Keystore is locked");
  const cached = unlockedMnemonics.get(id);
  if (cached) return cached;
  const store = await loadStore();
  const rec = store?.wallets[id];
  if (!rec?.enc) throw new Error("No local seed for this wallet (hardware signer)");
  const mnemonic = await decryptString(dek, rec.enc, mnemonicAad(id));
  unlockedMnemonics.set(id, mnemonic);
  return mnemonic;
}

// ---- passkey slots (docs/passkey-unlock.md §2) ----

/** Secret-free passkey view for the UI — the unlock screen's button and the
 *  Settings list. Readable while locked: none of these fields is key
 *  material, and the unlock screen has to know whether a passkey door exists
 *  before asking for one. */
export interface PasskeyInfo {
  id: string;
  kind: PasskeyKind;
  addedAt: number;
}

export async function listPasskeys(): Promise<PasskeyInfo[]> {
  const store = await loadStore();
  if (!store || store.version !== STORE_VERSION) return [];
  return asCurrent(store)
    .slots.filter((s): s is PasskeySlot => s.type === "passkey")
    .map(({ id, kind, addedAt }) => ({ id, kind, addedAt }));
}

/** What the unlock ceremony needs BEFORE any user gesture: the enrolled
 *  credential ids (so the prompt offers exactly this vault's passkeys) and the
 *  vault-wide PRF salt. Null when no passkey is enrolled or the store is not
 *  current — the caller treats that as "no passkey door". */
export async function passkeyChallenge(): Promise<{
  credentialIds: string[];
  prfSalt: string;
} | null> {
  const store = await loadStore();
  if (!store || store.version !== STORE_VERSION) return null;
  const slots = asCurrent(store).slots.filter((s): s is PasskeySlot => s.type === "passkey");
  if (slots.length === 0) return null;
  // Every passkey slot carries the same vault salt by construction (see
  // enrollPasskey); reading the first is reading the salt.
  return { credentialIds: slots.map((s) => s.credentialId), prfSalt: slots[0].prfSalt };
}

/**
 * Enroll: seal the DEK under a passkey. The PRF bytes arrive from the panel's
 * ceremony (base64 over the runtime message — a Uint8Array would arrive as a
 * plain object and silently derive the wrong key; the router decodes and
 * length-checks). Requires an unlocked vault — what gets sealed is the DEK —
 * and the ceremony itself already supplied user verification.
 */
export async function enrollPasskey(
  prfOutput: Uint8Array<ArrayBuffer>,
  meta: { credentialId: string; kind: PasskeyKind },
): Promise<PasskeyInfo> {
  if (isLocked() || !dek) throw new Error("Keystore is locked");
  const store = await loadStore();
  if (!store) throw new Error("Keystore not initialized");
  if (store.version !== STORE_VERSION) throw new Error("Keystore format needs upgrading — unlock first");
  const current = asCurrent(store);
  const slot = await enrollPasskeySlot(dek, prfOutput, meta, vaultPrfSalt(current.slots));
  current.slots.push(slot);
  await saveStore(current);
  return { id: slot.id, kind: slot.kind, addedAt: slot.addedAt };
}

/**
 * Unlock through a passkey: one PRF evaluation against every enrolled slot
 * (they share the vault salt, so one prompt's bytes may open any of them).
 * Deliberately does NOT consult or touch the unlock throttle on failure — the
 * throttle exists for a secret an attacker can guess; a failed unwrap carries
 * no information, and counting attempts would let a flaky fingerprint sensor
 * hard-lock the owner out of their own vault. A SUCCESS clears it, because it
 * proves the legitimate user.
 */
export async function unlockWithPasskey(prfOutput: Uint8Array<ArrayBuffer>): Promise<void> {
  const store = await loadStore();
  if (!store) throw new Error("Keystore not initialized");
  if (store.version > STORE_VERSION) {
    throw new Error(
      "This vault was written by a newer version of Apogee. Update the extension, or reset Apogee and re-import your recovery phrase.",
    );
  }
  if (store.version !== STORE_VERSION) {
    // An older store must migrate through the password path first; the
    // passkey slot only exists from v3 on.
    throw new Error("Keystore format needs upgrading — unlock with the password first");
  }
  const current = asCurrent(store);
  const opened = await openPasskeyDek(current.slots, prfOutput, current.dekCheck);
  if (!opened) throw new Error("PASSKEY_UNLOCK_FAILED");
  await clearUnlockFailures();
  unlockedMnemonics.clear();
  dek = opened;
  await persistSession(opened);
}

/**
 * Remove a passkey slot (Settings). Requires an unlocked vault, and is
 * non-destructive by construction — the vault and every key survive; only a
 * convenience is lost, which is why there is no step-up here (step-up is for
 * destruction). The password slot is permanent and structurally unreachable:
 * this only ever removes slots of type "passkey".
 */
export async function removePasskey(id: string): Promise<void> {
  if (isLocked() || !dek) throw new Error("Keystore is locked");
  const store = await loadStore();
  if (!store) throw new Error("Keystore not initialized");
  if (store.version !== STORE_VERSION) throw new Error("Keystore format needs upgrading — unlock first");
  const current = asCurrent(store);
  const before = current.slots.length;
  current.slots = current.slots.filter((s) => s.type !== "passkey" || s.id !== id);
  if (current.slots.length === before) throw new Error("Unknown passkey");
  await saveStore(current);
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
  if (dek) return;
  const sess = await sessionGet<{ k: string }>(SESSION_KEY);
  if (!sess?.k) return; // genuinely locked
  const store = await loadStore();
  if (!store || store.version > STORE_VERSION) {
    await sessionClear(SESSION_KEY);
    return;
  }
  if (store.version !== STORE_VERSION && !hasMigrationPath(store.version, STORE_VERSION, VAULT_MIGRATIONS)) {
    // Unmigratable here too (corrupt version field or a pruned chain entry):
    // the checks below would fail against a scheme this build never wrote, and
    // we'd drop a perfectly good session for no reason.
    await sessionClear(SESSION_KEY);
    return;
  }
  const key = await importKeyRaw(sess.k);
  if (store.version < STORE_VERSION) {
    // A pre-v3 session caches the PASSWORD key, and it is a valid vault key,
    // so the migration can run here too — a browser that stayed open across an
    // update migrates without a prompt. Afterwards the session is upgraded to
    // the DEK the migrated vault unwraps to. On any failure, drop the session
    // and let unlock() retry with the password.
    try {
      // Through the shared mutex, and re-read inside: an unlock that raced us
      // to the migration is adopted rather than doubled.
      const vault = await migrateExclusive(key, store);
      const opened = await unwrapDek(key, passwordSlotOf(vault));
      unlockedMnemonics.clear();
      dek = opened;
      await persistSession(opened);
    } catch (err) {
      console.warn("vault migration failed", err);
      await sessionClear(SESSION_KEY);
    }
    return;
  }
  // v3 sessions cache the DEK. The DEK-bound check (not the password-bound
  // verifier — no password is involved here) is what drops a stale or foreign
  // key: a pre-v3 session key against a migrated store fails it and lands on
  // the password prompt, which is the correct place for it.
  if (!(await checkVerifier(key, asCurrent(store).dekCheck, dekCheckAad(STORE_VERSION)))) {
    await sessionClear(SESSION_KEY);
    return;
  }
  // Same as unlock(): recover the key, decrypt nothing eagerly.
  unlockedMnemonics.clear();
  dek = key;
}
