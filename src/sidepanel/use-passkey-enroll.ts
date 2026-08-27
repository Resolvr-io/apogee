// One enroll flow, two entries: the Settings management card and the one-time
// discoverability offer on the wallet home. The ceremony runs here, the DEK
// never leaves the service worker — only the raw PRF bytes travel, base64, on
// the same runtime channel the password already uses.

import { useCallback, useEffect, useRef, useState } from "react";
import { bytesToBase64, randomBytes } from "@/keystore/crypto";
import type { PasskeyInfo } from "@/keystore/keystore";
import {
  PasskeyCancelled,
  PasskeyRequestPending,
  type PasskeyTarget,
  PasskeyUnresponsive,
  describeWebAuthnError,
  enrollPasskeyCeremony,
  passkeyCapable,
  passkeyPreflightBlocker,
  webAuthnAvailable,
} from "@/sidepanel/passkey-ceremony";
import { errMessage, wallet } from "@/sidepanel/wallet-client";

export function usePasskeyEnroll() {
  const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
  // Two capability tiers (docs/passkey-unlock.md §2): `available` gates the
  // Settings entry — any WebAuthn surface at all, so a machine without a
  // platform authenticator can still enroll a security key. `supported` adds
  // a user-verifying PLATFORM authenticator and gates only the offer card,
  // whose copy promises the fingerprint.
  const [available, setAvailable] = useState(false);
  const [supported, setSupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // TEMPORARY device-pass diagnostics: a rendered trace of each enrollment
  // step (Settings card shows it) so a wedged native WebAuthn prompt can be
  // diagnosed without opening DevTools. Strip once enrollment is proven on
  // real hardware.
  const [log, setLog] = useState<string[]>([]);
  // The live ceremony's canceller. A ceremony that never gets a native sheet
  // cannot be dismissed by the user any other way, which is the whole reason
  // this exists rather than relying on the OS dialog's own cancel.
  const aborter = useRef<AbortController | null>(null);
  const t0 = useRef(performance.now());
  const push = useCallback((msg: string) => {
    setLog((prev) => {
      const next = [...prev, `${((performance.now() - t0.current) / 1000).toFixed(1)}s ${msg}`];
      return next.length > 60 ? next.slice(next.length - 60) : next;
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      setPasskeys(await wallet.listPasskeys());
    } catch {
      /* display-only; the keystore enforces */
    }
  }, []);

  useEffect(() => {
    void refresh();
    void webAuthnAvailable().then(setAvailable);
    void passkeyCapable().then(setSupported);
  }, [refresh]);

  /** `target` picks which authenticators the ceremony will talk to. The
   *  Settings card offers both: the plain entry leaves it to the browser, and
   *  "Another device" pins cross-platform so the phone/QR and security-key
   *  surfaces are reachable even on a machine whose platform authenticator
   *  already holds this vault's passkey (see PasskeyTarget). */
  const enroll = useCallback(async (target: PasskeyTarget = "any"): Promise<boolean> => {
    setBusy(true);
    setError("");
    push(`— attempt started (${target}) —`);
    try {
      // No permission gate: ceremonies send no RP ID, so there is nothing to
      // grant (docs/passkey-unlock.md §4). What IS checked first is whether the
      // client will serve this at all — a managed profile can accept the
      // ceremony and never surface a prompt, and declining up front beats a
      // three-minute spinner (docs/passkey-unlock.md §4, "when the client
      // simply will not").
      const blocker = await passkeyPreflightBlocker();
      push(`preflight: ${blocker ?? "clear"}`);
      if (blocker) {
        setError(blocker);
        return false;
      }
      const challenge = await wallet.passkeyChallenge();
      const existing = challenge?.credentials ?? [];
      push(`challenge: ${existing.length} enrolled, ${challenge ? "vault salt" : "fresh salt"}`);
      // The vault's salt when a passkey already exists; minted here for the
      // first one (nothing stored could have supplied it) and adopted by the
      // keystore, which cross-checks it against any stored salt.
      const prfSalt = challenge?.prfSalt ?? bytesToBase64(randomBytes(32));
      let created = false;
      try {
        aborter.current = new AbortController();
        const { prf, credentialId, kind, transports } = await enrollPasskeyCeremony(
          prfSalt,
          existing,
          target,
          push,
          aborter.current.signal,
        );
        // The moment create() returns, a resident credential exists whether or
        // not anything below succeeds (WebAuthn has no delete).
        created = true;
        push(`ceremony done: ${kind} [${transports?.join(",") || "no transports"}]`);
        await wallet.enrollPasskey(prf, { credentialId, kind, transports }, prfSalt);
        push("keystore enroll ok");
      } catch (err) {
        push(`enroll failed: ${describeWebAuthnError(err)}`);
        // Post-create failures are the awkward class: WebAuthn has no delete,
        // so a credential may now sit resident in the authenticator while the
        // vault never referenced it (an orphan). Say so plainly instead of
        // surfacing "Keystore is locked" or a salt mismatch as if nothing
        // happened (docs/passkey-unlock.md, Security decisions).
        const msg = errMessage(err);
        if (
          created &&
          (msg.includes("Keystore is locked") ||
            msg.includes("PASSKEY_SALT_MISMATCH") ||
            msg.includes("PASSKEY_BAD_PRF"))
        ) {
          setError(
            "Created on your device, but Apogee couldn’t finish enrolling it. You can remove it from your password manager.",
          );
          void refresh();
          return false;
        }
        throw err;
      }
      await refresh();
      push("done");
      return true;
    } catch (err) {
      const msg = errMessage(err);
      if (err instanceof PasskeyUnresponsive) {
        // The ceremony was accepted and never surfaced. Overwhelmingly this is
        // a browser-level restriction rather than anything about the device, so
        // the copy points at the profile and leaves the password untouched.
        setError(
          "Your browser didn’t show a passkey prompt. Passkeys may be restricted here. Your password still works.",
        );
      } else if (err instanceof PasskeyRequestPending) {
        // Not a cancellation, however much it looks like one to the browser:
        // an earlier ceremony is still open and Chrome allows only one.
        setError("Another passkey request is still open. Close and reopen the panel, then try again.");
      } else if (err instanceof PasskeyCancelled) {
        // A cancelled prompt enrolls nothing — a shrug, not an error.
        push("cancelled");
      } else if (msg.includes("InvalidStateError") || msg.includes("already")) {
        // The dead end that made a second device unreachable: this
        // authenticator already holds a passkey for the vault, so
        // excludeCredentials refuses it. Point at the route that goes
        // somewhere instead of just saying no.
        setError(
          target === "another-device"
            ? "That device already has one. Try a different phone or security key."
            : "This device already has one. Use “Another device” for a phone or security key.",
        );
      } else if (msg.includes("PASSKEY_NO_PRF")) {
        setError(
          target === "another-device"
            ? "That device’s passkeys can’t unlock Apogee. Your password is unchanged."
            : "This device’s passkey can’t be used here. Your password is unchanged.",
        );
      } else {
        setError(msg);
      }
      return false;
    } finally {
      aborter.current = null;
      setBusy(false);
    }
  }, [push, refresh]);

  /** Abandon the ceremony in flight. Resolves the spinner immediately and
   *  silently, the way a dismissed OS sheet would if one had appeared. */
  const cancel = useCallback(() => {
    aborter.current?.abort(new DOMException("Canceled", "AbortError"));
  }, []);

  const remove = useCallback(
    async (id: string) => {
      setBusy(true);
      setError("");
      try {
        await wallet.removePasskey(id);
        await refresh();
      } catch (err) {
        setError(errMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return { passkeys, available, supported, busy, error, log, enroll, cancel, remove, refresh };
}
