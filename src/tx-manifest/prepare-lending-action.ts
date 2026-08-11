import { SIMPLICITY_LENDING_V3_BUNDLE } from "./builtins/simplicity-lending-v3";
import { taggedCanonicalJsonHash } from "./bundle";
import { trustedTxManifestActionHintScript } from "./registry";
import {
  compileLendingV3AcceptOfferCovenants,
  type CovenantNetwork,
  type LendingV3AcceptOfferCovenants,
} from "./lending-v3";
import type {
  CancelOfferRequirementPlan,
  ClaimPrincipalRequirementPlan,
  LiquidateOfferRequirementPlan,
  RepayLoanRequirementPlan,
  TxManifestOutpoint,
} from "./requirements";
import {
  buildTxManifestPset,
  finalizeTxManifestCovenant,
  type TxManifestCovenantFinalizeSpec,
  type TxManifestPsetBuildSpec,
} from "./runtime";
import type { AcceptOfferDestination, AcceptOfferResolvedInput } from "./prepare-accept-offer";

const BURN_SCRIPT = "6a046275726e";
const ACTIVE_SEQUENCE = 0xffff_fffe;
const PENDING_OFFER_STATE_LEAF = "00".repeat(32);
const ACTIVE_OFFER_STATE_LEAF = `${"00".repeat(31)}01`;

export type BorrowerLendingRequirementPlan =
  | ClaimPrincipalRequirementPlan
  | CancelOfferRequirementPlan
  | RepayLoanRequirementPlan
  | LiquidateOfferRequirementPlan;

export type PreparedCovenantExecution = Omit<TxManifestCovenantFinalizeSpec, "pset">;

type SnapshotBase = {
  network?: CovenantNetwork;
  genesisHash: string;
  tipHeight: number;
  policyAssetId: string;
  feeInput: AcceptOfferResolvedInput;
  walletDestination: AcceptOfferDestination;
  explicitWalletDestination: AcceptOfferDestination;
  feeChangeDestination?: AcceptOfferDestination;
  fee: string;
};

export type ClaimPrincipalChainWalletSnapshot = SnapshotBase & {
  kind: "claimPrincipal";
  principalAssetAuth: AcceptOfferResolvedInput;
  borrowerNftInput: AcceptOfferResolvedInput;
};

export type CancelOfferChainWalletSnapshot = SnapshotBase & {
  kind: "cancelOffer";
  pendingOffer: AcceptOfferResolvedInput;
  lenderNftAuthorization: AcceptOfferResolvedInput;
  borrowerNftInput: AcceptOfferResolvedInput;
};

export type RepayLoanChainWalletSnapshot = SnapshotBase & {
  kind: "repayLoan";
  activeOffer: AcceptOfferResolvedInput;
  borrowerNftInput: AcceptOfferResolvedInput;
  repaymentInput: AcceptOfferResolvedInput;
  principalChangeDestination?: AcceptOfferDestination;
};

export type LiquidateOfferChainWalletSnapshot = SnapshotBase & {
  kind: "liquidateOffer";
  activeOffer: AcceptOfferResolvedInput;
  lenderNftInput: AcceptOfferResolvedInput;
};

export type BorrowerLendingChainWalletSnapshot =
  | ClaimPrincipalChainWalletSnapshot
  | CancelOfferChainWalletSnapshot
  | RepayLoanChainWalletSnapshot
  | LiquidateOfferChainWalletSnapshot;

export type PreparedBorrowerLendingExecution = {
  kind: BorrowerLendingChainWalletSnapshot["kind"];
  pset: string;
  planDigest: `sha256:${string}`;
  requirementsDigest: `sha256:${string}`;
  covenants: LendingV3AcceptOfferCovenants;
  covenantExecutions: PreparedCovenantExecution[];
  review: {
    principalAssetId: string;
    principalAmount: string;
    collateralAssetId: string;
    collateralAmount: string;
    borrowerNftAssetId: string;
    lenderNftAssetId: string;
    totalDebt?: string;
    interestAmount?: string;
    protocolFeeAmount?: string;
    lenderVaultAmount?: string;
    expirationHeight: number;
    feeAssetId: string;
    fee: string;
    principalChange: string;
    feeChange: string;
    walletInputOutpoints: TxManifestOutpoint[];
  };
};

type ActionRuntime = {
  compileCovenants: typeof compileLendingV3AcceptOfferCovenants;
  buildPset(spec: TxManifestPsetBuildSpec): Promise<string>;
  finalizeCovenant(spec: TxManifestCovenantFinalizeSpec): Promise<string>;
};

const DEFAULT_RUNTIME: ActionRuntime = {
  compileCovenants: compileLendingV3AcceptOfferCovenants,
  buildPset: buildTxManifestPset,
  finalizeCovenant: finalizeTxManifestCovenant,
};

export async function prepareLendingV3BorrowerAction(
  plan: BorrowerLendingRequirementPlan,
  snapshot: BorrowerLendingChainWalletSnapshot,
  runtime: ActionRuntime = DEFAULT_RUNTIME,
): Promise<PreparedBorrowerLendingExecution> {
  validateCommon(plan, snapshot);
  const covenants = await runtime.compileCovenants(plan.instance, undefined, snapshot.network);
  const prepared = prepareAction(plan, snapshot, covenants);
  prepared.buildSpec.outputs.push({
    script_pub_key: await trustedTxManifestActionHintScript(plan.bundleHash, plan.action),
    asset: snapshot.policyAssetId,
    amount: "0",
  });
  let pset = await runtime.buildPset(prepared.buildSpec);
  for (const covenant of prepared.covenantExecutions) {
    pset = await runtime.finalizeCovenant({ pset, ...covenant });
  }
  const authorization = {
    version: "apogee-tx-manifest-plan/v1",
    requestId: plan.requestId,
    chainId: plan.chainId,
    accountIdentifier: plan.accountIdentifier,
    bundleHash: plan.bundleHash,
    action: plan.action,
    requirementsDigest: plan.requirementDigest,
    inputs: prepared.buildSpec.inputs.map(stripSecrets),
    outputs: prepared.buildSpec.outputs,
    fee: prepared.buildSpec.fee,
    ...(prepared.buildSpec.locktime === undefined
      ? {}
      : { locktime: prepared.buildSpec.locktime }),
    covenantCommitments: prepared.covenantCommitments,
  };
  return {
    kind: snapshot.kind,
    pset,
    planDigest: await taggedCanonicalJsonHash("apogee/tx-manifest-plan/v1", authorization),
    requirementsDigest: plan.requirementDigest,
    covenants,
    covenantExecutions: prepared.covenantExecutions,
    review: {
      principalAssetId: plan.intent.principalAssetId,
      principalAmount: plan.intent.principalAmount,
      collateralAssetId: plan.intent.collateralAssetId,
      collateralAmount: plan.intent.collateralAmount,
      borrowerNftAssetId: plan.intent.borrowerNftAssetId,
      lenderNftAssetId: plan.intent.lenderNftAssetId,
      ...(plan.action === "lending_contract.RepayLoan"
        ? {
            totalDebt: plan.intent.totalDebt,
            interestAmount: plan.intent.interestAmount,
            protocolFeeAmount: plan.intent.protocolFeeAmount,
            lenderVaultAmount: plan.intent.lenderVaultAmount,
          }
        : plan.action === "lending_contract.LiquidateOffer"
          ? { totalDebt: plan.intent.totalDebt }
          : {}),
      expirationHeight: plan.intent.expirationHeight,
      feeAssetId: snapshot.policyAssetId,
      fee: snapshot.fee,
      principalChange: prepared.principalChange,
      feeChange: prepared.feeChange,
      walletInputOutpoints: prepared.walletInputs.map(outpoint),
    },
  };
}

function prepareAction(
  plan: BorrowerLendingRequirementPlan,
  snapshot: BorrowerLendingChainWalletSnapshot,
  covenants: LendingV3AcceptOfferCovenants,
): {
  buildSpec: TxManifestPsetBuildSpec;
  covenantExecutions: PreparedCovenantExecution[];
  covenantCommitments: Record<string, string>;
  walletInputs: AcceptOfferResolvedInput[];
  principalChange: string;
  feeChange: string;
} {
  if (plan.action === "lending_contract.ClaimPrincipal" && snapshot.kind === "claimPrincipal") {
    requireChainInput(snapshot.principalAssetAuth, plan.covenantInputs[0].outpoint, plan.intent.principalAssetId, plan.intent.principalAmount, covenants.principalOutput.script_pub_key, "principal covenant");
    requireWalletInput(snapshot.borrowerNftInput, plan.walletInputs[0].outpoint, plan.intent.borrowerNftAssetId, "1", "borrower NFT");
    distinct([snapshot.principalAssetAuth, snapshot.borrowerNftInput, snapshot.feeInput]);
    const inputs = [snapshot.principalAssetAuth, snapshot.borrowerNftInput, snapshot.feeInput];
    const outputs: TxManifestPsetBuildSpec["outputs"] = [
      output(snapshot.explicitWalletDestination, plan.intent.borrowerNftAssetId, "1"),
      confidentialOutput(snapshot.walletDestination, plan.intent.principalAssetId, plan.intent.principalAmount, 0),
    ];
    const feeChange = addFeeChange(outputs, snapshot, 2);
    return {
      buildSpec: buildSpec(inputs, outputs, snapshot),
      covenantExecutions: [{
        source: SIMPLICITY_LENDING_V3_BUNDLE.sources["asset_auth.simf"],
        arguments: covenants.principalArguments,
        extra_leaf_payloads: [],
        witnesses: {
          INPUT_ASSET_INDEX: { type: "simplicityhl", value: "1" },
          OUTPUT_ASSET_INDEX: { type: "simplicityhl", value: "0" },
        },
        input_index: 0,
        genesis_hash: snapshot.genesisHash,
        include_debug_symbols: true,
      }],
      covenantCommitments: { principalAssetAuth: covenants.principalOutput.script_pub_key },
      walletInputs: [snapshot.borrowerNftInput, snapshot.feeInput],
      principalChange: "0",
      feeChange,
    };
  }

  if (plan.action === "lending_contract.CancelOffer" && snapshot.kind === "cancelOffer") {
    requireChainInput(snapshot.pendingOffer, plan.covenantInputs[0].outpoint, plan.intent.collateralAssetId, plan.intent.collateralAmount, covenants.pendingOffer.script_pub_key, "pending offer");
    requireChainInput(snapshot.lenderNftAuthorization, plan.covenantInputs[1].outpoint, plan.intent.lenderNftAssetId, "1", covenants.lenderNftAuthorization.script_pub_key, "lender NFT authorization");
    requireWalletInput(snapshot.borrowerNftInput, plan.walletInputs[0].outpoint, plan.intent.borrowerNftAssetId, "1", "borrower NFT");
    distinct([snapshot.pendingOffer, snapshot.lenderNftAuthorization, snapshot.borrowerNftInput, snapshot.feeInput]);
    const inputs = [snapshot.pendingOffer, snapshot.lenderNftAuthorization, snapshot.borrowerNftInput, snapshot.feeInput];
    const outputs: TxManifestPsetBuildSpec["outputs"] = [
      { script_pub_key: BURN_SCRIPT, asset: plan.intent.lenderNftAssetId, amount: "1" },
      { script_pub_key: BURN_SCRIPT, asset: plan.intent.borrowerNftAssetId, amount: "1" },
      confidentialOutput(snapshot.walletDestination, plan.intent.collateralAssetId, plan.intent.collateralAmount, 0),
    ];
    const feeChange = addFeeChange(outputs, snapshot, 3);
    const debtLeaf = u64StorageLeaf(covenants.currentDebt);
    return {
      buildSpec: buildSpec(inputs, outputs, snapshot),
      covenantExecutions: [
        lendingExecution(
          covenants,
          snapshot.genesisHash,
          0,
          "Left(Right(()))",
          PENDING_OFFER_STATE_LEAF,
          debtLeaf,
        ),
        {
          source: SIMPLICITY_LENDING_V3_BUNDLE.sources["script_auth.simf"],
          arguments: { SCRIPT_HASH: { value: `0x${covenants.pendingOffer.script_hash}`, type: "u256" } },
          extra_leaf_payloads: [],
          witnesses: { INPUT_SCRIPT_INDEX: { type: "simplicityhl", value: "0" } },
          input_index: 1,
          genesis_hash: snapshot.genesisHash,
          include_debug_symbols: true,
        },
      ],
      covenantCommitments: {
        pendingOffer: covenants.pendingOffer.script_pub_key,
        lenderNftAuthorization: covenants.lenderNftAuthorization.script_pub_key,
      },
      walletInputs: [snapshot.borrowerNftInput, snapshot.feeInput],
      principalChange: "0",
      feeChange,
    };
  }

  if (plan.action === "lending_contract.RepayLoan" && snapshot.kind === "repayLoan") {
    requireWalletInput(snapshot.borrowerNftInput, plan.walletInputs[0].outpoint, plan.intent.borrowerNftAssetId, "1", "borrower NFT");
    requireChainInput(snapshot.activeOffer, plan.covenantInputs[0].outpoint, plan.intent.collateralAssetId, plan.intent.collateralAmount, covenants.activeOffer.script_pub_key, "active offer");
    requireWalletInput(snapshot.repaymentInput, undefined, plan.intent.principalAssetId, plan.intent.totalDebt, "repayment input");
    const combinedRepaymentAndFee = sameOutpoint(snapshot.repaymentInput, snapshot.feeInput);
    if (combinedRepaymentAndFee && plan.intent.principalAssetId !== snapshot.policyAssetId) {
      throw new Error("Only an L-BTC repayment input may also pay the network fee.");
    }
    if (
      combinedRepaymentAndFee &&
      BigInt(snapshot.repaymentInput.amount) < BigInt(plan.intent.totalDebt) + BigInt(snapshot.fee)
    ) {
      throw new Error("The combined repayment input cannot also cover the network fee.");
    }
    distinct([
      snapshot.borrowerNftInput,
      snapshot.activeOffer,
      snapshot.repaymentInput,
      ...(combinedRepaymentAndFee ? [] : [snapshot.feeInput]),
    ]);
    const principalChange = (
      BigInt(snapshot.repaymentInput.amount) -
      BigInt(plan.intent.totalDebt) -
      (combinedRepaymentAndFee ? BigInt(snapshot.fee) : 0n)
    ).toString();
    const inputs = [
      snapshot.borrowerNftInput,
      snapshot.activeOffer,
      snapshot.repaymentInput,
      ...(combinedRepaymentAndFee ? [] : [snapshot.feeInput]),
    ];
    const outputs: TxManifestPsetBuildSpec["outputs"] = [
      { script_pub_key: BURN_SCRIPT, asset: plan.intent.borrowerNftAssetId, amount: "1" },
      { script_pub_key: covenants.finalizedLenderVault.script_pub_key, asset: plan.intent.principalAssetId, amount: plan.intent.lenderVaultAmount },
      { script_pub_key: covenants.finalizedProtocolFeeVault.script_pub_key, asset: plan.intent.principalAssetId, amount: plan.intent.protocolFeeAmount },
      confidentialOutput(snapshot.walletDestination, plan.intent.collateralAssetId, plan.intent.collateralAmount, 1),
    ];
    if (principalChange !== "0") {
      if (!snapshot.principalChangeDestination) throw new Error("principalChangeDestination is required for repayment change.");
      outputs.push(confidentialOutput(snapshot.principalChangeDestination, plan.intent.principalAssetId, principalChange, 2));
    }
    const feeChange = combinedRepaymentAndFee ? "0" : addFeeChange(outputs, snapshot, 3);
    return {
      buildSpec: buildSpec(inputs, outputs, snapshot),
      covenantExecutions: [
        lendingExecution(
          covenants,
          snapshot.genesisHash,
          1,
          `Right(Left(Right(${plan.intent.totalDebt})))`,
          ACTIVE_OFFER_STATE_LEAF,
          u64StorageLeaf(covenants.currentDebt),
        ),
      ],
      covenantCommitments: {
        activeOffer: covenants.activeOffer.script_pub_key,
        finalizedLenderVault: covenants.finalizedLenderVault.script_pub_key,
        finalizedProtocolFeeVault: covenants.finalizedProtocolFeeVault.script_pub_key,
      },
      walletInputs: [
        snapshot.borrowerNftInput,
        snapshot.repaymentInput,
        ...(combinedRepaymentAndFee ? [] : [snapshot.feeInput]),
      ],
      principalChange,
      feeChange,
    };
  }

  if (plan.action === "lending_contract.LiquidateOffer" && snapshot.kind === "liquidateOffer") {
    if (snapshot.tipHeight < plan.intent.expirationHeight) throw new Error("This loan has not reached its liquidation height.");
    requireChainInput(snapshot.activeOffer, plan.covenantInputs[0].outpoint, plan.intent.collateralAssetId, plan.intent.collateralAmount, covenants.activeOffer.script_pub_key, "active offer");
    requireWalletInput(snapshot.lenderNftInput, plan.walletInputs[0].outpoint, plan.intent.lenderNftAssetId, "1", "lender NFT");
    distinct([snapshot.activeOffer, snapshot.lenderNftInput, snapshot.feeInput]);
    const inputs = [
      { ...snapshot.activeOffer, sequence: ACTIVE_SEQUENCE },
      snapshot.lenderNftInput,
      snapshot.feeInput,
    ];
    const outputs: TxManifestPsetBuildSpec["outputs"] = [
      { script_pub_key: BURN_SCRIPT, asset: plan.intent.lenderNftAssetId, amount: "1" },
      confidentialOutput(snapshot.walletDestination, plan.intent.collateralAssetId, plan.intent.collateralAmount, 0),
    ];
    const feeChange = addFeeChange(outputs, snapshot, 2);
    return {
      buildSpec: { ...buildSpec(inputs, outputs, snapshot), locktime: plan.intent.expirationHeight },
      covenantExecutions: [
        lendingExecution(
          covenants,
          snapshot.genesisHash,
          0,
          `Right(Right(${plan.intent.totalDebt}))`,
          ACTIVE_OFFER_STATE_LEAF,
          u64StorageLeaf(covenants.currentDebt),
        ),
      ],
      covenantCommitments: { activeOffer: covenants.activeOffer.script_pub_key },
      walletInputs: [snapshot.lenderNftInput, snapshot.feeInput],
      principalChange: "0",
      feeChange,
    };
  }

  throw new Error("The lending action plan and chain snapshot do not match.");
}

function lendingExecution(
  covenants: LendingV3AcceptOfferCovenants,
  genesisHash: string,
  inputIndex: number,
  path: string,
  stateLeaf: string,
  debtLeaf: string,
): PreparedCovenantExecution {
  return {
    source: SIMPLICITY_LENDING_V3_BUNDLE.sources["lending.simf"],
    arguments: covenants.lendingArguments,
    extra_leaf_payloads: [stateLeaf, debtLeaf],
    witnesses: { PATH: { type: "simplicityhl", value: path } },
    input_index: inputIndex,
    genesis_hash: genesisHash,
    include_debug_symbols: true,
  };
}

function validateCommon(plan: BorrowerLendingRequirementPlan, snapshot: SnapshotBase): void {
  if (!/^[0-9a-f]{64}$/.test(snapshot.genesisHash)) throw new Error("Invalid genesis hash.");
  asset(snapshot.policyAssetId, "policyAssetId");
  if (!Number.isInteger(snapshot.tipHeight) || snapshot.tipHeight < 0) throw new Error("Invalid tip height.");
  if (plan.constraints.validUntilHeight !== undefined && snapshot.tipHeight > plan.constraints.validUntilHeight) {
    throw new Error("The manifest request expired before transaction preparation.");
  }
  decimal(snapshot.fee, "fee");
  if (plan.constraints.maxFee !== undefined && BigInt(snapshot.fee) > BigInt(plan.constraints.maxFee)) {
    throw new Error("The selected network fee exceeds the approved maximum.");
  }
  requireWalletInput(snapshot.feeInput, undefined, snapshot.policyAssetId, snapshot.fee, "fee input");
}

function buildSpec(inputs: AcceptOfferResolvedInput[], outputs: TxManifestPsetBuildSpec["outputs"], snapshot: SnapshotBase): TxManifestPsetBuildSpec {
  return { inputs: inputs.map(psetInput), outputs, fee: { asset: snapshot.policyAssetId, amount: snapshot.fee } };
}

function addFeeChange(outputs: TxManifestPsetBuildSpec["outputs"], snapshot: SnapshotBase, blinderIndex: number): string {
  const change = (BigInt(snapshot.feeInput.amount) - BigInt(snapshot.fee)).toString();
  if (change !== "0") {
    if (!snapshot.feeChangeDestination) throw new Error("feeChangeDestination is required for non-zero change.");
    outputs.push(confidentialOutput(snapshot.feeChangeDestination, snapshot.policyAssetId, change, blinderIndex));
  }
  return change;
}

function requireChainInput(actual: AcceptOfferResolvedInput, outpoint_: TxManifestOutpoint, assetId: string, amount: string, scriptPubKey: string, label: string): void {
  if (!sameOutpoint(actual, outpoint_) || actual.assetId !== assetId || actual.amount !== amount || actual.scriptPubKey !== scriptPubKey) {
    throw new Error(`Resolved ${label} does not match the trusted covenant commitment.`);
  }
}

function requireWalletInput(actual: AcceptOfferResolvedInput, outpoint_: TxManifestOutpoint | undefined, assetId: string, minimum: string, label: string): void {
  if (outpoint_ && !sameOutpoint(actual, outpoint_)) throw new Error(`Resolved ${label} outpoint changed.`);
  if (actual.assetId !== assetId || BigInt(actual.amount) < BigInt(minimum)) throw new Error(`Resolved ${label} does not satisfy the required asset and amount.`);
  if ((actual.assetBlindingFactor === undefined) !== (actual.valueBlindingFactor === undefined)) throw new Error(`Resolved ${label} must include both blinding factors or neither.`);
}

function distinct(inputs: AcceptOfferResolvedInput[]): void {
  const keys = inputs.map((input) => `${input.txid}:${input.vout}`);
  if (new Set(keys).size !== keys.length) throw new Error("The manifest transaction inputs must use distinct outpoints.");
}

function psetInput(input: AcceptOfferResolvedInput): TxManifestPsetBuildSpec["inputs"][number] {
  return {
    txid: input.txid,
    vout: input.vout,
    tx_out: input.txOut,
    asset: input.assetId,
    amount: input.amount,
    ...(input.assetBlindingFactor ? { asset_blinding_factor: input.assetBlindingFactor, value_blinding_factor: input.valueBlindingFactor } : {}),
    ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
  };
}

function output(destination: AcceptOfferDestination, assetId: string, amount: string): TxManifestPsetBuildSpec["outputs"][number] {
  return { script_pub_key: script(destination, "explicit wallet destination"), asset: assetId, amount };
}

function confidentialOutput(destination: AcceptOfferDestination, assetId: string, amount: string, blinderIndex: number): TxManifestPsetBuildSpec["outputs"][number] {
  if (!destination.blindingPublicKey) throw new Error("A confidential wallet destination is required.");
  return { script_pub_key: script(destination, "wallet destination"), asset: assetId, amount, blinding_public_key: destination.blindingPublicKey, blinder_index: blinderIndex };
}

function script(destination: AcceptOfferDestination, label: string): string {
  if (!/^(?:[0-9a-f]{2})+$/.test(destination.scriptPubKey)) throw new Error(`${label} script is invalid.`);
  return destination.scriptPubKey;
}

function stripSecrets(input: TxManifestPsetBuildSpec["inputs"][number]): object {
  const { asset_blinding_factor: _assetBf, value_blinding_factor: _valueBf, ...safe } = input;
  return safe;
}

function u64StorageLeaf(value: string): string {
  return `${"00".repeat(24)}${BigInt(value).toString(16).padStart(16, "0")}`;
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
