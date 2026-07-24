// txmanifest schema — transcribed from tx_manifest_spec/Spec.md (rev 0.4.0) and
// the Contract Templates & Instances extension (extensions/templates.md).
//
// Scope for the PoC is the `last_will` example: the core format plus contract
// templates. We do NOT cover hooks, validations-as-behaviour, issuance, or
// OP_RETURN encoding yet — those are `lending_v3` territory. Fields we don't
// implement are still typed here (so parsing doesn't lose them) but flagged.
//
// Naming: the spec renamed `classes`→`contract_templates` and `class`→`template`.
// We target current naming and accept the legacy aliases on parse (see
// normalizeManifest) so the manifest-wallet copies still load. This file uses the
// current names only.

// ---- field types (Spec §5.2) -----------------------------------------------

/** Type strings usable by ParamDefs and template fields. Each maps to a SimplicityHL primitive. */
export type FieldType =
  | "u8"
  | "u16"
  | "u32"
  | "u64"
  | "bool"
  | "bytes32" // u256, 32 raw bytes
  | "pubkey" // u256, x-only BIP340
  | "liquid.asset_id"; // u256, Liquid asset id

/**
 * Param-only extras: resolved wallet-side, never compiled into a covenant (Spec §5.2).
 * `address` is a wallet-side address; `string` is opaque text (e.g. a fixed output
 * destination like a fixed discovery beacon) that passes through untouched.
 */
export type ParamType = FieldType | "address" | "string";

// ---- top level (Spec §3) ---------------------------------------------------

export type Chain = "bitcoin" | "elements" | "liquid" | "cross-chain";

export interface Manifest {
  manifest_version: string;
  protocol: string;
  description: string;
  chain?: Chain; // default "elements"; "liquid" == "elements"
  utxo_types?: Record<string, UtxoType>;
  actions?: Record<string, Action>; // top-level actions (p2pk)
  contract_templates?: Record<string, ContractTemplate>; // extension (last_will, lending)
  // Extension fields we don't interpret yet, kept so round-trips don't drop them.
  lifecycle?: unknown;
  // Present in some examples; ignored for now.
  compile_debug_symbols?: boolean;
  simplicity_hl_version?: string;
  attestation_version?: string;
}

// ---- UTXO types (Spec §4) --------------------------------------------------

export interface UtxoType {
  description?: string;
  script: ScriptDef;
  asset?: string; // selection/validation hint
  confidential?: boolean; // impl-only; covenant outputs are always explicit
}

export interface ScriptDef {
  type: "simplicity";
  source: string; // relative path, e.g. "./last_will.simf"
  /** Wires .simf param names to manifest value expressions (Spec §4.2). */
  compile_params?: Record<string, string>;
}

// ---- actions (Spec §5) -----------------------------------------------------

export interface Action {
  description?: string;
  params?: Record<string, ParamDef>;
  inputs?: Input[];
  outputs?: Output[];
  // Contract Templates extension:
  is_constructor?: boolean;
  create_instance?: CreateInstance;
  // Extensions we reject-if-present rather than silently ignore (Spec §12):
  validations?: unknown[];
  on_pre_broadcast?: unknown;
  on_post_broadcast?: unknown;
  // impl-only, undocumented in Spec.md — the clear-signing summary. We author these.
  ui?: ActionUi;
}

export interface ParamDef {
  type: ParamType;
  description?: string;
  default?: string;
  /** Auto-fill instead of prompting (Spec §5.1). Only "wallet_key" is defined. */
  source?: { type: "wallet_key" };
}

// ---- inputs (Spec §6) ------------------------------------------------------

export interface Input {
  id: string;
  description?: string;
  /** "wallet" | { utxo_type, compile_params? } (Spec §6.1). */
  utxo_source: UtxoSource;
  asset?: string; // "lbtc" | "bitcoin" | 64-hex | instance.NAME | params.NAME
  amount_sat?: AmountSpec;
  /** Absolute index (>=0) or from-end (-1 = last). Absent from the ref Rust structs; per spec. */
  required_index?: number;
  optional?: boolean; // default false
  sequence?: SequenceSpec;
  witnesses?: Record<string, Witness>;
  issuance?: unknown; // lending_v3 territory
  ui?: UiSpec;
}

export type UtxoSource = "wallet" | { utxo_type: string; compile_params?: Record<string, string> };

export type AmountSpec = number | string | { min_amount: string };

export type SequenceSpec =
  | { relative_blocks: string | number }
  | { relative_seconds: string | number }
  | number;

// ---- outputs (Spec §7) -----------------------------------------------------

export interface Output {
  id: string;
  description?: string;
  destination: Destination;
  amount_sat?: AmountSpec; // required except where a formula supplies it
  asset?: string;
  required_index?: number;
  optional?: boolean;
  confidential?: boolean; // covenant + OP_RETURN outputs are always unblinded regardless
  data?: unknown; // OP_RETURN payload — lending_v3 territory
  ui?: UiSpec;
}

export type Destination =
  | "wallet"
  | "change"
  | string // "params.NAME"
  | { utxo_type: string; compile_params?: Record<string, string> }
  | { script_hash: string }
  | { type: "op_return" | "burn" };

// ---- witnesses (Spec §8) ---------------------------------------------------

export type Witness =
  | {
      type: "simplicityhl";
      simplicity_type?: string; // inferred from ABI if omitted
      value: string; // "0x<hex>" | "Left(())" | "Right(instance.X)" | ...
      description?: string;
    }
  | {
      type: "Signature";
      sig_type: "simplicity.sig_all_hash";
      source: { type: "wallet"; key: string }; // key: ref to a 64-hex x-only pubkey
      description?: string;
    }
  | {
      type: "formula";
      expr: string;
      description?: string;
    };

// ---- contract templates (extensions/templates.md) --------------------------

export interface ContractTemplate {
  description?: string;
  fields?: Record<string, TemplateField>;
  methods?: Record<string, Action>;
}

export interface TemplateField {
  type: FieldType; // NOT "address" — it can't be compiled into a covenant
  description?: string;
  default?: string;
}

export interface CreateInstance {
  template: string;
  /** field name → formula string OR inline tapleaf compute spec. */
  fields: Record<string, string | TapleafComputeSpec>;
}

/** Computes a covenant script hash = SHA256(scriptPubKey). templates.md §3. */
export interface TapleafComputeSpec {
  lang: "tapleaf";
  simf: string;
  params: Record<string, { value: string; type?: FieldType }>;
  depends_on?: string[];
}

// ---- instance file (templates.md §4) ---------------------------------------

export interface InstanceFile {
  template: string;
  created_by?: string;
  /** All values are strings: hex for byte types, decimal for integers. */
  fields: Record<string, string>;
  provided_inputs?: Record<string, ProvidedInput>;
}

export interface ProvidedInput {
  txid: string; // 64 hex, natural byte order
  vout: number;
  amount_sat: number;
  asset: string; // 64 hex
  issuance_entropy?: string;
}

// ---- UI hints (impl-only; manifest-wallet preview.rs) ----------------------

export interface ActionUi {
  action?: string; // one-line summary template with {instance.X} / {instance.X:symbol}
}

/** A bare string is shorthand for { label }. */
export type UiSpec = string | UiDetail;

export interface UiDetail {
  label?: string;
  role?: string;
  group?: string;
  hide?: boolean;
}

// ---- normalization ---------------------------------------------------------

/** Accept the legacy `classes`/`class` naming and fold it into current names. */
export function normalizeManifest(raw: Record<string, unknown>): Manifest {
  const m = { ...raw } as Record<string, unknown>;
  // classes → contract_templates
  if (m.classes && !m.contract_templates) {
    m.contract_templates = m.classes;
    delete m.classes;
  }
  // Within each template, the constructor's create_instance.class → .template.
  const templates = m.contract_templates as Record<string, ContractTemplate> | undefined;
  if (templates) {
    for (const tpl of Object.values(templates)) {
      for (const method of Object.values(tpl.methods ?? {})) {
        const ci = method.create_instance as (CreateInstance & { class?: string }) | undefined;
        if (ci?.class && !ci.template) {
          ci.template = ci.class;
          delete ci.class;
        }
      }
    }
  }
  return m as unknown as Manifest;
}

/** Accept the legacy instance shape `{ instance: { class, fields } }`. */
export function normalizeInstance(raw: Record<string, unknown>): InstanceFile {
  // Legacy: nested under `instance`, keyed `class`.
  const nested = raw.instance as { class?: string; template?: string; fields?: unknown } | undefined;
  if (nested && typeof nested === "object") {
    return {
      template: nested.template ?? nested.class ?? "",
      fields: (nested.fields ?? {}) as Record<string, string>,
      provided_inputs: raw.provided_inputs as InstanceFile["provided_inputs"],
      created_by: raw.created_by as string | undefined,
    };
  }
  const r = raw as Record<string, unknown> & { class?: string; template?: string };
  return {
    template: (r.template ?? r.class ?? "") as string,
    created_by: r.created_by as string | undefined,
    fields: (r.fields ?? {}) as Record<string, string>,
    provided_inputs: r.provided_inputs as InstanceFile["provided_inputs"],
  };
}

/** Find an action by name, whether top-level or under a contract template. */
export function findAction(
  manifest: Manifest,
  name: string,
): { action: Action; template?: string } | null {
  const top = manifest.actions?.[name];
  if (top) return { action: top };
  for (const [templateName, tpl] of Object.entries(manifest.contract_templates ?? {})) {
    const method = tpl.methods?.[name];
    if (method) return { action: method, template: templateName };
  }
  return null;
}
