import type { TxManifestAssetMeta } from "@/engine/protocol";
import { buildDeclarativeApprovalReview } from "@/tx-manifest/declarative-review";
import {
  declarativeSigningMode,
  resolveDeclarativeRequirements,
  type DeclarativeRequirementPlan,
} from "@/tx-manifest/declarative-plan";
import type { PreparedDeclarativeExecution } from "@/tx-manifest/declarative-prepare";
import type {
  DeclarativeTxManifestAdapterPreparationContext,
  TxManifestExecutionAdapter,
} from "./types";

export const DECLARATIVE_TX_MANIFEST_ADAPTER_ID =
  "apogee-declarative-transaction-v1" as const;

export type DeclarativePreparedTxManifest = {
  adapterId: typeof DECLARATIVE_TX_MANIFEST_ADAPTER_ID;
  signingMode: "wallet" | "none";
  kind: "declarative";
  plan: DeclarativeRequirementPlan;
  prepared: PreparedDeclarativeExecution;
  genesisHash: string;
};

/**
 * Capability-selected executor for strict declarative bundles. Nothing in this
 * adapter is keyed by publisher protocol, action name, or bundle hash.
 */
export const declarativeTxManifestExecutionAdapter: TxManifestExecutionAdapter<
  DeclarativeRequirementPlan,
  DeclarativePreparedTxManifest
> = {
  id: DECLARATIVE_TX_MANIFEST_ADAPTER_ID,

  signingMode(plan) {
    return declarativeSigningMode(plan);
  },

  async resolveRequirements(invocation) {
    return resolveDeclarativeRequirements(invocation);
  },

  async prepare(plan, context) {
    const host = requireDeclarativeHost(context);
    const signingMode = declarativeSigningMode(plan);
    const chainSnapshot = await host.resolveDeclarativeChainSnapshot(
      plan.providedInputs.map(({ roleId, outpoint }) => ({ id: roleId, outpoint })),
    );
    const walletDestination = signingMode === "none" && plan.recipe.outputs.some(
      (output) => output.kind === "wallet" || output.kind === "change",
    )
      ? await host.resolveWalletDestination()
      : undefined;
    const common = {
      kind: "prepareDeclarativeTxManifest" as const,
      network: host.network,
      policyAssetId: host.policyAssetId,
      plan,
      chainSnapshot,
      ...(host.reviewedFee === undefined ? {} : { reviewedFee: host.reviewedFee }),
    };
    const prepared = signingMode === "wallet"
      ? await host.engine<PreparedDeclarativeExecution>({
          ...common,
          signingMode,
          descriptor: host.descriptor,
        })
      : await host.engine<PreparedDeclarativeExecution>({
          ...common,
          signingMode,
          ...(walletDestination === undefined ? {} : { walletDestination }),
        });
    if (prepared.review.signingMode !== signingMode) {
      throw new Error("The declarative transaction signing mode changed during preparation.");
    }
    return {
      adapterId: DECLARATIVE_TX_MANIFEST_ADAPTER_ID,
      signingMode,
      kind: "declarative",
      plan,
      prepared,
      genesisHash: chainSnapshot.genesisHash,
    };
  },

  assetIds(context) {
    const ids = new Set<string>([context.prepared.review.feeAssetId]);
    for (const input of context.prepared.review.inputs) ids.add(input.assetId);
    for (const output of context.prepared.review.outputs) ids.add(output.assetId);
    return [...ids];
  },

  approvalReview(context, assets: Record<string, TxManifestAssetMeta>) {
    return buildDeclarativeApprovalReview(context.plan, context.prepared, assets);
  },

  async verifyFinalTransaction(context, transactionHex, engine) {
    const expectedInputIndexes = context.plan.recipe.covenant_witnesses.map((witness) =>
      context.plan.recipe.inputs.findIndex((input) => input.id === witness.input)
    );
    if (
      context.prepared.covenants.length !== expectedInputIndexes.length ||
      context.prepared.covenants.some(
        (covenant, index) => covenant.input_index !== expectedInputIndexes[index],
      )
    ) {
      throw new Error("The prepared declarative transaction omitted a declared covenant.");
    }
    for (const covenant of context.prepared.covenants) {
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

function requireDeclarativeHost(
  context: Parameters<
    typeof declarativeTxManifestExecutionAdapter.prepare
  >[1],
): DeclarativeTxManifestAdapterPreparationContext {
  if (context.chainResolution !== "declarative") {
    throw new Error("The declarative TX Manifest adapter requires the bounded host resolver.");
  }
  return context;
}
