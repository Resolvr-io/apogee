// Unit tests for the vault re-wrap migration engine (pure WebCrypto — Node-safe).

import { describe, expect, it } from "vitest";
import type { Enc, Kdf } from "./crypto";
import {
  checkVerifier,
  decryptString,
  deriveKey,
  encryptString,
  makeVerifier,
  newKdf,
} from "./crypto";
import type { WalletRecord } from "./keystore";
import {
  type StoreV2Shape,
  type VaultMigration,
  hasMigrationPath,
  migrateStore,
  mnemonicAad,
  rewrapEnvelopes,
  verifierAad,
} from "./migrations";

const PASSWORD = "correct horse battery staple";

// Fast KDF for tests — iteration count is irrelevant to the stepping logic.
const kdf: Kdf = { ...newKdf(), iterations: 1000 };

async function testKey(): Promise<CryptoKey> {
  return deriveKey(PASSWORD, kdf);
}

function wallet(id: string, enc?: Enc): WalletRecord {
  return {
    id,
    label: `wallet ${id}`,
    network: "liquid",
    signer: "local",
    descriptor: "ct(...)elwpkh(...)",
    fingerprint: "00112233",
    enc,
    createdAt: 1234,
  };
}

/** A store at `version` whose envelopes (verifier + every mnemonic) are bound
 *  to that version's AAD scheme. */
async function storeAt(version: number, mnemonics: Record<string, string>): Promise<StoreV2Shape> {
  const key = await testKey();
  const wallets: Record<string, WalletRecord> = {};
  for (const [id, mnemonic] of Object.entries(mnemonics)) {
    wallets[id] = wallet(id, await encryptString(key, mnemonic, mnemonicAad(version, id)));
  }
  return {
    version,
    kdf,
    verifier: await makeVerifier(key, verifierAad(version)),
    wallets,
    order: Object.keys(mnemonics),
  };
}

describe("rewrapEnvelopes", () => {
  it("re-binds verifier and mnemonics to the next version's AAD under the same key", async () => {
    const key = await testKey();
    const store = await storeAt(2, { a: "alpha phrase", b: "beta phrase" });
    const next = await rewrapEnvelopes(key, store, 2);
    expect(next.version).toBe(3);
    expect(await decryptString(key, next.wallets.a.enc!, mnemonicAad(3, "a"))).toBe("alpha phrase");
    expect(await decryptString(key, next.wallets.b.enc!, mnemonicAad(3, "b"))).toBe("beta phrase");
    expect(await checkVerifier(key, next.verifier, verifierAad(3))).toBe(true);
    // And NOT under the old AAD — the re-wrap really moved the binding.
    await expect(decryptString(key, next.wallets.a.enc!, mnemonicAad(2, "a"))).rejects.toThrow();
    expect(await checkVerifier(key, next.verifier, verifierAad(2))).toBe(false);
  });

  it("carries seedless (hardware) wallets through unchanged", async () => {
    const key = await testKey();
    const jade = wallet("j");
    jade.signer = "jade";
    const store = await storeAt(2, { a: "alpha phrase" });
    store.wallets.j = jade;
    store.order.push("j");
    const next = await rewrapEnvelopes(key, store, 2);
    expect(next.wallets.j).toBe(jade);
    expect(next.order).toContain("j");
  });

  it("carries an orphaned record (in wallets, missing from order) through rather than dropping it", async () => {
    const key = await testKey();
    const store = await storeAt(2, { a: "alpha phrase", orphan: "orphan phrase" });
    store.order = ["a"]; // orphan fell out of the index — must not be deleted
    const next = await rewrapEnvelopes(key, store, 2);
    expect(await decryptString(key, next.wallets.orphan.enc!, mnemonicAad(3, "orphan"))).toBe(
      "orphan phrase",
    );
  });
});

describe("hasMigrationPath", () => {
  const m: Record<number, VaultMigration> = {
    2: (k, s) => rewrapEnvelopes(k, s as StoreV2Shape, 2),
    3: (k, s) => rewrapEnvelopes(k, s as StoreV2Shape, 3),
  };

  it("is true only when every step on the chain is registered", () => {
    expect(hasMigrationPath(2, 4, m)).toBe(true);
    expect(hasMigrationPath(3, 4, m)).toBe(true);
    expect(hasMigrationPath(2, 5, m)).toBe(false); // v4 step missing
    expect(hasMigrationPath(1, 4, m)).toBe(false); // v1→2 step missing
  });

  it("is false for a corrupt or absent version, or a newer-than-target store", () => {
    expect(hasMigrationPath(Number.NaN, 4, m)).toBe(false);
    expect(hasMigrationPath(2.5, 4, m)).toBe(false);
    expect(hasMigrationPath(5, 4, m)).toBe(false);
  });
});

describe("migrateStore", () => {
  it("chains registered steps to the target version", async () => {
    const key = await testKey();
    const store = await storeAt(2, { a: "alpha phrase" });
    const migrations: Record<number, VaultMigration> = {
      2: (k, s) => rewrapEnvelopes(k, s as StoreV2Shape, 2),
      3: (k, s) => rewrapEnvelopes(k, s as StoreV2Shape, 3),
    };
    const out = (await migrateStore(key, store, 4, migrations)) as StoreV2Shape;
    expect(out.version).toBe(4);
    expect(await decryptString(key, out.wallets.a.enc!, mnemonicAad(4, "a"))).toBe("alpha phrase");
    expect(await checkVerifier(key, out.verifier, verifierAad(4))).toBe(true);
  });

  it("is a no-op when the store is already at target", async () => {
    const key = await testKey();
    const store = await storeAt(4, { a: "alpha phrase" });
    const out = await migrateStore(key, store, 4, { 2: (k, s) => rewrapEnvelopes(k, s as StoreV2Shape, 2) });
    expect(out).toBe(store);
  });

  it("throws when a step on the path is unregistered", async () => {
    const key = await testKey();
    const store = await storeAt(2, { a: "alpha phrase" });
    await expect(migrateStore(key, store, 4, {})).rejects.toThrow("no migration path from vault version 2");
  });

  it("throws when a step does not advance the version by exactly one", async () => {
    const key = await testKey();
    const store = await storeAt(2, { a: "alpha phrase" });
    const lazy: Record<number, VaultMigration> = {
      2: async (_k, s) => ({ ...s, version: 4 }), // skips v3
    };
    await expect(migrateStore(key, store, 4, lazy)).rejects.toThrow(
      "migration from v2 produced v4, expected v3",
    );
  });

  it("refuses a store newer than the target build", async () => {
    const key = await testKey();
    const store = await storeAt(5, { a: "alpha phrase" });
    await expect(migrateStore(key, store, 4, {})).rejects.toThrow("newer than this build supports");
  });

  it("does not mutate the input store on a mid-chain failure", async () => {
    const key = await testKey();
    const store = await storeAt(2, { a: "alpha phrase" });
    const broken: Record<number, VaultMigration> = {
      2: (k, s) => rewrapEnvelopes(k, s as StoreV2Shape, 2),
      3: () => Promise.reject(new Error("boom")),
    };
    await expect(migrateStore(key, store, 4, broken)).rejects.toThrow("boom");
    // The caller persists only on success, and the input is untouched either way.
    expect(store.version).toBe(2);
    expect(await decryptString(key, store.wallets.a.enc!, mnemonicAad(2, "a"))).toBe("alpha phrase");
  });
});
