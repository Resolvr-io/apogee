import { describe, expect, it, vi } from "vitest";
import { txManifestBundleHash, type TxManifestBundle } from "@/tx-manifest/bundle";
import type { DeclarativeChainSnapshot } from "@/tx-manifest/declarative-chain";
import type { PreparedDeclarativeExecution } from "@/tx-manifest/declarative-prepare";
import type { TxManifestInvocation } from "@/tx-manifest/requirements";
import {
  DECLARATIVE_TX_MANIFEST_ADAPTER_ID,
  declarativeTxManifestExecutionAdapter,
} from "./declarative";
import {
  resolveTxManifestRequirementsWithAdapter,
  txManifestExecutionAdapterForInvocation,
  txManifestExecutionAdapterForPlan,
} from ".";
import type {
  TxManifestAdapterEngine,
  TxManifestAdapterEngineRequest,
} from "./types";

const CHAIN = `bip122:${"11".repeat(16)}`;
const GENESIS = "11".repeat(32);
const ASSET = "22".repeat(32);
const FIRST_TXID = "33".repeat(32);
const SECOND_TXID = "44".repeat(32);
const COVENANT_SCRIPT = `5120${"55".repeat(32)}`;

function bundle(protocol: string, action: string, walletOutput = false): TxManifestBundle {
  const provided = (id: string, providedInput: string, amount: string) => ({
    kind: "provided",
    id,
    provided_input: providedInput,
    authorization: "covenant",
    expect: {
      asset: { op: "arg", name: "ASSET" },
      amount: { op: "uint", value: amount },
    },
  });
  const covenant = (input: string) => ({
    input,
    source: "contract.simf",
    arguments: {},
    extra_leaf_payloads: [],
    witnesses: { PATH: { kind: "right", value: { kind: "unit" } } },
  });
  return {
    schema: "apogee-tx-manifest-bundle/v1",
    manifestSpec: {
      id: "elip-205-draft",
      revision: "1a8d0b759853a00fef5f74351b64a602e2ba7a6f",
    },
    compiler: {
      id: "simplicityhl",
      revision: "9e77379d343e76eb92cb57c2668af9f8e0c4f46b",
      debugSymbols: false,
    },
    extensions: ["apogee-declarative-transaction/v1"],
    manifest: {
      manifest_version: "0.1.0",
      protocol,
      actions: { [action]: { description: "Unverified publisher description." } },
      x_apogee_declarative: {
        version: 1,
        chains: [CHAIN],
        actions: {
          [action]: {
            arguments: { ASSET: "asset_id" },
            inputs: [
              provided("first", "first_in", "60"),
              provided("second", "second_in", "50"),
            ],
            outputs: walletOutput
              ? [{
                  kind: "wallet",
                  asset: { op: "arg", name: "ASSET" },
                  amount: { op: "uint", value: "100" },
                  confidential: false,
                }]
              : [{
                  kind: "script",
                  asset: { op: "arg", name: "ASSET" },
                  amount: { op: "uint", value: "100" },
                  script: { op: "bytes", value: "51" },
                  confidential: false,
                }],
            fee: {
              mode: "fixed",
              asset: { op: "arg", name: "ASSET" },
              amount: { op: "uint", value: "10" },
              output_index: 1,
            },
            covenant_witnesses: [covenant("first"), covenant("second")],
          },
        },
      },
    },
    sources: { "contract.simf": "fn main() {}\n" },
  };
}

async function invocation(
  protocol: string,
  action: string,
  walletOutput = false,
): Promise<TxManifestInvocation> {
  const value = bundle(protocol, action, walletOutput);
  return {
    protocolVersion: "0.1",
    requestId: `request-${action}`,
    chainId: CHAIN,
    accountIdentifier: `${CHAIN}:wallet`,
    manifest: { bundleHash: await txManifestBundleHash(value), bundle: value },
    action,
    arguments: { ASSET },
    providedInputs: {
      first_in: { txid: FIRST_TXID, vout: 0 },
      second_in: { txid: SECOND_TXID, vout: 1 },
    },
    constraints: { maxFee: "20" },
  };
}

function chainSnapshot(): DeclarativeChainSnapshot {
  const inputs = [
    { id: "first", txid: FIRST_TXID, vout: 0, amount: "60" },
    { id: "second", txid: SECOND_TXID, vout: 1, amount: "50" },
  ].map((input, index) => ({
    ...input,
    txOut: `${index + 1}`.padStart(2, "0"),
    scriptPubKey: COVENANT_SCRIPT,
    assetId: ASSET,
    transactionHex: `020000000${index}`,
    confirmed: true,
    blockHeight: 90 + index,
  }));
  return {
    genesisHash: GENESIS,
    tipHeight: 100,
    feeRateSatPerKvb: "100",
    inputs,
    parentTransactions: inputs.map(({ transactionHex }) => transactionHex),
  };
}

function preparedExecution(): PreparedDeclarativeExecution {
  const parents = chainSnapshot().parentTransactions.slice();
  return {
    pset: "pset-keyless",
    planDigest: `sha256:${"66".repeat(32)}`,
    feeSelectionTarget: "10",
    parentTransactions: parents,
    covenants: [0, 1].map((input_index) => ({
      source: "fn main() {}\n",
      arguments: {},
      extra_leaf_payloads: [],
      witnesses: { PATH: { type: "simplicityhl", value: "Right(())" } },
      input_index,
      genesis_hash: GENESIS,
      include_debug_symbols: false,
      transaction_hex: "",
      parent_transactions: [],
    })),
    review: {
      feeAssetId: ASSET,
      fee: "10",
      feeOutputIndex: 1,
      feeChange: "0",
      inputs: [],
      outputs: [],
      locktime: 0,
      rbf: false,
      signingMode: "none",
      walletBalanceChanges: {},
    },
  };
}

describe("generic declarative TX Manifest adapter", () => {
  it("selects equivalent renamed and rehashed bundles by capability", async () => {
    const first = await invocation("publisher-one", "example.Execute");
    const renamed = await invocation("publisher-two", "renamed.Apply");
    expect(first.manifest.bundleHash).not.toBe(renamed.manifest.bundleHash);

    for (const request of [first, renamed]) {
      const selected = txManifestExecutionAdapterForInvocation(request);
      const plan = await resolveTxManifestRequirementsWithAdapter(request);
      expect(selected.id).toBe(DECLARATIVE_TX_MANIFEST_ADAPTER_ID);
      expect(plan.planVersion).toBe("apogee-declarative-requirements/v1");
      expect(txManifestExecutionAdapterForPlan(plan)).toBe(selected);
    }
  });

  it("prepares a keyless action through only the exact-outpoint host callback", async () => {
    const plan = await resolveTxManifestRequirementsWithAdapter(
      await invocation("publisher", "generic.Execute"),
    );
    if (plan.planVersion !== "apogee-declarative-requirements/v1") {
      throw new Error("expected declarative plan");
    }
    const snapshot = chainSnapshot();
    const resolveChain = vi.fn(async () => snapshot);
    const resolveWalletDestination = vi.fn(async () => ({
      scriptPubKey: "unused",
      blindingPublicKey: "unused",
    }));
    const requests: unknown[] = [];
    const engine: TxManifestAdapterEngine = async <Result>(
      request: TxManifestAdapterEngineRequest,
    ) => {
      requests.push(request);
      return preparedExecution() as unknown as Result;
    };

    const result = await declarativeTxManifestExecutionAdapter.prepare(plan, {
      chainResolution: "declarative",
      origin: "https://example.test",
      descriptor: "descriptor-must-not-be-forwarded",
      network: "liquidtestnet",
      policyAssetId: ASSET,
      engine,
      resolveWalletDestination,
      resolveDeclarativeChainSnapshot: resolveChain,
    });

    expect(resolveChain).toHaveBeenCalledWith([
      { id: "first", outpoint: { txid: FIRST_TXID, vout: 0 } },
      { id: "second", outpoint: { txid: SECOND_TXID, vout: 1 } },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      kind: "prepareDeclarativeTxManifest",
      signingMode: "none",
      chainSnapshot: snapshot,
    });
    expect(requests[0]).not.toHaveProperty("descriptor");
    expect(resolveWalletDestination).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      adapterId: DECLARATIVE_TX_MANIFEST_ADAPTER_ID,
      signingMode: "none",
      kind: "declarative",
      genesisHash: GENESIS,
    });
  });

  it("asks the host for a public destination for a keyless wallet output", async () => {
    const plan = await resolveTxManifestRequirementsWithAdapter(
      await invocation("publisher", "generic.Payout", true),
    );
    if (plan.planVersion !== "apogee-declarative-requirements/v1") {
      throw new Error("expected declarative plan");
    }
    const destination = {
      scriptPubKey: `0014${"77".repeat(20)}`,
      blindingPublicKey: `02${"88".repeat(32)}`,
    };
    const resolveWalletDestination = vi.fn(async () => destination);
    const requests: unknown[] = [];
    const engine: TxManifestAdapterEngine = async <Result>(
      request: TxManifestAdapterEngineRequest,
    ) => {
      requests.push(request);
      return preparedExecution() as unknown as Result;
    };

    await declarativeTxManifestExecutionAdapter.prepare(plan, {
      chainResolution: "declarative",
      origin: "https://example.test",
      descriptor: "descriptor-must-not-be-forwarded",
      network: "liquidtestnet",
      policyAssetId: ASSET,
      engine,
      resolveWalletDestination,
      resolveDeclarativeChainSnapshot: async () => chainSnapshot(),
    });

    expect(resolveWalletDestination).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      kind: "prepareDeclarativeTxManifest",
      signingMode: "none",
      walletDestination: destination,
    });
    expect(requests[0]).not.toHaveProperty("descriptor");
  });

  it("dry-runs every declared covenant against the exact final transaction and parents", async () => {
    const plan = await resolveTxManifestRequirementsWithAdapter(
      await invocation("publisher", "generic.Verify"),
    );
    if (plan.planVersion !== "apogee-declarative-requirements/v1") {
      throw new Error("expected declarative plan");
    }
    const prepared = preparedExecution();
    const calls: unknown[] = [];
    const engine: TxManifestAdapterEngine = async <Result>(
      request: TxManifestAdapterEngineRequest,
    ) => {
      calls.push(request);
      return true as Result;
    };
    await declarativeTxManifestExecutionAdapter.verifyFinalTransaction(
      {
        adapterId: DECLARATIVE_TX_MANIFEST_ADAPTER_ID,
        signingMode: "none",
        kind: "declarative",
        plan,
        prepared,
        genesisHash: GENESIS,
      },
      "deadbeef",
      engine,
    );

    expect(calls).toHaveLength(2);
    for (const [index, call] of calls.entries()) {
      expect(call).toMatchObject({
        kind: "dryRunTxManifestCovenant",
        spec: {
          input_index: index,
          transaction_hex: "deadbeef",
          parent_transactions: prepared.parentTransactions,
        },
      });
    }
  });
});
