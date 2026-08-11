import { describe, expect, it } from "vitest";
import {
  SIMPLICITY_LENDING_V3_ACCEPT_OFFER,
  SIMPLICITY_LENDING_V3_TESTNET_CHAIN,
} from "./builtins/simplicity-lending-v3";
import type { LendingV3AcceptOfferCovenants } from "./lending-v3";
import {
  prepareLendingV3AcceptOffer,
  type AcceptOfferChainWalletSnapshot,
} from "./prepare-accept-offer";
import { SIMPLICITY_LENDING_V3_BUNDLE_HASH } from "./registry";
import { resolveTxManifestRequirements, type TxManifestInvocation } from "./requirements";
import type {
  TxManifestCovenantCommitments,
  TxManifestCovenantFinalizeSpec,
  TxManifestPsetBuildSpec,
} from "./runtime";

const POLICY = "144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49";
const PRINCIPAL = "38fca2d939696061a8f76d4e6b5eecd54e3b4221c846f24a6b279e79952850a5";
const BORROWER = "8734a76badb98fd22150ec9a537684dd3824c30d80b2bcc1f4b0ff635fa8d97c";
const LENDER = "99396282d5ef54a51a1d9ceebd20710b6eb9a47055b275db4e8d1a7334c14502";
const OFFER_TXID = "baa0de011d4addd0ab4bf0b00c34bb797f67487be7517136af04ac39b184bff1";

function invocation(): TxManifestInvocation {
  return {
    protocolVersion: "0.1",
    requestId: "accept-3",
    chainId: SIMPLICITY_LENDING_V3_TESTNET_CHAIN,
    accountIdentifier: `${SIMPLICITY_LENDING_V3_TESTNET_CHAIN}:wallet-test`,
    manifest: { bundleHash: SIMPLICITY_LENDING_V3_BUNDLE_HASH },
    action: "lending_contract.AcceptOffer",
    arguments: {
      COLLATERAL_ASSET_ID: POLICY,
      PRINCIPAL_ASSET_ID: PRINCIPAL,
      BORROWER_NFT_ASSET_ID: BORROWER,
      LENDER_NFT_ASSET_ID: LENDER,
      PROTOCOL_FEE_KEEPER_ASSET_ID: PRINCIPAL,
      COLLATERAL_AMOUNT: "1000",
      PRINCIPAL_AMOUNT: "100",
      PRINCIPAL_INTEREST_RATE: "10000",
      LOAN_EXPIRATION_TIME: "2604140",
    },
    providedInputs: {
      pending_offer_in: { txid: OFFER_TXID, vout: 5 },
      lender_nft_in: { txid: OFFER_TXID, vout: 3 },
    },
    constraints: { maxFee: "500", validUntilHeight: 2_601_100 },
  };
}

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

function snapshot(covs = covenants()): AcceptOfferChainWalletSnapshot {
  return {
    genesisHash: "a771da8e52ee6ad581ed1e9a99825e5b3b7992225534eaa2ae23244fe26ab1c1",
    tipHeight: 2_601_000,
    policyAssetId: POLICY,
    pendingOffer: {
      txid: OFFER_TXID,
      vout: 5,
      txOut: "00",
      scriptPubKey: covs.pendingOffer.script_pub_key,
      assetId: POLICY,
      amount: "1000",
    },
    lenderNftAuthorization: {
      txid: OFFER_TXID,
      vout: 3,
      txOut: "00",
      scriptPubKey: covs.lenderNftAuthorization.script_pub_key,
      assetId: LENDER,
      amount: "1",
    },
    principalInputs: [
      {
        txid: "22".repeat(32),
        vout: 4,
        txOut: "00",
        scriptPubKey: "001411",
        assetId: PRINCIPAL,
        amount: "60",
      },
      {
        txid: "23".repeat(32),
        vout: 1,
        txOut: "00",
        scriptPubKey: "001412",
        assetId: PRINCIPAL,
        amount: "90",
      },
    ],
    feeInputs: [
      {
        txid: "33".repeat(32),
        vout: 2,
        txOut: "00",
        scriptPubKey: "001422",
        assetId: POLICY,
        amount: "300",
      },
      {
        txid: "34".repeat(32),
        vout: 0,
        txOut: "00",
        scriptPubKey: "001423",
        assetId: POLICY,
        amount: "700",
      },
    ],
    lenderNftDestination: { scriptPubKey: "0014aa" },
    principalChangeDestination: { scriptPubKey: "0014bb" },
    feeChangeDestination: { scriptPubKey: "0014cc" },
    fee: "305",
  };
}

async function requirementPlan() {
  const plan = await resolveTxManifestRequirements(invocation());
  if (plan.action !== SIMPLICITY_LENDING_V3_ACCEPT_OFFER) {
    throw new Error("Expected AcceptOffer requirement plan.");
  }
  return plan;
}

describe("AcceptOffer preparation", () => {
  it("binds exact inputs, outputs, fee, and both covenant finalizations", async () => {
    const plan = await requirementPlan();
    const covs = covenants();
    let buildSpec: TxManifestPsetBuildSpec | undefined;
    const finalizations: TxManifestCovenantFinalizeSpec[] = [];
    const runtime = {
      compileCovenants: async () => covs,
      buildPset: async (spec: TxManifestPsetBuildSpec) => {
        buildSpec = spec;
        return "built";
      },
      finalizeCovenant: async (spec: TxManifestCovenantFinalizeSpec) => {
        finalizations.push(spec);
        return `${spec.pset}-${spec.input_index}`;
      },
    };
    const prepared = await prepareLendingV3AcceptOffer(plan, snapshot(covs), runtime);
    expect(prepared.pset).toBe("built-0-1");
    expect(prepared.review).toMatchObject({
      principalAmount: "100",
      totalDebt: "200",
      fee: "305",
      principalChange: "50",
      feeChange: "695",
    });
    expect(buildSpec?.inputs.map(({ txid, vout }) => ({ txid, vout }))).toEqual([
      { txid: OFFER_TXID, vout: 5 },
      { txid: OFFER_TXID, vout: 3 },
      { txid: "22".repeat(32), vout: 4 },
      { txid: "23".repeat(32), vout: 1 },
      { txid: "33".repeat(32), vout: 2 },
      { txid: "34".repeat(32), vout: 0 },
    ]);
    expect(buildSpec?.outputs.map(({ script_pub_key, amount }) => ({ script_pub_key, amount }))).toEqual([
      { script_pub_key: covs.activeOffer.script_pub_key, amount: "1000" },
      { script_pub_key: covs.principalOutput.script_pub_key, amount: "100" },
      { script_pub_key: "0014aa", amount: "1" },
      { script_pub_key: "0014bb", amount: "50" },
      { script_pub_key: "0014cc", amount: "695" },
      { script_pub_key: expect.stringMatching(/^6a35/), amount: "0" },
    ]);
    expect(finalizations.map(({ input_index }) => input_index)).toEqual([0, 1]);
    expect(prepared.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects stale covenant state and fee-policy violations before building", async () => {
    const plan = await requirementPlan();
    const covs = covenants();
    const stale = snapshot(covs);
    stale.pendingOffer.scriptPubKey = "51";
    const runtime = {
      compileCovenants: async () => covs,
      buildPset: async () => {
        throw new Error("must not build");
      },
      finalizeCovenant: async () => {
        throw new Error("must not finalize");
      },
    };
    await expect(prepareLendingV3AcceptOffer(plan, stale, runtime)).rejects.toThrow(
      /trusted covenant commitment/,
    );

    const expensive = snapshot(covs);
    expensive.fee = "501";
    await expect(prepareLendingV3AcceptOffer(plan, expensive, runtime)).rejects.toThrow(
      /approved maximum/,
    );
  });
});
