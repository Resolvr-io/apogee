import { SIMPLICITY_LENDING_V3_BUNDLE } from "./builtins/simplicity-lending-v3";
import { taggedCanonicalJsonHash } from "./bundle";
import { trustedTxManifestActionHintScript } from "./registry";
import {
  compileLendingV3FinalizedLenderVault,
  type CovenantNetwork,
  type LendingV3FinalizedLenderVault,
} from "./lending-v3";
import type { AcceptOfferDestination, AcceptOfferResolvedInput } from "./prepare-accept-offer";
import type { ClaimLenderVaultRequirementPlan, TxManifestOutpoint } from "./requirements";
import {
  buildTxManifestPset,
  dryRunTxManifestCovenant,
  finalizeTxManifestCovenant,
  type TxManifestCovenantFinalizeSpec,
  type TxManifestPsetBuildSpec,
} from "./runtime";

const LENDER_NFT_BURN_SCRIPT = "6a046275726e";

export type ClaimLenderVaultChainWalletSnapshot = {
  network?: CovenantNetwork;
  genesisHash: string;
  tipHeight: number;
  policyAssetId: string;
  lenderVault: AcceptOfferResolvedInput;
  lenderNftInput: AcceptOfferResolvedInput;
  feeInput: AcceptOfferResolvedInput;
  principalDestination: AcceptOfferDestination;
  feeChangeDestination?: AcceptOfferDestination;
  fee: string;
};

export type PreparedClaimLenderVaultExecution = {
  pset: string;
  planDigest: `sha256:${string}`;
  requirementsDigest: `sha256:${string}`;
  vault: LendingV3FinalizedLenderVault;
  review: {
    principalAssetId: string;
    principalAmount: string;
    grossDebt: string;
    interestAmount: string;
    protocolFeeAmount: string;
    lenderNftAssetId: string;
    feeAssetId: string;
    fee: string;
    feeChange: string;
    walletInputOutpoints: TxManifestOutpoint[];
  };
};

export type FinalClaimLenderVaultDryRun = {
  transactionHex: string;
  parentTransactions: string[];
  genesisHash: string;
  vault: LendingV3FinalizedLenderVault;
};

type ClaimLenderVaultRuntime = {
  compileVault: typeof compileLendingV3FinalizedLenderVault;
  buildPset(spec: TxManifestPsetBuildSpec): Promise<string>;
  finalizeCovenant(spec: TxManifestCovenantFinalizeSpec): Promise<string>;
};

const DEFAULT_RUNTIME: ClaimLenderVaultRuntime = {
  compileVault: compileLendingV3FinalizedLenderVault,
  buildPset: buildTxManifestPset,
  finalizeCovenant: finalizeTxManifestCovenant,
};

/** Build and covenant-finalize one lender-vault claim without signing wallet inputs. */
export async function prepareLendingV3ClaimLenderVault(
  plan: ClaimLenderVaultRequirementPlan,
  snapshot: ClaimLenderVaultChainWalletSnapshot,
  runtime: ClaimLenderVaultRuntime = DEFAULT_RUNTIME,
): Promise<PreparedClaimLenderVaultExecution> {
  validateSnapshot(plan, snapshot);
  const vault = await runtime.compileVault(plan.instance, undefined, snapshot.network);
  requireCovenantInput(snapshot.lenderVault, plan.covenantInputs[0], vault.covenant.script_pub_key);

  const feeChange = (BigInt(snapshot.feeInput.amount) - BigInt(snapshot.fee)).toString();
  const inputs = [
    psetInput(snapshot.lenderVault),
    psetInput(snapshot.lenderNftInput),
    psetInput(snapshot.feeInput),
  ];
  const outputs: TxManifestPsetBuildSpec["outputs"] = [
    {
      script_pub_key: LENDER_NFT_BURN_SCRIPT,
      asset: plan.intent.lenderNftAssetId,
      amount: "1",
    },
    {
      script_pub_key: script(snapshot.principalDestination, "principalDestination"),
      asset: plan.intent.principalAssetId,
      amount: plan.intent.principalAmount,
      blinding_public_key: blindingKey(snapshot.principalDestination, "principalDestination"),
      blinder_index: 0,
    },
  ];
  if (feeChange !== "0") {
    outputs.push({
      script_pub_key: script(snapshot.feeChangeDestination, "feeChangeDestination"),
      asset: snapshot.policyAssetId,
      amount: feeChange,
      blinding_public_key: blindingKey(snapshot.feeChangeDestination, "feeChangeDestination"),
      blinder_index: 2,
    });
  }
  outputs.push({
    script_pub_key: await trustedTxManifestActionHintScript(plan.bundleHash, plan.action),
    asset: snapshot.policyAssetId,
    amount: "0",
  });

  const buildSpec: TxManifestPsetBuildSpec = {
    inputs,
    outputs,
    fee: { asset: snapshot.policyAssetId, amount: snapshot.fee },
  };
  let pset = await runtime.buildPset(buildSpec);
  pset = await runtime.finalizeCovenant({
    pset,
    source: SIMPLICITY_LENDING_V3_BUNDLE.sources["asset_auth_vault.simf"],
    arguments: vault.arguments,
    extra_leaf_payloads: [],
    witnesses: {
      PATH: { type: "simplicityhl", value: "Left(Left((1, 0)))" },
    },
    input_index: 0,
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
    covenantCommitments: { lenderVault: vault.covenant.script_pub_key },
  };
  return {
    pset,
    planDigest: await taggedCanonicalJsonHash("apogee/tx-manifest-plan/v1", authorization),
    requirementsDigest: plan.requirementDigest,
    vault,
    review: {
      principalAssetId: plan.intent.principalAssetId,
      principalAmount: plan.intent.principalAmount,
      grossDebt: plan.intent.grossDebt,
      interestAmount: plan.intent.interestAmount,
      protocolFeeAmount: plan.intent.protocolFeeAmount,
      lenderNftAssetId: plan.intent.lenderNftAssetId,
      feeAssetId: snapshot.policyAssetId,
      fee: snapshot.fee,
      feeChange,
      walletInputOutpoints: [outpoint(snapshot.lenderNftInput), outpoint(snapshot.feeInput)],
    },
  };
}

export async function dryRunLendingV3ClaimLenderVaultExecution(
  execution: FinalClaimLenderVaultDryRun,
): Promise<true> {
  await dryRunTxManifestCovenant({
    source: SIMPLICITY_LENDING_V3_BUNDLE.sources["asset_auth_vault.simf"],
    arguments: execution.vault.arguments,
    extra_leaf_payloads: [],
    witnesses: { PATH: { type: "simplicityhl", value: "Left(Left((1, 0)))" } },
    transaction_hex: execution.transactionHex,
    parent_transactions: execution.parentTransactions,
    input_index: 0,
    genesis_hash: execution.genesisHash,
    include_debug_symbols: true,
  });
  return true;
}

function validateSnapshot(
  plan: ClaimLenderVaultRequirementPlan,
  snapshot: ClaimLenderVaultChainWalletSnapshot,
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
    snapshot.lenderNftInput,
    plan.walletInputs[0].outpoint,
    plan.intent.lenderNftAssetId,
    "1",
    "lenderNftInput",
  );
  requireWalletInput(
    snapshot.feeInput,
    undefined,
    snapshot.policyAssetId,
    snapshot.fee,
    "feeInput",
  );
  if (
    sameOutpoint(snapshot.lenderVault, snapshot.lenderNftInput) ||
    sameOutpoint(snapshot.lenderVault, snapshot.feeInput) ||
    sameOutpoint(snapshot.lenderNftInput, snapshot.feeInput)
  ) {
    throw new Error("The lender vault, lender NFT, and fee inputs must be distinct.");
  }
}

function requireCovenantInput(
  actual: AcceptOfferResolvedInput,
  required: ClaimLenderVaultRequirementPlan["covenantInputs"][0],
  expectedScript: string,
): void {
  if (!sameOutpoint(actual, required.outpoint)) throw new Error("Resolved lender vault outpoint changed.");
  if (
    actual.assetId !== required.assetId ||
    actual.amount !== required.amount ||
    actual.scriptPubKey !== expectedScript
  ) {
    throw new Error("Resolved lender vault does not match the trusted covenant commitment.");
  }
}

function requireWalletInput(
  input: AcceptOfferResolvedInput,
  expectedOutpoint: TxManifestOutpoint | undefined,
  expectedAsset: string,
  minimumAmount: string,
  path: string,
): void {
  asset(input.assetId, `${path}.assetId`);
  decimal(input.amount, `${path}.amount`);
  if (expectedOutpoint && !sameOutpoint(input, expectedOutpoint)) {
    throw new Error(`${path} does not match the requested wallet outpoint.`);
  }
  if (input.assetId !== expectedAsset || BigInt(input.amount) < BigInt(minimumAmount)) {
    throw new Error(`${path} does not satisfy the required asset and amount.`);
  }
  if ((input.assetBlindingFactor === undefined) !== (input.valueBlindingFactor === undefined)) {
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

function script(destination: AcceptOfferDestination | undefined, path: string): string {
  if (!destination || !/^(?:[0-9a-f]{2})+$/.test(destination.scriptPubKey)) {
    throw new Error(`${path}.scriptPubKey is invalid.`);
  }
  return destination.scriptPubKey;
}

function blindingKey(destination: AcceptOfferDestination | undefined, path: string): string {
  if (!destination?.blindingPublicKey) throw new Error(`${path}.blindingPublicKey is required.`);
  return destination.blindingPublicKey;
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
