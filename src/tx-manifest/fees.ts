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
  /** Input-selection fee target paired with `exactFee` during revalidation. */
  exactSelectionFee?: string;
};

export type TxManifestFeeCandidate = {
  pset: string;
  /** Fee lower bound used to select the candidate's wallet inputs. */
  feeSelectionTarget: string;
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
 * Selection-fee movement is monotonic, so a fee-driven input/change-shape
 * transition can settle without oscillation. A candidate's actual fee may be
 * slightly higher when sub-floor L-BTC change is folded into fees. Exact mode
 * retains both values after approval: it recreates the reviewed selection and
 * verifies the reviewed actual fee is still sufficient without raising it.
 */
export async function convergeTxManifestFee<T extends TxManifestFeeCandidate>(
  policy: TxManifestFeePolicy,
  prepare: (fee: string) => Promise<T>,
  estimate: FeeEstimator = estimateTxManifestFee,
): Promise<T> {
  const rate = positiveInteger(policy.feeRateSatPerKvb, "fee rate");
  const maximum = positiveInteger(policy.maxFee, "manifest fee cap");

  if ((policy.exactFee === undefined) !== (policy.exactSelectionFee === undefined)) {
    throw new Error("Reviewed actual and selection fees must be supplied together.");
  }

  if (policy.exactFee !== undefined && policy.exactSelectionFee !== undefined) {
    const exact = positiveInteger(policy.exactFee, "reviewed fee");
    const selection = positiveInteger(policy.exactSelectionFee, "reviewed fee selection target");
    if (selection > exact) {
      throw new Error("The reviewed fee selection target exceeds the reviewed fee.");
    }
    if (exact > maximum) throw new Error("The reviewed fee exceeds the manifest fee cap.");
    const candidate = await prepare(selection.toString());
    requireSelectionFee(candidate, selection);
    requireActualFee(candidate, exact);
    const required = await requiredFee(candidate, rate, estimate);
    if (required > exact) {
      throw new Error(
        "Network fees increased beyond the reviewed fee; request a new TX Manifest approval.",
      );
    }
    return candidate;
  }

  let selectionFee = 1n;
  for (let iteration = 0; iteration < TX_MANIFEST_MAX_FEE_ITERATIONS; iteration += 1) {
    if (selectionFee > maximum) {
      throw new Error("The estimated network fee exceeds the manifest fee cap.");
    }
    const candidate = await prepare(selectionFee.toString());
    requireSelectionFee(candidate, selectionFee);
    const actualFee = candidateActualFee(candidate);
    if (actualFee < selectionFee) {
      throw new Error("The prepared transaction fee is below its selection target.");
    }
    if (actualFee > maximum) {
      throw new Error("The prepared transaction fee exceeds the manifest fee cap.");
    }
    const required = await requiredFee(candidate, rate, estimate);
    if (required <= actualFee) return candidate;
    selectionFee = required;
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

function requireSelectionFee(candidate: TxManifestFeeCandidate, expected: bigint): void {
  if (positiveInteger(candidate.feeSelectionTarget, "prepared fee selection target") !== expected) {
    throw new Error("The prepared fee selection target does not match the requested fee.");
  }
}

function requireActualFee(candidate: TxManifestFeeCandidate, expected: bigint): void {
  if (candidateActualFee(candidate) !== expected) {
    throw new Error("The prepared transaction fee does not match the reviewed fee.");
  }
}

function candidateActualFee(candidate: TxManifestFeeCandidate): bigint {
  return positiveInteger(candidate.review.fee, "prepared fee");
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
