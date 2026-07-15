// Shared approval UI for dapp actions. `connect` authorizes a site (it then sees
// the watch-only account); `send` reviews a built spend before signing. Rendered
// as an overlay inside the side panel when it's open, and by the standalone
// prompt popup when it isn't. Reject (or closing the popup) fails the request.

import { useEffect, useState } from "react";
import { Check, Plug } from "lucide-react";
import type { ApprovalRequest } from "@/engine/protocol";
import { formatSats } from "@/lib/format";
import { shortenHex } from "@/lib/utils";
import { Button, Card, ErrorText, Field, Input, Spinner } from "@/sidepanel/components/ui";
import { errMessage, unlockErrMessage, wallet } from "@/sidepanel/wallet-client";

function decide(
  id: string,
  approved: boolean,
  password?: string,
): Promise<{ ok: boolean; error?: string }> {
  return chrome.runtime.sendMessage({ type: "apogee/approval-decision", id, approved, password });
}

/** Human-friendly network label for the approval UI. */
function networkLabel(n: "mainnet" | "testnet" | "regtest"): string {
  return n === "mainnet" ? "Liquid" : n === "testnet" ? "Liquid Testnet" : "Regtest";
}

export function Approval({ request, onClose }: { request: ApprovalRequest; onClose: () => void }) {
  const isConnect = request.kind === "connect";
  // A Jade send is signed on the device (in a tab) after approval, not here.
  const jade = request.kind === "send" && request.signerKind === "jade";
  // A locked wallet must be unlocked before connecting or sending — the SW
  // rejects a connect/send decision while locked, so gate it behind this form.
  const [locked, setLocked] = useState(Boolean(request.locked));
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Brief confirmation (checkmark) shown after a successful decision, before the
  // overlay closes. Kind-aware: connect → Connected, local send → Sent, Jade →
  // Approved (on-device signing continues after this step).
  const [done, setDone] = useState<"" | "connected" | "sent" | "approved">("");
  const [autoLock, setAutoLock] = useState(15);
  const [sendPassword, setSendPassword] = useState("");
  // Auto-lock "never" steps up auth: a local send requires the password.
  const needsSendPassword = !isConnect && !jade && autoLock === 0;

  // Hold the success checkmark for a beat, then dismiss the overlay.
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(onClose, 1200);
    return () => window.clearTimeout(t);
  }, [done, onClose]);

  useEffect(() => {
    void wallet.getAutoLock().then(setAutoLock).catch(() => {});
  }, []);

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await wallet.unlock(password);
      setLocked(false);
    } catch (err) {
      setError(unlockErrMessage(err)); // throttle-aware (cooldown / hard lock)
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    setBusy(true);
    setError("");
    try {
      const res = await decide(request.id, true, needsSendPassword ? sendPassword : undefined);
      if (!res?.ok) {
        throw new Error(res?.error ?? (isConnect ? "Couldn't connect." : "The transaction failed."));
      }
      setDone(isConnect ? "connected" : jade ? "approved" : "sent");
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    try {
      await decide(request.id, false);
    } finally {
      onClose();
    }
  }

  if (done) {
    const isConnect = done === "connected";
    const label = isConnect ? "Connected" : done === "sent" ? "Sent" : "Approved";
    // Connect success uses a blue connection glyph (vs the green check for sends),
    // so the two outcomes read differently at a glance.
    const Icon = isConnect ? Plug : Check;
    return (
      <Card>
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <span
            className={`apogee-pop flex size-14 items-center justify-center rounded-full ${
              isConnect
                ? "bg-[color:var(--accent-soft)] text-[color:var(--accent-strong)]"
                : "bg-[color:var(--success-bg)] text-[color:var(--success-text)]"
            }`}
          >
            <Icon size={30} strokeWidth={2.5} />
          </span>
          <h2 className="text-lg font-semibold text-[color:var(--text-strong)]">{label}</h2>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="mb-4 flex flex-col items-center gap-2 text-center">
        {/* Apogee mark with a soft accent halo, echoing the moonlit scene. */}
        <span className="relative flex size-12 items-center justify-center">
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-full"
            style={{
              background:
                "radial-gradient(circle, color-mix(in srgb, var(--accent) 32%, transparent) 0%, transparent 70%)",
            }}
          />
          <img src="/icons/apogee-icon.svg" alt="" className="relative h-10 w-auto" />
        </span>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--text-overline)]">
          {isConnect ? "Connect" : "Approve transaction"}
        </h2>
        <p className="-mt-1 truncate text-xs text-[color:var(--text-subtle)]" title={request.origin}>
          {request.origin}
        </p>
      </div>

      {request.kind === "connect" ? (
        <>
          <p className="text-sm text-[color:var(--text-secondary)]">
            This site wants to connect to your wallet. It will see your addresses and balance, but
            can't move funds without your approval.
          </p>
          <dl className="mt-3 flex flex-col gap-1.5 rounded-xl border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] p-3 text-sm">
            <Row label="Wallet" value={request.fingerprint} mono />
            <Row label="Network" value={networkLabel(request.network)} />
          </dl>
        </>
      ) : (
        <>
          <dl className="flex flex-col gap-1.5 rounded-xl border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] p-3 text-sm">
            <Row label="To" value={shortenHex(request.address, 10, 8)} mono />
            <Row label="Network" value={networkLabel(request.network)} />
            <Row
              label={request.drain ? "Amount (max)" : "Amount"}
              value={`${formatSats(request.recipientSats)} sats`}
            />
            <Row label="Network fee" value={`${formatSats(request.fee)} sats`} />
            <Row label="Total" value={`${formatSats(request.recipientSats + request.fee)} sats`} strong />
          </dl>
        </>
      )}

      {locked ? (
        <form onSubmit={unlock} className="mt-3 flex flex-col gap-2">
          <Field label="Unlock to approve">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
          </Field>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" disabled={busy || !password}>
            {busy ? <Spinner /> : "Unlock"}
          </Button>
          <Button variant="secondary" onClick={reject} disabled={busy}>
            Reject
          </Button>
        </form>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          <ErrorText>{error}</ErrorText>
          {jade && (
            <p className="text-center text-xs text-[color:var(--text-subtle)]">
              {busy
                ? "Approve the transaction on your Jade in the window that opened…"
                : "You'll sign on your Jade — a window opens after you approve."}
            </p>
          )}
          {needsSendPassword && (
            <Field label="Password (auto-lock is off)">
              <Input
                type="password"
                value={sendPassword}
                onChange={(e) => setSendPassword(e.target.value)}
                autoFocus
              />
            </Field>
          )}
          <Button
            onClick={approve}
            disabled={busy || (needsSendPassword && !sendPassword)}
            className={busy ? undefined : "apogee-cta"}
          >
            {busy ? <Spinner /> : isConnect ? "Connect" : jade ? "Approve & sign on Jade" : "Approve & send"}
          </Button>
          <Button variant="secondary" onClick={reject} disabled={busy}>
            Reject
          </Button>
        </div>
      )}
    </Card>
  );
}

function Row({
  label,
  value,
  mono,
  strong,
}: {
  label: string;
  value: string;
  mono?: boolean;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[color:var(--text-subtle)]">{label}</dt>
      <dd
        className={[
          "truncate",
          mono ? "font-mono" : "",
          strong
            ? "font-semibold text-[color:var(--text-strong)]"
            : "text-[color:var(--text-primary)]",
        ].join(" ")}
      >
        {value}
      </dd>
    </div>
  );
}
