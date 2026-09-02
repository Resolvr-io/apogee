import { describe, expect, it } from "vitest";
import type { DeclarativeRequirementPlan } from "@/tx-manifest/declarative-plan";
import type { EngineRequest } from "./protocol";
import { declarativeKeylessPreparationSnapshot } from "./engine-core";

const ASSET = "22".repeat(32);

describe("keyless declarative engine boundary", () => {
  it("preserves a host-derived wallet destination in the preparation snapshot", () => {
    const walletDestination = {
      scriptPubKey: `0014${"33".repeat(20)}`,
      blindingPublicKey: `02${"44".repeat(32)}`,
    };
    const request = {
      kind: "prepareDeclarativeTxManifest",
      network: "liquidtestnet",
      policyAssetId: ASSET,
      plan: { constraints: { maxFee: "20" } } as DeclarativeRequirementPlan,
      chainSnapshot: {
        genesisHash: "11".repeat(32),
        tipHeight: 100,
        feeRateSatPerKvb: "100",
        inputs: [],
        parentTransactions: [],
      },
      signingMode: "none",
      walletDestination,
    } satisfies Extract<EngineRequest, { kind: "prepareDeclarativeTxManifest" }>;

    expect(declarativeKeylessPreparationSnapshot(request)).toMatchObject({
      network: "liquid-testnet",
      policyAssetId: ASSET,
      walletCandidates: [],
      walletDestination,
      feePolicy: { feeRateSatPerKvb: "100", maxFee: "20" },
    });
  });
});
