// Passkey surface of the keystore itself — the composed invariants its pieces
// are correct alone but nothing pinned together before now (docs/passkey-unlock.md,
// "Testing" short list):
//
//   - an enrolled passkey keeps opening the vault across a password change
//     (changePassword re-wraps ONE wrap site by design; this proves it),
//   - a ceremony that evaluated a different salt than the vault's stored one
//     is refused (PASSKEY_SALT_MISMATCH — the looks-enrolled-opens-for-nobody
//     case),
//   - removing an unknown credential id is refused without disturbing the rest.
//
// These drive keystore.ts top-to-bottom against an in-memory
// browser.storage: real WebCrypto throughout, cheap KDF iterations so the
// suite stays fast. True service-worker eviction — the one thing this shape
// still can't see — is the e2e's job (chrome.runtime.reload() in
// e2e/passkey-unlock.spec.ts); a unit `lock()` already covers its observable
// core, since lock drops the in-memory DEK and the session cache both.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PASSKEY_OFFER_KEY } from "@/lib/passkey-offer";

const { localStore, sessionStore } = vi.hoisted(() => ({
  localStore: new Map<string, unknown>(),
  sessionStore: new Map<string, unknown>(),
}));

type StorageKeys = string | readonly string[];

vi.mock("@/lib/ext", () => ({
  browser: {
    storage: {
      local: chromeArea(localStore),
      session: chromeArea(sessionStore),
    },
  },
}));

function chromeArea(map: Map<string, unknown>) {
  return {
    // Chrome semantics: get(string | string[]) answers {[k]: value}, absent
    // keys are omitted.
    async get(query: StorageKeys) {
      const keys = typeof query === "string" ? [query] : [...query];
      return Object.fromEntries(keys.filter((k) => map.has(k)).map((k) => [k, map.get(k)]));
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) map.set(k, v);
    },
    async remove(query: StorageKeys) {
      const keys = typeof query === "string" ? [query] : [...query];
      for (const k of keys) map.delete(k);
    },
  };
}

import { bytesToBase64, deriveKey, makeVerifier, newKdf, randomBytes } from "./crypto";
import * as keystore from "./keystore";
import { verifierAad } from "./migrations";
import { dekCheckAad, generateDek, makePasswordSlotWithKey } from "./slots";

const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "different horse battery staple";
const STORE_KEY = "apogee_keystore"; // mirrors keystore.ts

/** The fake authenticator, same as passkey-slot.test: SHA-256(secret ‖ salt). */
async function fakePrf(secret: Uint8Array<ArrayBuffer>, salt: string): Promise<Uint8Array<ArrayBuffer>> {
  const material = new Uint8Array([...secret, ...atobLike(salt)]);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", material));
}

function atobLike(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const SECRET = randomBytes(32);

/** A v3 vault on disk whose password slot derives at cheap iterations — the
 *  real initialize() path, minus the 600k-round cost multiplied by every test. */
async function seedVault(): Promise<void> {
  const kdf = { ...newKdf(), iterations: 1000 };
  const key = await deriveKey(PASSWORD, kdf);
  const dek = await generateDek();
  localStore.set(STORE_KEY, {
    version: 3,
    slots: [await makePasswordSlotWithKey(key, kdf, dek)],
    verifier: await makeVerifier(key, verifierAad(3)),
    dekCheck: await makeVerifier(dek, dekCheckAad(3)),
    wallets: {},
    order: [],
  });
}

async function enrollFirstPasskey(): Promise<{ info: keystore.PasskeyInfo; prf: Uint8Array<ArrayBuffer> }> {
  const prfSalt = bytesToBase64(randomBytes(32)); // minted panel-side on first enrollment
  const prf = await fakePrf(SECRET, prfSalt);
  const info = await keystore.enrollPasskey(
    prf,
    { credentialId: bytesToBase64(randomBytes(16)), kind: "device" },
    prfSalt,
  );
  return { info, prf };
}

/** A SECOND device: its own authenticator secret, so its PRF output over the
 *  shared vault salt is unrelated to the first's — which is the whole premise
 *  of the per-vault salt (slots.ts, vaultPrfSalt). The salt comes from the
 *  vault, exactly as the panel would read it back out of passkeyChallenge()
 *  before the ceremony. */
async function enrollAnotherDevice(
  secret: Uint8Array<ArrayBuffer>,
  meta: { kind: keystore.PasskeyInfo["kind"]; transports?: string[] },
): Promise<{ info: keystore.PasskeyInfo; prf: Uint8Array<ArrayBuffer>; credentialId: string }> {
  const challenge = await keystore.passkeyChallenge();
  if (!challenge) throw new Error("no vault salt to enroll against");
  const prf = await fakePrf(secret, challenge.prfSalt);
  const credentialId = bytesToBase64(randomBytes(16));
  const info = await keystore.enrollPasskey(prf, { credentialId, ...meta }, challenge.prfSalt);
  return { info, prf, credentialId };
}

async function addLocalWallet(): Promise<string> {
  const w = await keystore.addWallet({
    mnemonic: "test surge guilt marine focus rug pulse broker wife accordion stamp cow mango",
    descriptor: "ct(elwpkh(...))",
    fingerprint: "00112233",
    label: "integration",
    network: "liquid",
  });
  return w.id;
}

beforeEach(() => {
  localStore.clear();
  sessionStore.clear();
});

describe("passkeys across a password change", () => {
  it("a passkey enrolled before the change still opens the vault after it — cold", async () => {
    await seedVault();
    await keystore.unlock(PASSWORD);
    const walletId = await addLocalWallet();
    const { prf } = await enrollFirstPasskey();

    await keystore.changePassword(PASSWORD, NEW_PASSWORD);

    // Cold: lock() drops the in-memory DEK and the session cache both — the
    // only thing left bridging the change is the persisted slot wrapping the
    // SAME data key.
    await keystore.lock();
    await expect(keystore.unlock(PASSWORD)).rejects.toThrow("Incorrect password");
    await keystore.unlockWithPasskey(prf);

    const state = await keystore.getState();
    expect(state.locked).toBe(false);
    // Same DEK: the seeds — the reason the vault exists — read back intact.
    expect(await keystore.getMnemonic(walletId)).toContain("accordion");
    const passkeys = await keystore.listPasskeys();
    expect(passkeys).toHaveLength(1);
  });
});

describe("enrollPasskey guard rails", () => {
  it("refuses a ceremony salt that disagrees with the vault's stored one", async () => {
    await seedVault();
    await keystore.unlock(PASSWORD);
    await enrollFirstPasskey();

    const strangerSalt = bytesToBase64(randomBytes(32));
    const strangerPrf = await fakePrf(randomBytes(32), strangerSalt);
    await expect(
      keystore.enrollPasskey(
        strangerPrf,
        { credentialId: bytesToBase64(randomBytes(16)), kind: "device" },
        strangerSalt,
      ),
    ).rejects.toThrow("PASSKEY_SALT_MISMATCH");
    // The refused enrollment left the vault untouched.
    expect(await keystore.listPasskeys()).toHaveLength(1);
  });

  it("removePasskey refuses an unknown id and keeps the real slot", async () => {
    await seedVault();
    await keystore.unlock(PASSWORD);
    const { info } = await enrollFirstPasskey();

    await expect(keystore.removePasskey("not-a-real-id")).rejects.toThrow("Unknown passkey");
    const passkeys = await keystore.listPasskeys();
    expect(passkeys).toHaveLength(1);
    expect(passkeys[0].id).toBe(info.id);
  });

  it("removePasskey leaves the password slot structurally unreachable", async () => {
    await seedVault();
    await keystore.unlock(PASSWORD);
    const { info } = await enrollFirstPasskey();
    await keystore.removePasskey(info.id);

    expect(await keystore.listPasskeys()).toHaveLength(0);
    const store = localStore.get(STORE_KEY) as { slots: { type: string }[] };
    expect(store.slots.some((s) => s.type === "password")).toBe(true);
    // And the password door still opens what remains.
    await keystore.lock();
    await keystore.unlock(PASSWORD);
    expect((await keystore.getState()).locked).toBe(false);
  });
});

// The multi-device story (docs/passkey-unlock.md §2): the slot array has always
// allowed N passkeys, and nothing pinned what happens once N > 1. Every one of
// these is a way the second enrollment could quietly cost the user the first.
describe("more than one device enrolled", () => {
  it("a second device joins without disturbing the first, and either one opens the vault", async () => {
    await seedVault();
    await keystore.unlock(PASSWORD);
    const walletId = await addLocalWallet();
    const first = await enrollFirstPasskey();
    const second = await enrollAnotherDevice(randomBytes(32), { kind: "cross-device" });

    expect(await keystore.listPasskeys()).toHaveLength(2);
    expect(second.info.id).not.toBe(first.info.id);

    // The first device, cold, AFTER the second was added — the wrap sites are
    // independent, so enrolling one must not re-key the other.
    await keystore.lock();
    await keystore.unlockWithPasskey(first.prf);
    expect(await keystore.getMnemonic(walletId)).toContain("accordion");

    // And the second, equally, on its own.
    await keystore.lock();
    await keystore.unlockWithPasskey(second.prf);
    expect(await keystore.getMnemonic(walletId)).toContain("accordion");
  });

  it("both devices share the vault salt, so one prompt can offer either", async () => {
    await seedVault();
    await keystore.unlock(PASSWORD);
    await enrollFirstPasskey();
    const saltAfterFirst = (await keystore.passkeyChallenge())?.prfSalt;
    const second = await enrollAnotherDevice(randomBytes(32), { kind: "security-key" });

    const challenge = await keystore.passkeyChallenge();
    // A re-minted salt here would be the silent catastrophe: the second slot
    // would look enrolled while the unlock ceremony asked for a salt only one
    // of the two devices could answer.
    expect(challenge?.prfSalt).toBe(saltAfterFirst);
    expect(challenge?.credentials.map((c) => c.id)).toContain(second.credentialId);
    expect(challenge?.credentials).toHaveLength(2);
  });

  it("hands each device's transports back to the next ceremony", async () => {
    await seedVault();
    await keystore.unlock(PASSWORD);
    await enrollFirstPasskey(); // enrolled without transports, as pre-existing slots are
    const phone = await enrollAnotherDevice(randomBytes(32), {
      kind: "cross-device",
      transports: ["hybrid"],
    });

    const challenge = await keystore.passkeyChallenge();
    const byId = new Map(challenge?.credentials.map((c) => [c.id, c.transports]));
    // The hybrid hint is what makes a browser offer the phone at unlock; a
    // slot that forgot it is a passkey the user can no longer reach.
    expect(byId.get(phone.credentialId)).toEqual(["hybrid"]);
    // Absent stays absent rather than becoming [] — an empty array reads as
    // "reachable by nothing".
    expect([...byId.values()].filter((t) => t === undefined)).toHaveLength(1);
  });

  it("removing one device leaves the other opening the vault", async () => {
    await seedVault();
    await keystore.unlock(PASSWORD);
    const walletId = await addLocalWallet();
    const first = await enrollFirstPasskey();
    const second = await enrollAnotherDevice(randomBytes(32), { kind: "security-key" });

    await keystore.removePasskey(second.info.id);
    expect(await keystore.listPasskeys().then((p) => p.map((x) => x.id))).toEqual([first.info.id]);

    await keystore.lock();
    // The removed device is refused — its slot is gone, and the PRF bytes it
    // would produce open nothing.
    await expect(keystore.unlockWithPasskey(second.prf)).rejects.toThrow("PASSKEY_UNLOCK_FAILED");
    expect((await keystore.getState()).locked).toBe(true);
    // The one that stayed still works.
    await keystore.unlockWithPasskey(first.prf);
    expect(await keystore.getMnemonic(walletId)).toContain("accordion");
  });
});

// The offer is the only discoverable way in — Settings is where people do not
// look — so a dismissal that outlives its vault makes passkey enrollment
// effectively invisible after a reset.
describe("reset clears the one-time offer's dismissal", () => {
  it("a dismissed offer does not outlive the vault it was dismissed for", async () => {
    await seedVault();
    await keystore.unlock(PASSWORD);
    // The panel writes this when the user says "not now" (or closes the card).
    localStore.set(PASSKEY_OFFER_KEY, true);

    await keystore.reset();

    // Gone, exactly like the unlock throttle: both are per-vault state whose
    // survival would silently degrade the NEXT vault.
    expect(localStore.has(PASSKEY_OFFER_KEY)).toBe(false);
  });
});
