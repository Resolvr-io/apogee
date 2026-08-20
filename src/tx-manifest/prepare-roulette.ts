import {
  SIMPLICITY_ROULETTE_V1_BUNDLE,
  SIMPLICITY_ROULETTE_V1_CANCEL,
  SIMPLICITY_ROULETTE_V1_CLAIM_PAYOUT,
  SIMPLICITY_ROULETTE_V1_FORFEIT,
  SIMPLICITY_ROULETTE_V1_OPEN,
  SIMPLICITY_ROULETTE_V1_SETTLE,
  SIMPLICITY_ROULETTE_V1_TAKE,
} from "./builtins/simplicity-roulette-v1";
import { taggedCanonicalJsonHash } from "./bundle";
import { MAX_MANIFEST_WALLET_INPUTS_PER_ASSET } from "./coin-selection-policy";
import type { AcceptOfferDestination, AcceptOfferResolvedInput } from "./prepare-accept-offer";
import type {
  RouletteCancelRequirementPlan,
  RouletteClaimPayoutRequirementPlan,
  RouletteForfeitRequirementPlan,
  RouletteOpenRequirementPlan,
  RouletteRequirementPlan,
  RouletteSettleRequirementPlan,
  RouletteTakeRequirementPlan,
  TxManifestOutpoint,
} from "./requirements";
import { rouletteMetadataScripts } from "./roulette-metadata";
import {
  compileRouletteV1State,
  rouletteActiveState,
  rouletteFinalizeExecution,
  rouletteOpenState,
  rouletteOutcome,
  roulettePayouts,
  rouletteScriptHash,
  rouletteSecretCommitment,
  type RouletteCovenantState,
} from "./roulette-v1";
import { trustedTxManifestActionHintScript } from "./registry";
import {
  buildTxManifestPset,
  finalizeTxManifestCovenant,
  type TxManifestCovenantCompileSpec,
  type TxManifestCovenantFinalizeSpec,
  type TxManifestPsetBuildSpec,
} from "./runtime";

const SOURCE = SIMPLICITY_ROULETTE_V1_BUNDLE.sources["roulette_v1.simf"];
const UNLOCKED_SEQUENCE = 0xffff_fffe;

type BaseSnapshot = {
  network: TxManifestCovenantCompileSpec["network"];
  genesisHash: string;
  tipHeight: number;
  policyAssetId: string;
  feeInputs: AcceptOfferResolvedInput[];
  confidentialDestination: AcceptOfferDestination;
  fee: string;
};

type CovenantSnapshot = BaseSnapshot & {
  roundInput: AcceptOfferResolvedInput;
  roundInputConfirmedHeight: number;
};

export type RouletteOpenChainWalletSnapshot = BaseSnapshot & {
  kind: "rouletteOpen";
  fundingInputs: AcceptOfferResolvedInput[];
  playerDestination: AcceptOfferDestination;
};

export type RouletteTakeChainWalletSnapshot = CovenantSnapshot & {
  kind: "rouletteTake";
  collateralInputs: AcceptOfferResolvedInput[];
};

export type RouletteSettleChainWalletSnapshot = CovenantSnapshot & { kind: "rouletteSettle" };
export type RouletteCancelChainWalletSnapshot = CovenantSnapshot & { kind: "rouletteCancel" };
export type RouletteForfeitChainWalletSnapshot = CovenantSnapshot & { kind: "rouletteForfeit" };

export type RouletteClaimPayoutChainWalletSnapshot = BaseSnapshot & {
  kind: "rouletteClaimPayout";
  payoutInput: AcceptOfferResolvedInput;
  terminalAction: typeof SIMPLICITY_ROULETTE_V1_SETTLE | typeof SIMPLICITY_ROULETTE_V1_CANCEL | typeof SIMPLICITY_ROULETTE_V1_FORFEIT;
};

export type RouletteChainWalletSnapshot =
  | RouletteOpenChainWalletSnapshot
  | RouletteTakeChainWalletSnapshot
  | RouletteSettleChainWalletSnapshot
  | RouletteCancelChainWalletSnapshot
  | RouletteForfeitChainWalletSnapshot
  | RouletteClaimPayoutChainWalletSnapshot;

export type PreparedRouletteExecution = {
  kind: RouletteChainWalletSnapshot["kind"];
  pset: string;
  planDigest: `sha256:${string}`;
  requirementsDigest: `sha256:${string}`;
  covenantExecutions: Array<Omit<TxManifestCovenantFinalizeSpec, "pset">>;
  review: {
    roundId: string;
    assetId: string;
    stake: string;
    bond: string;
    houseCollateral: string;
    pocket?: number;
    playerAmount?: string;
    houseAmount?: string;
    payoutAmount?: string;
    terminalAction?: string;
    feeAssetId: string;
    fee: string;
    assetChange: string;
    feeChange: string;
    walletInputOutpoints: TxManifestOutpoint[];
  };
};

type Runtime = {
  compile: Parameters<typeof compileRouletteV1State>[3];
  buildPset(spec: TxManifestPsetBuildSpec): Promise<string>;
  finalize(spec: TxManifestCovenantFinalizeSpec): Promise<string>;
};

const DEFAULT_RUNTIME: Runtime = {
  compile: undefined,
  buildPset: buildTxManifestPset,
  finalize: finalizeTxManifestCovenant,
};

/** Build, covenant-finalize, and review one roulette action without wallet signing. */
export async function prepareRouletteV1Action(
  plan: RouletteRequirementPlan,
  snapshot: RouletteChainWalletSnapshot,
  runtime: Runtime = DEFAULT_RUNTIME,
): Promise<PreparedRouletteExecution> {
  validateCommon(plan, snapshot);
  const prepared = await prepare(plan, snapshot, runtime);
  const metadata = await rouletteMetadataScripts(prepared.metadata);
  prepared.buildSpec.outputs.push(...metadata.map((script) => ({
    script_pub_key: script,
    asset: snapshot.policyAssetId,
    amount: "0",
  })));
  prepared.buildSpec.outputs.push({
    script_pub_key: await trustedTxManifestActionHintScript(plan.bundleHash, plan.action),
    asset: snapshot.policyAssetId,
    amount: "0",
  });
  let pset = await runtime.buildPset(prepared.buildSpec);
  for (const execution of prepared.covenantExecutions) {
    pset = await runtime.finalize({ pset, ...execution });
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
    covenantCommitments: prepared.covenantCommitments,
  };
  return {
    kind: snapshot.kind,
    pset,
    planDigest: await taggedCanonicalJsonHash("apogee/tx-manifest-plan/v1", authorization),
    requirementsDigest: plan.requirementDigest,
    covenantExecutions: prepared.covenantExecutions,
    review: prepared.review,
  };
}

type PreparedParts = {
  buildSpec: TxManifestPsetBuildSpec;
  covenantExecutions: Array<Omit<TxManifestCovenantFinalizeSpec, "pset">>;
  covenantCommitments: Record<string, string>;
  metadata: Parameters<typeof rouletteMetadataScripts>[0];
  review: PreparedRouletteExecution["review"];
};

async function prepare(
  plan: RouletteRequirementPlan,
  snapshot: RouletteChainWalletSnapshot,
  runtime: Runtime,
): Promise<PreparedParts> {
  if (plan.action === SIMPLICITY_ROULETTE_V1_OPEN && snapshot.kind === "rouletteOpen") {
    return prepareOpen(plan, snapshot, runtime);
  }
  if (plan.action === SIMPLICITY_ROULETTE_V1_TAKE && snapshot.kind === "rouletteTake") {
    return prepareTake(plan, snapshot, runtime);
  }
  if (plan.action === SIMPLICITY_ROULETTE_V1_SETTLE && snapshot.kind === "rouletteSettle") {
    return prepareSettle(plan, snapshot, runtime);
  }
  if (plan.action === SIMPLICITY_ROULETTE_V1_CANCEL && snapshot.kind === "rouletteCancel") {
    return prepareCancel(plan, snapshot, runtime);
  }
  if (plan.action === SIMPLICITY_ROULETTE_V1_FORFEIT && snapshot.kind === "rouletteForfeit") {
    return prepareForfeit(plan, snapshot, runtime);
  }
  if (plan.action === SIMPLICITY_ROULETTE_V1_CLAIM_PAYOUT && snapshot.kind === "rouletteClaimPayout") {
    return prepareClaimPayout(plan, snapshot);
  }
  throw new Error("The roulette action plan and chain/wallet snapshot do not match.");
}

async function prepareOpen(
  plan: RouletteOpenRequirementPlan,
  snapshot: RouletteOpenChainWalletSnapshot,
  runtime: Runtime,
): Promise<PreparedParts> {
  const playerScript = script(snapshot.playerDestination, "playerDestination");
  requireP2wpkh(playerScript, "playerDestination");
  const playerHash = await rouletteScriptHash(playerScript);
  const state = rouletteOpenState(plan.terms, playerHash);
  const compiled = await compile(state, snapshot, runtime);
  const openAmount = add(plan.terms.stake, plan.terms.bond);
  const combined = plan.terms.assetId === snapshot.policyAssetId;
  requireInputs(snapshot.fundingInputs, plan.terms.assetId, add(openAmount, combined ? snapshot.fee : "0"), "round funding inputs");
  if (!combined) requireInputs(snapshot.feeInputs, snapshot.policyAssetId, snapshot.fee, "fee inputs");
  else if (snapshot.feeInputs.length !== 0) throw new Error("L-BTC Open funding must not duplicate fee inputs.");
  distinct([...snapshot.fundingInputs, ...snapshot.feeInputs]);
  const assetChange = subtract(sum(snapshot.fundingInputs), add(openAmount, combined ? snapshot.fee : "0"));
  const feeChange = combined ? "0" : subtract(sum(snapshot.feeInputs), snapshot.fee);
  const outputs: TxManifestPsetBuildSpec["outputs"] = [
    explicit(compiled.covenant.script_pub_key, plan.terms.assetId, openAmount),
  ];
  addChange(outputs, snapshot.confidentialDestination, plan.terms.assetId, assetChange, 0);
  if (!combined) addChange(outputs, snapshot.confidentialDestination, snapshot.policyAssetId, feeChange, snapshot.fundingInputs.length);
  const inputs = [...snapshot.fundingInputs, ...snapshot.feeInputs];
  return parts(plan, snapshot, inputs, outputs, [], {
    open: compiled.covenant.script_pub_key,
  }, {
    action: "open",
    roundId: plan.terms.roundId,
    assetId: plan.terms.assetId,
    playerPayoutScript: playerScript,
    secretCommitment: plan.terms.secretCommitment,
    betKind: plan.terms.betKind,
    betSelection: plan.terms.betSelection,
    stake: plan.terms.stake,
    bond: plan.terms.bond,
    openExpiry: plan.terms.openExpiry,
    minRevealAge: plan.terms.minRevealAge,
    revealExpiry: plan.terms.revealExpiry,
    covenantVout: 0,
  }, { houseCollateral: "0", assetChange, feeChange });
}

async function prepareTake(
  plan: RouletteTakeRequirementPlan,
  snapshot: RouletteTakeChainWalletSnapshot,
  runtime: Runtime,
): Promise<PreparedParts> {
  const playerScript = playerScriptFrom(plan);
  const playerHash = await rouletteScriptHash(playerScript);
  const openState = rouletteOpenState(plan.terms, playerHash);
  const open = await compile(openState, snapshot, runtime);
  requireRoundInput(snapshot.roundInput, plan.covenantInputs[0].outpoint, plan.terms.assetId, plan.covenantInputs[0].amount, open.covenant.script_pub_key, "OPEN");
  requireInputs(snapshot.collateralInputs, plan.terms.assetId, add(plan.houseCollateral, plan.terms.assetId === snapshot.policyAssetId ? snapshot.fee : "0"), "house collateral inputs");
  if (snapshot.collateralInputs.length === 0) throw new Error("Take requires a house authorization input.");
  const houseScript = snapshot.collateralInputs[0]!.scriptPubKey;
  requireP2wpkh(houseScript, "house authorization input");
  const houseHash = await rouletteScriptHash(houseScript);
  const activeState = rouletteActiveState(openState, houseHash, plan.houseNonce, plan.houseCollateral);
  const active = await compile(activeState, snapshot, runtime);
  const combined = plan.terms.assetId === snapshot.policyAssetId;
  if (!combined) requireInputs(snapshot.feeInputs, snapshot.policyAssetId, snapshot.fee, "fee inputs");
  else if (snapshot.feeInputs.length !== 0) throw new Error("L-BTC collateral must not duplicate fee inputs.");
  distinct([snapshot.roundInput, ...snapshot.collateralInputs, ...snapshot.feeInputs]);
  const assetChange = subtract(sum(snapshot.collateralInputs), add(plan.houseCollateral, combined ? snapshot.fee : "0"));
  const feeChange = combined ? "0" : subtract(sum(snapshot.feeInputs), snapshot.fee);
  const outputs: TxManifestPsetBuildSpec["outputs"] = [
    explicit(active.covenant.script_pub_key, plan.terms.assetId, add(plan.covenantInputs[0].amount, plan.houseCollateral)),
  ];
  addChange(outputs, snapshot.confidentialDestination, plan.terms.assetId, assetChange, 1);
  if (!combined) addChange(outputs, snapshot.confidentialDestination, snapshot.policyAssetId, feeChange, 1 + snapshot.collateralInputs.length);
  const execution = rouletteFinalizeExecution(SOURCE, openState, open.stateWord, {
    action: "take",
    houseNonce: plan.houseNonce,
    houseScriptHash: houseHash,
    houseCollateral: plan.houseCollateral,
    houseInputIndex: 1,
  }, 0, snapshot.genesisHash);
  return parts(plan, snapshot, [
    { ...snapshot.roundInput, sequence: UNLOCKED_SEQUENCE },
    ...snapshot.collateralInputs,
    ...snapshot.feeInputs,
  ], outputs, [execution], { open: open.covenant.script_pub_key, active: active.covenant.script_pub_key }, {
    action: "take",
    roundId: plan.terms.roundId,
    previous: plan.covenantInputs[0].outpoint,
    housePayoutScript: houseScript,
    houseNonce: plan.houseNonce,
    houseCollateral: plan.houseCollateral,
    covenantVout: 0,
  }, { houseCollateral: plan.houseCollateral, assetChange, feeChange });
}

async function prepareSettle(
  plan: RouletteSettleRequirementPlan,
  snapshot: RouletteSettleChainWalletSnapshot,
  runtime: Runtime,
): Promise<PreparedParts> {
  const state = await activeState(plan);
  const expectedCommitment = await rouletteSecretCommitment(state, plan.playerSecret);
  if (expectedCommitment !== plan.terms.secretCommitment) throw new Error("PLAYER_SECRET does not match SECRET_COMMITMENT.");
  const compiled = await compile(state, snapshot, runtime);
  requireActiveInput(plan, snapshot, compiled.covenant.script_pub_key);
  requireMature(snapshot, plan.terms.minRevealAge, "Settle");
  const pocket = await rouletteOutcome(state, plan.playerSecret);
  const payouts = roulettePayouts(state, pocket);
  const outputs: TxManifestPsetBuildSpec["outputs"] = [];
  if (payouts.playerAmount !== "0") outputs.push(explicit(playerScriptFrom(plan), plan.terms.assetId, payouts.playerAmount));
  if (payouts.houseAmount !== "0") outputs.push(explicit(plan.housePayoutScript, plan.terms.assetId, payouts.houseAmount));
  const feeChange = terminalFeeChange(snapshot, outputs);
  const execution = rouletteFinalizeExecution(SOURCE, state, compiled.stateWord, { action: "settle", playerSecret: plan.playerSecret }, 0, snapshot.genesisHash);
  return parts(plan, snapshot, [{ ...snapshot.roundInput, sequence: plan.terms.minRevealAge }, ...snapshot.feeInputs], outputs, [execution], { active: compiled.covenant.script_pub_key }, {
    action: "settle", roundId: plan.terms.roundId, previous: plan.covenantInputs[0].outpoint,
    playerSecret: plan.playerSecret, pocket,
  }, { houseCollateral: plan.houseCollateral, pocket, ...payouts, assetChange: "0", feeChange });
}

async function prepareCancel(
  plan: RouletteCancelRequirementPlan,
  snapshot: RouletteCancelChainWalletSnapshot,
  runtime: Runtime,
): Promise<PreparedParts> {
  const playerScript = playerScriptFrom(plan);
  const state = rouletteOpenState(plan.terms, await rouletteScriptHash(playerScript));
  const compiled = await compile(state, snapshot, runtime);
  requireRoundInput(snapshot.roundInput, plan.covenantInputs[0].outpoint, plan.terms.assetId, plan.covenantInputs[0].amount, compiled.covenant.script_pub_key, "OPEN");
  requireMature(snapshot, plan.terms.openExpiry, "Cancel");
  const outputs = [explicit(playerScript, plan.terms.assetId, plan.covenantInputs[0].amount)];
  const feeChange = terminalFeeChange(snapshot, outputs);
  const execution = rouletteFinalizeExecution(SOURCE, state, compiled.stateWord, { action: "cancel" }, 0, snapshot.genesisHash);
  return parts(plan, snapshot, [{ ...snapshot.roundInput, sequence: plan.terms.openExpiry }, ...snapshot.feeInputs], outputs, [execution], { open: compiled.covenant.script_pub_key }, {
    action: "cancel", roundId: plan.terms.roundId, previous: plan.covenantInputs[0].outpoint,
  }, { houseCollateral: "0", playerAmount: plan.covenantInputs[0].amount, houseAmount: "0", assetChange: "0", feeChange });
}

async function prepareForfeit(
  plan: RouletteForfeitRequirementPlan,
  snapshot: RouletteForfeitChainWalletSnapshot,
  runtime: Runtime,
): Promise<PreparedParts> {
  const state = await activeState(plan);
  const compiled = await compile(state, snapshot, runtime);
  requireActiveInput(plan, snapshot, compiled.covenant.script_pub_key);
  requireMature(snapshot, plan.terms.revealExpiry, "Forfeit");
  const amount = plan.covenantInputs[0].amount;
  const outputs = [explicit(plan.housePayoutScript, plan.terms.assetId, amount)];
  const feeChange = terminalFeeChange(snapshot, outputs);
  const execution = rouletteFinalizeExecution(SOURCE, state, compiled.stateWord, { action: "forfeit" }, 0, snapshot.genesisHash);
  return parts(plan, snapshot, [{ ...snapshot.roundInput, sequence: plan.terms.revealExpiry }, ...snapshot.feeInputs], outputs, [execution], { active: compiled.covenant.script_pub_key }, {
    action: "forfeit", roundId: plan.terms.roundId, previous: plan.covenantInputs[0].outpoint,
  }, { houseCollateral: plan.houseCollateral, playerAmount: "0", houseAmount: amount, assetChange: "0", feeChange });
}

function prepareClaimPayout(
  plan: RouletteClaimPayoutRequirementPlan,
  snapshot: RouletteClaimPayoutChainWalletSnapshot,
): PreparedParts {
  if (!sameOutpoint(snapshot.payoutInput, plan.payoutOutpoint)) throw new Error("Resolved payout outpoint changed.");
  requireP2wpkh(snapshot.payoutInput.scriptPubKey, "roulette payout");
  requireInputs(snapshot.feeInputs, snapshot.policyAssetId, snapshot.fee, "distinct fee inputs");
  distinct([snapshot.payoutInput, ...snapshot.feeInputs]);
  const outputs: TxManifestPsetBuildSpec["outputs"] = [confidential(snapshot.confidentialDestination, snapshot.payoutInput.assetId, snapshot.payoutInput.amount, 0)];
  const feeChange = terminalFeeChange(snapshot, outputs);
  return parts(plan, snapshot, [snapshot.payoutInput, ...snapshot.feeInputs], outputs, [], {}, {
    action: "claimPayout", roundId: plan.intent.roundId, previous: plan.payoutOutpoint,
  }, {
    assetId: snapshot.payoutInput.assetId,
    houseCollateral: "0",
    payoutAmount: snapshot.payoutInput.amount,
    terminalAction: snapshot.terminalAction,
    assetChange: "0",
    feeChange,
  });
}

async function activeState(
  plan: RouletteSettleRequirementPlan | RouletteForfeitRequirementPlan,
): Promise<RouletteCovenantState> {
  const player = playerScriptFrom(plan);
  requireP2wpkh(plan.housePayoutScript, "HOUSE_PAYOUT_SCRIPT");
  const open = rouletteOpenState(plan.terms, await rouletteScriptHash(player));
  return rouletteActiveState(open, await rouletteScriptHash(plan.housePayoutScript), plan.houseNonce, plan.houseCollateral);
}

async function compile(
  state: RouletteCovenantState,
  snapshot: BaseSnapshot,
  runtime: Runtime,
) {
  return compileRouletteV1State(SOURCE, state, snapshot.network, runtime.compile);
}

function parts(
  plan: RouletteRequirementPlan,
  snapshot: BaseSnapshot,
  inputs: AcceptOfferResolvedInput[],
  outputs: TxManifestPsetBuildSpec["outputs"],
  covenantExecutions: PreparedParts["covenantExecutions"],
  covenantCommitments: Record<string, string>,
  metadata: PreparedParts["metadata"],
  review: Partial<PreparedRouletteExecution["review"]> & Pick<PreparedRouletteExecution["review"], "houseCollateral" | "assetChange" | "feeChange">,
): PreparedParts {
  return {
    buildSpec: { inputs: inputs.map(psetInput), outputs, fee: { asset: snapshot.policyAssetId, amount: snapshot.fee } },
    covenantExecutions,
    covenantCommitments,
    metadata,
    review: {
      roundId: plan.intent.roundId,
      assetId: review.assetId ?? plan.intent.assetId ?? snapshot.policyAssetId,
      stake: plan.intent.stake ?? "0",
      bond: plan.intent.bond ?? "0",
      ...review,
      feeAssetId: snapshot.policyAssetId,
      fee: snapshot.fee,
      walletInputOutpoints: inputs.slice(covenantExecutions.length === 0 && plan.action !== SIMPLICITY_ROULETTE_V1_CLAIM_PAYOUT ? 0 : 1).map(outpoint),
    },
  };
}

function validateCommon(plan: RouletteRequirementPlan, snapshot: RouletteChainWalletSnapshot): void {
  if (!/^[0-9a-f]{64}$/.test(snapshot.genesisHash)) throw new Error("Invalid genesis hash.");
  asset(snapshot.policyAssetId, "policyAssetId");
  if (!Number.isInteger(snapshot.tipHeight) || snapshot.tipHeight < 0) throw new Error("Invalid tip height.");
  decimal(snapshot.fee, "fee");
  if (plan.constraints.maxFee !== undefined && BigInt(snapshot.fee) > BigInt(plan.constraints.maxFee)) throw new Error("The selected network fee exceeds the approved maximum.");
  if (plan.constraints.validUntilHeight !== undefined && snapshot.tipHeight > plan.constraints.validUntilHeight) throw new Error("The manifest request expired before transaction preparation.");
}

function requireActiveInput(
  plan: RouletteSettleRequirementPlan | RouletteForfeitRequirementPlan,
  snapshot: CovenantSnapshot,
  scriptPubKey: string,
): void {
  requireRoundInput(snapshot.roundInput, plan.covenantInputs[0].outpoint, plan.terms.assetId, plan.covenantInputs[0].amount, scriptPubKey, "ACTIVE");
}

function requireRoundInput(actual: AcceptOfferResolvedInput, expected: TxManifestOutpoint, assetId: string, amount: string, scriptPubKey: string, phase: string): void {
  if (!sameOutpoint(actual, expected) || actual.assetId !== assetId || actual.amount !== amount || actual.scriptPubKey !== scriptPubKey) {
    throw new Error(`Resolved ${phase} input does not match the trusted roulette covenant state.`);
  }
}

function requireMature(snapshot: CovenantSnapshot, delay: number, action: string): void {
  if (!Number.isInteger(snapshot.roundInputConfirmedHeight) || snapshot.roundInputConfirmedHeight < 0) throw new Error("The roulette input confirmation height is invalid.");
  if (snapshot.tipHeight + 1 < snapshot.roundInputConfirmedHeight + delay) {
    throw new Error(`${action} relative block delay has not matured.`);
  }
}

function terminalFeeChange(snapshot: BaseSnapshot, outputs: TxManifestPsetBuildSpec["outputs"]): string {
  requireInputs(snapshot.feeInputs, snapshot.policyAssetId, snapshot.fee, "distinct fee inputs");
  const change = subtract(sum(snapshot.feeInputs), snapshot.fee);
  addChange(outputs, snapshot.confidentialDestination, snapshot.policyAssetId, change, 1);
  return change;
}

function addChange(outputs: TxManifestPsetBuildSpec["outputs"], destination: AcceptOfferDestination, assetId: string, amount: string, blinderIndex: number): void {
  if (amount !== "0") outputs.push(confidential(destination, assetId, amount, blinderIndex));
}

function explicit(scriptPubKey: string, assetId: string, amount: string): TxManifestPsetBuildSpec["outputs"][number] {
  return { script_pub_key: scriptPubKey, asset: assetId, amount };
}

function confidential(destination: AcceptOfferDestination, assetId: string, amount: string, blinderIndex: number): TxManifestPsetBuildSpec["outputs"][number] {
  if (!destination.blindingPublicKey) throw new Error("A confidential wallet destination is required.");
  return { script_pub_key: script(destination, "confidentialDestination"), asset: assetId, amount, blinding_public_key: destination.blindingPublicKey, blinder_index: blinderIndex };
}

function psetInput(input: AcceptOfferResolvedInput): TxManifestPsetBuildSpec["inputs"][number] {
  return {
    txid: input.txid, vout: input.vout, tx_out: input.txOut, asset: input.assetId, amount: input.amount,
    ...(input.assetBlindingFactor ? { asset_blinding_factor: input.assetBlindingFactor, value_blinding_factor: input.valueBlindingFactor } : {}),
    ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
  };
}

function requireInputs(inputs: readonly AcceptOfferResolvedInput[], assetId: string, minimum: string, label: string): void {
  if (inputs.length === 0 || inputs.length > MAX_MANIFEST_WALLET_INPUTS_PER_ASSET) throw new Error(`${label} must contain 1..${MAX_MANIFEST_WALLET_INPUTS_PER_ASSET} inputs.`);
  for (const input of inputs) {
    if (input.assetId !== assetId || !/^(?:0|[1-9][0-9]*)$/.test(input.amount)) throw new Error(`${label} contain an input with the wrong asset or amount.`);
  }
  if (sum(inputs) < BigInt(minimum)) throw new Error(`The connected wallet has insufficient ${label}.`);
}

function playerScriptFrom(plan: Exclude<RouletteRequirementPlan, RouletteOpenRequirementPlan | RouletteClaimPayoutRequirementPlan>): string {
  const value = plan.terms.playerPayoutScript;
  if (value === null) throw new Error("PLAYER_PAYOUT_SCRIPT is required after Open.");
  requireP2wpkh(value, "PLAYER_PAYOUT_SCRIPT");
  return value;
}

function script(destination: AcceptOfferDestination, label: string): string {
  if (!/^(?:[0-9a-f]{2})+$/.test(destination.scriptPubKey)) throw new Error(`${label} script is invalid.`);
  return destination.scriptPubKey;
}

function requireP2wpkh(value: string, label: string): void {
  if (!/^0014[0-9a-f]{40}$/.test(value)) throw new Error(`${label} must be a canonical P2WPKH script.`);
}

function sum(inputs: readonly AcceptOfferResolvedInput[]): bigint {
  return inputs.reduce((total, input) => total + BigInt(input.amount), 0n);
}

function add(left: string, right: string): string { return (BigInt(left) + BigInt(right)).toString(); }
function subtract(left: bigint, right: string): string {
  const result = left - BigInt(right);
  if (result < 0n) throw new Error("Roulette input value is insufficient.");
  return result.toString();
}

function distinct(inputs: readonly AcceptOfferResolvedInput[]): void {
  const ids = inputs.map(({ txid, vout }) => `${txid}:${vout}`);
  if (new Set(ids).size !== ids.length) throw new Error("Roulette inputs must use distinct outpoints.");
}

function sameOutpoint(left: TxManifestOutpoint, right: TxManifestOutpoint): boolean {
  return left.txid === right.txid && left.vout === right.vout;
}

function outpoint(input: AcceptOfferResolvedInput): TxManifestOutpoint { return { txid: input.txid, vout: input.vout }; }

function stripSecrets(input: TxManifestPsetBuildSpec["inputs"][number]): object {
  const { asset_blinding_factor: _abf, value_blinding_factor: _vbf, ...safe } = input;
  return safe;
}

function asset(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} is not an asset id.`);
}

function decimal(value: string, label: string): void {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} is not a canonical decimal amount.`);
}
