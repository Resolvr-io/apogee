import type {
  AnyTxManifestRequirementPlan,
  TxManifestInvocation,
} from "@/tx-manifest/requirements";
import {
  DECLARATIVE_TX_MANIFEST_ADAPTER_ID,
  declarativeTxManifestExecutionAdapter,
} from "./declarative";
import { simplicityLendingV3ExecutionAdapter } from "./simplicity-lending-v3";
import {
  requireTxManifestSigningMode,
  type TxManifestSigningMode,
  type PreparedProviderTxManifest,
  type TxManifestExecutionAdapter,
} from "./types";

export { requireTxManifestSigningMode } from "./types";

export function txManifestExecutionAdapterForInvocation(
  invocation: Pick<TxManifestInvocation, "manifest">,
): TxManifestExecutionAdapter {
  if (invocation.manifest.bundleHash === simplicityLendingV3ExecutionAdapter.bundleHash) {
    return simplicityLendingV3ExecutionAdapter;
  }
  if (invocation.manifest.bundle !== undefined) return declarativeTxManifestExecutionAdapter;
  throw new Error("Unknown or unsupported TX Manifest bundle.");
}

export function txManifestExecutionAdapterForPlan(
  plan: Pick<AnyTxManifestRequirementPlan, "planVersion" | "bundleHash">,
): TxManifestExecutionAdapter {
  if (plan.planVersion === "apogee-tx-manifest-requirements/v1") {
    if (plan.bundleHash !== simplicityLendingV3ExecutionAdapter.bundleHash) {
      throw new Error("Unknown or unsupported built-in TX Manifest bundle.");
    }
    return simplicityLendingV3ExecutionAdapter;
  }
  if (plan.planVersion === "apogee-declarative-requirements/v1") {
    return declarativeTxManifestExecutionAdapter;
  }
  throw new Error("Unknown or unsupported TX Manifest execution plan.");
}

export function txManifestExecutionAdapterForPrepared(
  context: PreparedProviderTxManifest,
): TxManifestExecutionAdapter {
  const adapter = txManifestExecutionAdapterForPlan(context.plan);
  if (
    context.adapterId !== adapter.id ||
    context.signingMode !== txManifestSigningModeForPlan(context.plan)
  ) {
    throw new Error("The prepared TX Manifest does not match its execution adapter.");
  }
  return adapter;
}

export function txManifestSigningModeForPlan(
  plan: AnyTxManifestRequirementPlan,
): TxManifestSigningMode {
  const adapter = txManifestExecutionAdapterForPlan(plan);
  return requireTxManifestSigningMode(adapter.signingMode(plan));
}

export async function resolveTxManifestRequirementsWithAdapter(
  invocation: TxManifestInvocation,
): Promise<AnyTxManifestRequirementPlan> {
  const adapter = txManifestExecutionAdapterForInvocation(invocation);
  const plan = await adapter.resolveRequirements(invocation);
  if (
    plan.bundleHash !== invocation.manifest.bundleHash ||
    (adapter.bundleHash !== undefined && plan.bundleHash !== adapter.bundleHash)
  ) {
    throw new Error("The resolved TX Manifest plan does not match its execution adapter.");
  }
  if (
    adapter.id === DECLARATIVE_TX_MANIFEST_ADAPTER_ID &&
    plan.planVersion !== "apogee-declarative-requirements/v1"
  ) {
    throw new Error("The generic TX Manifest adapter returned a non-declarative plan.");
  }
  requireTxManifestSigningMode(adapter.signingMode(plan));
  return plan;
}

export type {
  PreparedProviderTxManifest,
  ProviderPreparedTxManifestExecution,
  ReviewedTxManifestFee,
  TxManifestSigningMode,
  TxManifestAdapterEngine,
  TxManifestAdapterEngineRequest,
  TxManifestAdapterPreparationContext,
  BuiltinTxManifestAdapterPreparationContext,
  DeclarativeTxManifestAdapterPreparationContext,
  TxManifestExecutionAdapter,
} from "./types";

export {
  DECLARATIVE_TX_MANIFEST_ADAPTER_ID,
  declarativeTxManifestExecutionAdapter,
} from "./declarative";
