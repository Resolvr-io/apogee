// Lock screen — decrypt the keystore with the password to resume. The "Forgot
// password?" path mirrors MetaMask: we can't recover the password, so recovery
// means re-importing from the recovery phrase (or, failing that, resetting the
// wallet on this device). Both wipe the unusable encrypted vault first.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ChevronLeft, X } from "lucide-react";
import type { UnlockThrottle } from "@/keystore/keystore";
import { Button, ErrorText, Field, Input, Spinner, WelcomeShell } from "@/sidepanel/components/ui";
import {
  UNLOCK_BLOCKED_TEXT,
  errMessage,
  formatCooldown,
  unlockErrMessage,
  wallet,
} from "@/sidepanel/wallet-client";

// Type-to-confirm word for the destructive reset — a deliberate speed bump so a
// wallet can't be wiped with a single click.
const RESET_WORD = "RESET";

export function Unlock({
  onDone,
  onImport,
  onReset,
}: {
  onDone: () => void;
  onImport: () => void;
  onReset: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [forgot, setForgot] = useState<null | "intro" | "reset">(null);
  const [confirmText, setConfirmText] = useState("");

  // Failed-attempt throttle (enforced by the keystore; this is display-only).
  // `now` ticks once a second while a cooldown is live so the countdown renders.
  const [throttle, setThrottle] = useState<UnlockThrottle | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const refreshThrottle = useCallback(async () => {
    try {
      const next = await wallet.getUnlockThrottle();
      // Sync `now` to the instant we read retryAt so the first rendered countdown
      // is correct. Otherwise `now` holds whatever value the 1s interval last set
      // (stale before/between cooldowns, since the interval only runs while one is
      // live), and the timer starts too high then jumps down on the next tick.
      setNow(Date.now());
      setThrottle(next);
    } catch {
      // display-only; the keystore still enforces on submit
    }
  }, []);
  useEffect(() => {
    void refreshThrottle();
  }, [refreshThrottle]);

  const blocked = throttle?.blocked ?? false;
  const coolingDown = !blocked && throttle?.retryAt != null && throttle.retryAt > now;
  useEffect(() => {
    if (!coolingDown) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [coolingDown]);
  // When the countdown lapses, re-read the authoritative state (re-enables the form).
  useEffect(() => {
    if (throttle?.retryAt != null && throttle.retryAt <= now) void refreshThrottle();
  }, [throttle, now, refreshThrottle]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await wallet.unlock(password);
      onDone();
    } catch (err) {
      setError(unlockErrMessage(err));
      setPassword("");
      // A failure may have started (or extended) a cooldown — re-read it.
      void refreshThrottle();
    } finally {
      setBusy(false);
    }
  }

  // Intentional reset: this is the only place that destroys the vault directly.
  // (Import defers the wipe until a valid phrase is actually submitted.)
  async function doReset() {
    setBusy(true);
    try {
      await wallet.reset();
      onReset();
    } catch (err) {
      setError(errMessage(err));
      setForgot(null);
      setConfirmText("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <WelcomeShell subtitle="Enter your password to unlock.">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Password">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            disabled={blocked || coolingDown}
          />
        </Field>
        {blocked ? (
          <ErrorText>{UNLOCK_BLOCKED_TEXT}</ErrorText>
        ) : coolingDown ? (
          // Live countdown supersedes the static error from the last attempt.
          <ErrorText>
            {`Too many failed attempts. Try again in ${formatCooldown((throttle?.retryAt ?? 0) - now)}.`}
          </ErrorText>
        ) : (
          <>
            <ErrorText>{error}</ErrorText>
            {throttle?.warning && throttle.remainingBeforeBlock > 0 && (
              <p className="rounded-lg border border-[color:var(--warning-border)] bg-[color:var(--warning-bg)] px-3 py-2 text-xs text-[color:var(--warning-text)]">
                {throttle.remainingBeforeBlock === 1
                  ? "1 attempt left"
                  : `${throttle.remainingBeforeBlock} attempts left`}{" "}
                before Apogee requires your recovery phrase.
              </p>
            )}
          </>
        )}
        <Button type="submit" disabled={busy || !password || blocked || coolingDown}>
          {busy ? <Spinner /> : "Unlock"}
        </Button>
        <button
          type="button"
          onClick={() => setForgot("intro")}
          className="mx-auto mt-1 text-xs font-medium text-[color:var(--accent)] hover:underline"
        >
          Forgot your password?
        </button>
      </form>

      {forgot && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-[color:var(--overlay)] p-5">
          {forgot === "intro" ? (
            <div className="w-full max-w-sm rounded-2xl border border-[color:var(--border-default)] bg-[color:var(--surface-modal)] p-5 shadow-[0_20px_60px_var(--shadow-strong)]">
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-base font-semibold text-[color:var(--text-strong)]">
                  Forgot your password?
                </h2>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => setForgot(null)}
                  className="icon-btn size-7 shrink-0"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="mt-3 flex flex-col gap-2.5 text-sm text-[color:var(--text-secondary)]">
                <p>We can&rsquo;t recover your password for you.</p>
                <p>
                  Add your wallet back to Apogee by entering the recovery phrase associated with it.
                </p>
              </div>
              <div className="mt-5 flex flex-col gap-2">
                <Button onClick={onImport} disabled={busy}>
                  Import wallet
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setConfirmText("");
                    setForgot("reset");
                  }}
                  disabled={busy}
                >
                  I don&rsquo;t know my phrase
                </Button>
              </div>
            </div>
          ) : (
            <div className="w-full max-w-sm rounded-2xl border border-[color:var(--border-default)] bg-[color:var(--surface-modal)] p-5 shadow-[0_20px_60px_var(--shadow-strong)]">
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  aria-label="Back"
                  onClick={() => {
                    setConfirmText("");
                    setForgot("intro");
                  }}
                  className="icon-btn size-7"
                >
                  <ChevronLeft size={18} />
                </button>
                <span className="flex size-9 items-center justify-center rounded-full bg-[color:var(--danger-bg)] text-[color:var(--danger-text)]">
                  <AlertTriangle size={18} />
                </span>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => {
                    setConfirmText("");
                    setForgot(null);
                  }}
                  className="icon-btn size-7"
                >
                  <X size={16} />
                </button>
              </div>
              <h2 className="mt-3 text-center text-base font-semibold text-[color:var(--text-strong)]">
                Don&rsquo;t have your recovery phrase?
              </h2>
              <div className="mt-3 flex flex-col gap-2.5 text-sm text-[color:var(--text-secondary)]">
                <p>
                  We can&rsquo;t recover your recovery phrase. Resetting will{" "}
                  <strong className="font-semibold text-[color:var(--text-strong)]">
                    permanently delete
                  </strong>{" "}
                  this wallet&rsquo;s data on this device.
                </p>
                <p>
                  It will{" "}
                  <strong className="font-semibold text-[color:var(--text-strong)]">not</strong>{" "}
                  affect the funds on-chain. They stay recoverable from your recovery phrase.
                </p>
              </div>
              <div className="mt-4">
                <Field label={`Type ${RESET_WORD} to confirm`}>
                  <Input
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    placeholder={RESET_WORD}
                    autoFocus
                    autoCapitalize="characters"
                    spellCheck={false}
                  />
                </Field>
              </div>
              <Button
                variant="danger"
                className="mt-4 w-full"
                onClick={doReset}
                disabled={busy || confirmText.trim().toUpperCase() !== RESET_WORD}
              >
                {busy ? <Spinner /> : "Yes, reset wallet"}
              </Button>
            </div>
          )}
        </div>
      )}
    </WelcomeShell>
  );
}
