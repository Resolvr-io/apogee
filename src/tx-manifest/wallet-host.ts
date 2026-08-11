import type {
  AcceptOfferResolvedInput,
  PreparedAcceptOfferExecution,
} from "./prepare-accept-offer";
import type { PreparedClaimLenderVaultExecution } from "./prepare-claim-lender-vault";
import type {
  CancelOfferRequirementPlan,
  ClaimPrincipalRequirementPlan,
  CreateFactoryRequirementPlan,
  CreateOfferRequirementPlan,
  LiquidateOfferRequirementPlan,
  RepayLoanRequirementPlan,
  TxManifestOutpoint,
} from "./requirements";
import type {
  PreparedCreateFactoryExecution,
  PreparedCreateOfferExecution,
} from "./prepare-create";
import type { PreparedBorrowerLendingExecution } from "./prepare-lending-action";

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

export type ClaimLenderVaultVerifiedChainSnapshot = {
  genesisHash: string;
  tipHeight: number;
  policyAssetId: string;
  lenderVault: AcceptOfferResolvedInput;
  lenderNft: AcceptOfferResolvedInput;
  parentTransactions: string[];
  fee: string;
};

export type HostedPreparedClaimLenderVaultExecution = PreparedClaimLenderVaultExecution & {
  parentTransactions: string[];
};

export type ClaimLenderVaultWalletSelection = {
  lenderNftInput: AcceptOfferWalletCandidate;
  feeInput: AcceptOfferWalletCandidate;
};

export type WalletDestination = {
  address: string;
  scriptPubKey: string;
};

export type NewLendingRequirementPlan =
  | CreateFactoryRequirementPlan
  | CreateOfferRequirementPlan
  | ClaimPrincipalRequirementPlan
  | CancelOfferRequirementPlan
  | RepayLoanRequirementPlan
  | LiquidateOfferRequirementPlan;

export type NewLendingVerifiedChainSnapshot = {
  genesisHash: string;
  tipHeight: number;
  policyAssetId: string;
  inputs: Record<string, AcceptOfferResolvedInput>;
  parentTransactions: string[];
  fee: string;
};

export type HostedPreparedNewLendingExecution = (
  | PreparedCreateFactoryExecution
  | PreparedCreateOfferExecution
  | PreparedBorrowerLendingExecution
) & { parentTransactions: string[] };

/**
 * Recover an explicit wallet output that LWK cannot place in `wollet.utxos()`.
 *
 * Simplicity Lending intentionally returns the lender NFT as an explicit output.
 * LWK currently omits that output from the UTXO set of a confidential descriptor,
 * even when another output in the same transaction proves that the script belongs
 * to the wallet. Keep the exception narrow: only the requested outpoint may be
 * recovered, and its verified chain script must match an independently derived or
 * already-recognized wallet destination.
 */
export function recoverExplicitWalletInputCandidate(
  candidates: readonly AcceptOfferWalletCandidate[],
  requestedOutpoint: TxManifestOutpoint,
  resolvedInput: AcceptOfferResolvedInput,
  walletDestinations: readonly WalletDestination[],
  parentTransaction: string | undefined,
): readonly AcceptOfferWalletCandidate[] {
  if (candidates.some((candidate) => sameOutpoint(candidate, requestedOutpoint))) {
    return candidates;
  }
  if (!sameOutpoint(resolvedInput, requestedOutpoint) || !parentTransaction) return candidates;
  const destination = walletDestinations.find(
    (candidate) => candidate.scriptPubKey === resolvedInput.scriptPubKey,
  );
  if (!destination) return candidates;
  return [
    ...candidates,
    {
      ...resolvedInput,
      address: destination.address,
      parentTransaction,
    },
  ];
}

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

/** Require the supplied lender NFT to be current wallet state, then choose its fee coin. */
export function selectClaimLenderVaultWalletInputs(
  candidates: readonly AcceptOfferWalletCandidate[],
  lenderNftOutpoint: TxManifestOutpoint,
  lenderNftAssetId: string,
  policyAssetId: string,
  fee: string,
): ClaimLenderVaultWalletSelection {
  const lenderNftInput = candidates.find(
    (candidate) =>
      sameOutpoint(candidate, lenderNftOutpoint) &&
      candidate.assetId === lenderNftAssetId &&
      candidate.amount === "1",
  );
  if (!lenderNftInput) {
    throw new Error("The requested lender NFT is not an unspent coin owned by this wallet.");
  }
  const feeInput = sufficient(candidates, policyAssetId, fee).find(
    (candidate) => !sameOutpoint(candidate, lenderNftInput),
  );
  if (!feeInput) {
    throw new Error("The connected wallet has no distinct L-BTC input large enough for the network fee.");
  }
  return { lenderNftInput, feeInput };
}

/** Select the smallest sufficient wallet input excluding already fixed transaction inputs. */
export function selectManifestWalletInput(
  candidates: readonly AcceptOfferWalletCandidate[],
  assetId: string,
  minimumAmount: string,
  excluded: readonly TxManifestOutpoint[] = [],
  label = "wallet input",
): AcceptOfferWalletCandidate {
  const selected = sufficient(candidates, assetId, minimumAmount).find(
    (candidate) => !excluded.some((outpoint) => sameOutpoint(candidate, outpoint)),
  );
  if (!selected) {
    throw new Error(`The connected wallet has no ${label} large enough for this action.`);
  }
  return selected;
}

/** Require an exact supplied outpoint to be a current coin owned by the wallet. */
export function selectManifestWalletInputByOutpoint(
  candidates: readonly AcceptOfferWalletCandidate[],
  requested: TxManifestOutpoint,
  assetId: string,
  minimumAmount: string,
  label: string,
): AcceptOfferWalletCandidate {
  const selected = candidates.find(
    (candidate) =>
      sameOutpoint(candidate, requested) &&
      candidate.assetId === assetId &&
      BigInt(candidate.amount) >= BigInt(minimumAmount),
  );
  if (!selected) throw new Error(`The requested ${label} is not an unspent coin owned by this wallet.`);
  return selected;
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

function sameOutpoint(a: TxManifestOutpoint, b: TxManifestOutpoint): boolean {
  return a.txid === b.txid && a.vout === b.vout;
}
