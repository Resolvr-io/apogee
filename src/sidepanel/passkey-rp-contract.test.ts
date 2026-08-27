// Executable record of the RP ID contract written up in
// docs/passkey-unlock.md §4. Read that first; this file exists so the parts of
// it that look arbitrary cannot drift without a failing test demanding a
// re-read.
//
// THE CONTRACT IS THAT THERE IS NO RP ID. Both ceremonies omit `rp.id` and
// `rpId`, so WebAuthn falls back to the caller's origin and every credential is
// baked to `chrome-extension://<extension id>`.
//
// The pins and why each exists:
//
// 1. NO RP ID IS EVER SENT. An earlier design claimed the registrable domain
//    `resolvr.io` via an optional host permission. On Chrome that claim is
//    ACCEPTED and then never dispatched from a side panel — no native prompt,
//    no rejection, a promise pending until the timeout. The identical claim
//    works from a tab, because Chrome renders its own attribution dialog for a
//    domain that is not the caller's and that dialog needs a tab to anchor to.
//    An own-origin ceremony has no such dialog and runs anywhere. Adding an
//    `rp.id` back is therefore not a tidy-up; it reintroduces a hang that
//    presents as a spinner with no error, and it cost two debugging sessions to
//    localize. If you are here to add one, read §4 first.
//
// 2. THE IDENTITY IS THE EXTENSION ID, so it is pinned in the manifest. With no
//    RP ID, credentials are bound to the extension's origin; change or drop the
//    `key` in manifest.config.ts and every enrolled passkey orphans, field-wide,
//    permanently (WebAuthn has no delete, so users cannot even clear the zombie
//    entries from their password manager). That pin is asserted against the
//    BUILT manifest in e2e/passkey-unlock.spec.ts rather than here, so this file
//    stays free of Node builtins — see the note below.
//
// 3. CEREMONIES CARRY AN EXPLICIT, BOUNDED TIMEOUT. WebAuthn's default-less
//    shape turns a refusal into an eternally-pending promise instead of a
//    NotAllowedError the UI could report; a missing timeout is what made defect
//    1 read as "spinner forever" rather than something diagnosable. The value
//    is argued at CEREMONY_TIMEOUT_MS and pinned below only for its two
//    properties: finite, and long enough for a cross-device errand.
//
// Firefox note, so nobody "fixes" this by symmetry: Firefox is the mirror image
// — it supports the host-permission domain claim and NOT the own-origin form
// (bugzilla 1693562, reclassified to an enhancement and still open). Apogee is
// Chrome-only, so own-origin is unambiguously right here. A Firefox build would
// have to reintroduce the domain claim, and its credentials would be separate
// from Chrome's either way.
//
// This file deliberately imports NOTHING that drags a declaration graph into
// the app-side tsc program — not manifest.shared.ts (its `loadEnv` import pulls
// vite's declarations and Node's ambient timer globals, which alone breaks
// unrelated files whose timer types resolve through `window.setTimeout`), and
// no `node:*` builtin either, since tsconfig.json pins `types` explicitly to
// keep exactly those globals out.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// passkey-ceremony.ts reaches src/lib/ext.ts transitively, which evaluates the
// real `chrome` global at import time. Nothing these tests exercise touches the
// namespace beyond that evaluation, so an empty object satisfies it — set
// BEFORE the dynamic import below, whose hoisting order is why it isn't static.
(globalThis as { chrome?: unknown }).chrome ??= {};

interface CeremonyOptions {
  publicKey: {
    rp?: { id?: string; name?: string };
    rpId?: string;
    timeout?: number;
    authenticatorSelection?: { residentKey?: string; userVerification?: string };
    extensions?: { prf?: { eval?: { first?: Uint8Array } } };
  };
}
type CeremonyModule = typeof import("@/sidepanel/passkey-ceremony");
let ceremony!: CeremonyModule;

beforeEach(async () => {
  ceremony = await import("@/sidepanel/passkey-ceremony");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A platform-authenticator-shaped credential: PRF evaluated eagerly, so both
 *  ceremonies resolve on their first call and never follow up with another. */
function stubCredentials() {
  const credential = {
    rawId: new Uint8Array([7, 8]).buffer,
    authenticatorAttachment: "platform",
    response: { getTransports: () => ["internal"] },
    getClientExtensionResults: () => ({
      prf: { results: { first: new Uint8Array(32).buffer } },
    }),
  };
  const api = {
    create: vi.fn(async (_opts: CeremonyOptions) => credential),
    get: vi.fn(async (_opts: CeremonyOptions) => credential),
  };
  vi.stubGlobal("navigator", { credentials: api });
  return api;
}

describe("passkey RP ID contract (docs/passkey-unlock.md §4)", () => {
  // 16 zero bytes in plain base64 — enroll/unlock take the vault salt form,
  // converted to base64url internally.
  const SALT = "AAAAAAAAAAAAAAAAAAAAAA==";

  it("enrollment claims no RP ID, so the credential binds to the extension origin", async () => {
    const api = stubCredentials();
    await ceremony.enrollPasskeyCeremony(SALT, []);
    const opts = api.create.mock.calls[0][0].publicKey;
    // Absent, not empty-string and not the extension id spelled out: WebAuthn's
    // own default is the caller's origin, and saying it explicitly would be a
    // second place to get it wrong.
    expect(opts.rp).not.toHaveProperty("id");
    // `name` stays — it is what the OS dialog shows the user.
    expect(opts.rp?.name).toBe("Apogee");
  });

  it("unlock claims no RP ID either", async () => {
    const api = stubCredentials();
    await ceremony.unlockPasskeyCeremony(SALT, [{ id: "AQIDBA" }]);
    const opts = api.get.mock.calls[0][0].publicKey;
    // A get() that named a domain the create() did not would find nothing —
    // the two halves have to agree, and the only way they cannot disagree is
    // for neither to say anything.
    expect(opts).not.toHaveProperty("rpId");
  });

  it("never sends a registrable domain anywhere in either ceremony", async () => {
    const api = stubCredentials();
    await ceremony.enrollPasskeyCeremony(SALT, []);
    await ceremony.unlockPasskeyCeremony(SALT, [{ id: "AQIDBA" }]);
    // Belt and braces against a partial revert: the literal that used to be
    // claimed must not reappear in any field of either request.
    for (const call of [...api.create.mock.calls, ...api.get.mock.calls]) {
      expect(JSON.stringify(call[0])).not.toContain("resolvr.io");
    }
  });

  it("bounds every ceremony, and leaves room for a cross-device one", () => {
    // Finite is the whole point of pin 3. The lower bound is the cross-device
    // errand — read a QR off the screen, fetch the phone, unlock it, scan,
    // approve — which does not fit in a minute; the upper bound keeps the
    // pathological "accepted but never dispatched" case diagnosable rather
    // than indistinguishable from a hang.
    expect(Number.isFinite(ceremony.CEREMONY_TIMEOUT_MS)).toBe(true);
    expect(ceremony.CEREMONY_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
    expect(ceremony.CEREMONY_TIMEOUT_MS).toBeLessThanOrEqual(300_000);
  });

  it("keeps the properties the ceremony's security rests on", async () => {
    const api = stubCredentials();
    await ceremony.enrollPasskeyCeremony(SALT, []);
    const opts = api.create.mock.calls[0][0].publicKey;
    expect(opts.timeout).toBe(ceremony.CEREMONY_TIMEOUT_MS);
    // Discoverable, because the vault stores no username to look one up by;
    // user-verified, because the biometric IS the security property.
    expect(opts.authenticatorSelection?.residentKey).toBe("required");
    expect(opts.authenticatorSelection?.userVerification).toBe("required");
    expect(opts.extensions?.prf?.eval?.first).toBeInstanceOf(Uint8Array);
  });
});
