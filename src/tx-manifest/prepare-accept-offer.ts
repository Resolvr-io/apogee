import { taggedCanonicalJsonHash } from "./bundle";
import {
  compileLendingV3AcceptOfferCovenants,
  type LendingV3AcceptOfferCovenants,
  type LendingV3Instance,
} from "./lending-v3";
import type { AcceptOfferRequirementPlan, TxManifestOutpoint } from "./requirements";
import {
  buildTxManifestPset,
  dryRunTxManifestCovenant,
  finalizeTxManifestCovenant,
  type TxManifestCovenantFinalizeSpec,
  type TxManifestPsetBuildSpec,
} from "./runtime";
import { SIMPLICITY_LENDING_V3_BUNDLE } from "./builtins/simplicity-lending-v3";

export type AcceptOfferResolvedInput = TxManifestOutpoint & {
  txOut: string;
  scriptPubKey: string;
  assetId: string;
  amount: string;
  assetBlindingFactor?: string;
  valueBlindingFactor?: string;
  sequence?: number;
};

export type AcceptOfferDestination = {
  scriptPubKey: string;
  blindingPublicKey?: string;
};

export type AcceptOfferChainWalletSnapshot = {
  genesisHash: string;
  tipHeight: number;
  policyAssetId: string;
  pendingOffer: AcceptOfferResolvedInput;
  lenderNftAuthorization: AcceptOfferResolvedInput;
  principalInput: AcceptOfferResolvedInput;
  feeInput: AcceptOfferResolvedInput;
  lenderNftDestination: AcceptOfferDestination;
  principalChangeDestination?: AcceptOfferDestination;
  feeChangeDestination?: AcceptOfferDestination;
  fee: string;
};

export type PreparedAcceptOfferExecution = {
  pset: string;
  planDigest: `sha256:${string}`;
  requirementsDigest: `sha256:${string}`;
  covenants: LendingV3AcceptOfferCovenants;
  review: {
    principalAssetId: string;
    principalAmount: string;
    collateralAssetId: string;
    collateralAmount: string;
    totalDebt: string;
    feeAssetId: string;
    fee: string;
    principalChange: string;
    feeChange: string;
    walletInputOutpoints: TxManifestOutpoint[];
  };
};

export type FinalAcceptOfferDryRun = {
  transactionHex: string;
  parentTransactions: string[];
  genesisHash: string;
  covenants: LendingV3AcceptOfferCovenants;
};

type AcceptOfferRuntime = {
  compileCovenants(instance: LendingV3Instance): Promise<LendingV3AcceptOfferCovenants>;
  buildPset(spec: TxManifestPsetBuildSpec): Promise<string>;
  finalizeCovenant(spec: TxManifestCovenantFinalizeSpec): Promise<string>;
};

const DEFAULT_RUNTIME: AcceptOfferRuntime = {
  compileCovenants: compileLendingV3AcceptOfferCovenants,
  buildPset: buildTxManifestPset,
  finalizeCovenant: finalizeTxManifestCovenant,
};

/**
 * Prepare and covenant-finalize one AcceptOffer PSET without signing wallet
 * inputs. The caller must obtain this snapshot independently from fresh chain
 * and wallet state; dapp-supplied facts never enter this function directly.
 */
export async function prepareLendingV3AcceptOffer(
  plan: AcceptOfferRequirementPlan,
  snapshot: AcceptOfferChainWalletSnapshot,
  runtime: AcceptOfferRuntime = DEFAULT_RUNTIME,
): Promise<PreparedAcceptOfferExecution> {
  validateSnapshot(plan, snapshot);
  const instance = instanceFromPlan(plan);
  const covenants = await runtime.compileCovenants(instance);
  requireInput(
    snapshot.pendingOffer,
    plan.covenantInputs[0],
    covenants.pendingOffer.script_pub_key,
    "pending offer",
  );
  requireInput(
    snapshot.lenderNftAuthorization,
    plan.covenantInputs[1],
    covenants.lenderNftAuthorization.script_pub_key,
    "lender NFT authorization",
  );

  const principalChange = (
    BigInt(snapshot.principalInput.amount) - BigInt(plan.intent.principalAmount)
  ).toString();
  const feeChange = (BigInt(snapshot.feeInput.amount) - BigInt(snapshot.fee)).toString();
  const outputs: TxManifestPsetBuildSpec["outputs"] = [
    {
      script_pub_key: covenants.activeOffer.script_pub_key,
      asset: plan.intent.collateralAssetId,
      amount: plan.intent.collateralAmount,
    },
    {
      script_pub_key: covenants.principalOutput.script_pub_key,
      asset: plan.intent.principalAssetId,
      amount: plan.intent.principalAmount,
    },
    {
      script_pub_key: script(snapshot.lenderNftDestination, "lenderNftDestination"),
      asset: plan.covenantInputs[1].assetId,
      amount: "1",
    },
  ];
  if (principalChange !== "0") {
    outputs.push(
      changeOutput(
        snapshot.principalChangeDestination,
        plan.intent.principalAssetId,
        principalChange,
        2,
        "principalChangeDestination",
      ),
    );
  }
  if (feeChange !== "0") {
    outputs.push(
      changeOutput(
        snapshot.feeChangeDestination,
        snapshot.policyAssetId,
        feeChange,
        3,
        "feeChangeDestination",
      ),
    );
  }

  const inputs = [
    psetInput(snapshot.pendingOffer),
    psetInput(snapshot.lenderNftAuthorization),
    psetInput(snapshot.principalInput),
    psetInput(snapshot.feeInput),
  ];
  const buildSpec: TxManifestPsetBuildSpec = {
    inputs,
    outputs,
    fee: { asset: snapshot.policyAssetId, amount: snapshot.fee },
  };
  let pset = await runtime.buildPset(buildSpec);
  const debtLeaf = `${"00".repeat(24)}${BigInt(covenants.currentDebt)
    .toString(16)
    .padStart(16, "0")}`;
  pset = await runtime.finalizeCovenant({
    pset,
    source: SIMPLICITY_LENDING_V3_BUNDLE.sources["lending.simf"],
    arguments: covenants.lendingArguments,
    extra_leaf_payloads: ["00".repeat(32), debtLeaf],
    witnesses: { PATH: { type: "simplicityhl", value: "Left(Left(()))" } },
    input_index: 0,
    genesis_hash: snapshot.genesisHash,
    include_debug_symbols: true,
  });
  pset = await runtime.finalizeCovenant({
    pset,
    source: SIMPLICITY_LENDING_V3_BUNDLE.sources["script_auth.simf"],
    arguments: {
      SCRIPT_HASH: { value: `0x${covenants.pendingOffer.script_hash}`, type: "u256" },
    },
    extra_leaf_payloads: [],
    witnesses: { INPUT_SCRIPT_INDEX: { type: "simplicityhl", value: "0" } },
    input_index: 1,
    genesis_hash: snapshot.genesisHash,
    include_debug_symbols: true,
  });

  const authorization = {
    version: "apogee-tx-manifest-plan/v1",
    requestId: plan.requestId,
    chainId: plan.chainId,
    accountIdentifier: plan.accountIdentifier,
    bundleHash: plan.bundleHash,
    action: plan.action,
    requirementsDigest: plan.requirementDigest,
    inputs: inputs.map(({ asset_blinding_factor: _assetBf, value_blinding_factor: _valueBf, ...input }) => input),
    outputs,
    fee: buildSpec.fee,
    covenantCommitments: {
      pendingOffer: covenants.pendingOffer.script_pub_key,
      activeOffer: covenants.activeOffer.script_pub_key,
      principalOutput: covenants.principalOutput.script_pub_key,
      lenderNftAuthorization: covenants.lenderNftAuthorization.script_pub_key,
    },
  };
  return {
    pset,
    planDigest: await taggedCanonicalJsonHash("apogee/tx-manifest-plan/v1", authorization),
    requirementsDigest: plan.requirementDigest,
    covenants,
    review: {
      principalAssetId: plan.intent.principalAssetId,
      principalAmount: plan.intent.principalAmount,
      collateralAssetId: plan.intent.collateralAssetId,
      collateralAmount: plan.intent.collateralAmount,
      totalDebt: plan.intent.totalDebt,
      feeAssetId: snapshot.policyAssetId,
      fee: snapshot.fee,
      principalChange,
      feeChange,
      walletInputOutpoints: [
        outpoint(snapshot.principalInput),
        outpoint(snapshot.feeInput),
      ],
    },
  };
}

/** Execute both covenant inputs against the exact finalized transaction. */
export async function dryRunLendingV3AcceptOfferExecution(
  execution: FinalAcceptOfferDryRun,
): Promise<true> {
  const debtLeaf = `${"00".repeat(24)}${BigInt(execution.covenants.currentDebt)
    .toString(16)
    .padStart(16, "0")}`;
  await dryRunTxManifestCovenant({
    source: SIMPLICITY_LENDING_V3_BUNDLE.sources["lending.simf"],
    arguments: execution.covenants.lendingArguments,
    extra_leaf_payloads: ["00".repeat(32), debtLeaf],
    witnesses: { PATH: { type: "simplicityhl", value: "Left(Left(()))" } },
    transaction_hex: execution.transactionHex,
    parent_transactions: execution.parentTransactions,
    input_index: 0,
    genesis_hash: execution.genesisHash,
    include_debug_symbols: true,
  });
  await dryRunTxManifestCovenant({
    source: SIMPLICITY_LENDING_V3_BUNDLE.sources["script_auth.simf"],
    arguments: {
      SCRIPT_HASH: {
        value: `0x${execution.covenants.pendingOffer.script_hash}`,
        type: "u256",
      },
    },
    extra_leaf_payloads: [],
    witnesses: { INPUT_SCRIPT_INDEX: { type: "simplicityhl", value: "0" } },
    transaction_hex: execution.transactionHex,
    parent_transactions: execution.parentTransactions,
    input_index: 1,
    genesis_hash: execution.genesisHash,
    include_debug_symbols: true,
  });
  return true;
}

function validateSnapshot(
  plan: AcceptOfferRequirementPlan,
  snapshot: AcceptOfferChainWalletSnapshot,
): void {
  asset(snapshot.policyAssetId, "policyAssetId");
  if (!/^[0-9a-f]{64}$/.test(snapshot.genesisHash)) throw new Error("Invalid genesis hash.");
  if (!Number.isInteger(snapshot.tipHeight) || snapshot.tipHeight < 0) throw new Error("Invalid tip height.");
  if (
    plan.constraints.validUntilHeight !== undefined &&
    snapshot.tipHeight > plan.constraints.validUntilHeight
  ) {
    throw new Error("The manifest request expired before transaction preparation.");
  }
  decimal(snapshot.fee, "fee");
  if (
    plan.constraints.maxFee !== undefined &&
    BigInt(snapshot.fee) > BigInt(plan.constraints.maxFee)
  ) {
    throw new Error("The selected network fee exceeds the approved maximum.");
  }
  requireWalletInput(
    snapshot.principalInput,
    plan.intent.principalAssetId,
    plan.intent.principalAmount,
    "principalInput",
  );
  requireWalletInput(snapshot.feeInput, snapshot.policyAssetId, snapshot.fee, "feeInput");
  if (sameOutpoint(snapshot.principalInput, snapshot.feeInput)) {
    throw new Error("The first slice requires distinct principal and fee inputs.");
  }
}

function requireInput(
  actual: AcceptOfferResolvedInput,
  required: AcceptOfferRequirementPlan["covenantInputs"][number],
  expectedScript: string,
  label: string,
): void {
  if (!sameOutpoint(actual, required.outpoint)) throw new Error(`Resolved ${label} outpoint changed.`);
  if (
    actual.assetId !== required.assetId ||
    actual.amount !== required.amount ||
    actual.scriptPubKey !== expectedScript
  ) {
    throw new Error(`Resolved ${label} does not match the trusted covenant commitment.`);
  }
}

function requireWalletInput(
  input: AcceptOfferResolvedInput,
  expectedAsset: string,
  minimumAmount: string,
  path: string,
): void {
  asset(input.assetId, `${path}.assetId`);
  decimal(input.amount, `${path}.amount`);
  if (input.assetId !== expectedAsset || BigInt(input.amount) < BigInt(minimumAmount)) {
    throw new Error(`${path} does not satisfy the required asset and amount.`);
  }
  if (
    (input.assetBlindingFactor === undefined) !==
    (input.valueBlindingFactor === undefined)
  ) {
    throw new Error(`${path} must include both input blinding factors or neither.`);
  }
}

function psetInput(input: AcceptOfferResolvedInput): TxManifestPsetBuildSpec["inputs"][number] {
  return {
    txid: input.txid,
    vout: input.vout,
    tx_out: input.txOut,
    asset: input.assetId,
    amount: input.amount,
    ...(input.assetBlindingFactor
      ? {
          asset_blinding_factor: input.assetBlindingFactor,
          value_blinding_factor: input.valueBlindingFactor,
        }
      : {}),
    ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
  };
}

function changeOutput(
  destination: AcceptOfferDestination | undefined,
  assetId: string,
  amount: string,
  blinderIndex: number,
  path: string,
): TxManifestPsetBuildSpec["outputs"][number] {
  if (!destination) throw new Error(`${path} is required for non-zero change.`);
  return {
    script_pub_key: script(destination, path),
    asset: assetId,
    amount,
    ...(destination.blindingPublicKey
      ? { blinding_public_key: destination.blindingPublicKey, blinder_index: blinderIndex }
      : {}),
  };
}

function instanceFromPlan(plan: AcceptOfferRequirementPlan): LendingV3Instance {
  return plan.instance;
}

function script(destination: AcceptOfferDestination, path: string): string {
  if (!/^(?:[0-9a-f]{2})*$/.test(destination.scriptPubKey) || destination.scriptPubKey.length === 0) {
    throw new Error(`${path}.scriptPubKey is invalid.`);
  }
  return destination.scriptPubKey;
}

function asset(value: string, path: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${path} is not an asset id.`);
}

function decimal(value: string, path: string): void {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${path} is not a decimal amount.`);
}

function sameOutpoint(a: TxManifestOutpoint, b: TxManifestOutpoint): boolean {
  return a.txid === b.txid && a.vout === b.vout;
}

function outpoint(input: AcceptOfferResolvedInput): TxManifestOutpoint {
  return { txid: input.txid, vout: input.vout };
}
