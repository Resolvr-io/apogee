// WebAuthn ceremonies for passkey unlock (docs/passkey-unlock.md §2–3).
// Browser-only by nature: `navigator.credentials` does not exist in the service
// worker, so these run in the side panel and hand only the RAW PRF BYTES to the
// SW over a runtime message — the same trust domain the password already
// crosses on unlock. (Nothing actively zeroes those bytes: both copies are
// immutable JS strings, unreferenced as soon as the ceremony ends. The
// encoding exists because runtime messages are JSON and a Uint8Array would
// arrive as a plain object and silently derive the wrong key — the router
// decodes and length-checks.)
//
// What these ceremonies are NOT: authentication. There is no server to verify
// an assertion, and presence proves nothing at rest. The one property used is
// the PRF extension — a key-derivation oracle gated behind user verification
// (`userVerification: "required"` everywhere; the biometric IS the security
// property).

import type { PasskeyCredentialRef, PasskeyKind } from "@/keystore/slots";

/**
 * NO RP ID IS EVER SENT. Both ceremonies below omit `rp.id` / `rpId`, so
 * WebAuthn falls back to the caller's origin and every credential is baked to
 * `chrome-extension://<extension id>` — pinned to the published id by the
 * `key` in manifest.config.ts.
 *
 * This is the correction to a design that claimed `resolvr.io` via an optional
 * host permission. On Chrome, an extension claiming a foreign registrable
 * domain is ACCEPTED and then never dispatched from a side panel: no native
 * prompt, no rejection, a promise pending until the timeout. The same claim
 * works from a tab, because Chrome renders its own attribution dialog for a
 * domain that is not the caller's and that dialog needs a tab to anchor to.
 * An own-origin ceremony has no such dialog and runs anywhere.
 *
 * Consequences worth knowing before touching this:
 *   - No host permission is needed, so updates never re-prompt existing users.
 *   - Credentials are bound to the extension id. Change or lose the manifest
 *     `key` and every enrolled passkey orphans, permanently (WebAuthn has no
 *     delete). That is the same permanence the domain had, relocated.
 *   - Firefox is the mirror image — it supports the host-permission domain
 *     claim and NOT the own-origin form (bug 1693562, still open). Apogee is
 *     Chrome-only, so own-origin is unambiguously right here; a Firefox build
 *     would have to reintroduce the domain claim and enroll separately.
 *
 * Full reasoning in docs/passkey-unlock.md §4; pinned by
 * passkey-rp-contract.test.ts.
 */

/** Does the WebAuthn surface exist in this browser at all? The honest gate for
 *  the Settings entry point: anything that could run a ceremony qualifies,
 *  including ones with no platform authenticator — the slot model supports
 *  security keys and cross-device too (docs/passkey-unlock.md §2). Whether the
 *  chosen authenticator can serve PRF is enforced by enrollment itself. */
export async function webAuthnAvailable(): Promise<boolean> {
  if (typeof navigator === "undefined" || !("credentials" in navigator)) return false;
  return typeof window !== "undefined" && "PublicKeyCredential" in window;
}

/** Can THIS device offer the biometric door? Kept separate from
 *  webAuthnAvailable because only the discoverability offer promises "your
 *  fingerprint" — a machine with no platform authenticator still sees Settings
 *  and can enroll a security key. */
export async function passkeyCapable(): Promise<boolean> {
  if (!(await webAuthnAvailable())) return false;
  const pkc = (window as { PublicKeyCredential?: typeof PublicKeyCredential }).PublicKeyCredential;
  if (!pkc?.isUserVerifyingPlatformAuthenticatorAvailable) return false;
  try {
    return await pkc.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/**
 * How long a ceremony may stay open. Two failure modes bound this from both
 * sides, and 60s — the value the RP-ID hunt first introduced — sits on the
 * wrong side of one of them:
 *
 * - Without ANY timeout, a claim the browser accepts but never dispatches UI
 *   for leaves the promise pending forever, which is the spinner-with-no-way-
 *   out that cost a whole debugging session. A bound is mandatory.
 * - Too short a bound breaks the cross-device flow outright. Enrolling a phone
 *   means reading a QR code off the screen, picking the phone up, unlocking
 *   it, opening the camera, scanning, and approving. Sixty seconds is not that
 *   errand; the ceremony would abort while the user was still holding the
 *   phone, and read to them as "my phone doesn't work with this".
 *
 * Three minutes fits the errand and still turns the pathological case into a
 * named exception rather than an eternity. (WebAuthn's own recommended range
 * for a user-verifying ceremony tops out far higher; this is deliberately
 * shorter than that, because the diagnosability matters more here than the
 * last minute of patience.) Pinned by passkey-rp-contract.test.ts.
 */
export const CEREMONY_TIMEOUT_MS = 180_000;

/** Which authenticators a ceremony will talk to, expressed the way the UI
 *  means it rather than the way WebAuthn spells it:
 *
 *  - `"any"` leaves `authenticatorAttachment` unset, so the browser offers
 *    everything it knows — its own picker, which is right for "add a passkey"
 *    when the user has not said where.
 *  - `"another-device"` pins `cross-platform`, which is the ONLY way to make
 *    Chrome go straight to the phone/QR and security-key surfaces. Without it,
 *    a machine with a platform authenticator tends to answer with that
 *    authenticator — and if it already holds this vault's passkey,
 *    excludeCredentials turns the attempt into InvalidStateError and the user
 *    has no route to their second device at all. That dead end is the reason
 *    this parameter exists.
 */
export type PasskeyTarget = "any" | "another-device";

function attachmentFor(target: PasskeyTarget): AuthenticatorAttachment | undefined {
  return target === "another-device" ? "cross-platform" : undefined;
}

/** WebAuthn's descriptor form for one already-known credential. Transports are
 *  passed through when we have them and omitted when we do not: an empty array
 *  is a positive "reachable by nothing" claim, whereas a missing one means
 *  "no hint, try every route" — the difference between a phone being offered
 *  and a phone being invisible. */
function descriptorsFor(refs: PasskeyCredentialRef[]): PublicKeyCredentialDescriptor[] {
  return refs.map((ref) => ({
    id: b64UrlToBytes(b64ToB64Url(ref.id)),
    type: "public-key" as const,
    ...(ref.transports?.length
      ? { transports: ref.transports as AuthenticatorTransport[] }
      : {}),
  }));
}

// ---- base64url (WebAuthn's wire form) ↔ the vault's plain base64 -----------

function b64ToB64Url(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64UrlToB64(u: string): string {
  const padded = u.replace(/-/g, "+").replace(/_/g, "/");
  return padded + "=".repeat((4 - (padded.length % 4)) % 4);
}

function bytesToB64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64UrlToBytes(u: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64UrlToB64(u));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The `kind` label, captured at enrollment — it can never be fetched
 *  retroactively. From `authenticatorAttachment` (which outranks the transports
 *  hint — hybrid covers phones AND passkeys synced through a platform store),
 *  with transports as the tiebreaker ONLY between cross-platform things: a
 *  security key speaks usb/nfc/ble, a phone summoned by cross-device flow
 *  reports hybrid. */
function kindOf(
  attachment: AuthenticatorAttachment | undefined,
  transports: AuthenticatorTransport[] | undefined,
): PasskeyKind {
  if (attachment === "platform") return "device";
  if (transports?.includes("hybrid")) return "cross-device";
  return "security-key";
}

function prfResults(ext: AuthenticationExtensionsClientOutputs): Uint8Array<ArrayBuffer> | undefined {
  const first = (ext as { prf?: { results?: { first?: ArrayBuffer } } }).prf?.results?.first;
  return first ? new Uint8Array(first) : undefined;
}

/** A cancelled prompt is a shrug, not a failure — distinct from "the
 *  authenticator produced no PRF" (the caller reports that separately). */
export class PasskeyCancelled extends Error {
  constructor() {
    super("PASSKEY_CANCELLED");
  }
}

/** Chrome permits exactly ONE outstanding WebAuthn request at a time. A second
 *  one is refused with "A request is already pending." — observed on Chrome as
 *  an `OperationError`, and reported elsewhere as a `NotAllowedError`, which is
 *  exactly why this matches on MESSAGE and not on name. Getting it wrong is
 *  expensive in a specific way: as a `NotAllowedError` it is indistinguishable
 *  from a user cancellation, Apogee treats cancellation as a deliberate shrug
 *  that shows no message, and so a ceremony left pending by an earlier attempt
 *  turns every later press into a silent no-op — which reads as a hang while
 *  the first one is still spinning. */
export class PasskeyRequestPending extends Error {
  constructor() {
    super("PASSKEY_REQUEST_PENDING");
  }
}

/** Is this the one-request-at-a-time refusal rather than a cancellation? */
function isRequestPending(err: unknown): boolean {
  return err instanceof DOMException && /already pending|request is pending/i.test(err.message);
}

/**
 * Enroll: create a passkey and evaluate the PRF against the vault salt in the
 * same ceremony where possible. Some browsers report PRF supported but decline
 * to evaluate during create(); the recovery shape is a follow-up get() against
 * the credential just made — NOT treating the device as unsupported. Nothing
 * here persists anything; the caller only proceeds to the SW's enroll message
 * when PRF bytes came out.
 */
export async function enrollPasskeyCeremony(
  prfSalt: string,
  /** Already-enrolled credentials, excluded from this ceremony so a second
   *  enrollment on an authenticator that already holds one fails loudly
   *  (InvalidStateError) instead of shadowing the first. Their transports ride
   *  along so the exclusion reaches the authenticator it is about. */
  existing: PasskeyCredentialRef[],
  /** Where this passkey should be created. `"another-device"` is what makes
   *  the phone/QR and security-key surfaces reachable at all; see
   *  PasskeyTarget. */
  target: PasskeyTarget = "any",
  /** Optional step-by-step reporter — TEMPORARY device-pass diagnostics;
   *  the Settings card renders the lines until we know why the native
   *  prompt never appears outside automation. */
  trace?: (msg: string) => void,
): Promise<{
  prf: Uint8Array<ArrayBuffer>;
  credentialId: string;
  kind: PasskeyKind;
  transports?: string[];
}> {
  const t0 = performance.now();
  const say = (msg: string) => trace?.(`${msg} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);

  const salt = b64ToB64Url(prfSalt);
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  // A fresh random user.id per enrollment: authenticators key resident storage
  // on (rpId, user.id) and REPLACE on collision, so reusing a handle would
  // make enrolling a second passkey silently destroy the first.
  const userId = crypto.getRandomValues(new Uint8Array(16));
  let result: PublicKeyCredential;
  try {
    say("credentials.create() called");
    result = (await navigator.credentials.create({
      publicKey: {
        // No `id`: see the RP ID note above. WebAuthn defaults it to the
        // caller's origin, which is what makes this work in a side panel.
        rp: { name: "Apogee" },
        user: { id: userId, name: "Apogee wallet", displayName: "Apogee wallet" },
        challenge,
        // No bound here is an INFINITE pending promise in the exact cases this
        // UI has no other way out of (a claim the browser never dispatches UI
        // for) — and too tight a bound aborts a phone mid-scan. See
        // CEREMONY_TIMEOUT_MS for both sides of that.
        timeout: CEREMONY_TIMEOUT_MS,
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        // Exclude already-enrolled credentials so a second enrollment on the
        // same authenticator fails loudly instead of shadowing the first.
        excludeCredentials: descriptorsFor(existing),
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
          // Omitted for "any" — an absent key and an undefined one are the
          // same to the browser, but spelling it conditionally keeps the
          // "let the browser offer everything" case free of a field that
          // would narrow it.
          ...(attachmentFor(target) ? { authenticatorAttachment: attachmentFor(target) } : {}),
        },
        extensions: {
          prf: { eval: { first: b64UrlToBytes(salt) } },
        },
      },
    })) as PublicKeyCredential;
    say("credentials.create() resolved");
  } catch (err) {
    say(`credentials.create() threw ${describeWebAuthnError(err)}`);
    // Order matters: "already pending" arrives AS a NotAllowedError, so the
    // cancellation branch below would swallow it into silence.
    if (isRequestPending(err)) throw new PasskeyRequestPending();
    if (err instanceof DOMException && err.name === "NotAllowedError") throw new PasskeyCancelled();
    throw err;
  }

  const response = result.response as AuthenticatorAttestationResponse;
  say(
    `created ${result.authenticatorAttachment ?? "?"} transports=${
      response.getTransports?.().join(",") || "?"
    }`,
  );
  let prf = prfResults(result.getClientExtensionResults());
  if (!prf) {
    // Supported-but-not-evaluated-during-create: evaluate now, against the
    // credential this ceremony just made.
    say("no PRF at create — following up with get()");
    prf = await evaluatePrf(
      salt,
      [{ id: new Uint8Array(result.rawId), type: "public-key" }],
      (m) => say(`[follow-up] ${m}`),
    );
  } else {
    say("PRF evaluated during create");
  }
  const transports = response.getTransports?.() ?? [];
  const kind = kindOf(
    (result.authenticatorAttachment ?? undefined) as AuthenticatorAttachment | undefined,
    transports as AuthenticatorTransport[],
  );
  return {
    prf,
    credentialId: bytesToB64Url(new Uint8Array(result.rawId)),
    kind,
    // Recorded now or never: getTransports() answers only for the response of
    // the ceremony that made the credential, and a later get() cannot be asked
    // where the thing it just talked to lives.
    ...(transports.length ? { transports } : {}),
  };
}

export function describeWebAuthnError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** Unlock: evaluate the vault salt against the enrolled credentials — one
 *  prompt offers every one of them (they share the salt, so whichever the user
 *  picks, the bytes may open its slot), each named with the transports it was
 *  enrolled with so a phone shows up as a phone rather than as nothing. */
export async function unlockPasskeyCeremony(
  prfSalt: string,
  credentials: PasskeyCredentialRef[],
): Promise<Uint8Array<ArrayBuffer>> {
  return evaluatePrf(b64ToB64Url(prfSalt), descriptorsFor(credentials));
}

async function evaluatePrf(
  b64UrlSalt: string,
  allow: PublicKeyCredentialDescriptor[],
  trace?: (msg: string) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  const t0 = performance.now();
  const say = (msg: string) => trace?.(`${msg} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  let result: PublicKeyCredential;
  try {
    say("credentials.get() called");
    result = (await navigator.credentials.get({
      publicKey: {
        // No `rpId`, matching create() — see the RP ID note above.
        challenge,
        allowCredentials: allow,
        // See the matching comment in enrollPasskeyCeremony: absent means
        // pending forever on whatever refuses the ceremony silently, and too
        // short cuts off a phone that is being fetched from another room.
        timeout: CEREMONY_TIMEOUT_MS,
        userVerification: "required",
        extensions: {
          prf: { eval: { first: b64UrlToBytes(b64UrlSalt) } },
        },
      },
    })) as PublicKeyCredential;
    say("credentials.get() resolved");
  } catch (err) {
    say(`credentials.get() threw ${describeWebAuthnError(err)}`);
    if (isRequestPending(err)) throw new PasskeyRequestPending();
    if (err instanceof DOMException && err.name === "NotAllowedError") throw new PasskeyCancelled();
    throw err;
  }
  const prf = prfResults(result.getClientExtensionResults());
  if (!prf) throw new Error("PASSKEY_NO_PRF"); // supported, but this credential/store won't evaluate
  return prf;
}
