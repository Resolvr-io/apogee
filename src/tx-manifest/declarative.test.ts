import { describe, expect, it } from "vitest";
import type { TxManifestBundle } from "./bundle";
import {
  APOGEE_DECLARATIVE_MANIFEST_FIELD,
  APOGEE_DECLARATIVE_TRANSACTION_EXTENSION,
  DECLARATIVE_LIMITS,
  assertDeclarativeChainAllowed,
  assertDeclarativeProvidedInputMatches,
  createDeclarativeEvaluationContext,
  createDeclarativePartialEvaluationContext,
  declarativeActionRequiresWalletSigning,
  declarativeBytesHex,
  evaluateDeclarativeCovenantWitnesses,
  evaluateDeclarativeExpression,
  evaluateDeclarativeFee,
  evaluateDeclarativeFragmentedRecord,
  evaluateDeclarativeOutputExpansion,
  evaluateDeclarativeTypedExpression,
  evaluateDeclarativeWalletRequirement,
  parseDeclarativeArguments,
  parseDeclarativeTxManifest,
  resolveDeclarativeFeeOutputIndex,
  type DeclarativeActionRecipe,
  type DeclarativeExpression,
} from "./declarative";

const CHAIN = `bip122:${"11".repeat(16)}`;
const OTHER_CHAIN = `bip122:${"22".repeat(16)}`;
const ASSET = "aa".repeat(32);
const TXID = "bb".repeat(32);
const DIGEST = "cc".repeat(32);

type DeclarativeBundle = Pick<TxManifestBundle, "extensions" | "manifest" | "sources">;

function expressionArg(name: string): Record<string, unknown> {
  return { op: "arg", name };
}

function expressionUint(value: string): Record<string, unknown> {
  return { op: "uint", value };
}

function actionRecipe(): Record<string, unknown> {
  return {
    arguments: {
      count: "u32",
      payload: "bytes",
      digest: "bytes32",
      asset: "asset_id",
      destination: "script",
    },
    inputs: [
      {
        kind: "provided",
        id: "state",
        provided_input: "state_input",
        authorization: "covenant",
        expect: {
          asset: expressionArg("asset"),
          amount: expressionUint("900"),
        },
        sequence: expressionUint("7"),
      },
      {
        kind: "wallet",
        id: "funding",
        asset: expressionArg("asset"),
        amount: expressionUint("100"),
        amount_mode: "minimum",
        script_type: "p2wpkh",
      },
    ],
    outputs: [
      {
        kind: "script",
        asset: expressionArg("asset"),
        amount: {
          op: "add",
          left: { op: "input", input: "state", field: "amount" },
          right: expressionUint("100"),
        },
        script: expressionArg("destination"),
        confidential: false,
      },
      {
        kind: "covenant",
        source: "contract.simf",
        arguments: {
          count: { type: "u32", value: expressionArg("count") },
          digest: { type: "bytes32", value: expressionArg("digest") },
        },
        extra_leaf_payloads: [{ op: "bytes", value: "0102" }],
        asset: expressionArg("asset"),
        amount: expressionUint("50"),
        confidential: false,
      },
      {
        kind: "wallet",
        asset: expressionArg("asset"),
        amount: expressionUint("25"),
        confidential: true,
      },
      {
        kind: "change",
        asset: expressionArg("asset"),
        confidential: true,
        minimum: expressionUint("1"),
      },
      {
        kind: "fragmented_record",
        asset: expressionArg("asset"),
        record: expressionArg("payload"),
        fragment_bytes: 4,
      },
      { kind: "txmf", asset: expressionArg("asset") },
    ],
    fee: {
      mode: "fixed",
      asset: expressionArg("asset"),
      amount: expressionUint("10"),
      output_index: 1,
    },
    covenant_witnesses: [
      {
        input: "state",
        source: "contract.simf",
        arguments: {
          count: { type: "u32", value: expressionArg("count") },
        },
        extra_leaf_payloads: [],
        witnesses: {
          PATH: {
            kind: "left",
            value: {
              kind: "tuple",
              values: [
                { kind: "leaf", type: "bytes32", value: expressionArg("digest") },
                {
                  kind: "leaf",
                  type: "u32",
                  value: { op: "input", input: "funding", field: "index" },
                },
              ],
            },
          },
          CLOSED: { kind: "right", value: { kind: "unit" } },
        },
      },
    ],
    locktime: expressionUint("42"),
  };
}

function bundle(): DeclarativeBundle {
  return {
    extensions: [APOGEE_DECLARATIVE_TRANSACTION_EXTENSION],
    manifest: {
      manifest_version: "0.1.0",
      protocol: "generic-test",
      actions: { Execute: {} },
      [APOGEE_DECLARATIVE_MANIFEST_FIELD]: {
        version: 1,
        chains: [CHAIN],
        actions: { Execute: actionRecipe() },
      },
    },
    sources: { "contract.simf": "fn main() { assert!(true); }\n" },
  };
}

function cloneBundle(): DeclarativeBundle {
  return structuredClone(bundle());
}

function extension(value: DeclarativeBundle): {
  version: number;
  chains: string[];
  actions: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
} {
  return value.manifest[APOGEE_DECLARATIVE_MANIFEST_FIELD] as ReturnType<
    typeof extension
  >;
}

function execute(value: DeclarativeBundle): Record<string, unknown> {
  return extension(value).actions.Execute;
}

function evaluationContext(recipe: DeclarativeActionRecipe, stateAmount = "900") {
  return createDeclarativeEvaluationContext(
    recipe,
    {
      count: "5",
      payload: "0102030405",
      digest: DIGEST,
      asset: ASSET,
      destination: "0014" + "dd".repeat(20),
    },
    [
      {
        id: "state",
        source: "provided",
        txid: TXID,
        vout: 3,
        asset_id: ASSET,
        amount: stateAmount,
        script_pub_key: "51",
        tx_out: "010203",
      },
      {
        id: "funding",
        source: "wallet",
        txid: "ee".repeat(32),
        vout: 4,
        asset_id: ASSET,
        amount: "200",
        script_pub_key: "0014" + "ff".repeat(20),
      },
    ],
  );
}

describe("declarative manifest schema", () => {
  it("parses every generic role/output variant and its strict metadata", () => {
    const parsed = parseDeclarativeTxManifest(bundle());
    expect(parsed).toMatchObject({ version: 1, chains: [CHAIN] });
    expect(parsed.actions.Execute.inputs).toEqual([
      expect.objectContaining({
        kind: "provided",
        id: "state",
        authorization: "covenant",
      }),
      expect.objectContaining({
        kind: "wallet",
        id: "funding",
        script_type: "p2wpkh",
      }),
    ]);
    expect(parsed.actions.Execute.outputs.map((output) => output.kind)).toEqual([
      "script",
      "covenant",
      "wallet",
      "change",
      "fragmented_record",
      "txmf",
    ]);
    expect(parsed.actions.Execute.covenant_witnesses[0]).toMatchObject({
      input: "state",
      source: "contract.simf",
    });
    expect(declarativeActionRequiresWalletSigning(parsed.actions.Execute)).toBe(true);
  });

  it("requires the exact extension id, extension keys, and version", () => {
    const wrongId = cloneBundle();
    wrongId.extensions = ["different/v1"];
    expect(() => parseDeclarativeTxManifest(wrongId)).toThrow(/must contain only/);

    const unknown = cloneBundle();
    extension(unknown).future = true;
    expect(() => parseDeclarativeTxManifest(unknown)).toThrow(/unknown field future/);

    const wrongVersion = cloneBundle();
    extension(wrongVersion).version = 2;
    expect(() => parseDeclarativeTxManifest(wrongVersion)).toThrow(/version must be 1/);
  });

  it("requires a valid chain allowlist and checks the active chain", () => {
    const parsed = parseDeclarativeTxManifest(bundle());
    expect(() => assertDeclarativeChainAllowed(parsed, CHAIN)).not.toThrow();
    expect(() => assertDeclarativeChainAllowed(parsed, OTHER_CHAIN)).toThrow(/does not allow/);

    const duplicate = cloneBundle();
    extension(duplicate).chains = [CHAIN, CHAIN];
    expect(() => parseDeclarativeTxManifest(duplicate)).toThrow(/duplicate chain/);

    const invalid = cloneBundle();
    extension(invalid).chains = ["liquid-regtest"];
    expect(() => parseDeclarativeTxManifest(invalid)).toThrow(/invalid chain/);
  });

  it("requires a full exact recipe map for direct and template actions", () => {
    const missing = cloneBundle();
    missing.manifest.contract_templates = { Vault: { actions: { Spend: {} } } };
    expect(() => parseDeclarativeTxManifest(missing)).toThrow(/missing Vault\.Spend/);

    extension(missing).actions["Vault.Spend"] = actionRecipe();
    expect(Object.keys(parseDeclarativeTxManifest(missing).actions)).toEqual([
      "Execute",
      "Vault.Spend",
    ]);

    const extra = cloneBundle();
    extension(extra).actions.Unadvertised = actionRecipe();
    expect(() => parseDeclarativeTxManifest(extra)).toThrow(/unknown name Unadvertised/);
  });

  it("rejects unknown nested fields and unresolved expression/input/source names", () => {
    const unknown = cloneBundle();
    (execute(unknown).fee as Record<string, unknown>).surprise = true;
    expect(() => parseDeclarativeTxManifest(unknown)).toThrow(/unknown field surprise/);

    const unknownArgument = cloneBundle();
    (execute(unknownArgument).fee as Record<string, unknown>).asset = expressionArg("missing");
    expect(() => parseDeclarativeTxManifest(unknownArgument)).toThrow(/unknown argument missing/);

    const unknownInput = cloneBundle();
    (execute(unknownInput).fee as Record<string, unknown>).amount = {
      op: "input",
      input: "missing",
      field: "amount",
    };
    expect(() => parseDeclarativeTxManifest(unknownInput)).toThrow(/unknown role missing/);

    const missingSource = cloneBundle();
    (execute(missingSource).outputs as Record<string, unknown>[])[1].source = "other.simf";
    expect(() => parseDeclarativeTxManifest(missingSource)).toThrow(/missing bundle source/);
  });

  it("requires explicit provided authorization and strictly pins wallet script types", () => {
    const missingAuthorization = cloneBundle();
    delete (execute(missingAuthorization).inputs as Record<string, unknown>[])[0]
      .authorization;
    expect(() => parseDeclarativeTxManifest(missingAuthorization)).toThrow(
      /authorization is required/,
    );

    const invalidAuthorization = cloneBundle();
    (execute(invalidAuthorization).inputs as Record<string, unknown>[])[0].authorization =
      "either";
    expect(() => parseDeclarativeTxManifest(invalidAuthorization)).toThrow(
      /must be covenant or wallet/,
    );

    const invalidScriptType = cloneBundle();
    (execute(invalidScriptType).inputs as Record<string, unknown>[])[1].script_type =
      "p2tr";
    expect(() => parseDeclarativeTxManifest(invalidScriptType)).toThrow(/must be p2wpkh/);

    const unconstrainedWalletProvided = cloneBundle();
    (
      execute(unconstrainedWalletProvided).inputs as Record<string, unknown>[]
    )[0].authorization = "wallet";
    expect(() => parseDeclarativeTxManifest(unconstrainedWalletProvided)).toThrow(
      /script_pub_key is required for wallet authorization/,
    );

    const providedWallet = cloneBundle();
    (execute(providedWallet).inputs as Record<string, unknown>[]).splice(1, 1);
    const providedRole = (execute(providedWallet).inputs as Record<string, unknown>[])[0];
    providedRole.authorization = "wallet";
    (providedRole.expect as Record<string, unknown>).script_pub_key = {
      op: "bytes",
      value: "51",
    };
    execute(providedWallet).covenant_witnesses = [];
    const recipe = parseDeclarativeTxManifest(providedWallet).actions.Execute;
    expect(declarativeActionRequiresWalletSigning(recipe)).toBe(true);
  });

  it("accepts only bounded structural Simplicity witness values", () => {
    const raw = cloneBundle();
    const covenant = (execute(raw).covenant_witnesses as Record<string, unknown>[])[0];
    (covenant.witnesses as Record<string, unknown>).PATH = {
      kind: "raw",
      value: `Left((0x${DIGEST}, 1))`,
    };
    expect(() => parseDeclarativeTxManifest(raw)).toThrow(/not a supported Simplicity value/);

    const unknown = cloneBundle();
    const unknownCovenant = (
      execute(unknown).covenant_witnesses as Record<string, unknown>[]
    )[0];
    (unknownCovenant.witnesses as Record<string, Record<string, unknown>>).CLOSED.extra =
      true;
    expect(() => parseDeclarativeTxManifest(unknown)).toThrow(/unknown field extra/);

    const tooDeep = cloneBundle();
    let value: Record<string, unknown> = { kind: "unit" };
    for (let index = 0; index < DECLARATIVE_LIMITS.simplicityValueDepth; index += 1) {
      value = { kind: "left", value };
    }
    const deepCovenant = (
      execute(tooDeep).covenant_witnesses as Record<string, unknown>[]
    )[0];
    (deepCovenant.witnesses as Record<string, unknown>).PATH = value;
    expect(() => parseDeclarativeTxManifest(tooDeep)).toThrow(/value depth limit/);

    const tooManyNodes = cloneBundle();
    let tree: Record<string, unknown> = { kind: "unit" };
    for (let depth = 0; depth < 8; depth += 1) {
      tree = { kind: "tuple", values: [structuredClone(tree), structuredClone(tree)] };
    }
    const largeCovenant = (
      execute(tooManyNodes).covenant_witnesses as Record<string, unknown>[]
    )[0];
    (largeCovenant.witnesses as Record<string, unknown>).PATH = tree;
    expect(() => parseDeclarativeTxManifest(tooManyNodes)).toThrow(/value node limit/);
  });

  it("enforces action, input, output, expression, source, and literal limits", () => {
    const tooManyActions = cloneBundle();
    tooManyActions.manifest.actions = {};
    extension(tooManyActions).actions = {};
    for (let index = 0; index <= DECLARATIVE_LIMITS.actions; index += 1) {
      const name = `Action${index}`;
      (tooManyActions.manifest.actions as Record<string, unknown>)[name] = {};
      extension(tooManyActions).actions[name] = actionRecipe();
    }
    expect(() => parseDeclarativeTxManifest(tooManyActions)).toThrow(/more than 32 actions/);

    const tooManyInputs = cloneBundle();
    execute(tooManyInputs).inputs = Array.from(
      { length: DECLARATIVE_LIMITS.inputsPerAction + 1 },
      (_, index) => ({
        kind: "provided",
        id: `input${index}`,
        provided_input: `provided${index}`,
        authorization: "covenant",
        expect: { asset: expressionArg("asset"), amount: expressionUint("1") },
      }),
    );
    expect(() => parseDeclarativeTxManifest(tooManyInputs)).toThrow(/more than 32 items/);

    const tooManyOutputs = cloneBundle();
    const firstOutput = (execute(tooManyOutputs).outputs as unknown[])[0];
    execute(tooManyOutputs).outputs = Array.from(
      { length: DECLARATIVE_LIMITS.outputsPerAction + 1 },
      () => structuredClone(firstOutput),
    );
    expect(() => parseDeclarativeTxManifest(tooManyOutputs)).toThrow(/more than 64 items/);

    const tooDeep = cloneBundle();
    let deep: Record<string, unknown> = { op: "bytes", value: "00" };
    for (let index = 0; index < DECLARATIVE_LIMITS.expressionDepth; index += 1) {
      deep = { op: "reverse", value: deep };
    }
    (execute(tooDeep).fee as Record<string, unknown>).asset = deep;
    expect(() => parseDeclarativeTxManifest(tooDeep)).toThrow(/depth limit/);

    const tooManySources = cloneBundle();
    tooManySources.sources = Object.fromEntries(
      Array.from({ length: DECLARATIVE_LIMITS.sourceFiles + 1 }, (_, index) => [
        `source-${index}.simf`,
        "fn main() {}",
      ]),
    );
    expect(() => parseDeclarativeTxManifest(tooManySources)).toThrow(/more than 32 files/);

    const excessiveCompileWork = cloneBundle();
    excessiveCompileWork.sources["contract.simf"] = "x".repeat(
      DECLARATIVE_LIMITS.sourceBytesPerFile,
    );
    const covenantOutput = (execute(excessiveCompileWork).outputs as unknown[])[1];
    execute(excessiveCompileWork).outputs = Array.from(
      { length: 16 },
      () => structuredClone(covenantOutput),
    );
    expect(() => parseDeclarativeTxManifest(excessiveCompileWork)).toThrow(
      /compilation-work limit/,
    );

    const hugeLiteral = cloneBundle();
    (execute(hugeLiteral).fee as Record<string, unknown>).asset = {
      op: "bytes",
      value: "00".repeat(DECLARATIVE_LIMITS.literalBytesPerExpression + 1),
    };
    expect(() => parseDeclarativeTxManifest(hugeLiteral)).toThrow(/exceeds 4096 bytes/);
  });

  it("rejects ambient source imports", () => {
    const value = cloneBundle();
    value.sources["contract.simf"] = "import ambient;\nfn main() {}";
    expect(() => parseDeclarativeTxManifest(value)).toThrow(/unsupported import/);
  });
});

describe("declarative argument and input binding", () => {
  it("strictly parses every argument primitive and binds ordered input roles", () => {
    const recipe = parseDeclarativeTxManifest(bundle()).actions.Execute;
    const args = parseDeclarativeArguments(recipe, {
      count: 5,
      payload: "0102",
      digest: DIGEST,
      asset: ASSET,
      destination: "0014" + "dd".repeat(20),
    });
    expect(args.get("count")).toMatchObject({ type: "u32", kind: "uint", value: 5n });
    expect(args.get("payload")).toMatchObject({ type: "bytes", kind: "bytes" });

    const context = evaluationContext(recipe);
    expect(context.inputs.get("state")).toMatchObject({ index: 0, source: "provided" });
    expect(context.inputs.get("funding")).toMatchObject({ index: 1, source: "wallet" });
  });

  it("evaluates a wallet requirement using only its bounded prior-input context", async () => {
    const recipe = parseDeclarativeTxManifest(bundle()).actions.Execute;
    const complete = evaluationContext(recipe);
    const state = complete.inputs.get("state");
    if (!state) throw new Error("fixture input missing");
    const partial = createDeclarativePartialEvaluationContext(
      recipe,
      {
        count: "5",
        payload: "0102030405",
        digest: DIGEST,
        asset: ASSET,
        destination: "0014" + "dd".repeat(20),
      },
      [
        {
          id: "state",
          source: "provided",
          txid: TXID,
          vout: 3,
          asset_id: ASSET,
          amount: "900",
          script_pub_key: "51",
          tx_out: "010203",
        },
      ],
    );
    const walletRole = recipe.inputs[1];
    if (walletRole.kind !== "wallet") throw new Error("fixture wallet role missing");
    await expect(evaluateDeclarativeWalletRequirement(walletRole, partial)).resolves.toEqual({
      id: "funding",
      assetId: ASSET,
      amount: "100",
      amountMode: "minimum",
      scriptType: "p2wpkh",
    });
    const providedRole = recipe.inputs[0];
    if (providedRole.kind !== "provided") throw new Error("fixture role missing");
    await expect(
      assertDeclarativeProvidedInputMatches(providedRole, complete),
    ).resolves.toEqual({ id: "state", assetId: ASSET, amount: "900" });
    await expect(
      assertDeclarativeProvidedInputMatches(
        providedRole,
        evaluationContext(recipe, "901"),
      ),
    ).rejects.toThrow(/unexpected amount/);
  });

  it("rejects self/later references in input expectations and wallet selection", () => {
    const selfExpectation = cloneBundle();
    const provided = (execute(selfExpectation).inputs as Record<string, unknown>[])[0];
    (provided.expect as Record<string, unknown>).amount = {
      op: "input",
      input: "state",
      field: "amount",
    };
    expect(() => parseDeclarativeTxManifest(selfExpectation)).toThrow(/unknown role state/);

    const selfSelection = cloneBundle();
    const wallet = (execute(selfSelection).inputs as Record<string, unknown>[])[1];
    wallet.amount = { op: "input", input: "funding", field: "amount" };
    expect(() => parseDeclarativeTxManifest(selfSelection)).toThrow(/unknown role funding/);
  });

  it("rejects unknown args, integer overflow, noncanonical hex, and reordered inputs", () => {
    const recipe = parseDeclarativeTxManifest(bundle()).actions.Execute;
    const values = {
      count: "5",
      payload: "00",
      digest: DIGEST,
      asset: ASSET,
      destination: "51",
    };
    expect(() => parseDeclarativeArguments(recipe, { ...values, extra: "00" })).toThrow(
      /unknown name extra/,
    );
    expect(() =>
      parseDeclarativeArguments(recipe, { ...values, count: "4294967296" }),
    ).toThrow(/out of range/);
    expect(() =>
      parseDeclarativeArguments(recipe, { ...values, asset: ASSET.toUpperCase() }),
    ).toThrow(/lowercase hex/);

    const good = evaluationContext(recipe);
    const reversed = [...good.inputs.values()]
      .reverse()
      .map((input) => ({
        id: input.id,
        source: input.source,
        txid: TXID,
        vout: Number(input.vout),
        asset_id: ASSET,
        amount: input.amount,
        script_pub_key: "51",
      }));
    expect(() => createDeclarativeEvaluationContext(recipe, values, reversed)).toThrow(
      /must resolve provided role state/,
    );
  });
});

describe("declarative expression evaluation", () => {
  it("evaluates refs, integer addition/encoding, concatenation, reversal, slicing, and prefixes", async () => {
    const recipe = parseDeclarativeTxManifest(bundle()).actions.Execute;
    const context = evaluationContext(recipe);
    const expression: DeclarativeExpression = {
      op: "concat",
      values: [
        {
          op: "encode_uint",
          value: {
            op: "add",
            left: { op: "arg", name: "count" },
            right: { op: "uint", value: "2" },
          },
          width: 2,
          endian: "little",
        },
        { op: "reverse", value: { op: "bytes", value: "aabbcc" } },
        {
          op: "slice",
          value: { op: "bytes", value: "00112233" },
          start: 1,
          length: 2,
        },
        {
          op: "length_prefix",
          value: { op: "arg", name: "payload" },
          width: 1,
          endian: "big",
        },
        { op: "input", input: "state", field: "script_pub_key" },
      ],
    };
    expect(declarativeBytesHex(await evaluateDeclarativeExpression(expression, context))).toBe(
      "0700ccbbaa112205010203040551",
    );
    await expect(
      evaluateDeclarativeTypedExpression(
        { type: "u64", value: { op: "input", input: "state", field: "amount" } },
        context,
      ),
    ).resolves.toMatchObject({ type: "u64", kind: "uint", value: 900n });
  });

  it("evaluates SHA-256 and tagged SHA-256 deterministically", async () => {
    const recipe = parseDeclarativeTxManifest(bundle()).actions.Execute;
    const context = evaluationContext(recipe);
    const emptyHash = await evaluateDeclarativeExpression(
      { op: "sha256", value: { op: "bytes", value: "" } },
      context,
    );
    expect(declarativeBytesHex(emptyHash)).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    const first = declarativeBytesHex(
      await evaluateDeclarativeExpression(
        {
          op: "tagged_sha256",
          tag: { op: "bytes", value: "746167" },
          value: { op: "bytes", value: "0102" },
        },
        context,
      ),
    );
    const second = declarativeBytesHex(
      await evaluateDeclarativeExpression(
        {
          op: "tagged_sha256",
          tag: { op: "bytes", value: "746167" },
          value: { op: "bytes", value: "0102" },
        },
        context,
      ),
    );
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  it("rejects type confusion, integer overflow, invalid slices, and missing tx_out", async () => {
    const recipe = parseDeclarativeTxManifest(bundle()).actions.Execute;
    const context = evaluationContext(recipe);
    await expect(
      evaluateDeclarativeExpression(
        {
          op: "add",
          left: { op: "bytes", value: "00" },
          right: { op: "uint", value: "1" },
        },
        context,
      ),
    ).rejects.toThrow(/must evaluate to an unsigned integer/);
    await expect(
      evaluateDeclarativeExpression(
        {
          op: "add",
          left: { op: "uint", value: ((1n << 256n) - 1n).toString() },
          right: { op: "uint", value: "1" },
        },
        context,
      ),
    ).rejects.toThrow(/exceeds u256/);
    await expect(
      evaluateDeclarativeExpression(
        {
          op: "slice",
          value: { op: "bytes", value: "00" },
          start: 1,
          length: 1,
        },
        context,
      ),
    ).rejects.toThrow(/exceeds its input/);
    await expect(
      evaluateDeclarativeExpression(
        { op: "input", input: "funding", field: "tx_out" },
        context,
      ),
    ).rejects.toThrow(/has no tx_out/);
  });
});

describe("declarative output helpers", () => {
  it("renders dynamic sum/product witnesses without accepting format strings", async () => {
    const recipe = parseDeclarativeTxManifest(bundle()).actions.Execute;
    const context = evaluationContext(recipe);
    await expect(
      evaluateDeclarativeCovenantWitnesses(recipe.covenant_witnesses[0], context),
    ).resolves.toEqual({
      CLOSED: { type: "simplicityhl", value: "Right(())" },
      PATH: { type: "simplicityhl", value: `Left((0x${DIGEST}, 1))` },
    });
  });

  it("evaluates fixed and estimated fee bounds at an ordered output index", async () => {
    const recipe = parseDeclarativeTxManifest(bundle()).actions.Execute;
    const context = evaluationContext(recipe);
    await expect(evaluateDeclarativeFee(recipe.fee, context, 7)).resolves.toEqual({
      mode: "fixed",
      assetId: ASSET,
      amount: "10",
      outputIndex: 1,
    });
    await expect(
      evaluateDeclarativeFee(
        {
          mode: "estimate",
          asset: { op: "arg", name: "asset" },
          max_amount: { op: "uint", value: "99" },
        },
        context,
        7,
      ),
    ).resolves.toEqual({
      mode: "estimate",
      assetId: ASSET,
      maxAmount: "99",
      outputIndex: 7,
    });
    expect(() => resolveDeclarativeFeeOutputIndex(recipe.fee, 0)).toThrow(/integer in 0\.\.0/);
  });

  it("fragments records deterministically, including an empty record", async () => {
    const recipe = parseDeclarativeTxManifest(bundle()).actions.Execute;
    const context = evaluationContext(recipe);
    const output = recipe.outputs.find((candidate) => candidate.kind === "fragmented_record");
    if (!output || output.kind !== "fragmented_record") throw new Error("fixture output missing");
    const evaluated = await evaluateDeclarativeFragmentedRecord(output, context);
    expect(evaluated.assetId).toBe(ASSET);
    expect(evaluated.fragments.map((fragment) => [...fragment])).toEqual([
      [1, 2, 3, 4],
      [5],
    ]);

    const empty = await evaluateDeclarativeFragmentedRecord(
      { ...output, record: { op: "bytes", value: "" } },
      context,
    );
    expect(empty.fragments).toHaveLength(1);
    expect(empty.fragments[0]).toHaveLength(0);

    const expansion = await evaluateDeclarativeOutputExpansion(recipe, context);
    expect(expansion.nonFeeOutputCount).toBe(7);
    expect(expansion.fragmentedRecords.get(4)?.fragments).toHaveLength(2);
  });

  it("enforces the action-wide expanded output limit", async () => {
    const value = cloneBundle();
    execute(value).outputs = Array.from({ length: 26 }, () => ({
      kind: "fragmented_record",
      asset: expressionArg("asset"),
      record: expressionArg("payload"),
      fragment_bytes: 1,
    }));
    const recipe = parseDeclarativeTxManifest(value).actions.Execute;
    const context = evaluationContext(recipe);
    await expect(evaluateDeclarativeOutputExpansion(recipe, context)).rejects.toThrow(
      /more than 128 non-fee outputs/,
    );
  });
});
