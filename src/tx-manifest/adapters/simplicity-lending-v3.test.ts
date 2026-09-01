import { describe, expect, it } from "vitest";
import type { EngineRequest } from "@/engine/protocol";
import type { TxManifestAdapterEngine } from "./types";
import {
  simplicityLendingV3ExecutionAdapter,
  type SimplicityLendingV3PreparedTxManifest,
} from "./simplicity-lending-v3";

function recordingEngine(requests: EngineRequest[]): TxManifestAdapterEngine {
  return async <Result>(request: EngineRequest) => {
    requests.push(request);
    return true as Result;
  };
}

describe("Simplicity Lending v3 final verification routing", () => {
  it("preserves the AcceptOffer dry run", async () => {
    const requests: EngineRequest[] = [];
    const context = {
      kind: "acceptOffer",
      genesisHash: "genesis",
      prepared: {
        parentTransactions: ["parent"],
        covenants: [{ id: "covenant" }],
      },
    } as unknown as Extract<SimplicityLendingV3PreparedTxManifest, { kind: "acceptOffer" }>;

    await simplicityLendingV3ExecutionAdapter.verifyFinalTransaction(
      context,
      "transaction",
      recordingEngine(requests),
    );

    expect(requests).toEqual([
      {
        kind: "dryRunLendingV3AcceptOffer",
        transactionHex: "transaction",
        parentTransactions: ["parent"],
        genesisHash: "genesis",
        covenants: [{ id: "covenant" }],
      },
    ]);
  });

  it("preserves the ClaimLenderVault dry run", async () => {
    const requests: EngineRequest[] = [];
    const context = {
      kind: "claimLenderVault",
      genesisHash: "genesis",
      prepared: {
        parentTransactions: ["parent"],
        vault: { txid: "vault" },
      },
    } as unknown as Extract<
      SimplicityLendingV3PreparedTxManifest,
      { kind: "claimLenderVault" }
    >;

    await simplicityLendingV3ExecutionAdapter.verifyFinalTransaction(
      context,
      "transaction",
      recordingEngine(requests),
    );

    expect(requests).toEqual([
      {
        kind: "dryRunLendingV3ClaimLenderVault",
        transactionHex: "transaction",
        parentTransactions: ["parent"],
        genesisHash: "genesis",
        vault: { txid: "vault" },
      },
    ]);
  });

  it("preserves one generic covenant dry run per new Lending execution", async () => {
    const requests: EngineRequest[] = [];
    const context = {
      kind: "newLendingAction",
      prepared: {
        parentTransactions: ["parent-a", "parent-b"],
        covenantExecutions: [
          { contract: "first", program: "program-a" },
          { contract: "second", program: "program-b" },
        ],
      },
    } as unknown as Extract<
      SimplicityLendingV3PreparedTxManifest,
      { kind: "newLendingAction" }
    >;

    await simplicityLendingV3ExecutionAdapter.verifyFinalTransaction(
      context,
      "transaction",
      recordingEngine(requests),
    );

    expect(requests).toEqual([
      {
        kind: "dryRunTxManifestCovenant",
        spec: {
          contract: "first",
          program: "program-a",
          transaction_hex: "transaction",
          parent_transactions: ["parent-a", "parent-b"],
        },
      },
      {
        kind: "dryRunTxManifestCovenant",
        spec: {
          contract: "second",
          program: "program-b",
          transaction_hex: "transaction",
          parent_transactions: ["parent-a", "parent-b"],
        },
      },
    ]);
  });
});
