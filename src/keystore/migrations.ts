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
import { decryptString, encryptString } from "./crypto";
import type { WalletRecord } from "./keystore";

/** The persisted store shape (kept in sync with keystore.ts). */
export interface StoreShape {
  version: number;
  kdf: Kdf;
  verifier: Enc;
  wallets: Record<string, WalletRecord>;
  order: string[];
}

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
export async function rewrapEnvelopes(
  key: CryptoKey,
  store: StoreShape,
  fromVersion: number,
): Promise<StoreShape> {
  const to = fromVersion + 1;
  const wallets: Record<string, WalletRecord> = {};
  for (const id of store.order) {
    const w = store.wallets[id];
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

/** One vault migration: store at version N in, store at version N+1 out. */
export type VaultMigration = (key: CryptoKey, store: StoreShape) => Promise<StoreShape>;

/**
 * Registered migrations, keyed by the version they upgrade FROM. Empty today:
 * no shipped vault format is older than the current one. To bump STORE_VERSION
 * to N, register the N-1 entry — normally
 * `(key, store) => rewrapEnvelopes(key, store, N - 1)` — and extend
 * migrations.test.ts. unlock()/ensureLoaded() step through this chain while the
 * vault key is live; a missing entry falls back to the reset-and-re-import path.
 */
export const VAULT_MIGRATIONS: Record<number, VaultMigration> = {};

/**
 * Step a store up to `target`, applying each version's migration in order.
 * The vault key must already be verified against `store.verifier`.
 * Throws when no migration is registered for a step on the path — the caller
 * falls back to the hard "reset and re-import" error, never to a half-migrated
 * store (nothing is persisted until every step has succeeded).
 */
export async function migrateStore(
  key: CryptoKey,
  store: StoreShape,
  target: number,
  migrations: Record<number, VaultMigration> = {},
): Promise<StoreShape> {
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
