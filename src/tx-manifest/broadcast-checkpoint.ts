import type { LiquidNetwork } from "@/keystore/keystore";
import type { LiquidExecuteTxManifestResult } from "@/provider/liquid-rpc";
import type { TxManifestApprovalReviewDTO } from "@/engine/protocol";
import type { TxManifestCheckpointRecord } from "./idempotency";

export type TxManifestCheckpointPayload = {
  version: 1;
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
  if (
    candidate.version !== 1 ||
    typeof candidate.transactionHex !== "string" ||
    candidate.transactionHex.length === 0 ||
    candidate.transactionHex.length % 2 !== 0 ||
    !/^[0-9a-f]+$/i.test(candidate.transactionHex) ||
    typeof candidate.txid !== "string" ||
    !/^[0-9a-f]{64}$/i.test(candidate.txid) ||
    !candidate.result ||
    typeof candidate.result !== "object" ||
    !candidate.review ||
    typeof candidate.review !== "object"
  ) {
    throw new Error("Invalid TX Manifest checkpoint.");
  }
  return candidate as TxManifestCheckpointPayload;
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
