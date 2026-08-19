export const TX_MANIFEST_LONG_TERM_FEE_RATE_SAT_PER_KVB = "100";

/**
 * Minimum L-BTC change left after paying the live transaction fee.
 *
 * This is an economic wallet threshold, not an Elements relay-dust rule. An
 * Apogee P2WPKH change coin adds 68 discounted vbytes when spent later. At the
 * wallet-owned long-term rate of 100 sat/kvB, ceil(68 * 100 / 1000) is 7 sats.
 * The live cost of creating the confidential output is priced separately by
 * dynamic fee estimation. Issued-asset change is never folded into fees.
 */
export const TX_MANIFEST_MINIMUM_POST_FEE_LBTC_CHANGE = "7";

export type TxManifestLbtcChangeDecision = {
  selectionFee: string;
  actualFee: string;
  postFeeChange: string;
  foldedChange: string;
};

/**
 * Apply Apogee's economic L-BTC change floor to one deterministic selection.
 * `fixedOutputAmount` includes every policy-asset payment other than fees and
 * discretionary wallet change.
 */
export function txManifestLbtcChangeDecision(
  selectedInputs: readonly { amount: string }[],
  fixedOutputAmount: string,
  selectionFee: string,
): TxManifestLbtcChangeDecision {
  const selected = selectedInputs.reduce(
    (total, input) => total + decimal(input.amount, "selected input amount"),
    0n,
  );
  const fixed = decimal(fixedOutputAmount, "fixed policy output amount");
  const requested = positiveDecimal(selectionFee, "selection fee");
  const change = selected - fixed - requested;
  if (change < 0n) {
    throw new Error("Selected L-BTC inputs do not cover the fixed outputs and selection fee.");
  }
  const minimum = BigInt(TX_MANIFEST_MINIMUM_POST_FEE_LBTC_CHANGE);
  const folded = change > 0n && change < minimum ? change : 0n;
  return {
    selectionFee: requested.toString(),
    actualFee: (requested + folded).toString(),
    postFeeChange: (change - folded).toString(),
    foldedChange: folded.toString(),
  };
}

function decimal(value: string, label: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return BigInt(value);
}

function positiveDecimal(value: string, label: string): bigint {
  const parsed = decimal(value, label);
  if (parsed === 0n) throw new Error(`${label} must be greater than zero.`);
  return parsed;
}
