import { describe, expect, it } from "vitest";
import {
  SIMPLICITY_ROULETTE_V1_CLAIM_PAYOUT,
  SIMPLICITY_ROULETTE_V1_CMR,
  SIMPLICITY_ROULETTE_V1_OPEN,
  SIMPLICITY_ROULETTE_V1_SETTLE,
  SIMPLICITY_ROULETTE_V1_TAPLEAF_HASH,
  SIMPLICITY_ROULETTE_V1_TAKE,
} from "./builtins/simplicity-roulette-v1";
import { SIMPLICITY_LENDING_V3_TESTNET_CHAIN } from "./builtins/simplicity-lending-v3";
import { prepareRouletteV1Action } from "./prepare-roulette";
import { SIMPLICITY_ROULETTE_V1_BUNDLE_HASH } from "./registry";
import { decodeRouletteTransactionMetadata } from "./roulette-metadata";
import {
  resolveTxManifestRequirements,
  type RouletteClaimPayoutRequirementPlan,
  type RouletteOpenRequirementPlan,
  type RouletteSettleRequirementPlan,
  type RouletteTakeRequirementPlan,
  type TxManifestInvocation,
} from "./requirements";
import type {
  TxManifestCovenantCompileSpec,
  TxManifestCovenantFinalizeSpec,
  TxManifestPsetBuildSpec,
} from "./runtime";

const POLICY = "aa".repeat(32);
const ASSET = "22".repeat(32);
const ROUND = "11".repeat(32);
const PLAYER = `0014${"33".repeat(20)}`;
const HOUSE = `0014${"44".repeat(20)}`;
const SECRET = "55".repeat(32);
const NONCE = "66".repeat(32);
const COMMITMENT = "cf507d7e0c518cfb4b33a026308d5677e6d982b619f976edbaa452c1665f5577";
const GENESIS = "a7".repeat(32);
const CONFIDENTIAL = {
  scriptPubKey: `0014${"77".repeat(20)}`,
  blindingPublicKey: `02${"88".repeat(32)}`,
};

function terms(): Record<string, unknown> {
  return {
    ROUND_ID: ROUND,
    ASSET_ID: ASSET,
    SECRET_COMMITMENT: COMMITMENT,
    BET_KIND: 0,
    BET_SELECTION: 17,
    STAKE: "100000",
    BOND: "25000",
    OPEN_EXPIRY: 144,
    MIN_REVEAL_AGE: 2,
    REVEAL_EXPIRY: 20,
  };
}

function invocation(
  action: string,
  arguments_: Record<string, unknown>,
  providedInputs?: TxManifestInvocation["providedInputs"],
): TxManifestInvocation {
  return {
    protocolVersion: "0.1",
    requestId: `request-${action}`,
    chainId: SIMPLICITY_LENDING_V3_TESTNET_CHAIN,
    accountIdentifier: `${SIMPLICITY_LENDING_V3_TESTNET_CHAIN}:roulette-test`,
    manifest: { bundleHash: SIMPLICITY_ROULETTE_V1_BUNDLE_HASH },
    action,
    arguments: arguments_,
    providedInputs,
    constraints: { maxFee: "500", validUntilHeight: 500 },
  };
}

async function plans() {
  const open = await resolveTxManifestRequirements(invocation(SIMPLICITY_ROULETTE_V1_OPEN, terms()));
  const take = await resolveTxManifestRequirements(invocation(SIMPLICITY_ROULETTE_V1_TAKE, {
    ...terms(),
    PLAYER_PAYOUT_SCRIPT: PLAYER,
    HOUSE_NONCE: NONCE,
    HOUSE_COLLATERAL: "3500000",
  }, { open_in: { txid: "90".repeat(32), vout: 0 } }));
  const settle = await resolveTxManifestRequirements(invocation(SIMPLICITY_ROULETTE_V1_SETTLE, {
    ...terms(),
    PLAYER_PAYOUT_SCRIPT: PLAYER,
    HOUSE_PAYOUT_SCRIPT: HOUSE,
    HOUSE_NONCE: NONCE,
    HOUSE_COLLATERAL: "3500000",
    PLAYER_SECRET: SECRET,
  }, { active_in: { txid: "91".repeat(32), vout: 0 } }));
  const claim = await resolveTxManifestRequirements(invocation(SIMPLICITY_ROULETTE_V1_CLAIM_PAYOUT, {
    ROUND_ID: ROUND,
  }, { payout_in: { txid: "92".repeat(32), vout: 0 } }));
  if (
    open.action !== SIMPLICITY_ROULETTE_V1_OPEN ||
    take.action !== SIMPLICITY_ROULETTE_V1_TAKE ||
    settle.action !== SIMPLICITY_ROULETTE_V1_SETTLE ||
    claim.action !== SIMPLICITY_ROULETTE_V1_CLAIM_PAYOUT
  ) throw new Error("Unexpected roulette requirement plan.");
  return {
    open: open as RouletteOpenRequirementPlan,
    take: take as RouletteTakeRequirementPlan,
    settle: settle as RouletteSettleRequirementPlan,
    claim: claim as RouletteClaimPayoutRequirementPlan,
  };
}

function input(
  txid: string,
  assetId: string,
  amount: string,
  scriptPubKey: string,
  vout = 0,
) {
  return { txid, vout, txOut: "00", scriptPubKey, assetId, amount };
}

function runtime() {
  const builds: TxManifestPsetBuildSpec[] = [];
  const finalizations: TxManifestCovenantFinalizeSpec[] = [];
  return {
    builds,
    finalizations,
    adapter: {
      compile: async (spec: TxManifestCovenantCompileSpec) => {
        const stateWord = spec.extra_leaf_payloads[0]!;
        return {
          cmr: SIMPLICITY_ROULETTE_V1_CMR,
          tapleaf_hash: SIMPLICITY_ROULETTE_V1_TAPLEAF_HASH,
          merkle_root: stateWord,
          script_pub_key: `5120${stateWord}`,
          script_hash: stateWord,
          address: "ert1ptest",
        };
      },
      buildPset: async (spec: TxManifestPsetBuildSpec) => {
        builds.push(structuredClone(spec));
        return `built-${builds.length}`;
      },
      finalize: async (spec: TxManifestCovenantFinalizeSpec) => {
        finalizations.push(structuredClone(spec));
        return `${spec.pset}-final`;
      },
    },
  };
}

async function decoded(build: TxManifestPsetBuildSpec) {
  return decodeRouletteTransactionMetadata(
    [...build.outputs.map(({ script_pub_key }) => script_pub_key), ""],
    SIMPLICITY_ROULETTE_V1_BUNDLE_HASH,
  );
}

describe("roulette v1 preparation", () => {
  it("chooses the player script at Open and binds the first house collateral input at Take", async () => {
    const plan = await plans();
    const mock = runtime();
    const opened = await prepareRouletteV1Action(plan.open, {
      kind: "rouletteOpen",
      network: "liquid-testnet",
      genesisHash: GENESIS,
      tipHeight: 100,
      policyAssetId: POLICY,
      fundingInputs: [input("80".repeat(32), ASSET, "130000", PLAYER)],
      feeInputs: [input("81".repeat(32), POLICY, "1000", PLAYER)],
      playerDestination: { scriptPubKey: PLAYER },
      confidentialDestination: CONFIDENTIAL,
      fee: "300",
    }, mock.adapter);
    const openBuild = mock.builds[0]!;
    expect(openBuild.outputs[0]).toEqual({
      script_pub_key: expect.stringMatching(/^5120[0-9a-f]{64}$/),
      asset: ASSET,
      amount: "125000",
    });
    expect(opened.review).toMatchObject({ assetChange: "5000", feeChange: "700" });
    expect((await decoded(openBuild))?.metadata).toMatchObject({
      action: "open",
      playerPayoutScript: PLAYER,
      assetId: ASSET,
      secretCommitment: COMMITMENT,
      covenantVout: 0,
    });
    expect(mock.finalizations).toHaveLength(0);

    const taken = await prepareRouletteV1Action(plan.take, {
      kind: "rouletteTake",
      network: "liquid-testnet",
      genesisHash: GENESIS,
      tipHeight: 101,
      policyAssetId: POLICY,
      roundInput: input("90".repeat(32), ASSET, "125000", openBuild.outputs[0]!.script_pub_key),
      roundInputConfirmedHeight: 100,
      collateralInputs: [input("82".repeat(32), ASSET, "3500100", HOUSE)],
      feeInputs: [input("83".repeat(32), POLICY, "1000", HOUSE)],
      confidentialDestination: CONFIDENTIAL,
      fee: "300",
    }, mock.adapter);
    const takeBuild = mock.builds[1]!;
    expect(takeBuild.inputs.slice(0, 2).map(({ txid }) => txid)).toEqual([
      "90".repeat(32),
      "82".repeat(32),
    ]);
    expect(takeBuild.outputs[0]).toMatchObject({ asset: ASSET, amount: "3625000" });
    expect(taken.review).toMatchObject({ houseCollateral: "3500000", assetChange: "100", feeChange: "700" });
    expect((await decoded(takeBuild))?.metadata).toMatchObject({
      action: "take",
      housePayoutScript: HOUSE,
      houseNonce: NONCE,
      houseCollateral: "3500000",
      covenantVout: 0,
    });
    expect(mock.finalizations[0]?.input_index).toBe(0);
    expect(mock.finalizations[0]?.witnesses?.PATH.value).toMatch(/Left\(Left\(\(.+, 3500000, 1\)\)\)/);
  });

  it("builds exact direct Settle payouts and a bounded confidential ClaimPayout adapter", async () => {
    const plan = await plans();
    const mock = runtime();
    const activeStateWord = "99".repeat(32);
    const activeScript = `5120${activeStateWord}`;
    // The compile mock deterministically derives the real state word, so learn
    // that exact script from a failed-free Open/Take preparation sequence.
    const openMock = runtime();
    await prepareRouletteV1Action(plan.open, {
      kind: "rouletteOpen", network: "liquid-testnet", genesisHash: GENESIS, tipHeight: 100,
      policyAssetId: POLICY, fundingInputs: [input("84".repeat(32), ASSET, "125000", PLAYER)],
      feeInputs: [input("85".repeat(32), POLICY, "500", PLAYER)], playerDestination: { scriptPubKey: PLAYER },
      confidentialDestination: CONFIDENTIAL, fee: "300",
    }, openMock.adapter);
    await prepareRouletteV1Action(plan.take, {
      kind: "rouletteTake", network: "liquid-testnet", genesisHash: GENESIS, tipHeight: 100,
      policyAssetId: POLICY,
      roundInput: input("90".repeat(32), ASSET, "125000", openMock.builds[0]!.outputs[0]!.script_pub_key),
      roundInputConfirmedHeight: 99,
      collateralInputs: [input("86".repeat(32), ASSET, "3500000", HOUSE)],
      feeInputs: [input("87".repeat(32), POLICY, "500", HOUSE)],
      confidentialDestination: CONFIDENTIAL, fee: "300",
    }, openMock.adapter);
    const compiledActiveScript = openMock.builds[1]!.outputs[0]!.script_pub_key;
    expect(compiledActiveScript).not.toBe(activeScript);

    const settled = await prepareRouletteV1Action(plan.settle, {
      kind: "rouletteSettle",
      network: "liquid-testnet",
      genesisHash: GENESIS,
      tipHeight: 101,
      policyAssetId: POLICY,
      roundInput: input("91".repeat(32), ASSET, "3625000", compiledActiveScript),
      roundInputConfirmedHeight: 100,
      feeInputs: [input("88".repeat(32), POLICY, "1000", HOUSE)],
      confidentialDestination: CONFIDENTIAL,
      fee: "300",
    }, mock.adapter);
    const settleBuild = mock.builds[0]!;
    expect(settleBuild.inputs[0]?.sequence).toBe(2);
    expect(settleBuild.outputs.slice(0, 3)).toEqual([
      { script_pub_key: PLAYER, asset: ASSET, amount: "25000" },
      { script_pub_key: HOUSE, asset: ASSET, amount: "3600000" },
      expect.objectContaining({ script_pub_key: CONFIDENTIAL.scriptPubKey, asset: POLICY, amount: "700" }),
    ]);
    expect(settled.review).toMatchObject({ pocket: 7, playerAmount: "25000", houseAmount: "3600000" });
    expect((await decoded(settleBuild))?.metadata).toMatchObject({
      action: "settle",
      playerSecret: SECRET,
      pocket: 7,
    });

    const claimed = await prepareRouletteV1Action(plan.claim, {
      kind: "rouletteClaimPayout",
      network: "liquid-testnet",
      genesisHash: GENESIS,
      tipHeight: 102,
      policyAssetId: POLICY,
      payoutInput: input("92".repeat(32), ASSET, "25000", PLAYER),
      terminalAction: SIMPLICITY_ROULETTE_V1_SETTLE,
      feeInputs: [input("89".repeat(32), POLICY, "1000", HOUSE)],
      confidentialDestination: CONFIDENTIAL,
      fee: "300",
    }, mock.adapter);
    const claimBuild = mock.builds[1]!;
    expect(claimed.covenantExecutions).toHaveLength(0);
    expect(claimBuild.outputs[0]).toEqual({
      script_pub_key: CONFIDENTIAL.scriptPubKey,
      asset: ASSET,
      amount: "25000",
      blinding_public_key: CONFIDENTIAL.blindingPublicKey,
      blinder_index: 0,
    });
    expect(claimed.review).toMatchObject({
      payoutAmount: "25000",
      terminalAction: SIMPLICITY_ROULETTE_V1_SETTLE,
    });
    expect((await decoded(claimBuild))?.metadata).toMatchObject({
      action: "claimPayout",
      previous: { txid: "92".repeat(32), vout: 0 },
    });
  });
});
