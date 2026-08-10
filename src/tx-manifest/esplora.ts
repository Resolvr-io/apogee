import type {
  AcceptOfferRequirementPlan,
  ClaimLenderVaultRequirementPlan,
  TxManifestOutpoint,
} from "./requirements";
import type {
  AcceptOfferVerifiedChainSnapshot,
  ClaimLenderVaultVerifiedChainSnapshot,
} from "./wallet-host";
import type { TxManifestTransactionOutputInspection } from "./runtime";

export const LIQUID_TESTNET_GENESIS_HASH =
  "a771da8e52ee6ad581ed1e9a99825e5b3b7992225534eaa2ae23244fe26ab1c1";
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

/** Choose one correctly-networked Esplora endpoint and take a fresh covenant snapshot. */
export async function resolveAcceptOfferChainSnapshot(
  plan: AcceptOfferRequirementPlan,
  policyAssetId: string,
  inspectOutput: InspectOutput,
  configuredEsplora?: string,
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
  const candidates = configuredEsplora
    ? [normalizeBase(configuredEsplora)]
    : [...LIQUID_TESTNET_ESPLORA];
  let lastError: unknown;
  for (const esploraUrl of candidates) {
    try {
      const [genesisHash, tipHeight] = await Promise.all([
        text(fetcher, `${esploraUrl}/block-height/0`),
        text(fetcher, `${esploraUrl}/blocks/tip/height`).then(parseHeight),
      ]);
      if (genesisHash !== LIQUID_TESTNET_GENESIS_HASH) {
        throw new Error("The configured chain server is not Liquid testnet.");
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
  fetcher: FetchLike = fetch,
): Promise<ClaimLenderVaultChainResolution> {
  requireSupportedFee(plan.constraints.maxFee);
  const candidates = configuredEsplora
    ? [normalizeBase(configuredEsplora)]
    : [...LIQUID_TESTNET_ESPLORA];
  let lastError: unknown;
  for (const esploraUrl of candidates) {
    try {
      const [genesisHash, tipHeight] = await Promise.all([
        text(fetcher, `${esploraUrl}/block-height/0`),
        text(fetcher, `${esploraUrl}/blocks/tip/height`).then(parseHeight),
      ]);
      if (genesisHash !== LIQUID_TESTNET_GENESIS_HASH) {
        throw new Error("The configured chain server is not Liquid testnet.");
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
