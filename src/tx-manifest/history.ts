import {
  SIMPLICITY_LENDING_V3_ACCEPT_OFFER,
  SIMPLICITY_LENDING_V3_CANCEL_OFFER,
  SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT,
  SIMPLICITY_LENDING_V3_CLAIM_PRINCIPAL,
  SIMPLICITY_LENDING_V3_CREATE_FACTORY,
  SIMPLICITY_LENDING_V3_CREATE_OFFER,
  SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER,
  SIMPLICITY_LENDING_V3_REPAY_LOAN,
} from "./builtins/simplicity-lending-v3";
import {
  SIMPLICITY_ROULETTE_V1_CANCEL,
  SIMPLICITY_ROULETTE_V1_CLAIM_PAYOUT,
  SIMPLICITY_ROULETTE_V1_FORFEIT,
  SIMPLICITY_ROULETTE_V1_OPEN,
  SIMPLICITY_ROULETTE_V1_SETTLE,
  SIMPLICITY_ROULETTE_V1_TAKE,
} from "./builtins/simplicity-roulette-v1";
import {
  TX_MANIFEST_ACTION_HINT_V1,
  txManifestActionHintMatches,
  txManifestActionHintScript,
  txManifestActionHintsFromScript,
  type TxManifestActionHint,
} from "./action-hint";
import { TRUSTED_TX_MANIFESTS, type TrustedTxManifest } from "./registry";
import {
  inspectElementsTransaction,
  type ElementsTransactionOutput,
  type ElementsTransactionShape,
} from "@/engine/elements-txout";
import { MAX_MANIFEST_WALLET_INPUTS_PER_ASSET } from "./coin-selection-policy";
import { decodeRouletteTransactionMetadata } from "./roulette-metadata";

export type TxManifestHistoryAnnotation =
  | {
      status: "verified";
      bundleHash: `sha256:${string}`;
      protocol: string;
      version: string;
      protocolLabel: string;
      action: string;
      actionLabel: string;
    }
  | {
      status: "unsupported";
      bundleHash: `sha256:${string}`;
    }
  | {
      status: "unverified";
      bundleHash?: `sha256:${string}`;
      reason: "ambiguous" | "disabled" | "unknown-action" | "not-wallet-authenticated" | "shape-mismatch";
    };

type LocatedHint = {
  hint: TxManifestActionHint;
  output: ElementsTransactionOutput;
  outputIndex: number;
  scriptHex: string;
};

/**
 * Recover one wallet-authenticated TX Manifest action from on-chain data.
 * A marker alone is never trusted: the exact bundle/action must be approved,
 * the transaction must spend a wallet-owned input, and the registered action's
 * structural postconditions must match.
 */
export async function txManifestHistoryAnnotation(
  transaction: Uint8Array,
  hasWalletOwnedInput: boolean,
): Promise<TxManifestHistoryAnnotation | undefined> {
  let shape: ElementsTransactionShape;
  try {
    shape = inspectElementsTransaction(transaction);
  } catch {
    return undefined;
  }
  const located = locateHints(shape);
  if (located.length === 0) return undefined;
  if (located.length !== 1) {
    return {
      status: "unverified",
      ...(located[0] ? { bundleHash: located[0].hint.bundleHash } : {}),
      reason: "ambiguous",
    };
  }

  const marker = located[0]!;
  const trusted = TRUSTED_TX_MANIFESTS.find(
    (candidate) => candidate.bundleHash === marker.hint.bundleHash,
  );
  if (!trusted) return { status: "unsupported", bundleHash: marker.hint.bundleHash };
  if (trusted.history.actionHint?.codec !== TX_MANIFEST_ACTION_HINT_V1) {
    return { status: "unverified", bundleHash: marker.hint.bundleHash, reason: "disabled" };
  }

  const actions: string[] = [];
  for (const action of trusted.actions) {
    if (await txManifestActionHintMatches(marker.hint, action)) actions.push(action);
  }
  if (actions.length !== 1) {
    return { status: "unverified", bundleHash: marker.hint.bundleHash, reason: "unknown-action" };
  }
  const action = actions[0]!;
  if (!hasWalletOwnedInput) {
    return {
      status: "unverified",
      bundleHash: marker.hint.bundleHash,
      reason: "not-wallet-authenticated",
    };
  }
  if (!(await markerAndActionShapeMatch(trusted, action, marker, shape))) {
    return { status: "unverified", bundleHash: marker.hint.bundleHash, reason: "shape-mismatch" };
  }
  return {
    status: "verified",
    bundleHash: trusted.bundleHash,
    protocol: trusted.protocol,
    version: trusted.version,
    protocolLabel: trusted.review.protocolLabel,
    action,
    actionLabel: trusted.review.actionLabels[action] ?? action,
  };
}

function locateHints(shape: ElementsTransactionShape): LocatedHint[] {
  return shape.outputs.flatMap((output, outputIndex) => {
    const scriptHex = hex(output.scriptPubKey);
    return txManifestActionHintsFromScript(scriptHex).map((hint) => ({
      hint,
      output,
      outputIndex,
      scriptHex,
    }));
  });
}

async function markerAndActionShapeMatch(
  trusted: TrustedTxManifest,
  action: string,
  marker: LocatedHint,
  shape: ElementsTransactionShape,
): Promise<boolean> {
  if (
    marker.scriptHex !== await txManifestActionHintScript(trusted.bundleHash, action) ||
    marker.outputIndex !== shape.outputs.length - 2 ||
    !marker.output.explicitAsset ||
    marker.output.explicitValue !== 0n ||
    !marker.output.nullNonce ||
    hex(shape.outputs.at(-1)?.scriptPubKey ?? new Uint8Array()) !== ""
  ) {
    return false;
  }
  if (trusted.history.actionHint?.postconditionVerifier === "simplicity-lending-v3") {
    return lendingActionShapeMatches(action, shape);
  }
  if (trusted.history.actionHint?.postconditionVerifier === "simplicity-roulette-v1") {
    return rouletteActionShapeMatches(trusted, action, marker, shape);
  }
  return false;
}

async function rouletteActionShapeMatches(
  trusted: TrustedTxManifest,
  action: string,
  marker: LocatedHint,
  shape: ElementsTransactionShape,
): Promise<boolean> {
  const scripts = shape.outputs.map((output) => hex(output.scriptPubKey));
  let located;
  try {
    located = await decodeRouletteTransactionMetadata(scripts, trusted.bundleHash);
  } catch {
    return false;
  }
  if (!located || located.txManifestVout !== marker.outputIndex) return false;
  for (let index = located.chunkStartVout; index <= located.txManifestVout; index += 1) {
    const output = shape.outputs[index]!;
    if (!output.explicitAsset || output.explicitValue !== 0n || !output.nullNonce) return false;
  }
  if (scripts.slice(0, located.chunkStartVout).some((script) => !script || script.startsWith("6a"))) {
    return false;
  }
  const inputCountBetween = (minimum: number, fixedPrefix: number, walletAssetPools: number) =>
    shape.inputCount >= minimum &&
    shape.inputCount <= fixedPrefix + walletAssetPools * MAX_MANIFEST_WALLET_INPUTS_PER_ASSET;
  const metadata = located.metadata;
  if (action === SIMPLICITY_ROULETTE_V1_OPEN) {
    return metadata.action === "open" && metadata.covenantVout === 0 &&
      located.chunkStartVout >= 1 && inputCountBetween(1, 0, 2);
  }
  if (action === SIMPLICITY_ROULETTE_V1_TAKE) {
    return metadata.action === "take" && metadata.covenantVout === 0 &&
      located.chunkStartVout >= 1 && inputCountBetween(2, 1, 2);
  }
  if (action === SIMPLICITY_ROULETTE_V1_SETTLE) {
    return metadata.action === "settle" && located.chunkStartVout >= 1 &&
      inputCountBetween(2, 1, 1);
  }
  if (action === SIMPLICITY_ROULETTE_V1_CANCEL) {
    return metadata.action === "cancel" && located.chunkStartVout >= 1 &&
      inputCountBetween(2, 1, 1);
  }
  if (action === SIMPLICITY_ROULETTE_V1_FORFEIT) {
    return metadata.action === "forfeit" && located.chunkStartVout >= 1 &&
      inputCountBetween(2, 1, 1);
  }
  if (action === SIMPLICITY_ROULETTE_V1_CLAIM_PAYOUT) {
    return metadata.action === "claimPayout" && located.chunkStartVout >= 1 &&
      inputCountBetween(2, 1, 1);
  }
  return false;
}

function lendingActionShapeMatches(action: string, shape: ElementsTransactionShape): boolean {
  const scripts = shape.outputs.map((output) => hex(output.scriptPubKey));
  const nonData = (index: number) => Boolean(scripts[index]) && !scripts[index]!.startsWith("6a");
  const burn = (index: number) => scripts[index] === "6a046275726e";
  const inputCountBetween = (minimum: number, fixedPrefix: number, walletAssetPools: number) =>
    shape.inputCount >= minimum &&
    shape.inputCount <= fixedPrefix + walletAssetPools * MAX_MANIFEST_WALLET_INPUTS_PER_ASSET;

  if (action === SIMPLICITY_LENDING_V3_CREATE_FACTORY) {
    return (
      inputCountBetween(1, 0, 1) &&
      scripts.length >= 5 &&
      nonData(0) &&
      nonData(1) &&
      scripts[2] === `6a0ddd1e7f8902${"00".repeat(8)}`
    );
  }
  if (action === SIMPLICITY_LENDING_V3_CREATE_OFFER) {
    return (
      inputCountBetween(3, 2, 2) &&
      scripts.length >= 8 &&
      [0, 1, 2, 3, 5].every(nonData) &&
      /^6a32a9b4ade7[0-9a-f]{92}$/.test(scripts[4] ?? "")
    );
  }
  if (action === SIMPLICITY_LENDING_V3_ACCEPT_OFFER) {
    return inputCountBetween(3, 2, 2) && scripts.length >= 5 && [0, 1, 2].every(nonData);
  }
  if (action === SIMPLICITY_LENDING_V3_CLAIM_PRINCIPAL) {
    return inputCountBetween(3, 2, 1) && scripts.length >= 4 && [0, 1].every(nonData);
  }
  if (action === SIMPLICITY_LENDING_V3_CANCEL_OFFER) {
    return inputCountBetween(4, 3, 1) && scripts.length >= 5 && burn(0) && burn(1) && nonData(2);
  }
  if (action === SIMPLICITY_LENDING_V3_REPAY_LOAN) {
    return (
      inputCountBetween(3, 2, 2) &&
      scripts.length >= 6 &&
      burn(0) &&
      [1, 2, 3].every(nonData)
    );
  }
  if (action === SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER) {
    return inputCountBetween(3, 2, 1) && scripts.length >= 4 && burn(0) && nonData(1);
  }
  if (action === SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT) {
    return inputCountBetween(3, 2, 1) && scripts.length >= 4 && burn(0) && nonData(1);
  }
  return false;
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
