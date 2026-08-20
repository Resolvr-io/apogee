import { inspectElementsTransaction } from "@/engine/elements-txout";
import {
  SIMPLICITY_ROULETTE_V1_CANCEL,
  SIMPLICITY_ROULETTE_V1_CLAIM_PAYOUT,
  SIMPLICITY_ROULETTE_V1_FORFEIT,
  SIMPLICITY_ROULETTE_V1_OPEN,
  SIMPLICITY_ROULETTE_V1_SETTLE,
  SIMPLICITY_ROULETTE_V1_TAKE,
} from "./builtins/simplicity-roulette-v1";
import { fetchTxManifestFeeRate, txManifestFeePolicy, type TxManifestFeePolicy } from "./fees";
import { LIQUID_TESTNET_GENESIS_HASH } from "./network";
import type { AcceptOfferResolvedInput } from "./prepare-accept-offer";
import type { RouletteRequirementPlan, TxManifestOutpoint } from "./requirements";
import {
  decodeRouletteTransactionMetadata,
  type LocatedRouletteMetadata,
} from "./roulette-metadata";
import type { TxManifestTransactionOutputInspection } from "./runtime";

const TESTNET_ESPLORA = [
  "https://liquid.network/liquidtestnet/api",
  "https://blockstream.info/liquidtestnet/api",
] as const;

type FetchLike = typeof fetch;
type InspectOutput = (transactionHex: string, vout: number) => Promise<TxManifestTransactionOutputInspection>;

export type RouletteVerifiedInput = AcceptOfferResolvedInput & { confirmedHeight: number };

export type RouletteVerifiedChainSnapshot = {
  genesisHash: string;
  tipHeight: number;
  policyAssetId: string;
  inputs: Record<string, RouletteVerifiedInput>;
  parentTransactions: string[];
  feePolicy: TxManifestFeePolicy;
  parentMetadata?: LocatedRouletteMetadata;
};

export type RouletteChainResolution = { esploraUrl: string; snapshot: RouletteVerifiedChainSnapshot };

/** Resolve named outpoints and authenticate their canonical RLT1/TXMF lineage. */
export async function resolveRouletteChainSnapshot(
  plan: RouletteRequirementPlan,
  policyAssetId: string,
  inspectOutput: InspectOutput,
  configuredEsplora?: string,
  expectedGenesisHash: string = LIQUID_TESTNET_GENESIS_HASH,
  fetcher: FetchLike = fetch,
): Promise<RouletteChainResolution> {
  // Tip height and outspend state are consensus inputs to BIP68 preparation.
  // Chromium otherwise honors Esplora's short public cache lifetime and can
  // prepare a later lifecycle action against a stale height or spend status.
  const chainFetcher: FetchLike = (input, init) => fetcher(input, {
    ...init,
    cache: "no-store",
  });
  const candidates = configuredEsplora ? [configuredEsplora.replace(/\/+$/, "")] :
    expectedGenesisHash === LIQUID_TESTNET_GENESIS_HASH ? [...TESTNET_ESPLORA] : [];
  if (candidates.length === 0) throw new Error("A chain server must be configured for local roulette execution.");
  let lastError: unknown;
  for (const base of candidates) {
    try {
      const [genesisHash, tipHeight, feeRate] = await Promise.all([
        text(chainFetcher, `${base}/block-height/0`),
        text(chainFetcher, `${base}/blocks/tip/height`).then(height),
        fetchTxManifestFeeRate(chainFetcher, base),
      ]);
      if (genesisHash !== expectedGenesisHash) throw new Error("The chain server is on a different Liquid network.");
      const requested = requestedOutpoint(plan);
      if (!requested) return {
        esploraUrl: base,
        snapshot: {
          genesisHash, tipHeight, policyAssetId, inputs: {}, parentTransactions: [],
          feePolicy: txManifestFeePolicy(feeRate, plan.constraints.maxFee),
        },
      };
      const resolved = await resolve(chainFetcher, base, requested.outpoint, inspectOutput);
      const marker = await markerFromTransaction(resolved.transactionHex, plan.bundleHash);
      verifyParent(plan, requested.name, requested.outpoint, marker, resolved.transactionHex);
      return {
        esploraUrl: base,
        snapshot: {
          genesisHash,
          tipHeight,
          policyAssetId,
          inputs: { [requested.name]: resolved.input },
          parentTransactions: [resolved.transactionHex],
          feePolicy: txManifestFeePolicy(feeRate, plan.constraints.maxFee),
          parentMetadata: marker,
        },
      };
    } catch (error) {
      lastError = error;
      if (configuredEsplora) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("No roulette chain server is available.");
}

function requestedOutpoint(plan: RouletteRequirementPlan): { name: string; outpoint: TxManifestOutpoint } | null {
  switch (plan.action) {
    case SIMPLICITY_ROULETTE_V1_OPEN: return null;
    case SIMPLICITY_ROULETTE_V1_TAKE:
    case SIMPLICITY_ROULETTE_V1_CANCEL: return { name: "open_in", outpoint: plan.covenantInputs[0].outpoint };
    case SIMPLICITY_ROULETTE_V1_SETTLE:
    case SIMPLICITY_ROULETTE_V1_FORFEIT: return { name: "active_in", outpoint: plan.covenantInputs[0].outpoint };
    case SIMPLICITY_ROULETTE_V1_CLAIM_PAYOUT: return { name: "payout_in", outpoint: plan.payoutOutpoint };
  }
}

async function resolve(fetcher: FetchLike, base: string, outpoint: TxManifestOutpoint, inspectOutput: InspectOutput): Promise<{
  transactionHex: string;
  input: RouletteVerifiedInput;
}> {
  const [transactionHex, status, outspend] = await Promise.all([
    text(fetcher, `${base}/tx/${outpoint.txid}/hex`),
    json(fetcher, `${base}/tx/${outpoint.txid}/status`) as Promise<{ confirmed?: unknown; block_height?: unknown }>,
    json(fetcher, `${base}/tx/${outpoint.txid}/outspend/${outpoint.vout}`) as Promise<{ spent?: unknown }>,
  ]);
  if (status.confirmed !== true || !Number.isSafeInteger(status.block_height) || (status.block_height as number) < 0) {
    throw new Error(`Roulette input ${outpoint.txid}:${outpoint.vout} is not confirmed.`);
  }
  if (outspend.spent !== false) throw new Error(`Roulette input ${outpoint.txid}:${outpoint.vout} is already spent.`);
  const inspected = await inspectOutput(transactionHex, outpoint.vout);
  if (inspected.txid !== outpoint.txid || inspected.vout !== outpoint.vout) throw new Error("Chain server returned the wrong roulette outpoint.");
  if (!inspected.explicit || !inspected.asset || !inspected.amount) throw new Error("Roulette state and payout inputs must be explicit.");
  return {
    transactionHex,
    input: {
      txid: inspected.txid,
      vout: inspected.vout,
      txOut: inspected.tx_out,
      scriptPubKey: inspected.script_pub_key,
      assetId: inspected.asset,
      amount: inspected.amount,
      confirmedHeight: status.block_height as number,
    },
  };
}

async function markerFromTransaction(transactionHex: string, bundleHash: RouletteRequirementPlan["bundleHash"]): Promise<LocatedRouletteMetadata> {
  const shape = inspectElementsTransaction(bytes(transactionHex));
  const scripts = shape.outputs.map((output) => hex(output.scriptPubKey));
  const marker = await decodeRouletteTransactionMetadata(scripts, bundleHash);
  if (!marker) throw new Error("Roulette parent transaction has no RLT1 record.");
  for (let index = marker.chunkStartVout; index <= marker.txManifestVout; index += 1) {
    const output = shape.outputs[index]!;
    if (!output.explicitAsset || output.explicitValue !== 0n || !output.nullNonce) throw new Error("Roulette marker outputs must be explicit zero-value outputs.");
  }
  if (marker.txManifestVout !== shape.outputs.length - 2 || hex(shape.outputs.at(-1)?.scriptPubKey ?? new Uint8Array()) !== "") {
    throw new Error("Roulette RLT1/TXMF/fee placement is noncanonical.");
  }
  return marker;
}

function verifyParent(
  plan: RouletteRequirementPlan,
  inputName: string,
  outpoint: TxManifestOutpoint,
  located: LocatedRouletteMetadata,
  transactionHex: string,
): void {
  const marker = located.metadata;
  if (marker.roundId !== plan.intent.roundId) throw new Error("Roulette parent round id does not match the invocation.");
  if (plan.action === SIMPLICITY_ROULETTE_V1_TAKE || plan.action === SIMPLICITY_ROULETTE_V1_CANCEL) {
    if (marker.action !== "open" || marker.covenantVout !== outpoint.vout) throw new Error(`${inputName} is not the canonical OPEN output.`);
    if (
      marker.assetId !== plan.terms.assetId || marker.playerPayoutScript !== plan.terms.playerPayoutScript ||
      marker.secretCommitment !== plan.terms.secretCommitment || marker.betKind !== plan.terms.betKind ||
      marker.betSelection !== plan.terms.betSelection || marker.stake !== plan.terms.stake || marker.bond !== plan.terms.bond ||
      marker.openExpiry !== plan.terms.openExpiry || marker.minRevealAge !== plan.terms.minRevealAge || marker.revealExpiry !== plan.terms.revealExpiry
    ) throw new Error("Invocation terms do not match the canonical OPEN metadata.");
    return;
  }
  if (plan.action === SIMPLICITY_ROULETTE_V1_SETTLE || plan.action === SIMPLICITY_ROULETTE_V1_FORFEIT) {
    if (marker.action !== "take" || marker.covenantVout !== outpoint.vout) throw new Error(`${inputName} is not the canonical ACTIVE output.`);
    if (marker.housePayoutScript !== plan.housePayoutScript || marker.houseNonce !== plan.houseNonce || marker.houseCollateral !== plan.houseCollateral) {
      throw new Error("Invocation house state does not match canonical Take metadata.");
    }
    return;
  }
  if (plan.action === SIMPLICITY_ROULETTE_V1_CLAIM_PAYOUT) {
    if (!(["settle", "cancel", "forfeit"] as const).includes(marker.action as "settle" | "cancel" | "forfeit")) {
      throw new Error("ClaimPayout parent is not a terminal roulette action.");
    }
    const shape = inspectElementsTransaction(bytes(transactionHex));
    const payout = shape.outputs[outpoint.vout];
    if (!payout || outpoint.vout >= located.chunkStartVout || !/^0014[0-9a-f]{40}$/.test(hex(payout.scriptPubKey))) {
      throw new Error("ClaimPayout does not reference a canonical terminal P2WPKH payout.");
    }
    if ((marker.action === "cancel" || marker.action === "forfeit") && outpoint.vout !== 0) {
      throw new Error("Cancel and Forfeit payouts must be output zero.");
    }
  }
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

function height(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Chain server returned an invalid height.");
  return Number(value);
}

function bytes(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/.test(value)) throw new Error("Chain server returned invalid transaction hex.");
  return Uint8Array.from(value.match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
