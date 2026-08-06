// Read-only security gate for the ELIP signPset RPC.
//
// LWK's signer signs every input it recognizes. Before a caller-controlled PSET
// can ever reach that signer, this analyzer binds every input to a current
// wallet UTXO, requires every input to be explicitly listed in signInputs, and
// derives a complete review from wallet state. It deliberately supports only
// Apogee's current native-SegWit single-key inputs. Collaborative PSETs,
// issuances, arbitrary scripts, and incomplete confidential data fail closed.

import type * as Lwk from "lwk_wasm";
import type {
  ProviderPsetAnalysisFailureReason,
  ProviderPsetAnalysisResultDTO,
  ProviderPsetInputReviewDTO,
  ProviderPsetRecipientReviewDTO,
  ProviderPsetSignResultDTO,
} from "./protocol";
import type { ProviderPsetAnalysisDTO } from "./protocol";
import { providerPsetReviewsMatch } from "./provider-pset-review";

export interface NormalizedProviderPsetSignInput {
  index: number;
  address: string;
  scriptPubKey: string;
  sighashTypes?: number[];
}

const DEFAULT_SIGHASH = 1;
const VALID_SIGHASH_TYPES = new Set([1, 2, 3, 129, 130, 131]);
// Only modes that commit to every output are safe for an ordinary wallet
// approval. NONE and SINGLE remain valid ELIP values, but require a purpose-
// built review flow because the signed PSET can be changed after approval.
const SUPPORTED_SIGHASH_TYPES = new Set([1, 129]);
const P2WPKH = /^0014[0-9a-f]{40}$/;

interface WalletUtxoReview {
  txid: string;
  vout: number;
  address: string;
  assetId: string;
  amount: bigint;
  scriptPubKey: string;
  confidential: boolean;
}

export function analyzeProviderPset(
  pset: Lwk.Pset,
  wollet: Lwk.Wollet,
  policyAssetId: string,
  requestedInputs: readonly NormalizedProviderPsetSignInput[],
): ProviderPsetAnalysisResultDTO {
  // Dealer- and dapp-built PSETs may omit witness UTXOs and derivation data.
  // Enrich from the trusted Wollet before taking input/output snapshots.
  pset.addDetails(wollet);

  const inputs = pset.inputs();
  const outputs = pset.outputs();
  if (inputs.length === 0 || outputs.length === 0 || requestedInputs.length === 0) {
    return failure("invalid_request");
  }

  const requested = new Map<number, NormalizedProviderPsetSignInput>();
  for (const request of requestedInputs) {
    if (
      !Number.isSafeInteger(request.index) ||
      request.index < 0 ||
      request.index >= inputs.length ||
      requested.has(request.index)
    ) {
      return failure("invalid_request", request.index);
    }
    const sighashTypes = request.sighashTypes ?? [DEFAULT_SIGHASH];
    if (
      sighashTypes.length === 0 ||
      new Set(sighashTypes).size !== sighashTypes.length ||
      sighashTypes.some((value) => !VALID_SIGHASH_TYPES.has(value))
    ) {
      return failure("invalid_request", request.index);
    }
    requested.set(request.index, request);
  }

  const walletUtxos = new Map<string, WalletUtxoReview>();
  for (const utxo of wollet.utxos()) {
    const outpoint = utxo.outpoint();
    const unblinded = utxo.unblinded();
    const review: WalletUtxoReview = {
      txid: outpoint.txid().toString(),
      vout: outpoint.vout(),
      address: utxo.address().toString(),
      assetId: unblinded.asset().toString(),
      amount: BigInt(unblinded.value().toString()),
      scriptPubKey: utxo.scriptPubkey().toString(),
      confidential: !unblinded.isExplicit(),
    };
    walletUtxos.set(outpointKey(review.txid, review.vout), review);
  }

  const seenOutpoints = new Set<string>();
  const inputTotals = new Map<string, bigint>();
  const inputReviews: ProviderPsetInputReviewDTO[] = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    const txid = input.previousTxid().toString();
    const vout = input.previousVout();
    const key = outpointKey(txid, vout);
    if (seenOutpoints.has(key)) return failure("duplicate_input", index);
    seenOutpoints.add(key);

    const walletUtxo = walletUtxos.get(key);
    if (!walletUtxo) return failure("input_not_current_utxo", index);
    const request = requested.get(index);
    if (!request) return failure("unrequested_wallet_input", index);

    const previousScript = input.previousScriptPubkey()?.toString();
    if (!previousScript || previousScript !== walletUtxo.scriptPubKey) {
      return failure("input_prevout_mismatch", index);
    }
    if (
      !P2WPKH.test(previousScript) ||
      input.redeemScript() !== undefined
    ) {
      return failure("private_or_unsupported_script", index);
    }
    if (request.scriptPubKey !== previousScript) {
      return failure("input_address_mismatch", index);
    }

    const issuance = input.issuance();
    if (issuance?.isIssuance() || issuance?.isReissuance()) {
      return failure("unsupported_issuance", index);
    }

    const sighashType = input.sighash();
    if (!SUPPORTED_SIGHASH_TYPES.has(sighashType)) {
      return failure("unsupported_sighash", index);
    }
    if (!(request.sighashTypes ?? [DEFAULT_SIGHASH]).includes(sighashType)) {
      return failure("sighash_not_allowed", index);
    }
    addAmount(inputTotals, walletUtxo.assetId, walletUtxo.amount);
    inputReviews.push({
      index,
      txid,
      vout,
      address: walletUtxo.address,
      assetId: walletUtxo.assetId,
      amount: walletUtxo.amount.toString(),
      scriptPubKey: previousScript,
      confidential: walletUtxo.confidential,
      sighashType,
    });
  }
  if (requested.size !== inputs.length) return failure("invalid_request");

  const outputTotals = new Map<string, bigint>();
  const feeOutputs = new Map<string, bigint>();
  let hasConfidentialOutputs = false;
  for (const output of outputs) {
    const assetId = output.asset()?.toString();
    const amount = output.amount();
    if (!assetId || amount === undefined || amount < 0n) {
      return failure("unreviewable_output");
    }
    addAmount(outputTotals, assetId, amount);
    const scriptPubKey = output.scriptPubkey().toString();
    if (scriptPubKey === "") {
      if (assetId !== policyAssetId || output.blinderIndex() !== undefined) {
        return failure("non_policy_fee");
      }
      addAmount(feeOutputs, assetId, amount);
    } else if (output.blinderIndex() !== undefined) {
      hasConfidentialOutputs = true;
    }
  }
  if (!mapsEqual(inputTotals, outputTotals)) return failure("pset_value_mismatch");

  const psetBalance = wollet.psetDetails(pset).balance();
  const balanceChanges = bigintMap(psetBalance.balances().entries());
  const fees = bigintMap(psetBalance.fees().entries());
  if (!mapsEqual(feeOutputs, fees)) return failure("pset_balance_mismatch");
  for (const [assetId, amount] of fees) {
    if (amount < 0n || (amount !== 0n && assetId !== policyAssetId)) {
      return failure("non_policy_fee");
    }
  }

  const recipients: ProviderPsetRecipientReviewDTO[] = [];
  const recipientTotals = new Map<string, bigint>();
  for (const recipient of psetBalance.recipients()) {
    const assetId = recipient.asset()?.toString();
    const amount = recipient.value();
    const address = recipient.address();
    if (!assetId || amount === undefined || amount < 0n || !address) {
      return failure("unreviewable_output");
    }
    addAmount(recipientTotals, assetId, amount);
    const confidential = address.isBlinded();
    if (confidential) hasConfidentialOutputs = true;
    recipients.push({
      address: address.toString(),
      assetId,
      amount: amount.toString(),
      confidential,
    });
  }

  const reviewAssets = new Set([
    ...inputTotals.keys(),
    ...balanceChanges.keys(),
    ...fees.keys(),
    ...recipientTotals.keys(),
  ]);
  for (const assetId of reviewAssets) {
    const net = balanceChanges.get(assetId) ?? 0n;
    const explainedOutflow = (recipientTotals.get(assetId) ?? 0n) + (fees.get(assetId) ?? 0n);
    if (net > 0n || -net !== explainedOutflow) {
      return failure("pset_balance_mismatch");
    }
  }

  return {
    ok: true,
    analysis: {
      uniqueId: pset.uniqueId().toString(),
      walletStatus: wollet.status().toString(),
      inputCount: inputs.length,
      outputCount: outputs.length,
      policyAssetId,
      inputs: inputReviews,
      recipients,
      balanceChanges: stringRecord(balanceChanges),
      fees: stringRecord(fees),
      hasConfidentialInputs: inputReviews.some((input) => input.confidential),
      hasConfidentialOutputs,
    },
  };
}

/** Re-run the complete analyzer and sign that exact parsed PSET only when its
 * current effects still match the approval snapshot. The callback exists so
 * local-key signing stays testable without putting a seed in analyzer tests. */
export function analyzeAndSignProviderPset(
  pset: Lwk.Pset,
  wollet: Lwk.Wollet,
  policyAssetId: string,
  requestedInputs: readonly NormalizedProviderPsetSignInput[],
  expectedAnalysis: ProviderPsetAnalysisDTO,
  sign: (pset: Lwk.Pset) => Lwk.Pset,
): ProviderPsetSignResultDTO {
  const result = analyzeProviderPset(pset, wollet, policyAssetId, requestedInputs);
  if (!result.ok) return result;
  if (!providerPsetReviewsMatch(expectedAnalysis, result.analysis)) {
    return { ok: false, reason: "review_changed" };
  }
  try {
    const signed = sign(pset);
    try {
      return { ok: true, pset: signed.toString(), analysis: result.analysis };
    } finally {
      signed.free();
    }
  } catch {
    return { ok: false, reason: "signing_failed" };
  }
}

function failure(
  reason: ProviderPsetAnalysisFailureReason,
  inputIndex?: number,
): ProviderPsetAnalysisResultDTO {
  return inputIndex === undefined ? { ok: false, reason } : { ok: false, reason, inputIndex };
}

function outpointKey(txid: string, vout: number): string {
  return `${txid}:${vout}`;
}

function addAmount(target: Map<string, bigint>, assetId: string, amount: bigint): void {
  target.set(assetId, (target.get(assetId) ?? 0n) + amount);
}

function bigintMap(value: unknown): Map<string, bigint> {
  if (!(value instanceof Map)) return new Map();
  return new Map(
    [...value.entries()].map(([assetId, amount]) => [String(assetId), BigInt(String(amount))]),
  );
}

function mapsEqual(left: Map<string, bigint>, right: Map<string, bigint>): boolean {
  const keys = new Set([...left.keys(), ...right.keys()]);
  for (const key of keys) {
    if ((left.get(key) ?? 0n) !== (right.get(key) ?? 0n)) return false;
  }
  return true;
}

function stringRecord(values: Map<string, bigint>): Record<string, string> {
  return Object.fromEntries(
    [...values.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([assetId, amount]) => [assetId, amount.toString()]),
  );
}
