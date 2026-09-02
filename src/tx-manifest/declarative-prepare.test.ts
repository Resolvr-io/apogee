import { describe, expect, it, vi } from "vitest";
import { txManifestBundleHash, type TxManifestBundle } from "./bundle";
import type { DeclarativeChainSnapshot } from "./declarative-chain";
import { resolveDeclarativeRequirements } from "./declarative-plan";
import {
  prepareDeclarativeExecution,
  type DeclarativePreparationRuntime,
  type DeclarativePreparationSnapshot,
} from "./declarative-prepare";

const CHAIN = `bip122:${"11".repeat(16)}`;
const GENESIS = "11".repeat(32);
const ASSET = "22".repeat(32);
const TXID = "33".repeat(32);
const COVENANT_SCRIPT = `5120${"44".repeat(32)}`;
const PAYOUT_SCRIPT = `0014${"55".repeat(20)}`;

function baseBundle(action: string, recipe: Record<string, unknown>): TxManifestBundle {
  return {
    schema: "apogee-tx-manifest-bundle/v1",
    manifestSpec: { id: "elip-205-draft", revision: "1a8d0b759853a00fef5f74351b64a602e2ba7a6f" },
    compiler: { id: "simplicityhl", revision: "9e77379d343e76eb92cb57c2668af9f8e0c4f46b", debugSymbols: false },
    extensions: ["apogee-declarative-transaction/v1"],
    manifest: {
      manifest_version: "0.1.0",
      protocol: "publisher-example",
      actions: { [action]: { description: "Publisher prose only." } },
      x_apogee_declarative: {
        version: 1,
        chains: [CHAIN],
        actions: { [action]: recipe },
      },
    },
    sources: { "contract.simf": "fn main() {}\n" },
  };
}

function runtime() {
  const buildPset = vi.fn(async (_spec: Parameters<DeclarativePreparationRuntime["buildPset"]>[0]) => "pset-built");
  const finalizeCovenant = vi.fn(async (_spec: Parameters<DeclarativePreparationRuntime["finalizeCovenant"]>[0]) => "pset-finalized");
  const estimateFee = vi.fn(async (_spec: Parameters<DeclarativePreparationRuntime["estimateFee"]>[0]) => ({
    discountVsize: 100,
    requiredFee: "5",
    unsignedWalletInputs: 1,
  }));
  const compileCovenant = vi.fn(async (_spec: Parameters<DeclarativePreparationRuntime["compileCovenant"]>[0]) => ({
    cmr: "66".repeat(32),
    tapleaf_hash: "77".repeat(32),
    merkle_root: "88".repeat(32),
    script_pub_key: COVENANT_SCRIPT,
    script_hash: "99".repeat(32),
    address: "ert1pexample",
  }));
  return {
    value: { buildPset, finalizeCovenant, estimateFee, compileCovenant } satisfies DeclarativePreparationRuntime,
    buildPset,
    finalizeCovenant,
    estimateFee,
    compileCovenant,
  };
}

async function plan(
  action: string,
  bundle: TxManifestBundle,
  args: Record<string, unknown>,
  providedInputs?: Record<string, { txid: string; vout: number }>,
) {
  return resolveDeclarativeRequirements({
    protocolVersion: "0.1",
    requestId: "request-1",
    chainId: CHAIN,
    accountIdentifier: `${CHAIN}:wallet`,
    manifest: { bundleHash: await txManifestBundleHash(bundle), bundle },
    action,
    arguments: args,
    ...(providedInputs ? { providedInputs } : {}),
    constraints: { maxFee: "20" },
  });
}

function chain(inputs: DeclarativeChainSnapshot["inputs"]): DeclarativeChainSnapshot {
  return {
    genesisHash: GENESIS,
    tipHeight: 100,
    feeRateSatPerKvb: "100",
    inputs,
    parentTransactions: inputs.map((input) => input.transactionHex),
  };
}

describe("declarative preparation", () => {
  it("builds a keyless fixed-fee covenant action with a wallet payout", async () => {
    const action = "renamed.CloseEquivalent";
    const recipe = {
      arguments: { ASSET: "asset_id", PAYOUT: "u64", RESERVE: "u64" },
      inputs: [
        {
          kind: "provided",
          id: "state",
          provided_input: "state_in",
          authorization: "covenant",
          expect: {
            asset: { op: "arg", name: "ASSET" },
            amount: {
              op: "add",
              left: { op: "arg", name: "PAYOUT" },
              right: { op: "arg", name: "RESERVE" },
            },
          },
          sequence: { op: "uint", value: "2" },
        },
      ],
      outputs: [
        {
          kind: "wallet",
          asset: { op: "arg", name: "ASSET" },
          amount: { op: "arg", name: "PAYOUT" },
          confidential: false,
        },
        { kind: "txmf", asset: { op: "arg", name: "ASSET" } },
      ],
      fee: {
        mode: "fixed",
        asset: { op: "arg", name: "ASSET" },
        amount: { op: "arg", name: "RESERVE" },
        output_index: 1,
      },
      covenant_witnesses: [
        {
          input: "state",
          source: "contract.simf",
          arguments: {},
          extra_leaf_payloads: [],
          witnesses: { PATH: { kind: "right", value: { kind: "unit" } } },
        },
      ],
    };
    const bundle = baseBundle(action, recipe);
    const resolved = await plan(
      action,
      bundle,
      { ASSET, PAYOUT: "100", RESERVE: "10" },
      { state_in: { txid: TXID, vout: 0 } },
    );
    const chainInput = {
      id: "state",
      txid: TXID,
      vout: 0,
      txOut: "aa",
      scriptPubKey: COVENANT_SCRIPT,
      assetId: ASSET,
      amount: "110",
      transactionHex: "0200000000",
      confirmed: true,
      blockHeight: 90,
    } as const;
    const snapshot: DeclarativePreparationSnapshot = {
      network: "elements-regtest",
      genesisHash: GENESIS,
      tipHeight: 100,
      policyAssetId: ASSET,
      chain: chain([chainInput]),
      walletCandidates: [],
      walletDestination: {
        scriptPubKey: PAYOUT_SCRIPT,
        blindingPublicKey: `02${"55".repeat(32)}`,
      },
      feePolicy: { feeRateSatPerKvb: "100", maxFee: "20" },
    };
    const mocked = runtime();
    const prepared = await prepareDeclarativeExecution(resolved, snapshot, mocked.value);
    expect(prepared.review.signingMode).toBe("none");
    expect(prepared.review.outputs.map(({ index, role }) => [index, role])).toEqual([
      [0, "wallet"],
      [2, "txmf"],
    ]);
    expect(prepared.review.walletBalanceChanges).toEqual({ [ASSET]: "100" });
    expect(prepared.review.fee).toBe("10");
    expect(mocked.buildPset).toHaveBeenCalledWith(expect.objectContaining({
      fee: { asset: ASSET, amount: "10", output_index: 1 },
    }));
    expect(mocked.finalizeCovenant).toHaveBeenCalledOnce();
    expect(mocked.estimateFee).not.toHaveBeenCalled();
  });

  it("converges an estimated fee and derives confidential wallet change", async () => {
    const action = "another.StartEquivalent";
    const recipe = {
      arguments: { ASSET: "asset_id", AMOUNT: "u64" },
      inputs: [
        {
          kind: "wallet",
          id: "funding",
          asset: { op: "arg", name: "ASSET" },
          amount: { op: "arg", name: "AMOUNT" },
          amount_mode: "minimum",
          script_type: "p2wpkh",
        },
      ],
      outputs: [
        {
          kind: "covenant",
          source: "contract.simf",
          arguments: {},
          extra_leaf_payloads: [],
          asset: { op: "arg", name: "ASSET" },
          amount: { op: "arg", name: "AMOUNT" },
          confidential: false,
        },
        {
          kind: "change",
          asset: { op: "arg", name: "ASSET" },
          confidential: true,
          minimum: { op: "uint", value: "7" },
        },
        { kind: "txmf", asset: { op: "arg", name: "ASSET" } },
      ],
      fee: {
        mode: "estimate",
        asset: { op: "arg", name: "ASSET" },
        max_amount: { op: "uint", value: "20" },
      },
      covenant_witnesses: [],
    };
    const bundle = baseBundle(action, recipe);
    const resolved = await plan(action, bundle, { ASSET, AMOUNT: "100" });
    const snapshot: DeclarativePreparationSnapshot = {
      network: "elements-regtest",
      genesisHash: GENESIS,
      tipHeight: 100,
      policyAssetId: ASSET,
      chain: chain([]),
      walletCandidates: [
        {
          txid: TXID,
          vout: 1,
          txOut: "bb",
          scriptPubKey: PAYOUT_SCRIPT,
          assetId: ASSET,
          amount: "125",
          assetBlindingFactor: "66".repeat(32),
          valueBlindingFactor: "77".repeat(32),
          address: "el1qqexample",
          parentTransaction: "0200000001",
        },
      ],
      walletDestination: {
        scriptPubKey: `0014${"88".repeat(20)}`,
        blindingPublicKey: `02${"99".repeat(32)}`,
      },
      feePolicy: { feeRateSatPerKvb: "100", maxFee: "20" },
    };
    const mocked = runtime();
    const prepared = await prepareDeclarativeExecution(resolved, snapshot, mocked.value);
    expect(prepared.review.signingMode).toBe("wallet");
    expect(prepared.review.fee).toBe("5");
    expect(prepared.review.outputs.find((output) => output.role === "change")).toMatchObject({
      amount: "20",
      confidential: true,
      walletOwned: true,
    });
    expect(mocked.buildPset).toHaveBeenCalledTimes(2);
    expect(mocked.compileCovenant).toHaveBeenCalledTimes(1);
    expect(mocked.buildPset.mock.calls[1]?.[0]).toMatchObject({
      fee: { asset: ASSET, amount: "5", output_index: 3 },
      outputs: expect.arrayContaining([
        expect.objectContaining({ amount: "20", blinder_index: 0 }),
      ]),
    });
  });

  it("estimates a fully finalized keyless action and pays explicit wallet change", async () => {
    const action = "generic.KeylessEstimate";
    const recipe = {
      arguments: { ASSET: "asset_id" },
      inputs: [{
        kind: "provided",
        id: "state",
        provided_input: "state_in",
        authorization: "covenant",
        expect: {
          asset: { op: "arg", name: "ASSET" },
          amount: { op: "uint", value: "110" },
        },
      }],
      outputs: [
        {
          kind: "script",
          asset: { op: "arg", name: "ASSET" },
          amount: { op: "uint", value: "100" },
          script: { op: "bytes", value: PAYOUT_SCRIPT },
          confidential: false,
        },
        {
          kind: "change",
          asset: { op: "arg", name: "ASSET" },
          confidential: false,
        },
      ],
      fee: {
        mode: "estimate",
        asset: { op: "arg", name: "ASSET" },
        max_amount: { op: "uint", value: "10" },
      },
      covenant_witnesses: [{
        input: "state",
        source: "contract.simf",
        arguments: {},
        extra_leaf_payloads: [],
        witnesses: { PATH: { kind: "right", value: { kind: "unit" } } },
      }],
    };
    const bundle = baseBundle(action, recipe);
    const resolved = await plan(
      action,
      bundle,
      { ASSET },
      { state_in: { txid: TXID, vout: 0 } },
    );
    const snapshot: DeclarativePreparationSnapshot = {
      network: "elements-regtest",
      genesisHash: GENESIS,
      tipHeight: 100,
      policyAssetId: ASSET,
      chain: chain([{
        id: "state",
        txid: TXID,
        vout: 0,
        txOut: "aa",
        scriptPubKey: COVENANT_SCRIPT,
        assetId: ASSET,
        amount: "110",
        transactionHex: "0200000000",
        confirmed: true,
        blockHeight: 90,
      }]),
      walletCandidates: [],
      walletDestination: {
        scriptPubKey: `0014${"88".repeat(20)}`,
        blindingPublicKey: `02${"99".repeat(32)}`,
      },
      feePolicy: { feeRateSatPerKvb: "100", maxFee: "20" },
    };
    const mocked = runtime();
    mocked.estimateFee.mockImplementation(async ({ pset }) => {
      expect(pset).toBe("pset-finalized");
      return { discountVsize: 100, requiredFee: "5", unsignedWalletInputs: 0 };
    });

    const prepared = await prepareDeclarativeExecution(resolved, snapshot, mocked.value);

    expect(prepared.review).toMatchObject({
      signingMode: "none",
      fee: "5",
      feeChange: "5",
      walletBalanceChanges: { [ASSET]: "5" },
    });
    expect(prepared.review.outputs).toContainEqual(expect.objectContaining({
      role: "change",
      amount: "5",
      walletOwned: true,
      confidential: false,
    }));
    expect(mocked.buildPset).toHaveBeenCalledTimes(2);
    expect(mocked.finalizeCovenant).toHaveBeenCalledTimes(2);
    expect(mocked.estimateFee).toHaveBeenCalledTimes(2);
  });

  it("keeps exact wallet roles exact and assigns fees to a minimum role", async () => {
    const action = "generic.ExactThenFee";
    const recipe = {
      arguments: { ASSET: "asset_id" },
      inputs: [
        {
          kind: "wallet",
          id: "exact",
          asset: { op: "arg", name: "ASSET" },
          amount: { op: "uint", value: "100" },
          amount_mode: "exact",
          script_type: "p2wpkh",
        },
        {
          kind: "wallet",
          id: "fees",
          asset: { op: "arg", name: "ASSET" },
          amount: { op: "uint", value: "1" },
          amount_mode: "minimum",
          script_type: "p2wpkh",
        },
      ],
      outputs: [{
        kind: "script",
        asset: { op: "arg", name: "ASSET" },
        amount: { op: "uint", value: "101" },
        script: { op: "bytes", value: PAYOUT_SCRIPT },
        confidential: false,
      }],
      fee: {
        mode: "fixed",
        asset: { op: "arg", name: "ASSET" },
        amount: { op: "uint", value: "5" },
      },
      covenant_witnesses: [],
    };
    const bundle = baseBundle(action, recipe);
    const resolved = await plan(action, bundle, { ASSET });
    const secondTxid = "34".repeat(32);
    const snapshot: DeclarativePreparationSnapshot = {
      network: "elements-regtest",
      genesisHash: GENESIS,
      tipHeight: 100,
      policyAssetId: ASSET,
      chain: chain([]),
      walletCandidates: [
        {
          txid: TXID,
          vout: 0,
          txOut: "aa",
          scriptPubKey: PAYOUT_SCRIPT,
          assetId: ASSET,
          amount: "100",
          address: "el1exact",
          parentTransaction: "0200000001",
        },
        {
          txid: secondTxid,
          vout: 1,
          txOut: "bb",
          scriptPubKey: PAYOUT_SCRIPT,
          assetId: ASSET,
          amount: "6",
          address: "el1fees",
          parentTransaction: "0200000002",
        },
      ],
      feePolicy: { feeRateSatPerKvb: "100", maxFee: "20" },
    };
    const mocked = runtime();

    const prepared = await prepareDeclarativeExecution(resolved, snapshot, mocked.value);

    expect(prepared.review.signingMode).toBe("wallet");
    expect(mocked.buildPset).toHaveBeenCalledWith(expect.objectContaining({
      inputs: [
        expect.objectContaining({ amount: "100" }),
        expect.objectContaining({ amount: "6" }),
      ],
      fee: { asset: ASSET, amount: "5", output_index: 1 },
    }));
  });
});
