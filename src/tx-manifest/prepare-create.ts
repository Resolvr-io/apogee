import { SIMPLICITY_LENDING_V3_BUNDLE } from "./builtins/simplicity-lending-v3";
import { taggedCanonicalJsonHash } from "./bundle";
import { deriveSimplicityLendingAsset } from "./issuance";
import {
  compileLendingV3AcceptOfferCovenants,
  compileLendingV3IssuanceFactory,
  type CovenantNetwork,
  type LendingV3AcceptOfferCovenants,
  type LendingV3IssuanceFactory,
} from "./lending-v3";
import type { AcceptOfferDestination, AcceptOfferResolvedInput } from "./prepare-accept-offer";
import type { PreparedCovenantExecution } from "./prepare-lending-action";
import type {
  CreateFactoryRequirementPlan,
  CreateOfferRequirementPlan,
  TxManifestOutpoint,
} from "./requirements";
import {
  buildTxManifestPset,
  finalizeTxManifestCovenant,
  type TxManifestCovenantFinalizeSpec,
  type TxManifestPsetBuildSpec,
} from "./runtime";

const FACTORY_CREATION_SCRIPT = `6a0d${"dd1e7f89"}02${"00".repeat(8)}`;

type CreateRuntime = {
  buildPset(spec: TxManifestPsetBuildSpec): Promise<string>;
  finalizeCovenant(spec: TxManifestCovenantFinalizeSpec): Promise<string>;
  compileFactory: typeof compileLendingV3IssuanceFactory;
  compileLending: typeof compileLendingV3AcceptOfferCovenants;
  deriveAsset: typeof deriveSimplicityLendingAsset;
};

const DEFAULT_RUNTIME: CreateRuntime = {
  buildPset: buildTxManifestPset,
  finalizeCovenant: finalizeTxManifestCovenant,
  compileFactory: compileLendingV3IssuanceFactory,
  compileLending: compileLendingV3AcceptOfferCovenants,
  deriveAsset: deriveSimplicityLendingAsset,
};

export type CreateFactoryChainWalletSnapshot = {
  network?: CovenantNetwork;
  genesisHash: string;
  tipHeight: number;
  policyAssetId: string;
  assetContractDomain: string;
  fundingInput: AcceptOfferResolvedInput;
  explicitWalletDestination: AcceptOfferDestination;
  feeChangeDestination?: AcceptOfferDestination;
  fee: string;
};

export type PreparedCreateFactoryExecution = {
  kind: "createFactory";
  pset: string;
  planDigest: `sha256:${string}`;
  requirementsDigest: `sha256:${string}`;
  factory: LendingV3IssuanceFactory;
  covenantExecutions: PreparedCovenantExecution[];
  review: {
    factoryAssetId: string;
    fundingAmount: string;
    feeAssetId: string;
    fee: string;
    feeChange: string;
    walletInputOutpoints: TxManifestOutpoint[];
  };
};

export async function prepareLendingV3CreateFactory(
  plan: CreateFactoryRequirementPlan,
  snapshot: CreateFactoryChainWalletSnapshot,
  runtime: CreateRuntime = DEFAULT_RUNTIME,
): Promise<PreparedCreateFactoryExecution> {
  validateCommon(plan, snapshot);
  requireWalletInput(snapshot.fundingInput, snapshot.policyAssetId, snapshot.fee, "factory funding input");
  const issued = await runtime.deriveAsset(
    snapshot.assetContractDomain,
    outpoint(snapshot.fundingInput),
    "factory",
  );
  const factory = await runtime.compileFactory(undefined, snapshot.network);
  const feeChange = (BigInt(snapshot.fundingInput.amount) - BigInt(snapshot.fee)).toString();
  const outputs: TxManifestPsetBuildSpec["outputs"] = [
    output(snapshot.explicitWalletDestination, issued.assetId, "1"),
    { script_pub_key: factory.covenant.script_pub_key, asset: issued.assetId, amount: "1" },
    { script_pub_key: FACTORY_CREATION_SCRIPT, asset: snapshot.policyAssetId, amount: "0" },
  ];
  if (feeChange !== "0") {
    if (!snapshot.feeChangeDestination) throw new Error("feeChangeDestination is required for non-zero change.");
    outputs.push(confidentialOutput(snapshot.feeChangeDestination, snapshot.policyAssetId, feeChange, 0));
  }
  const buildSpec: TxManifestPsetBuildSpec = {
    inputs: [{
      ...psetInput(snapshot.fundingInput),
      issuance: { contract_hash: issued.contractHash, asset_amount: "2" },
    }],
    outputs,
    fee: { asset: snapshot.policyAssetId, amount: snapshot.fee },
  };
  const pset = await runtime.buildPset(buildSpec);
  const authorization = {
    version: "apogee-tx-manifest-plan/v1",
    requestId: plan.requestId,
    chainId: plan.chainId,
    accountIdentifier: plan.accountIdentifier,
    bundleHash: plan.bundleHash,
    action: plan.action,
    requirementsDigest: plan.requirementDigest,
    inputs: buildSpec.inputs.map(stripSecrets),
    outputs,
    fee: buildSpec.fee,
    covenantCommitments: { factory: factory.covenant.script_pub_key },
  };
  return {
    kind: "createFactory",
    pset,
    planDigest: await taggedCanonicalJsonHash("apogee/tx-manifest-plan/v1", authorization),
    requirementsDigest: plan.requirementDigest,
    factory,
    covenantExecutions: [],
    review: {
      factoryAssetId: issued.assetId,
      fundingAmount: snapshot.fundingInput.amount,
      feeAssetId: snapshot.policyAssetId,
      fee: snapshot.fee,
      feeChange,
      walletInputOutpoints: [outpoint(snapshot.fundingInput)],
    },
  };
}

export type CreateOfferChainWalletSnapshot = {
  network?: CovenantNetwork;
  genesisHash: string;
  tipHeight: number;
  policyAssetId: string;
  assetContractDomain: string;
  factoryAuthInput: AcceptOfferResolvedInput;
  factoryCovenant: AcceptOfferResolvedInput;
  collateralInput: AcceptOfferResolvedInput;
  feeInput: AcceptOfferResolvedInput;
  explicitWalletDestination: AcceptOfferDestination;
  changeDestination?: AcceptOfferDestination;
  fee: string;
};

export type PreparedCreateOfferExecution = {
  kind: "createOffer";
  pset: string;
  planDigest: `sha256:${string}`;
  requirementsDigest: `sha256:${string}`;
  factory: LendingV3IssuanceFactory;
  covenants: LendingV3AcceptOfferCovenants;
  covenantExecutions: PreparedCovenantExecution[];
  review: {
    factoryAssetId: string;
    borrowerNftAssetId: string;
    lenderNftAssetId: string;
    principalAssetId: string;
    principalAmount: string;
    collateralAssetId: string;
    collateralAmount: string;
    interestRateBasisPoints: string;
    totalDebt: string;
    expirationHeight: number;
    feeAssetId: string;
    fee: string;
    feeChange: string;
    collateralChange: string;
    walletInputOutpoints: TxManifestOutpoint[];
  };
};

export async function prepareLendingV3CreateOffer(
  plan: CreateOfferRequirementPlan,
  snapshot: CreateOfferChainWalletSnapshot,
  runtime: CreateRuntime = DEFAULT_RUNTIME,
): Promise<PreparedCreateOfferExecution> {
  validateCommon(plan, snapshot);
  if (plan.intent.expirationHeight <= snapshot.tipHeight) {
    throw new Error("The borrow offer expiration must be in the future.");
  }
  requireWalletInput(snapshot.factoryAuthInput, plan.factoryAssetId, "1", "factory auth NFT", plan.walletInputs[0].outpoint);
  requireWalletInput(snapshot.collateralInput, plan.intent.collateralAssetId, plan.intent.collateralAmount, "collateral input");
  requireWalletInput(snapshot.feeInput, snapshot.policyAssetId, snapshot.fee, "fee input");
  const combinedCollateralAndFee = sameOutpoint(snapshot.collateralInput, snapshot.feeInput);
  if (combinedCollateralAndFee && plan.intent.collateralAssetId !== snapshot.policyAssetId) {
    throw new Error("Only an L-BTC collateral input may also pay the network fee.");
  }
  if (
    combinedCollateralAndFee &&
    BigInt(snapshot.collateralInput.amount) <
      BigInt(plan.intent.collateralAmount) + BigInt(snapshot.fee)
  ) {
    throw new Error("The combined collateral input cannot also cover the network fee.");
  }
  distinct([
    snapshot.factoryAuthInput,
    snapshot.factoryCovenant,
    snapshot.collateralInput,
    ...(combinedCollateralAndFee ? [] : [snapshot.feeInput]),
  ]);

  const [borrowerIssuance, lenderIssuance, factory] = await Promise.all([
    runtime.deriveAsset(snapshot.assetContractDomain, outpoint(snapshot.factoryCovenant), "borrower-nft"),
    runtime.deriveAsset(snapshot.assetContractDomain, outpoint(snapshot.collateralInput), "lender-nft"),
    runtime.compileFactory(undefined, snapshot.network),
  ]);
  requireChainInput(snapshot.factoryCovenant, plan.covenantInputs[0].outpoint, plan.factoryAssetId, "1", factory.covenant.script_pub_key, "factory covenant");
  const covenants = await runtime.compileLending(
    {
      ...plan.instance,
      BORROWER_NFT_ASSET_ID: borrowerIssuance.assetId,
      LENDER_NFT_ASSET_ID: lenderIssuance.assetId,
    },
    undefined,
    snapshot.network,
  );
  const collateralChange = (
    BigInt(snapshot.collateralInput.amount) -
    BigInt(plan.intent.collateralAmount) -
    (combinedCollateralAndFee ? BigInt(snapshot.fee) : 0n)
  ).toString();
  const feeChange = combinedCollateralAndFee
    ? "0"
    : (BigInt(snapshot.feeInput.amount) - BigInt(snapshot.fee)).toString();
  const outputs: TxManifestPsetBuildSpec["outputs"] = [
    output(snapshot.explicitWalletDestination, plan.factoryAssetId, "1"),
    { script_pub_key: factory.covenant.script_pub_key, asset: plan.factoryAssetId, amount: "1" },
    output(snapshot.explicitWalletDestination, borrowerIssuance.assetId, "1"),
    { script_pub_key: covenants.lenderNftAuthorization.script_pub_key, asset: lenderIssuance.assetId, amount: "1" },
    { script_pub_key: offerMetadataScript(plan), asset: snapshot.policyAssetId, amount: "0" },
    { script_pub_key: covenants.pendingOffer.script_pub_key, asset: plan.intent.collateralAssetId, amount: plan.intent.collateralAmount },
  ];
  if (collateralChange !== "0") {
    if (!snapshot.changeDestination) throw new Error("changeDestination is required for collateral change.");
    outputs.push(confidentialOutput(snapshot.changeDestination, plan.intent.collateralAssetId, collateralChange, 2));
  }
  if (feeChange !== "0") {
    if (!snapshot.changeDestination) throw new Error("changeDestination is required for fee change.");
    outputs.push(confidentialOutput(snapshot.changeDestination, snapshot.policyAssetId, feeChange, 3));
  }

  const buildSpec: TxManifestPsetBuildSpec = {
    inputs: [
      psetInput(snapshot.factoryAuthInput),
      { ...psetInput(snapshot.factoryCovenant), issuance: { contract_hash: borrowerIssuance.contractHash, asset_amount: "1" } },
      { ...psetInput(snapshot.collateralInput), issuance: { contract_hash: lenderIssuance.contractHash, asset_amount: "1" } },
      ...(combinedCollateralAndFee ? [] : [psetInput(snapshot.feeInput)]),
    ],
    outputs,
    fee: { asset: snapshot.policyAssetId, amount: snapshot.fee },
  };
  const covenantExecution: PreparedCovenantExecution = {
    source: SIMPLICITY_LENDING_V3_BUNDLE.sources["issuance_factory.simf"],
    arguments: factory.arguments,
    extra_leaf_payloads: [],
    witnesses: { PATH: { type: "simplicityhl", value: "Left(0)" } },
    input_index: 1,
    genesis_hash: snapshot.genesisHash,
    include_debug_symbols: true,
  };
  let pset = await runtime.buildPset(buildSpec);
  pset = await runtime.finalizeCovenant({ pset, ...covenantExecution });
  const authorization = {
    version: "apogee-tx-manifest-plan/v1",
    requestId: plan.requestId,
    chainId: plan.chainId,
    accountIdentifier: plan.accountIdentifier,
    bundleHash: plan.bundleHash,
    action: plan.action,
    requirementsDigest: plan.requirementDigest,
    inputs: buildSpec.inputs.map(stripSecrets),
    outputs,
    fee: buildSpec.fee,
    covenantCommitments: {
      factory: factory.covenant.script_pub_key,
      pendingOffer: covenants.pendingOffer.script_pub_key,
      lenderNftAuthorization: covenants.lenderNftAuthorization.script_pub_key,
    },
  };
  return {
    kind: "createOffer",
    pset,
    planDigest: await taggedCanonicalJsonHash("apogee/tx-manifest-plan/v1", authorization),
    requirementsDigest: plan.requirementDigest,
    factory,
    covenants,
    covenantExecutions: [covenantExecution],
    review: {
      factoryAssetId: plan.factoryAssetId,
      borrowerNftAssetId: borrowerIssuance.assetId,
      lenderNftAssetId: lenderIssuance.assetId,
      principalAssetId: plan.intent.principalAssetId,
      principalAmount: plan.intent.principalAmount,
      collateralAssetId: plan.intent.collateralAssetId,
      collateralAmount: plan.intent.collateralAmount,
      interestRateBasisPoints: plan.intent.interestRateBasisPoints,
      totalDebt: plan.intent.totalDebt,
      expirationHeight: plan.intent.expirationHeight,
      feeAssetId: snapshot.policyAssetId,
      fee: snapshot.fee,
      feeChange,
      collateralChange,
      walletInputOutpoints: [
        outpoint(snapshot.factoryAuthInput),
        outpoint(snapshot.collateralInput),
        ...(combinedCollateralAndFee ? [] : [outpoint(snapshot.feeInput)]),
      ],
    },
  };
}

function offerMetadataScript(plan: CreateOfferRequirementPlan): string {
  const principalInternal = (plan.intent.principalAssetId.match(/../g) ?? []).reverse().join("");
  const amount = littleEndianHex(BigInt(plan.intent.principalAmount), 8);
  const expiration = littleEndianHex(BigInt(plan.intent.expirationHeight), 4);
  const interest = littleEndianHex(BigInt(plan.intent.interestRateBasisPoints), 2);
  const payload = `a9b4ade7${principalInternal}${amount}${expiration}${interest}`;
  if (payload.length !== 100) throw new Error("The lending metadata payload is not 50 bytes.");
  return `6a32${payload}`;
}

function littleEndianHex(value: bigint, bytes: number): string {
  const hex = value.toString(16).padStart(bytes * 2, "0");
  if (hex.length !== bytes * 2) throw new Error("Lending metadata integer overflow.");
  return (hex.match(/../g) ?? []).reverse().join("");
}

function validateCommon(plan: { constraints: { maxFee?: string; validUntilHeight?: number } }, snapshot: { genesisHash: string; tipHeight: number; policyAssetId: string; fee: string }): void {
  if (!/^[0-9a-f]{64}$/.test(snapshot.genesisHash)) throw new Error("Invalid genesis hash.");
  if (!/^[0-9a-f]{64}$/.test(snapshot.policyAssetId)) throw new Error("Invalid policy asset id.");
  if (!Number.isInteger(snapshot.tipHeight) || snapshot.tipHeight < 0) throw new Error("Invalid tip height.");
  if (plan.constraints.validUntilHeight !== undefined && snapshot.tipHeight > plan.constraints.validUntilHeight) throw new Error("The manifest request expired before transaction preparation.");
  if (!/^(?:0|[1-9][0-9]*)$/.test(snapshot.fee)) throw new Error("Invalid fee.");
  if (plan.constraints.maxFee !== undefined && BigInt(snapshot.fee) > BigInt(plan.constraints.maxFee)) throw new Error("The selected network fee exceeds the approved maximum.");
}

function requireChainInput(actual: AcceptOfferResolvedInput, outpoint_: TxManifestOutpoint, assetId: string, amount: string, scriptPubKey: string, label: string): void {
  if (!sameOutpoint(actual, outpoint_) || actual.assetId !== assetId || actual.amount !== amount || actual.scriptPubKey !== scriptPubKey) throw new Error(`Resolved ${label} does not match the trusted covenant commitment.`);
}

function requireWalletInput(actual: AcceptOfferResolvedInput, assetId: string, minimum: string, label: string, outpoint_?: TxManifestOutpoint): void {
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
  return { script_pub_key: script(destination), asset: assetId, amount };
}

function confidentialOutput(destination: AcceptOfferDestination, assetId: string, amount: string, blinderIndex: number): TxManifestPsetBuildSpec["outputs"][number] {
  if (!destination.blindingPublicKey) throw new Error("A confidential change destination is required.");
  return { script_pub_key: script(destination), asset: assetId, amount, blinding_public_key: destination.blindingPublicKey, blinder_index: blinderIndex };
}

function script(destination: AcceptOfferDestination): string {
  if (!/^(?:[0-9a-f]{2})+$/.test(destination.scriptPubKey)) throw new Error("The wallet destination script is invalid.");
  return destination.scriptPubKey;
}

function stripSecrets(input: TxManifestPsetBuildSpec["inputs"][number]): object {
  const { asset_blinding_factor: _assetBf, value_blinding_factor: _valueBf, ...safe } = input;
  return safe;
}

function sameOutpoint(a: TxManifestOutpoint, b: TxManifestOutpoint): boolean {
  return a.txid === b.txid && a.vout === b.vout;
}

function outpoint(input: AcceptOfferResolvedInput): TxManifestOutpoint {
  return { txid: input.txid, vout: input.vout };
}
