// The contract that makes a SECOND device reachable (docs/passkey-unlock.md §2).
//
// The slot model has always allowed any number of passkeys; what it lacked was
// a way for the user to ever create the second one. Two facts about real
// browsers are why:
//
// 1. Left unconstrained, a machine with a platform authenticator answers
//    create() with that authenticator. Once it holds this vault's passkey,
//    excludeCredentials refuses the attempt — so "add a passkey" dead-ends on
//    InvalidStateError forever and the phone in the user's pocket is
//    unreachable. Pinning `cross-platform` is the only route past it.
//
// 2. A credential descriptor without transports is a credential the browser
//    does not know how to reach. `hybrid` is what turns an entry in
//    allowCredentials into an offer to use a phone; drop the hint and the
//    passkey the user enrolled from their phone simply is not offered back to
//    them. getTransports() answers only on the response of the ceremony that
//    minted the credential, so if enrollment does not record it, nothing can.
//
// Both are shape-of-the-request properties: invisible to the e2e virtual
// authenticator (which has exactly one transport and no picker) and invisible
// to typecheck. Hence assertions on the arguments themselves.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// src/lib/ext.ts evaluates the real `chrome` global at import time; nothing
// here touches the namespace beyond that. Set before the dynamic import.
(globalThis as { chrome?: unknown }).chrome ??= {};

interface CreateOptions {
  publicKey: {
    authenticatorSelection?: {
      authenticatorAttachment?: string;
      residentKey?: string;
      userVerification?: string;
    };
    excludeCredentials?: { id: Uint8Array; type: string; transports?: string[] }[];
  };
}
interface GetOptions {
  publicKey: {
    allowCredentials?: { id: Uint8Array; type: string; transports?: string[] }[];
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

/** A credential shaped like whichever authenticator the test is standing in
 *  for. PRF is evaluated eagerly so no ceremony below follows up with a
 *  second call and muddies the recorded arguments. */
function stubCredentials(
  shape: { attachment?: string; transports?: string[] } = {
    attachment: "platform",
    transports: ["internal"],
  },
) {
  const credential = {
    rawId: new Uint8Array([1, 2, 3, 4]).buffer,
    authenticatorAttachment: shape.attachment,
    response: { getTransports: () => shape.transports ?? [] },
    getClientExtensionResults: () => ({
      prf: { results: { first: new Uint8Array(32).buffer } },
    }),
  };
  const api = {
    create: vi.fn(async (_opts: CreateOptions) => credential),
    get: vi.fn(async (_opts: GetOptions) => credential),
  };
  vi.stubGlobal("navigator", { credentials: api });
  return api;
}

// 16 zero bytes in plain base64 — the vault salt's stored form.
const SALT = "AAAAAAAAAAAAAAAAAAAAAA==";

describe("enrolling from another device", () => {
  it("leaves the attachment open when the user has not said where", async () => {
    const api = stubCredentials();
    await ceremony.enrollPasskeyCeremony(SALT, [], "any");
    const selection = api.create.mock.calls[0][0].publicKey.authenticatorSelection;
    // Unset, not "platform": the browser's own picker is the right answer when
    // the user pressed a button that did not name a device.
    expect(selection).not.toHaveProperty("authenticatorAttachment");
    // The two invariants that hold whatever the attachment: discoverable (the
    // vault stores no username to look one up by) and user-verified (the
    // biometric IS the security property).
    expect(selection?.residentKey).toBe("required");
    expect(selection?.userVerification).toBe("required");
  });

  it("pins cross-platform when the user asked for another device", async () => {
    const api = stubCredentials({ attachment: "cross-platform", transports: ["hybrid"] });
    await ceremony.enrollPasskeyCeremony(SALT, [], "another-device");
    const selection = api.create.mock.calls[0][0].publicKey.authenticatorSelection;
    // Without this the platform authenticator answers, and if it already holds
    // the vault's passkey the attempt is refused with no route to a phone.
    expect(selection?.authenticatorAttachment).toBe("cross-platform");
    expect(selection?.residentKey).toBe("required");
    expect(selection?.userVerification).toBe("required");
  });

  it("records the transports the authenticator reported, since nothing can ask later", async () => {
    stubCredentials({ attachment: "cross-platform", transports: ["hybrid", "internal"] });
    const result = await ceremony.enrollPasskeyCeremony(SALT, [], "another-device");
    expect(result.transports).toEqual(["hybrid", "internal"]);
    // hybrid + cross-platform is a phone, and the slot label has to say so.
    expect(result.kind).toBe("cross-device");
  });

  it("reports a plugged-in key as a security key, not as this device", async () => {
    stubCredentials({ attachment: "cross-platform", transports: ["usb"] });
    const result = await ceremony.enrollPasskeyCeremony(SALT, [], "another-device");
    expect(result.kind).toBe("security-key");
    expect(result.transports).toEqual(["usb"]);
  });

  it("omits transports entirely when the authenticator reported none", async () => {
    stubCredentials({ attachment: "platform", transports: [] });
    const result = await ceremony.enrollPasskeyCeremony(SALT, []);
    // Absent, not []: an empty array reads as "reachable by nothing", which
    // would make the credential invisible to a later ceremony.
    expect(result).not.toHaveProperty("transports");
  });

  it("excludes the devices already enrolled, each named with its own transports", async () => {
    const api = stubCredentials();
    await ceremony.enrollPasskeyCeremony(
      SALT,
      [
        { id: "AQIDBA", transports: ["internal"] },
        { id: "BQYHCA", transports: ["hybrid"] },
        { id: "CQoLDA" }, // enrolled before transports were recorded
      ],
      "another-device",
    );
    const exclude = api.create.mock.calls[0][0].publicKey.excludeCredentials ?? [];
    expect(exclude).toHaveLength(3);
    expect(exclude.map((d) => d.transports)).toEqual([["internal"], ["hybrid"], undefined]);
    // An exclusion the authenticator cannot be reached about is an exclusion
    // that does not happen — which is how a second enrollment on the same
    // device silently shadows the first instead of failing loudly.
    expect(exclude.every((d) => d.type === "public-key")).toBe(true);
    expect(exclude.every((d) => d.id instanceof Uint8Array && d.id.length > 0)).toBe(true);
  });
});

describe("unlocking with any of several devices", () => {
  it("offers every enrolled credential, each with the transports it was enrolled with", async () => {
    const api = stubCredentials();
    await ceremony.unlockPasskeyCeremony(SALT, [
      { id: "AQIDBA", transports: ["internal"] },
      { id: "BQYHCA", transports: ["hybrid"] },
    ]);
    const allow = api.get.mock.calls[0][0].publicKey.allowCredentials ?? [];
    expect(allow).toHaveLength(2);
    // The hybrid hint is what makes Chrome offer "use a phone" rather than
    // looking only for something local and finding nothing.
    expect(allow.map((d) => d.transports)).toEqual([["internal"], ["hybrid"]]);
  });

  it("passes an unhinted credential through unhinted", async () => {
    const api = stubCredentials();
    await ceremony.unlockPasskeyCeremony(SALT, [{ id: "AQIDBA" }]);
    const allow = api.get.mock.calls[0][0].publicKey.allowCredentials ?? [];
    // Slots enrolled before transports were recorded still have to work: no
    // hint means "try every route", which is exactly the shipped behavior.
    expect(allow[0]).not.toHaveProperty("transports");
  });
});

// Chrome allows exactly one outstanding WebAuthn request per profile, and
// refuses a second with `NotAllowedError: A request is already pending.` —
// the SAME DOMException name a user cancellation uses. Apogee treats
// cancellation as a deliberate shrug that shows no message, so before this was
// separated a ceremony left pending by an earlier attempt made every later
// press a silent no-op, and cost a diagnostic round to spot.
describe("the one-request-at-a-time refusal", () => {
  function stubRejectingCreate(err: unknown) {
    const api = {
      create: vi.fn(async () => {
        throw err;
      }),
      get: vi.fn(async () => {
        throw err;
      }),
    };
    vi.stubGlobal("navigator", { credentials: api });
    return api;
  }

  // Both spellings seen in the wild: Chrome raises OperationError for this,
  // other reports have it as NotAllowedError. The matcher keys on the message
  // precisely so the name cannot matter.
  const PENDING = new DOMException("A request is already pending.", "OperationError");
  const PENDING_AS_NOT_ALLOWED = new DOMException(
    "A request is already pending.",
    "NotAllowedError",
  );
  const CANCELLED = new DOMException(
    "The operation either timed out or was not allowed.",
    "NotAllowedError",
  );

  it("is not reported as a cancellation on enrollment", async () => {
    stubRejectingCreate(PENDING);
    await expect(ceremony.enrollPasskeyCeremony(SALT, [])).rejects.toThrow(
      "PASSKEY_REQUEST_PENDING",
    );
  });

  it("is not reported as a cancellation on unlock", async () => {
    stubRejectingCreate(PENDING);
    await expect(ceremony.unlockPasskeyCeremony(SALT, [{ id: "AQIDBA" }])).rejects.toThrow(
      "PASSKEY_REQUEST_PENDING",
    );
  });

  it("is caught under either DOMException name", async () => {
    stubRejectingCreate(PENDING_AS_NOT_ALLOWED);
    await expect(ceremony.enrollPasskeyCeremony(SALT, [])).rejects.toThrow(
      "PASSKEY_REQUEST_PENDING",
    );
  });

  it("still reports a real cancellation as a cancellation", async () => {
    stubRejectingCreate(CANCELLED);
    // Same DOMException name, different meaning: this one IS the user saying no,
    // and must stay silent rather than nagging about a stuck request.
    await expect(ceremony.enrollPasskeyCeremony(SALT, [])).rejects.toThrow("PASSKEY_CANCELLED");
  });
});
