import type { TxManifestApprovalReviewDTO, TxManifestAssetMeta } from "@/engine/protocol";
import {
  SIMPLICITY_LENDING_V3_ACCEPT_OFFER,
  SIMPLICITY_LENDING_V3_CANCEL_OFFER,
  SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT,
  SIMPLICITY_LENDING_V3_CLAIM_PRINCIPAL,
  SIMPLICITY_LENDING_V3_CREATE_FACTORY,
  SIMPLICITY_LENDING_V3_CREATE_OFFER,
  SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER,
  SIMPLICITY_LENDING_V3_REPAY_LOAN,
} from "@/tx-manifest/builtins/simplicity-lending-v3";
import {
  resolveAcceptOfferChainSnapshot,
  resolveClaimLenderVaultChainSnapshot,
  resolveNewLendingActionChainSnapshot,
} from "@/tx-manifest/esplora";
import {
  resolveTxManifestRequirements,
  type AcceptOfferRequirementPlan,
  type CancelOfferRequirementPlan,
  type ClaimLenderVaultRequirementPlan,
  type ClaimPrincipalRequirementPlan,
  type CreateFactoryRequirementPlan,
  type CreateOfferRequirementPlan,
  type LiquidateOfferRequirementPlan,
  type RepayLoanRequirementPlan,
  type TxManifestRequirementPlan,
} from "@/tx-manifest/requirements";
import { SIMPLICITY_LENDING_V3_BUNDLE_HASH } from "@/tx-manifest/registry";
import type { TxManifestTransactionOutputInspection } from "@/tx-manifest/runtime";
import type {
  HostedPreparedAcceptOfferExecution,
  HostedPreparedClaimLenderVaultExecution,
  HostedPreparedNewLendingExecution,
} from "@/tx-manifest/wallet-host";
import {
  type ReviewedTxManifestFee,
  type TxManifestAdapterPreparationContext,
  type TxManifestExecutionAdapter,
} from "./types";

export const SIMPLICITY_LENDING_V3_ADAPTER_ID = "simplicity-lending-v3" as const;

type NewLendingPlan =
  | CreateFactoryRequirementPlan
  | CreateOfferRequirementPlan
  | ClaimPrincipalRequirementPlan
  | CancelOfferRequirementPlan
  | RepayLoanRequirementPlan
  | LiquidateOfferRequirementPlan;

export type SimplicityLendingV3PreparedTxManifest =
  | {
      adapterId: typeof SIMPLICITY_LENDING_V3_ADAPTER_ID;
      kind: "acceptOffer";
      plan: AcceptOfferRequirementPlan;
      prepared: HostedPreparedAcceptOfferExecution;
      genesisHash: string;
    }
  | {
      adapterId: typeof SIMPLICITY_LENDING_V3_ADAPTER_ID;
      kind: "claimLenderVault";
      plan: ClaimLenderVaultRequirementPlan;
      prepared: HostedPreparedClaimLenderVaultExecution;
      genesisHash: string;
    }
  | {
      adapterId: typeof SIMPLICITY_LENDING_V3_ADAPTER_ID;
      kind: "newLendingAction";
      plan: NewLendingPlan;
      prepared: HostedPreparedNewLendingExecution;
      genesisHash: string;
    };

export type SimplicityLendingV3PreparationRoute =
  | "acceptOffer"
  | "claimLenderVault"
  | "newLendingAction";

/** Pure action routing kept explicit so every trusted action is covered by tests. */
export function simplicityLendingV3PreparationRoute(
  action: string,
): SimplicityLendingV3PreparationRoute {
  if (action === SIMPLICITY_LENDING_V3_ACCEPT_OFFER) return "acceptOffer";
  if (action === SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT) return "claimLenderVault";
  if (
    action === SIMPLICITY_LENDING_V3_CREATE_FACTORY ||
    action === SIMPLICITY_LENDING_V3_CREATE_OFFER ||
    action === SIMPLICITY_LENDING_V3_CLAIM_PRINCIPAL ||
    action === SIMPLICITY_LENDING_V3_CANCEL_OFFER ||
    action === SIMPLICITY_LENDING_V3_REPAY_LOAN ||
    action === SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER
  ) {
    return "newLendingAction";
  }
  throw new Error("Unsupported Simplicity Lending TX Manifest action.");
}

export const simplicityLendingV3ExecutionAdapter: TxManifestExecutionAdapter<
  TxManifestRequirementPlan,
  SimplicityLendingV3PreparedTxManifest
> = {
  id: SIMPLICITY_LENDING_V3_ADAPTER_ID,
  bundleHash: SIMPLICITY_LENDING_V3_BUNDLE_HASH,
  resolveRequirements: resolveTxManifestRequirements,

  async prepare(plan, context) {
    const inspectOutput = (transactionHex: string, vout: number) =>
      context.engine<TxManifestTransactionOutputInspection>({
        kind: "inspectTxManifestTransactionOutput",
        transactionHex,
        vout,
      });

    switch (simplicityLendingV3PreparationRoute(plan.action)) {
      case "acceptOffer":
        return prepareAcceptOffer(plan as AcceptOfferRequirementPlan, context, inspectOutput);
      case "claimLenderVault":
        return prepareClaimLenderVault(
          plan as ClaimLenderVaultRequirementPlan,
          context,
          inspectOutput,
        );
      case "newLendingAction":
        return prepareNewLendingAction(plan as NewLendingPlan, context, inspectOutput);
    }
  },

  assetIds(context) {
    const ids = new Set<string>();
    const push = (id: string | undefined) => {
      if (id) ids.add(id);
    };
    push(context.prepared.review.feeAssetId);
    if (context.kind === "acceptOffer") {
      push(context.plan.instance.LENDER_NFT_ASSET_ID);
    }
    const intent = context.plan.intent as unknown as Record<string, unknown>;
    for (const key of [
      "principalAssetId",
      "collateralAssetId",
      "factoryAssetId",
      "borrowerNftAssetId",
      "lenderNftAssetId",
    ]) {
      if (typeof intent[key] === "string") push(intent[key]);
    }
    const review = context.prepared.review as unknown as Record<string, unknown>;
    for (const key of ["factoryAssetId", "borrowerNftAssetId", "lenderNftAssetId"]) {
      if (typeof review[key] === "string") push(review[key]);
    }
    return [...ids];
  },

  approvalReview(context, assets) {
    return lendingApprovalReview(context, assets);
  },

  async verifyFinalTransaction(context, transactionHex, engine) {
    if (context.kind === "acceptOffer") {
      await engine<true>({
        kind: "dryRunLendingV3AcceptOffer",
        transactionHex,
        parentTransactions: context.prepared.parentTransactions,
        genesisHash: context.genesisHash,
        covenants: context.prepared.covenants,
      });
      return;
    }
    if (context.kind === "claimLenderVault") {
      await engine<true>({
        kind: "dryRunLendingV3ClaimLenderVault",
        transactionHex,
        parentTransactions: context.prepared.parentTransactions,
        genesisHash: context.genesisHash,
        vault: context.prepared.vault,
      });
      return;
    }
    for (const covenant of context.prepared.covenantExecutions) {
      await engine<true>({
        kind: "dryRunTxManifestCovenant",
        spec: {
          ...covenant,
          transaction_hex: transactionHex,
          parent_transactions: context.prepared.parentTransactions,
        },
      });
    }
  },
};

type InspectOutput = (
  transactionHex: string,
  vout: number,
) => Promise<TxManifestTransactionOutputInspection>;

async function prepareAcceptOffer(
  plan: AcceptOfferRequirementPlan,
  context: TxManifestAdapterPreparationContext,
  inspectOutput: InspectOutput,
): Promise<Extract<SimplicityLendingV3PreparedTxManifest, { kind: "acceptOffer" }>> {
  const resolved = await resolveAcceptOfferChainSnapshot(
    plan,
    context.policyAssetId,
    inspectOutput,
    context.configuredChainServer,
    context.expectedGenesisHash,
  );
  const snapshot = withReviewedFee(resolved.snapshot, context.reviewedFee);
  const prepared = await context.engine<HostedPreparedAcceptOfferExecution>({
    kind: "prepareLendingV3AcceptOfferWithWallet",
    descriptor: context.descriptor,
    network: context.network,
    plan,
    chainSnapshot: snapshot,
  });
  return {
    adapterId: SIMPLICITY_LENDING_V3_ADAPTER_ID,
    kind: "acceptOffer",
    plan,
    prepared,
    genesisHash: resolved.snapshot.genesisHash,
  };
}

async function prepareClaimLenderVault(
  plan: ClaimLenderVaultRequirementPlan,
  context: TxManifestAdapterPreparationContext,
  inspectOutput: InspectOutput,
): Promise<Extract<SimplicityLendingV3PreparedTxManifest, { kind: "claimLenderVault" }>> {
  const resolved = await resolveClaimLenderVaultChainSnapshot(
    plan,
    context.policyAssetId,
    inspectOutput,
    context.configuredChainServer,
    context.expectedGenesisHash,
  );
  const snapshot = withReviewedFee(resolved.snapshot, context.reviewedFee);
  const prepared = await context.engine<HostedPreparedClaimLenderVaultExecution>({
    kind: "prepareLendingV3ClaimLenderVaultWithWallet",
    descriptor: context.descriptor,
    network: context.network,
    plan,
    chainSnapshot: snapshot,
  });
  return {
    adapterId: SIMPLICITY_LENDING_V3_ADAPTER_ID,
    kind: "claimLenderVault",
    plan,
    prepared,
    genesisHash: resolved.snapshot.genesisHash,
  };
}

async function prepareNewLendingAction(
  plan: NewLendingPlan,
  context: TxManifestAdapterPreparationContext,
  inspectOutput: InspectOutput,
): Promise<Extract<SimplicityLendingV3PreparedTxManifest, { kind: "newLendingAction" }>> {
  const resolved = await resolveNewLendingActionChainSnapshot(
    plan,
    context.policyAssetId,
    inspectOutput,
    context.configuredChainServer,
    context.expectedGenesisHash,
  );
  const snapshot = withReviewedFee(resolved.snapshot, context.reviewedFee);
  const prepared = await context.engine<HostedPreparedNewLendingExecution>({
    kind: "prepareLendingV3NewActionWithWallet",
    descriptor: context.descriptor,
    network: context.network,
    assetContractDomain: new URL(context.origin).hostname.toLowerCase(),
    plan,
    chainSnapshot: snapshot,
  });
  return {
    adapterId: SIMPLICITY_LENDING_V3_ADAPTER_ID,
    kind: "newLendingAction",
    plan,
    prepared,
    genesisHash: resolved.snapshot.genesisHash,
  };
}

function withReviewedFee<
  Snapshot extends { feePolicy: { exactFee?: string; exactSelectionFee?: string } },
>(snapshot: Snapshot, reviewedFee: ReviewedTxManifestFee | undefined): Snapshot {
  if (reviewedFee === undefined) return snapshot;
  return {
    ...snapshot,
    feePolicy: {
      ...snapshot.feePolicy,
      exactFee: reviewedFee.actualFee,
      exactSelectionFee: reviewedFee.selectionFee,
    },
  };
}

function lendingApprovalReview(
  context: SimplicityLendingV3PreparedTxManifest,
  assets: Record<string, TxManifestAssetMeta>,
): TxManifestApprovalReviewDTO {
  const common = {
    protocolLabel: context.plan.intent.protocolLabel,
    actionLabel: context.plan.intent.actionLabel,
    requestId: context.plan.requestId,
    accountIdentifier: context.plan.accountIdentifier,
    bundleHash: context.plan.bundleHash,
    action: context.plan.action,
    feeAssetId: context.prepared.review.feeAssetId,
    fee: context.prepared.review.fee,
    feeChange: context.prepared.review.feeChange,
    assets,
  };
  if (context.kind === "acceptOffer") {
    return {
      ...common,
      kind: "acceptOffer",
      lenderNftAssetId: context.plan.instance.LENDER_NFT_ASSET_ID,
      principalAssetId: context.plan.intent.principalAssetId,
      principalAmount: context.plan.intent.principalAmount,
      collateralAssetId: context.plan.intent.collateralAssetId,
      collateralAmount: context.plan.intent.collateralAmount,
      interestRateBasisPoints: context.plan.intent.interestRateBasisPoints,
      totalDebt: context.plan.intent.totalDebt,
      expirationHeight: context.plan.intent.expirationHeight,
      principalChange: context.prepared.review.principalChange,
    };
  }
  if (context.kind === "claimLenderVault") {
    return {
      ...common,
      kind: "claimLenderVault",
      principalAssetId: context.plan.intent.principalAssetId,
      principalAmount: context.plan.intent.principalAmount,
      grossDebt: context.plan.intent.grossDebt,
      interestAmount: context.plan.intent.interestAmount,
      protocolFeeAmount: context.plan.intent.protocolFeeAmount,
      lenderNftAssetId: context.plan.intent.lenderNftAssetId,
    };
  }
  const prepared = context.prepared;
  if (prepared.kind === "createFactory") {
    return {
      ...common,
      kind: "createFactory",
      factoryAssetId: prepared.review.factoryAssetId,
      fundingAmount: prepared.review.fundingAmount,
    };
  }
  if (prepared.kind === "createOffer") {
    return {
      ...common,
      kind: "createOffer",
      factoryAssetId: prepared.review.factoryAssetId,
      borrowerNftAssetId: prepared.review.borrowerNftAssetId,
      lenderNftAssetId: prepared.review.lenderNftAssetId,
      principalAssetId: prepared.review.principalAssetId,
      principalAmount: prepared.review.principalAmount,
      collateralAssetId: prepared.review.collateralAssetId,
      collateralAmount: prepared.review.collateralAmount,
      interestRateBasisPoints: prepared.review.interestRateBasisPoints,
      totalDebt: prepared.review.totalDebt,
      expirationHeight: prepared.review.expirationHeight,
      collateralChange: prepared.review.collateralChange,
    };
  }
  return {
    ...common,
    kind: prepared.kind,
    principalAssetId: prepared.review.principalAssetId,
    principalAmount: prepared.review.principalAmount,
    collateralAssetId: prepared.review.collateralAssetId,
    collateralAmount: prepared.review.collateralAmount,
    borrowerNftAssetId: prepared.review.borrowerNftAssetId,
    lenderNftAssetId: prepared.review.lenderNftAssetId,
    expirationHeight: prepared.review.expirationHeight,
    ...(prepared.review.totalDebt === undefined ? {} : { totalDebt: prepared.review.totalDebt }),
    ...(prepared.review.interestAmount === undefined
      ? {}
      : { interestAmount: prepared.review.interestAmount }),
    ...(prepared.review.protocolFeeAmount === undefined
      ? {}
      : { protocolFeeAmount: prepared.review.protocolFeeAmount }),
    ...(prepared.review.lenderVaultAmount === undefined
      ? {}
      : { lenderVaultAmount: prepared.review.lenderVaultAmount }),
    principalChange: prepared.review.principalChange,
  };
}
