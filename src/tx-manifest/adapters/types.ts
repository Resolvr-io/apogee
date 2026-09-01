import type { EngineRequest, TxManifestApprovalReviewDTO, TxManifestAssetMeta } from "@/engine/protocol";
import type { LiquidNetwork } from "@/keystore/keystore";
import type {
  TxManifestInvocation,
  TxManifestRequirementPlan,
} from "@/tx-manifest/requirements";

export type ReviewedTxManifestFee = {
  /** Actual transaction fee displayed to and approved by the user. */
  actualFee: string;
  /** Lower bound used to reproduce the reviewed deterministic input selection. */
  selectionFee: string;
};

/** Fields the provider lifecycle needs without knowing a protocol's execution shape. */
export type ProviderPreparedTxManifestExecution = {
  pset: string;
  planDigest: `sha256:${string}`;
  feeSelectionTarget: string;
  review: { fee: string };
};

/** Opaque-to-the-provider result returned by a protocol adapter. */
export type PreparedProviderTxManifest<
  Plan extends TxManifestRequirementPlan = TxManifestRequirementPlan,
  Prepared extends ProviderPreparedTxManifestExecution = ProviderPreparedTxManifestExecution,
> = {
  adapterId: string;
  plan: Plan;
  prepared: Prepared;
};

export type TxManifestAdapterEngine = <Result>(request: EngineRequest) => Promise<Result>;

export type TxManifestAdapterPreparationContext = {
  origin: string;
  descriptor: string;
  network: LiquidNetwork;
  policyAssetId: string;
  configuredChainServer: string | undefined;
  expectedGenesisHash: string;
  reviewedFee?: ReviewedTxManifestFee;
  engine: TxManifestAdapterEngine;
};

/**
 * Protocol-neutral boundary between the provider lifecycle and one manifest
 * implementation. The service worker authenticates the caller, owns retries,
 * signs, checkpoints, and broadcasts; an adapter owns protocol interpretation,
 * construction, review facts, and covenant verification.
 */
export interface TxManifestExecutionAdapter<
  Plan extends TxManifestRequirementPlan = TxManifestRequirementPlan,
  Prepared extends PreparedProviderTxManifest<Plan> = PreparedProviderTxManifest<Plan>,
> {
  readonly id: string;
  readonly bundleHash: `sha256:${string}`;

  resolveRequirements(
    invocation: TxManifestInvocation,
  ): Promise<Plan>;

  prepare(
    plan: Plan,
    context: TxManifestAdapterPreparationContext,
  ): Promise<Prepared>;

  assetIds(context: Prepared): string[];

  approvalReview(
    context: Prepared,
    assets: Record<string, TxManifestAssetMeta>,
  ): TxManifestApprovalReviewDTO;

  verifyFinalTransaction(
    context: Prepared,
    transactionHex: string,
    engine: TxManifestAdapterEngine,
  ): Promise<void>;
}
