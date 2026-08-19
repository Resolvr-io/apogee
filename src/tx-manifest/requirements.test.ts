import { describe, expect, it } from "vitest";
import {
  SIMPLICITY_LENDING_V3_ACCEPT_OFFER,
  SIMPLICITY_LENDING_V3_CREATE_FACTORY,
  SIMPLICITY_LENDING_V3_CREATE_OFFER,
  SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER,
  SIMPLICITY_LENDING_V3_REPAY_LOAN,
  SIMPLICITY_LENDING_V3_TESTNET_CHAIN,
} from "./builtins/simplicity-lending-v3";
import { SIMPLICITY_LENDING_V3_BUNDLE_HASH } from "./registry";
import { resolveTxManifestRequirements, type TxManifestInvocation } from "./requirements";

const OFFER_TXID = "baa0de011d4addd0ab4bf0b00c34bb797f67487be7517136af04ac39b184bff1";

function invocation(): TxManifestInvocation {
  return {
    protocolVersion: "0.1",
    requestId: "accept-offer-3",
    chainId: SIMPLICITY_LENDING_V3_TESTNET_CHAIN,
    accountIdentifier: `${SIMPLICITY_LENDING_V3_TESTNET_CHAIN}:wallet-test`,
    manifest: { bundleHash: SIMPLICITY_LENDING_V3_BUNDLE_HASH },
    action: "lending_contract.AcceptOffer",
    arguments: {
      COLLATERAL_ASSET_ID: "144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49",
      PRINCIPAL_ASSET_ID: "38fca2d939696061a8f76d4e6b5eecd54e3b4221c846f24a6b279e79952850a5",
      BORROWER_NFT_ASSET_ID: "8734a76badb98fd22150ec9a537684dd3824c30d80b2bcc1f4b0ff635fa8d97c",
      LENDER_NFT_ASSET_ID: "99396282d5ef54a51a1d9ceebd20710b6eb9a47055b275db4e8d1a7334c14502",
      PROTOCOL_FEE_KEEPER_ASSET_ID:
        "38fca2d939696061a8f76d4e6b5eecd54e3b4221c846f24a6b279e79952850a5",
      COLLATERAL_AMOUNT: "1000",
      PRINCIPAL_AMOUNT: "100",
      PRINCIPAL_INTEREST_RATE: "10000",
      LOAN_EXPIRATION_TIME: "2604140",
    },
    providedInputs: {
      pending_offer_in: { txid: OFFER_TXID, vout: 5 },
      lender_nft_in: { txid: OFFER_TXID, vout: 3 },
    },
    constraints: { maxFee: "1000", validUntilHeight: 2_601_000 },
  };
}

describe("TX Manifest AcceptOffer requirements", () => {
  it("resolves the confirmed testnet offer deterministically", async () => {
    const first = await resolveTxManifestRequirements(invocation());
    const second = await resolveTxManifestRequirements(invocation());
    if (first.action !== SIMPLICITY_LENDING_V3_ACCEPT_OFFER) throw new Error("wrong plan");
    expect(first).toEqual(second);
    expect(first.intent).toMatchObject({
      actionLabel: "Fund loan offer",
      principalAmount: "100",
      collateralAmount: "1000",
      totalDebt: "200",
      expirationHeight: 2_604_140,
    });
    expect(first.covenantInputs.map(({ requiredIndex, outpoint }) => ({ requiredIndex, outpoint }))).toEqual([
      { requiredIndex: 0, outpoint: { txid: OFFER_TXID, vout: 5 } },
      { requiredIndex: 1, outpoint: { txid: OFFER_TXID, vout: 3 } },
    ]);
    expect(first.outputs.map(({ requiredIndex, destinationType }) => ({ requiredIndex, destinationType }))).toEqual([
      { requiredIndex: 0, destinationType: "lending_collateral_active" },
      { requiredIndex: 1, destinationType: "principal_asset_auth" },
      { requiredIndex: 2, destinationType: "wallet" },
    ]);
    expect(first.requirementDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("fails closed for actions, chains, fields, and outpoints", async () => {
    const wrongAction = invocation();
    wrongAction.action = "lending_contract.NotAnAction";
    await expect(resolveTxManifestRequirements(wrongAction)).rejects.toThrow(/not enabled/);

    const wrongChain = invocation();
    wrongChain.chainId = "bip122:00000000000000000000000000000000";
    await expect(resolveTxManifestRequirements(wrongChain)).rejects.toThrow(/not enabled.*chain/);

    const extraField = invocation();
    extraField.arguments.SURPRISE = "1";
    await expect(resolveTxManifestRequirements(extraField)).rejects.toThrow(/Unknown AcceptOffer argument/);

    const noOffer = invocation();
    delete noOffer.providedInputs?.pending_offer_in;
    await expect(resolveTxManifestRequirements(noOffer)).rejects.toThrow(/pending_offer_in/);
  });

  it("resolves Enable borrowing without trusting any dapp-selected input", async () => {
    const createFactory = invocation();
    createFactory.requestId = "enable-borrowing";
    createFactory.action = SIMPLICITY_LENDING_V3_CREATE_FACTORY;
    createFactory.arguments = {};
    createFactory.providedInputs = {};
    const plan = await resolveTxManifestRequirements(createFactory);
    if (plan.action !== SIMPLICITY_LENDING_V3_CREATE_FACTORY) throw new Error("wrong plan");
    expect(plan.intent).toEqual({
      protocolLabel: "Simplicity Lending",
      actionLabel: "Enable borrowing",
      issuingUtxosCount: 2,
      reissuanceFlags: "0",
    });
    expect(plan.walletInputs).toEqual([{ id: "factory_issuance_input", assetId: "lbtc" }]);
  });

  it("keeps dynamically issued borrower and lender NFT ids inside Apogee", async () => {
    const createOffer = invocation();
    createOffer.requestId = "create-offer";
    createOffer.action = SIMPLICITY_LENDING_V3_CREATE_OFFER;
    const { BORROWER_NFT_ASSET_ID: _borrower, LENDER_NFT_ASSET_ID: _lender, ...arguments_ } =
      createOffer.arguments;
    createOffer.arguments = {
      FACTORY_ASSET_ID: "11".repeat(32),
      ...arguments_,
    };
    createOffer.providedInputs = {
      factory_auth_in: { txid: "22".repeat(32), vout: 0 },
      factory_covenant_in: { txid: "22".repeat(32), vout: 1 },
    };
    const plan = await resolveTxManifestRequirements(createOffer);
    if (plan.action !== SIMPLICITY_LENDING_V3_CREATE_OFFER) throw new Error("wrong plan");
    expect(plan.instance).not.toHaveProperty("BORROWER_NFT_ASSET_ID");
    expect(plan.instance).not.toHaveProperty("LENDER_NFT_ASSET_ID");
    expect(plan.intent).toMatchObject({
      actionLabel: "Create borrow offer",
      factoryAssetId: "11".repeat(32),
      totalDebt: "200",
    });

    createOffer.arguments.BORROWER_NFT_ASSET_ID = "33".repeat(32);
    await expect(resolveTxManifestRequirements(createOffer)).rejects.toThrow(
      /Unknown CreateOffer argument BORROWER_NFT_ASSET_ID/,
    );
  });

  it("derives full-repayment settlement values and liquidation authorization", async () => {
    const repay = invocation();
    repay.action = SIMPLICITY_LENDING_V3_REPAY_LOAN;
    repay.providedInputs = {
      borrower_nft_in: { txid: "44".repeat(32), vout: 0 },
      active_offer_in: { txid: "55".repeat(32), vout: 0 },
    };
    const repayment = await resolveTxManifestRequirements(repay);
    if (repayment.action !== SIMPLICITY_LENDING_V3_REPAY_LOAN) throw new Error("wrong plan");
    expect(repayment.intent).toMatchObject({
      totalDebt: "200",
      interestAmount: "100",
      protocolFeeAmount: "10",
      lenderVaultAmount: "190",
    });

    const liquidate = invocation();
    liquidate.action = SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER;
    liquidate.providedInputs = {
      lender_nft_in: { txid: "66".repeat(32), vout: 2 },
      active_offer_in: { txid: "55".repeat(32), vout: 0 },
    };
    const liquidation = await resolveTxManifestRequirements(liquidate);
    if (liquidation.action !== SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER) {
      throw new Error("wrong plan");
    }
    expect(liquidation.walletInputs[0]).toMatchObject({
      id: "lender_nft_in",
      outpoint: { txid: "66".repeat(32), vout: 2 },
    });
  });
});
