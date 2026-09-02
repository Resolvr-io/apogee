import { txManifestActionHintScript } from "./action-hint";
import { taggedCanonicalJsonHash } from "./bundle";
import type { DeclarativeChainSnapshot } from "./declarative-chain";
import type { DeclarativeRequirementPlan } from "./declarative-plan";
import {
  assertDeclarativeProvidedInputMatches,
  createDeclarativeEvaluationContext,
  createDeclarativePartialEvaluationContext,
  declarativeBytesHex,
  evaluateDeclarativeCovenantWitnesses,
  evaluateDeclarativeExpression,
  evaluateDeclarativeFee,
  evaluateDeclarativeOutputExpansion,
  evaluateDeclarativeTypedExpression,
  evaluateDeclarativeWalletRequirement,
  type DeclarativeEvaluationContext,
  type DeclarativeResolvedInput,
  type DeclarativeTypedExpression,
} from "./declarative";
import {
  convergeTxManifestFee,
  type TxManifestFeePolicy,
} from "./fees";
import type { AcceptOfferWalletCandidate } from "./wallet-host";
import type {
  TxManifestCovenantCommitments,
  TxManifestCovenantDryRunSpec,
  TxManifestCovenantFinalizeSpec,
  TxManifestFeeEstimate,
  TxManifestPsetBuildSpec,
} from "./runtime";

export type DeclarativeWalletDestination = {
  scriptPubKey: string;
  blindingPublicKey: string;
};

export type DeclarativePreparationSnapshot = {
  network: "liquid" | "liquid-testnet" | "elements-regtest";
  genesisHash: string;
  tipHeight: number;
  policyAssetId: string;
  chain: DeclarativeChainSnapshot;
  walletCandidates: readonly AcceptOfferWalletCandidate[];
  walletDestination?: DeclarativeWalletDestination;
  feePolicy: TxManifestFeePolicy;
};

export type DeclarativeReviewedInput = {
  index: number;
  roleId: string;
  source: "provided" | "wallet";
  authorization: "covenant" | "wallet";
  txid: string;
  vout: number;
  assetId: string;
  amount: string;
  scriptPubKey: string;
  confidential: boolean;
  sequence: number;
  confirmed: boolean | null;
};

export type DeclarativeReviewedOutput = {
  index: number;
  role: "script" | "covenant" | "wallet" | "change" | "record" | "txmf";
  assetId: string;
  amount: string;
  scriptPubKey: string;
  confidential: boolean;
  walletOwned: boolean;
};

export type PreparedDeclarativeExecution = {
  pset: string;
  planDigest: `sha256:${string}`;
  feeSelectionTarget: string;
  parentTransactions: string[];
  covenants: TxManifestCovenantDryRunSpec[];
  review: {
    feeAssetId: string;
    fee: string;
    feeOutputIndex: number;
    feeChange: string;
    inputs: DeclarativeReviewedInput[];
    outputs: DeclarativeReviewedOutput[];
    locktime: number;
    rbf: boolean;
    signingMode: "wallet" | "none";
    walletBalanceChanges: Record<string, string>;
  };
};

export type DeclarativePreparationRuntime = {
  compileCovenant(spec: {
    source: string;
    arguments: Record<string, { type: string; value: string }>;
    extra_leaf_payloads: string[];
    network: DeclarativePreparationSnapshot["network"];
    include_debug_symbols: boolean;
  }): Promise<TxManifestCovenantCommitments>;
  buildPset(spec: TxManifestPsetBuildSpec): Promise<string>;
  finalizeCovenant(spec: TxManifestCovenantFinalizeSpec): Promise<string>;
  estimateFee(spec: { pset: string; feeRateSatPerKvb: string }): Promise<TxManifestFeeEstimate>;
};

/** Construct and covenant-finalize a compatible declarative action. */
export async function prepareDeclarativeExecution(
  plan: DeclarativeRequirementPlan,
  snapshot: DeclarativePreparationSnapshot,
  runtime: DeclarativePreparationRuntime,
  reviewedFee?: { actualFee: string; selectionFee: string },
): Promise<PreparedDeclarativeExecution> {
  validateSnapshot(plan, snapshot);
  const cachedRuntime = withCompilationCache(runtime);
  const signingMode = plan.recipe.inputs.some(
    (input) => input.kind === "wallet" || input.authorization === "wallet",
  ) ? "wallet" : "none";
  const policy: TxManifestFeePolicy = {
    ...snapshot.feePolicy,
    ...(reviewedFee === undefined
      ? {}
      : {
          exactFee: reviewedFee.actualFee,
          exactSelectionFee: reviewedFee.selectionFee,
        }),
  };

  if (plan.recipe.fee.mode === "fixed") {
    const seed = await resolveInputs(plan, snapshot, "0");
    const context = createDeclarativeEvaluationContext(plan.recipe, plan.arguments, seed.resolved);
    const expansion = await evaluateDeclarativeOutputExpansion(plan.recipe, context);
    const fee = await evaluateDeclarativeFee(plan.recipe.fee, context, expansion.nonFeeOutputCount);
    if (fee.mode !== "fixed") throw new Error("Declarative fixed-fee mode changed during evaluation.");
    requireFeeWithinPolicy(fee.amount, policy.maxFee, "fixed fee");
    if (reviewedFee && (reviewedFee.actualFee !== fee.amount || reviewedFee.selectionFee !== fee.amount)) {
      throw new Error("The fixed declarative fee does not match the reviewed fee.");
    }
    return buildCandidate(plan, snapshot, cachedRuntime, fee.amount, signingMode);
  }

  return convergeTxManifestFee(
    policy,
    (selectionFee) => buildCandidate(plan, snapshot, cachedRuntime, selectionFee, signingMode),
    runtime.estimateFee,
  );
}

function withCompilationCache(
  runtime: DeclarativePreparationRuntime,
): DeclarativePreparationRuntime {
  const compiled = new Map<string, ReturnType<DeclarativePreparationRuntime["compileCovenant"]>>();
  return {
    ...runtime,
    compileCovenant(spec) {
      // Every key is constructed here with a fixed field order; evaluated
      // argument maps are already sorted, so this is a canonical local cache
      // key rather than publisher-controlled formatting.
      const key = JSON.stringify(spec);
      const cached = compiled.get(key);
      if (cached) return cached;
      const pending = runtime.compileCovenant(spec);
      compiled.set(key, pending);
      void pending.catch(() => {
        if (compiled.get(key) === pending) compiled.delete(key);
      });
      return pending;
    },
  };
}

async function buildCandidate(
  plan: DeclarativeRequirementPlan,
  snapshot: DeclarativePreparationSnapshot,
  runtime: DeclarativePreparationRuntime,
  selectionFee: string,
  signingMode: "wallet" | "none",
): Promise<PreparedDeclarativeExecution> {
  const selected = await resolveInputs(plan, snapshot, selectionFee);
  const context = createDeclarativeEvaluationContext(
    plan.recipe,
    plan.arguments,
    selected.resolved,
  );
  const locktime = plan.recipe.locktime === undefined
    ? 0
    : Number(await uintExpression(plan.recipe.locktime, "u32", context, "locktime"));
  const expansion = await evaluateDeclarativeOutputExpansion(plan.recipe, context);
  const evaluatedFee = await evaluateDeclarativeFee(
    plan.recipe.fee,
    context,
    expansion.nonFeeOutputCount,
  );
  if (evaluatedFee.assetId !== snapshot.policyAssetId) {
    throw new Error("Declarative v1 fees must use the connected network policy asset.");
  }
  if (evaluatedFee.mode === "estimate") {
    requireFeeWithinPolicy(selectionFee, evaluatedFee.maxAmount, "recipe fee cap");
    requireFeeWithinPolicy(selectionFee, snapshot.feePolicy.maxFee, "manifest fee cap");
  } else if (selectionFee !== evaluatedFee.amount) {
    throw new Error("The fixed declarative fee changed during preparation.");
  }

  const compiledByInput = new Map<number, {
    spec: Omit<TxManifestCovenantDryRunSpec, "transaction_hex" | "parent_transactions">;
    finalize: Omit<TxManifestCovenantFinalizeSpec, "pset">;
  }>();
  const rawOutputs: Array<{
    output: TxManifestPsetBuildSpec["outputs"][number];
    review: Omit<DeclarativeReviewedOutput, "index">;
    kind: "fixed" | "change";
    minimum?: bigint;
  }> = [];

  for (let recipeIndex = 0; recipeIndex < plan.recipe.outputs.length; recipeIndex += 1) {
    const output = plan.recipe.outputs[recipeIndex];
    if (output.kind === "fragmented_record") {
      const evaluated = expansion.fragmentedRecords.get(recipeIndex);
      if (!evaluated) throw new Error("Missing evaluated fragmented record.");
      for (const fragment of evaluated.fragments) {
        const scriptPubKey = opReturn(fragment);
        rawOutputs.push({
          kind: "fixed",
          output: { script_pub_key: scriptPubKey, asset: evaluated.assetId, amount: "0" },
          review: {
            role: "record",
            assetId: evaluated.assetId,
            amount: "0",
            scriptPubKey,
            confidential: false,
            walletOwned: false,
          },
        });
      }
      continue;
    }
    if (output.kind === "txmf") {
      const assetId = await assetExpression(output.asset, context, "TXMF asset");
      const scriptPubKey = await txManifestActionHintScript(plan.bundleHash, plan.action);
      rawOutputs.push({
        kind: "fixed",
        output: { script_pub_key: scriptPubKey, asset: assetId, amount: "0" },
        review: {
          role: "txmf",
          assetId,
          amount: "0",
          scriptPubKey,
          confidential: false,
          walletOwned: false,
        },
      });
      continue;
    }
    if (output.kind === "change") {
      const assetId = await assetExpression(output.asset, context, "change asset");
      const destination = requireWalletDestination(snapshot);
      const minimum = output.minimum === undefined
        ? 0n
        : await uintExpression(output.minimum, "u64", context, "change minimum");
      rawOutputs.push({
        kind: "change",
        minimum,
        output: {
          script_pub_key: destination.scriptPubKey,
          asset: assetId,
          amount: "0",
          ...(output.confidential
            ? confidentialOutput(destination, selected.psetInputs)
            : {}),
        },
        review: {
          role: "change",
          assetId,
          amount: "0",
          scriptPubKey: destination.scriptPubKey,
          confidential: output.confidential,
          walletOwned: true,
        },
      });
      continue;
    }

    const assetId = await assetExpression(output.asset, context, `${output.kind} output asset`);
    const amount = (await uintExpression(output.amount, "u64", context, `${output.kind} output amount`)).toString();
    if (output.kind === "script") {
      const scriptPubKey = await bytesExpression(output.script, "script", context, "output script");
      if (scriptPubKey.length === 0) throw new Error("Declarative non-fee scripts must not be empty.");
      rawOutputs.push({
        kind: "fixed",
        output: { script_pub_key: scriptPubKey, asset: assetId, amount },
        review: {
          role: "script",
          assetId,
          amount,
          scriptPubKey,
          confidential: false,
          walletOwned: false,
        },
      });
      continue;
    }
    if (output.kind === "wallet") {
      const destination = requireWalletDestination(snapshot);
      rawOutputs.push({
        kind: "fixed",
        output: {
          script_pub_key: destination.scriptPubKey,
          asset: assetId,
          amount,
          ...(output.confidential
            ? confidentialOutput(destination, selected.psetInputs)
            : {}),
        },
        review: {
          role: "wallet",
          assetId,
          amount,
          scriptPubKey: destination.scriptPubKey,
          confidential: output.confidential,
          walletOwned: true,
        },
      });
      continue;
    }

    const arguments_ = await evaluateArgumentMap(output.arguments, context);
    const extraLeafPayloads = await evaluateBytesList(
      output.extra_leaf_payloads,
      context,
      "covenant output extra leaf",
    );
    const commitments = await runtime.compileCovenant({
      source: source(plan, output.source),
      arguments: arguments_,
      extra_leaf_payloads: extraLeafPayloads,
      network: snapshot.network,
      include_debug_symbols: plan.bundle.compiler.debugSymbols,
    });
    rawOutputs.push({
      kind: "fixed",
      output: { script_pub_key: commitments.script_pub_key, asset: assetId, amount },
      review: {
        role: "covenant",
        assetId,
        amount,
        scriptPubKey: commitments.script_pub_key,
        confidential: false,
        walletOwned: false,
      },
    });
  }

  for (const covenant of plan.recipe.covenant_witnesses) {
    const inputIndex = plan.recipe.inputs.findIndex((input) => input.id === covenant.input);
    if (inputIndex < 0) throw new Error(`Unknown covenant input ${covenant.input}.`);
    const arguments_ = await evaluateArgumentMap(covenant.arguments, context);
    const extraLeafPayloads = await evaluateBytesList(
      covenant.extra_leaf_payloads,
      context,
      `covenant input ${covenant.input} extra leaf`,
    );
    const witnesses = await evaluateDeclarativeCovenantWitnesses(covenant, context);
    const commitments = await runtime.compileCovenant({
      source: source(plan, covenant.source),
      arguments: arguments_,
      extra_leaf_payloads: extraLeafPayloads,
      network: snapshot.network,
      include_debug_symbols: plan.bundle.compiler.debugSymbols,
    });
    const actualScript = selected.psetInputs[inputIndex]?.scriptPubKey;
    if (actualScript !== commitments.script_pub_key) {
      throw new Error(`Provided covenant input ${covenant.input} does not match its compiled recipe.`);
    }
    const common = {
      source: source(plan, covenant.source),
      arguments: arguments_,
      extra_leaf_payloads: extraLeafPayloads,
      witnesses,
      input_index: inputIndex,
      genesis_hash: snapshot.genesisHash,
      include_debug_symbols: plan.bundle.compiler.debugSymbols,
    };
    compiledByInput.set(inputIndex, {
      finalize: common,
      spec: common,
    });
  }

  const inputTotals = totals(selected.psetInputs.map((input) => ({
    assetId: input.assetId,
    amount: input.amount,
  })));
  const fixedTotals = totals(rawOutputs.filter((entry) => entry.kind === "fixed").map((entry) => ({
    assetId: entry.review.assetId,
    amount: entry.review.amount,
  })));
  const changeByAsset = new Map<string, typeof rawOutputs[number]>();
  for (const entry of rawOutputs) {
    if (entry.kind !== "change") continue;
    if (changeByAsset.has(entry.review.assetId)) {
      throw new Error(`Declarative v1 allows at most one change output per asset.`);
    }
    changeByAsset.set(entry.review.assetId, entry);
  }

  let actualFee = BigInt(selectionFee);
  const remainderByAsset = new Map<string, bigint>();
  for (const [assetId, inputAmount] of inputTotals) {
    const fee = assetId === evaluatedFee.assetId ? actualFee : 0n;
    const remainder = inputAmount - (fixedTotals.get(assetId) ?? 0n) - fee;
    if (remainder < 0n) throw new Error(`Declarative outputs exceed inputs for asset ${assetId}.`);
    remainderByAsset.set(assetId, remainder);
  }
  for (const [assetId, amount] of fixedTotals) {
    if (!inputTotals.has(assetId) && amount !== 0n) {
      throw new Error(`Declarative outputs create unsupported asset ${assetId}.`);
    }
  }

  const emittedOutputs: typeof rawOutputs = [];
  for (const entry of rawOutputs) {
    if (entry.kind === "fixed") {
      emittedOutputs.push(entry);
      continue;
    }
    const remainder = remainderByAsset.get(entry.review.assetId) ?? 0n;
    remainderByAsset.set(entry.review.assetId, 0n);
    if (remainder === 0n) continue;
    if (remainder < (entry.minimum ?? 0n)) {
      if (entry.review.assetId !== evaluatedFee.assetId || evaluatedFee.mode !== "estimate") {
        throw new Error("Declarative change is below its required minimum.");
      }
      actualFee += remainder;
      continue;
    }
    entry.output.amount = remainder.toString();
    entry.review.amount = remainder.toString();
    emittedOutputs.push(entry);
  }
  for (const [assetId, remainder] of remainderByAsset) {
    if (remainder !== 0n) throw new Error(`Declarative recipe leaves unassigned ${assetId} value.`);
  }
  requireFeeWithinPolicy(actualFee.toString(), snapshot.feePolicy.maxFee, "manifest fee cap");
  if (evaluatedFee.mode === "estimate") {
    requireFeeWithinPolicy(actualFee.toString(), evaluatedFee.maxAmount, "recipe fee cap");
  }

  const feeOutputIndex = plan.recipe.fee.output_index ?? emittedOutputs.length;
  if (feeOutputIndex > emittedOutputs.length) {
    throw new Error("Declarative fee output index exceeds the constructed output count.");
  }
  const buildSpec: TxManifestPsetBuildSpec = {
    inputs: selected.psetInputs.map(({ scriptPubKey: _script, assetId: _assetId, ...input }) => input),
    outputs: emittedOutputs.map((entry) => entry.output),
    fee: {
      asset: evaluatedFee.assetId,
      amount: actualFee.toString(),
      output_index: feeOutputIndex,
    },
    ...(locktime === 0 ? {} : { locktime }),
  };
  let pset = await runtime.buildPset(buildSpec);
  for (const [inputIndex, covenant] of [...compiledByInput].sort(([a], [b]) => a - b)) {
    pset = await runtime.finalizeCovenant({ pset, ...covenant.finalize });
    if (inputIndex !== covenant.finalize.input_index) {
      throw new Error("Declarative covenant finalization index changed.");
    }
  }

  const reviewOutputs: DeclarativeReviewedOutput[] = [];
  let emittedIndex = 0;
  for (let finalIndex = 0; finalIndex < emittedOutputs.length + 1; finalIndex += 1) {
    if (finalIndex === feeOutputIndex) continue;
    const entry = emittedOutputs[emittedIndex++];
    reviewOutputs.push({ index: finalIndex, ...entry.review });
  }
  const reviewInputs: DeclarativeReviewedInput[] = selected.resolved.map((input, index) => {
    const role = plan.recipe.inputs[index];
    const chainInput = snapshot.chain.inputs.find((candidate) =>
      candidate.txid === input.txid && candidate.vout === input.vout
    );
    return {
      index,
      roleId: role.id,
      source: input.source,
      authorization: role.kind === "wallet" ? "wallet" : role.authorization,
      txid: input.txid,
      vout: input.vout,
      assetId: input.asset_id,
      amount: String(input.amount),
      scriptPubKey: input.script_pub_key,
      confidential:
        selected.psetInputs[index].asset_blinding_factor !== undefined &&
        selected.psetInputs[index].value_blinding_factor !== undefined,
      sequence: selected.psetInputs[index].sequence ?? 0xffff_ffff,
      confirmed: chainInput?.confirmed ?? null,
    };
  });
  const walletBalanceChanges = walletEffects(reviewInputs, reviewOutputs);
  const feeChange = reviewOutputs
    .filter((output) => output.role === "change" && output.assetId === evaluatedFee.assetId)
    .reduce((total, output) => total + BigInt(output.amount), 0n);
  const authorization = {
    version: "apogee-declarative-plan/v1",
    requirementDigest: plan.requirementDigest,
    inputs: buildSpec.inputs.map(({ asset_blinding_factor: _abf, value_blinding_factor: _vbf, ...input }) => input),
    outputs: buildSpec.outputs,
    fee: buildSpec.fee,
    locktime,
    signingMode,
    covenantScripts: [...compiledByInput].map(([index]) => ({
      index,
      scriptPubKey: selected.psetInputs[index].scriptPubKey,
    })),
  };
  return {
    pset,
    planDigest: await taggedCanonicalJsonHash("apogee/declarative-plan/v1", authorization),
    feeSelectionTarget: selectionFee,
    parentTransactions: [...new Set([
      ...snapshot.chain.parentTransactions,
      ...selected.walletParents,
    ])],
    covenants: [...compiledByInput.values()].map(({ spec }) => ({
      ...spec,
      transaction_hex: "",
      parent_transactions: [],
    })),
    review: {
      feeAssetId: evaluatedFee.assetId,
      fee: actualFee.toString(),
      feeOutputIndex,
      feeChange: feeChange.toString(),
      inputs: reviewInputs,
      outputs: reviewOutputs,
      locktime,
      rbf: reviewInputs.some((input) => input.sequence < 0xffff_fffe),
      signingMode,
      walletBalanceChanges,
    },
  };
}

async function resolveInputs(
  plan: DeclarativeRequirementPlan,
  snapshot: DeclarativePreparationSnapshot,
  selectionFee: string,
): Promise<{
  resolved: DeclarativeResolvedInput[];
  psetInputs: Array<TxManifestPsetBuildSpec["inputs"][number] & { scriptPubKey: string; assetId: string }>;
  walletParents: string[];
}> {
  const resolved: DeclarativeResolvedInput[] = [];
  const psetInputs: Array<TxManifestPsetBuildSpec["inputs"][number] & { scriptPubKey: string; assetId: string }> = [];
  const walletParents: string[] = [];
  const excluded = new Set<string>();
  let feeAssigned = false;

  for (let index = 0; index < plan.recipe.inputs.length; index += 1) {
    const role = plan.recipe.inputs[index];
    if (role.kind === "provided") {
      const planned = plan.providedInputs.find((input) => input.roleId === role.id);
      const chainInput = planned && snapshot.chain.inputs.find((input) =>
        input.id === role.id && input.txid === planned.outpoint.txid && input.vout === planned.outpoint.vout
      );
      if (!planned || !chainInput) throw new Error(`Missing verified provided input ${role.id}.`);
      const wallet = role.authorization === "wallet"
        ? snapshot.walletCandidates.find((candidate) => sameOutpoint(candidate, chainInput))
        : undefined;
      if (role.authorization === "wallet") {
        if (!wallet) throw new Error(`Provided input ${role.id} is not owned by the connected wallet.`);
        requireWalletChainAgreement(wallet, chainInput, role.id);
        walletParents.push(wallet.parentTransaction);
      }
      const sequence = role.sequence === undefined
        ? undefined
        : Number(await uintExpression(
            role.sequence,
            "u32",
            createDeclarativePartialEvaluationContext(plan.recipe, plan.arguments, resolved),
            `${role.id} sequence`,
          ));
      resolved.push({
        id: role.id,
        source: "provided",
        txid: chainInput.txid,
        vout: chainInput.vout,
        asset_id: chainInput.assetId,
        amount: chainInput.amount,
        script_pub_key: chainInput.scriptPubKey,
        tx_out: chainInput.txOut,
      });
      await assertDeclarativeProvidedInputMatches(
        role,
        createDeclarativePartialEvaluationContext(plan.recipe, plan.arguments, resolved),
      );
      psetInputs.push({
        txid: chainInput.txid,
        vout: chainInput.vout,
        tx_out: chainInput.txOut,
        asset: chainInput.assetId,
        assetId: chainInput.assetId,
        amount: chainInput.amount,
        scriptPubKey: chainInput.scriptPubKey,
        ...(wallet?.assetBlindingFactor
          ? { asset_blinding_factor: wallet.assetBlindingFactor }
          : {}),
        ...(wallet?.valueBlindingFactor
          ? { value_blinding_factor: wallet.valueBlindingFactor }
          : {}),
        ...(sequence === undefined ? {} : { sequence }),
      });
      excluded.add(outpointKey(chainInput));
      continue;
    }

    const partial = createDeclarativePartialEvaluationContext(plan.recipe, plan.arguments, resolved);
    const requirement = await evaluateDeclarativeWalletRequirement(role, partial);
    let target = BigInt(requirement.amount);
    const feeAssetId = await assetExpression(plan.recipe.fee.asset, partial, "fee asset");
    if (
      !feeAssigned &&
      requirement.assetId === feeAssetId &&
      requirement.amountMode === "minimum"
    ) {
      target += BigInt(selectionFee);
      feeAssigned = true;
    }
    const candidate = selectOneWalletInput(
      snapshot.walletCandidates,
      requirement.assetId,
      target,
      requirement.amountMode,
      requirement.scriptType,
      excluded,
      role.id,
    );
    const sequence = role.sequence === undefined
      ? undefined
      : Number(await uintExpression(role.sequence, "u32", partial, `${role.id} sequence`));
    resolved.push({
      id: role.id,
      source: "wallet",
      txid: candidate.txid,
      vout: candidate.vout,
      asset_id: candidate.assetId,
      amount: candidate.amount,
      script_pub_key: candidate.scriptPubKey,
      tx_out: candidate.txOut,
    });
    psetInputs.push({
      txid: candidate.txid,
      vout: candidate.vout,
      tx_out: candidate.txOut,
      asset: candidate.assetId,
      assetId: candidate.assetId,
      amount: candidate.amount,
      scriptPubKey: candidate.scriptPubKey,
      ...(candidate.assetBlindingFactor
        ? { asset_blinding_factor: candidate.assetBlindingFactor }
        : {}),
      ...(candidate.valueBlindingFactor
        ? { value_blinding_factor: candidate.valueBlindingFactor }
        : {}),
      ...(sequence === undefined ? {} : { sequence }),
    });
    excluded.add(outpointKey(candidate));
    walletParents.push(candidate.parentTransaction);
  }
  return { resolved, psetInputs, walletParents };
}

function selectOneWalletInput(
  candidates: readonly AcceptOfferWalletCandidate[],
  assetId: string,
  target: bigint,
  mode: "exact" | "minimum",
  scriptType: "p2wpkh" | undefined,
  excluded: ReadonlySet<string>,
  label: string,
): AcceptOfferWalletCandidate {
  const eligible = candidates.filter((candidate) =>
    candidate.assetId === assetId &&
    !excluded.has(outpointKey(candidate)) &&
    (mode === "exact" ? BigInt(candidate.amount) === target : BigInt(candidate.amount) >= target) &&
    (scriptType !== "p2wpkh" || /^0014[0-9a-f]{40}$/.test(candidate.scriptPubKey))
  ).sort((a, b) => {
    const amount = BigInt(a.amount) - BigInt(b.amount);
    if (amount !== 0n) return amount < 0n ? -1 : 1;
    const txid = a.txid.localeCompare(b.txid);
    return txid !== 0 ? txid : a.vout - b.vout;
  });
  const selected = eligible[0];
  if (!selected) {
    throw new Error(`The connected wallet has no single ${label} input satisfying the declarative role.`);
  }
  return selected;
}

async function evaluateArgumentMap(
  values: Readonly<Record<string, DeclarativeTypedExpression>>,
  context: DeclarativeEvaluationContext,
): Promise<Record<string, { type: string; value: string }>> {
  const out: Record<string, { type: string; value: string }> = {};
  for (const name of Object.keys(values).sort()) {
    const expression = values[name];
    const value = await evaluateDeclarativeTypedExpression(expression, context);
    if (value.kind === "uint") {
      out[name] = { type: expression.type, value: value.value.toString() };
    } else {
      const hex = declarativeBytesHex(value);
      if (expression.type === "bytes32" || expression.type === "asset_id") {
        out[name] = { type: "u256", value: `0x${hex}` };
      } else {
        throw new Error(`Covenant argument ${name} uses unsupported variable bytes.`);
      }
    }
  }
  return out;
}

async function evaluateBytesList(
  values: readonly Parameters<typeof evaluateDeclarativeExpression>[0][],
  context: DeclarativeEvaluationContext,
  label: string,
): Promise<string[]> {
  return Promise.all(values.map(async (value, index) =>
    rawBytesValue(await evaluateDeclarativeExpression(value, context), `${label} ${index}`)
  ));
}

async function assetExpression(
  expression: Parameters<typeof evaluateDeclarativeExpression>[0],
  context: DeclarativeEvaluationContext,
  label: string,
): Promise<string> {
  return bytesExpression(expression, "asset_id", context, label);
}

async function bytesExpression(
  expression: Parameters<typeof evaluateDeclarativeExpression>[0],
  type: "asset_id" | "script",
  context: DeclarativeEvaluationContext,
  label: string,
): Promise<string> {
  const value = await evaluateDeclarativeTypedExpression({ type, value: expression }, context);
  return bytesValue(value, label);
}

async function uintExpression(
  expression: Parameters<typeof evaluateDeclarativeExpression>[0],
  type: "u32" | "u64",
  context: DeclarativeEvaluationContext,
  label: string,
): Promise<bigint> {
  const value = await evaluateDeclarativeTypedExpression({ type, value: expression }, context);
  if (value.kind !== "uint") throw new Error(`${label} did not evaluate to an integer.`);
  return value.value;
}

function bytesValue(value: Awaited<ReturnType<typeof evaluateDeclarativeTypedExpression>>, label: string): string {
  if (value.kind !== "bytes") throw new Error(`${label} did not evaluate to bytes.`);
  return declarativeBytesHex(value);
}

function rawBytesValue(value: Awaited<ReturnType<typeof evaluateDeclarativeExpression>>, label: string): string {
  if (value.kind !== "bytes") throw new Error(`${label} did not evaluate to bytes.`);
  return declarativeBytesHex(value);
}

function confidentialOutput(
  destination: DeclarativeWalletDestination,
  inputs: ReadonlyArray<{ asset_blinding_factor?: string; value_blinding_factor?: string }>,
): { blinding_public_key: string; blinder_index: number } {
  const blinderIndex = inputs.findIndex(
    (input) => input.asset_blinding_factor !== undefined && input.value_blinding_factor !== undefined,
  );
  if (blinderIndex < 0) throw new Error("A confidential declarative output requires a blinding input.");
  return {
    blinding_public_key: destination.blindingPublicKey,
    blinder_index: blinderIndex,
  };
}

function walletEffects(
  inputs: readonly DeclarativeReviewedInput[],
  outputs: readonly DeclarativeReviewedOutput[],
): Record<string, string> {
  const changes = new Map<string, bigint>();
  for (const input of inputs) {
    if (input.authorization !== "wallet") continue;
    changes.set(input.assetId, (changes.get(input.assetId) ?? 0n) - BigInt(input.amount));
  }
  for (const output of outputs) {
    if (!output.walletOwned) continue;
    changes.set(output.assetId, (changes.get(output.assetId) ?? 0n) + BigInt(output.amount));
  }
  // Fees are already reflected in wallet input/output deltas when the wallet
  // funds them. A keyless action spends only external covenant value, so it
  // must not invent a wallet balance effect for that fee.
  return Object.fromEntries(
    [...changes].sort(([a], [b]) => a.localeCompare(b)).map(([asset, amount]) => [asset, amount.toString()]),
  );
}

function totals(values: readonly { assetId: string; amount: string }[]): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const value of values) {
    out.set(value.assetId, (out.get(value.assetId) ?? 0n) + BigInt(value.amount));
  }
  return out;
}

function source(plan: DeclarativeRequirementPlan, path: string): string {
  const value = plan.bundle.sources[path];
  if (value === undefined) throw new Error(`Declarative source ${path} is missing from the bundle.`);
  return value;
}

function requireWalletDestination(snapshot: DeclarativePreparationSnapshot): DeclarativeWalletDestination {
  if (!snapshot.walletDestination) throw new Error("This declarative action requires a wallet destination.");
  return snapshot.walletDestination;
}

function requireWalletChainAgreement(
  wallet: AcceptOfferWalletCandidate,
  chain: { txOut: string; scriptPubKey: string; assetId: string; amount: string },
  label: string,
): void {
  if (
    wallet.txOut !== chain.txOut ||
    wallet.scriptPubKey !== chain.scriptPubKey ||
    wallet.assetId !== chain.assetId ||
    wallet.amount !== chain.amount
  ) {
    throw new Error(`Wallet and chain state disagree about provided input ${label}.`);
  }
}

function validateSnapshot(plan: DeclarativeRequirementPlan, snapshot: DeclarativePreparationSnapshot): void {
  if (snapshot.genesisHash !== snapshot.chain.genesisHash) {
    throw new Error("Declarative chain evidence has the wrong genesis hash.");
  }
  if (snapshot.policyAssetId.length !== 64) throw new Error("Wallet policy asset id is invalid.");
  if (plan.constraints.validUntilHeight !== undefined && snapshot.tipHeight > plan.constraints.validUntilHeight) {
    throw new Error("The declarative TX Manifest request expired before preparation.");
  }
}

function requireFeeWithinPolicy(value: string, maximum: string, label: string): void {
  const fee = BigInt(value);
  if (fee <= 0n || fee > BigInt(maximum)) throw new Error(`The ${label} is exceeded.`);
}

function opReturn(payload: Uint8Array): string {
  if (payload.length > 80) throw new Error("Declarative record fragment exceeds 80 bytes.");
  const prefix = payload.length <= 0x4b
    ? Uint8Array.of(0x6a, payload.length)
    : Uint8Array.of(0x6a, 0x4c, payload.length);
  const script = new Uint8Array(prefix.length + payload.length);
  script.set(prefix);
  script.set(payload, prefix.length);
  return [...script].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameOutpoint(
  left: { txid: string; vout: number },
  right: { txid: string; vout: number },
): boolean {
  return left.txid === right.txid && left.vout === right.vout;
}

function outpointKey(value: { txid: string; vout: number }): string {
  return `${value.txid}:${value.vout}`;
}
