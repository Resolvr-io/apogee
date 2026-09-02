import {
  SIMPLICITY_LENDING_V3_ACCEPT_OFFER,
  SIMPLICITY_LENDING_V3_CANCEL_OFFER,
  SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT,
  SIMPLICITY_LENDING_V3_CLAIM_PRINCIPAL,
  SIMPLICITY_LENDING_V3_CREATE_FACTORY,
  SIMPLICITY_LENDING_V3_CREATE_OFFER,
  SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER,
  SIMPLICITY_LENDING_V3_REPAY_LOAN,
} from "./builtins/simplicity-lending-v3";
import { taggedCanonicalJsonHash } from "./bundle";
import {
  resolveTrustedTxManifest,
  type TxManifestBundleHash,
} from "./registry";
import type { DeclarativeRequirementPlan } from "./declarative-plan";

export type TxManifestOutpoint = { txid: string; vout: number };

export type TxManifestInvocation = {
  protocolVersion: "0.1";
  requestId: string;
  chainId: string;
  accountIdentifier: string;
  manifest: { bundleHash: TxManifestBundleHash; bundle?: unknown };
  action: string;
  arguments: Record<string, unknown>;
  providedInputs?: Record<string, TxManifestOutpoint | TxManifestOutpoint[]>;
  constraints?: { maxFee?: string; validUntilHeight?: number };
};

export type LendingV3InstanceArguments = {
  COLLATERAL_ASSET_ID: string;
  PRINCIPAL_ASSET_ID: string;
  BORROWER_NFT_ASSET_ID: string;
  LENDER_NFT_ASSET_ID: string;
  PROTOCOL_FEE_KEEPER_ASSET_ID: string;
  COLLATERAL_AMOUNT: string;
  PRINCIPAL_AMOUNT: string;
  PRINCIPAL_INTEREST_RATE: string;
  LOAN_EXPIRATION_TIME: string;
};

export type CreateOfferInstanceArguments = Omit<
  LendingV3InstanceArguments,
  "BORROWER_NFT_ASSET_ID" | "LENDER_NFT_ASSET_ID"
>;

type RequirementPlanBase = {
  planVersion: "apogee-tx-manifest-requirements/v1";
  requestId: string;
  chainId: string;
  accountIdentifier: string;
  bundleHash: TxManifestBundleHash;
  constraints: { maxFee?: string; validUntilHeight?: number };
  requirementDigest: `sha256:${string}`;
};

type LendingRequirementPlanBase = RequirementPlanBase & {
  instance: LendingV3InstanceArguments;
};

export type CreateFactoryRequirementPlan = RequirementPlanBase & {
  action: typeof SIMPLICITY_LENDING_V3_CREATE_FACTORY;
  intent: {
    protocolLabel: "Simplicity Lending";
    actionLabel: "Enable borrowing";
    issuingUtxosCount: 2;
    reissuanceFlags: "0";
  };
  walletInputs: readonly [{ id: "factory_issuance_input"; assetId: "lbtc" }];
};

export type CreateOfferRequirementPlan = RequirementPlanBase & {
  action: typeof SIMPLICITY_LENDING_V3_CREATE_OFFER;
  instance: CreateOfferInstanceArguments;
  factoryAssetId: string;
  intent: {
    protocolLabel: "Simplicity Lending";
    actionLabel: "Create borrow offer";
    factoryAssetId: string;
    principalAssetId: string;
    principalAmount: string;
    collateralAssetId: string;
    collateralAmount: string;
    interestRateBasisPoints: string;
    totalDebt: string;
    expirationHeight: number;
  };
  covenantInputs: readonly [{
    id: "factory_covenant_in";
    requiredIndex: 1;
    outpoint: TxManifestOutpoint;
    assetId: string;
    amount: "1";
    sourceType: "issuance_factory";
    witnesses: { PATH: "Left(0)" };
  }];
  walletInputs: readonly [
    {
      id: "factory_auth_in";
      requiredIndex: 0;
      outpoint: TxManifestOutpoint;
      assetId: string;
      amount: "1";
    },
    { id: "collateral_in"; requiredIndex: 2; assetId: string; minAmount: string },
    { id: "fee_input"; assetId: "lbtc" },
  ];
};

export type AcceptOfferRequirementPlan = LendingRequirementPlanBase & {
  action: typeof SIMPLICITY_LENDING_V3_ACCEPT_OFFER;
  intent: {
    protocolLabel: "Simplicity Lending";
    actionLabel: "Fund loan offer";
    principalAssetId: string;
    principalAmount: string;
    collateralAssetId: string;
    collateralAmount: string;
    interestRateBasisPoints: string;
    totalDebt: string;
    expirationHeight: number;
  };
  covenantInputs: readonly [
    {
      id: "pending_offer_in";
      requiredIndex: 0;
      outpoint: TxManifestOutpoint;
      assetId: string;
      amount: string;
      sourceType: "lending_collateral";
      witnesses: { PATH: "Left(Left(()))" };
    },
    {
      id: "lender_nft_in";
      requiredIndex: 1;
      outpoint: TxManifestOutpoint;
      assetId: string;
      amount: "1";
      sourceType: "lender_nft_script_auth";
      witnesses: { INPUT_SCRIPT_INDEX: "0" };
    },
  ];
  walletInputs: readonly [
    { id: "principal_in"; requiredIndex: 2; assetId: string; minAmount: string },
    { id: "fee_input"; assetId: "lbtc" },
  ];
  outputs: readonly [
    {
      id: "active_offer_out";
      requiredIndex: 0;
      destinationType: "lending_collateral_active";
      assetId: string;
      amount: string;
      confidential: false;
    },
    {
      id: "principal_out";
      requiredIndex: 1;
      destinationType: "principal_asset_auth";
      assetId: string;
      amount: string;
      confidential: false;
    },
    {
      id: "lender_nft_out";
      requiredIndex: 2;
      destinationType: "wallet";
      assetId: string;
      amount: "1";
      confidential: false;
    },
  ];
  change: readonly [
    { assetId: string; destinationType: "change" },
    { assetId: "lbtc"; destinationType: "change" },
  ];
};

export type ClaimPrincipalRequirementPlan = LendingRequirementPlanBase & {
  action: typeof SIMPLICITY_LENDING_V3_CLAIM_PRINCIPAL;
  intent: CommonBorrowerIntent & { actionLabel: "Claim borrowed funds" };
  covenantInputs: readonly [{
    id: "principal_asset_auth_in";
    requiredIndex: 0;
    outpoint: TxManifestOutpoint;
    assetId: string;
    amount: string;
    sourceType: "principal_asset_auth";
  }];
  walletInputs: readonly [
    {
      id: "borrower_nft_in";
      requiredIndex: 1;
      outpoint: TxManifestOutpoint;
      assetId: string;
      amount: "1";
    },
    { id: "fee_input"; assetId: "lbtc" },
  ];
};

export type CancelOfferRequirementPlan = LendingRequirementPlanBase & {
  action: typeof SIMPLICITY_LENDING_V3_CANCEL_OFFER;
  intent: CommonBorrowerIntent & { actionLabel: "Cancel borrow offer" };
  covenantInputs: readonly [
    { id: "pending_offer_in"; requiredIndex: 0; outpoint: TxManifestOutpoint; assetId: string; amount: string; sourceType: "lending_collateral" },
    { id: "lender_nft_in"; requiredIndex: 1; outpoint: TxManifestOutpoint; assetId: string; amount: "1"; sourceType: "lender_nft_script_auth" },
  ];
  walletInputs: readonly [
    { id: "borrower_nft_in"; requiredIndex: 2; outpoint: TxManifestOutpoint; assetId: string; amount: "1" },
    { id: "fee_input"; assetId: "lbtc" },
  ];
};

export type RepayLoanRequirementPlan = LendingRequirementPlanBase & {
  action: typeof SIMPLICITY_LENDING_V3_REPAY_LOAN;
  intent: CommonBorrowerIntent & {
    actionLabel: "Repay loan in full";
    totalDebt: string;
    interestAmount: string;
    protocolFeeAmount: string;
    lenderVaultAmount: string;
  };
  covenantInputs: readonly [{ id: "active_offer_in"; requiredIndex: 1; outpoint: TxManifestOutpoint; assetId: string; amount: string; sourceType: "lending_collateral_active" }];
  walletInputs: readonly [
    { id: "borrower_nft_in"; requiredIndex: 0; outpoint: TxManifestOutpoint; assetId: string; amount: "1" },
    { id: "repayment_in"; requiredIndex: 2; assetId: string; minAmount: string },
    { id: "fee_input"; assetId: "lbtc" },
  ];
};

export type LiquidateOfferRequirementPlan = LendingRequirementPlanBase & {
  action: typeof SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER;
  intent: CommonBorrowerIntent & {
    actionLabel: "Liquidate expired loan";
    totalDebt: string;
  };
  covenantInputs: readonly [{ id: "active_offer_in"; requiredIndex: 0; outpoint: TxManifestOutpoint; assetId: string; amount: string; sourceType: "lending_collateral_active" }];
  walletInputs: readonly [
    { id: "lender_nft_in"; requiredIndex: 1; outpoint: TxManifestOutpoint; assetId: string; amount: "1" },
    { id: "fee_input"; assetId: "lbtc" },
  ];
};

type CommonBorrowerIntent = {
  protocolLabel: "Simplicity Lending";
  actionLabel: string;
  principalAssetId: string;
  principalAmount: string;
  collateralAssetId: string;
  collateralAmount: string;
  borrowerNftAssetId: string;
  lenderNftAssetId: string;
  expirationHeight: number;
};

export type ClaimLenderVaultRequirementPlan = LendingRequirementPlanBase & {
  action: typeof SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT;
  intent: {
    protocolLabel: "Simplicity Lending";
    actionLabel: "Collect loan repayment";
    principalAssetId: string;
    principalAmount: string;
    grossDebt: string;
    interestAmount: string;
    protocolFeeAmount: string;
    lenderNftAssetId: string;
  };
  covenantInputs: readonly [{
    id: "lender_vault_in";
    requiredIndex: 0;
    outpoint: TxManifestOutpoint;
    assetId: string;
    amount: string;
    sourceType: "lender_vault_finalized";
    witnesses: { PATH: "Left(Left((1, 0)))" };
  }];
  walletInputs: readonly [
    { id: "lender_nft_in"; requiredIndex: 1; outpoint: TxManifestOutpoint; assetId: string; amount: "1" },
    { id: "fee_input"; assetId: "lbtc" },
  ];
  outputs: readonly [
    { id: "lender_nft_burned"; requiredIndex: 0; destinationType: "op_return"; assetId: string; amount: "1"; confidential: false },
    { id: "principal_claimed"; requiredIndex: 1; destinationType: "wallet"; assetId: string; amount: string; confidential: true },
  ];
  change: readonly [{ assetId: "lbtc"; destinationType: "change" }];
};

export type TxManifestRequirementPlan =
  | CreateFactoryRequirementPlan
  | CreateOfferRequirementPlan
  | AcceptOfferRequirementPlan
  | ClaimPrincipalRequirementPlan
  | RepayLoanRequirementPlan
  | CancelOfferRequirementPlan
  | LiquidateOfferRequirementPlan
  | ClaimLenderVaultRequirementPlan;

/** Provider-wide union; the legacy name above intentionally stays Lending-only for action narrowing. */
export type AnyTxManifestRequirementPlan =
  | TxManifestRequirementPlan
  | DeclarativeRequirementPlan;

const REQUIRED_INSTANCE_FIELDS = [
  "COLLATERAL_ASSET_ID",
  "PRINCIPAL_ASSET_ID",
  "BORROWER_NFT_ASSET_ID",
  "LENDER_NFT_ASSET_ID",
  "PROTOCOL_FEE_KEEPER_ASSET_ID",
  "COLLATERAL_AMOUNT",
  "PRINCIPAL_AMOUNT",
  "PRINCIPAL_INTEREST_RATE",
  "LOAN_EXPIRATION_TIME",
] as const;

const ACTION_NAMES: Readonly<Record<string, string>> = {
  [SIMPLICITY_LENDING_V3_CREATE_FACTORY]: "CreateFactory",
  [SIMPLICITY_LENDING_V3_CREATE_OFFER]: "CreateOffer",
  [SIMPLICITY_LENDING_V3_ACCEPT_OFFER]: "AcceptOffer",
  [SIMPLICITY_LENDING_V3_CLAIM_PRINCIPAL]: "ClaimPrincipal",
  [SIMPLICITY_LENDING_V3_REPAY_LOAN]: "RepayLoan",
  [SIMPLICITY_LENDING_V3_CANCEL_OFFER]: "CancelOffer",
  [SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER]: "LiquidateOffer",
  [SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT]: "ClaimLenderVault",
};

/** Resolve authorization-safe facts only. The host verifies chain and wallet state later. */
export async function resolveTxManifestRequirements(
  invocation: TxManifestInvocation,
): Promise<TxManifestRequirementPlan> {
  if (invocation.protocolVersion !== "0.1") throw new Error("Unsupported TX Manifest protocol version.");
  const trusted = await resolveTrustedTxManifest(invocation.manifest.bundleHash, invocation.manifest.bundle);
  if (!trusted.chainIds.includes(invocation.chainId)) {
    throw new Error("This TX Manifest bundle is not enabled for the requested chain.");
  }
  if (!trusted.actions.includes(invocation.action)) {
    throw new Error("This TX Manifest action is not enabled by Apogee.");
  }
  const actionName = ACTION_NAMES[invocation.action];
  if (!actionName) throw new Error("Unsupported TX Manifest action.");

  const common = {
    planVersion: "apogee-tx-manifest-requirements/v1" as const,
    requestId: nonEmpty(invocation.requestId, "requestId"),
    chainId: nonEmpty(invocation.chainId, "chainId"),
    accountIdentifier: nonEmpty(invocation.accountIdentifier, "accountIdentifier"),
    bundleHash: invocation.manifest.bundleHash,
    constraints: validateConstraints(invocation.constraints),
  };

  if (invocation.action === SIMPLICITY_LENDING_V3_CREATE_FACTORY) {
    exactArguments(invocation.arguments, [], actionName);
    exactProvidedInputs(invocation.providedInputs, [], actionName);
    return withDigest({
      ...common,
      action: SIMPLICITY_LENDING_V3_CREATE_FACTORY,
      intent: {
        protocolLabel: "Simplicity Lending" as const,
        actionLabel: "Enable borrowing" as const,
        issuingUtxosCount: 2 as const,
        reissuanceFlags: "0" as const,
      },
      walletInputs: [{ id: "factory_issuance_input" as const, assetId: "lbtc" as const }] as const,
    });
  }

  if (invocation.action === SIMPLICITY_LENDING_V3_CREATE_OFFER) {
    const args = exactArguments(invocation.arguments, [
      "FACTORY_ASSET_ID",
      "COLLATERAL_ASSET_ID",
      "PRINCIPAL_ASSET_ID",
      "PROTOCOL_FEE_KEEPER_ASSET_ID",
      "COLLATERAL_AMOUNT",
      "PRINCIPAL_AMOUNT",
      "PRINCIPAL_INTEREST_RATE",
      "LOAN_EXPIRATION_TIME",
    ], actionName);
    const instance = parseCreateOfferInstance(args);
    const values = calculateLendingValues(instance);
    exactProvidedInputs(invocation.providedInputs, ["factory_auth_in", "factory_covenant_in"], actionName);
    if (BigInt(instance.PRINCIPAL_INTEREST_RATE) > 65_535n) {
      throw new Error("PRINCIPAL_INTEREST_RATE exceeds the lending metadata u16 limit.");
    }
    const factoryAssetId = assetId(args.FACTORY_ASSET_ID, "FACTORY_ASSET_ID");
    const factoryAuth = providedOutpoint(invocation.providedInputs, "factory_auth_in");
    const factoryCovenant = providedOutpoint(invocation.providedInputs, "factory_covenant_in");
    return withDigest({
      ...common,
      instance,
      action: SIMPLICITY_LENDING_V3_CREATE_OFFER,
      factoryAssetId,
      intent: {
        protocolLabel: "Simplicity Lending" as const,
        actionLabel: "Create borrow offer" as const,
        factoryAssetId,
        principalAssetId: instance.PRINCIPAL_ASSET_ID,
        principalAmount: instance.PRINCIPAL_AMOUNT,
        collateralAssetId: instance.COLLATERAL_ASSET_ID,
        collateralAmount: instance.COLLATERAL_AMOUNT,
        interestRateBasisPoints: instance.PRINCIPAL_INTEREST_RATE,
        totalDebt: values.totalDebt.toString(),
        expirationHeight: values.expirationHeight,
      },
      covenantInputs: [{
        id: "factory_covenant_in" as const,
        requiredIndex: 1 as const,
        outpoint: factoryCovenant,
        assetId: factoryAssetId,
        amount: "1" as const,
        sourceType: "issuance_factory" as const,
        witnesses: { PATH: "Left(0)" as const },
      }] as const,
      walletInputs: [
        { id: "factory_auth_in" as const, requiredIndex: 0 as const, outpoint: factoryAuth, assetId: factoryAssetId, amount: "1" as const },
        { id: "collateral_in" as const, requiredIndex: 2 as const, assetId: instance.COLLATERAL_ASSET_ID, minAmount: instance.COLLATERAL_AMOUNT },
        { id: "fee_input" as const, assetId: "lbtc" as const },
      ] as const,
    });
  }

  const args = exactArguments(invocation.arguments, REQUIRED_INSTANCE_FIELDS, actionName);
  const instance = parseLendingInstance(args);
  const values = calculateLendingValues(instance);
  const lendingCommon = { ...common, instance };
  const borrowerIntent = {
    protocolLabel: "Simplicity Lending" as const,
    principalAssetId: instance.PRINCIPAL_ASSET_ID,
    principalAmount: instance.PRINCIPAL_AMOUNT,
    collateralAssetId: instance.COLLATERAL_ASSET_ID,
    collateralAmount: instance.COLLATERAL_AMOUNT,
    borrowerNftAssetId: instance.BORROWER_NFT_ASSET_ID,
    lenderNftAssetId: instance.LENDER_NFT_ASSET_ID,
    expirationHeight: values.expirationHeight,
  };

  if (invocation.action === SIMPLICITY_LENDING_V3_ACCEPT_OFFER) {
    exactProvidedInputs(invocation.providedInputs, ["pending_offer_in", "lender_nft_in"], actionName);
    const pendingOffer = providedOutpoint(invocation.providedInputs, "pending_offer_in");
    const lenderNft = providedOutpoint(invocation.providedInputs, "lender_nft_in");
    return withDigest({
      ...lendingCommon,
      action: SIMPLICITY_LENDING_V3_ACCEPT_OFFER,
      intent: {
        protocolLabel: "Simplicity Lending" as const,
        actionLabel: "Fund loan offer" as const,
        principalAssetId: instance.PRINCIPAL_ASSET_ID,
        principalAmount: instance.PRINCIPAL_AMOUNT,
        collateralAssetId: instance.COLLATERAL_ASSET_ID,
        collateralAmount: instance.COLLATERAL_AMOUNT,
        interestRateBasisPoints: instance.PRINCIPAL_INTEREST_RATE,
        totalDebt: values.totalDebt.toString(),
        expirationHeight: values.expirationHeight,
      },
      covenantInputs: [
        { id: "pending_offer_in" as const, requiredIndex: 0 as const, outpoint: pendingOffer, assetId: instance.COLLATERAL_ASSET_ID, amount: instance.COLLATERAL_AMOUNT, sourceType: "lending_collateral" as const, witnesses: { PATH: "Left(Left(()))" as const } },
        { id: "lender_nft_in" as const, requiredIndex: 1 as const, outpoint: lenderNft, assetId: instance.LENDER_NFT_ASSET_ID, amount: "1" as const, sourceType: "lender_nft_script_auth" as const, witnesses: { INPUT_SCRIPT_INDEX: "0" as const } },
      ] as const,
      walletInputs: [
        { id: "principal_in" as const, requiredIndex: 2 as const, assetId: instance.PRINCIPAL_ASSET_ID, minAmount: instance.PRINCIPAL_AMOUNT },
        { id: "fee_input" as const, assetId: "lbtc" as const },
      ] as const,
      outputs: [
        { id: "active_offer_out" as const, requiredIndex: 0 as const, destinationType: "lending_collateral_active" as const, assetId: instance.COLLATERAL_ASSET_ID, amount: instance.COLLATERAL_AMOUNT, confidential: false as const },
        { id: "principal_out" as const, requiredIndex: 1 as const, destinationType: "principal_asset_auth" as const, assetId: instance.PRINCIPAL_ASSET_ID, amount: instance.PRINCIPAL_AMOUNT, confidential: false as const },
        { id: "lender_nft_out" as const, requiredIndex: 2 as const, destinationType: "wallet" as const, assetId: instance.LENDER_NFT_ASSET_ID, amount: "1" as const, confidential: false as const },
      ] as const,
      change: [
        { assetId: instance.PRINCIPAL_ASSET_ID, destinationType: "change" as const },
        { assetId: "lbtc" as const, destinationType: "change" as const },
      ] as const,
    });
  }

  if (invocation.action === SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT) {
    exactProvidedInputs(invocation.providedInputs, ["lender_vault_in", "lender_nft_in"], actionName);
    const lenderVault = providedOutpoint(invocation.providedInputs, "lender_vault_in");
    const lenderNft = providedOutpoint(invocation.providedInputs, "lender_nft_in");
    return withDigest({
      ...lendingCommon,
      action: SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT,
      intent: {
        protocolLabel: "Simplicity Lending" as const,
        actionLabel: "Collect loan repayment" as const,
        principalAssetId: instance.PRINCIPAL_ASSET_ID,
        principalAmount: values.lenderVaultAmount.toString(),
        grossDebt: values.totalDebt.toString(),
        interestAmount: values.interestAmount.toString(),
        protocolFeeAmount: values.protocolFeeAmount.toString(),
        lenderNftAssetId: instance.LENDER_NFT_ASSET_ID,
      },
      covenantInputs: [{ id: "lender_vault_in" as const, requiredIndex: 0 as const, outpoint: lenderVault, assetId: instance.PRINCIPAL_ASSET_ID, amount: values.lenderVaultAmount.toString(), sourceType: "lender_vault_finalized" as const, witnesses: { PATH: "Left(Left((1, 0)))" as const } }] as const,
      walletInputs: [
        { id: "lender_nft_in" as const, requiredIndex: 1 as const, outpoint: lenderNft, assetId: instance.LENDER_NFT_ASSET_ID, amount: "1" as const },
        { id: "fee_input" as const, assetId: "lbtc" as const },
      ] as const,
      outputs: [
        { id: "lender_nft_burned" as const, requiredIndex: 0 as const, destinationType: "op_return" as const, assetId: instance.LENDER_NFT_ASSET_ID, amount: "1" as const, confidential: false as const },
        { id: "principal_claimed" as const, requiredIndex: 1 as const, destinationType: "wallet" as const, assetId: instance.PRINCIPAL_ASSET_ID, amount: values.lenderVaultAmount.toString(), confidential: true as const },
      ] as const,
      change: [{ assetId: "lbtc" as const, destinationType: "change" as const }] as const,
    });
  }

  if (invocation.action === SIMPLICITY_LENDING_V3_CLAIM_PRINCIPAL) {
    exactProvidedInputs(invocation.providedInputs, ["principal_asset_auth_in", "borrower_nft_in"], actionName);
    return withDigest({
      ...lendingCommon,
      action: SIMPLICITY_LENDING_V3_CLAIM_PRINCIPAL,
      intent: { ...borrowerIntent, actionLabel: "Claim borrowed funds" as const },
      covenantInputs: [{ id: "principal_asset_auth_in" as const, requiredIndex: 0 as const, outpoint: providedOutpoint(invocation.providedInputs, "principal_asset_auth_in"), assetId: instance.PRINCIPAL_ASSET_ID, amount: instance.PRINCIPAL_AMOUNT, sourceType: "principal_asset_auth" as const }] as const,
      walletInputs: [
        { id: "borrower_nft_in" as const, requiredIndex: 1 as const, outpoint: providedOutpoint(invocation.providedInputs, "borrower_nft_in"), assetId: instance.BORROWER_NFT_ASSET_ID, amount: "1" as const },
        { id: "fee_input" as const, assetId: "lbtc" as const },
      ] as const,
    });
  }

  if (invocation.action === SIMPLICITY_LENDING_V3_CANCEL_OFFER) {
    exactProvidedInputs(invocation.providedInputs, ["pending_offer_in", "lender_nft_in", "borrower_nft_in"], actionName);
    return withDigest({
      ...lendingCommon,
      action: SIMPLICITY_LENDING_V3_CANCEL_OFFER,
      intent: { ...borrowerIntent, actionLabel: "Cancel borrow offer" as const },
      covenantInputs: [
        { id: "pending_offer_in" as const, requiredIndex: 0 as const, outpoint: providedOutpoint(invocation.providedInputs, "pending_offer_in"), assetId: instance.COLLATERAL_ASSET_ID, amount: instance.COLLATERAL_AMOUNT, sourceType: "lending_collateral" as const },
        { id: "lender_nft_in" as const, requiredIndex: 1 as const, outpoint: providedOutpoint(invocation.providedInputs, "lender_nft_in"), assetId: instance.LENDER_NFT_ASSET_ID, amount: "1" as const, sourceType: "lender_nft_script_auth" as const },
      ] as const,
      walletInputs: [
        { id: "borrower_nft_in" as const, requiredIndex: 2 as const, outpoint: providedOutpoint(invocation.providedInputs, "borrower_nft_in"), assetId: instance.BORROWER_NFT_ASSET_ID, amount: "1" as const },
        { id: "fee_input" as const, assetId: "lbtc" as const },
      ] as const,
    });
  }

  if (invocation.action === SIMPLICITY_LENDING_V3_REPAY_LOAN) {
    exactProvidedInputs(invocation.providedInputs, ["active_offer_in", "borrower_nft_in"], actionName);
    return withDigest({
      ...lendingCommon,
      action: SIMPLICITY_LENDING_V3_REPAY_LOAN,
      intent: {
        ...borrowerIntent,
        actionLabel: "Repay loan in full" as const,
        totalDebt: values.totalDebt.toString(),
        interestAmount: values.interestAmount.toString(),
        protocolFeeAmount: values.protocolFeeAmount.toString(),
        lenderVaultAmount: values.lenderVaultAmount.toString(),
      },
      covenantInputs: [{ id: "active_offer_in" as const, requiredIndex: 1 as const, outpoint: providedOutpoint(invocation.providedInputs, "active_offer_in"), assetId: instance.COLLATERAL_ASSET_ID, amount: instance.COLLATERAL_AMOUNT, sourceType: "lending_collateral_active" as const }] as const,
      walletInputs: [
        { id: "borrower_nft_in" as const, requiredIndex: 0 as const, outpoint: providedOutpoint(invocation.providedInputs, "borrower_nft_in"), assetId: instance.BORROWER_NFT_ASSET_ID, amount: "1" as const },
        { id: "repayment_in" as const, requiredIndex: 2 as const, assetId: instance.PRINCIPAL_ASSET_ID, minAmount: values.totalDebt.toString() },
        { id: "fee_input" as const, assetId: "lbtc" as const },
      ] as const,
    });
  }

  exactProvidedInputs(invocation.providedInputs, ["active_offer_in", "lender_nft_in"], actionName);
  return withDigest({
    ...lendingCommon,
    action: SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER,
    intent: { ...borrowerIntent, actionLabel: "Liquidate expired loan" as const, totalDebt: values.totalDebt.toString() },
    covenantInputs: [{ id: "active_offer_in" as const, requiredIndex: 0 as const, outpoint: providedOutpoint(invocation.providedInputs, "active_offer_in"), assetId: instance.COLLATERAL_ASSET_ID, amount: instance.COLLATERAL_AMOUNT, sourceType: "lending_collateral_active" as const }] as const,
    walletInputs: [
      { id: "lender_nft_in" as const, requiredIndex: 1 as const, outpoint: providedOutpoint(invocation.providedInputs, "lender_nft_in"), assetId: instance.LENDER_NFT_ASSET_ID, amount: "1" as const },
      { id: "fee_input" as const, assetId: "lbtc" as const },
    ] as const,
  });
}

function parseLendingInstance(args: Record<string, unknown>): LendingV3InstanceArguments {
  return {
    COLLATERAL_ASSET_ID: assetId(args.COLLATERAL_ASSET_ID, "COLLATERAL_ASSET_ID"),
    PRINCIPAL_ASSET_ID: assetId(args.PRINCIPAL_ASSET_ID, "PRINCIPAL_ASSET_ID"),
    BORROWER_NFT_ASSET_ID: assetId(args.BORROWER_NFT_ASSET_ID, "BORROWER_NFT_ASSET_ID"),
    LENDER_NFT_ASSET_ID: assetId(args.LENDER_NFT_ASSET_ID, "LENDER_NFT_ASSET_ID"),
    PROTOCOL_FEE_KEEPER_ASSET_ID: assetId(args.PROTOCOL_FEE_KEEPER_ASSET_ID, "PROTOCOL_FEE_KEEPER_ASSET_ID"),
    COLLATERAL_AMOUNT: decimalU64(args.COLLATERAL_AMOUNT, "COLLATERAL_AMOUNT"),
    PRINCIPAL_AMOUNT: decimalU64(args.PRINCIPAL_AMOUNT, "PRINCIPAL_AMOUNT"),
    PRINCIPAL_INTEREST_RATE: decimalU64(args.PRINCIPAL_INTEREST_RATE, "PRINCIPAL_INTEREST_RATE"),
    LOAN_EXPIRATION_TIME: String(u32(args.LOAN_EXPIRATION_TIME, "LOAN_EXPIRATION_TIME")),
  };
}

function parseCreateOfferInstance(args: Record<string, unknown>): CreateOfferInstanceArguments {
  return {
    COLLATERAL_ASSET_ID: assetId(args.COLLATERAL_ASSET_ID, "COLLATERAL_ASSET_ID"),
    PRINCIPAL_ASSET_ID: assetId(args.PRINCIPAL_ASSET_ID, "PRINCIPAL_ASSET_ID"),
    PROTOCOL_FEE_KEEPER_ASSET_ID: assetId(args.PROTOCOL_FEE_KEEPER_ASSET_ID, "PROTOCOL_FEE_KEEPER_ASSET_ID"),
    COLLATERAL_AMOUNT: decimalU64(args.COLLATERAL_AMOUNT, "COLLATERAL_AMOUNT"),
    PRINCIPAL_AMOUNT: decimalU64(args.PRINCIPAL_AMOUNT, "PRINCIPAL_AMOUNT"),
    PRINCIPAL_INTEREST_RATE: decimalU64(args.PRINCIPAL_INTEREST_RATE, "PRINCIPAL_INTEREST_RATE"),
    LOAN_EXPIRATION_TIME: String(u32(args.LOAN_EXPIRATION_TIME, "LOAN_EXPIRATION_TIME")),
  };
}

function calculateLendingValues(instance: Pick<
  LendingV3InstanceArguments,
  "PRINCIPAL_AMOUNT" | "PRINCIPAL_INTEREST_RATE" | "LOAN_EXPIRATION_TIME"
>): {
  expirationHeight: number;
  interestAmount: bigint;
  totalDebt: bigint;
  protocolFeeAmount: bigint;
  lenderVaultAmount: bigint;
} {
  const interestAmount = (BigInt(instance.PRINCIPAL_AMOUNT) * BigInt(instance.PRINCIPAL_INTEREST_RATE)) / 10_000n;
  const totalDebt = BigInt(instance.PRINCIPAL_AMOUNT) + interestAmount;
  if (totalDebt > 0xffff_ffff_ffff_ffffn) throw new Error("Total debt overflows u64.");
  const protocolFeeAmount = (interestAmount * 1_000n) / 10_000n;
  return {
    expirationHeight: Number(instance.LOAN_EXPIRATION_TIME),
    interestAmount,
    totalDebt,
    protocolFeeAmount,
    lenderVaultAmount: totalDebt - protocolFeeAmount,
  };
}

async function withDigest<T extends object>(plan: T): Promise<T & { requirementDigest: `sha256:${string}` }> {
  return { ...plan, requirementDigest: await taggedCanonicalJsonHash("apogee/tx-manifest-requirements/v1", plan) };
}

function exactArguments(value: Record<string, unknown>, fields: readonly string[], actionName: string): Record<string, unknown> {
  const expected = new Set(fields);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(`Unknown ${actionName} argument ${key}.`);
  }
  for (const key of fields) {
    if (!Object.hasOwn(value, key)) throw new Error(`Missing ${actionName} argument ${key}.`);
  }
  return value;
}

function exactProvidedInputs(inputs: TxManifestInvocation["providedInputs"], fields: readonly string[], actionName: string): void {
  const actual = inputs ?? {};
  const expected = new Set(fields);
  for (const key of Object.keys(actual)) {
    if (!expected.has(key)) throw new Error(`Unknown ${actionName} provided input ${key}.`);
  }
  for (const key of fields) {
    if (!Object.hasOwn(actual, key)) throw new Error(`Missing ${actionName} provided input ${key}.`);
  }
}

function providedOutpoint(inputs: TxManifestInvocation["providedInputs"], name: string): TxManifestOutpoint {
  const value = inputs?.[name];
  if (Array.isArray(value) || value === undefined) throw new Error(`providedInputs.${name} must be one outpoint.`);
  if (!/^[0-9a-f]{64}$/.test(value.txid) || !Number.isInteger(value.vout) || value.vout < 0 || value.vout > 0xffff_ffff) {
    throw new Error(`providedInputs.${name} is not a valid outpoint.`);
  }
  return { txid: value.txid, vout: value.vout };
}

function validateConstraints(value: TxManifestInvocation["constraints"]): { maxFee?: string; validUntilHeight?: number } {
  if (!value) return {};
  const constraints: { maxFee?: string; validUntilHeight?: number } = {};
  if (value.maxFee !== undefined) constraints.maxFee = decimalU64(value.maxFee, "constraints.maxFee");
  if (value.validUntilHeight !== undefined) constraints.validUntilHeight = u32(value.validUntilHeight, "constraints.validUntilHeight");
  return constraints;
}

function assetId(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${path} must be a lowercase 32-byte asset id.`);
  return value;
}

function decimalU64(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${path} must be a canonical unsigned decimal string.`);
  const parsed = BigInt(value);
  if (parsed > 0xffff_ffff_ffff_ffffn) throw new Error(`${path} exceeds u64.`);
  return value;
}

function u32(value: unknown, path: string): number {
  const decimal = decimalU64(typeof value === "number" ? String(value) : value, path);
  const parsed = Number(decimal);
  if (!Number.isSafeInteger(parsed) || parsed > 0xffff_ffff) throw new Error(`${path} exceeds u32.`);
  return parsed;
}

function nonEmpty(value: string, path: string): string {
  if (value.length === 0) throw new Error(`${path} must not be empty.`);
  return value;
}
