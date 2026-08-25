// One-step vault re-wrap migrations for STORE_VERSION bumps.
//
// A format bump used to brick existing vaults ("reset and re-import") — fail-
// safe, but a user without a paper backup loses their view of funds. Instead,
// each bump now ships a migration that re-writes the store in place while the
// vault key is available: the envelopes are decrypted under the OLD scheme and
// re-encrypted under the new one, then the whole store is persisted in a single
// atomic storage.set. No password change is involved — "re-wrap" means format,
// not key (see keystore.changePassword for the password path).
//
// Pure — WebCrypto only, no browser.* — so the stepping semantics are unit-
// testable in plain Node (keystore.ts itself registers listeners at import
// transitively through the service worker and is not loadable there).

import type { Enc, Kdf } from "./crypto";
import { checkVerifier, decryptString, encryptString, makeVerifier } from "./crypto";
import type { WalletRecord } from "./keystore";
import {
  type KeySlot,
  dekCheckAad,
  generateDek,
  makePasswordSlotWithKey,
  sameKey,
  unwrapDek,
} from "./slots";

/** The pre-v3 store shape: every payload wrapped directly under the password
 *  key, whose KDF descriptor sat at the top level. `version` is open rather
 *  than the literal 2 because the migration engine's tests build synthetic
 *  future versions on the same shape — the real 2→v3 step checks the version
 *  itself. (Type alias, not interface: it must satisfy the engine's indexed
 *  VaultStore, and aliases get the implicit index signature.) */
export type StoreV2Shape = {
  version: number;
  kdf: Kdf;
  verifier: Enc;
  wallets: Record<string, WalletRecord>;
  order: string[];
}

/** The persisted store shape from v3 on (kept in sync with keystore.ts): all
 *  payloads under the DEK, and one wrapped copy of the DEK per unlock factor
 *  (see slots.ts and docs/passkey-unlock.md §1). The top-level `kdf` is gone —
 *  each password slot carries its own. (Type alias for the same indexed-store
 *  reason as StoreV2Shape.) */
export type StoreShape = {
  version: 3;
  slots: KeySlot[];
  verifier: Enc; // password-bound — proves the password before a slot is opened
  dekCheck: Enc; // DEK-bound — validates a session-cached key (see ensureLoaded)
  wallets: Record<string, WalletRecord>;
  order: string[];
}

/** Any store a migration step may consume or produce. The engine's contract
 *  is version-stepping; which shape a step reads or writes is the step's own
 *  business (migrateV2ToV3 narrows internally, tests use synthetic versions
 *  that no shipped store ever had). */
export type VaultStore = { version: number } & Record<string, unknown>;

/** Envelope AAD for a given store version — see keystore.ts for the scheme. */
export function verifierAad(version: number): string {
  return `apogee:verifier:v${version}`;
}
export function mnemonicAad(version: number, walletId: string): string {
  return `apogee:mnemonic:v${version}:${walletId}`;
}

/** Re-wrap every wallet's mnemonic envelope and the verifier from
 *  `fromVersion` to `fromVersion + 1`, under the SAME derived key. This is the
 *  shape every AAD-scheme bump needs; a migration that changes more than the
 *  envelope scheme can compose on top of it. */
export async function rewrapEnvelopes<
  S extends {
    version: number;
    verifier: Enc;
    wallets: Record<string, WalletRecord>;
  },
>(key: CryptoKey, store: S, fromVersion: number): Promise<S> {
  const to = fromVersion + 1;
  // Driven by the wallets MAP, not `order`: a record that exists but fell out
  // of `order` (corrupt index) is carried through, not silently deleted — this
  // runs automatically on every user's first unlock after an update, and the
  // dropped record would be an encrypted seed.
  const wallets: Record<string, WalletRecord> = {};
  for (const [id, w] of Object.entries(store.wallets)) {
    if (!w) continue;
    // Hardware wallets have no seed to re-wrap; carry them through unchanged.
    wallets[id] = w.enc
      ? {
          ...w,
          enc: await encryptString(
            key,
            await decryptString(key, w.enc, mnemonicAad(fromVersion, id)),
            mnemonicAad(to, id),
          ),
        }
      : w;
  }
  const mnemonic = await decryptString(key, store.verifier, verifierAad(fromVersion));
  return {
    ...store,
    version: to,
    verifier: await encryptString(key, mnemonic, verifierAad(to)),
    wallets,
  };
}

/** One vault migration: store at version N in, store at version N+1 out. The
 *  engine's contract is version-stepping only — what each step re-shapes is
 *  the step's business, so the shapes are the union both ways. */
export type VaultMigration = (key: CryptoKey, store: VaultStore) => Promise<VaultStore>;

/**
 * v2 → v3 — the slot rework (docs/passkey-unlock.md §1). Every mnemonic is
 * decrypted out of its password-wrapped v2 envelope and re-encrypted under a
 * fresh random DEK; a single password slot wraps that DEK under the same
 * password key (this migration changes the FORMAT, never the password), and a
 * DEK-bound check takes the place the verifier held for session validation.
 *
 * Before anything is usable, every new ciphertext is decrypted back out and
 * compared byte-for-byte with what went in — the plaintexts of every mnemonic,
 * the DEK that comes back out of the new slot, both verifiers. The caller
 * persists only on success, so a failure anywhere leaves the v2 vault intact
 * and the user exactly where they were.
 */
export async function migrateV2ToV3(key: CryptoKey, input: VaultStore): Promise<StoreShape> {
  if (input.version !== 2 || !("kdf" in input) || !("wallets" in input)) {
    throw new Error("v2→v3 migration called on a store that is not v2");
  }
  const store = input as StoreV2Shape;
  // Prove the key opens THIS vault before anything is re-keyed under it. The
  // byte-verify below cannot do this job: it checks the OUTPUT against the
  // migration's own inputs, and for a seedless vault — hardware-only, or a
  // password set before any wallet exists — `key` is otherwise never used to
  // decrypt anything pre-existing, so any key produces a self-consistent v3
  // store. This step must be self-defending (not a caller-side check) because
  // ensureLoaded feeds it a session key that nothing else has verified.
  if (!(await checkVerifier(key, store.verifier, verifierAad(2)))) {
    throw new Error("v2→v3 migration called with a key that does not open this vault");
  }
  const dek = await generateDek();
  const wallets: Record<string, WalletRecord> = {};
  // Driven by the wallets MAP, not `order`: a record that fell out of `order`
  // (corrupt index) is carried through, not silently deleted — this runs on
  // every user's first unlock after the update, and the dropped record would
  // be an encrypted seed.
  for (const [id, w] of Object.entries(store.wallets)) {
    if (!w) continue;
    // Hardware wallets have no seed to wrap; carry them through unchanged.
    wallets[id] = w.enc
      ? {
          ...w,
          enc: await encryptString(dek, await decryptString(key, w.enc, mnemonicAad(2, id)), mnemonicAad(3, id)),
        }
      : w;
  }
  const slot = await makePasswordSlotWithKey(key, store.kdf, dek);
  const next: StoreShape = {
    version: 3,
    slots: [slot],
    verifier: await makeVerifier(key, verifierAad(3)),
    dekCheck: await makeVerifier(dek, dekCheckAad(3)),
    wallets,
    order: store.order,
  };

  // ---- byte-verify: nothing above is trusted until it reads back identical.
  // This deliberately decrypts each v2 envelope a SECOND time (the wrapping
  // loop already held the plaintext): a verify that reuses in-flight values
  // verifies the arithmetic, not the store.
  for (const [id, w] of Object.entries(store.wallets)) {
    if (!w?.enc) continue;
    const from = await decryptString(key, w.enc, mnemonicAad(2, id));
    const back = await decryptString(dek, wallets[id].enc!, mnemonicAad(3, id));
    if (from !== back) throw new Error(`v2→v3 migration verify failed for wallet ${id}`);
  }
  if (!(await sameKey(dek, await unwrapDek(key, slot)))) {
    throw new Error("v2→v3 migration verify failed: slot does not unwrap to the DEK");
  }
  if (!(await checkVerifier(key, next.verifier, verifierAad(3)))) {
    throw new Error("v2→v3 migration verify failed: verifier");
  }
  if (!(await checkVerifier(dek, next.dekCheck, dekCheckAad(3)))) {
    throw new Error("v2→v3 migration verify failed: DEK check");
  }
  return next;
}

/**
 * Registered migrations, keyed by the version they upgrade FROM. v1 predates
 * public release and has no path (reset-and-re-import, as ever). To bump
 * STORE_VERSION to N, register the N-1 entry — a pure AAD-scheme bump is
 * `(key, store) => rewrapEnvelopes(key, store, N - 1)`; a shape change gets a
 * hand-written step like migrateV2ToV3 — and extend migrations.test.ts.
 * unlock()/ensureLoaded() step through this chain while the vault key is live;
 * a missing entry falls back to the reset-and-re-import path.
 */
export const VAULT_MIGRATIONS: Record<number, VaultMigration> = {
  2: migrateV2ToV3,
};

/**
 * Whether a chain of registered migrations can carry `from` up to `target`.
 * False for a non-integer/absent version (a corrupt or truncated store) and
 * for any gap in the chain. Callers use this to refuse an unreachable store
 * BEFORE deriving a key or touching the unlock throttle — checking the
 * verifier against an AAD scheme this build never wrote would read as
 * "Incorrect password" for the correct password and burn the attempt counter.
 */
export function hasMigrationPath(
  from: number,
  target: number,
  migrations: Record<number, VaultMigration> = {},
): boolean {
  if (!Number.isInteger(from) || from > target) return false;
  for (let v = from; v < target; v++) if (!migrations[v]) return false;
  return true;
}

/**
 * Step a store up to `target`, applying each version's migration in order.
 * The vault key must already be verified against `store.verifier`.
 * Throws when no migration is registered for a step on the path — the caller
 * falls back to the hard "reset and re-import" error, never to a half-migrated
 * store (nothing is persisted until every step has succeeded).
 */
export async function migrateStore(
  key: CryptoKey,
  store: VaultStore,
  target: number,
  migrations: Record<number, VaultMigration> = {},
): Promise<VaultStore> {
  if (store.version > target) {
    throw new Error(`vault version ${store.version} is newer than this build supports (${target})`);
  }
  let current = store;
  while (current.version < target) {
    const from = current.version;
    const step = migrations[from];
    if (!step) {
      throw new Error(`no migration path from vault version ${from}`);
    }
    current = await step(key, current);
    // A step that lies about the version it produced would loop forever or
    // strand the store between formats — fail loudly instead of persisting it.
    if (current.version !== from + 1) {
      throw new Error(`migration from v${from} produced v${current.version}, expected v${from + 1}`);
    }
  }
  return current;
}
