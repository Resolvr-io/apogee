// Manifest runner — turns a (manifest, action) pair into a concrete build plan.
//
// This is the layer that makes Apogee a manifest *runner* rather than a blind
// PSET signer: every covenant destination is DERIVED here from the manifest's
// own `.simf` source (Spec §11), never taken from the caller. A site that lies
// about an instance field changes the derived address, so the lie shows up as a
// mismatch instead of as a payout.
//
// Everything crosses in as text and stays as strings: u64 runs past 2^53, so
// integers are decimal strings and byte values are hex, exactly as the reference
// CLI's instance files do.
//
// lwk arrives as a parameter (like covenant.ts) so this whole file is testable in
// Node against the pkg_node build, without a browser or an offscreen document.
//
// SCOPE: constructors (`last_will`'s `Fund`) and KEYLESS covenant spends. A
// covenant input is planned here — its address derived
// for verification and its `simplicityhl` witness resolved — while the engine
// builds the PSET and finalizes the covenant input (see offscreen.ts + witness.ts).
// Signature-carrying spends, issuances, and formula witnesses are still refused
// explicitly rather than half-built. See meta/tasks/upnext/01-txmanifest-runner.md.

import type { CompileParam, LwkLike } from "./covenant";
import { deriveCovenantAddress, computeCovenantScriptHashSync } from "./covenant";
import { evalBool, evalU64, type SwelEnv, type SwelValue, SwelError } from "./swel";
import {
  findAction,
  normalizeInstance,
  normalizeManifest,
  type Action,
  type ContractTemplate,
  type FieldType,
  type Input,
  type Manifest,
  type Output,
} from "./types";
import type { LiquidNetwork } from "@/keystore/keystore";

/**
 * Marks an error as describing the CALLER's manifest rather than wallet
 * internals, so the service worker may forward it to the dapp verbatim instead
 * of genericizing it. The engine boundary is a plain string channel that drops
 * the error class, so the marker has to travel in the message itself.
 */
export const MANIFEST_ERROR_PREFIX = "MANIFEST: ";

/** Raised for any manifest we refuse to run. The message reaches the dapp. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

/** An externally-supplied UTXO. Untrusted until its script matches a derived one. */
export interface ProvidedInput {
  txid: string;
  vout: number;
  amount_sat: string;
  asset: string;
}

export interface RunnerInput {
  /** Raw txmanifest.json TEXT — parsed here so callers can also hash the bytes. */
  manifestText: string;
  action: string;
  /** Source path (as written in `script.source`) → raw `.simf` text. */
  sources: Record<string, string>;
  instanceText?: string;
  providedInputs?: Record<string, ProvidedInput>;
  actionParams?: Record<string, string>;
  network: LiquidNetwork;
}

/** A resolved output: what to build, and for covenants the address WE derived. */
export interface PlannedOutput {
  id: string;
  description: string;
  /**
   * A pay-to-address output. Set for `{utxo_type: X}` covenant destinations (the
   * address WE derived) AND for a fixed literal-address destination such as the
   * discovery beacon; `external` distinguishes the two.
   */
  address?: string;
  utxoType?: string;
  /**
   * True when `address` is a fixed destination taken from the manifest (e.g. the
   * beacon), NOT a covenant we derived. Such an output is paid but is not a spendable
   * covenant UTXO — it is excluded from the created-instance UTXO list and its address
   * carries no "derived" trust badge.
   */
  external?: boolean;
  /**
   * Set for an `{type: "op_return"}` destination — the already-encoded OP_RETURN
   * payload as a hex string. Mutually exclusive with `address`/`wallet`.
   */
  opReturnData?: string;
  /** Wallet-owned destinations ("wallet" / "change") the builder handles itself. */
  wallet: "recipient" | "change" | undefined;
  amountSat?: bigint; // absent when a formula supplies it later (e.g. drain)
  asset: string; // "lbtc" or a 64-hex asset id
  optional: boolean;
  requiredIndex?: number;
}

/**
 * A resolved covenant-input witness (Spec §8). Only keyless `simplicityhl`
 * witnesses are in scope: a keyless covenant spend's PATH, and nothing that carries a
 * signature. Carried as strings; the engine turns them into typed Simplicity
 * values at finalize time (see witness.ts).
 */
export interface PlannedWitness {
  /** Witness name in the `.simf` ABI (e.g. "PATH"). */
  name: string;
  /** SimplicityHL type of the value (e.g. "Either<u32, u32>"). */
  simplicityType: string;
  /** The literal value expression (e.g. "Left(0)"). */
  value: string;
}

/**
 * A covenant UTXO this action spends: the outpoint, the address WE derived to
 * verify it against chain, the program to recompile at finalize time, and the
 * Simplicity witness that satisfies it.
 *
 * Wallet inputs never appear here — lwk selects and signs them itself, driven by
 * the outputs. Only covenant inputs, which the wallet can neither discover nor
 * finalize on its own, are planned explicitly.
 */
export interface PlannedInput {
  id: string;
  description: string;
  utxoType: string;
  /** The `.simf` source text, so the engine can recompile to finalize the input. */
  source: string;
  compileParams: CompileParam[];
  debugSymbols: boolean;
  /** The covenant address WE derived — a hard gate against the on-chain script_pubkey. */
  address: string;
  /** The outpoint being spent, supplied (untrusted) by the caller. */
  providedInput: ProvidedInput;
  /** Witnesses satisfying the covenant, in declaration order. */
  witnesses: PlannedWitness[];
  asset: string; // "lbtc" or 64-hex — for the approval's detail leg
  amountSat?: bigint; // best-effort, for the detail leg
  optional: boolean;
}

export interface ManifestPlan {
  protocol: string;
  action: string;
  description: string;
  /** Contract template this action belongs to, if any. */
  template?: string;
  /** Author's one-line intent (`ui.action`) with refs interpolated. UNTRUSTED. */
  intent?: string;
  /** Covenant inputs to spend (wallet inputs are implicit and omitted). */
  inputs: PlannedInput[];
  outputs: PlannedOutput[];
  /** Instance created by a constructor. Must be handed back to the caller. */
  instance?: { template: string; fields: Record<string, string> };
}

// ---- value helpers ---------------------------------------------------------

const BYTE_TYPES = new Set<FieldType>(["bytes32", "pubkey", "liquid.asset_id"]);
const INT_TYPES = new Set<FieldType>(["u8", "u16", "u32", "u64"]);

function strip0x(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/**
 * Normalize a typed manifest value to its canonical string form, and reject
 * anything malformed. The reference CLI is lenient here — an unresolvable
 * compile-param reference falls through as a literal and is then dropped with
 * only a warning, which silently compiles a DIFFERENT program and therefore a
 * different address. We make every such case a hard error instead.
 */
function normalizeValue(name: string, type: FieldType | "string", raw: string): string {
  const v = raw.trim();
  // Opaque text — a fixed output destination (e.g. the discovery beacon address)
  // that never compiles into a covenant, so there is nothing to normalize or verify.
  // Passed straight through; the only guard is that it isn't empty.
  if (type === "string") {
    if (v.length === 0) throw new ManifestError(`${name}: expected a non-empty string`);
    return v;
  }
  if (BYTE_TYPES.has(type)) {
    const hex = strip0x(v).toLowerCase();
    if (!/^[0-9a-f]*$/.test(hex) || hex.length === 0) {
      throw new ManifestError(`${name}: expected hex for ${type}, got "${raw}"`);
    }
    if (hex.length > 64) throw new ManifestError(`${name}: ${type} value is longer than 32 bytes`);
    return hex.padStart(64, "0");
  }
  if (INT_TYPES.has(type)) {
    if (!/^[0-9]+$/.test(v)) {
      throw new ManifestError(`${name}: expected a non-negative integer for ${type}, got "${raw}"`);
    }
    const n = BigInt(v);
    const bits = { u8: 8n, u16: 16n, u32: 32n, u64: 64n }[type as "u8" | "u16" | "u32" | "u64"];
    if (n > (1n << bits) - 1n) throw new ManifestError(`${name}: value ${v} overflows ${type}`);
    return v;
  }
  if (type === "bool") {
    if (v !== "true" && v !== "false") {
      throw new ManifestError(`${name}: expected "true" or "false", got "${raw}"`);
    }
    return v;
  }
  throw new ManifestError(`${name}: unsupported type ${String(type)}`);
}

/** Wrap a normalized string as the SWEL value its manifest type implies. */
function swelValue(type: FieldType | "string", value: string): SwelValue {
  // A `string` param (e.g. the beacon address) is a wallet-side destination, never a
  // SWEL value — arithmetic or a covenant that referenced one would be a manifest bug.
  if (type === "string") throw new SwelError(`a string value ("${value}") can't be used here`);
  if (BYTE_TYPES.has(type)) return { kind: "bytes", hex: value };
  if (type === "bool") return { kind: "bool", value: value === "true" };
  return { kind: "u64", value: BigInt(value) };
}

// ---- parameter + instance resolution ---------------------------------------

interface Typed {
  // `string` only ever holds a param-side destination (e.g. a fixed beacon address); it
  // is never a covenant compile param or a SWEL value, and the sinks that consume a
  // FieldType (swelValue, resolveScriptParams) reject it explicitly.
  type: FieldType | "string";
  value: string;
}

/**
 * Resolve the action's declared params from caller input + declared defaults.
 * A param the caller didn't supply and that has no `default` is an error — we
 * never invent a value that ends up baked into a covenant address.
 */
function resolveParams(action: Action, supplied: Record<string, string>): Record<string, Typed> {
  const out: Record<string, Typed> = {};
  for (const [name, def] of Object.entries(action.params ?? {})) {
    // Spec §5.1 defines exactly one auto-fill source, `wallet_key`. Deriving the
    // right x-only key from the wallet isn't wired up, and guessing one would
    // silently produce a covenant nobody can spend — refuse instead.
    if (def.source?.type === "wallet_key") {
      throw new ManifestError(
        `Parameter "${name}" wants source.wallet_key, which Apogee doesn't fill in yet.`,
      );
    }
    // `address` is wallet-side only and never compiles into a covenant (Spec §5.2).
    if (def.type === "address") {
      throw new ManifestError(`Parameter "${name}": the "address" param type isn't supported yet.`);
    }
    const raw = supplied[name] ?? def.default;
    if (raw === undefined) throw new ManifestError(`Missing required parameter "${name}".`);
    out[name] = { type: def.type, value: normalizeValue(name, def.type, String(raw)) };
  }
  // A param the manifest never declared is a bug in the caller, not something to
  // quietly drop — it may be the one they think is controlling the amount.
  for (const name of Object.keys(supplied)) {
    if (!(name in (action.params ?? {}))) {
      throw new ManifestError(`Unknown parameter "${name}" for this action.`);
    }
  }
  return out;
}

/**
 * Compute a constructor's instance fields (templates.md §3).
 *
 * Ordering matters and matches the reference CLI: the fields are resolved BEFORE
 * any covenant address is derived, because the covenant's compile params are
 * looked up in this very map.
 */
function resolveInstanceFields(
  lwk: LwkLike,
  manifest: Manifest,
  action: Action,
  template: ContractTemplate,
  params: Record<string, Typed>,
  sources: Record<string, string>,
  network: LiquidNetwork,
): Record<string, Typed> {
  const ci = action.create_instance;
  if (!ci) return {};
  const debugSymbols = manifest.compile_debug_symbols === true;
  const out: Record<string, Typed> = {};
  for (const [field, spec] of Object.entries(ci.fields)) {
    const def = template.fields?.[field];
    if (!def) throw new ManifestError(`create_instance sets unknown field "${field}".`);
    if (typeof spec === "string") {
      // `$`-prefixed direct substitution and the bare dotted forms both appear in
      // the wild; both are a plain namespace lookup, not arithmetic. A field already
      // set by an earlier entry is visible in `out`, so a compute can depend on one.
      const ref = spec.trim().replace(/^\$/, "");
      const value = lookupRef(ref, params, out);
      if (value === undefined) {
        throw new ManifestError(`Field "${field}": can't resolve "${spec}".`);
      }
      out[field] = { type: def.type, value: normalizeValue(field, def.type, value) };
      continue;
    }
    // Inline tapleaf computation (templates.md §3): the field is SHA256(scriptPubKey)
    // of a covenant compiled from `simf` with the given params.
    // The manifest writes the discriminant as `compute` (legacy) or `lang`.
    out[field] = { type: def.type, value: computeTapleafField(lwk, field, spec, params, out, sources, network, debugSymbols) };
  }
  // Every field the template declares must end up set, or the instance we hand
  // back is incomplete and the contract becomes unspendable.
  for (const field of Object.keys(template.fields ?? {})) {
    if (!(field in out)) throw new ManifestError(`create_instance never sets field "${field}".`);
  }
  return out;
}

/**
 * Resolve a `compute: "tapleaf"` instance field to `SHA256(scriptPubKey)` of the
 * covenant it names (templates.md §3). This is what lets a constructor commit, by
 * construction, to another covenant's address: a field can hold the hash of a second
 * covenant's payout script, so the committing covenant enforces payment there without a
 * party ever copying a hash by hand. Computed exactly like an output address is derived, then
 * hashed; a lie in any tapleaf param changes the hash and so the offer address.
 */
function computeTapleafField(
  lwk: LwkLike,
  field: string,
  spec: unknown,
  params: Record<string, Typed>,
  instanceSoFar: Record<string, Typed>,
  sources: Record<string, string>,
  network: LiquidNetwork,
  debugSymbols: boolean,
): string {
  const s = spec as {
    compute?: string;
    lang?: string;
    simf?: string;
    params?: Record<string, { value: string; type?: FieldType }>;
  };
  if (s.compute !== "tapleaf" && s.lang !== "tapleaf") {
    throw new ManifestError(`Field "${field}": unsupported computed value.`);
  }
  if (typeof s.simf !== "string") {
    throw new ManifestError(`Field "${field}": tapleaf compute has no "simf" source.`);
  }
  const source = sources[s.simf];
  if (source === undefined) {
    throw new ManifestError(`Field "${field}": missing program source "${s.simf}" — pass it in \`sources\`.`);
  }
  const compileParams: CompileParam[] = Object.entries(s.params ?? {}).map(([simfName, p]) => {
    const ref = String(p.value).trim().replace(/^\$/, "");
    const reffed = lookupTyped(ref, params, instanceSoFar);
    if (reffed === undefined) {
      throw new ManifestError(`Field "${field}": can't resolve tapleaf param "${simfName}" → "${p.value}".`);
    }
    const type = p.type ?? reffed.type;
    if (type === "string") {
      throw new ManifestError(`Field "${field}": tapleaf param "${simfName}" resolves to a string.`);
    }
    return { name: simfName, type, value: normalizeValue(simfName, type, reffed.value) };
  });
  return computeCovenantScriptHashSync(lwk, source, compileParams, network, debugSymbols);
}

/** Like `lookupRef`, but returns the full typed value (type + value), not just the value. */
function lookupTyped(
  ref: string,
  params: Record<string, Typed>,
  instance: Record<string, Typed>,
): Typed | undefined {
  if (ref.startsWith("params.")) return params[ref.slice(7)];
  if (ref.startsWith("instance.")) return instance[ref.slice(9)];
  if (ref.startsWith("compile_params.")) return instance[ref.slice(15)];
  if (!ref.includes(".")) return params[ref] ?? instance[ref];
  return undefined;
}

/**
 * Resolve a namespace reference to its raw string value.
 * `instance.` is current naming; `compile_params.` is the legacy alias for the
 * same namespace and is still what the reference fixtures use.
 */
function lookupRef(
  ref: string,
  params: Record<string, Typed>,
  instance: Record<string, Typed>,
): string | undefined {
  if (ref.startsWith("params.")) return params[ref.slice(7)]?.value;
  if (ref.startsWith("instance.")) return instance[ref.slice(9)]?.value;
  if (ref.startsWith("compile_params.")) return instance[ref.slice(15)]?.value;
  if (!ref.includes(".")) return params[ref]?.value ?? instance[ref]?.value;
  return undefined;
}

/** SWEL environment over the resolved params/instance, plus `fee` when known. */
function buildEnv(
  params: Record<string, Typed>,
  instance: Record<string, Typed>,
  extra: Record<string, SwelValue> = {},
): SwelEnv {
  return {
    lookup(ref) {
      if (ref in extra) return extra[ref];
      const typed =
        ref.startsWith("params.")
          ? params[ref.slice(7)]
          : ref.startsWith("instance.")
            ? instance[ref.slice(9)]
            : ref.startsWith("compile_params.")
              ? instance[ref.slice(15)]
              : (params[ref] ?? instance[ref]);
      if (!typed) throw new SwelError(`unknown reference: ${ref}`);
      return swelValue(typed.type, typed.value);
    },
  };
}

// ---- covenant address derivation -------------------------------------------

/**
 * Derive the address for a `{utxo_type: X}` destination.
 *
 * `script.compile_params` maps a `.simf` parameter name to a KEY in the
 * instance/param namespace — not to a SWEL formula. The reference implementation
 * falls back to treating an unresolved key as a literal value; we refuse
 * instead, because a typo there compiles a different program and so yields a
 * different address, silently.
 */
/**
 * Resolve a `{utxo_type: X}`'s Simplicity script: the `.simf` source text and its
 * compile params, ready to compile. Shared by output-address derivation and
 * covenant-input planning — both need the exact same program the offer address
 * committed to.
 *
 * `script.compile_params` maps a `.simf` parameter name to a KEY in the
 * instance/param namespace — not to a SWEL formula. The reference implementation
 * falls back to treating an unresolved key as a literal value; we refuse instead,
 * because a typo there compiles a different program and so yields a different
 * address, silently.
 */
function resolveScriptParams(
  manifest: Manifest,
  utxoTypeName: string,
  sources: Record<string, string>,
  params: Record<string, Typed>,
  instance: Record<string, Typed>,
): { source: string; compileParams: CompileParam[]; debugSymbols: boolean } {
  const ut = manifest.utxo_types?.[utxoTypeName];
  if (!ut) throw new ManifestError(`Unknown utxo_type "${utxoTypeName}".`);
  if (ut.script.type !== "simplicity") {
    throw new ManifestError(`utxo_type "${utxoTypeName}": only Simplicity scripts are supported.`);
  }
  const source = sources[ut.script.source];
  if (source === undefined) {
    throw new ManifestError(
      `Missing program source "${ut.script.source}" — pass it in \`sources\`.`,
    );
  }
  const compileParams = Object.entries(ut.script.compile_params ?? {}).map(([simfName, ref]) => {
    const key = String(ref).trim().replace(/^\$/, "");
    const typed =
      key.startsWith("instance.")
        ? instance[key.slice(9)]
        : key.startsWith("compile_params.")
          ? instance[key.slice(15)]
          : key.startsWith("params.")
            ? params[key.slice(7)]
            : (instance[key] ?? params[key]);
    if (!typed) {
      throw new ManifestError(
        `utxo_type "${utxoTypeName}": compile param "${simfName}" references "${ref}", which isn't a known instance field or parameter.`,
      );
    }
    if (typed.type === "string") {
      throw new ManifestError(
        `utxo_type "${utxoTypeName}": compile param "${simfName}" resolves to a string, which can't compile into a covenant.`,
      );
    }
    return { name: simfName, type: typed.type, value: typed.value };
  });
  // `compile_debug_symbols` changes the CMR and therefore the address, so it must
  // match the protocol's own toolchain exactly.
  return { source, compileParams, debugSymbols: manifest.compile_debug_symbols === true };
}

/** Derive the address for a `{utxo_type: X}` destination. */
function deriveDestination(
  lwk: LwkLike,
  manifest: Manifest,
  utxoTypeName: string,
  sources: Record<string, string>,
  params: Record<string, Typed>,
  instance: Record<string, Typed>,
  network: LiquidNetwork,
): string {
  const { source, compileParams, debugSymbols } = resolveScriptParams(
    manifest,
    utxoTypeName,
    sources,
    params,
    instance,
  );
  return deriveCovenantAddress(lwk, source, compileParams, network, debugSymbols);
}

// ---- validations (Spec §12) ------------------------------------------------

/** Run the action's declared `validations`. Only `arithmetic` rules are known. */
function runValidations(action: Action, env: SwelEnv): void {
  for (const v of action.validations ?? []) {
    const rule = v as {
      id?: string;
      rule?: { type?: string; expr?: string };
      error?: { message?: string };
    };
    if (rule.rule?.type !== "arithmetic" || typeof rule.rule.expr !== "string") {
      // The spec requires refusing a manifest that leans on an extension we
      // don't implement, rather than approving a transaction whose stated
      // preconditions we skipped.
      throw new ManifestError(
        `Validation "${rule.id ?? "?"}" uses an unsupported rule type.`,
      );
    }
    if (!evalBool(rule.rule.expr, env)) {
      throw new ManifestError(rule.error?.message ?? `Validation "${rule.id ?? "?"}" failed.`);
    }
  }
}

// ---- intent string ---------------------------------------------------------

/**
 * Interpolate `{instance.X}` / `{params.X}` into the author's `ui.action` line.
 *
 * An unresolvable reference is left LITERAL on purpose: an authoring bug should
 * be visible in the approval screen, not silently rendered as an empty string
 * that changes what the sentence claims.
 */
function renderIntent(
  action: Action,
  params: Record<string, Typed>,
  instance: Record<string, Typed>,
): string | undefined {
  const tpl = action.ui?.action;
  if (!tpl) return undefined;
  return tpl.replace(/\{([^{}]+)\}/g, (whole, expr: string) => {
    const ref = expr.split(":")[0].trim(); // strip a `:symbol` display hint
    return lookupRef(ref, params, instance) ?? whole;
  });
}

// ---- entry point -----------------------------------------------------------

/**
 * Resolve a manifest action into a build plan.
 *
 * Pure apart from the injected `lwk` (which only compiles + derives addresses):
 * it touches no chain state and builds no PSET. The caller turns the plan into a
 * transaction and takes the amounts it shows the user from the built PSET, not
 * from here.
 */
export function planAction(lwk: LwkLike, input: RunnerInput): ManifestPlan {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(input.manifestText) as Record<string, unknown>;
  } catch {
    throw new ManifestError("The manifest isn't valid JSON.");
  }
  const manifest = normalizeManifest(raw);

  const chain = manifest.chain ?? "elements";
  if (chain !== "elements" && chain !== "liquid") {
    throw new ManifestError(`This manifest targets "${chain}", which Apogee can't run.`);
  }
  // Refuse extensions we don't implement rather than ignoring them — ignoring a
  // lifecycle hook means approving a transaction whose described behaviour we
  // only partly enforce.
  if (manifest.lifecycle !== undefined) {
    throw new ManifestError("This manifest uses lifecycle hooks, which Apogee doesn't support yet.");
  }

  const found = findAction(manifest, input.action);
  if (!found) throw new ManifestError(`This manifest has no action called "${input.action}".`);
  const { action, template: templateName } = found;

  if (action.on_pre_broadcast !== undefined || action.on_post_broadcast !== undefined) {
    throw new ManifestError(`Action "${input.action}" uses broadcast hooks, which aren't supported.`);
  }

  const params = resolveParams(action, input.actionParams ?? {});

  // Instance fields: computed for a constructor, loaded from the caller's
  // instance file otherwise. Either way they're resolved BEFORE any address is
  // derived, because the covenant's compile params are looked up in them.
  let instance: Record<string, Typed> = {};
  let template: ContractTemplate | undefined;
  let instanceTemplateName = templateName;
  if (templateName) {
    template = manifest.contract_templates?.[templateName];
    if (!template) throw new ManifestError(`Unknown contract template "${templateName}".`);
  }

  if (action.is_constructor) {
    if (!template || !action.create_instance) {
      throw new ManifestError(`Action "${input.action}" is a constructor with no create_instance.`);
    }
    instanceTemplateName = action.create_instance.template;
    const ctorTemplate = manifest.contract_templates?.[instanceTemplateName];
    if (!ctorTemplate) {
      throw new ManifestError(`create_instance names unknown template "${instanceTemplateName}".`);
    }
    instance = resolveInstanceFields(
      lwk,
      manifest,
      action,
      ctorTemplate,
      params,
      input.sources,
      input.network,
    );
    template = ctorTemplate;
  } else if (template) {
    if (!input.instanceText) {
      throw new ManifestError(`Action "${input.action}" needs the contract instance.`);
    }
    let rawInstance: Record<string, unknown>;
    try {
      rawInstance = JSON.parse(input.instanceText) as Record<string, unknown>;
    } catch {
      throw new ManifestError("The contract instance isn't valid JSON.");
    }
    const parsed = normalizeInstance(rawInstance);
    for (const [field, def] of Object.entries(template.fields ?? {})) {
      const value = parsed.fields[field];
      if (value === undefined) throw new ManifestError(`The instance is missing field "${field}".`);
      instance[field] = { type: def.type, value: normalizeValue(field, def.type, String(value)) };
    }
  }

  // Outputs can reference an input's amount (e.g. an output sized to
  // `some_in.amount_sat` — release the whole input). Seed the SWEL env with each
  // provided input's amount so those refs resolve. This value is the caller's
  // CLAIM; the engine sizes the real spend from the on-chain funding tx and lets
  // an unbalanced PSET fail the build, so a lie here can't profit.
  const inputAmounts: Record<string, SwelValue> = {};
  for (const [id, pi] of Object.entries(input.providedInputs ?? {})) {
    inputAmounts[`${id}.amount_sat`] = { kind: "u64", value: BigInt(pi.amount_sat) };
  }
  const env = buildEnv(params, instance, inputAmounts);
  runValidations(action, env);

  // Covenant inputs are planned (derived + witness-resolved); wallet inputs are
  // implicit — lwk selects and signs them, driven by the outputs — so planInput
  // returns null for them.
  const inputs: PlannedInput[] = [];
  for (const inp of action.inputs ?? []) {
    const planned = planInput(lwk, manifest, inp, input, params, instance, env);
    if (planned) inputs.push(planned);
  }

  const outputs: PlannedOutput[] = (action.outputs ?? []).map((o) =>
    planOutput(lwk, manifest, o, input, params, instance, env),
  );

  return {
    protocol: manifest.protocol,
    action: input.action,
    description: action.description ?? "",
    template: templateName,
    intent: renderIntent(action, params, instance),
    inputs,
    outputs,
    instance:
      action.is_constructor && instanceTemplateName
        ? {
            template: instanceTemplateName,
            fields: Object.fromEntries(Object.entries(instance).map(([k, v]) => [k, v.value])),
          }
        : undefined,
  };
}

function planOutput(
  lwk: LwkLike,
  manifest: Manifest,
  o: Output,
  input: RunnerInput,
  params: Record<string, Typed>,
  instance: Record<string, Typed>,
  env: SwelEnv,
): PlannedOutput {
  const dest = o.destination;
  let address: string | undefined;
  let utxoType: string | undefined;
  let external: boolean | undefined;
  let opReturnData: string | undefined;
  let wallet: PlannedOutput["wallet"];

  if (dest === "wallet") {
    wallet = "recipient";
  } else if (dest === "change") {
    wallet = "change";
  } else if (typeof dest === "string") {
    // A fixed literal-address destination — e.g. a beacon address named as
    // `"params.BEACON_ADDRESS"`. Resolve a params/instance reference; if it isn't
    // one, treat the string itself as the address. This is NOT a covenant we derived
    // (see `external`): it's a constant the manifest names, paid but not re-derived.
    address = lookupRef(dest, params, instance) ?? dest;
    external = true;
  } else if (typeof dest === "object" && dest !== null && "utxo_type" in dest) {
    utxoType = dest.utxo_type;
    // Per-site `compile_params` overrides are a different (formula-resolved)
    // form than the utxo_type's own map; nothing in scope uses them.
    if (dest.compile_params && Object.keys(dest.compile_params).length > 0) {
      throw new ManifestError(`Output "${o.id}": per-destination compile_params aren't supported yet.`);
    }
    address = deriveDestination(lwk, manifest, utxoType, input.sources, params, instance, input.network);
  } else if (typeof dest === "object" && dest !== null && (dest as { type?: string }).type === "op_return") {
    // An OP_RETURN metadata output — e.g. an on-chain discovery record. The
    // payload is encoded here to exact bytes; the engine attaches it via lwk's
    // Script::new_op_return (see offscreen). Carries no asset/amount.
    opReturnData = encodeOpReturnData(o, params, instance);
  } else {
    throw new ManifestError(`Output "${o.id}": unsupported destination.`);
  }

  let amountSat: bigint | undefined;
  if (typeof o.amount_sat === "string") {
    amountSat = evalU64(o.amount_sat, env);
  } else if (typeof o.amount_sat === "number") {
    amountSat = BigInt(o.amount_sat);
  } else if (o.amount_sat && typeof o.amount_sat === "object") {
    throw new ManifestError(`Output "${o.id}": min_amount isn't valid on an output.`);
  }

  // Resolve the asset reference to "lbtc" or a 64-hex id. A covenant output can
  // pay a token (an output asset named as e.g. `instance.ASSET_B`), so passing the raw
  // "instance.X" ref through to the builder would fail as an invalid asset id.
  const asset = o.asset === undefined ? "lbtc" : resolveAssetRef(o.asset, params, instance);

  return {
    id: o.id,
    description: o.description ?? "",
    address,
    utxoType,
    external,
    opReturnData,
    wallet,
    amountSat,
    asset,
    optional: o.optional === true,
    requiredIndex: o.required_index,
  };
}

/**
 * Resolve one action input.
 *
 * Returns `null` for a wallet input — lwk selects and signs those itself, so
 * there's nothing to plan. A covenant input (`{utxo_type}`) is planned: its
 * address is DERIVED (the same gate as an output destination — a lie about a
 * committed field changes the address and won't match the on-chain UTXO), and its
 * witnesses are resolved. Only keyless `simplicityhl` witnesses are in scope;
 * anything carrying a signature, an issuance, or a formula is refused rather than
 * half-built.
 */
function planInput(
  lwk: LwkLike,
  manifest: Manifest,
  inp: Input,
  input: RunnerInput,
  params: Record<string, Typed>,
  instance: Record<string, Typed>,
  env: SwelEnv,
): PlannedInput | null {
  if (inp.issuance !== undefined) {
    throw new ManifestError(`Input "${inp.id}" performs an issuance, which isn't supported.`);
  }
  if (inp.utxo_source === "wallet") {
    // Wallet inputs carry no covenant witness; a witness on one is a manifest bug.
    if (inp.witnesses && Object.keys(inp.witnesses).length > 0) {
      throw new ManifestError(`Wallet input "${inp.id}" declares witnesses, which don't apply.`);
    }
    return null;
  }
  if (typeof inp.utxo_source !== "object" || !("utxo_type" in inp.utxo_source)) {
    throw new ManifestError(`Input "${inp.id}": unsupported utxo_source.`);
  }
  const utxoType = inp.utxo_source.utxo_type;
  if (inp.utxo_source.compile_params && Object.keys(inp.utxo_source.compile_params).length > 0) {
    throw new ManifestError(`Input "${inp.id}": per-input compile_params aren't supported yet.`);
  }

  // The covenant UTXO is supplied by the caller and is never chain-discoverable by
  // the wallet, so it must be handed in. The derived address below is what makes
  // trusting the caller's outpoint safe.
  const provided = input.providedInputs?.[inp.id];
  if (!provided) {
    throw new ManifestError(`Input "${inp.id}" spends a covenant but no matching providedInput was given.`);
  }

  const { source, compileParams, debugSymbols } = resolveScriptParams(
    manifest,
    utxoType,
    input.sources,
    params,
    instance,
  );
  const address = deriveCovenantAddress(lwk, source, compileParams, input.network, debugSymbols);

  const witnesses = resolveWitnesses(inp);

  // Asset/amount are for the approval's detail leg only. The values that go into
  // the spend (the ExternalUtxo secrets) come from the on-chain funding tx, not
  // from here — the manifest's claim about a covenant it doesn't commit to is
  // not authoritative and must not be shown as verified.
  let asset = "lbtc";
  if (typeof inp.asset === "string") {
    const resolved = resolveAssetRef(inp.asset, params, instance);
    asset = resolved;
  }
  let amountSat: bigint | undefined;
  if (typeof inp.amount_sat === "string") {
    try {
      amountSat = evalU64(inp.amount_sat, env);
    } catch {
      amountSat = undefined; // display-only; a bad expr shouldn't block the spend
    }
  } else if (typeof inp.amount_sat === "number") {
    amountSat = BigInt(inp.amount_sat);
  }

  return {
    id: inp.id,
    description: inp.description ?? "",
    utxoType,
    source,
    compileParams,
    debugSymbols,
    address,
    providedInput: provided,
    witnesses,
    asset,
    amountSat,
    optional: inp.optional === true,
  };
}

/**
 * Encode an `{type: "op_return"}` output's `data.parts` to the exact byte string that
 * goes in the OP_RETURN. A layout is a fixed sequence of parts — e.g.
 * `tag(4) ‖ asset(32, internal order) ‖ amount(8, u64 LE) ‖ pubkey(32) ‖
 * timeout(4, u32 LE)` = 80 bytes — and an indexer may re-derive an address from these
 * exact bytes, so this must match the producer byte-for-byte. Each part is one of:
 *
 *   - `bytes`          — a literal hex constant (the 4-byte program tag)
 *   - `liquid.asset_id`— a 32-byte asset id, BYTE-REVERSED to internal order (the same
 *                        flip covenant.ts applies; asset ids are written display-order)
 *   - `pubkey`/`bytes32` — 32 raw bytes, as-is (never reversed)
 *   - `u8`/`u16`/`u32`/`u64` — a fixed-width integer, little-endian unless `endian: "be"`
 */
function encodeOpReturnData(
  o: Output,
  params: Record<string, Typed>,
  instance: Record<string, Typed>,
): string {
  const data = o.data as { parts?: Array<{ type?: string; value?: string; endian?: string }> } | undefined;
  const parts = data?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new ManifestError(`Output "${o.id}": op_return has no data parts.`);
  }
  const INT_WIDTH: Record<string, number> = { u8: 1, u16: 2, u32: 4, u64: 8 };
  let hex = "";
  for (const part of parts) {
    const type = String(part.type);
    // A part value is either a literal (the tag) or a params/instance reference.
    const rawValue = String(part.value ?? "");
    const resolved = lookupRef(rawValue, params, instance) ?? rawValue;
    if (type === "bytes") {
      const h = strip0x(resolved).toLowerCase();
      if (!/^[0-9a-f]*$/.test(h) || h.length % 2 !== 0) {
        throw new ManifestError(`Output "${o.id}": bytes part isn't valid hex: "${rawValue}".`);
      }
      hex += h;
    } else if (type === "liquid.asset_id") {
      hex += reverseHex32(strip0x(resolved).toLowerCase());
    } else if (type === "pubkey" || type === "bytes32") {
      const h = strip0x(resolved).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(h)) {
        throw new ManifestError(`Output "${o.id}": ${type} part isn't 32 bytes of hex.`);
      }
      hex += h;
    } else if (type in INT_WIDTH) {
      const endian = part.endian === "be" ? "be" : "le";
      hex += encodeIntBytes(resolved, INT_WIDTH[type], endian, `${o.id}/${type}`);
    } else {
      throw new ManifestError(`Output "${o.id}": op_return part type "${type}" isn't supported.`);
    }
  }
  if (hex.length / 2 > 80) {
    // Elements' default MAX_OP_RETURN_RELAY is 83 bytes for the whole scriptPubKey
    // (80 data + OP_RETURN + pushdata), so more than 80 data bytes won't relay.
    throw new ManifestError(`Output "${o.id}": op_return payload is ${hex.length / 2} bytes, over the 80-byte relay limit.`);
  }
  return hex;
}

/** Reverse a 32-byte hex string (asset ids are written display-order, stored internal). */
function reverseHex32(hex: string): string {
  const pairs = hex.match(/../g);
  if (!pairs || pairs.length !== 32) {
    throw new ManifestError(`expected 32 bytes of hex for an asset id, got ${hex.length / 2}`);
  }
  return pairs.reverse().join("");
}

/** Encode a non-negative decimal integer to fixed-width `bytes`, little- or big-endian. */
function encodeIntBytes(value: string, bytes: number, endian: "le" | "be", label: string): string {
  if (!/^[0-9]+$/.test(value.trim())) {
    throw new ManifestError(`${label}: expected a non-negative integer, got "${value}".`);
  }
  let n = BigInt(value.trim());
  const out: string[] = [];
  for (let i = 0; i < bytes; i++) {
    out.push((n & 0xffn).toString(16).padStart(2, "0"));
    n >>= 8n;
  }
  if (n !== 0n) throw new ManifestError(`${label}: value ${value} overflows ${bytes} bytes.`);
  return (endian === "le" ? out : out.reverse()).join("");
}

/** Resolve an `asset` reference ("lbtc"/"bitcoin"/64-hex/instance.X/params.X) to "lbtc" or 64-hex. */
function resolveAssetRef(
  ref: string,
  params: Record<string, Typed>,
  instance: Record<string, Typed>,
): string {
  const v = ref.trim();
  if (v === "lbtc" || v === "bitcoin") return "lbtc";
  if (/^[0-9a-fA-F]{64}$/.test(v)) return v.toLowerCase();
  const resolved = lookupRef(v, params, instance);
  if (resolved === undefined) {
    throw new ManifestError(`Couldn't resolve asset reference "${ref}".`);
  }
  if (resolved === "lbtc" || resolved === "bitcoin") return "lbtc";
  return strip0x(resolved).toLowerCase();
}

/**
 * Resolve a covenant input's witnesses to the keyless `simplicityhl` subset we
 * can finalize. A `Signature` witness (e.g. the maker's ClaimPayout) or a
 * `formula` witness is refused — Settle needs neither, and half-building one would
 * produce a transaction the covenant rejects after approval.
 */
function resolveWitnesses(inp: Input): PlannedWitness[] {
  const out: PlannedWitness[] = [];
  for (const [name, w] of Object.entries(inp.witnesses ?? {})) {
    if (w.type !== "simplicityhl") {
      throw new ManifestError(
        `Input "${inp.id}" witness "${name}" is type "${w.type}", which Apogee can't satisfy yet (keyless spends only).`,
      );
    }
    if (!w.simplicity_type) {
      throw new ManifestError(`Input "${inp.id}" witness "${name}" has no simplicity_type.`);
    }
    // Values with namespace refs (e.g. "Right(instance.X)") would need per-field
    // resolution + typing; Settle's PATH is a literal. Refuse refs rather than
    // mis-encode one.
    if (/\b(instance|params|compile_params)\./.test(w.value)) {
      throw new ManifestError(
        `Input "${inp.id}" witness "${name}" references a field, which isn't supported yet.`,
      );
    }
    out.push({ name, simplicityType: w.simplicity_type, value: w.value });
  }
  return out;
}
