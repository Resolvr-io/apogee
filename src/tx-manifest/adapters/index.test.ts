import { describe, expect, it } from "vitest";
import {
  SIMPLICITY_LENDING_V3_ACCEPT_OFFER,
  SIMPLICITY_LENDING_V3_CANCEL_OFFER,
  SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT,
  SIMPLICITY_LENDING_V3_CLAIM_PRINCIPAL,
  SIMPLICITY_LENDING_V3_CREATE_FACTORY,
  SIMPLICITY_LENDING_V3_CREATE_OFFER,
  SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER,
  SIMPLICITY_LENDING_V3_REPAY_LOAN,
  SIMPLICITY_LENDING_V3_TESTNET_CHAIN,
} from "@/tx-manifest/builtins/simplicity-lending-v3";
import { SIMPLICITY_LENDING_V3_BUNDLE_HASH } from "@/tx-manifest/registry";
import type { TxManifestInvocation } from "@/tx-manifest/requirements";
import {
  resolveTxManifestRequirementsWithAdapter,
  txManifestExecutionAdapterForInvocation,
  txManifestExecutionAdapterForPlan,
  txManifestExecutionAdapterForPrepared,
  type PreparedProviderTxManifest,
} from ".";
import {
  SIMPLICITY_LENDING_V3_ADAPTER_ID,
  simplicityLendingV3PreparationRoute,
  type SimplicityLendingV3PreparationRoute,
} from "./simplicity-lending-v3";

function createFactoryInvocation(): TxManifestInvocation {
  return {
    protocolVersion: "0.1",
    requestId: "create-factory-adapter-test",
    chainId: SIMPLICITY_LENDING_V3_TESTNET_CHAIN,
    accountIdentifier: `${SIMPLICITY_LENDING_V3_TESTNET_CHAIN}:wallet-test`,
    manifest: { bundleHash: SIMPLICITY_LENDING_V3_BUNDLE_HASH },
    action: SIMPLICITY_LENDING_V3_CREATE_FACTORY,
    arguments: {},
    providedInputs: {},
  };
}

describe("TX Manifest execution adapter registry", () => {
  it("routes a trusted invocation and its resolved plan to the same adapter", async () => {
    const invocation = createFactoryInvocation();
    const adapter = txManifestExecutionAdapterForInvocation(invocation);
    const plan = await resolveTxManifestRequirementsWithAdapter(invocation);

    expect(adapter.id).toBe(SIMPLICITY_LENDING_V3_ADAPTER_ID);
    expect(plan.action).toBe(SIMPLICITY_LENDING_V3_CREATE_FACTORY);
    expect(txManifestExecutionAdapterForPlan(plan)).toBe(adapter);
  });

  it("retains the fail-closed error for an unknown bundle", async () => {
    const invocation = createFactoryInvocation();
    invocation.manifest.bundleHash = `sha256:${"11".repeat(32)}`;

    expect(() => txManifestExecutionAdapterForInvocation(invocation)).toThrow(
      "Unknown or unsupported TX Manifest bundle.",
    );
    await expect(resolveTxManifestRequirementsWithAdapter(invocation)).rejects.toThrow(
      "Unknown or unsupported TX Manifest bundle.",
    );
  });

  it("leaves trusted action authorization inside the selected adapter", async () => {
    const invocation = createFactoryInvocation();
    invocation.action = "lending_contract.NotAnAction";

    expect(txManifestExecutionAdapterForInvocation(invocation).id).toBe(
      SIMPLICITY_LENDING_V3_ADAPTER_ID,
    );
    await expect(resolveTxManifestRequirementsWithAdapter(invocation)).rejects.toThrow(
      "This TX Manifest action is not enabled by Apogee.",
    );
  });

  it("routes a prepared execution only when its adapter id and bundle agree", async () => {
    const plan = await resolveTxManifestRequirementsWithAdapter(createFactoryInvocation());
    const context: PreparedProviderTxManifest = {
      adapterId: SIMPLICITY_LENDING_V3_ADAPTER_ID,
      plan,
      prepared: {
        pset: "pset",
        planDigest: `sha256:${"22".repeat(32)}`,
        feeSelectionTarget: "100",
        review: { fee: "100" },
      },
    };

    expect(txManifestExecutionAdapterForPrepared(context)).toBe(
      txManifestExecutionAdapterForPlan(plan),
    );

    context.adapterId = "different-adapter";
    expect(() => txManifestExecutionAdapterForPrepared(context)).toThrow(
      "The prepared TX Manifest does not match its execution adapter.",
    );
  });
});

describe("Simplicity Lending v3 adapter preparation routing", () => {
  it.each<[string, SimplicityLendingV3PreparationRoute]>([
    [SIMPLICITY_LENDING_V3_ACCEPT_OFFER, "acceptOffer"],
    [SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT, "claimLenderVault"],
    [SIMPLICITY_LENDING_V3_CREATE_FACTORY, "newLendingAction"],
    [SIMPLICITY_LENDING_V3_CREATE_OFFER, "newLendingAction"],
    [SIMPLICITY_LENDING_V3_CLAIM_PRINCIPAL, "newLendingAction"],
    [SIMPLICITY_LENDING_V3_CANCEL_OFFER, "newLendingAction"],
    [SIMPLICITY_LENDING_V3_REPAY_LOAN, "newLendingAction"],
    [SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER, "newLendingAction"],
  ])("routes %s through %s preparation", (action, route) => {
    expect(simplicityLendingV3PreparationRoute(action)).toBe(route);
  });

  it("rejects an action with no Lending preparation", () => {
    expect(() => simplicityLendingV3PreparationRoute("unknown.Action")).toThrow(
      "Unsupported Simplicity Lending TX Manifest action.",
    );
  });
});
