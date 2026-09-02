import type { EngineRequest, TxManifestApprovalReviewDTO, TxManifestAssetMeta } from "@/engine/protocol";
import type { LiquidNetwork } from "@/keystore/keystore";
import type {
  DeclarativeChainInputRequest,
  DeclarativeChainSnapshot,
} from "@/tx-manifest/declarative-chain";
import type { DeclarativeWalletDestination } from "@/tx-manifest/declarative-prepare";
import type {
  AnyTxManifestRequirementPlan,
  TxManifestInvocation,
} from "@/tx-manifest/requirements";
import type {
  AcceptOfferVerifiedChainSnapshot,
  ClaimLenderVaultVerifiedChainSnapshot,
  NewLendingVerifiedChainSnapshot,
} from "@/tx-manifest/wallet-host";

export type ReviewedTxManifestFee = {
  /** Actual transaction fee displayed to and approved by the user. */
  actualFee: string;
  /** Lower bound used to reproduce the reviewed deterministic input selection. */
  selectionFee: string;
};

/** Whether executing a prepared manifest requires access to wallet signing keys. */
export type TxManifestSigningMode = "wallet" | "none";

export function requireTxManifestSigningMode(value: unknown): TxManifestSigningMode {
  if (value === "wallet" || value === "none") return value;
  throw new Error("Unsupported TX Manifest signing mode.");
}

/** Fields the provider lifecycle needs without knowing a protocol's execution shape. */
export type ProviderPreparedTxManifestExecution = {
  pset: string;
  planDigest: `sha256:${string}`;
  feeSelectionTarget: string;
  review: { fee: string };
};

/** Opaque-to-the-provider result returned by a protocol adapter. */
export type PreparedProviderTxManifest<
  Plan extends AnyTxManifestRequirementPlan = AnyTxManifestRequirementPlan,
  Prepared extends ProviderPreparedTxManifestExecution = ProviderPreparedTxManifestExecution,
> = {
  adapterId: string;
  signingMode: TxManifestSigningMode;
  plan: Plan;
  prepared: Prepared;
};

/** Engine capabilities exposed to adapters; wallet lifecycle and network I/O stay host-owned. */
export type TxManifestAdapterEngineRequest = Extract<
  EngineRequest,
  {
    kind:
      | "compileTxManifestCovenant"
      | "inspectTxManifestTransactionOutput"
      | "inspectTxManifestAddress"
      | "dryRunTxManifestCovenant"
      | "buildTxManifestPset"
      | "finalizeTxManifestCovenant"
      | "prepareDeclarativeTxManifest"
      | "prepareLendingV3AcceptOffer"
      | "prepareLendingV3AcceptOfferWithWallet"
      | "dryRunLendingV3AcceptOffer"
      | "prepareLendingV3ClaimLenderVault"
      | "prepareLendingV3ClaimLenderVaultWithWallet"
      | "dryRunLendingV3ClaimLenderVault"
      | "prepareLendingV3NewActionWithWallet";
  }
>;

export type TxManifestAdapterEngine = <Result>(
  request: TxManifestAdapterEngineRequest,
) => Promise<Result>;

type TxManifestAdapterPreparationContextBase = {
  origin: string;
  descriptor: string;
  network: LiquidNetwork;
  policyAssetId: string;
  reviewedFee?: ReviewedTxManifestFee;
  engine: TxManifestAdapterEngine;
};

export type BuiltinTxManifestAdapterPreparationContext =
  TxManifestAdapterPreparationContextBase & {
    chainResolution: "builtin";
    /** Host-owned resolver bound to this exact trusted plan. */
    resolveBuiltinChainSnapshot(): Promise<
      | { kind: "acceptOffer"; snapshot: AcceptOfferVerifiedChainSnapshot }
      | { kind: "claimLenderVault"; snapshot: ClaimLenderVaultVerifiedChainSnapshot }
      | { kind: "newLendingAction"; snapshot: NewLendingVerifiedChainSnapshot }
    >;
  };

export type DeclarativeTxManifestAdapterPreparationContext =
  TxManifestAdapterPreparationContextBase & {
    chainResolution: "declarative";
    /** Host-derived public destination; does not expose a descriptor or signer. */
    resolveWalletDestination(): Promise<DeclarativeWalletDestination>;
    /** Host-owned lookup restricted to the plan's exact declared outpoints. */
    resolveDeclarativeChainSnapshot(
      inputs: readonly DeclarativeChainInputRequest[],
    ): Promise<DeclarativeChainSnapshot>;
  };

export type TxManifestAdapterPreparationContext =
  | BuiltinTxManifestAdapterPreparationContext
  | DeclarativeTxManifestAdapterPreparationContext;

/**
 * Protocol-neutral boundary between the provider lifecycle and one manifest
 * implementation. The service worker authenticates the caller, owns retries,
 * signs, checkpoints, and broadcasts; an adapter owns protocol interpretation,
 * construction, review facts, and covenant verification.
 */
export interface TxManifestExecutionAdapter<
  Plan extends AnyTxManifestRequirementPlan = AnyTxManifestRequirementPlan,
  Prepared extends PreparedProviderTxManifest<Plan> = PreparedProviderTxManifest<Plan>,
> {
  readonly id: string;
  /** Present only for built-in adapters pinned to one trusted bundle. */
  readonly bundleHash?: `sha256:${string}`;

  /** Resolve key requirements from the trusted plan before wallet preparation. */
  signingMode(plan: Plan): TxManifestSigningMode;

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
