import {
  SIMPLICITY_LENDING_V3_ACCEPT_OFFER,
  SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT,
} from "./builtins/simplicity-lending-v3";
import { taggedCanonicalJsonHash } from "./bundle";
import {
  resolveTrustedTxManifest,
  type TxManifestBundleHash,
} from "./registry";

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

type RequirementPlanBase = {
  planVersion: "apogee-tx-manifest-requirements/v1";
  requestId: string;
  chainId: string;
  accountIdentifier: string;
  bundleHash: TxManifestBundleHash;
  instance: LendingV3InstanceArguments;
  constraints: { maxFee?: string; validUntilHeight?: number };
  requirementDigest: `sha256:${string}`;
};

export type AcceptOfferRequirementPlan = RequirementPlanBase & {
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

export type ClaimLenderVaultRequirementPlan = RequirementPlanBase & {
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
  covenantInputs: readonly [
    {
      id: "lender_vault_in";
      requiredIndex: 0;
      outpoint: TxManifestOutpoint;
      assetId: string;
      amount: string;
      sourceType: "lender_vault_finalized";
      witnesses: { PATH: "Left(Left((1, 0)))" };
    },
  ];
  walletInputs: readonly [
    {
      id: "lender_nft_in";
      requiredIndex: 1;
      outpoint: TxManifestOutpoint;
      assetId: string;
      amount: "1";
    },
    { id: "fee_input"; assetId: "lbtc" },
  ];
  outputs: readonly [
    {
      id: "lender_nft_burned";
      requiredIndex: 0;
      destinationType: "op_return";
      assetId: string;
      amount: "1";
      confidential: false;
    },
    {
      id: "principal_claimed";
      requiredIndex: 1;
      destinationType: "wallet";
      assetId: string;
      amount: string;
      confidential: true;
    },
  ];
  change: readonly [{ assetId: "lbtc"; destinationType: "change" }];
};

export type TxManifestRequirementPlan =
  | AcceptOfferRequirementPlan
  | ClaimLenderVaultRequirementPlan;

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

/** Resolve authorization-safe facts only. The host verifies chain and wallet state later. */
export async function resolveTxManifestRequirements(
  invocation: TxManifestInvocation,
): Promise<TxManifestRequirementPlan> {
  if (invocation.protocolVersion !== "0.1") throw new Error("Unsupported TX Manifest protocol version.");
  const trusted = await resolveTrustedTxManifest(
    invocation.manifest.bundleHash,
    invocation.manifest.bundle,
  );
  if (!trusted.chainIds.includes(invocation.chainId)) {
    throw new Error("This TX Manifest bundle is not enabled for the requested chain.");
  }
  if (!trusted.actions.includes(invocation.action)) {
    throw new Error("This TX Manifest action is not enabled by Apogee.");
  }

  const actionName =
    invocation.action === SIMPLICITY_LENDING_V3_ACCEPT_OFFER
      ? "AcceptOffer"
      : invocation.action === SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT
        ? "ClaimLenderVault"
        : null;
  if (!actionName) throw new Error("Unsupported TX Manifest action.");

  const args = exactInstanceArguments(invocation.arguments, actionName);
  const collateralAssetId = assetId(args.COLLATERAL_ASSET_ID, "COLLATERAL_ASSET_ID");
  const principalAssetId = assetId(args.PRINCIPAL_ASSET_ID, "PRINCIPAL_ASSET_ID");
  const borrowerNftAssetId = assetId(args.BORROWER_NFT_ASSET_ID, "BORROWER_NFT_ASSET_ID");
  const lenderNftAssetId = assetId(args.LENDER_NFT_ASSET_ID, "LENDER_NFT_ASSET_ID");
  const protocolFeeKeeperAssetId = assetId(
    args.PROTOCOL_FEE_KEEPER_ASSET_ID,
    "PROTOCOL_FEE_KEEPER_ASSET_ID",
  );
  const collateralAmount = decimalU64(args.COLLATERAL_AMOUNT, "COLLATERAL_AMOUNT");
  const principalAmount = decimalU64(args.PRINCIPAL_AMOUNT, "PRINCIPAL_AMOUNT");
  const interestRate = decimalU64(args.PRINCIPAL_INTEREST_RATE, "PRINCIPAL_INTEREST_RATE");
  const expirationHeight = u32(args.LOAN_EXPIRATION_TIME, "LOAN_EXPIRATION_TIME");
  const interestAmount = (BigInt(principalAmount) * BigInt(interestRate)) / 10_000n;
  const totalDebt = BigInt(principalAmount) + interestAmount;
  const protocolFeeAmount = (interestAmount * 1_000n) / 10_000n;
  const lenderVaultAmount = totalDebt - protocolFeeAmount;
  if (totalDebt > 0xffff_ffff_ffff_ffffn) throw new Error("Total debt overflows u64.");

  const instance: LendingV3InstanceArguments = {
    COLLATERAL_ASSET_ID: collateralAssetId,
    PRINCIPAL_ASSET_ID: principalAssetId,
    BORROWER_NFT_ASSET_ID: borrowerNftAssetId,
    LENDER_NFT_ASSET_ID: lenderNftAssetId,
    PROTOCOL_FEE_KEEPER_ASSET_ID: protocolFeeKeeperAssetId,
    COLLATERAL_AMOUNT: collateralAmount,
    PRINCIPAL_AMOUNT: principalAmount,
    PRINCIPAL_INTEREST_RATE: interestRate,
    LOAN_EXPIRATION_TIME: String(expirationHeight),
  };
  const common = {
    planVersion: "apogee-tx-manifest-requirements/v1" as const,
    requestId: nonEmpty(invocation.requestId, "requestId"),
    chainId: nonEmpty(invocation.chainId, "chainId"),
    accountIdentifier: nonEmpty(invocation.accountIdentifier, "accountIdentifier"),
    bundleHash: invocation.manifest.bundleHash,
    instance,
    constraints: validateConstraints(invocation.constraints),
  };

  if (invocation.action === SIMPLICITY_LENDING_V3_ACCEPT_OFFER) {
    const pendingOffer = providedOutpoint(invocation.providedInputs, "pending_offer_in");
    const lenderNft = providedOutpoint(invocation.providedInputs, "lender_nft_in");
    const planWithoutDigest = {
      ...common,
      action: SIMPLICITY_LENDING_V3_ACCEPT_OFFER,
      intent: {
        protocolLabel: "Simplicity Lending" as const,
        actionLabel: "Fund loan offer" as const,
        principalAssetId,
        principalAmount,
        collateralAssetId,
        collateralAmount,
        interestRateBasisPoints: interestRate,
        totalDebt: totalDebt.toString(),
        expirationHeight,
      },
      covenantInputs: [
        {
          id: "pending_offer_in" as const,
          requiredIndex: 0 as const,
          outpoint: pendingOffer,
          assetId: collateralAssetId,
          amount: collateralAmount,
          sourceType: "lending_collateral" as const,
          witnesses: { PATH: "Left(Left(()))" as const },
        },
        {
          id: "lender_nft_in" as const,
          requiredIndex: 1 as const,
          outpoint: lenderNft,
          assetId: lenderNftAssetId,
          amount: "1" as const,
          sourceType: "lender_nft_script_auth" as const,
          witnesses: { INPUT_SCRIPT_INDEX: "0" as const },
        },
      ] as const,
      walletInputs: [
        {
          id: "principal_in" as const,
          requiredIndex: 2 as const,
          assetId: principalAssetId,
          minAmount: principalAmount,
        },
        { id: "fee_input" as const, assetId: "lbtc" as const },
      ] as const,
      outputs: [
        {
          id: "active_offer_out" as const,
          requiredIndex: 0 as const,
          destinationType: "lending_collateral_active" as const,
          assetId: collateralAssetId,
          amount: collateralAmount,
          confidential: false as const,
        },
        {
          id: "principal_out" as const,
          requiredIndex: 1 as const,
          destinationType: "principal_asset_auth" as const,
          assetId: principalAssetId,
          amount: principalAmount,
          confidential: false as const,
        },
        {
          id: "lender_nft_out" as const,
          requiredIndex: 2 as const,
          destinationType: "wallet" as const,
          assetId: lenderNftAssetId,
          amount: "1" as const,
          confidential: false as const,
        },
      ] as const,
      change: [
        { assetId: principalAssetId, destinationType: "change" as const },
        { assetId: "lbtc" as const, destinationType: "change" as const },
      ] as const,
    };
    return withDigest(planWithoutDigest);
  }

  const lenderVault = providedOutpoint(invocation.providedInputs, "lender_vault_in");
  const lenderNft = providedOutpoint(invocation.providedInputs, "lender_nft_in");
  const planWithoutDigest = {
    ...common,
    action: SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT,
    intent: {
      protocolLabel: "Simplicity Lending" as const,
      actionLabel: "Collect loan repayment" as const,
      principalAssetId,
      principalAmount: lenderVaultAmount.toString(),
      grossDebt: totalDebt.toString(),
      interestAmount: interestAmount.toString(),
      protocolFeeAmount: protocolFeeAmount.toString(),
      lenderNftAssetId,
    },
    covenantInputs: [
      {
        id: "lender_vault_in" as const,
        requiredIndex: 0 as const,
        outpoint: lenderVault,
        assetId: principalAssetId,
        amount: lenderVaultAmount.toString(),
        sourceType: "lender_vault_finalized" as const,
        witnesses: { PATH: "Left(Left((1, 0)))" as const },
      },
    ] as const,
    walletInputs: [
      {
        id: "lender_nft_in" as const,
        requiredIndex: 1 as const,
        outpoint: lenderNft,
        assetId: lenderNftAssetId,
        amount: "1" as const,
      },
      { id: "fee_input" as const, assetId: "lbtc" as const },
    ] as const,
    outputs: [
      {
        id: "lender_nft_burned" as const,
        requiredIndex: 0 as const,
        destinationType: "op_return" as const,
        assetId: lenderNftAssetId,
        amount: "1" as const,
        confidential: false as const,
      },
      {
        id: "principal_claimed" as const,
        requiredIndex: 1 as const,
        destinationType: "wallet" as const,
        assetId: principalAssetId,
        amount: lenderVaultAmount.toString(),
        confidential: true as const,
      },
    ] as const,
    change: [{ assetId: "lbtc" as const, destinationType: "change" as const }] as const,
  };
  return withDigest(planWithoutDigest);
}

async function withDigest<T extends object>(plan: T): Promise<T & { requirementDigest: `sha256:${string}` }> {
  return {
    ...plan,
    requirementDigest: await taggedCanonicalJsonHash(
      "apogee/tx-manifest-requirements/v1",
      plan,
    ),
  };
}

function exactInstanceArguments(
  value: Record<string, unknown>,
  actionName: string,
): Record<string, unknown> {
  const expected = new Set<string>(REQUIRED_INSTANCE_FIELDS);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(`Unknown ${actionName} argument ${key}.`);
  }
  for (const key of REQUIRED_INSTANCE_FIELDS) {
    if (!Object.hasOwn(value, key)) throw new Error(`Missing ${actionName} argument ${key}.`);
  }
  return value;
}

function providedOutpoint(
  inputs: TxManifestInvocation["providedInputs"],
  name: string,
): TxManifestOutpoint {
  const value = inputs?.[name];
  if (Array.isArray(value) || value === undefined) {
    throw new Error(`providedInputs.${name} must be one outpoint.`);
  }
  if (!/^[0-9a-f]{64}$/.test(value.txid) || !Number.isInteger(value.vout) || value.vout < 0) {
    throw new Error(`providedInputs.${name} is not a valid outpoint.`);
  }
  return { txid: value.txid, vout: value.vout };
}

function validateConstraints(value: TxManifestInvocation["constraints"]): {
  maxFee?: string;
  validUntilHeight?: number;
} {
  if (!value) return {};
  const constraints: { maxFee?: string; validUntilHeight?: number } = {};
  if (value.maxFee !== undefined) constraints.maxFee = decimalU64(value.maxFee, "constraints.maxFee");
  if (value.validUntilHeight !== undefined) {
    constraints.validUntilHeight = u32(value.validUntilHeight, "constraints.validUntilHeight");
  }
  return constraints;
}

function assetId(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${path} must be a lowercase 32-byte asset id.`);
  }
  return value;
}

function decimalU64(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${path} must be a canonical unsigned decimal string.`);
  }
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
