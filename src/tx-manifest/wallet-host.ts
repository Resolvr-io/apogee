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
import {
  MAX_MANIFEST_SELECTION_SEARCH_CANDIDATES,
  MAX_MANIFEST_SELECTION_SEARCH_NODES,
  MAX_MANIFEST_WALLET_INPUTS_PER_ASSET,
} from "./coin-selection-policy";
import type { TxManifestFeePolicy } from "./fees";

export type AcceptOfferWalletCandidate = AcceptOfferResolvedInput & {
  address: string;
  parentTransaction: string;
};

export type AcceptOfferWalletSelection = {
  principalInputs: AcceptOfferWalletCandidate[];
  feeInputs: AcceptOfferWalletCandidate[];
};

export type AcceptOfferVerifiedChainSnapshot = {
  genesisHash: string;
  tipHeight: number;
  policyAssetId: string;
  pendingOffer: AcceptOfferResolvedInput;
  lenderNftAuthorization: AcceptOfferResolvedInput;
  parentTransactions: string[];
  feePolicy: TxManifestFeePolicy;
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
  feePolicy: TxManifestFeePolicy;
};

export type HostedPreparedClaimLenderVaultExecution = PreparedClaimLenderVaultExecution & {
  parentTransactions: string[];
};

export type ClaimLenderVaultWalletSelection = {
  lenderNftInput: AcceptOfferWalletCandidate;
  feeInputs: AcceptOfferWalletCandidate[];
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
  feePolicy: TxManifestFeePolicy;
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

/** Deterministically select distinct principal and fee coin sets. */
export function selectAcceptOfferWalletInputs(
  candidates: readonly AcceptOfferWalletCandidate[],
  principalAssetId: string,
  principalAmount: string,
  policyAssetId: string,
  fee: string,
): AcceptOfferWalletSelection {
  if (principalAssetId === policyAssetId) {
    return {
      principalInputs: selectManifestWalletInputs(
        candidates,
        principalAssetId,
        (BigInt(principalAmount) + BigInt(fee)).toString(),
        [],
        "principal and fee inputs",
      ),
      feeInputs: [],
    };
  }
  const principalInputs = selectManifestWalletInputs(
    candidates,
    principalAssetId,
    principalAmount,
    [],
    "principal inputs",
  );
  return {
    principalInputs,
    feeInputs: selectManifestWalletInputs(
      candidates,
      policyAssetId,
      fee,
      principalInputs,
      "distinct L-BTC fee inputs",
    ),
  };
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
  return {
    lenderNftInput,
    feeInputs: selectManifestWalletInputs(
      candidates,
      policyAssetId,
      fee,
      [lenderNftInput],
      "distinct L-BTC fee inputs",
    ),
  };
}

/**
 * Select a deterministic bounded set of wallet inputs for one asset.
 *
 * A one-coin exact or dust-safe solution keeps the current efficient behavior.
 * Fragmented balances use a node-count-bounded best-fit search followed by a
 * deterministic largest-first fallback. Returned inputs use canonical outpoint
 * order so required issuance/funding anchors remain stable across preparations.
 */
export function selectManifestWalletInputs(
  candidates: readonly AcceptOfferWalletCandidate[],
  assetId: string,
  minimumAmount: string,
  excluded: readonly TxManifestOutpoint[] = [],
  label = "wallet inputs",
  minimumChange = "0",
): AcceptOfferWalletCandidate[] {
  const target = BigInt(minimumAmount);
  const changeFloor = BigInt(minimumChange);
  if (target <= 0n) throw new Error(`${label} target must be positive.`);
  if (changeFloor < 0n) throw new Error(`${label} minimum change cannot be negative.`);

  const eligible = candidates
    .filter(
      (candidate) =>
        candidate.assetId === assetId &&
        !excluded.some((outpoint) => sameOutpoint(candidate, outpoint)),
    )
    .sort(compareCandidateOutpoint);
  const totalAvailable = sumInputs(eligible);
  if (totalAvailable < target) {
    throw new Error(`The connected wallet has insufficient ${label} for this action.`);
  }

  const exactSingle = eligible.find((candidate) => BigInt(candidate.amount) === target);
  if (exactSingle) return [exactSingle];

  const sufficientSingles = eligible
    .filter((candidate) => BigInt(candidate.amount) > target)
    .sort((a, b) => compareSelection([a], [b], target, changeFloor));
  const dustSafeSingle = sufficientSingles.find(
    (candidate) => isDustSafe(BigInt(candidate.amount) - target, changeFloor),
  );
  if (dustSafeSingle) return [dustSafeSingle];

  const byAmountDescending = [...eligible].sort((a, b) => {
    const amountOrder = compareBigInt(BigInt(b.amount), BigInt(a.amount));
    return amountOrder !== 0 ? amountOrder : compareCandidateOutpoint(a, b);
  });
  const greedy: AcceptOfferWalletCandidate[] = [];
  let greedyTotal = 0n;
  for (const candidate of byAmountDescending) {
    if (greedy.length === MAX_MANIFEST_WALLET_INPUTS_PER_ASSET) break;
    greedy.push(candidate);
    greedyTotal += BigInt(candidate.amount);
    if (greedyTotal >= target) break;
  }
  if (greedyTotal < target) {
    throw new Error(
      `The connected wallet's ${label} are too fragmented; this action supports at most ${MAX_MANIFEST_WALLET_INPUTS_PER_ASSET} inputs per asset.`,
    );
  }

  let best = [...greedy].sort(compareCandidateOutpoint);
  const search = byAmountDescending.slice(0, MAX_MANIFEST_SELECTION_SEARCH_CANDIDATES);
  const remaining = Array<bigint>(search.length + 1).fill(0n);
  for (let index = search.length - 1; index >= 0; index -= 1) {
    remaining[index] = remaining[index + 1]! + BigInt(search[index]!.amount);
  }
  let visited = 0;
  const selected: AcceptOfferWalletCandidate[] = [];

  const visit = (index: number, total: bigint) => {
    visited += 1;
    if (visited > MAX_MANIFEST_SELECTION_SEARCH_NODES) return;
    if (total >= target) {
      const ordered = [...selected].sort(compareCandidateOutpoint);
      if (compareSelection(ordered, best, target, changeFloor) < 0) best = ordered;
      return;
    }
    if (
      index >= search.length ||
      selected.length >= MAX_MANIFEST_WALLET_INPUTS_PER_ASSET ||
      total + remaining[index]! < target
    ) {
      return;
    }
    const candidate = search[index]!;
    selected.push(candidate);
    visit(index + 1, total + BigInt(candidate.amount));
    selected.pop();
    visit(index + 1, total);
  };
  visit(0, 0n);
  return best;
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

function compareSelection(
  a: readonly AcceptOfferWalletCandidate[],
  b: readonly AcceptOfferWalletCandidate[],
  target: bigint,
  changeFloor: bigint,
): number {
  const aChange = sumInputs(a) - target;
  const bChange = sumInputs(b) - target;
  const exactOrder = Number(aChange !== 0n) - Number(bChange !== 0n);
  if (exactOrder !== 0) return exactOrder;
  const dustOrder = Number(!isDustSafe(aChange, changeFloor)) - Number(!isDustSafe(bChange, changeFloor));
  if (dustOrder !== 0) return dustOrder;
  const changeOrder = compareBigInt(aChange, bChange);
  if (changeOrder !== 0) return changeOrder;
  if (a.length !== b.length) return a.length - b.length;
  for (let index = 0; index < a.length; index += 1) {
    const outpointOrder = compareCandidateOutpoint(a[index]!, b[index]!);
    if (outpointOrder !== 0) return outpointOrder;
  }
  return 0;
}

function isDustSafe(change: bigint, minimumChange: bigint): boolean {
  return change === 0n || change >= minimumChange;
}

function sumInputs(inputs: readonly AcceptOfferWalletCandidate[]): bigint {
  return inputs.reduce((total, input) => total + BigInt(input.amount), 0n);
}

function compareCandidateOutpoint(
  a: AcceptOfferWalletCandidate,
  b: AcceptOfferWalletCandidate,
): number {
  const txidOrder = a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0;
  return txidOrder !== 0 ? txidOrder : a.vout - b.vout;
}

function compareBigInt(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sameOutpoint(a: TxManifestOutpoint, b: TxManifestOutpoint): boolean {
  return a.txid === b.txid && a.vout === b.vout;
}
