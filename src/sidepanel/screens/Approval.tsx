// Shared approval UI for dapp actions. `connect` authorizes a site (it then sees
// the watch-only account); `send` reviews a built spend before signing. Rendered
// as an overlay inside the side panel when it's open, and by the standalone
// prompt popup when it isn't. Reject (or closing the popup) fails the request.

import { useEffect, useState } from "react";
import { AlertTriangle, Check } from "lucide-react";
import type { ApprovalRequest, ManifestReview } from "@/engine/protocol";
import { formatSats } from "@/lib/format";
import { shortenHex } from "@/lib/utils";
import { Button, Card, ErrorText, Field, Input, Spinner } from "@/sidepanel/components/ui";
import { errMessage, unlockErrMessage, wallet } from "@/sidepanel/wallet-client";
import { browser } from "@/lib/ext";

// Sputnik-style connection glyph for the connect success state: a satellite
// emblem, thickened with a matching currentColor stroke and tilted so it reads
// as "in orbit" — a nod to Apogee's celestial theme. The native glyph nearly
// fills its 88.9 viewBox, so the box is padded to the glyph's max radius (else
// tilting clips the antenna at the viewport edge) and the rendered size is
// scaled up by the same factor so the visible ink still matches `size`. TILT
// and THICKEN are the tuning knobs; both inherit the badge's accent color.
const SPUTNIK_TILT = 30; // degrees clockwise, about the glyph's center
const SPUTNIK_THICKEN = 4; // stroke width in viewBox units
const SPUTNIK_PAD = 129 / 88.92; // padded viewBox (129) ÷ native (88.92)
function Sputnik({ size = 30 }: { size?: number }) {
  const box = size * SPUTNIK_PAD;
  return (
    <svg
      width={box}
      height={box}
      viewBox="-20 -20 129 129"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth={SPUTNIK_THICKEN}
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path
        transform={`rotate(${SPUTNIK_TILT} 44.46 44.445)`}
        d="M88.84,86.11l-13.22-57.25C74.26,12.78,60.98-.03,44.48,0,27.98,0,14.7,12.81,13.33,28.86L.06,86.11c-.28,1.22.47,2.42,1.7,2.72,1.2.28,2.45-.47,2.72-1.7l10.58-45.67c4.03,11.47,14.56,19.89,27.17,20.81v24.36c0,1.25,1,2.25,2.25,2.25s2.25-1,2.25-2.25v-24.36c12.61-.92,23.14-9.3,27.17-20.78l10.56,45.64c.28,1.22,1.53,1.97,2.72,1.7,1.22-.28,1.97-1.5,1.7-2.72h-.03ZM46.73,57.75v-17.44c0-1.25-1-2.25-2.25-2.25s-2.25,1-2.25,2.25v17.44c-13.64-1.17-24.42-12.61-24.42-26.56,0-14.69,11.97-26.67,26.67-26.67s26.67,11.97,26.67,26.67-10.75,25.42-24.42,26.56Z"
      />
    </svg>
  );
}

function decide(
  id: string,
  approved: boolean,
  password?: string,
): Promise<{ ok: boolean; error?: string }> {
  return browser.runtime.sendMessage({ type: "apogee/approval-decision", id, approved, password });
}

/** Human-friendly network label for the approval UI. */
function networkLabel(n: "mainnet" | "testnet" | "regtest"): string {
  return n === "mainnet" ? "Liquid" : n === "testnet" ? "Liquid Testnet" : "Regtest";
}

export function Approval({ request, onClose }: { request: ApprovalRequest; onClose: () => void }) {
  const isConnect = request.kind === "connect";
  // A Jade send is signed on the device (in a tab) after approval, not here.
  const jade = request.kind === "send" && request.signerKind === "jade";
  // Connect just authorizes the site; anything that signs can require an unlock.
  const [locked, setLocked] = useState(request.kind === "connect" ? false : request.locked);
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
    void wallet.getAutoLock().then(setAutoLock).catch(() => { });
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
    const connected = done === "connected";
    const label = connected ? "Connected" : done === "sent" ? "Sent" : "Approved";
    // Connect success uses a blue Sputnik glyph (vs the green check for sends),
    // so the two outcomes read differently at a glance — and it nods to Apogee's
    // orbital/telemetry theme.
    return (
      <Card>
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <span
            className={`apogee-pop flex size-14 items-center justify-center rounded-full ${connected
              ? "bg-[color:var(--accent-soft)] text-[color:var(--accent-strong)]"
              : "bg-[color:var(--success-bg)] text-[color:var(--success-text)]"
              }`}
          >
            {connected ? <Sputnik size={30} /> : <Check size={30} strokeWidth={2.5} />}
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
        <h2 className="console-overline">
          {request.kind === "connect"
            ? "Connect"
            : request.kind === "manifest"
              ? request.review.action
              : "Approve transaction"}
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
            <Row label="Wallet" value={request.fingerprint.toUpperCase()} console />
            <Row label="Network" value={networkLabel(request.network)} />
          </dl>
        </>
      ) : request.kind === "manifest" ? (
        <ManifestReviewView review={request.review} network={request.network} />
      ) : (
        <>
          <dl className="flex flex-col gap-1.5 rounded-xl border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] p-3 text-sm">
            <Row label="To" value={shortenHex(request.address, 10, 8)} mono />
            <Row label="Network" value={networkLabel(request.network)} />
            <Row
              label={request.drain ? "Amount (max)" : "Amount"}
              value={`${formatSats(request.recipientSats)} sats`}
              console
            />
            <Row label="Network fee" value={`${formatSats(request.fee)} sats`} console />
            <Row label="Total" value={`${formatSats(request.recipientSats + request.fee)} sats`} strong console />
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
            {busy ? (
              <Spinner />
            ) : isConnect ? (
              "Connect"
            ) : jade ? (
              "Approve & sign on Jade"
            ) : request.kind === "manifest" ? (
              "Approve & sign"
            ) : (
              "Approve & send"
            )}
          </Button>
          <Button variant="secondary" onClick={reject} disabled={busy}>
            Reject
          </Button>
        </div>
      )}
    </Card>
  );
}

/**
 * Manifest review, modelled on the reference wallet's three screens:
 * Intent (what the site says) → Net effect (what the PSET actually does) →
 * Detail (every leg).
 *
 * The two halves have very different trust and are deliberately styled apart:
 *
 *  - Intent and leg labels are prose the SITE wrote. They are not Apogee's
 *    finding and are attributed to the origin, because nothing verifies them.
 *  - The net effect comes from the built PSET's own wallet delta, so it is
 *    authoritative about the immediate move — and silent about what the
 *    covenant does later, which is exactly what the derived-address check
 *    ("Address verified by Apogee") covers instead.
 *
 * Neither control substitutes for the other: a hostile lookalike contract and
 * the real one can produce an identical net effect.
 */
function ManifestReviewView({
  review,
  network,
}: {
  review: ManifestReview;
  network: "mainnet" | "testnet" | "regtest";
}) {
  const net = Object.entries(review.net).filter(([, v]) => v !== 0);
  return (
    <div className="flex flex-col gap-3">
      {review.trust === "unverified" && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-[color:var(--danger-border)] bg-[color:var(--danger-bg)] p-3 text-xs leading-relaxed text-[color:var(--danger-text)]"
        >
          <AlertTriangle className="mt-px size-4 shrink-0" />
          <span>
            <span className="font-semibold text-[color:var(--danger-strong)]">
              High risk — unverified contract.
            </span>{" "}
            Apogee can't verify who published this contract. Only continue if you trust the site.
          </span>
        </div>
      )}

      {(review.intent || review.description) && (
        <div>
          <p className="text-sm text-[color:var(--text-secondary)]">
            {review.intent || review.description}
          </p>
          <p className="mt-1 text-[11px] text-[color:var(--text-subtle)]">
            Described by {review.protocol} — not checked by Apogee.
          </p>
        </div>
      )}

      <dl className="flex flex-col gap-1.5 rounded-xl border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] p-3 text-sm">
        <Row label="Network" value={networkLabel(network)} />
        {net.length === 0 ? (
          <Row label="Net effect" value="No change to your balance" />
        ) : (
          net.map(([asset, value]) => {
            const assetLabel =
              asset === review.policyAssetHex ? "L-BTC" : shortenHex(asset, 6, 6);
            return (
              <Row
                key={asset}
                label={value < 0 ? "Leaves your wallet" : "Enters your wallet"}
                value={`${formatSats(Math.abs(value))} sats ${assetLabel}`}
                strong
              />
            );
          })
        )}
        {/* The net delta above is the wallet's own balance change, which ALREADY
            has the fee in it — so for an ordinary spend "of which network fee"
            reads correctly: the fee is part of the L-BTC that left.

            But the fee is paid in L-BTC, and a transaction can ALSO bring L-BTC
            in (e.g. an offer's proceeds). That inflow nets against the fee, so
            the L-BTC shown as leaving can be SMALLER than the fee. "of which"
            would then claim a subset that isn't one (fee > amount leaving). Only
            keep that wording when the L-BTC leaving genuinely contains the fee. */}
        {(() => {
          const policyNet = review.net[review.policyAssetHex] ?? 0;
          const feeInsideNet = policyNet < 0 && Math.abs(policyNet) >= review.fee;
          return (
            <>
              <Row
                label={feeInsideNet ? "of which network fee" : "Network fee (L-BTC)"}
                value={`${formatSats(review.fee)} sats`}
              />
              {!feeInsideNet && (
                <p className="text-[11px] text-[color:var(--text-subtle)]">
                  The fee is paid in L-BTC. This transaction also brings L-BTC in, so the
                  net L-BTC above already has the fee taken out.
                </p>
              )}
            </>
          );
        })()}
      </dl>

      {review.txInputs.length + review.txOutputs.length > 0 && (
        <details className="rounded-xl border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] p-3">
          <summary className="cursor-pointer text-xs text-[color:var(--text-subtle)]">
            Details ({review.txInputs.length} in · {review.txOutputs.length} out)
          </summary>
          {/* The whole transaction, not just the contract's legs: the wallet's own
              funding inputs, change, and the fee are listed alongside the covenant
              legs (which carry the site's prose and a verified badge). Wallet legs
              are blinded, so they show as "confidential" — expected, not an error;
              the authoritative totals are in the Net effect box above. */}
          {(
            [
              ["Inputs", review.txInputs],
              ["Outputs", review.txOutputs],
            ] as const
          ).map(([heading, legs]) =>
            legs.length === 0 ? null : (
              <section key={heading} className="mt-3 first:mt-2">
                <p className="console-overline mb-1.5 text-[color:var(--text-subtle)]">
                  {heading} ({legs.length})
                </p>
                <dl className="flex flex-col gap-3 text-sm">
                  {legs.map((leg, i) => (
                    <LegItem key={`${heading}-${i}`} leg={leg} policyAssetHex={review.policyAssetHex} />
                  ))}
                </dl>
              </section>
            ),
          )}
        </details>
      )}
    </div>
  );
}

const LEG_ROLE_TEXT: Record<ManifestReview["txInputs"][number]["role"], string> = {
  contract: "Contract leg",
  wallet: "Your wallet",
  fee: "Network fee",
  external: "External output",
};

/** One input or output of the built transaction. The amount + asset lead on their
 *  own line (a long site-written prose label can't share a horizontal row without
 *  truncating the amount). Blinded wallet legs have no readable amount, so they
 *  read "Confidential" rather than a number. */
function LegItem({ leg, policyAssetHex }: { leg: ManifestReview["txInputs"][number]; policyAssetHex: string }) {
  const assetLabel =
    leg.asset === null ? "" : leg.asset === policyAssetHex ? "L-BTC" : shortenHex(leg.asset, 6, 6);
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] uppercase tracking-wide text-[color:var(--text-subtle)]">
          {LEG_ROLE_TEXT[leg.role]}
        </span>
        <span className="shrink-0 font-semibold text-[color:var(--text-strong)]">
          {leg.amountSat === null ? "Confidential" : `${formatSats(leg.amountSat)} sats ${assetLabel}`}
        </span>
      </div>
      {leg.label && (
        <p className="text-xs leading-relaxed text-[color:var(--text-secondary)]">{leg.label}</p>
      )}
      {leg.ref && (
        <p className="truncate font-mono text-[11px] text-[color:var(--text-subtle)]" title={leg.ref}>
          {leg.ref.length > 24 ? shortenHex(leg.ref, 10, 8) : leg.ref}
        </p>
      )}
      {leg.verified && (
        // The load-bearing line: this covenant address was recomputed from the
        // contract's own source, not accepted from the site.
        <p className="text-[11px] text-[color:var(--text-secondary)]">Address verified by Apogee</p>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  strong,
  console: consoleValue,
}: {
  label: string;
  value: string;
  mono?: boolean;
  strong?: boolean;
  console?: boolean; // telemetry-face readout (sats amounts)
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[color:var(--text-subtle)]">{label}</dt>
      <dd
        className={[
          "truncate",
          mono ? "font-mono" : "",
          consoleValue ? "console-value" : "",
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
