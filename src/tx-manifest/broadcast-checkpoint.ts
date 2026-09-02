import type { LiquidNetwork } from "@/keystore/keystore";
import type { LiquidExecuteTxManifestResult } from "@/provider/liquid-rpc";
import type { TxManifestApprovalReviewDTO } from "@/engine/protocol";
import type { TxManifestSigningMode } from "./adapters";
import { taggedCanonicalJsonHash } from "./bundle";
import type { TxManifestCheckpointRecord } from "./idempotency";

export type TxManifestCheckpointPayload = {
  version: 1;
  signingMode: TxManifestSigningMode;
  /** Binds recoverable public bytes and their review to the resolved execution authority. */
  authorization?: {
    requirementDigest: `sha256:${string}`;
    planDigest: `sha256:${string}`;
    feeSelectionTarget: string;
  };
  transactionHex: string;
  txid: string;
  result: LiquidExecuteTxManifestResult;
  review: TxManifestApprovalReviewDTO;
};

export type TxManifestTransactionStatus = "found" | "missing" | "unknown";

const DEFAULT_ESPLORA: Record<LiquidNetwork, string[]> = {
  liquid: ["https://liquid.network/api", "https://blockstream.info/liquid/api"],
  liquidtestnet: [
    "https://liquid.network/liquidtestnet/api",
    "https://blockstream.info/liquidtestnet/api",
  ],
  regtest: ["http://localhost:3000"],
};

export function txManifestCheckpointContext(
  record: Pick<
    TxManifestCheckpointRecord,
    "key" | "invocationDigest" | "walletId" | "network"
  >,
): string {
  return JSON.stringify([
    record.key,
    record.invocationDigest,
    record.walletId,
    record.network,
  ]);
}

/**
 * Check whether a prior submission is visible without treating a provider
 * outage as proof that it is absent. A configured server remains pinned; in
 * automatic mode every built-in provider must return 404 before `missing`.
 */
export async function lookupTxManifestTransaction(
  network: LiquidNetwork,
  txid: string,
  esploraUrl?: string,
  fetcher: typeof fetch = fetch,
): Promise<TxManifestTransactionStatus> {
  const roots = esploraUrl ? [esploraUrl] : DEFAULT_ESPLORA[network];
  let missing = 0;
  for (const root of roots) {
    try {
      const response = await fetcher(`${root.replace(/\/$/, "")}/tx/${txid}/status`, {
        method: "GET",
        cache: "no-store",
      });
      if (response.ok) return "found";
      if (response.status === 404) missing += 1;
    } catch {
      // An outage is ambiguous. Try the alternate, then report `unknown`.
    }
  }
  return missing === roots.length ? "missing" : "unknown";
}

export function parseTxManifestCheckpointPayload(
  plaintext: string,
): TxManifestCheckpointPayload {
  const value: unknown = JSON.parse(plaintext);
  if (!value || typeof value !== "object") throw new Error("Invalid TX Manifest checkpoint.");
  const candidate = value as Partial<TxManifestCheckpointPayload>;
  // Checkpoints written before signing modes existed were always wallet-signed.
  const signingMode = candidate.signingMode ?? "wallet";
  const authorization = parseAuthorization(candidate.authorization);
  if (
    candidate.version !== 1 ||
    (signingMode !== "wallet" && signingMode !== "none") ||
    typeof candidate.transactionHex !== "string" ||
    candidate.transactionHex.length === 0 ||
    candidate.transactionHex.length % 2 !== 0 ||
    !/^[0-9a-f]+$/i.test(candidate.transactionHex) ||
    typeof candidate.txid !== "string" ||
    !/^[0-9a-f]{64}$/i.test(candidate.txid) ||
    !candidate.result ||
    typeof candidate.result !== "object" ||
    !candidate.review ||
    typeof candidate.review !== "object" ||
    (signingMode === "none" && authorization === undefined)
  ) {
    throw new Error("Invalid TX Manifest checkpoint.");
  }
  return {
    ...candidate,
    signingMode,
    ...(authorization === undefined ? {} : { authorization }),
  } as TxManifestCheckpointPayload;
}

function parseAuthorization(
  value: unknown,
): TxManifestCheckpointPayload["authorization"] {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid TX Manifest checkpoint.");
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "feeSelectionTarget" ||
    keys[1] !== "planDigest" ||
    keys[2] !== "requirementDigest" ||
    typeof candidate.requirementDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(candidate.requirementDigest) ||
    typeof candidate.planDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(candidate.planDigest) ||
    typeof candidate.feeSelectionTarget !== "string" ||
    !/^[1-9][0-9]*$/.test(candidate.feeSelectionTarget)
  ) {
    throw new Error("Invalid TX Manifest checkpoint.");
  }
  return candidate as TxManifestCheckpointPayload["authorization"];
}

/** Read a checkpoint without consulting the keystore for signature-free bytes. */
export async function readTxManifestCheckpointPayload(
  record: TxManifestCheckpointRecord,
  openWalletPayload: (
    checkpoint: Extract<TxManifestCheckpointRecord, { signingMode: "wallet" }>,
  ) => Promise<string>,
): Promise<TxManifestCheckpointPayload> {
  const plaintext = record.signingMode === "none"
    ? record.publicPayload
    : await openWalletPayload(record);
  const payload = parseTxManifestCheckpointPayload(plaintext);
  if (payload.signingMode !== record.signingMode) {
    throw new Error("The TX Manifest checkpoint signing mode does not match its payload.");
  }
  return payload;
}

/** Revalidate every mutable public-checkpoint authority before rebroadcast. */
export async function requireTxManifestRecoveryPlanBinding(input: {
  payload: TxManifestCheckpointPayload;
  requirementDigest: `sha256:${string}`;
  refreshedPlanDigest: `sha256:${string}`;
  refreshedReview: TxManifestApprovalReviewDTO;
  /** Required for deterministic signature-free actions; omitted for freshly blinded wallet actions. */
  refreshedTxid?: string;
}): Promise<void> {
  const authorization = input.payload.authorization;
  if (
    authorization === undefined ||
    authorization.requirementDigest !== input.requirementDigest ||
    authorization.planDigest !== input.refreshedPlanDigest
  ) {
    throw new Error("The saved TX Manifest transaction does not match its execution plan.");
  }
  if (
    input.payload.signingMode === "none" &&
    (input.refreshedTxid === undefined || input.refreshedTxid !== input.payload.txid)
  ) {
    throw new Error("The saved TX Manifest transaction does not match the refreshed template.");
  }
  const { assets: _savedAssets, ...savedAuthority } = input.payload.review;
  const { assets: _refreshedAssets, ...refreshedAuthority } = input.refreshedReview;
  const [savedDigest, refreshedDigest] = await Promise.all([
    taggedCanonicalJsonHash("apogee/tx-manifest-review-authority/v1", savedAuthority),
    taggedCanonicalJsonHash("apogee/tx-manifest-review-authority/v1", refreshedAuthority),
  ]);
  if (savedDigest !== refreshedDigest) {
    throw new Error("The saved TX Manifest review does not match its execution plan.");
  }
}

/** A broadcast rejection that itself proves these exact bytes were already accepted. */
export function isKnownTxManifestBroadcastError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return /(?:already (?:in|known)|already have (?:transaction|tx)|txn-already-in-mempool|transaction already exists|already in block chain)/.test(
    message,
  );
}

/** Errors for which rebroadcasting the same bytes cannot become valid later. */
export function isPermanentTxManifestBroadcastError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (isKnownTxManifestBroadcastError(error)) return false;
  return /(?:missingorspent|missing or spent|inputs? spent|script verify|mandatory-script|non-mandatory-script|bad-txns|bad transaction|dust)/.test(
    message,
  );
}
