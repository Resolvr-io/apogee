import type {
  TxManifestInvocation,
  TxManifestRequirementPlan,
} from "@/tx-manifest/requirements";
import { simplicityLendingV3ExecutionAdapter } from "./simplicity-lending-v3";
import type {
  PreparedProviderTxManifest,
  TxManifestExecutionAdapter,
} from "./types";

const TX_MANIFEST_EXECUTION_ADAPTERS: readonly TxManifestExecutionAdapter[] = Object.freeze([
  simplicityLendingV3ExecutionAdapter,
]);

export function txManifestExecutionAdapterForInvocation(
  invocation: Pick<TxManifestInvocation, "manifest">,
): TxManifestExecutionAdapter {
  const adapter = TX_MANIFEST_EXECUTION_ADAPTERS.find(
    (candidate) => candidate.bundleHash === invocation.manifest.bundleHash,
  );
  if (!adapter) throw new Error("Unknown or unsupported TX Manifest bundle.");
  return adapter;
}

export function txManifestExecutionAdapterForPlan(
  plan: Pick<TxManifestRequirementPlan, "bundleHash">,
): TxManifestExecutionAdapter {
  const adapter = TX_MANIFEST_EXECUTION_ADAPTERS.find(
    (candidate) => candidate.bundleHash === plan.bundleHash,
  );
  if (!adapter) throw new Error("Unknown or unsupported TX Manifest bundle.");
  return adapter;
}

export function txManifestExecutionAdapterForPrepared(
  context: PreparedProviderTxManifest,
): TxManifestExecutionAdapter {
  const adapter = txManifestExecutionAdapterForPlan(context.plan);
  if (context.adapterId !== adapter.id) {
    throw new Error("The prepared TX Manifest does not match its execution adapter.");
  }
  return adapter;
}

export async function resolveTxManifestRequirementsWithAdapter(
  invocation: TxManifestInvocation,
): Promise<TxManifestRequirementPlan> {
  return txManifestExecutionAdapterForInvocation(invocation).resolveRequirements(invocation);
}

export type {
  PreparedProviderTxManifest,
  ProviderPreparedTxManifestExecution,
  ReviewedTxManifestFee,
  TxManifestAdapterEngine,
  TxManifestAdapterPreparationContext,
  TxManifestExecutionAdapter,
} from "./types";
