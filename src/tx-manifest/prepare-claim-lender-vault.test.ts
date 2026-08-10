import { describe, expect, it } from "vitest";
import {
  SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT,
  SIMPLICITY_LENDING_V3_TESTNET_CHAIN,
} from "./builtins/simplicity-lending-v3";
import type { LendingV3FinalizedLenderVault } from "./lending-v3";
import {
  prepareLendingV3ClaimLenderVault,
  type ClaimLenderVaultChainWalletSnapshot,
} from "./prepare-claim-lender-vault";
import { SIMPLICITY_LENDING_V3_BUNDLE_HASH } from "./registry";
import {
  resolveTxManifestRequirements,
  type ClaimLenderVaultRequirementPlan,
  type TxManifestInvocation,
} from "./requirements";
import type {
  TxManifestCovenantFinalizeSpec,
  TxManifestPsetBuildSpec,
} from "./runtime";

const POLICY = "144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49";
const PRINCIPAL = "38fca2d939696061a8f76d4e6b5eecd54e3b4221c846f24a6b279e79952850a5";
const BORROWER = "8734a76badb98fd22150ec9a537684dd3824c30d80b2bcc1f4b0ff635fa8d97c";
const LENDER = "99396282d5ef54a51a1d9ceebd20710b6eb9a47055b275db4e8d1a7334c14502";
const VAULT_TXID = "44".repeat(32);
const NFT_TXID = "55".repeat(32);

function invocation(): TxManifestInvocation {
  return {
    protocolVersion: "0.1",
    requestId: "claim-3",
    chainId: SIMPLICITY_LENDING_V3_TESTNET_CHAIN,
    accountIdentifier: `${SIMPLICITY_LENDING_V3_TESTNET_CHAIN}:wallet-test`,
    manifest: { bundleHash: SIMPLICITY_LENDING_V3_BUNDLE_HASH },
    action: SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT,
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
      lender_vault_in: { txid: VAULT_TXID, vout: 1 },
      lender_nft_in: { txid: NFT_TXID, vout: 2 },
    },
    constraints: { maxFee: "500", validUntilHeight: 2_601_100 },
  };
}

async function requirementPlan(): Promise<ClaimLenderVaultRequirementPlan> {
  const plan = await resolveTxManifestRequirements(invocation());
  if (plan.action !== SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT) {
    throw new Error("Expected ClaimLenderVault requirement plan.");
  }
  return plan;
}

function vault(): LendingV3FinalizedLenderVault {
  return {
    covenant: {
      cmr: "11".repeat(32),
      tapleaf_hash: "22".repeat(32),
      merkle_root: "22".repeat(32),
      script_pub_key: `5120${"22".repeat(32)}`,
      script_hash: "33".repeat(32),
      address: "tlq1vault",
    },
    arguments: { VAULT_ASSET_ID: { value: `0x${PRINCIPAL}`, type: "u256" } },
  };
}

function snapshot(compiled = vault()): ClaimLenderVaultChainWalletSnapshot {
  return {
    genesisHash: "a771da8e52ee6ad581ed1e9a99825e5b3b7992225534eaa2ae23244fe26ab1c1",
    tipHeight: 2_601_000,
    policyAssetId: POLICY,
    lenderVault: {
      txid: VAULT_TXID,
      vout: 1,
      txOut: "00",
      scriptPubKey: compiled.covenant.script_pub_key,
      assetId: PRINCIPAL,
      amount: "190",
    },
    lenderNftInput: {
      txid: NFT_TXID,
      vout: 2,
      txOut: "00",
      scriptPubKey: "001411",
      assetId: LENDER,
      amount: "1",
    },
    feeInput: {
      txid: "66".repeat(32),
      vout: 0,
      txOut: "00",
      scriptPubKey: "001422",
      assetId: POLICY,
      amount: "1000",
    },
    principalDestination: {
      scriptPubKey: "0014aa",
      blindingPublicKey: `02${"aa".repeat(32)}`,
    },
    feeChangeDestination: {
      scriptPubKey: "0014bb",
      blindingPublicKey: `02${"bb".repeat(32)}`,
    },
    fee: "305",
  };
}

describe("ClaimLenderVault preparation", () => {
  it("derives the exact net repayment and binds vault, NFT burn, recipient, and fee", async () => {
    const plan = await requirementPlan();
    expect(plan.intent).toMatchObject({
      grossDebt: "200",
      interestAmount: "100",
      protocolFeeAmount: "10",
      principalAmount: "190",
    });
    const compiled = vault();
    let buildSpec: TxManifestPsetBuildSpec | undefined;
    let finalization: TxManifestCovenantFinalizeSpec | undefined;
    const prepared = await prepareLendingV3ClaimLenderVault(plan, snapshot(compiled), {
      compileVault: async () => compiled,
      buildPset: async (spec) => {
        buildSpec = spec;
        return "built";
      },
      finalizeCovenant: async (spec) => {
        finalization = spec;
        return "finalized";
      },
    });
    expect(prepared.pset).toBe("finalized");
    expect(buildSpec?.inputs.map(({ txid, vout }) => ({ txid, vout }))).toEqual([
      { txid: VAULT_TXID, vout: 1 },
      { txid: NFT_TXID, vout: 2 },
      { txid: "66".repeat(32), vout: 0 },
    ]);
    expect(buildSpec?.outputs).toMatchObject([
      { script_pub_key: "6a046275726e", asset: LENDER, amount: "1" },
      { script_pub_key: "0014aa", asset: PRINCIPAL, amount: "190", blinder_index: 0 },
      { script_pub_key: "0014bb", asset: POLICY, amount: "695", blinder_index: 2 },
    ]);
    expect(finalization).toMatchObject({
      input_index: 0,
      witnesses: { PATH: { value: "Left(Left((1, 0)))" } },
    });
    expect(prepared.review).toMatchObject({ principalAmount: "190", fee: "305", feeChange: "695" });
    expect(prepared.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects a vault that does not match the trusted offer instance", async () => {
    const plan = await requirementPlan();
    const compiled = vault();
    const stale = snapshot(compiled);
    stale.lenderVault.amount = "189";
    await expect(
      prepareLendingV3ClaimLenderVault(plan, stale, {
        compileVault: async () => compiled,
        buildPset: async () => {
          throw new Error("must not build");
        },
        finalizeCovenant: async () => {
          throw new Error("must not finalize");
        },
      }),
    ).rejects.toThrow(/trusted covenant commitment/);
  });
});
