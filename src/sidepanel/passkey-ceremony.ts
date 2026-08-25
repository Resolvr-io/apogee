// WebAuthn ceremonies for passkey unlock (docs/passkey-unlock.md §2–3).
// Browser-only by nature: `navigator.credentials` does not exist in the service
// worker, so these run in the side panel and hand only the RAW PRF BYTES to the
// SW over a runtime message — the same trust domain the password already
// crosses on unlock. Both sides wipe their copy after use; the client encodes
// base64 because runtime messages are JSON and a Uint8Array would arrive as a
// plain object and silently derive the wrong key (the router decodes and
// length-checks).
//
// What these ceremonies are NOT: authentication. There is no server to verify
// an assertion, and presence proves nothing at rest. The one property used is
// the PRF extension — a key-derivation oracle gated behind user verification
// (`userVerification: "required"` everywhere; the biometric IS the security
// property).

import type { PasskeyKind } from "@/keystore/slots";

/** Credentials are scoped to a registrable domain and an extension origin
 *  cannot be one, so the extension claims this first-party RP ID via a host
 *  permission (Chrome 122+). Permanent once shipped — every credential ever
 *  enrolled is baked to it — and deliberately unbundled from any release until
 *  the store-notes pass. */
export const PASSKEY_RP_ID = "apogee.resolvr.io";

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

/** Can a real ceremony even run here? Availability + a user-verifying
 *  authenticator. The harder half of detection — an actual PRF round-trip —
 *  is enforced by enrollment itself: nothing is persisted unless the full
 *  create/evaluate succeeds (see enrollPasskeyCeremony's recovery path). */
export async function passkeyCapable(): Promise<boolean> {
  if (typeof navigator === "undefined" || !("credentials" in navigator)) return false;
  const pkc = (window as { PublicKeyCredential?: typeof PublicKeyCredential }).PublicKeyCredential;
  if (!pkc?.isUserVerifyingPlatformAuthenticatorAvailable) return false;
  try {
    return await pkc.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
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
  existingCredentialIds: string[],
): Promise<{ prf: Uint8Array<ArrayBuffer>; credentialId: string; kind: PasskeyKind }> {
  const salt = b64ToB64Url(prfSalt);
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  // A fresh random user.id per enrollment: authenticators key resident storage
  // on (rpId, user.id) and REPLACE on collision, so reusing a handle would
  // make enrolling a second passkey silently destroy the first.
  const userId = crypto.getRandomValues(new Uint8Array(16));
  let result: PublicKeyCredential;
  try {
    result = (await navigator.credentials.create({
      publicKey: {
        rp: { id: PASSKEY_RP_ID, name: "Apogee" },
        user: { id: userId, name: "Apogee wallet", displayName: "Apogee wallet" },
        challenge,
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        // Exclude already-enrolled credentials so a second enrollment on the
        // same authenticator fails loudly instead of shadowing the first.
        excludeCredentials: existingCredentialIds.map((id) => ({
          id: b64UrlToBytes(b64ToB64Url(id)),
          type: "public-key" as const,
        })),
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
        extensions: {
          prf: { eval: { first: b64UrlToBytes(salt) } },
        },
      },
    })) as PublicKeyCredential;
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotAllowedError") throw new PasskeyCancelled();
    throw err;
  }

  const response = result.response as AuthenticatorAttestationResponse;
  let prf = prfResults(result.getClientExtensionResults());
  if (!prf) {
    // Supported-but-not-evaluated-during-create: evaluate now, against the
    // credential this ceremony just made.
    prf = await evaluatePrf(salt, [new Uint8Array(result.rawId)]);
  }
  const kind = kindOf(
    (result.authenticatorAttachment ?? undefined) as AuthenticatorAttachment | undefined,
    response.getTransports?.() as AuthenticatorTransport[] | undefined,
  );
  return { prf, credentialId: bytesToB64Url(new Uint8Array(result.rawId)), kind };
}

/** Unlock: evaluate the vault salt against the enrolled credentials — one
 *  prompt offers every one of them (they share the salt, so whichever the user
 *  picks, the bytes may open its slot). */
export async function unlockPasskeyCeremony(
  prfSalt: string,
  credentialIds: string[],
): Promise<Uint8Array<ArrayBuffer>> {
  const prf = await evaluatePrf(
    b64ToB64Url(prfSalt),
    credentialIds.map((id) => b64UrlToBytes(b64ToB64Url(id))),
  );
  return prf;
}

async function evaluatePrf(
  b64UrlSalt: string,
  allowIds: Uint8Array<ArrayBuffer>[],
): Promise<Uint8Array<ArrayBuffer>> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  let result: PublicKeyCredential;
  try {
    result = (await navigator.credentials.get({
      publicKey: {
        rpId: PASSKEY_RP_ID,
        challenge,
        allowCredentials: allowIds.map((id) => ({ id, type: "public-key" as const })),
        userVerification: "required",
        extensions: {
          prf: { eval: { first: b64UrlToBytes(b64UrlSalt) } },
        },
      },
    })) as PublicKeyCredential;
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotAllowedError") throw new PasskeyCancelled();
    throw err;
  }
  const prf = prfResults(result.getClientExtensionResults());
  if (!prf) throw new Error("PASSKEY_NO_PRF"); // supported, but this credential/store won't evaluate
  return prf;
}
