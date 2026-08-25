// Vault v3 — the DEK-and-slots rework (docs/passkey-unlock.md §1). The
// properties pinned here are the ones the spec calls out for phase 1: the
// migration's byte-verify, ciphertext untouched by key-slot changes, the
// slot wrap's AAD binding, and the abort paths. Pure WebCrypto, Node-safe.

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
  VAULT_MIGRATIONS,
  type StoreV2Shape,
  migrateStore,
  migrateV2ToV3,
  mnemonicAad,
  verifierAad,
} from "./migrations";
import {
  type KeySlot,
  dekCheckAad,
  generateDek,
  makePasswordSlot,
  makePasswordSlotWithKey,
  sameKey,
  unwrapDek,
} from "./slots";

const PASSWORD = "correct horse battery staple";
const OTHER_PASSWORD = "different horse battery staple";

const kdf: Kdf = { ...newKdf(), iterations: 1000 };

async function passwordKey(password = PASSWORD): Promise<CryptoKey> {
  return deriveKey(password, kdf);
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

async function v2Store(mnemonics: Record<string, string>): Promise<StoreV2Shape> {
  const key = await passwordKey();
  const wallets: Record<string, WalletRecord> = {};
  for (const [id, mnemonic] of Object.entries(mnemonics)) {
    wallets[id] = wallet(id, await encryptString(key, mnemonic, mnemonicAad(2, id)));
  }
  return {
    version: 2,
    kdf,
    verifier: await makeVerifier(key, verifierAad(2)),
    wallets,
    order: Object.keys(mnemonics),
  };
}

describe("v2→v3 migration", () => {
  it("re-encrypts every mnemonic under the DEK and verifies it reads back identical", async () => {
    const key = await passwordKey();
    const store = await v2Store({ a: "alpha phrase", b: "beta phrase" });
    const next = await migrateV2ToV3(key, store);
    expect(next.version).toBe(3);

    const dek = await unwrapDek(key, next.slots[0]);
    expect(await decryptString(dek, next.wallets.a.enc!, mnemonicAad(3, "a"))).toBe("alpha phrase");
    expect(await decryptString(dek, next.wallets.b.enc!, mnemonicAad(3, "b"))).toBe("beta phrase");
    // The ciphertext really moved off the password key: the v2 envelopes no
    // longer decrypt with it, and the new ones are not the old ones.
    await expect(decryptString(key, next.wallets.a.enc!, mnemonicAad(3, "a"))).rejects.toThrow();
    expect(next.wallets.a.enc!.ct).not.toBe(store.wallets.a.enc!.ct);
  });

  it("keeps the same KDF descriptor — a format migration never changes the password", async () => {
    const key = await passwordKey();
    const store = await v2Store({ a: "alpha phrase" });
    const next = await migrateV2ToV3(key, store);
    expect(next.slots[0].kdf).toEqual(store.kdf);
    // The verifier still proves the SAME password under the v3 AAD.
    expect(await checkVerifier(key, next.verifier, verifierAad(3))).toBe(true);
    expect(await checkVerifier(await passwordKey(OTHER_PASSWORD), next.verifier, verifierAad(3))).toBe(false);
  });

  it("validates the session key through the DEK check", async () => {
    const key = await passwordKey();
    const next = await migrateV2ToV3(key, await v2Store({ a: "alpha phrase" }));
    const dek = await unwrapDek(key, next.slots[0]);
    expect(await checkVerifier(dek, next.dekCheck, dekCheckAad(3))).toBe(true);
    expect(await checkVerifier(key, next.dekCheck, dekCheckAad(3))).toBe(false); // password key is not the DEK
  });

  it("carries hardware (seedless) wallets through unchanged", async () => {
    const key = await passwordKey();
    const store = await v2Store({ a: "alpha phrase" });
    const jade = wallet("j");
    jade.signer = "jade";
    store.wallets.j = jade;
    store.order.push("j");
    const next = await migrateV2ToV3(key, store);
    expect(next.wallets.j).toBe(jade);
  });

  it("carries an orphaned record (in wallets, missing from order) through", async () => {
    const key = await passwordKey();
    const store = await v2Store({ a: "alpha phrase", orphan: "orphan phrase" });
    store.order = ["a"];
    const next = await migrateV2ToV3(key, store);
    const dek = await unwrapDek(key, next.slots[0]);
    expect(await decryptString(dek, next.wallets.orphan.enc!, mnemonicAad(3, "orphan"))).toBe(
      "orphan phrase",
    );
  });

  it("aborts (throws) on a corrupted v2 envelope, leaving the input untouched", async () => {
    const key = await passwordKey();
    const store = await v2Store({ a: "alpha phrase" });
    // Truncate the ciphertext: decryption fails and nothing is produced.
    store.wallets.a.enc!.ct = store.wallets.a.enc!.ct.slice(0, 8);
    await expect(migrateV2ToV3(key, store)).rejects.toThrow();
    // The caller persists only on success; the input is still intact v2.
    expect(store.version).toBe(2);
    expect(await checkVerifier(key, store.verifier, verifierAad(2))).toBe(true);
  });

  it("refuses a store that is not v2", async () => {
    const key = await passwordKey();
    const store = await v2Store({ a: "alpha phrase" });
    store.version = 3; // a v3 store reaching the v2 step is a chain wiring bug
    await expect(migrateV2ToV3(key, store)).rejects.toThrow("not v2");
  });

  it("runs through the registered chain via migrateStore", async () => {
    const key = await passwordKey();
    const out = await migrateStore(key, await v2Store({ a: "alpha phrase" }), 3, VAULT_MIGRATIONS);
    expect(out.version).toBe(3);
    // The engine speaks the loose store shape; the registered v3 step produces
    // the real one, so narrow once and use it.
    const vault = out as unknown as { slots: KeySlot[]; wallets: Record<string, WalletRecord> };
    const dek = await unwrapDek(key, vault.slots[0]);
    expect(await decryptString(dek, vault.wallets.a.enc!, mnemonicAad(3, "a"))).toBe("alpha phrase");
  });
});

describe("key slots", () => {
  it("round-trips the DEK through a password slot", async () => {
    const dek = await generateDek();
    const slot = await makePasswordSlot(PASSWORD, kdf, dek);
    expect(await sameKey(dek, await unwrapDek(await passwordKey(), slot))).toBe(true);
  });

  it("does not unwrap under a wrong password", async () => {
    const dek = await generateDek();
    const slot = await makePasswordSlot(PASSWORD, kdf, dek);
    await expect(unwrapDek(await passwordKey(OTHER_PASSWORD), slot)).rejects.toThrow();
  });

  it("binds the wrap to the slot's identity — no transplanting between slots", async () => {
    const dek = await generateDek();
    const a = await makePasswordSlot(PASSWORD, kdf, dek);
    const b = await makePasswordSlot(PASSWORD, kdf, dek);
    // A wrapped key moved into another slot's record fails on the AAD.
    const transplanted = { ...a, id: b.id };
    await expect(unwrapDek(await passwordKey(), transplanted)).rejects.toThrow();
  });

  it("re-keying under a new password opens to the SAME DEK — the slot changed, the key did not", async () => {
    // The shape of keystore.changePassword: unwrap once, wrap under the new
    // password. Everything downstream (wallet envelopes, the DEK check) is
    // untouched by construction — this pins that the slot is the only wrap.
    const dek = await generateDek();
    const oldSlot = await makePasswordSlot(PASSWORD, kdf, dek);
    const nextKdf: Kdf = { ...newKdf(), iterations: 1000 };
    const newKey = await deriveKey(OTHER_PASSWORD, nextKdf);
    const newSlot = await makePasswordSlotWithKey(newKey, nextKdf, dek);

    const throughOld = await unwrapDek(await passwordKey(), oldSlot);
    const throughNew = await unwrapDek(newKey, newSlot);
    expect(await sameKey(throughOld, throughNew)).toBe(true);
    expect(await sameKey(throughOld, dek)).toBe(true);
    // And the old slot is dead once removed: only the new password opens it.
    await expect(unwrapDek(await passwordKey(), newSlot)).rejects.toThrow();
  });
});
