import { describe, expect, it } from "vitest";
import {
  SIMPLICITY_LENDING_V3_CREATE_OFFER,
  SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER,
  SIMPLICITY_LENDING_V3_REPAY_LOAN,
  SIMPLICITY_LENDING_V3_TESTNET_CHAIN,
} from "./builtins/simplicity-lending-v3";
import type {
  LendingV3AcceptOfferCovenants,
  LendingV3IssuanceFactory,
} from "./lending-v3";
import { prepareLendingV3CreateOffer } from "./prepare-create";
import { prepareLendingV3BorrowerAction } from "./prepare-lending-action";
import { SIMPLICITY_LENDING_V3_BUNDLE_HASH } from "./registry";
import { resolveTxManifestRequirements, type TxManifestInvocation } from "./requirements";
import type {
  TxManifestCovenantCommitments,
  TxManifestCovenantFinalizeSpec,
  TxManifestPsetBuildSpec,
} from "./runtime";

const POLICY = "144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49";
const COLLATERAL = "77".repeat(32);
const BORROWER = "88".repeat(32);
const LENDER = "99".repeat(32);
const FACTORY = "11".repeat(32);
const OFFER_TXID = "55".repeat(32);
const BLINDING_KEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

function commitment(label: string): TxManifestCovenantCommitments {
  const hash = label.charCodeAt(0).toString(16).padStart(64, "0");
  return {
    cmr: hash,
    tapleaf_hash: hash,
    merkle_root: hash,
    script_pub_key: `${label}00`,
    script_hash: hash,
    address: label,
  };
}

function covenants(): LendingV3AcceptOfferCovenants {
  return {
    currentDebt: "200",
    finalizedLenderVault: commitment("a"),
    lenderVault: commitment("b"),
    finalizedProtocolFeeVault: commitment("c"),
    protocolFeeVault: commitment("d"),
    principalOutput: commitment("p"),
    pendingOffer: commitment("o"),
    activeOffer: commitment("x"),
    lenderNftAuthorization: commitment("n"),
    principalArguments: { A: { value: "1", type: "u64" } },
    lendingArguments: { A: { value: "1", type: "u64" } },
  };
}

function factory(): LendingV3IssuanceFactory {
  return {
    covenant: commitment("f"),
    arguments: {
      ISSUING_UTXOS_COUNT: { value: "2", type: "u8" },
      REISSUANCE_FLAGS: { value: "0", type: "u64" },
    },
  };
}

function baseInvocation(action: string): TxManifestInvocation {
  return {
    protocolVersion: "0.1",
    requestId: `test-${action}`,
    chainId: SIMPLICITY_LENDING_V3_TESTNET_CHAIN,
    accountIdentifier: `${SIMPLICITY_LENDING_V3_TESTNET_CHAIN}:wallet-test`,
    manifest: { bundleHash: SIMPLICITY_LENDING_V3_BUNDLE_HASH },
    action,
    arguments: {
      COLLATERAL_ASSET_ID: COLLATERAL,
      PRINCIPAL_ASSET_ID: POLICY,
      BORROWER_NFT_ASSET_ID: BORROWER,
      LENDER_NFT_ASSET_ID: LENDER,
      PROTOCOL_FEE_KEEPER_ASSET_ID: POLICY,
      COLLATERAL_AMOUNT: "1000",
      PRINCIPAL_AMOUNT: "100",
      PRINCIPAL_INTEREST_RATE: "10000",
      LOAN_EXPIRATION_TIME: "2604140",
    },
    providedInputs: {},
    constraints: { maxFee: "1000" },
  };
}

function input(
  txid: string,
  vout: number,
  scriptPubKey: string,
  assetId: string,
  amount: string,
) {
  return { txid, vout, txOut: "00", scriptPubKey, assetId, amount };
}

describe("new lending action preparation", () => {
  it("creates an offer with one L-BTC input funding both collateral and fee", async () => {
    const invocation = baseInvocation(SIMPLICITY_LENDING_V3_CREATE_OFFER);
    invocation.arguments = {
      FACTORY_ASSET_ID: FACTORY,
      COLLATERAL_ASSET_ID: POLICY,
      PRINCIPAL_ASSET_ID: POLICY,
      PROTOCOL_FEE_KEEPER_ASSET_ID: POLICY,
      COLLATERAL_AMOUNT: "500",
      PRINCIPAL_AMOUNT: "100",
      PRINCIPAL_INTEREST_RATE: "10000",
      LOAN_EXPIRATION_TIME: "2604140",
    };
    invocation.providedInputs = {
      factory_auth_in: { txid: "22".repeat(32), vout: 0 },
      factory_covenant_in: { txid: "22".repeat(32), vout: 1 },
    };
    const plan = await resolveTxManifestRequirements(invocation);
    if (plan.action !== SIMPLICITY_LENDING_V3_CREATE_OFFER) throw new Error("wrong plan");
    const collateralAndFee = input("33".repeat(32), 4, "0014cc", POLICY, "2000");
    let buildSpec: TxManifestPsetBuildSpec | undefined;
    const finalizations: TxManifestCovenantFinalizeSpec[] = [];
    const prepared = await prepareLendingV3CreateOffer(
      plan,
      {
        genesisHash: "a771da8e52ee6ad581ed1e9a99825e5b3b7992225534eaa2ae23244fe26ab1c1",
        tipHeight: 2_601_000,
        policyAssetId: POLICY,
        assetContractDomain: "127.0.0.1",
        factoryAuthInput: input("22".repeat(32), 0, "0014aa", FACTORY, "1"),
        factoryCovenant: input("22".repeat(32), 1, factory().covenant.script_pub_key, FACTORY, "1"),
        collateralInput: collateralAndFee,
        feeInput: collateralAndFee,
        explicitWalletDestination: { scriptPubKey: "0014dd" },
        changeDestination: { scriptPubKey: "0014dd", blindingPublicKey: BLINDING_KEY },
        fee: "1000",
      },
      {
        compileFactory: async () => factory(),
        compileLending: async () => covenants(),
        deriveAsset: async (_domain, _outpoint, kind) => ({
          assetId: kind === "borrower-nft" ? BORROWER : LENDER,
          contractHash: kind === "borrower-nft" ? "ab".repeat(32) : "cd".repeat(32),
        }),
        buildPset: async spec => {
          buildSpec = spec;
          return "built";
        },
        finalizeCovenant: async spec => {
          finalizations.push(spec);
          return "finalized";
        },
      },
    );

    expect(buildSpec?.inputs).toHaveLength(3);
    expect(buildSpec?.inputs[1].issuance?.asset_amount).toBe("1");
    expect(buildSpec?.inputs[2].issuance?.asset_amount).toBe("1");
    expect(buildSpec?.outputs.at(-2)).toMatchObject({
      asset: POLICY,
      amount: "500",
      blinder_index: 2,
    });
    expect(buildSpec?.outputs.at(-1)).toMatchObject({
      script_pub_key: expect.stringMatching(/^6a35/),
      asset: POLICY,
      amount: "0",
    });
    expect(prepared.review).toMatchObject({ collateralChange: "500", feeChange: "0" });
    expect(finalizations.map(spec => spec.input_index)).toEqual([1]);
  });

  it("repays an L-BTC-denominated loan with one combined repayment and fee input", async () => {
    const invocation = baseInvocation(SIMPLICITY_LENDING_V3_REPAY_LOAN);
    invocation.providedInputs = {
      borrower_nft_in: { txid: "44".repeat(32), vout: 0 },
      active_offer_in: { txid: OFFER_TXID, vout: 0 },
    };
    const plan = await resolveTxManifestRequirements(invocation);
    if (plan.action !== SIMPLICITY_LENDING_V3_REPAY_LOAN) throw new Error("wrong plan");
    const repaymentAndFee = input("66".repeat(32), 2, "0014cc", POLICY, "500");
    let buildSpec: TxManifestPsetBuildSpec | undefined;
    const finalizations: TxManifestCovenantFinalizeSpec[] = [];
    const prepared = await prepareLendingV3BorrowerAction(
      plan,
      {
        kind: "repayLoan",
        genesisHash: "a771da8e52ee6ad581ed1e9a99825e5b3b7992225534eaa2ae23244fe26ab1c1",
        tipHeight: 2_604_140,
        policyAssetId: POLICY,
        activeOffer: input(OFFER_TXID, 0, covenants().activeOffer.script_pub_key, COLLATERAL, "1000"),
        borrowerNftInput: input("44".repeat(32), 0, "0014aa", BORROWER, "1"),
        repaymentInput: repaymentAndFee,
        feeInput: repaymentAndFee,
        walletDestination: { scriptPubKey: "0014dd", blindingPublicKey: BLINDING_KEY },
        explicitWalletDestination: { scriptPubKey: "0014dd" },
        principalChangeDestination: { scriptPubKey: "0014dd", blindingPublicKey: BLINDING_KEY },
        feeChangeDestination: { scriptPubKey: "0014dd", blindingPublicKey: BLINDING_KEY },
        fee: "100",
      },
      {
        compileCovenants: async () => covenants(),
        buildPset: async spec => {
          buildSpec = spec;
          return "built";
        },
        finalizeCovenant: async spec => {
          finalizations.push(spec);
          return "finalized";
        },
      },
    );

    expect(buildSpec?.inputs).toHaveLength(3);
    expect(buildSpec?.outputs[3]).toMatchObject({ asset: COLLATERAL, blinder_index: 1 });
    expect(buildSpec?.outputs[4]).toMatchObject({ asset: POLICY, amount: "200", blinder_index: 2 });
    expect(prepared.review).toMatchObject({ principalChange: "200", feeChange: "0" });
    expect(finalizations[0]?.extra_leaf_payloads[0]).toBe(`${"00".repeat(31)}01`);
  });

  it("binds liquidation to the expiration locktime and a non-final covenant sequence", async () => {
    const invocation = baseInvocation(SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER);
    invocation.providedInputs = {
      lender_nft_in: { txid: "99".repeat(32), vout: 2 },
      active_offer_in: { txid: OFFER_TXID, vout: 0 },
    };
    const plan = await resolveTxManifestRequirements(invocation);
    if (plan.action !== SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER) throw new Error("wrong plan");
    let buildSpec: TxManifestPsetBuildSpec | undefined;
    const finalizations: TxManifestCovenantFinalizeSpec[] = [];
    await prepareLendingV3BorrowerAction(
      plan,
      {
        kind: "liquidateOffer",
        genesisHash: "a771da8e52ee6ad581ed1e9a99825e5b3b7992225534eaa2ae23244fe26ab1c1",
        tipHeight: 2_604_140,
        policyAssetId: POLICY,
        activeOffer: input(OFFER_TXID, 0, covenants().activeOffer.script_pub_key, COLLATERAL, "1000"),
        lenderNftInput: input("99".repeat(32), 2, "0014aa", LENDER, "1"),
        feeInput: input("aa".repeat(32), 3, "0014bb", POLICY, "1100"),
        walletDestination: { scriptPubKey: "0014dd", blindingPublicKey: BLINDING_KEY },
        explicitWalletDestination: { scriptPubKey: "0014dd" },
        feeChangeDestination: { scriptPubKey: "0014dd", blindingPublicKey: BLINDING_KEY },
        fee: "1000",
      },
      {
        compileCovenants: async () => covenants(),
        buildPset: async spec => {
          buildSpec = spec;
          return "built";
        },
        finalizeCovenant: async spec => {
          finalizations.push(spec);
          return "finalized";
        },
      },
    );

    expect(buildSpec?.locktime).toBe(2_604_140);
    expect(buildSpec?.inputs[0].sequence).toBe(0xffff_fffe);
    expect(finalizations[0]?.extra_leaf_payloads[0]).toBe(`${"00".repeat(31)}01`);
  });
});
