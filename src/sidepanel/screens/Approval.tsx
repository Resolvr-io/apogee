// Shared approval UI for dapp actions. `connect` authorizes a site (it then sees
// the watch-only account); `send` reviews a built spend before signing. Rendered
// as an overlay inside the side panel when it's open, and by the standalone
// prompt popup when it isn't. Reject (or closing the popup) fails the request.

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import type { ApprovalRequest } from "@/engine/protocol";
import { formatAssetAmountExact, formatBaseUnits } from "@/lib/format";
import { shortenHex } from "@/lib/utils";
import {
  Button,
  Card,
  ErrorText,
  Field,
  Input,
  Spinner,
  TelemetryNumber,
} from "@/sidepanel/components/ui";
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

/**
 * Side-panel host for the shared approval card. The panel root deliberately
 * clips its ordinary content, so the overlay owns vertical scrolling. `my-auto`
 * centers short approvals while collapsing to zero for a review taller than
 * the viewport, keeping both its first row and final action buttons reachable.
 */
export function ApprovalOverlay({
  request,
  onClose,
}: {
  request: ApprovalRequest;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-40 overflow-y-auto bg-[color:var(--overlay)] p-4"
      data-testid="approval-overlay"
    >
      <div className="flex min-h-full items-start justify-center">
        <div className="my-auto w-full max-w-sm">
          <Approval request={request} onClose={onClose} />
        </div>
      </div>
    </div>
  );
}

export function Approval({ request, onClose }: { request: ApprovalRequest; onClose: () => void }) {
  const isConnect = request.kind === "connect";
  const isPset = request.kind === "signPset";
  const isManifest = request.kind === "executeTxManifest";
  const broadcastsPset = request.kind === "signPset" && request.broadcast;
  const sendReview = request.kind === "send" ? request.review : null;
  const tokenAmount = sendReview?.assetId
    ? `${formatAssetAmountExact(sendReview.recipientAmount, sendReview.assetPrecision ?? null)} ${sendReview.assetTicker ?? shortenHex(sendReview.assetId, 6, 6)}`
    : sendReview
      ? `${formatBaseUnits(sendReview.recipientAmount)} sats`
      : "";
  const lbtcTotal =
    sendReview && !sendReview.assetId
      ? formatBaseUnits(
          (BigInt(sendReview.recipientAmount) + BigInt(sendReview.feeAmount)).toString(),
        )
      : "";
  // Jade actions are signed on the device (in a tab) after approval, not here.
  const jade = request.kind !== "connect" && request.signerKind === "jade";
  // A locked wallet must be unlocked before connecting, sending, or signing —
  // the SW rejects the decision while locked, so gate it behind this form.
  const [locked, setLocked] = useState(Boolean(request.locked));
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Brief confirmation (checkmark) shown after a successful decision, before the
  // overlay closes. Kind-aware: connect → Connected, send → Sent, provider
  // PSET → Signed or Sent according to its approved broadcast flag, and Jade
  // send → Approved while the device flow continues.
  const [done, setDone] = useState<"" | "connected" | "sent" | "approved" | "signed">("");
  const [autoLock, setAutoLock] = useState(15);
  const [sendPassword, setSendPassword] = useState("");
  // Auto-lock "never" steps up auth: any local signing requires the password.
  const needsStepUpPassword = !isConnect && !jade && autoLock === 0;

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
      const res = await decide(request.id, true, needsStepUpPassword ? sendPassword : undefined);
      if (!res?.ok) {
        throw new Error(res?.error ?? (isConnect ? "Couldn't connect." : "The transaction failed."));
      }
      setDone(
        isConnect
          ? "connected"
          : broadcastsPset
            ? "sent"
            : isPset
              ? "signed"
              : jade
                ? "approved"
                : "sent",
      );
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
    const label = connected
      ? "Connected"
      : done === "sent"
        ? "Sent"
        : done === "signed"
          ? "Signed"
          : "Approved";
    // Connect success uses a blue Sputnik glyph (vs the green check for sends),
    // so the two outcomes read differently at a glance — and it nods to Apogee's
    // orbital/telemetry theme.
    return (
      <Card>
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <span
            className={`apogee-pop flex size-14 items-center justify-center rounded-full ${
              connected
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
          {isConnect
            ? "Connect"
            : broadcastsPset
              ? "Sign & broadcast PSET"
              : isPset
                ? "Sign PSET"
                : isManifest
                  ? "Execute contract action"
                  : "Approve transaction"}
        </h2>
        {/* Middle-truncate: clipping the end would hide the registrable
            domain/TLD behind a long subdomain — the part that identifies the
            site. Full origin stays on hover. */}
        <p className="-mt-1 text-xs text-[color:var(--text-subtle)]" title={request.origin}>
          {shortenHex(request.origin, 18, 14)}
        </p>
      </div>

      {request.kind === "connect" ? (
        <>
          <p className="text-sm text-[color:var(--text-secondary)]">
            {request.legacy
              ? "This site wants to connect to your wallet. It will see your addresses and balance, but can't move funds without your approval."
              : "This site is requesting the wallet permissions shown below. Transaction and signing requests still require their own review."}
          </p>
          {!request.legacy && request.methods.includes("getUTXOs") && (
            <p className="mt-2 text-xs leading-relaxed text-[color:var(--warning-text)]">
              UTXO access reveals individual coins, addresses, amounts, and transaction links for
              this account. It does not reveal blinding keys or other wallet secrets.
            </p>
          )}
          {!request.legacy && request.methods.includes("getWalletDescriptor") && (
            <p className="mt-2 text-xs leading-relaxed text-[color:var(--warning-text)]">
              Descriptor access lets this site derive and correlate this account&apos;s scripts and
              unconfidential addresses. It does not reveal private spend keys, blinding keys, or
              the ability to unblind outputs.
            </p>
          )}
          {!request.legacy && request.methods.includes("signPset") && (
            <p className="mt-2 text-xs leading-relaxed text-[color:var(--warning-text)]">
              PSET signing lets this site ask for transaction signatures. Every request still
              shows its exact inputs, recipients, asset changes, and fees for separate approval.
            </p>
          )}
          {!request.legacy && request.methods.includes("experimental_executeTxManifest") && (
            <p className="mt-2 text-xs leading-relaxed text-[color:var(--warning-text)]">
              TX Manifest execution lets this site request supported contract actions. Apogee
              independently builds, verifies, and shows every execution for separate approval
              before signing and broadcasting it.
            </p>
          )}
          <dl className="mt-3 flex flex-col gap-1.5 rounded-xl border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] p-3 text-sm">
            <Row label="Wallet" value={request.fingerprint.toUpperCase()} console />
            <Row label="Network" value={networkLabel(request.network)} />
            {!request.legacy && <Row label="Methods" value={request.methods.join(", ")} mono />}
            {!request.legacy && request.events.length > 0 && (
              <Row label="Events" value={request.events.join(", ")} mono />
            )}
          </dl>
        </>
      ) : request.kind === "signPset" ? (
        <ProviderPsetReview
          review={request.review}
          network={request.network}
          broadcast={request.broadcast}
        />
      ) : request.kind === "executeTxManifest" ? (
        <TxManifestReview review={request.review} network={request.network} />
      ) : (
        <>
          <dl className="flex flex-col gap-1.5 rounded-xl border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] p-3 text-sm">
            {/* Full address, never truncated — the recipient is the one field
                the user must be able to verify against what they were told. */}
            <Row label="To" value={sendReview?.address ?? ""} mono wrap />
            <Row label="Network" value={networkLabel(request.network)} />
            {sendReview?.accountIdentifier && (
              <Row
                label="Account"
                value={shortenHex(sendReview.accountIdentifier, 18, 12)}
                title={sendReview.accountIdentifier}
                mono
              />
            )}
            {sendReview?.assetId && (
              <Row
                label="Asset"
                value={shortenHex(sendReview.assetId, 18, 12)}
                title={sendReview.assetId}
                mono
              />
            )}
            {sendReview?.assetId && sendReview.assetTicker && (
              /* The ticker comes from the public asset registry, which an
                 issued asset can steer — it's a display hint, never proof of
                 what the asset is. The ID above is the identifier. The marker
                 leads and the ticker is clamped because Row truncates: a long
                 hostile ticker must never be able to clip "· registry" off. */
              <Row
                label="Label"
                value={`registry · ${sendReview.assetTicker.slice(0, 24)}`}
                title={`"${sendReview.assetTicker}" comes from the public asset registry and is not verified — identify the asset by its ID above.`}
              />
            )}
            <Row
              label={sendReview?.drain ? "Amount (max)" : "Amount"}
              value={tokenAmount}
              amount
            />
            {sendReview?.assetId && sendReview.assetPrecision != null && (
              <Row
                label="Base units"
                value={formatBaseUnits(sendReview.recipientAmount)}
                mono
              />
            )}
            <Row
              label="Network fee"
              value={`${formatBaseUnits(sendReview?.feeAmount ?? "0")} sats`}
              amount
            />
            {/* Paying one of our own addresses: the amount returns, so the fee is
                the whole cost and a sum of the two would overstate the spend. */}
            {sendReview?.toSelf ? (
              <Row
                label="Net cost"
                value={`${formatBaseUnits(sendReview.feeAmount)} sats`}
                strong
                amount
              />
            ) : sendReview?.assetId ? null : (
              <Row label="Total" value={`${lbtcTotal} sats`} strong amount />
            )}
          </dl>
          {sendReview?.toSelf && (
            <p className="mt-1.5 text-xs text-[color:var(--text-subtle)]">
              This address belongs to this wallet — the amount returns to you.
            </p>
          )}
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
                : isPset
                  ? broadcastsPset
                    ? "You'll sign on your Jade. After validation, Apogee will broadcast the transaction."
                    : "You'll sign on your Jade. The signed PSET returns to the app and is not broadcast."
                  : "You'll sign on your Jade — a window opens after you approve."}
            </p>
          )}
          {needsStepUpPassword && (
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
            disabled={busy || (needsStepUpPassword && !sendPassword)}
            className={busy ? undefined : "apogee-cta"}
          >
            {busy ? (
              <Spinner />
            ) : isConnect ? (
              "Connect"
            ) : isPset ? (
              broadcastsPset
                ? "Approve, sign & broadcast"
                : jade
                  ? "Approve & sign on Jade"
                  : "Approve & sign"
            ) : isManifest ? (
              "Approve & execute"
            ) : jade ? (
              "Approve & sign on Jade"
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

type TxManifestReviewDTO = Extract<
  ApprovalRequest,
  { kind: "executeTxManifest" }
>["review"];

function TxManifestReview({
  review,
  network,
}: {
  review: TxManifestReviewDTO;
  network: "mainnet" | "testnet" | "regtest";
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-[color:var(--text-secondary)]">
        Apogee built this transaction from a trusted contract manifest and current chain state.
        Approval signs and broadcasts it.
      </p>
      <dl className="flex flex-col gap-1.5 rounded-xl border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] p-3 text-sm">
        <Row label="Protocol" value={review.protocolLabel} strong />
        <Row label="Action" value={review.actionLabel} strong />
        <Row label="Network" value={networkLabel(network)} />
        <Row
          label="Account"
          value={review.accountIdentifier}
          title={review.accountIdentifier}
          mono
          wrap
        />
        <Row label="Request" value={review.requestId} title={review.requestId} mono wrap />
      </dl>

      {review.kind === "createFactory" ? (
        <ReviewSection title="Borrower setup">
          <ReviewItem>
            <Row label="Factory asset" value={review.factoryAssetId} title={review.factoryAssetId} mono wrap />
            <Row label="Funding input" value={`${formatBaseUnits(review.fundingAmount)} sats`} amount />
            <Row label="Factory auth NFT" value="1 to this wallet" strong />
          </ReviewItem>
        </ReviewSection>
      ) : review.kind === "acceptOffer" || review.kind === "createOffer" ? (
        <ReviewSection title="Loan terms">
          <ReviewItem>
            <Row
              label="Principal"
              value={`${formatBaseUnits(review.principalAmount)} base units`}
              amount
              strong
            />
            <Row
              label="Principal asset"
              value={review.principalAssetId}
              title={review.principalAssetId}
              mono
              wrap
            />
            <Row
              label="Collateral"
              value={`${formatBaseUnits(review.collateralAmount)} base units`}
              amount
            />
            <Row
              label="Collateral asset"
              value={review.collateralAssetId}
              title={review.collateralAssetId}
              mono
              wrap
            />
            <Row label="Interest" value={`${formatBaseUnits(review.interestRateBasisPoints)} bps`} />
            <Row
              label="Total debt"
              value={`${formatBaseUnits(review.totalDebt)} base units`}
              amount
            />
            <Row label="Expires at height" value={String(review.expirationHeight)} mono />
          </ReviewItem>
        </ReviewSection>
      ) : review.kind === "claimLenderVault" ? (
        <ReviewSection title="Repayment collected">
          <ReviewItem>
            <Row
              label="Net to wallet"
              value={`${formatBaseUnits(review.principalAmount)} base units`}
              amount
              strong
            />
            <Row
              label="Principal asset"
              value={review.principalAssetId}
              title={review.principalAssetId}
              mono
              wrap
            />
            <Row
              label="Gross repayment"
              value={`${formatBaseUnits(review.grossDebt)} base units`}
              amount
            />
            <Row
              label="Interest included"
              value={`${formatBaseUnits(review.interestAmount)} base units`}
              amount
            />
            <Row
              label="Protocol fee"
              value={`${formatBaseUnits(review.protocolFeeAmount)} base units`}
              amount
            />
            <Row
              label="Lender NFT burned"
              value={review.lenderNftAssetId}
              title={review.lenderNftAssetId}
              mono
              wrap
            />
          </ReviewItem>
        </ReviewSection>
      ) : (
        <ReviewSection title={review.kind === "claimPrincipal" ? "Funds claimed" : review.kind === "cancelOffer" ? "Offer cancelled" : review.kind === "repayLoan" ? "Loan repaid" : "Expired loan liquidated"}>
          <ReviewItem>
            <Row label="Principal" value={`${formatBaseUnits(review.principalAmount)} base units`} amount />
            <Row label="Principal asset" value={review.principalAssetId} title={review.principalAssetId} mono wrap />
            <Row label="Collateral" value={`${formatBaseUnits(review.collateralAmount)} base units`} amount strong />
            <Row label="Collateral asset" value={review.collateralAssetId} title={review.collateralAssetId} mono wrap />
            {review.totalDebt !== undefined && <Row label="Total debt" value={`${formatBaseUnits(review.totalDebt)} base units`} amount />}
            {review.protocolFeeAmount !== undefined && <Row label="Protocol fee" value={`${formatBaseUnits(review.protocolFeeAmount)} base units`} amount />}
            <Row label="Expiration height" value={String(review.expirationHeight)} mono />
          </ReviewItem>
        </ReviewSection>
      )}

      <ReviewSection title="Wallet effect">
        <ReviewItem>
          <Row
            label="Network fee"
            value={`${formatBaseUnits(review.fee)} sats`}
            amount
            strong
          />
          {"principalChange" in review && BigInt(review.principalChange) !== 0n && (
            <Row
              label="Principal change"
              value={`${formatBaseUnits(review.principalChange)} base units`}
              amount
            />
          )}
          {review.kind === "createOffer" && BigInt(review.collateralChange) !== 0n && (
            <Row
              label="Collateral change"
              value={`${formatBaseUnits(review.collateralChange)} base units`}
              amount
            />
          )}
          {BigInt(review.feeChange) !== 0n && (
            <Row
              label="L-BTC change"
              value={`${formatBaseUnits(review.feeChange)} sats`}
              amount
            />
          )}
        </ReviewItem>
      </ReviewSection>

      <details className="rounded-xl border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] p-3 text-xs">
        <summary className="cursor-pointer text-[color:var(--text-secondary)]">Technical details</summary>
        <dl className="mt-2 flex flex-col gap-1.5">
          <Row label="Bundle" value={review.bundleHash} title={review.bundleHash} mono wrap />
          <Row label="Manifest action" value={review.action} title={review.action} mono wrap />
          <Row label="Fee asset" value={review.feeAssetId} title={review.feeAssetId} mono wrap />
        </dl>
      </details>
    </div>
  );
}

type ProviderPsetReviewDTO = Extract<ApprovalRequest, { kind: "signPset" }>["review"];

function ProviderPsetReview({
  review,
  network,
  broadcast,
}: {
  review: ProviderPsetReviewDTO;
  network: "mainnet" | "testnet" | "regtest";
  broadcast: boolean;
}) {
  const sighashes = [...new Set(review.inputs.map((input) => input.sighashType))]
    .map(sighashLabel)
    .join(", ");
  const balanceChanges = Object.entries(review.balanceChanges);
  const fees = Object.entries(review.fees).filter(([, amount]) => BigInt(amount) !== 0n);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-[color:var(--text-secondary)]">
        {broadcast
          ? "This site is asking Apogee to sign and broadcast this transaction. Verify every asset and recipient below."
          : "This site is asking Apogee to sign—not broadcast—this transaction. Verify every asset and recipient below."}
      </p>
      <dl className="flex flex-col gap-1.5 rounded-xl border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] p-3 text-sm">
        <Row label="Action" value={broadcast ? "Sign and broadcast" : "Sign only"} strong />
        <Row label="Network" value={networkLabel(network)} />
        <Row
          label="Account"
          value={review.accountIdentifier}
          title={review.accountIdentifier}
          mono
          wrap
        />
        <Row
          label="PSET"
          value={review.uniqueId}
          title={review.uniqueId}
          mono
          wrap
        />
        <Row label="Inputs" value={String(review.inputCount)} />
        <Row label="Outputs" value={String(review.outputCount)} />
        <Row label="Sighash" value={sighashes} mono />
        <Row
          label="Confidential"
          value={`inputs ${review.hasConfidentialInputs ? "yes" : "no"} · outputs ${review.hasConfidentialOutputs ? "yes" : "no"}`}
        />
      </dl>

      <ReviewSection title="Wallet inputs">
        {review.inputs.map((input) => (
          <ReviewItem key={`${input.txid}:${input.vout}`}>
            <Row
              label={`Input ${input.index}`}
              value={`${input.txid}:${input.vout}`}
              title={`${input.txid}:${input.vout}`}
              mono
              wrap
            />
            <Row
              label="Address"
              value={input.address}
              title={input.address}
              mono
              wrap
            />
            <Row
              label="Amount"
              value={psetAssetAmount(input.amount, input.assetId, review.policyAssetId)}
              amount
            />
            <Row
              label="Asset"
              value={exactAssetLabel(input.assetId, review.policyAssetId)}
              title={input.assetId}
              mono
              wrap
            />
            <Row label="Sighash" value={sighashLabel(input.sighashType)} mono />
          </ReviewItem>
        ))}
      </ReviewSection>

      <ReviewSection title="External recipients">
        {review.recipients.length === 0 ? (
          <p className="text-xs text-[color:var(--text-subtle)]">No external recipients.</p>
        ) : (
          review.recipients.map((recipient, index) => (
            <ReviewItem key={`${recipient.address}:${recipient.assetId}:${index}`}>
              <Row
                label={`To ${index + 1}`}
                value={recipient.address}
                title={recipient.address}
                mono
                wrap
              />
              <Row
                label="Amount"
                value={psetAssetAmount(recipient.amount, recipient.assetId, review.policyAssetId)}
                amount
              />
              <Row
                label="Asset"
                value={exactAssetLabel(recipient.assetId, review.policyAssetId)}
                title={recipient.assetId}
                mono
                wrap
              />
              <Row label="Confidential" value={recipient.confidential ? "yes" : "no"} />
            </ReviewItem>
          ))
        )}
      </ReviewSection>

      <ReviewSection title="Wallet effect">
        {balanceChanges.map(([assetId, amount]) => (
          <ReviewItem key={`change:${assetId}`}>
            <Row
              label="Change"
              value={psetAssetAmount(amount, assetId, review.policyAssetId)}
              amount
            />
            <Row
              label="Asset"
              value={exactAssetLabel(assetId, review.policyAssetId)}
              title={assetId}
              mono
              wrap
            />
          </ReviewItem>
        ))}
        {fees.map(([assetId, amount]) => (
          <ReviewItem key={`fee:${assetId}`}>
            <Row
              label="Network fee"
              value={psetAssetAmount(amount, assetId, review.policyAssetId)}
              amount
              strong
            />
          </ReviewItem>
        ))}
      </ReviewSection>
    </div>
  );
}

function ReviewSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[color:var(--text-subtle)]">
        {title}
      </h3>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  );
}

function ReviewItem({ children }: { children: React.ReactNode }) {
  return (
    <dl className="flex flex-col gap-1 rounded-xl border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] p-3 text-sm">
      {children}
    </dl>
  );
}

function sighashLabel(value: number): string {
  return value === 1 ? "ALL (0x01)" : value === 129 ? "ALL|ANYONECANPAY (0x81)" : `0x${value.toString(16)}`;
}

function exactAssetLabel(assetId: string, policyAssetId: string): string {
  return assetId === policyAssetId ? `LBTC · ${assetId}` : assetId;
}

function psetAssetAmount(amount: string, assetId: string, policyAssetId: string): string {
  return `${formatBaseUnits(amount)} ${assetId === policyAssetId ? "sats" : "base units"}`;
}

function Row({
  label,
  value,
  mono,
  strong,
  amount,
  console: consoleValue,
  title,
  wrap,
}: {
  label: string;
  value: string;
  mono?: boolean;
  strong?: boolean;
  // An amount ending in a unit ("1,234 sats"). Rendered through TelemetryNumber
  // so the figures take the telemetry face and the unit stays in the body face.
  amount?: boolean;
  // Raw telemetry-face readout for a non-amount string with no unit to split off
  // — the wallet fingerprint. TelemetryNumber would read its trailing letters as
  // a ticker and set them in the body face, so this keeps the whole string.
  console?: boolean;
  title?: string;
  // Security-sensitive identifiers can opt out of truncation so the review
  // displays the exact value instead of relying on a hover title.
  wrap?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      {/* `strong` weights the LABEL, not the value — the telemetry face has one
          weight, so font-semibold on a figure is synthesized, and beside a ticker
          in the body face (which has a real 600) the mismatch reads as a rendering
          fault. The value's emphasis is its --text-strong color. See Send.tsx. */}
      <dt
        className={[
          "text-[color:var(--text-subtle)]",
          strong ? "font-semibold" : "",
        ].join(" ")}
      >
        {label}
      </dt>
      <dd
        title={title}
        className={[
          wrap ? "min-w-0 break-all text-right" : "truncate",
          mono ? "font-mono" : "",
          consoleValue ? "console-value" : "",
          strong ? "text-[color:var(--text-strong)]" : "text-[color:var(--text-primary)]",
        ].join(" ")}
      >
        {amount ? <TelemetryNumber value={value} glow={false} /> : value}
      </dd>
    </div>
  );
}
