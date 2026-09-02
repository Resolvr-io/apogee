import type {
  GenericTxManifestInputReviewDTO,
  GenericTxManifestOutputReviewDTO,
  TxManifestApprovalReviewDTO,
  TxManifestAssetMeta,
} from "@/engine/protocol";
import {
  declarativeSigningMode,
  type DeclarativeRequirementPlan,
} from "./declarative-plan";
import type {
  DeclarativeReviewedInput,
  DeclarativeReviewedOutput,
  PreparedDeclarativeExecution,
} from "./declarative-prepare";

export type GenericTxManifestApprovalReviewDTO = Extract<
  TxManifestApprovalReviewDTO,
  { kind: "generic" }
>;

/**
 * Convert a fully prepared declarative transaction into the only review shape
 * the generic UI accepts. Transaction-derived fields are copied exactly. The
 * manifest publisher's prose remains separately labelled presentation data.
 */
export function buildDeclarativeApprovalReview(
  plan: DeclarativeRequirementPlan,
  prepared: PreparedDeclarativeExecution,
  assets: Record<string, TxManifestAssetMeta>,
): GenericTxManifestApprovalReviewDTO {
  const { review } = prepared;
  const signingMode = declarativeSigningMode(plan);
  if (review.signingMode !== signingMode) {
    throw new Error("The declarative transaction signing mode changed before review.");
  }
  if (plan.publisher.action !== plan.action) {
    throw new Error("The publisher action label does not match the requested action.");
  }

  const inputs = authoritativeInputs(plan, review.inputs);
  const outputs = authoritativeOutputs(
    review.outputs,
    review.feeOutputIndex,
    review.feeAssetId,
    review.fee,
  );
  assertU32(review.locktime, "review locktime");
  const rbf = inputs.some((input) => input.sequence < 0xffff_fffe);
  if (review.rbf !== rbf) {
    throw new Error("The declarative transaction RBF summary does not match its input sequences.");
  }
  assertSignedBalanceChanges(review.walletBalanceChanges);

  return {
    kind: "generic",
    reviewVersion: "apogee-generic-transaction-review/v1",
    unverified: true,
    protocolLabel: plan.publisher.protocol,
    actionLabel: plan.publisher.action,
    ...(plan.publisher.description === undefined
      ? {}
      : { publisherDescription: plan.publisher.description }),
    requestId: plan.requestId,
    accountIdentifier: plan.accountIdentifier,
    bundleHash: plan.bundleHash,
    action: plan.action,
    feeAssetId: review.feeAssetId,
    fee: review.fee,
    feeChange: review.feeChange,
    assets,
    inputs,
    outputs,
    feeOutputIndex: review.feeOutputIndex,
    locktime: review.locktime,
    rbf,
    signingMode,
    walletBalanceChanges: { ...review.walletBalanceChanges },
  };
}

function authoritativeInputs(
  plan: DeclarativeRequirementPlan,
  reviewed: readonly DeclarativeReviewedInput[],
): GenericTxManifestInputReviewDTO[] {
  if (reviewed.length !== plan.recipe.inputs.length) {
    throw new Error("The declarative input review is incomplete.");
  }
  return reviewed.map((input, index) => {
    const role = plan.recipe.inputs[index];
    if (input.index !== index || input.roleId !== role.id) {
      throw new Error("The declarative input review order does not match its recipe.");
    }
    const expectedSource = role.kind === "provided" ? "provided" : "wallet";
    const expectedAuthorization = role.kind === "provided" ? role.authorization : "wallet";
    if (input.source !== expectedSource || input.authorization !== expectedAuthorization) {
      throw new Error("The declarative input review role does not match its recipe.");
    }
    assertHex(input.txid, 32, `input ${index} txid`);
    assertU32(input.vout, `input ${index} vout`);
    assertAssetAmountScript(input, `input ${index}`);
    assertU32(input.sequence, `input ${index} sequence`);
    if (input.confirmed !== null && typeof input.confirmed !== "boolean") {
      throw new Error(`Input ${index} confirmation status is invalid.`);
    }
    return {
      ...input,
      walletOwned: input.authorization === "wallet",
    };
  });
}

function authoritativeOutputs(
  reviewed: readonly DeclarativeReviewedOutput[],
  feeOutputIndex: number,
  feeAssetId: string,
  fee: string,
): GenericTxManifestOutputReviewDTO[] {
  const finalOutputCount = reviewed.length + 1;
  assertIndex(feeOutputIndex, finalOutputCount, "fee output index");
  assertHex(feeAssetId, 32, "fee asset id");
  assertCanonicalAmount(fee, "fee");
  if (BigInt(fee) <= 0n) throw new Error("The declarative fee must be positive.");

  const outputs = new Array<GenericTxManifestOutputReviewDTO | undefined>(finalOutputCount);
  outputs[feeOutputIndex] = {
    index: feeOutputIndex,
    role: "fee",
    assetId: feeAssetId,
    amount: fee,
    scriptPubKey: "",
    confidential: false,
    walletOwned: false,
  };
  for (const output of reviewed) {
    assertIndex(output.index, finalOutputCount, "output index");
    if (output.index === feeOutputIndex || outputs[output.index] !== undefined) {
      throw new Error("The declarative output review has a duplicate or occupied index.");
    }
    assertAssetAmountScript(output, `output ${output.index}`);
    outputs[output.index] = { ...output };
  }
  return Array.from({ length: finalOutputCount }, (_, index) => {
    const output = outputs[index];
    if (output === undefined) throw new Error("The declarative output review is incomplete.");
    return output;
  });
}

function assertAssetAmountScript(
  value: { assetId: string; amount: string; scriptPubKey: string; confidential: boolean },
  label: string,
): void {
  assertHex(value.assetId, 32, `${label} asset id`);
  assertCanonicalAmount(value.amount, `${label} amount`);
  if (!/^(?:[0-9a-f]{2})*$/.test(value.scriptPubKey)) {
    throw new Error(`The ${label} script is not canonical hex.`);
  }
  if (typeof value.confidential !== "boolean") {
    throw new Error(`The ${label} confidentiality flag is invalid.`);
  }
}

function assertSignedBalanceChanges(changes: Readonly<Record<string, string>>): void {
  for (const [assetId, amount] of Object.entries(changes)) {
    assertHex(assetId, 32, "wallet balance asset id");
    if (!/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(amount)) {
      throw new Error("A declarative wallet balance change is not a canonical integer.");
    }
  }
}

function assertCanonicalAmount(value: string, label: string): void {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`The ${label} is not a canonical amount.`);
  }
}

function assertHex(value: string, bytes: number, label: string): void {
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) {
    throw new Error(`The ${label} is not canonical hex.`);
  }
}

function assertU32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`The ${label} does not fit u32.`);
  }
}

function assertIndex(value: number, count: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= count) {
    throw new Error(`The ${label} is outside the final transaction.`);
  }
}
