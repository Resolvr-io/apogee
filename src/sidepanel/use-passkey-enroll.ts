// One enroll flow, two entries: the Settings management card and the one-time
// discoverability offer on the wallet home. The ceremony runs here, the DEK
// never leaves the service worker — only the raw PRF bytes travel, base64, on
// the same runtime channel the password already uses.

import { useCallback, useEffect, useState } from "react";
import { bytesToBase64, randomBytes } from "@/keystore/crypto";
import type { PasskeyInfo } from "@/keystore/keystore";
import {
  PasskeyCancelled,
  enrollPasskeyCeremony,
  passkeyCapable,
} from "@/sidepanel/passkey-ceremony";
import { errMessage } from "@/sidepanel/wallet-client";
import { wallet } from "@/sidepanel/wallet-client";

export function usePasskeyEnroll() {
  const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
  const [supported, setSupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setPasskeys(await wallet.listPasskeys());
    } catch {
      /* display-only; the keystore enforces */
    }
  }, []);

  useEffect(() => {
    void refresh();
    void passkeyCapable().then(setSupported);
  }, [refresh]);

  const enroll = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    setError("");
    try {
      const challenge = await wallet.passkeyChallenge();
      const existingIds = challenge?.credentialIds ?? [];
      // The vault's salt when a passkey already exists; minted here for the
      // first one (nothing stored could have supplied it) and adopted by the
      // keystore, which cross-checks it against any stored salt.
      const prfSalt = challenge?.prfSalt ?? bytesToBase64(randomBytes(32));
      const { prf, credentialId, kind } = await enrollPasskeyCeremony(prfSalt, existingIds);
      await wallet.enrollPasskey(prf, credentialId, kind, prfSalt);
      await refresh();
      return true;
    } catch (err) {
      const msg = errMessage(err);
      if (err instanceof PasskeyCancelled) {
        // A cancelled prompt enrolls nothing — a shrug, not an error.
      } else if (msg.includes("InvalidStateError") || msg.includes("already")) {
        setError("That passkey is already enrolled. Enroll a different one.");
      } else if (msg.includes("PASSKEY_NO_PRF")) {
        setError("This device’s passkey can’t be used here. Your password is unchanged.");
      } else {
        setError(msg);
      }
      return false;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

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

  return { passkeys, supported, busy, error, enroll, remove, refresh };
}
