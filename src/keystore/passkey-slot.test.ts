// Passkey slot crypto (docs/passkey-unlock.md §2) — the pure half of phase 2,
// everything that doesn't need an authenticator. The WebAuthn property this
// design depends on is exactly one: the PRF is a deterministic function of
// (credential secret, salt) gated behind user verification. So the tests use a
// FAKE authenticator — SHA-256(secret ‖ salt) stands in for the PRF — and every
// real ceremony that satisfies that property is covered by construction. The
// ceremonies themselves (navigator.credentials in the side panel) are
// browser-only and wait on the RP ID decision.

import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, makeVerifier, newKdf, randomBytes } from "./crypto";
import {
  dekCheckAad,
  derivePasskeyKek,
  enrollPasskeySlot,
  generateDek,
  makePasskeySlot,
  openPasskeyDek,
  sameKey,
  unwrapDek,
  vaultPrfSalt,
  type PasswordSlot,
} from "./slots";

/** The fake authenticator: a credential is a secret; evaluating the PRF is
 *  deterministic in (secret, salt). Nothing here models user verification —
 *  that's the ceremony's business, not the crypto's. */
async function fakePrfAsync(
  secret: Uint8Array<ArrayBuffer>,
  salt: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const material = new Uint8Array([...secret, ...base64ToBytes(salt)]);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", material));
}

const CREDENTIAL_SECRET = randomBytes(32);
const PRF_SALT = bytesToBase64(randomBytes(32)); // one per vault
const HKDF_SALT = bytesToBase64(randomBytes(32));
const OTHER_HKDF_SALT = bytesToBase64(randomBytes(32));

describe("passkey KEK derivation", () => {
  it("is deterministic: the same PRF evaluation opens what it sealed, across derivations", async () => {
    // Non-extractable keys can't be compared by bytes — compare by behavior:
    // a DEK wrapped under one derivation must unwrap under a second, fresh
    // derivation from the same inputs.
    const prf = await fakePrfAsync(CREDENTIAL_SECRET, PRF_SALT);
    const dek = await generateDek();
    const slot = await makePasskeySlot(await derivePasskeyKek(prf, HKDF_SALT), dek, {
      credentialId: bytesToBase64(randomBytes(16)),
      prfSalt: PRF_SALT,
      hkdfSalt: HKDF_SALT,
      kind: "device",
    });
    const reopened = await unwrapDek(await derivePasskeyKek(prf, HKDF_SALT), slot);
    expect(await sameKey(dek, reopened)).toBe(true);
  });

  it("produces a non-extractable key", async () => {
    const kek = await derivePasskeyKek(await fakePrfAsync(CREDENTIAL_SECRET, PRF_SALT), HKDF_SALT);
    expect(kek.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", kek)).rejects.toThrow();
  });

  it("differs per credential, per PRF salt, and per HKDF salt", async () => {
    const dek = await generateDek();
    const prf = await fakePrfAsync(CREDENTIAL_SECRET, PRF_SALT);
    const slot = await makePasskeySlot(await derivePasskeyKek(prf, HKDF_SALT), dek, {
      credentialId: bytesToBase64(randomBytes(16)),
      prfSalt: PRF_SALT,
      hkdfSalt: HKDF_SALT,
      kind: "device",
    });
    // A different credential (its own secret) evaluating the SAME vault PRF
    // salt — the shared-salt, distinct-output property the one-salt-per-vault
    // rule depends on — must not open this slot.
    const otherCredential = await fakePrfAsync(randomBytes(32), PRF_SALT);
    await expect(unwrapDek(await derivePasskeyKek(otherCredential, HKDF_SALT), slot)).rejects.toThrow();
    // Nor a different HKDF salt, nor a different PRF salt.
    await expect(unwrapDek(await derivePasskeyKek(prf, OTHER_HKDF_SALT), slot)).rejects.toThrow();
    const wrongSalt = await fakePrfAsync(CREDENTIAL_SECRET, bytesToBase64(randomBytes(32)));
    await expect(unwrapDek(await derivePasskeyKek(wrongSalt, HKDF_SALT), slot)).rejects.toThrow();
  });

  it("domain-separates from any other use of the same PRF output", async () => {
    // A consumer deriving with a different HKDF info (some other protocol
    // using the same credential) must land on a different key: the info
    // binding is load-bearing, not decorative.
    const prf = await fakePrfAsync(CREDENTIAL_SECRET, PRF_SALT);
    const dek = await generateDek();
    const slot = await makePasskeySlot(await derivePasskeyKek(prf, HKDF_SALT), dek, {
      credentialId: bytesToBase64(randomBytes(16)),
      prfSalt: PRF_SALT,
      hkdfSalt: HKDF_SALT,
      kind: "device",
    });
    const base = await crypto.subtle.importKey("raw", prf, "HKDF", false, ["deriveKey"]);
    const stranger = await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: base64ToBytes(HKDF_SALT),
        info: new TextEncoder().encode("someone-else:v9"),
      },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    await expect(unwrapDek(stranger, slot)).rejects.toThrow();
  });
});

describe("passkey slot shape", () => {
  it("records what's needed to ask again — and nothing secret", async () => {
    const dek = await generateDek();
    const slot = await makePasskeySlot(
      await derivePasskeyKek(await fakePrfAsync(CREDENTIAL_SECRET, PRF_SALT), HKDF_SALT),
      dek,
      { credentialId: "cred-1", prfSalt: PRF_SALT, hkdfSalt: HKDF_SALT, kind: "cross-device" },
    );
    expect(slot.type).toBe("passkey");
    expect(slot.credentialId).toBe("cred-1");
    expect(slot.prfSalt).toBe(PRF_SALT);
    expect(slot.hkdfSalt).toBe(HKDF_SALT);
    expect(slot.kind).toBe("cross-device");
    expect(typeof slot.addedAt).toBe("number");
    // No field carries key material: everything present is identifiers, salts,
    // and the wrapped DEK.
    expect(slot.wrappedDek.ct).not.toContain(CREDENTIAL_SECRET.join(","));
  });
});

describe("passkey enrollment and unlock cores", () => {
  async function vaultWithPasskey() {
    const dek = await generateDek();
    const prf = await fakePrfAsync(CREDENTIAL_SECRET, PRF_SALT);
    const slot = await enrollPasskeySlot(dek, prf, { credentialId: "cred-1", kind: "device" }, PRF_SALT);
    const dekCheck = await makeVerifier(dek, dekCheckAad(3));
    return { dek, slot, dekCheck };
  }

  it("enrolls a slot that a later evaluation of the same credential opens", async () => {
    const { dek, slot, dekCheck } = await vaultWithPasskey();
    const prf = await fakePrfAsync(CREDENTIAL_SECRET, PRF_SALT); // a fresh ceremony
    const opened = await openPasskeyDek([slot], prf, dekCheck);
    expect(opened).toBeDefined();
    expect(await sameKey(dek, opened!)).toBe(true);
  });

  it("vaultPrfSalt reuses the existing salt — one per vault, not per credential", async () => {
    const { slot } = await vaultWithPasskey();
    expect(vaultPrfSalt([slot])).toBe(slot.prfSalt);
    expect(vaultPrfSalt([])).not.toBe(vaultPrfSalt([])); // fresh when the vault has none
  });

  it("one evaluation opens either of two enrolled credentials (the shared-salt property)", async () => {
    const dek = await generateDek();
    const prfSalt = PRF_SALT;
    const secretB = randomBytes(32); // the second credential's own secret
    const slots = [
      await enrollPasskeySlot(dek, await fakePrfAsync(CREDENTIAL_SECRET, prfSalt), { credentialId: "a", kind: "device" }, prfSalt),
      await enrollPasskeySlot(dek, await fakePrfAsync(secretB, prfSalt), { credentialId: "b", kind: "cross-device" }, prfSalt),
    ];
    const dekCheck = await makeVerifier(dek, dekCheckAad(3));
    // One prompt's bytes come from whichever credential the user picks; either
    // must open the vault through the shared salt.
    for (const secret of [CREDENTIAL_SECRET, secretB]) {
      const opened = await openPasskeyDek(slots, await fakePrfAsync(secret, prfSalt), dekCheck);
      expect(opened).toBeDefined();
      expect(await sameKey(dek, opened!)).toBe(true);
    }
  });

  it("a wrong evaluation returns null (no throw) and never reports which slot failed", async () => {
    const { slot, dekCheck } = await vaultWithPasskey();
    const stranger = await fakePrfAsync(randomBytes(32), PRF_SALT);
    expect(await openPasskeyDek([slot], stranger, dekCheck)).toBeNull();
  });

  it("skips password slots entirely", async () => {
    const { dek, slot, dekCheck } = await vaultWithPasskey();
    const passwordSlot: PasswordSlot = {
      type: "password",
      id: "pw",
      kdf: { ...newKdf(), iterations: 1000 },
      wrappedDek: { iv: "", ct: "" },
    };
    const prf = await fakePrfAsync(CREDENTIAL_SECRET, PRF_SALT);
    const opened = await openPasskeyDek([passwordSlot, slot], prf, dekCheck);
    expect(await sameKey(dek, opened!)).toBe(true);
  });
});
