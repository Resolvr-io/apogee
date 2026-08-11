import type {
  AcceptOfferRequirementPlan,
  CancelOfferRequirementPlan,
  ClaimLenderVaultRequirementPlan,
  ClaimPrincipalRequirementPlan,
  CreateFactoryRequirementPlan,
  CreateOfferRequirementPlan,
  LiquidateOfferRequirementPlan,
  RepayLoanRequirementPlan,
  TxManifestOutpoint,
} from "./requirements";
import {
  SIMPLICITY_LENDING_V3_CANCEL_OFFER,
  SIMPLICITY_LENDING_V3_CLAIM_PRINCIPAL,
  SIMPLICITY_LENDING_V3_CREATE_FACTORY,
  SIMPLICITY_LENDING_V3_CREATE_OFFER,
  SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER,
  SIMPLICITY_LENDING_V3_REPAY_LOAN,
} from "./builtins/simplicity-lending-v3";
import type {
  AcceptOfferVerifiedChainSnapshot,
  ClaimLenderVaultVerifiedChainSnapshot,
} from "./wallet-host";
import type { TxManifestTransactionOutputInspection } from "./runtime";
import { LIQUID_TESTNET_GENESIS_HASH } from "./network";

export { LIQUID_TESTNET_GENESIS_HASH } from "./network";
export const TX_MANIFEST_DEFAULT_FEE = "1000";

const LIQUID_TESTNET_ESPLORA = [
  "https://liquid.network/liquidtestnet/api",
  "https://blockstream.info/liquidtestnet/api",
] as const;

type FetchLike = typeof fetch;
type InspectOutput = (
  transactionHex: string,
  vout: number,
) => Promise<TxManifestTransactionOutputInspection>;

export type TxManifestChainResolution = {
  esploraUrl: string;
  snapshot: AcceptOfferVerifiedChainSnapshot;
};

export type ClaimLenderVaultChainResolution = {
  esploraUrl: string;
  snapshot: ClaimLenderVaultVerifiedChainSnapshot;
};

export type NewLendingActionRequirementPlan =
  | CreateFactoryRequirementPlan
  | CreateOfferRequirementPlan
  | ClaimPrincipalRequirementPlan
  | CancelOfferRequirementPlan
  | RepayLoanRequirementPlan
  | LiquidateOfferRequirementPlan;

export type NewLendingActionChainResolution = {
  esploraUrl: string;
  snapshot: {
    genesisHash: string;
    tipHeight: number;
    policyAssetId: string;
    inputs: Record<string, AcceptOfferVerifiedChainSnapshot["pendingOffer"]>;
    parentTransactions: string[];
    fee: string;
  };
};

/** Resolve every dapp-named input for the borrower and liquidation actions. */
export async function resolveNewLendingActionChainSnapshot(
  plan: NewLendingActionRequirementPlan,
  policyAssetId: string,
  inspectOutput: InspectOutput,
  configuredEsplora?: string,
  expectedGenesisHash: string = LIQUID_TESTNET_GENESIS_HASH,
  fetcher: FetchLike = fetch,
): Promise<NewLendingActionChainResolution> {
  requireSupportedFee(plan.constraints.maxFee);
  const requested = newActionOutpoints(plan);
  const candidates = chainServerCandidates(configuredEsplora, expectedGenesisHash);
  let lastError: unknown;
  for (const esploraUrl of candidates) {
    try {
      const [genesisHash, tipHeight] = await Promise.all([
        text(fetcher, `${esploraUrl}/block-height/0`),
        text(fetcher, `${esploraUrl}/blocks/tip/height`).then(parseHeight),
      ]);
      if (genesisHash !== expectedGenesisHash) {
        throw new Error("The configured chain server does not match the connected Liquid network.");
      }
      const resolved = await Promise.all(
        requested.map(async ([name, outpoint]) => [
          name,
          await resolveOutpoint(fetcher, esploraUrl, outpoint, inspectOutput),
        ] as const),
      );
      return {
        esploraUrl,
        snapshot: {
          genesisHash,
          tipHeight,
          policyAssetId,
          inputs: Object.fromEntries(resolved.map(([name, value]) => [name, value.input])),
          parentTransactions: [...new Set(resolved.map(([, value]) => value.transactionHex))],
          fee: TX_MANIFEST_DEFAULT_FEE,
        },
      };
    } catch (error) {
      lastError = error;
      if (configuredEsplora) break;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("No Liquid testnet chain server is available.");
}

function newActionOutpoints(
  plan: NewLendingActionRequirementPlan,
): Array<[string, TxManifestOutpoint]> {
  switch (plan.action) {
    case SIMPLICITY_LENDING_V3_CREATE_FACTORY:
      return [];
    case SIMPLICITY_LENDING_V3_CREATE_OFFER:
      return [
        ["factory_auth_in", plan.walletInputs[0].outpoint],
        ["factory_covenant_in", plan.covenantInputs[0].outpoint],
      ];
    case SIMPLICITY_LENDING_V3_CLAIM_PRINCIPAL:
      return [
        ["principal_asset_auth_in", plan.covenantInputs[0].outpoint],
        ["borrower_nft_in", plan.walletInputs[0].outpoint],
      ];
    case SIMPLICITY_LENDING_V3_CANCEL_OFFER:
      return [
        ["pending_offer_in", plan.covenantInputs[0].outpoint],
        ["lender_nft_in", plan.covenantInputs[1].outpoint],
        ["borrower_nft_in", plan.walletInputs[0].outpoint],
      ];
    case SIMPLICITY_LENDING_V3_REPAY_LOAN:
      return [
        ["active_offer_in", plan.covenantInputs[0].outpoint],
        ["borrower_nft_in", plan.walletInputs[0].outpoint],
      ];
    case SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER:
      return [
        ["active_offer_in", plan.covenantInputs[0].outpoint],
        ["lender_nft_in", plan.walletInputs[0].outpoint],
      ];
  }
}

/** Choose one correctly-networked Esplora endpoint and take a fresh covenant snapshot. */
export async function resolveAcceptOfferChainSnapshot(
  plan: AcceptOfferRequirementPlan,
  policyAssetId: string,
  inspectOutput: InspectOutput,
  configuredEsplora?: string,
  expectedGenesisHash: string = LIQUID_TESTNET_GENESIS_HASH,
  fetcher: FetchLike = fetch,
): Promise<TxManifestChainResolution> {
  if (
    plan.constraints.maxFee !== undefined &&
    BigInt(plan.constraints.maxFee) < BigInt(TX_MANIFEST_DEFAULT_FEE)
  ) {
    throw new Error(
      `The manifest fee cap is below Apogee's ${TX_MANIFEST_DEFAULT_FEE}-sat first-release fee.`,
    );
  }
  const candidates = chainServerCandidates(configuredEsplora, expectedGenesisHash);
  let lastError: unknown;
  for (const esploraUrl of candidates) {
    try {
      const [genesisHash, tipHeight] = await Promise.all([
        text(fetcher, `${esploraUrl}/block-height/0`),
        text(fetcher, `${esploraUrl}/blocks/tip/height`).then(parseHeight),
      ]);
      if (genesisHash !== expectedGenesisHash) {
        throw new Error("The configured chain server does not match the connected Liquid network.");
      }
      const [pending, lenderNft] = await Promise.all([
        resolveOutpoint(fetcher, esploraUrl, plan.covenantInputs[0].outpoint, inspectOutput),
        resolveOutpoint(fetcher, esploraUrl, plan.covenantInputs[1].outpoint, inspectOutput),
      ]);
      return {
        esploraUrl,
        snapshot: {
          genesisHash,
          tipHeight,
          policyAssetId,
          pendingOffer: pending.input,
          lenderNftAuthorization: lenderNft.input,
          parentTransactions: [...new Set([pending.transactionHex, lenderNft.transactionHex])],
          fee: TX_MANIFEST_DEFAULT_FEE,
        },
      };
    } catch (error) {
      lastError = error;
      if (configuredEsplora) break;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("No Liquid testnet chain server is available.");
}

/** Resolve the finalized vault and supplied lender NFT from one verified testnet view. */
export async function resolveClaimLenderVaultChainSnapshot(
  plan: ClaimLenderVaultRequirementPlan,
  policyAssetId: string,
  inspectOutput: InspectOutput,
  configuredEsplora?: string,
  expectedGenesisHash: string = LIQUID_TESTNET_GENESIS_HASH,
  fetcher: FetchLike = fetch,
): Promise<ClaimLenderVaultChainResolution> {
  requireSupportedFee(plan.constraints.maxFee);
  const candidates = chainServerCandidates(configuredEsplora, expectedGenesisHash);
  let lastError: unknown;
  for (const esploraUrl of candidates) {
    try {
      const [genesisHash, tipHeight] = await Promise.all([
        text(fetcher, `${esploraUrl}/block-height/0`),
        text(fetcher, `${esploraUrl}/blocks/tip/height`).then(parseHeight),
      ]);
      if (genesisHash !== expectedGenesisHash) {
        throw new Error("The configured chain server does not match the connected Liquid network.");
      }
      const [vault, lenderNft] = await Promise.all([
        resolveOutpoint(fetcher, esploraUrl, plan.covenantInputs[0].outpoint, inspectOutput),
        resolveOutpoint(fetcher, esploraUrl, plan.walletInputs[0].outpoint, inspectOutput),
      ]);
      return {
        esploraUrl,
        snapshot: {
          genesisHash,
          tipHeight,
          policyAssetId,
          lenderVault: vault.input,
          lenderNft: lenderNft.input,
          parentTransactions: [...new Set([vault.transactionHex, lenderNft.transactionHex])],
          fee: TX_MANIFEST_DEFAULT_FEE,
        },
      };
    } catch (error) {
      lastError = error;
      if (configuredEsplora) break;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("No Liquid testnet chain server is available.");
}

function requireSupportedFee(maxFee: string | undefined): void {
  if (maxFee !== undefined && BigInt(maxFee) < BigInt(TX_MANIFEST_DEFAULT_FEE)) {
    throw new Error(
      `The manifest fee cap is below Apogee's ${TX_MANIFEST_DEFAULT_FEE}-sat first-release fee.`,
    );
  }
}

function chainServerCandidates(
  configuredEsplora: string | undefined,
  expectedGenesisHash: string,
): string[] {
  if (configuredEsplora) return [normalizeBase(configuredEsplora)];
  if (expectedGenesisHash === LIQUID_TESTNET_GENESIS_HASH) return [...LIQUID_TESTNET_ESPLORA];
  throw new Error("A chain server must be configured for local TX Manifest execution.");
}

async function resolveOutpoint(
  fetcher: FetchLike,
  base: string,
  outpoint: TxManifestOutpoint,
  inspectOutput: InspectOutput,
): Promise<{
  transactionHex: string;
  input: AcceptOfferVerifiedChainSnapshot["pendingOffer"];
}> {
  const [transactionHex, status, outspend] = await Promise.all([
    text(fetcher, `${base}/tx/${outpoint.txid}/hex`),
    json(fetcher, `${base}/tx/${outpoint.txid}/status`),
    json(fetcher, `${base}/tx/${outpoint.txid}/outspend/${outpoint.vout}`),
  ]);
  if ((status as { confirmed?: unknown }).confirmed !== true) {
    throw new Error(`Covenant input ${outpoint.txid}:${outpoint.vout} is not confirmed.`);
  }
  if ((outspend as { spent?: unknown }).spent !== false) {
    throw new Error(`Covenant input ${outpoint.txid}:${outpoint.vout} is already spent.`);
  }
  const inspected = await inspectOutput(transactionHex, outpoint.vout);
  if (inspected.txid !== outpoint.txid || inspected.vout !== outpoint.vout) {
    throw new Error("The chain server returned a transaction that does not match the requested outpoint.");
  }
  if (!inspected.explicit || !inspected.asset || !inspected.amount) {
    throw new Error("The first TX Manifest release requires explicit covenant inputs.");
  }
  return {
    transactionHex,
    input: {
      txid: inspected.txid,
      vout: inspected.vout,
      txOut: inspected.tx_out,
      scriptPubKey: inspected.script_pub_key,
      assetId: inspected.asset,
      amount: inspected.amount,
    },
  };
}

async function text(fetcher: FetchLike, url: string): Promise<string> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Chain server request failed (${response.status}).`);
  return (await response.text()).trim();
}

async function json(fetcher: FetchLike, url: string): Promise<unknown> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Chain server request failed (${response.status}).`);
  return response.json();
}

function parseHeight(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error("Chain server returned an invalid tip height.");
  const height = Number(value);
  if (!Number.isSafeInteger(height) || height > 0xffff_ffff) {
    throw new Error("Chain server returned an invalid tip height.");
  }
  return height;
}

function normalizeBase(value: string): string {
  return value.replace(/\/+$/, "");
}
