// Shared approval UI for dapp actions. `connect` authorizes a site (it then sees
// the watch-only account); `send` reviews a built spend before signing. Rendered
// as an overlay inside the side panel when it's open, and by the standalone
// prompt popup when it isn't. Reject (or closing the popup) fails the request.

import { useState } from "react";
import type { ApprovalRequest } from "@/engine/protocol";
import { formatSats } from "@/lib/format";
import { shortenHex } from "@/lib/utils";
import { Button, Card, ErrorText, Field, Input, Spinner } from "@/sidepanel/components/ui";
import { errMessage, unlockErrMessage, wallet } from "@/sidepanel/wallet-client";

function decide(id: string, approved: boolean): Promise<{ ok: boolean; error?: string }> {
  return chrome.runtime.sendMessage({ type: "apogee/approval-decision", id, approved });
}

/** Human-friendly network label for the approval UI. */
function networkLabel(n: "mainnet" | "testnet" | "regtest"): string {
  return n === "mainnet" ? "Liquid" : n === "testnet" ? "Liquid Testnet" : "Regtest";
}

export function Approval({ request, onClose }: { request: ApprovalRequest; onClose: () => void }) {
  const isConnect = request.kind === "connect";
  // A Jade send is signed on the device (in a tab) after approval, not here.
  const jade = request.kind === "send" && request.signerKind === "jade";
  // Only a `send` can require an unlock; connect just authorizes the site.
  const [locked, setLocked] = useState(request.kind === "send" ? request.locked : false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
      const res = await decide(request.id, true);
      if (!res?.ok) {
        throw new Error(res?.error ?? (isConnect ? "Couldn't connect." : "The transaction failed."));
      }
      onClose();
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

  return (
    <Card>
      <div className="mb-3 text-center">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--text-overline)]">
          {isConnect ? "Connect" : "Approve transaction"}
        </h2>
        <p className="mt-1 truncate text-xs text-[color:var(--text-subtle)]" title={request.origin}>
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
          <Button onClick={approve} disabled={busy}>
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
