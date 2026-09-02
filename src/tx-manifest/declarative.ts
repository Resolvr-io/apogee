import {
  canonicalTxManifestSourcePath,
  type TxManifestBundle,
} from "./bundle";

/** A closed, data-only transaction recipe understood by Apogee itself. */
export const APOGEE_DECLARATIVE_TRANSACTION_EXTENSION =
  "apogee-declarative-transaction/v1" as const;
export const APOGEE_DECLARATIVE_MANIFEST_FIELD = "x_apogee_declarative" as const;
export const APOGEE_DECLARATIVE_MANIFEST_VERSION = 1 as const;

/** Hard limits apply before wallet or network state is consulted. */
export const DECLARATIVE_LIMITS = Object.freeze({
  chains: 16,
  actions: 32,
  argumentsPerAction: 32,
  inputsPerAction: 32,
  outputsPerAction: 64,
  expandedOutputsPerAction: 128,
  covenantWitnessesPerAction: 32,
  typedValuesPerMap: 64,
  extraLeafPayloads: 32,
  expressionNodesPerAction: 512,
  expressionDepth: 16,
  expressionListItems: 32,
  simplicityValueNodesPerAction: 256,
  simplicityValueDepth: 16,
  simplicityValueTextBytes: 131_072,
  literalBytesPerExpression: 4_096,
  literalBytesPerAction: 65_536,
  evaluatedBytes: 65_536,
  fragmentedRecordBytes: 16_384,
  fragmentBytes: 80,
  sourceFiles: 32,
  sourceBytesPerFile: 262_144,
  sourceBytesTotal: 1_048_576,
  compilationSourceBytesPerAction: 4_194_304,
  sourcePathLength: 256,
  nameLength: 128,
  scriptBytes: 10_000,
  transactionOutputBytes: 1_048_576,
});

export type DeclarativeArgumentType =
  | "u16"
  | "u32"
  | "u64"
  | "bytes"
  | "bytes32"
  | "asset_id"
  | "script";

export type DeclarativeInputField =
  | "index"
  | "txid"
  | "vout"
  | "asset_id"
  | "amount"
  | "script_pub_key"
  | "tx_out";

export type DeclarativeExpression =
  | { op: "arg"; name: string }
  | { op: "input"; input: string; field: DeclarativeInputField }
  | { op: "bytes"; value: string }
  | { op: "uint"; value: string }
  | { op: "add"; left: DeclarativeExpression; right: DeclarativeExpression }
  | { op: "concat"; values: readonly DeclarativeExpression[] }
  | { op: "sha256"; value: DeclarativeExpression }
  | {
      op: "tagged_sha256";
      tag: DeclarativeExpression;
      value: DeclarativeExpression;
    }
  | { op: "reverse"; value: DeclarativeExpression }
  | {
      op: "encode_uint";
      value: DeclarativeExpression;
      width: 1 | 2 | 4 | 8 | 16 | 32;
      endian: "big" | "little";
    }
  | {
      op: "slice";
      value: DeclarativeExpression;
      start: number;
      length: number;
    }
  | {
      op: "length_prefix";
      value: DeclarativeExpression;
      width: 1 | 2 | 4 | 8;
      endian: "big" | "little";
    };

export type DeclarativeTypedExpression = {
  type: DeclarativeArgumentType;
  value: DeclarativeExpression;
};

/** Closed structural representation of a Simplicity sum/product witness value. */
export type DeclarativeSimplicityValue =
  | { kind: "unit" }
  | { kind: "left"; value: DeclarativeSimplicityValue }
  | { kind: "right"; value: DeclarativeSimplicityValue }
  | {
      kind: "tuple";
      values: readonly [DeclarativeSimplicityValue, DeclarativeSimplicityValue];
    }
  | {
      kind: "leaf";
      type: DeclarativeArgumentType;
      value: DeclarativeExpression;
    };

export type DeclarativeProvidedInputRole = {
  kind: "provided";
  id: string;
  provided_input: string;
  authorization: "covenant" | "wallet";
  expect: {
    asset: DeclarativeExpression;
    amount: DeclarativeExpression;
    script_pub_key?: DeclarativeExpression;
  };
  sequence?: DeclarativeExpression;
};

export type DeclarativeWalletInputRole = {
  kind: "wallet";
  id: string;
  asset: DeclarativeExpression;
  amount: DeclarativeExpression;
  amount_mode: "exact" | "minimum";
  script_type?: "p2wpkh";
  sequence?: DeclarativeExpression;
};

export type DeclarativeInputRole =
  | DeclarativeProvidedInputRole
  | DeclarativeWalletInputRole;

export type DeclarativeScriptOutput = {
  kind: "script";
  asset: DeclarativeExpression;
  amount: DeclarativeExpression;
  script: DeclarativeExpression;
  confidential: false;
};

export type DeclarativeCovenantOutput = {
  kind: "covenant";
  source: string;
  arguments: Readonly<Record<string, DeclarativeTypedExpression>>;
  extra_leaf_payloads: readonly DeclarativeExpression[];
  asset: DeclarativeExpression;
  amount: DeclarativeExpression;
  confidential: false;
};

export type DeclarativeWalletOutput = {
  kind: "wallet";
  asset: DeclarativeExpression;
  amount: DeclarativeExpression;
  confidential: boolean;
};

export type DeclarativeChangeOutput = {
  kind: "change";
  asset: DeclarativeExpression;
  confidential: boolean;
  minimum?: DeclarativeExpression;
};

export type DeclarativeFragmentedRecordOutput = {
  kind: "fragmented_record";
  asset: DeclarativeExpression;
  record: DeclarativeExpression;
  fragment_bytes: number;
};

export type DeclarativeTxmfOutput = {
  kind: "txmf";
  asset: DeclarativeExpression;
};

export type DeclarativeOutputRecipe =
  | DeclarativeScriptOutput
  | DeclarativeCovenantOutput
  | DeclarativeWalletOutput
  | DeclarativeChangeOutput
  | DeclarativeFragmentedRecordOutput
  | DeclarativeTxmfOutput;

export type DeclarativeFeeRecipe =
  | {
      mode: "fixed";
      asset: DeclarativeExpression;
      amount: DeclarativeExpression;
      output_index?: number;
    }
  | {
      mode: "estimate";
      asset: DeclarativeExpression;
      max_amount: DeclarativeExpression;
      output_index?: number;
    };

export type DeclarativeCovenantWitnessRecipe = {
  input: string;
  source: string;
  arguments: Readonly<Record<string, DeclarativeTypedExpression>>;
  extra_leaf_payloads: readonly DeclarativeExpression[];
  witnesses: Readonly<Record<string, DeclarativeSimplicityValue>>;
};

export type DeclarativeActionRecipe = {
  arguments: Readonly<Record<string, DeclarativeArgumentType>>;
  inputs: readonly DeclarativeInputRole[];
  outputs: readonly DeclarativeOutputRecipe[];
  fee: DeclarativeFeeRecipe;
  covenant_witnesses: readonly DeclarativeCovenantWitnessRecipe[];
  locktime?: DeclarativeExpression;
};

export type DeclarativeManifest = {
  version: typeof APOGEE_DECLARATIVE_MANIFEST_VERSION;
  chains: readonly string[];
  actions: Readonly<Record<string, DeclarativeActionRecipe>>;
};

export type DeclarativeUnsignedValue =
  | { kind: "uint"; value: bigint }
  | { kind: "bytes"; value: Uint8Array };

export type DeclarativeTypedValue =
  | {
      type: "u16" | "u32" | "u64";
      kind: "uint";
      value: bigint;
    }
  | {
      type: "bytes" | "bytes32" | "asset_id" | "script";
      kind: "bytes";
      value: Uint8Array;
    };

export interface DeclarativeResolvedInput {
  id: string;
  source: "provided" | "wallet";
  txid: string;
  vout: number;
  asset_id: string;
  amount: string | number | bigint;
  script_pub_key: string;
  tx_out?: string;
}

type NormalizedDeclarativeInput = {
  index: number;
  id: string;
  source: "provided" | "wallet";
  txid: Uint8Array;
  vout: bigint;
  assetId: Uint8Array;
  amount: bigint;
  scriptPubKey: Uint8Array;
  txOut?: Uint8Array;
};

export type DeclarativeEvaluationContext = {
  arguments: ReadonlyMap<string, DeclarativeTypedValue>;
  inputs: ReadonlyMap<string, NormalizedDeclarativeInput>;
};

export type EvaluatedDeclarativeFee =
  | {
      mode: "fixed";
      assetId: string;
      amount: string;
      outputIndex: number;
    }
  | {
      mode: "estimate";
      assetId: string;
      maxAmount: string;
      outputIndex: number;
    };

export type EvaluatedFragmentedRecord = {
  assetId: string;
  fragments: readonly Uint8Array[];
};

export type EvaluatedDeclarativeOutputExpansion = {
  nonFeeOutputCount: number;
  /** Recipe output index to the exact payload fragments it expands into. */
  fragmentedRecords: ReadonlyMap<number, EvaluatedFragmentedRecord>;
};

export type EvaluatedDeclarativeWalletRequirement = {
  id: string;
  assetId: string;
  amount: string;
  amountMode: "exact" | "minimum";
  scriptType?: "p2wpkh";
};

export type EvaluatedDeclarativeProvidedInputExpectation = {
  id: string;
  assetId: string;
  amount: string;
  scriptPubKey?: string;
};

type ExpressionParseScope = {
  arguments: ReadonlySet<string>;
  inputs: ReadonlySet<string>;
};

type ExpressionParseBudget = {
  nodes: number;
  literalBytes: number;
  simplicityValueNodes: number;
};

type ExpressionEvaluationBudget = {
  nodes: number;
};

type SimplicityValueEvaluationBudget = {
  nodes: number;
  textBytes: number;
  expression: ExpressionEvaluationBudget;
};

const CHAIN_ID = /^bip122:[0-9a-f]{32}$/;
const FULL_ACTION_NAME = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;
const LOWER_HEX = /^(?:[0-9a-f]{2})*$/;
const CANONICAL_UINT = /^(?:0|[1-9][0-9]*)$/;
const SOURCE_IMPORT = /^\s*(?:import|include|mod)\b/m;
const ARGUMENT_TYPES = new Set<DeclarativeArgumentType>([
  "u16",
  "u32",
  "u64",
  "bytes",
  "bytes32",
  "asset_id",
  "script",
]);
const INPUT_FIELDS = new Set<DeclarativeInputField>([
  "index",
  "txid",
  "vout",
  "asset_id",
  "amount",
  "script_pub_key",
  "tx_out",
]);
const UINT_WIDTHS = new Set([1, 2, 4, 8, 16, 32]);
const LENGTH_WIDTHS = new Set([1, 2, 4, 8]);
const U16_MAX = 0xffffn;
const U32_MAX = 0xffff_ffffn;
const U64_MAX = 0xffff_ffff_ffff_ffffn;
const U256_MAX = (1n << 256n) - 1n;

/**
 * Parse a normalized bundle's closed declarative extension. This function is
 * deliberately pure: it validates recipes and source references but never
 * consults a wallet, chain server, compiler, or signer.
 */
export function parseDeclarativeTxManifest(
  bundle: Pick<TxManifestBundle, "extensions" | "manifest" | "sources">,
): DeclarativeManifest {
  const extensions = stringArray(bundle.extensions, "bundle.extensions");
  if (
    extensions.length !== 1 ||
    extensions[0] !== APOGEE_DECLARATIVE_TRANSACTION_EXTENSION
  ) {
    throw new TypeError(
      `bundle.extensions must contain only ${APOGEE_DECLARATIVE_TRANSACTION_EXTENSION}.`,
    );
  }
  validateSources(bundle.sources);

  const manifest = record(bundle.manifest, "bundle.manifest");
  const extension = exactRecord(
    manifest[APOGEE_DECLARATIVE_MANIFEST_FIELD],
    `bundle.manifest.${APOGEE_DECLARATIVE_MANIFEST_FIELD}`,
    ["version", "chains", "actions"],
  );
  if (extension.version !== APOGEE_DECLARATIVE_MANIFEST_VERSION) {
    throw new TypeError(
      `bundle.manifest.${APOGEE_DECLARATIVE_MANIFEST_FIELD}.version must be ${APOGEE_DECLARATIVE_MANIFEST_VERSION}.`,
    );
  }
  const chains = parseChains(
    extension.chains,
    `bundle.manifest.${APOGEE_DECLARATIVE_MANIFEST_FIELD}.chains`,
  );
  const declaredActions = declaredManifestActionNames(manifest);
  const rawActions = record(
    extension.actions,
    `bundle.manifest.${APOGEE_DECLARATIVE_MANIFEST_FIELD}.actions`,
  );
  const recipeNames = Object.keys(rawActions).sort();
  if (recipeNames.length > DECLARATIVE_LIMITS.actions) {
    throw new TypeError(
      `Declarative manifest contains more than ${DECLARATIVE_LIMITS.actions} actions.`,
    );
  }
  for (const name of recipeNames) fullActionName(name, `declarative action ${name}`);
  requireExactNameMap(declaredActions, recipeNames);

  const actions: Record<string, DeclarativeActionRecipe> = {};
  for (const action of declaredActions) {
    actions[action] = parseActionRecipe(
      rawActions[action],
      `bundle.manifest.${APOGEE_DECLARATIVE_MANIFEST_FIELD}.actions.${action}`,
      bundle.sources,
    );
  }
  return {
    version: APOGEE_DECLARATIVE_MANIFEST_VERSION,
    chains,
    actions,
  };
}

/** Strictly parse invocation arguments according to one declarative action. */
export function parseDeclarativeArguments(
  recipe: DeclarativeActionRecipe,
  value: unknown,
): ReadonlyMap<string, DeclarativeTypedValue> {
  const raw = record(value, "arguments");
  const expected = Object.keys(recipe.arguments).sort();
  requireExactNameMap(expected, Object.keys(raw).sort(), "arguments");
  const parsed = new Map<string, DeclarativeTypedValue>();
  for (const name of expected) {
    parsed.set(name, parseArgumentValue(recipe.arguments[name], raw[name], `arguments.${name}`));
  }
  return parsed;
}

/**
 * Bind already-resolved inputs to their ordered recipe roles. Resolution and
 * ownership checks belong to the host; this helper only normalizes typed data.
 */
export function createDeclarativeEvaluationContext(
  recipe: DeclarativeActionRecipe,
  rawArguments: unknown,
  resolvedInputs: readonly DeclarativeResolvedInput[],
): DeclarativeEvaluationContext {
  if (resolvedInputs.length !== recipe.inputs.length) {
    throw new TypeError(
      `resolvedInputs must contain exactly ${recipe.inputs.length} ordered inputs.`,
    );
  }
  return createDeclarativePartialEvaluationContext(
    recipe,
    rawArguments,
    resolvedInputs,
  );
}

/**
 * Bind only the leading resolved roles, allowing the next wallet role's
 * selection requirements to be evaluated without inventing its own input.
 */
export function createDeclarativePartialEvaluationContext(
  recipe: DeclarativeActionRecipe,
  rawArguments: unknown,
  resolvedPriorInputs: readonly DeclarativeResolvedInput[],
): DeclarativeEvaluationContext {
  if (
    resolvedPriorInputs.length > recipe.inputs.length ||
    resolvedPriorInputs.length > DECLARATIVE_LIMITS.inputsPerAction
  ) {
    throw new TypeError("resolvedPriorInputs contains too many ordered inputs.");
  }
  const inputs = new Map<string, NormalizedDeclarativeInput>();
  for (let index = 0; index < resolvedPriorInputs.length; index += 1) {
    const role = recipe.inputs[index];
    const resolved = resolvedPriorInputs[index];
    if (resolved.id !== role.id || resolved.source !== role.kind) {
      throw new TypeError(
        `resolvedPriorInputs[${index}] must resolve ${role.kind} role ${role.id}.`,
      );
    }
    if (inputs.has(resolved.id)) {
      throw new TypeError(`resolvedPriorInputs contains duplicate role ${resolved.id}.`);
    }
    inputs.set(resolved.id, {
      index,
      id: resolved.id,
      source: resolved.source,
      txid: fixedHex(resolved.txid, 32, `resolvedPriorInputs[${index}].txid`),
      vout: boundedUint(
        resolved.vout,
        U32_MAX,
        `resolvedPriorInputs[${index}].vout`,
      ),
      assetId: fixedHex(
        resolved.asset_id,
        32,
        `resolvedPriorInputs[${index}].asset_id`,
      ),
      amount: boundedUint(
        resolved.amount,
        U64_MAX,
        `resolvedPriorInputs[${index}].amount`,
      ),
      scriptPubKey: variableHex(
        resolved.script_pub_key,
        DECLARATIVE_LIMITS.scriptBytes,
        `resolvedPriorInputs[${index}].script_pub_key`,
      ),
      ...(resolved.tx_out === undefined
        ? {}
        : {
            txOut: variableHex(
              resolved.tx_out,
              DECLARATIVE_LIMITS.transactionOutputBytes,
              `resolvedPriorInputs[${index}].tx_out`,
            ),
          }),
    });
  }
  return {
    arguments: parseDeclarativeArguments(recipe, rawArguments),
    inputs,
  };
}

/** Evaluate the next wallet-selection constraint against a partial context. */
export async function evaluateDeclarativeWalletRequirement(
  role: DeclarativeWalletInputRole,
  context: DeclarativeEvaluationContext,
): Promise<EvaluatedDeclarativeWalletRequirement> {
  const asset = await evaluateDeclarativeTypedExpression(
    { type: "asset_id", value: role.asset },
    context,
  );
  const amount = await evaluateDeclarativeTypedExpression(
    { type: "u64", value: role.amount },
    context,
  );
  return {
    id: role.id,
    assetId: bytesToHex(expectBytes(asset, `wallet role ${role.id} asset`)),
    amount: expectUint(amount, `wallet role ${role.id} amount`).toString(),
    amountMode: role.amount_mode,
    ...(role.script_type === undefined ? {} : { scriptType: role.script_type }),
  };
}

/** Evaluate and compare a provided role's non-tautological input expectations. */
export async function assertDeclarativeProvidedInputMatches(
  role: DeclarativeProvidedInputRole,
  context: DeclarativeEvaluationContext,
): Promise<EvaluatedDeclarativeProvidedInputExpectation> {
  const resolved = context.inputs.get(role.id);
  if (!resolved || resolved.source !== "provided") {
    throw new TypeError(`Missing resolved provided input ${role.id}.`);
  }
  const asset = await evaluateDeclarativeTypedExpression(
    { type: "asset_id", value: role.expect.asset },
    context,
  );
  const amount = await evaluateDeclarativeTypedExpression(
    { type: "u64", value: role.expect.amount },
    context,
  );
  const assetId = bytesToHex(expectBytes(asset, `provided role ${role.id} asset`));
  const expectedAmount = expectUint(amount, `provided role ${role.id} amount`);
  if (assetId !== bytesToHex(resolved.assetId)) {
    throw new TypeError(`Resolved provided input ${role.id} has an unexpected asset.`);
  }
  if (expectedAmount !== resolved.amount) {
    throw new TypeError(`Resolved provided input ${role.id} has an unexpected amount.`);
  }
  let scriptPubKey: string | undefined;
  if (role.expect.script_pub_key !== undefined) {
    const script = await evaluateDeclarativeTypedExpression(
      { type: "script", value: role.expect.script_pub_key },
      context,
    );
    scriptPubKey = bytesToHex(expectBytes(script, `provided role ${role.id} script`));
    if (scriptPubKey !== bytesToHex(resolved.scriptPubKey)) {
      throw new TypeError(
        `Resolved provided input ${role.id} has an unexpected script_pub_key.`,
      );
    }
  } else if (role.authorization === "wallet") {
    throw new TypeError(
      `Wallet-authorized provided role ${role.id} must constrain script_pub_key.`,
    );
  }
  return {
    id: role.id,
    assetId,
    amount: expectedAmount.toString(),
    ...(scriptPubKey === undefined ? {} : { scriptPubKey }),
  };
}

/** Evaluate one previously parsed expression under a bounded typed context. */
export async function evaluateDeclarativeExpression(
  expression: DeclarativeExpression,
  context: DeclarativeEvaluationContext,
): Promise<DeclarativeUnsignedValue> {
  return evaluateExpression(expression, context, { nodes: 0 }, 1);
}

/** Evaluate and enforce the declared primitive type. */
export async function evaluateDeclarativeTypedExpression(
  expression: DeclarativeTypedExpression,
  context: DeclarativeEvaluationContext,
): Promise<DeclarativeTypedValue> {
  const value = await evaluateDeclarativeExpression(expression.value, context);
  return enforceTypedValue(expression.type, value, "evaluated expression");
}

/** Render one closed value tree into the runtime's canonical SimplicityHL syntax. */
export async function renderDeclarativeSimplicityValue(
  value: DeclarativeSimplicityValue,
  context: DeclarativeEvaluationContext,
): Promise<string> {
  const budget: SimplicityValueEvaluationBudget = {
    nodes: 0,
    textBytes: 0,
    expression: { nodes: 0 },
  };
  return renderSimplicityValue(value, context, budget, 1);
}

/** Evaluate all named witnesses in deterministic name order for the WASM runtime. */
export async function evaluateDeclarativeCovenantWitnesses(
  recipe: DeclarativeCovenantWitnessRecipe,
  context: DeclarativeEvaluationContext,
): Promise<Readonly<Record<string, { type: "simplicityhl"; value: string }>>> {
  const result: Record<string, { type: "simplicityhl"; value: string }> = {};
  const budget: SimplicityValueEvaluationBudget = {
    nodes: 0,
    textBytes: 0,
    expression: { nodes: 0 },
  };
  for (const name of Object.keys(recipe.witnesses).sort()) {
    const value = await renderSimplicityValue(recipe.witnesses[name], context, budget, 1);
    result[name] = {
      type: "simplicityhl",
      value,
    };
  }
  return result;
}

/** Resolve the fee after the host knows the expanded non-fee output count. */
export async function evaluateDeclarativeFee(
  fee: DeclarativeFeeRecipe,
  context: DeclarativeEvaluationContext,
  nonFeeOutputCount: number,
): Promise<EvaluatedDeclarativeFee> {
  const asset = await evaluateDeclarativeTypedExpression(
    { type: "asset_id", value: fee.asset },
    context,
  );
  const outputIndex = resolveDeclarativeFeeOutputIndex(fee, nonFeeOutputCount);
  if (fee.mode === "fixed") {
    const amount = await evaluateDeclarativeTypedExpression(
      { type: "u64", value: fee.amount },
      context,
    );
    return {
      mode: "fixed",
      assetId: bytesToHex(expectBytes(asset, "fee asset")),
      amount: expectUint(amount, "fee amount").toString(),
      outputIndex,
    };
  }
  const maxAmount = await evaluateDeclarativeTypedExpression(
    { type: "u64", value: fee.max_amount },
    context,
  );
  return {
    mode: "estimate",
    assetId: bytesToHex(expectBytes(asset, "fee asset")),
    maxAmount: expectUint(maxAmount, "fee maximum").toString(),
    outputIndex,
  };
}

export function resolveDeclarativeFeeOutputIndex(
  fee: DeclarativeFeeRecipe,
  nonFeeOutputCount: number,
): number {
  const count = boundedInteger(
    nonFeeOutputCount,
    0,
    DECLARATIVE_LIMITS.expandedOutputsPerAction,
    "nonFeeOutputCount",
  );
  return boundedInteger(
    fee.output_index ?? count,
    0,
    count,
    "fee.output_index",
  );
}

/** Whether execution must collect a wallet signature for at least one input. */
export function declarativeActionRequiresWalletSigning(
  recipe: DeclarativeActionRecipe,
): boolean {
  return recipe.inputs.some(
    (input) => input.kind === "wallet" || input.authorization === "wallet",
  );
}

/** Reject an invocation whose active genesis hash was not declared by the bundle. */
export function assertDeclarativeChainAllowed(
  manifest: DeclarativeManifest,
  chain: string,
): void {
  if (!CHAIN_ID.test(chain)) {
    throw new TypeError("chain must be a lowercase BIP-122 identifier.");
  }
  if (!manifest.chains.includes(chain)) {
    throw new TypeError(`Declarative manifest does not allow chain ${chain}.`);
  }
}

/** Evaluate and deterministically fragment one record output. */
export async function evaluateDeclarativeFragmentedRecord(
  output: DeclarativeFragmentedRecordOutput,
  context: DeclarativeEvaluationContext,
): Promise<EvaluatedFragmentedRecord> {
  const asset = await evaluateDeclarativeTypedExpression(
    { type: "asset_id", value: output.asset },
    context,
  );
  const recordValue = await evaluateDeclarativeExpression(output.record, context);
  const recordBytes = expectBytes(recordValue, "fragmented record");
  if (recordBytes.length > DECLARATIVE_LIMITS.fragmentedRecordBytes) {
    throw new TypeError(
      `fragmented record exceeds ${DECLARATIVE_LIMITS.fragmentedRecordBytes} bytes.`,
    );
  }
  const fragmentBytes = boundedInteger(
    output.fragment_bytes,
    1,
    DECLARATIVE_LIMITS.fragmentBytes,
    "fragmented_record.fragment_bytes",
  );
  const fragmentCount = Math.max(1, Math.ceil(recordBytes.length / fragmentBytes));
  if (fragmentCount > DECLARATIVE_LIMITS.expandedOutputsPerAction) {
    throw new TypeError("fragmented record expands to too many outputs.");
  }
  const fragments: Uint8Array[] = [];
  for (let offset = 0; offset < recordBytes.length; offset += fragmentBytes) {
    fragments.push(recordBytes.slice(offset, offset + fragmentBytes));
  }
  if (fragments.length === 0) fragments.push(new Uint8Array());
  return {
    assetId: bytesToHex(expectBytes(asset, "fragmented record asset")),
    fragments,
  };
}

/**
 * Expand all bounded record outputs and account for the action-wide output cap.
 * Other output variants contribute exactly one transaction output each.
 */
export async function evaluateDeclarativeOutputExpansion(
  recipe: DeclarativeActionRecipe,
  context: DeclarativeEvaluationContext,
): Promise<EvaluatedDeclarativeOutputExpansion> {
  if (
    recipe.outputs.length === 0 ||
    recipe.outputs.length > DECLARATIVE_LIMITS.outputsPerAction
  ) {
    throw new TypeError("Declarative recipe output count is out of bounds.");
  }
  let nonFeeOutputCount = 0;
  const fragmentedRecords = new Map<number, EvaluatedFragmentedRecord>();
  for (let index = 0; index < recipe.outputs.length; index += 1) {
    const output = recipe.outputs[index];
    if (output.kind === "fragmented_record") {
      const evaluated = await evaluateDeclarativeFragmentedRecord(output, context);
      fragmentedRecords.set(index, evaluated);
      nonFeeOutputCount += evaluated.fragments.length;
    } else {
      nonFeeOutputCount += 1;
    }
    if (nonFeeOutputCount > DECLARATIVE_LIMITS.expandedOutputsPerAction) {
      throw new TypeError(
        `Declarative recipe expands to more than ${DECLARATIVE_LIMITS.expandedOutputsPerAction} non-fee outputs.`,
      );
    }
  }
  return { nonFeeOutputCount, fragmentedRecords };
}

export function declarativeBytesHex(value: DeclarativeUnsignedValue): string {
  return bytesToHex(expectBytes(value, "value"));
}

function parseActionRecipe(
  value: unknown,
  path: string,
  sources: Record<string, string>,
): DeclarativeActionRecipe {
  const raw = exactRecord(
    value,
    path,
    ["arguments", "inputs", "outputs", "fee", "covenant_witnesses"],
    ["locktime"],
  );
  const arguments_ = parseArgumentTypes(raw.arguments, `${path}.arguments`);
  const rawInputs = boundedArray(raw.inputs, `${path}.inputs`, DECLARATIVE_LIMITS.inputsPerAction);
  if (rawInputs.length === 0) throw new TypeError(`${path}.inputs must not be empty.`);

  const inputIds = new Set<string>();
  for (let index = 0; index < rawInputs.length; index += 1) {
    const input = record(rawInputs[index], `${path}.inputs[${index}]`);
    const id = identifier(input.id, `${path}.inputs[${index}].id`);
    if (inputIds.has(id)) throw new TypeError(`${path}.inputs contains duplicate id ${id}.`);
    inputIds.add(id);
  }
  const scope: ExpressionParseScope = {
    arguments: new Set(Object.keys(arguments_)),
    inputs: inputIds,
  };
  const budget: ExpressionParseBudget = {
    nodes: 0,
    literalBytes: 0,
    simplicityValueNodes: 0,
  };
  const inputs: DeclarativeInputRole[] = [];
  const priorInputIds = new Set<string>();
  for (let index = 0; index < rawInputs.length; index += 1) {
    const input = parseInputRole(
      rawInputs[index],
      `${path}.inputs[${index}]`,
      { arguments: scope.arguments, inputs: new Set(priorInputIds) },
      budget,
    );
    inputs.push(input);
    priorInputIds.add(input.id);
  }
  const providedNames = new Set<string>();
  for (const input of inputs) {
    if (input.kind !== "provided") continue;
    if (providedNames.has(input.provided_input)) {
      throw new TypeError(`${path}.inputs reuses provided input ${input.provided_input}.`);
    }
    providedNames.add(input.provided_input);
  }

  const rawOutputs = boundedArray(
    raw.outputs,
    `${path}.outputs`,
    DECLARATIVE_LIMITS.outputsPerAction,
  );
  if (rawOutputs.length === 0) throw new TypeError(`${path}.outputs must not be empty.`);
  const outputs = rawOutputs.map((output, index) =>
    parseOutputRecipe(
      output,
      `${path}.outputs[${index}]`,
      sources,
      scope,
      budget,
    ),
  );
  const fee = parseFeeRecipe(raw.fee, `${path}.fee`, scope, budget);

  const rawWitnesses = boundedArray(
    raw.covenant_witnesses,
    `${path}.covenant_witnesses`,
    DECLARATIVE_LIMITS.covenantWitnessesPerAction,
  );
  const roleById = new Map(inputs.map((input) => [input.id, input] as const));
  const witnessInputs = new Set<string>();
  const covenantWitnesses = rawWitnesses.map((witness, index) => {
    const parsed = parseCovenantWitness(
      witness,
      `${path}.covenant_witnesses[${index}]`,
      sources,
      scope,
      budget,
    );
    const role = roleById.get(parsed.input);
    if (
      !role ||
      role.kind !== "provided" ||
      role.authorization !== "covenant"
    ) {
      throw new TypeError(
        `${path}.covenant_witnesses[${index}].input must name a covenant-authorized provided input role.`,
      );
    }
    if (witnessInputs.has(parsed.input)) {
      throw new TypeError(`${path}.covenant_witnesses repeats input ${parsed.input}.`);
    }
    witnessInputs.add(parsed.input);
    return parsed;
  });
  for (const input of inputs) {
    if (
      input.kind === "provided" &&
      input.authorization === "covenant" &&
      !witnessInputs.has(input.id)
    ) {
      throw new TypeError(
        `${path}.covenant_witnesses is missing covenant-authorized input ${input.id}.`,
      );
    }
  }
  requireCompilationWorkWithinLimit(outputs, covenantWitnesses, sources, path);
  const locktime =
    raw.locktime === undefined
      ? undefined
      : parseExpression(raw.locktime, `${path}.locktime`, scope, budget, 1);
  return {
    arguments: arguments_,
    inputs,
    outputs,
    fee,
    covenant_witnesses: covenantWitnesses,
    ...(locktime === undefined ? {} : { locktime }),
  };
}

function requireCompilationWorkWithinLimit(
  outputs: readonly DeclarativeOutputRecipe[],
  witnesses: readonly DeclarativeCovenantWitnessRecipe[],
  sources: Readonly<Record<string, string>>,
  path: string,
): void {
  const encoder = new TextEncoder();
  const sourceSizes = new Map<string, number>();
  const size = (source: string) => {
    const cached = sourceSizes.get(source);
    if (cached !== undefined) return cached;
    const bytes = encoder.encode(sources[source] ?? "").length;
    sourceSizes.set(source, bytes);
    return bytes;
  };
  let total = 0;
  for (const output of outputs) {
    if (output.kind === "covenant") total += size(output.source);
  }
  for (const witness of witnesses) total += size(witness.source);
  if (total > DECLARATIVE_LIMITS.compilationSourceBytesPerAction) {
    throw new TypeError(
      `${path} exceeds the per-action Simplicity compilation-work limit.`,
    );
  }
}

function parseArgumentTypes(
  value: unknown,
  path: string,
): Readonly<Record<string, DeclarativeArgumentType>> {
  const raw = record(value, path);
  const names = Object.keys(raw).sort();
  if (names.length > DECLARATIVE_LIMITS.argumentsPerAction) {
    throw new TypeError(`${path} contains too many arguments.`);
  }
  const result: Record<string, DeclarativeArgumentType> = {};
  for (const name of names) {
    identifier(name, `${path} key`);
    const type = raw[name];
    if (typeof type !== "string" || !ARGUMENT_TYPES.has(type as DeclarativeArgumentType)) {
      throw new TypeError(`${path}.${name} has an unsupported argument type.`);
    }
    result[name] = type as DeclarativeArgumentType;
  }
  return result;
}

function parseInputRole(
  value: unknown,
  path: string,
  priorInputScope: ExpressionParseScope,
  budget: ExpressionParseBudget,
): DeclarativeInputRole {
  const raw = record(value, path);
  if (raw.kind === "provided") {
    exactKeys(
      raw,
      path,
      ["kind", "id", "provided_input", "authorization", "expect"],
      ["sequence"],
    );
    if (raw.authorization !== "covenant" && raw.authorization !== "wallet") {
      throw new TypeError(`${path}.authorization must be covenant or wallet.`);
    }
    const expectation = exactRecord(
      raw.expect,
      `${path}.expect`,
      ["asset", "amount"],
      ["script_pub_key"],
    );
    if (
      raw.authorization === "wallet" &&
      expectation.script_pub_key === undefined
    ) {
      throw new TypeError(
        `${path}.expect.script_pub_key is required for wallet authorization.`,
      );
    }
    return {
      kind: "provided",
      id: identifier(raw.id, `${path}.id`),
      provided_input: identifier(raw.provided_input, `${path}.provided_input`),
      authorization: raw.authorization,
      expect: {
        asset: parseExpression(
          expectation.asset,
          `${path}.expect.asset`,
          priorInputScope,
          budget,
          1,
        ),
        amount: parseExpression(
          expectation.amount,
          `${path}.expect.amount`,
          priorInputScope,
          budget,
          1,
        ),
        ...(expectation.script_pub_key === undefined
          ? {}
          : {
              script_pub_key: parseExpression(
                expectation.script_pub_key,
                `${path}.expect.script_pub_key`,
                priorInputScope,
                budget,
                1,
              ),
            }),
      },
      ...(raw.sequence === undefined
        ? {}
        : {
            sequence: parseExpression(
              raw.sequence,
              `${path}.sequence`,
              priorInputScope,
              budget,
              1,
            ),
          }),
    };
  }
  if (raw.kind === "wallet") {
    exactKeys(
      raw,
      path,
      ["kind", "id", "asset", "amount", "amount_mode"],
      ["script_type", "sequence"],
    );
    if (raw.amount_mode !== "exact" && raw.amount_mode !== "minimum") {
      throw new TypeError(`${path}.amount_mode must be exact or minimum.`);
    }
    if (raw.script_type !== undefined && raw.script_type !== "p2wpkh") {
      throw new TypeError(`${path}.script_type must be p2wpkh when present.`);
    }
    return {
      kind: "wallet",
      id: identifier(raw.id, `${path}.id`),
      asset: parseExpression(
        raw.asset,
        `${path}.asset`,
        priorInputScope,
        budget,
        1,
      ),
      amount: parseExpression(
        raw.amount,
        `${path}.amount`,
        priorInputScope,
        budget,
        1,
      ),
      amount_mode: raw.amount_mode,
      ...(raw.script_type === undefined
        ? {}
        : { script_type: raw.script_type }),
      ...(raw.sequence === undefined
        ? {}
        : {
            sequence: parseExpression(
              raw.sequence,
              `${path}.sequence`,
              priorInputScope,
              budget,
              1,
            ),
          }),
    };
  }
  throw new TypeError(`${path}.kind must be provided or wallet.`);
}

function parseOutputRecipe(
  value: unknown,
  path: string,
  sources: Record<string, string>,
  scope: ExpressionParseScope,
  budget: ExpressionParseBudget,
): DeclarativeOutputRecipe {
  const raw = record(value, path);
  switch (raw.kind) {
    case "script": {
      exactKeys(raw, path, ["kind", "asset", "amount", "script", "confidential"]);
      requireFalse(raw.confidential, `${path}.confidential`);
      return {
        kind: "script",
        asset: parseExpression(raw.asset, `${path}.asset`, scope, budget, 1),
        amount: parseExpression(raw.amount, `${path}.amount`, scope, budget, 1),
        script: parseExpression(raw.script, `${path}.script`, scope, budget, 1),
        confidential: false,
      };
    }
    case "covenant": {
      exactKeys(raw, path, [
        "kind",
        "source",
        "arguments",
        "extra_leaf_payloads",
        "asset",
        "amount",
        "confidential",
      ]);
      requireFalse(raw.confidential, `${path}.confidential`);
      return {
        kind: "covenant",
        source: sourceReference(raw.source, `${path}.source`, sources),
        arguments: parseTypedExpressionMap(
          raw.arguments,
          `${path}.arguments`,
          scope,
          budget,
        ),
        extra_leaf_payloads: parseExpressionArray(
          raw.extra_leaf_payloads,
          `${path}.extra_leaf_payloads`,
          DECLARATIVE_LIMITS.extraLeafPayloads,
          scope,
          budget,
        ),
        asset: parseExpression(raw.asset, `${path}.asset`, scope, budget, 1),
        amount: parseExpression(raw.amount, `${path}.amount`, scope, budget, 1),
        confidential: false,
      };
    }
    case "wallet": {
      exactKeys(raw, path, ["kind", "asset", "amount", "confidential"]);
      return {
        kind: "wallet",
        asset: parseExpression(raw.asset, `${path}.asset`, scope, budget, 1),
        amount: parseExpression(raw.amount, `${path}.amount`, scope, budget, 1),
        confidential: boolean(raw.confidential, `${path}.confidential`),
      };
    }
    case "change": {
      exactKeys(raw, path, ["kind", "asset", "confidential"], ["minimum"]);
      return {
        kind: "change",
        asset: parseExpression(raw.asset, `${path}.asset`, scope, budget, 1),
        confidential: boolean(raw.confidential, `${path}.confidential`),
        ...(raw.minimum === undefined
          ? {}
          : { minimum: parseExpression(raw.minimum, `${path}.minimum`, scope, budget, 1) }),
      };
    }
    case "fragmented_record": {
      exactKeys(raw, path, ["kind", "asset", "record", "fragment_bytes"]);
      return {
        kind: "fragmented_record",
        asset: parseExpression(raw.asset, `${path}.asset`, scope, budget, 1),
        record: parseExpression(raw.record, `${path}.record`, scope, budget, 1),
        fragment_bytes: boundedInteger(
          raw.fragment_bytes,
          1,
          DECLARATIVE_LIMITS.fragmentBytes,
          `${path}.fragment_bytes`,
        ),
      };
    }
    case "txmf": {
      exactKeys(raw, path, ["kind", "asset"]);
      return {
        kind: "txmf",
        asset: parseExpression(raw.asset, `${path}.asset`, scope, budget, 1),
      };
    }
    default:
      throw new TypeError(`${path}.kind is not a supported declarative output variant.`);
  }
}

function parseFeeRecipe(
  value: unknown,
  path: string,
  scope: ExpressionParseScope,
  budget: ExpressionParseBudget,
): DeclarativeFeeRecipe {
  const raw = record(value, path);
  const outputIndex =
    raw.output_index === undefined
      ? undefined
      : boundedInteger(
          raw.output_index,
          0,
          DECLARATIVE_LIMITS.expandedOutputsPerAction,
          `${path}.output_index`,
        );
  if (raw.mode === "fixed") {
    exactKeys(raw, path, ["mode", "asset", "amount"], ["output_index"]);
    return {
      mode: "fixed",
      asset: parseExpression(raw.asset, `${path}.asset`, scope, budget, 1),
      amount: parseExpression(raw.amount, `${path}.amount`, scope, budget, 1),
      ...(outputIndex === undefined ? {} : { output_index: outputIndex }),
    };
  }
  if (raw.mode === "estimate") {
    exactKeys(raw, path, ["mode", "asset", "max_amount"], ["output_index"]);
    return {
      mode: "estimate",
      asset: parseExpression(raw.asset, `${path}.asset`, scope, budget, 1),
      max_amount: parseExpression(raw.max_amount, `${path}.max_amount`, scope, budget, 1),
      ...(outputIndex === undefined ? {} : { output_index: outputIndex }),
    };
  }
  throw new TypeError(`${path}.mode must be fixed or estimate.`);
}

function parseCovenantWitness(
  value: unknown,
  path: string,
  sources: Record<string, string>,
  scope: ExpressionParseScope,
  budget: ExpressionParseBudget,
): DeclarativeCovenantWitnessRecipe {
  const raw = exactRecord(value, path, [
    "input",
    "source",
    "arguments",
    "extra_leaf_payloads",
    "witnesses",
  ]);
  return {
    input: identifier(raw.input, `${path}.input`),
    source: sourceReference(raw.source, `${path}.source`, sources),
    arguments: parseTypedExpressionMap(raw.arguments, `${path}.arguments`, scope, budget),
    extra_leaf_payloads: parseExpressionArray(
      raw.extra_leaf_payloads,
      `${path}.extra_leaf_payloads`,
      DECLARATIVE_LIMITS.extraLeafPayloads,
      scope,
      budget,
    ),
    witnesses: parseSimplicityValueMap(raw.witnesses, `${path}.witnesses`, scope, budget),
  };
}

function parseSimplicityValueMap(
  value: unknown,
  path: string,
  scope: ExpressionParseScope,
  budget: ExpressionParseBudget,
): Readonly<Record<string, DeclarativeSimplicityValue>> {
  const raw = record(value, path);
  const names = Object.keys(raw).sort();
  if (names.length > DECLARATIVE_LIMITS.typedValuesPerMap) {
    throw new TypeError(`${path} contains too many witness values.`);
  }
  const result: Record<string, DeclarativeSimplicityValue> = {};
  for (const name of names) {
    identifier(name, `${path} key`);
    result[name] = parseSimplicityValue(
      raw[name],
      `${path}.${name}`,
      scope,
      budget,
      1,
    );
  }
  return result;
}

function parseSimplicityValue(
  value: unknown,
  path: string,
  scope: ExpressionParseScope,
  budget: ExpressionParseBudget,
  depth: number,
): DeclarativeSimplicityValue {
  if (depth > DECLARATIVE_LIMITS.simplicityValueDepth) {
    throw new TypeError(`${path} exceeds the Simplicity value depth limit.`);
  }
  budget.simplicityValueNodes += 1;
  if (budget.simplicityValueNodes > DECLARATIVE_LIMITS.simplicityValueNodesPerAction) {
    throw new TypeError("Declarative action exceeds the Simplicity value node limit.");
  }
  const raw = record(value, path);
  switch (raw.kind) {
    case "unit":
      exactKeys(raw, path, ["kind"]);
      return { kind: "unit" };
    case "left":
    case "right":
      exactKeys(raw, path, ["kind", "value"]);
      return {
        kind: raw.kind,
        value: parseSimplicityValue(raw.value, `${path}.value`, scope, budget, depth + 1),
      };
    case "tuple": {
      exactKeys(raw, path, ["kind", "values"]);
      const values = boundedArray(raw.values, `${path}.values`, 2);
      if (values.length !== 2) {
        throw new TypeError(`${path}.values must contain exactly two values.`);
      }
      return {
        kind: "tuple",
        values: [
          parseSimplicityValue(values[0], `${path}.values[0]`, scope, budget, depth + 1),
          parseSimplicityValue(values[1], `${path}.values[1]`, scope, budget, depth + 1),
        ],
      };
    }
    case "leaf": {
      exactKeys(raw, path, ["kind", "type", "value"]);
      const type = raw.type;
      if (typeof type !== "string" || !ARGUMENT_TYPES.has(type as DeclarativeArgumentType)) {
        throw new TypeError(`${path}.type is unsupported.`);
      }
      return {
        kind: "leaf",
        type: type as DeclarativeArgumentType,
        value: parseExpression(raw.value, `${path}.value`, scope, budget, 1),
      };
    }
    default:
      throw new TypeError(`${path}.kind is not a supported Simplicity value node.`);
  }
}

function parseTypedExpressionMap(
  value: unknown,
  path: string,
  scope: ExpressionParseScope,
  budget: ExpressionParseBudget,
): Readonly<Record<string, DeclarativeTypedExpression>> {
  const raw = record(value, path);
  const names = Object.keys(raw).sort();
  if (names.length > DECLARATIVE_LIMITS.typedValuesPerMap) {
    throw new TypeError(`${path} contains too many typed values.`);
  }
  const result: Record<string, DeclarativeTypedExpression> = {};
  for (const name of names) {
    identifier(name, `${path} key`);
    const entry = exactRecord(raw[name], `${path}.${name}`, ["type", "value"]);
    const type = entry.type;
    if (typeof type !== "string" || !ARGUMENT_TYPES.has(type as DeclarativeArgumentType)) {
      throw new TypeError(`${path}.${name}.type is unsupported.`);
    }
    result[name] = {
      type: type as DeclarativeArgumentType,
      value: parseExpression(entry.value, `${path}.${name}.value`, scope, budget, 1),
    };
  }
  return result;
}

function parseExpressionArray(
  value: unknown,
  path: string,
  limit: number,
  scope: ExpressionParseScope,
  budget: ExpressionParseBudget,
): readonly DeclarativeExpression[] {
  return boundedArray(value, path, limit).map((entry, index) =>
    parseExpression(entry, `${path}[${index}]`, scope, budget, 1),
  );
}

function parseExpression(
  value: unknown,
  path: string,
  scope: ExpressionParseScope,
  budget: ExpressionParseBudget,
  depth: number,
): DeclarativeExpression {
  if (depth > DECLARATIVE_LIMITS.expressionDepth) {
    throw new TypeError(`${path} exceeds the declarative expression depth limit.`);
  }
  budget.nodes += 1;
  if (budget.nodes > DECLARATIVE_LIMITS.expressionNodesPerAction) {
    throw new TypeError("Declarative action exceeds the expression node limit.");
  }
  const raw = record(value, path);
  switch (raw.op) {
    case "arg": {
      exactKeys(raw, path, ["op", "name"]);
      const name = identifier(raw.name, `${path}.name`);
      if (!scope.arguments.has(name)) {
        throw new TypeError(`${path}.name references unknown argument ${name}.`);
      }
      return { op: "arg", name };
    }
    case "input": {
      exactKeys(raw, path, ["op", "input", "field"]);
      const input = identifier(raw.input, `${path}.input`);
      if (!scope.inputs.has(input)) {
        throw new TypeError(`${path}.input references unknown role ${input}.`);
      }
      const field = raw.field;
      if (typeof field !== "string" || !INPUT_FIELDS.has(field as DeclarativeInputField)) {
        throw new TypeError(`${path}.field is unsupported.`);
      }
      return { op: "input", input, field: field as DeclarativeInputField };
    }
    case "bytes": {
      exactKeys(raw, path, ["op", "value"]);
      const bytes = literalHex(raw.value, path);
      budget.literalBytes += bytes.length;
      if (budget.literalBytes > DECLARATIVE_LIMITS.literalBytesPerAction) {
        throw new TypeError("Declarative action exceeds the literal-byte limit.");
      }
      return { op: "bytes", value: bytesToHex(bytes) };
    }
    case "uint": {
      exactKeys(raw, path, ["op", "value"]);
      const value = canonicalUintString(raw.value, `${path}.value`, U256_MAX);
      return { op: "uint", value };
    }
    case "add": {
      exactKeys(raw, path, ["op", "left", "right"]);
      return {
        op: "add",
        left: parseExpression(raw.left, `${path}.left`, scope, budget, depth + 1),
        right: parseExpression(raw.right, `${path}.right`, scope, budget, depth + 1),
      };
    }
    case "concat": {
      exactKeys(raw, path, ["op", "values"]);
      const values = boundedArray(
        raw.values,
        `${path}.values`,
        DECLARATIVE_LIMITS.expressionListItems,
      );
      if (values.length === 0) throw new TypeError(`${path}.values must not be empty.`);
      return {
        op: "concat",
        values: values.map((entry, index) =>
          parseExpression(entry, `${path}.values[${index}]`, scope, budget, depth + 1),
        ),
      };
    }
    case "sha256":
    case "reverse": {
      exactKeys(raw, path, ["op", "value"]);
      return {
        op: raw.op,
        value: parseExpression(raw.value, `${path}.value`, scope, budget, depth + 1),
      };
    }
    case "tagged_sha256": {
      exactKeys(raw, path, ["op", "tag", "value"]);
      return {
        op: "tagged_sha256",
        tag: parseExpression(raw.tag, `${path}.tag`, scope, budget, depth + 1),
        value: parseExpression(raw.value, `${path}.value`, scope, budget, depth + 1),
      };
    }
    case "encode_uint": {
      exactKeys(raw, path, ["op", "value", "width", "endian"]);
      if (typeof raw.width !== "number" || !UINT_WIDTHS.has(raw.width)) {
        throw new TypeError(`${path}.width is unsupported.`);
      }
      const endian = endianness(raw.endian, `${path}.endian`);
      return {
        op: "encode_uint",
        value: parseExpression(raw.value, `${path}.value`, scope, budget, depth + 1),
        width: raw.width as 1 | 2 | 4 | 8 | 16 | 32,
        endian,
      };
    }
    case "slice": {
      exactKeys(raw, path, ["op", "value", "start", "length"]);
      const start = boundedInteger(
        raw.start,
        0,
        DECLARATIVE_LIMITS.evaluatedBytes,
        `${path}.start`,
      );
      const length = boundedInteger(
        raw.length,
        0,
        DECLARATIVE_LIMITS.evaluatedBytes,
        `${path}.length`,
      );
      if (start + length > DECLARATIVE_LIMITS.evaluatedBytes) {
        throw new TypeError(`${path} slice range exceeds the evaluated-byte limit.`);
      }
      return {
        op: "slice",
        value: parseExpression(raw.value, `${path}.value`, scope, budget, depth + 1),
        start,
        length,
      };
    }
    case "length_prefix": {
      exactKeys(raw, path, ["op", "value", "width", "endian"]);
      if (typeof raw.width !== "number" || !LENGTH_WIDTHS.has(raw.width)) {
        throw new TypeError(`${path}.width is unsupported.`);
      }
      const endian = endianness(raw.endian, `${path}.endian`);
      return {
        op: "length_prefix",
        value: parseExpression(raw.value, `${path}.value`, scope, budget, depth + 1),
        width: raw.width as 1 | 2 | 4 | 8,
        endian,
      };
    }
    default:
      throw new TypeError(`${path}.op is unsupported.`);
  }
}

async function evaluateExpression(
  expression: DeclarativeExpression,
  context: DeclarativeEvaluationContext,
  budget: ExpressionEvaluationBudget,
  depth: number,
): Promise<DeclarativeUnsignedValue> {
  if (depth > DECLARATIVE_LIMITS.expressionDepth) {
    throw new TypeError("Expression evaluation exceeded the depth limit.");
  }
  budget.nodes += 1;
  if (budget.nodes > DECLARATIVE_LIMITS.expressionNodesPerAction) {
    throw new TypeError("Expression evaluation exceeded the node limit.");
  }
  switch (expression.op) {
    case "arg": {
      const value = context.arguments.get(expression.name);
      if (!value) throw new TypeError(`Missing evaluated argument ${expression.name}.`);
      return cloneUnsignedValue(value);
    }
    case "input": {
      const input = context.inputs.get(expression.input);
      if (!input) throw new TypeError(`Missing resolved input ${expression.input}.`);
      switch (expression.field) {
        case "index":
          return { kind: "uint", value: BigInt(input.index) };
        case "txid":
          return bytesValue(input.txid);
        case "vout":
          return { kind: "uint", value: input.vout };
        case "asset_id":
          return bytesValue(input.assetId);
        case "amount":
          return { kind: "uint", value: input.amount };
        case "script_pub_key":
          return bytesValue(input.scriptPubKey);
        case "tx_out":
          if (!input.txOut) {
            throw new TypeError(`Resolved input ${expression.input} has no tx_out bytes.`);
          }
          return bytesValue(input.txOut);
      }
    }
    case "bytes":
      return bytesValue(hexToBytes(expression.value));
    case "uint":
      return { kind: "uint", value: BigInt(expression.value) };
    case "add": {
      const left = expectUint(
        await evaluateExpression(expression.left, context, budget, depth + 1),
        "add.left",
      );
      const right = expectUint(
        await evaluateExpression(expression.right, context, budget, depth + 1),
        "add.right",
      );
      const sum = left + right;
      if (sum > U256_MAX) throw new TypeError("add result exceeds u256.");
      return { kind: "uint", value: sum };
    }
    case "concat": {
      if (
        expression.values.length === 0 ||
        expression.values.length > DECLARATIVE_LIMITS.expressionListItems
      ) {
        throw new TypeError("concat value count is out of bounds.");
      }
      const parts: Uint8Array[] = [];
      let length = 0;
      for (const value of expression.values) {
        const part = expectBytes(
          await evaluateExpression(value, context, budget, depth + 1),
          "concat value",
        );
        length += part.length;
        if (length > DECLARATIVE_LIMITS.evaluatedBytes) {
          throw new TypeError("concat result exceeds the evaluated-byte limit.");
        }
        parts.push(part);
      }
      const result = new Uint8Array(length);
      let offset = 0;
      for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
      }
      return { kind: "bytes", value: result };
    }
    case "sha256": {
      const value = expectBytes(
        await evaluateExpression(expression.value, context, budget, depth + 1),
        "sha256 value",
      );
      return bytesValue(await sha256(value));
    }
    case "tagged_sha256": {
      const tag = expectBytes(
        await evaluateExpression(expression.tag, context, budget, depth + 1),
        "tagged_sha256 tag",
      );
      const value = expectBytes(
        await evaluateExpression(expression.value, context, budget, depth + 1),
        "tagged_sha256 value",
      );
      const tagHash = await sha256(tag);
      return bytesValue(await sha256(concatBytes(tagHash, tagHash, value)));
    }
    case "reverse": {
      const value = expectBytes(
        await evaluateExpression(expression.value, context, budget, depth + 1),
        "reverse value",
      );
      return bytesValue(Uint8Array.from(value).reverse());
    }
    case "encode_uint": {
      const value = expectUint(
        await evaluateExpression(expression.value, context, budget, depth + 1),
        "encode_uint value",
      );
      return bytesValue(encodeUint(value, expression.width, expression.endian));
    }
    case "slice": {
      const value = expectBytes(
        await evaluateExpression(expression.value, context, budget, depth + 1),
        "slice value",
      );
      if (expression.start < 0 || expression.length < 0) {
        throw new TypeError("slice range must be non-negative.");
      }
      const end = expression.start + expression.length;
      if (end > value.length) throw new TypeError("slice range exceeds its input.");
      return bytesValue(value.slice(expression.start, end));
    }
    case "length_prefix": {
      const value = expectBytes(
        await evaluateExpression(expression.value, context, budget, depth + 1),
        "length_prefix value",
      );
      const prefix = encodeUint(BigInt(value.length), expression.width, expression.endian);
      return bytesValue(concatBytes(prefix, value));
    }
  }
}

async function renderSimplicityValue(
  value: DeclarativeSimplicityValue,
  context: DeclarativeEvaluationContext,
  budget: SimplicityValueEvaluationBudget,
  depth: number,
): Promise<string> {
  if (depth > DECLARATIVE_LIMITS.simplicityValueDepth) {
    throw new TypeError("Simplicity value evaluation exceeded the depth limit.");
  }
  budget.nodes += 1;
  if (budget.nodes > DECLARATIVE_LIMITS.simplicityValueNodesPerAction) {
    throw new TypeError("Simplicity value evaluation exceeded the node limit.");
  }
  switch (value.kind) {
    case "unit":
      accountSimplicityValueText(2, budget);
      return "()";
    case "left": {
      const inner = await renderSimplicityValue(
        value.value,
        context,
        budget,
        depth + 1,
      );
      accountSimplicityValueText(6, budget);
      return `Left(${inner})`;
    }
    case "right": {
      const inner = await renderSimplicityValue(
        value.value,
        context,
        budget,
        depth + 1,
      );
      accountSimplicityValueText(7, budget);
      return `Right(${inner})`;
    }
    case "tuple": {
      if (!Array.isArray(value.values) || value.values.length !== 2) {
        throw new TypeError("Simplicity tuple must contain exactly two values.");
      }
      const left = await renderSimplicityValue(
        value.values[0],
        context,
        budget,
        depth + 1,
      );
      const right = await renderSimplicityValue(
        value.values[1],
        context,
        budget,
        depth + 1,
      );
      accountSimplicityValueText(4, budget);
      return `(${left}, ${right})`;
    }
    case "leaf": {
      const unsigned = await evaluateExpression(
        value.value,
        context,
        budget.expression,
        1,
      );
      const typed = enforceTypedValue(value.type, unsigned, "Simplicity value leaf");
      const rendered = typed.kind === "uint"
        ? typed.value.toString()
        : `0x${bytesToHex(typed.value)}`;
      accountSimplicityValueText(rendered.length, budget);
      return rendered;
    }
  }
}

function accountSimplicityValueText(
  bytes: number,
  budget: SimplicityValueEvaluationBudget,
): void {
  budget.textBytes += bytes;
  if (budget.textBytes > DECLARATIVE_LIMITS.simplicityValueTextBytes) {
    throw new TypeError("Simplicity value rendering exceeded the text-byte limit.");
  }
}

function parseArgumentValue(
  type: DeclarativeArgumentType,
  value: unknown,
  path: string,
): DeclarativeTypedValue {
  switch (type) {
    case "u16":
      return { type, kind: "uint", value: boundedUint(value, U16_MAX, path) };
    case "u32":
      return { type, kind: "uint", value: boundedUint(value, U32_MAX, path) };
    case "u64":
      return { type, kind: "uint", value: boundedUint(value, U64_MAX, path) };
    case "bytes":
      return { type, kind: "bytes", value: variableHex(value, DECLARATIVE_LIMITS.evaluatedBytes, path) };
    case "bytes32":
      return { type, kind: "bytes", value: fixedHex(value, 32, path) };
    case "asset_id":
      return { type, kind: "bytes", value: fixedHex(value, 32, path) };
    case "script":
      return { type, kind: "bytes", value: variableHex(value, DECLARATIVE_LIMITS.scriptBytes, path) };
  }
}

function enforceTypedValue(
  type: DeclarativeArgumentType,
  value: DeclarativeUnsignedValue,
  path: string,
): DeclarativeTypedValue {
  switch (type) {
    case "u16":
    case "u32":
    case "u64": {
      const max = type === "u16" ? U16_MAX : type === "u32" ? U32_MAX : U64_MAX;
      const uint = expectUint(value, path);
      if (uint > max) throw new TypeError(`${path} exceeds ${type}.`);
      return { type, kind: "uint", value: uint };
    }
    case "bytes": {
      const bytes = expectBytes(value, path);
      ensureByteLength(bytes, DECLARATIVE_LIMITS.evaluatedBytes, path);
      return { type, kind: "bytes", value: bytes.slice() };
    }
    case "bytes32":
    case "asset_id": {
      const bytes = expectBytes(value, path);
      if (bytes.length !== 32) throw new TypeError(`${path} must be exactly 32 bytes.`);
      return { type, kind: "bytes", value: bytes.slice() };
    }
    case "script": {
      const bytes = expectBytes(value, path);
      ensureByteLength(bytes, DECLARATIVE_LIMITS.scriptBytes, path);
      return { type, kind: "bytes", value: bytes.slice() };
    }
  }
}

function declaredManifestActionNames(manifest: Record<string, unknown>): string[] {
  const names = new Set<string>();
  if (manifest.actions !== undefined) {
    const actions = record(manifest.actions, "bundle.manifest.actions");
    for (const name of Object.keys(actions)) addActionName(names, fullActionName(name, "action"));
  }
  if (manifest.contract_templates !== undefined) {
    const templates = record(manifest.contract_templates, "bundle.manifest.contract_templates");
    for (const [templateName, templateValue] of Object.entries(templates)) {
      const template = identifier(templateName, "contract template name");
      const templateRecord = record(
        templateValue,
        `bundle.manifest.contract_templates.${templateName}`,
      );
      if (templateRecord.actions === undefined) continue;
      const actions = record(
        templateRecord.actions,
        `bundle.manifest.contract_templates.${templateName}.actions`,
      );
      for (const actionName of Object.keys(actions)) {
        const action = identifier(actionName, `action name in template ${templateName}`);
        addActionName(names, `${template}.${action}`);
      }
    }
  }
  const result = [...names].sort();
  if (result.length === 0) throw new TypeError("Manifest declares no actions.");
  if (result.length > DECLARATIVE_LIMITS.actions) {
    throw new TypeError(`Manifest declares more than ${DECLARATIVE_LIMITS.actions} actions.`);
  }
  return result;
}

function addActionName(names: Set<string>, name: string): void {
  if (names.has(name)) throw new TypeError(`Manifest declares duplicate action ${name}.`);
  names.add(name);
}

function requireExactNameMap(
  expected: readonly string[],
  actual: readonly string[],
  path = `bundle.manifest.${APOGEE_DECLARATIVE_MANIFEST_FIELD}.actions`,
): void {
  const expectedSet = new Set(expected);
  for (const name of actual) {
    if (!expectedSet.has(name)) throw new TypeError(`${path} contains unknown name ${name}.`);
  }
  const actualSet = new Set(actual);
  for (const name of expected) {
    if (!actualSet.has(name)) throw new TypeError(`${path} is missing ${name}.`);
  }
}

function parseChains(value: unknown, path: string): string[] {
  const chains = stringArray(value, path);
  if (chains.length === 0 || chains.length > DECLARATIVE_LIMITS.chains) {
    throw new TypeError(`${path} must contain 1..${DECLARATIVE_LIMITS.chains} chains.`);
  }
  const seen = new Set<string>();
  for (const chain of chains) {
    if (!CHAIN_ID.test(chain)) throw new TypeError(`${path} contains invalid chain ${chain}.`);
    if (seen.has(chain)) throw new TypeError(`${path} contains duplicate chain ${chain}.`);
    seen.add(chain);
  }
  return [...chains];
}

function validateSources(sourcesValue: unknown): void {
  const sources = record(sourcesValue, "bundle.sources");
  const entries = Object.entries(sources);
  if (entries.length > DECLARATIVE_LIMITS.sourceFiles) {
    throw new TypeError(`bundle.sources contains more than ${DECLARATIVE_LIMITS.sourceFiles} files.`);
  }
  let total = 0;
  for (const [path, source] of entries) {
    if (path.length > DECLARATIVE_LIMITS.sourcePathLength) {
      throw new TypeError(`bundle source path exceeds ${DECLARATIVE_LIMITS.sourcePathLength} characters.`);
    }
    const canonical = canonicalTxManifestSourcePath(path);
    if (canonical !== path) throw new TypeError(`bundle source path is not canonical: ${path}.`);
    if (typeof source !== "string") throw new TypeError(`bundle.sources.${path} must be text.`);
    if (SOURCE_IMPORT.test(source)) {
      throw new TypeError(`bundle source ${path} contains an unsupported import declaration.`);
    }
    const size = new TextEncoder().encode(source).length;
    if (size > DECLARATIVE_LIMITS.sourceBytesPerFile) {
      throw new TypeError(`bundle source ${path} exceeds the per-file byte limit.`);
    }
    total += size;
    if (total > DECLARATIVE_LIMITS.sourceBytesTotal) {
      throw new TypeError("bundle sources exceed the total byte limit.");
    }
  }
}

function sourceReference(value: unknown, path: string, sources: Record<string, string>): string {
  const raw = boundedString(value, path, DECLARATIVE_LIMITS.sourcePathLength);
  const canonical = canonicalTxManifestSourcePath(raw);
  if (!Object.hasOwn(sources, canonical)) {
    throw new TypeError(`${path} references missing bundle source ${canonical}.`);
  }
  return canonical;
}

function literalHex(value: unknown, path: string): Uint8Array {
  return variableHex(value, DECLARATIVE_LIMITS.literalBytesPerExpression, `${path}.value`);
}

function fixedHex(value: unknown, bytes: number, path: string): Uint8Array {
  if (typeof value !== "string" || value.length !== bytes * 2 || !LOWER_HEX.test(value)) {
    throw new TypeError(`${path} must be ${bytes}-byte lowercase hex.`);
  }
  return hexToBytes(value);
}

function variableHex(value: unknown, maxBytes: number, path: string): Uint8Array {
  if (typeof value !== "string" || !LOWER_HEX.test(value)) {
    throw new TypeError(`${path} must be even-length lowercase hex.`);
  }
  const bytes = hexToBytes(value);
  ensureByteLength(bytes, maxBytes, path);
  return bytes;
}

function ensureByteLength(value: Uint8Array, max: number, path: string): void {
  if (value.length > max) throw new TypeError(`${path} exceeds ${max} bytes.`);
}

function canonicalUintString(value: unknown, path: string, max: bigint): string {
  if (typeof value !== "string" || !CANONICAL_UINT.test(value)) {
    throw new TypeError(`${path} must be a canonical unsigned decimal string.`);
  }
  const parsed = BigInt(value);
  if (parsed > max) throw new TypeError(`${path} exceeds its unsigned integer bound.`);
  return value;
}

function boundedUint(value: unknown, max: bigint, path: string): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number" && Number.isSafeInteger(value)) {
    parsed = BigInt(value);
  } else if (typeof value === "string" && CANONICAL_UINT.test(value)) {
    parsed = BigInt(value);
  } else {
    throw new TypeError(`${path} must be a canonical unsigned integer.`);
  }
  if (parsed < 0n || parsed > max) throw new TypeError(`${path} is out of range.`);
  return parsed;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  path: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${path} must be an integer in ${minimum}..${maximum}.`);
  }
  return value as number;
}

function endianness(value: unknown, path: string): "big" | "little" {
  if (value !== "big" && value !== "little") {
    throw new TypeError(`${path} must be big or little.`);
  }
  return value;
}

function encodeUint(
  value: bigint,
  width: 1 | 2 | 4 | 8 | 16 | 32,
  endian: "big" | "little",
): Uint8Array {
  if (value < 0n || value >= 1n << BigInt(width * 8)) {
    throw new TypeError(`Unsigned integer does not fit in ${width} bytes.`);
  }
  const result = new Uint8Array(width);
  let remaining = value;
  for (let index = 0; index < width; index += 1) {
    const target = endian === "little" ? index : width - 1 - index;
    result[target] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return result;
}

function expectUint(value: DeclarativeUnsignedValue, path: string): bigint {
  if (value.kind !== "uint") throw new TypeError(`${path} must evaluate to an unsigned integer.`);
  return value.value;
}

function expectBytes(value: DeclarativeUnsignedValue, path: string): Uint8Array {
  if (value.kind !== "bytes") throw new TypeError(`${path} must evaluate to bytes.`);
  ensureByteLength(value.value, DECLARATIVE_LIMITS.evaluatedBytes, path);
  return value.value;
}

function cloneUnsignedValue(value: DeclarativeTypedValue): DeclarativeUnsignedValue {
  return value.kind === "uint"
    ? { kind: "uint", value: value.value }
    : bytesValue(value.value);
}

function bytesValue(value: Uint8Array): DeclarativeUnsignedValue {
  ensureByteLength(value, DECLARATIVE_LIMITS.evaluatedBytes, "expression result");
  return { kind: "bytes", value: value.slice() };
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  const input = new ArrayBuffer(value.length);
  new Uint8Array(input).set(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}

function concatBytes(...values: readonly Uint8Array[]): Uint8Array {
  const length = values.reduce((sum, value) => sum + value.length, 0);
  if (length > DECLARATIVE_LIMITS.evaluatedBytes) {
    throw new TypeError("Expression result exceeds the evaluated-byte limit.");
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from({ length: value.length / 2 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}

function bytesToHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fullActionName(value: unknown, path: string): string {
  const name = boundedString(value, path, DECLARATIVE_LIMITS.nameLength);
  if (!FULL_ACTION_NAME.test(name)) throw new TypeError(`${path} is not a full action name.`);
  return name;
}

function identifier(value: unknown, path: string): string {
  const name = boundedString(value, path, DECLARATIVE_LIMITS.nameLength);
  if (!IDENTIFIER.test(name)) throw new TypeError(`${path} is not a safe identifier.`);
  return name;
}

function boundedString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${path} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array.`);
  return value.map((entry, index) => boundedString(entry, `${path}[${index}]`, 256));
}

function boundedArray(value: unknown, path: string, limit: number): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array.`);
  if (value.length > limit) throw new TypeError(`${path} contains more than ${limit} items.`);
  return value;
}

function exactRecord(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const result = record(value, path);
  exactKeys(result, path, required, optional);
  return result;
}

function exactKeys(
  value: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${path} contains unknown field ${key}.`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${path}.${key} is required.`);
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean.`);
  return value;
}

function requireFalse(value: unknown, path: string): asserts value is false {
  if (value !== false) throw new TypeError(`${path} must be false for this output kind.`);
}
