// Shared approval UI for dapp actions. `connect` authorizes a site (it then sees
// the watch-only account); `send` reviews a built spend before signing. Rendered
// as an overlay inside the side panel when it's open, and by the standalone
// prompt popup when it isn't. Reject (or closing the popup) fails the request.

import { useEffect, useState } from "react";
import { Check, Eye, Send, PenLine, FileCode2, Coins, KeyRound, Bell } from "lucide-react";
import type { ApprovalRequest, TxManifestAssetMeta } from "@/engine/protocol";
import { formatAssetAmountExact, formatBaseUnits } from "@/lib/format";
import { shortenHex } from "@/lib/utils";
import { KNOWN_ASSETS } from "@/lib/asset-registry";
import type { LiquidNetwork } from "@/keystore/keystore";
import { AssetIcon } from "@/sidepanel/components/AssetIcon";
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

/** Human-readable labels for RPC methods shown on the connect screen. */
const METHOD_LABELS: Record<string, { label: string; description: string; icon: typeof Eye; sensitive?: boolean }> = {
  getBalance: { label: "Read balances", description: "See this account's asset balances.", icon: Eye },
  sendTransfer: { label: "Request sends", description: "Ask to send funds — each send needs your approval.", icon: Send },
  signPset: {
    label: "Sign transactions",
    description:
      "Ask for transaction signatures. Each transaction needs your approval and separately shows its exact inputs, recipients, asset changes, and fees.",
    icon: PenLine,
  },
  experimental_getTxManifestSupport: {
    label: "Check contract support",
    description: "See which trusted contract bundles and actions this wallet supports.",
    icon: FileCode2,
  },
  experimental_executeTxManifest: {
    label: "Execute contracts",
    description: "Request contract actions like lending. Each action is built, verified, and shown for approval before signing.",
    icon: FileCode2,
  },
  getUTXOs: {
    label: "View coin history",
    description:
      "Reveals individual coins, amounts, and transaction links for this account, including associated addresses. Does not reveal blinding keys or other wallet secrets.",
    icon: Coins,
    sensitive: true,
  },
  getWalletDescriptor: {
    label: "Derive addresses",
    description:
      "Lets this site derive and correlate this account's scripts and unconfidential addresses. Does not reveal private spend keys, blinding keys, or the ability to unblind outputs.",
    icon: KeyRound,
    sensitive: true,
  },
};

/** Human-readable labels for wallet events shown on the connect screen. */
const EVENT_LABELS: Record<string, { label: string; description: string; icon: typeof Eye }> = {
  bip122_walletDescriptorChanged: {
    label: "Watch address changes",
    description: "Be notified when this account's public wallet descriptor changes.",
    icon: Bell,
  },
};

export function Approval({ request, onClose }: { request: ApprovalRequest; onClose: () => void }) {
  const isConnect = request.kind === "connect";
  const isPset = request.kind === "signPset";
  const isManifest = request.kind === "executeTxManifest";
  const resumesManifest = request.kind === "executeTxManifest" && request.recovery === true;
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
  // PSET → Signed or Sent according to its approved broadcast flag, manifest →
  // Executed (not "Sent" — claiming collateral or repaying a loan isn't a send),
  // and Jade send → Approved while the device flow continues.
  const [done, setDone] = useState<"" | "connected" | "sent" | "approved" | "signed" | "executed">("");
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
              : isManifest
                ? "executed"
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
          : done === "executed"
            ? "Executed"
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
                  ? resumesManifest
                    ? "Resume contract transaction"
                    : "Execute contract action"
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
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[color:var(--text-secondary)]">
            {request.legacy
              ? "This site wants to connect. It will see your addresses and balance, but can't move funds without your approval."
              : "This site wants to connect. Review what it's asking for — every transaction still needs your approval."}
          </p>
          <dl className="flex flex-col gap-1.5 rounded-xl border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] p-3 text-sm">
            <Row label="Wallet" value={request.fingerprint.toUpperCase()} console />
            <Row label="Network" value={networkLabel(request.network)} />
          </dl>
          {!request.legacy && (request.methods.length > 0 || request.events.length > 0) && (
            <ReviewSection title="Permissions">
              {request.methods.map((method) => {
                const info = METHOD_LABELS[method];
                const Icon = info?.icon;
                return (
                  <div
                    key={method}
                    className="flex items-start gap-2.5 rounded-xl border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] p-2.5"
                  >
                    {Icon && (
                      <Icon
                        size={16}
                        className={`mt-0.5 shrink-0 ${info?.sensitive ? "text-[color:var(--warning-text)]" : "text-[color:var(--text-subtle)]"}`}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className={`text-sm font-medium ${info?.sensitive ? "text-[color:var(--warning-text)]" : "text-[color:var(--text-primary)]"}`}>
                        {info?.label ?? method}
                      </div>
                      {info?.description && (
                        <div className="mt-0.5 text-xs leading-relaxed text-[color:var(--text-subtle)]">
                          {info.description}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {request.events.map((event) => {
                const info = EVENT_LABELS[event];
                const Icon = info?.icon;
                return (
                  <div
                    key={event}
                    className="flex items-start gap-2.5 rounded-xl border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] p-2.5"
                  >
                    {Icon && <Icon size={16} className="mt-0.5 shrink-0 text-[color:var(--text-subtle)]" />}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-[color:var(--text-primary)]">
                        {info?.label ?? event}
                      </div>
                      {info?.description && (
                        <div className="mt-0.5 text-xs leading-relaxed text-[color:var(--text-subtle)]">
                          {info.description}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </ReviewSection>
          )}
        </div>
      ) : request.kind === "signPset" ? (
        <ProviderPsetReview
          review={request.review}
          network={request.network}
          broadcast={request.broadcast}
        />
      ) : request.kind === "executeTxManifest" ? (
        <TxManifestReview
          review={request.review}
          network={request.network}
          recovery={request.recovery === true}
        />
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
              resumesManifest ? "Resume broadcast" : "Approve & execute"
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

/** Look up resolved metadata with a shortened-hex fallback for unregistered assets. */
function metaFor(review: TxManifestReviewDTO, assetId: string): TxManifestAssetMeta {
  return review.assets?.[assetId] ?? {
    label: shortenHex(assetId, 6, 6),
    ticker: null,
    precision: null,
    source: "fallback",
  };
}

/** Older checkpoints predate `source`, so recover built-in provenance by ID. */
function manifestAssetSource(
  meta: TxManifestAssetMeta,
  assetId: string,
): NonNullable<TxManifestAssetMeta["source"]> {
  if (meta.source) return meta.source;
  if (KNOWN_ASSETS[assetId]) return "builtin";
  const fallback = shortenHex(assetId, 6, 6);
  return meta.ticker == null && meta.precision == null && meta.label === fallback
    ? "fallback"
    : "registry";
}

/** Map the Approval screen's DappNetwork to the LiquidNetwork AssetIcon expects. */
function manifestSpecNetwork(network: "mainnet" | "testnet" | "regtest"): LiquidNetwork {
  return network === "mainnet" ? "liquid" : network === "testnet" ? "liquidtestnet" : "regtest";
}

/** A token row: icon + role label + asset name on the left, precision-scaled amount on the right. */
function ManifestAssetRow({
  review,
  assetId,
  amount,
  specNetwork,
  roleLabel,
  strong,
}: {
  review: TxManifestReviewDTO;
  assetId: string;
  amount: string;
  specNetwork: LiquidNetwork;
  roleLabel: string;
  strong?: boolean;
}) {
  const meta = metaFor(review, assetId);
  const source = manifestAssetSource(meta, assetId);
  const displayLabel =
    source === "registry" ? `registry · ${meta.label.slice(0, 24)}` : meta.label;
  return (
    <div className="flex items-center gap-2.5 py-1">
      <AssetIcon assetId={assetId} label={meta.label} network={specNetwork} size="size-8" textSize="text-xs" />
      <div className="min-w-0 flex-1">
        <div className={`text-sm ${strong ? "text-[color:var(--text-strong)]" : "text-[color:var(--text-primary)]"}`}>
          {roleLabel}
        </div>
        <div
          className="text-[10px] text-[color:var(--text-subtle)]"
          title={
            source === "registry"
              ? `"${meta.label}" comes from the public asset registry and is not verified. Identify the asset by its exact ID in Asset identities.`
              : assetId
          }
        >
          {displayLabel}
        </div>
        <div className="font-mono text-[9px] text-[color:var(--text-subtle)]" title={assetId}>
          {shortenHex(assetId, 12, 10)}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <TelemetryNumber value={formatAssetAmountExact(amount, meta.precision)} glow={false} />
        <div className="font-mono text-[9px] text-[color:var(--text-subtle)]">
          {formatBaseUnits(amount)} {assetId === review.feeAssetId ? "sats" : "base units"}
        </div>
      </div>
    </div>
  );
}

function manifestTechnicalAssets(
  review: TxManifestReviewDTO,
): Array<{ label: string; value: string }> {
  const assets: Array<{ label: string; value: string | undefined }> = [
    { label: "Fee asset", value: review.feeAssetId },
    {
      label: "Factory asset",
      value: "factoryAssetId" in review ? review.factoryAssetId : undefined,
    },
    {
      label: "Principal asset",
      value: "principalAssetId" in review ? review.principalAssetId : undefined,
    },
    {
      label: "Collateral asset",
      value: "collateralAssetId" in review ? review.collateralAssetId : undefined,
    },
    {
      label: "Borrower NFT",
      value: "borrowerNftAssetId" in review ? review.borrowerNftAssetId : undefined,
    },
    {
      label: "Lender NFT",
      value: "lenderNftAssetId" in review ? review.lenderNftAssetId : undefined,
    },
  ];
  return assets.filter(
    (asset): asset is { label: string; value: string } => asset.value !== undefined,
  );
}

function TxManifestReview({
  review,
  network,
  recovery = false,
}: {
  review: TxManifestReviewDTO;
  network: "mainnet" | "testnet" | "regtest";
  recovery?: boolean;
}) {
  const specNetwork = manifestSpecNetwork(network);
  const feeMeta = metaFor(review, review.feeAssetId);

  return (
    <div className="flex flex-col gap-3">
      {/* Header: what the user is approving, prominent. */}
      <div className="rounded-xl border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] p-3">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-subtle)]">
          {review.protocolLabel}
        </div>
        <div className="text-base font-semibold text-[color:var(--text-strong)]">
          {review.actionLabel}
        </div>
        <div className="mt-1 text-xs text-[color:var(--text-secondary)]">
          {networkLabel(network)} · {recovery ? "resume exact saved broadcast" : "approve to sign and broadcast"}
        </div>
      </div>
      {recovery && (
        <p className="text-sm text-[color:var(--text-secondary)]">
          Apogee previously saved this exact signed transaction after you approved it, but could
          not durably confirm submission. Resuming broadcasts those same bytes; it does not rebuild
          or re-sign the transaction.
        </p>
      )}

      {review.kind === "createFactory" ? (
        <ReviewSection title="Borrower setup">
          <ReviewItem>
            <ManifestAssetRow review={review} assetId={review.factoryAssetId} amount="1" specNetwork={specNetwork} roleLabel="Factory asset" strong />
            <ManifestAssetRow review={review} assetId={review.feeAssetId} amount={review.fundingAmount} specNetwork={specNetwork} roleLabel="Funding input" />
            <Row label="Factory auth NFT" value="1 to this wallet" strong />
          </ReviewItem>
        </ReviewSection>
      ) : review.kind === "acceptOffer" || review.kind === "createOffer" ? (
        <ReviewSection title="Loan terms">
          <ReviewItem>
            <ManifestAssetRow review={review} assetId={review.principalAssetId} amount={review.principalAmount} specNetwork={specNetwork} roleLabel="Principal" strong />
            <ManifestAssetRow review={review} assetId={review.collateralAssetId} amount={review.collateralAmount} specNetwork={specNetwork} roleLabel="Collateral" />
            {review.kind === "acceptOffer" && review.lenderNftAssetId && (
              <ManifestAssetRow review={review} assetId={review.lenderNftAssetId} amount="1" specNetwork={specNetwork} roleLabel="Lender NFT received" />
            )}
            <Row label="Interest" value={`${formatBaseUnits(review.interestRateBasisPoints)} bps`} />
            <ManifestAssetRow review={review} assetId={review.principalAssetId} amount={review.totalDebt} specNetwork={specNetwork} roleLabel="Total debt" />
            <Row label="Expires at height" value={String(review.expirationHeight)} />
          </ReviewItem>
        </ReviewSection>
      ) : review.kind === "claimLenderVault" ? (
        <ReviewSection title="Repayment collected">
          <ReviewItem>
            <ManifestAssetRow review={review} assetId={review.principalAssetId} amount={review.principalAmount} specNetwork={specNetwork} roleLabel="Net to wallet" strong />
            <ManifestAssetRow review={review} assetId={review.principalAssetId} amount={review.grossDebt} specNetwork={specNetwork} roleLabel="Gross repayment" />
            <ManifestAssetRow review={review} assetId={review.principalAssetId} amount={review.interestAmount} specNetwork={specNetwork} roleLabel="Interest included" />
            <ManifestAssetRow review={review} assetId={review.principalAssetId} amount={review.protocolFeeAmount} specNetwork={specNetwork} roleLabel="Protocol fee" />
            <ManifestAssetRow review={review} assetId={review.lenderNftAssetId} amount="1" specNetwork={specNetwork} roleLabel="Lender NFT burned" />
          </ReviewItem>
        </ReviewSection>
      ) : (
        <ReviewSection title={review.kind === "claimPrincipal" ? "Funds claimed" : review.kind === "cancelOffer" ? "Offer cancelled" : review.kind === "repayLoan" ? "Loan repaid" : "Expired loan liquidated"}>
          <ReviewItem>
            <ManifestAssetRow review={review} assetId={review.principalAssetId} amount={review.principalAmount} specNetwork={specNetwork} roleLabel="Principal" />
            <ManifestAssetRow review={review} assetId={review.collateralAssetId} amount={review.collateralAmount} specNetwork={specNetwork} roleLabel="Collateral" strong />
            {review.totalDebt !== undefined && (
              <ManifestAssetRow review={review} assetId={review.principalAssetId} amount={review.totalDebt} specNetwork={specNetwork} roleLabel="Total debt" />
            )}
            {review.protocolFeeAmount !== undefined && (
              <ManifestAssetRow review={review} assetId={review.principalAssetId} amount={review.protocolFeeAmount} specNetwork={specNetwork} roleLabel="Protocol fee" />
            )}
            <Row label="Expiration height" value={String(review.expirationHeight)} />
          </ReviewItem>
        </ReviewSection>
      )}

      <ReviewSection title="Wallet effect">
        <ReviewItem>
          <ManifestAssetRow review={review} assetId={review.feeAssetId} amount={review.fee} specNetwork={specNetwork} roleLabel="Network fee" strong />
          {"principalChange" in review && BigInt(review.principalChange) !== 0n && (
            <ManifestAssetRow review={review} assetId={review.principalAssetId} amount={review.principalChange} specNetwork={specNetwork} roleLabel="Principal change" />
          )}
          {review.kind === "createOffer" && BigInt(review.collateralChange) !== 0n && (
            <ManifestAssetRow review={review} assetId={review.collateralAssetId} amount={review.collateralChange} specNetwork={specNetwork} roleLabel="Collateral change" />
          )}
          {BigInt(review.feeChange) !== 0n && (
            <ManifestAssetRow review={review} assetId={review.feeAssetId} amount={review.feeChange} specNetwork={specNetwork} roleLabel={`${feeMeta.label} change`} />
          )}
        </ReviewItem>
      </ReviewSection>

      <ReviewSection title="Asset identities">
        <ReviewItem>
          {manifestTechnicalAssets(review).map(({ label, value }) => (
            <Row key={label} label={label} value={value} mono wrap />
          ))}
        </ReviewItem>
      </ReviewSection>

      <details className="rounded-xl border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] p-3 text-xs">
        <summary className="cursor-pointer text-[color:var(--text-secondary)]">Technical details</summary>
        <div className="mt-2 flex flex-col gap-2">
          {[
            { label: "Account", value: review.accountIdentifier },
            { label: "Request", value: review.requestId },
            { label: "Bundle", value: review.bundleHash },
            { label: "Manifest action", value: review.action },
          ].map(({ label, value }) => (
            <div key={label}>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-subtle)]">
                {label}
              </div>
              <div className="mt-0.5 break-all font-mono text-[color:var(--text-primary)]">
                {value}
              </div>
            </div>
          ))}
        </div>
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
