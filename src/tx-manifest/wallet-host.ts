import type {
  AcceptOfferResolvedInput,
  PreparedAcceptOfferExecution,
} from "./prepare-accept-offer";

export type AcceptOfferWalletCandidate = AcceptOfferResolvedInput & {
  address: string;
  parentTransaction: string;
};

export type AcceptOfferWalletSelection = {
  principalInput: AcceptOfferWalletCandidate;
  feeInput: AcceptOfferWalletCandidate;
};

export type AcceptOfferVerifiedChainSnapshot = {
  genesisHash: string;
  tipHeight: number;
  policyAssetId: string;
  pendingOffer: AcceptOfferResolvedInput;
  lenderNftAuthorization: AcceptOfferResolvedInput;
  parentTransactions: string[];
  fee: string;
};

export type HostedPreparedAcceptOfferExecution = PreparedAcceptOfferExecution & {
  parentTransactions: string[];
};

/** Deterministically select the smallest sufficient distinct principal and fee coins. */
export function selectAcceptOfferWalletInputs(
  candidates: readonly AcceptOfferWalletCandidate[],
  principalAssetId: string,
  principalAmount: string,
  policyAssetId: string,
  fee: string,
): AcceptOfferWalletSelection {
  const principal = sufficient(candidates, principalAssetId, principalAmount);
  if (principal.length === 0) {
    throw new Error("The connected wallet has no single principal input large enough for this offer.");
  }
  for (const principalInput of principal) {
    const feeInput = sufficient(candidates, policyAssetId, fee).find(
      (candidate) => !sameOutpoint(candidate, principalInput),
    );
    if (feeInput) return { principalInput, feeInput };
  }
  throw new Error("The connected wallet has no distinct L-BTC input large enough for the network fee.");
}

function sufficient(
  candidates: readonly AcceptOfferWalletCandidate[],
  assetId: string,
  minimum: string,
): AcceptOfferWalletCandidate[] {
  const needed = BigInt(minimum);
  return candidates
    .filter((candidate) => candidate.assetId === assetId && BigInt(candidate.amount) >= needed)
    .sort((a, b) => {
      const amountOrder = compareBigInt(BigInt(a.amount), BigInt(b.amount));
      if (amountOrder !== 0) return amountOrder;
      const txidOrder = a.txid.localeCompare(b.txid);
      return txidOrder !== 0 ? txidOrder : a.vout - b.vout;
    });
}

function compareBigInt(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sameOutpoint(a: AcceptOfferResolvedInput, b: AcceptOfferResolvedInput): boolean {
  return a.txid === b.txid && a.vout === b.vout;
}
