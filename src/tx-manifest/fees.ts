import {
  estimateTxManifestFee,
  type TxManifestFeeEstimate,
} from "./runtime";

/** LWK's conservative default, expressed in the sat/kvB unit its builder uses. */
export const TX_MANIFEST_FALLBACK_FEE_RATE_SAT_PER_KVB = "100";

/** Wallet-owned safety ceiling used even when a dapp omits constraints.maxFee. */
export const TX_MANIFEST_MAX_FEE = "100000";

export const TX_MANIFEST_MAX_FEE_ITERATIONS = 16;

export type TxManifestFeePolicy = {
  feeRateSatPerKvb: string;
  maxFee: string;
  /** Set only while revalidating a transaction whose exact fee was reviewed. */
  exactFee?: string;
};

export type TxManifestFeeCandidate = {
  pset: string;
  review: { fee: string };
};

type FetchLike = typeof fetch;
type FeeEstimator = (spec: {
  pset: string;
  feeRateSatPerKvb: string;
}) => Promise<TxManifestFeeEstimate>;

/**
 * Convert Esplora's 1-block sat/vB estimate into the integer sat/kvB unit used
 * by LWK. A missing or malformed endpoint deliberately falls back to LWK's
 * conservative default so local/regtest execution remains deterministic.
 */
export async function fetchTxManifestFeeRate(
  fetcher: FetchLike,
  esploraUrl: string,
): Promise<string> {
  try {
    const response = await fetcher(`${normalizeBase(esploraUrl)}/fee-estimates`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`fee estimate request failed (${response.status})`);
    const estimates = await response.json() as Record<string, unknown>;
    const satPerVbyte = estimates["1"];
    if (typeof satPerVbyte !== "number" || !Number.isFinite(satPerVbyte) || satPerVbyte <= 0) {
      throw new Error("fee estimate is missing a positive 1-block target");
    }
    const satPerKvb = Math.ceil(satPerVbyte * 1_000);
    if (!Number.isSafeInteger(satPerKvb) || satPerKvb <= 0) {
      throw new Error("fee estimate is outside the supported range");
    }
    return satPerKvb.toString();
  } catch {
    return TX_MANIFEST_FALLBACK_FEE_RATE_SAT_PER_KVB;
  }
}

/** Apply both the dapp-authored cap and Apogee's independent wallet ceiling. */
export function txManifestFeePolicy(
  feeRateSatPerKvb: string,
  dappMaxFee?: string,
): TxManifestFeePolicy {
  const rate = positiveInteger(feeRateSatPerKvb, "fee rate");
  const walletMaximum = BigInt(TX_MANIFEST_MAX_FEE);
  const maximum = dappMaxFee === undefined
    ? walletMaximum
    : minBigInt(positiveInteger(dappMaxFee, "manifest fee cap"), walletMaximum);
  return {
    feeRateSatPerKvb: rate.toString(),
    maxFee: maximum.toString(),
  };
}

/**
 * Rebuild until the finalized transaction shape is sufficiently funded.
 *
 * Fee movement is monotonic, so a fee-driven input/change-shape transition can
 * settle without oscillation. The exact-fee mode is used after approval: it
 * verifies the reviewed fee is still sufficient but never raises it silently.
 */
export async function convergeTxManifestFee<T extends TxManifestFeeCandidate>(
  policy: TxManifestFeePolicy,
  prepare: (fee: string) => Promise<T>,
  estimate: FeeEstimator = estimateTxManifestFee,
): Promise<T> {
  const rate = positiveInteger(policy.feeRateSatPerKvb, "fee rate");
  const maximum = positiveInteger(policy.maxFee, "manifest fee cap");

  if (policy.exactFee !== undefined) {
    const exact = positiveInteger(policy.exactFee, "reviewed fee");
    if (exact > maximum) throw new Error("The reviewed fee exceeds the manifest fee cap.");
    const candidate = await prepare(exact.toString());
    requireCandidateFee(candidate, exact);
    const required = await requiredFee(candidate, rate, estimate);
    if (required > exact) {
      throw new Error(
        "Network fees increased beyond the reviewed fee; request a new TX Manifest approval.",
      );
    }
    return candidate;
  }

  let fee = 1n;
  for (let iteration = 0; iteration < TX_MANIFEST_MAX_FEE_ITERATIONS; iteration += 1) {
    if (fee > maximum) {
      throw new Error("The estimated network fee exceeds the manifest fee cap.");
    }
    const candidate = await prepare(fee.toString());
    requireCandidateFee(candidate, fee);
    const required = await requiredFee(candidate, rate, estimate);
    if (required <= fee) return candidate;
    fee = required;
  }
  throw new Error("TX Manifest fee estimation did not converge within the safety limit.");
}

async function requiredFee(
  candidate: TxManifestFeeCandidate,
  feeRateSatPerKvb: bigint,
  estimate: FeeEstimator,
): Promise<bigint> {
  const result = await estimate({
    pset: candidate.pset,
    feeRateSatPerKvb: feeRateSatPerKvb.toString(),
  });
  return positiveInteger(result.requiredFee, "estimated fee");
}

function requireCandidateFee(candidate: TxManifestFeeCandidate, expected: bigint): void {
  if (positiveInteger(candidate.review.fee, "prepared fee") !== expected) {
    throw new Error("The prepared transaction fee does not match the requested fee.");
  }
}

function positiveInteger(value: string, label: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be a positive integer.`);
  return BigInt(value);
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function normalizeBase(value: string): string {
  return value.replace(/\/+$/, "");
}
