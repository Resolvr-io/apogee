/* tslint:disable */
/* eslint-disable */

/**
 * Build an explicit-input/explicit-output PSET v2 from JSON and return base64.
 *
 * The production runtime must add wallet inputs, change, blinding, issuances,
 * ordering rules, and covenant witnesses. This probe demonstrates that the
 * low-level Elements PSET primitives needed for an Apogee adapter compile and run
 * independently of the reference CLI and its blocking network stack.
 */
export function build_explicit_pset_json(spec_json: string): string;

/**
 * Build the ordered multi-asset PSET used by a manifest host adapter.
 * Input unblinding secrets remain inside Apogee's engine and are used only to
 * balance confidential change outputs; they are never returned separately.
 */
export function build_manifest_pset_json(spec_json: string): string;

/**
 * Compile an in-memory SimplicityHL source and return its CMR as lowercase hex.
 *
 * This deliberately accepts source text rather than a filesystem path. An Apogee
 * bundle is an in-memory, content-addressed source map, while the current reference
 * runtime reads `.simf` files directly from disk.
 */
export function compile_cmr_from_source(source: string, arguments_json: string, include_debug_symbols: boolean): string;

/**
 * Compile an in-memory covenant and derive every address commitment Apogee needs.
 * No source, import, transaction, or UTXO is loaded by this runtime.
 */
export function compile_covenant_json(spec_json: string): string;

/**
 * Derive the asset id committed by one explicit new issuance.
 */
export function derive_issuance_asset_json(spec_json: string): string;

/**
 * Execute a finalized covenant transaction entirely from caller-supplied bytes.
 * Parent transactions are verified against every prevout before execution.
 */
export function dry_run_covenant_json(spec_json: string): void;

/**
 * Compile, satisfy, and execute a small Core-jet program in the Bit Machine.
 *
 * Real lending dry-runs use an `ElementsEnv` built from the finalized transaction
 * and all witness UTXOs. This proves the compiler and evaluator survive the
 * browser-WASM dependency boundary without claiming to be that final adapter.
 */
export function execute_core_self_test(): void;

/**
 * Finalize one Simplicity PSET input and return the updated PSET. The runtime
 * satisfies and executes the covenant against the exact transaction extracted
 * from the PSET before installing the four-item Simplicity witness stack.
 */
export function finalize_covenant_pset_json(spec_json: string): string;

/**
 * Parse one confidential wallet address into the output fields required by
 * the PSET builder without exposing the descriptor or a blinding private key.
 */
export function inspect_address_json(spec_json: string): string;

/**
 * Inspect one transaction output from caller-supplied consensus bytes. This is
 * used by Apogee's host adapter after it independently fetches the transaction;
 * covenant outputs must be explicit before their asset and amount can be trusted.
 */
export function inspect_transaction_output_json(spec_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly build_explicit_pset_json: (a: number, b: number, c: number) => void;
    readonly build_manifest_pset_json: (a: number, b: number, c: number) => void;
    readonly compile_cmr_from_source: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly compile_covenant_json: (a: number, b: number, c: number) => void;
    readonly derive_issuance_asset_json: (a: number, b: number, c: number) => void;
    readonly dry_run_covenant_json: (a: number, b: number, c: number) => void;
    readonly execute_core_self_test: (a: number) => void;
    readonly finalize_covenant_pset_json: (a: number, b: number, c: number) => void;
    readonly inspect_address_json: (a: number, b: number, c: number) => void;
    readonly inspect_transaction_output_json: (a: number, b: number, c: number) => void;
    readonly rust_0_7_free: (a: number) => void;
    readonly rust_0_7_calloc: (a: number, b: number) => number;
    readonly rust_0_7_malloc: (a: number) => number;
    readonly rustsecp256k1zkp_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1zkp_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_10_0_context_create: (a: number) => number;
    readonly rustsecp256k1_v0_10_0_context_destroy: (a: number) => void;
    readonly rustsecp256k1_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
