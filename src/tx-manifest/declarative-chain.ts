import { fetchTxManifestFeeRate } from "./fees";
import { LIQUID_TESTNET_GENESIS_HASH } from "./network";
import type { TxManifestOutpoint } from "./requirements";
import type { TxManifestTransactionOutputInspection } from "./runtime";

const LIQUID_TESTNET_ESPLORA = [
  "https://liquid.network/liquidtestnet/api",
  "https://blockstream.info/liquidtestnet/api",
] as const;

type FetchLike = typeof fetch;
type InspectOutput = (
  transactionHex: string,
  vout: number,
) => Promise<TxManifestTransactionOutputInspection>;

export type DeclarativeChainInputRequest = {
  id: string;
  outpoint: TxManifestOutpoint;
};

export type DeclarativeResolvedChainInput = {
  id: string;
  txid: string;
  vout: number;
  txOut: string;
  scriptPubKey: string;
  assetId: string;
  amount: string;
  transactionHex: string;
  confirmed: boolean;
  blockHeight: number | null;
};

export type DeclarativeChainSnapshot = {
  genesisHash: string;
  tipHeight: number;
  feeRateSatPerKvb: string;
  inputs: readonly DeclarativeResolvedChainInput[];
  parentTransactions: readonly string[];
};

/**
 * Host-owned, bounded chain lookup for an untrusted declarative recipe.
 *
 * The adapter supplies only exact outpoints. It never receives a fetch
 * primitive or a URL and cannot make arbitrary requests. Mempool outputs are
 * accepted: consensus-enforced sequences and covenant checks, rather than a
 * wallet policy, decide whether the resulting transaction is currently valid.
 */
export async function resolveDeclarativeChainSnapshot(
  requestedInputs: readonly DeclarativeChainInputRequest[],
  inspectOutput: InspectOutput,
  configuredEsplora: string | undefined,
  expectedGenesisHash: string,
  fetcher: FetchLike = fetch,
): Promise<DeclarativeChainSnapshot> {
  requireDistinctRequests(requestedInputs);
  const candidates = chainServerCandidates(configuredEsplora, expectedGenesisHash);
  let lastError: unknown;
  for (const esploraUrl of candidates) {
    try {
      const [genesisHash, tipHeight, feeRateSatPerKvb] = await Promise.all([
        text(fetcher, `${esploraUrl}/block-height/0`),
        text(fetcher, `${esploraUrl}/blocks/tip/height`).then(parseHeight),
        fetchTxManifestFeeRate(fetcher, esploraUrl),
      ]);
      if (genesisHash !== expectedGenesisHash) {
        throw new Error("The configured chain server does not match the connected Liquid network.");
      }
      const inputs = await Promise.all(
        requestedInputs.map((request) =>
          resolveInput(fetcher, esploraUrl, request, inspectOutput),
        ),
      );
      return {
        genesisHash,
        tipHeight,
        feeRateSatPerKvb,
        inputs,
        parentTransactions: [...new Set(inputs.map((input) => input.transactionHex))],
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

async function resolveInput(
  fetcher: FetchLike,
  base: string,
  request: DeclarativeChainInputRequest,
  inspectOutput: InspectOutput,
): Promise<DeclarativeResolvedChainInput> {
  const { txid, vout } = request.outpoint;
  const [transactionHex, rawStatus, rawOutspend] = await Promise.all([
    text(fetcher, `${base}/tx/${txid}/hex`),
    json(fetcher, `${base}/tx/${txid}/status`),
    json(fetcher, `${base}/tx/${txid}/outspend/${vout}`),
  ]);
  const outspend = object(rawOutspend, "chain outspend");
  if (outspend.spent !== false) {
    throw new Error(`Declarative input ${txid}:${vout} is already spent.`);
  }
  const status = parseStatus(rawStatus);
  const inspected = await inspectOutput(transactionHex, vout);
  if (inspected.txid !== txid || inspected.vout !== vout) {
    throw new Error("The chain server returned a transaction that does not match the requested outpoint.");
  }
  if (!inspected.explicit || !inspected.asset || !inspected.amount) {
    throw new Error("Declarative v1 requires explicit provided inputs.");
  }
  return {
    id: request.id,
    txid,
    vout,
    txOut: inspected.tx_out,
    scriptPubKey: inspected.script_pub_key,
    assetId: inspected.asset,
    amount: inspected.amount,
    transactionHex,
    ...status,
  };
}

function parseStatus(value: unknown): { confirmed: boolean; blockHeight: number | null } {
  const status = object(value, "chain transaction status");
  if (typeof status.confirmed !== "boolean") {
    throw new Error("Chain server returned an invalid transaction status.");
  }
  if (!status.confirmed) return { confirmed: false, blockHeight: null };
  const blockHeight = status.block_height;
  if (!Number.isSafeInteger(blockHeight) || (blockHeight as number) < 0 || (blockHeight as number) > 0xffff_ffff) {
    throw new Error("Chain server returned an invalid confirmation height.");
  }
  return { confirmed: true, blockHeight: blockHeight as number };
}

function requireDistinctRequests(requests: readonly DeclarativeChainInputRequest[]): void {
  const ids = new Set<string>();
  const outpoints = new Set<string>();
  for (const request of requests) {
    if (ids.has(request.id)) throw new Error(`Declarative input id ${request.id} is duplicated.`);
    ids.add(request.id);
    const key = `${request.outpoint.txid}:${request.outpoint.vout}`;
    if (outpoints.has(key)) throw new Error(`Declarative outpoint ${key} is duplicated.`);
    outpoints.add(key);
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
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Chain server returned an invalid tip height.");
  }
  const height = Number(value);
  if (!Number.isSafeInteger(height) || height > 0xffff_ffff) {
    throw new Error("Chain server returned an invalid tip height.");
  }
  return height;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function normalizeBase(value: string): string {
  return value.replace(/\/+$/, "");
}
