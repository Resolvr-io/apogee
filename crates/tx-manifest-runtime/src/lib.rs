use std::{str::FromStr, sync::Arc};

use elements::{
    bitcoin::PublicKey,
    confidential::{Asset, AssetBlindingFactor, Nonce, Value, ValueBlindingFactor},
    encode::{deserialize, serialize},
    hashes::{sha256, Hash as ElementsHash, HashEngine},
    pset::{Input, Output, PartiallySignedTransaction},
    secp256k1_zkp::{Secp256k1, XOnlyPublicKey},
    taproot::{ControlBlock, TapNodeHash, TaprootMerkleBranch, TaprootSpendInfo},
    Address, AddressParams, AssetId, BlockHash, ContractHash, LockTime, OutPoint, Script, Sequence,
    Transaction, TxOut, TxOutSecrets, TxOutWitness, Txid,
};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use simplicityhl::ast::{CoreJetHinter, ElementsJetHinter};
use simplicityhl::simplicity::{
    jet::{
        elements::{ElementsEnv, ElementsUtxo},
        CoreEnv,
    },
    BitMachine,
};
use simplicityhl::{Arguments, CompiledProgram, WitnessTypes, WitnessValues};
use wasm_bindgen::prelude::*;

const NUMS_KEY_BYTES: [u8; 32] = [
    0x50, 0x92, 0x9b, 0x74, 0xc1, 0xa0, 0x49, 0x54, 0xb7, 0x8b, 0x4b, 0x60, 0x35, 0xe9, 0x7a, 0x5e,
    0x07, 0x8a, 0x5a, 0x0f, 0x28, 0xec, 0x96, 0xd5, 0x47, 0xbf, 0xee, 0x9a, 0xce, 0x80, 0x3a, 0xc0,
];

const CORE_EXECUTION_PROBE: &str = r#"
fn main() {
    let (_, sum): (bool, u32) = jet::add_32(10, 20);
    assert!(jet::eq_32(sum, 30));
}
"#;

// elements-miniscript's Wpkh::max_weight_to_satisfy(): one maximally-sized
// DER signature (including sighash and pushes) plus one compressed public key.
// Manifest execution currently supports Apogee's standard BIP84 elwpkh wallet
// descriptors only; the estimator verifies every unsigned input has that shape.
const ELWPKH_MAX_SATISFACTION_WEIGHT: usize = 107;

/// Compile an in-memory SimplicityHL source and return its CMR as lowercase hex.
///
/// This deliberately accepts source text rather than a filesystem path. An Apogee
/// bundle is an in-memory, content-addressed source map, while the current reference
/// runtime reads `.simf` files directly from disk.
#[wasm_bindgen]
pub fn compile_cmr_from_source(
    source: &str,
    arguments_json: &str,
    include_debug_symbols: bool,
) -> Result<String, JsValue> {
    compile_cmr(source, arguments_json, include_debug_symbols).map_err(js_error)
}

fn compile_cmr(
    source: &str,
    arguments_json: &str,
    include_debug_symbols: bool,
) -> Result<String, String> {
    let arguments: Arguments =
        serde_json::from_str(arguments_json).map_err(|error| error.to_string())?;
    let compiled = CompiledProgram::new(
        source,
        arguments,
        include_debug_symbols,
        Box::new(ElementsJetHinter::new()),
    )?;
    Ok(hex::encode(compiled.commit().cmr().as_ref()))
}

/// Compile an in-memory covenant and derive every address commitment Apogee needs.
/// No source, import, transaction, or UTXO is loaded by this runtime.
#[wasm_bindgen]
pub fn compile_covenant_json(spec_json: &str) -> Result<String, JsValue> {
    let spec: CovenantCompileSpec =
        serde_json::from_str(spec_json).map_err(|error| js_error(error.to_string()))?;
    let result = compile_covenant(&spec).map_err(js_error)?;
    serde_json::to_string(&result).map_err(|error| js_error(error.to_string()))
}

/// Inspect one transaction output from caller-supplied consensus bytes. This is
/// used by Apogee's host adapter after it independently fetches the transaction;
/// covenant outputs must be explicit before their asset and amount can be trusted.
#[wasm_bindgen]
pub fn inspect_transaction_output_json(spec_json: &str) -> Result<String, JsValue> {
    let spec: TransactionOutputInspectionSpec =
        serde_json::from_str(spec_json).map_err(|error| js_error(error.to_string()))?;
    let transaction: Transaction =
        decode_hex_consensus(&spec.transaction_hex, "transaction_hex").map_err(js_error)?;
    let output = transaction
        .output
        .get(spec.vout as usize)
        .ok_or_else(|| js_error(format!("transaction has no output {}", spec.vout)))?;
    let (asset, amount) = match (output.asset, output.value) {
        (Asset::Explicit(asset), Value::Explicit(amount)) => {
            (Some(asset.to_string()), Some(amount.to_string()))
        }
        _ => (None, None),
    };
    let result = TransactionOutputInspection {
        txid: transaction.txid().to_string(),
        vout: spec.vout,
        tx_out: hex::encode(serialize(output)),
        script_pub_key: hex::encode(output.script_pubkey.as_bytes()),
        asset,
        amount,
        explicit: output.asset.is_explicit() && output.value.is_explicit(),
    };
    serde_json::to_string(&result).map_err(|error| js_error(error.to_string()))
}

/// Parse one confidential wallet address into the output fields required by
/// the PSET builder without exposing the descriptor or a blinding private key.
#[wasm_bindgen]
pub fn inspect_address_json(spec_json: &str) -> Result<String, JsValue> {
    let spec: AddressInspectionSpec =
        serde_json::from_str(spec_json).map_err(|error| js_error(error.to_string()))?;
    let address = Address::from_str(&spec.address).map_err(|error| js_error(error.to_string()))?;
    let expected = network_params(&spec.network).map_err(js_error)?;
    if address.params != expected {
        return Err(js_error(
            "address belongs to a different network".to_owned(),
        ));
    }
    let blinding_public_key = address
        .blinding_pubkey
        .map(|key| key.to_string())
        .ok_or_else(|| js_error("wallet destination must be confidential".to_owned()))?;
    let result = AddressInspection {
        script_pub_key: hex::encode(address.script_pubkey().as_bytes()),
        blinding_public_key,
    };
    serde_json::to_string(&result).map_err(|error| js_error(error.to_string()))
}

/// Derive the asset id committed by one explicit new issuance.
#[wasm_bindgen]
pub fn derive_issuance_asset_json(spec_json: &str) -> Result<String, JsValue> {
    let spec: IssuanceAssetSpec =
        serde_json::from_str(spec_json).map_err(|error| js_error(error.to_string()))?;
    let txid = Txid::from_str(&spec.txid).map_err(|error| js_error(error.to_string()))?;
    let contract_hash = contract_hash(&spec.contract_hash, "contract_hash").map_err(js_error)?;
    Ok(AssetId::new_issuance(OutPoint::new(txid, spec.vout), contract_hash).to_string())
}

fn compile_covenant(spec: &CovenantCompileSpec) -> Result<CovenantCommitments, String> {
    let compiled = compile_program(&spec.source, &spec.arguments, spec.include_debug_symbols)?;
    let cmr = compiled.commit().cmr();
    let leaf_version = simplicityhl::simplicity::leaf_version();
    let tapleaf = elements::taproot::TapLeafHash::from_script(
        &Script::from(cmr.as_ref().to_vec()),
        leaf_version,
    )
    .to_byte_array();

    let extra_leaves = decode_extra_leaves(&spec.extra_leaf_payloads)?;
    let merkle_root = extra_leaves.iter().fold(tapleaf, |root, payload| {
        build_tapbranch(root, tapdata_hash(payload))
    });
    let params = network_params(&spec.network)?;
    let nums_key =
        XOnlyPublicKey::from_slice(&NUMS_KEY_BYTES).map_err(|error| error.to_string())?;
    let address = Address::p2tr(
        &Secp256k1::new(),
        nums_key,
        Some(TapNodeHash::from_byte_array(merkle_root)),
        None,
        params,
    );
    let script_pub_key = address.script_pubkey();

    Ok(CovenantCommitments {
        cmr: hex::encode(cmr.as_ref()),
        tapleaf_hash: hex::encode(tapleaf),
        merkle_root: hex::encode(merkle_root),
        script_pub_key: hex::encode(script_pub_key.as_bytes()),
        script_hash: hex::encode(sha256::Hash::hash(script_pub_key.as_bytes()).to_byte_array()),
        address: address.to_string(),
    })
}

fn compile_program(
    source: &str,
    arguments: &serde_json::Value,
    include_debug_symbols: bool,
) -> Result<CompiledProgram, String> {
    let arguments_json = serde_json::to_string(arguments).map_err(|error| error.to_string())?;
    let arguments: Arguments =
        serde_json::from_str(&arguments_json).map_err(|error| error.to_string())?;
    CompiledProgram::new(
        source,
        arguments,
        include_debug_symbols,
        Box::new(ElementsJetHinter::new()),
    )
}

/// Execute a finalized covenant transaction entirely from caller-supplied bytes.
/// Parent transactions are verified against every prevout before execution.
#[wasm_bindgen]
pub fn dry_run_covenant_json(spec_json: &str) -> Result<(), JsValue> {
    let spec: CovenantDryRunSpec =
        serde_json::from_str(spec_json).map_err(|error| js_error(error.to_string()))?;
    dry_run_covenant(&spec).map_err(js_error)
}

/// Finalize one Simplicity PSET input and return the updated PSET. The runtime
/// satisfies and executes the covenant against the exact transaction extracted
/// from the PSET before installing the four-item Simplicity witness stack.
#[wasm_bindgen]
pub fn finalize_covenant_pset_json(spec_json: &str) -> Result<String, JsValue> {
    let spec: CovenantPsetFinalizeSpec =
        serde_json::from_str(spec_json).map_err(|error| js_error(error.to_string()))?;
    finalize_covenant_pset(&spec).map_err(js_error)
}

fn finalize_covenant_pset(spec: &CovenantPsetFinalizeSpec) -> Result<String, String> {
    let mut pset = PartiallySignedTransaction::from_str(&spec.pset)
        .map_err(|error| format!("invalid pset: {error}"))?;
    let input_index = usize::try_from(spec.input_index).map_err(|_| "input_index is invalid")?;
    if input_index >= pset.inputs().len() {
        return Err(format!("input_index {} is out of range", spec.input_index));
    }
    let tx = pset.extract_tx().map_err(|error| error.to_string())?;
    let witness_utxos: Vec<TxOut> = pset
        .inputs()
        .iter()
        .enumerate()
        .map(|(index, input)| {
            input
                .witness_utxo
                .clone()
                .ok_or_else(|| format!("PSET input {index} is missing witness_utxo"))
        })
        .collect::<Result<_, _>>()?;
    let compiled = compile_program(&spec.source, &spec.arguments, spec.include_debug_symbols)?;
    let abi = compiled
        .generate_abi_meta()
        .map_err(|error| error.to_string())?;
    let cmr = compiled.commit().cmr();
    let extra_leaves = decode_extra_leaves(&spec.extra_leaf_payloads)?;
    let leaf_version = simplicityhl::simplicity::leaf_version();
    let tapleaf = elements::taproot::TapLeafHash::from_script(
        &Script::from(cmr.as_ref().to_vec()),
        leaf_version,
    )
    .to_byte_array();
    let mut merkle_root = tapleaf;
    let mut siblings = Vec::with_capacity(extra_leaves.len());
    for payload in &extra_leaves {
        let hash = tapdata_hash(payload);
        siblings.push(sha256::Hash::from_byte_array(hash));
        merkle_root = build_tapbranch(merkle_root, hash);
    }
    let secp = Secp256k1::new();
    let nums_key =
        XOnlyPublicKey::from_slice(&NUMS_KEY_BYTES).map_err(|error| error.to_string())?;
    let spend_info = TaprootSpendInfo::new_key_spend(
        &secp,
        nums_key,
        Some(TapNodeHash::from_byte_array(merkle_root)),
    );
    let control_block = ControlBlock {
        leaf_version,
        output_key_parity: spend_info.output_key_parity(),
        internal_key: nums_key,
        merkle_branch: TaprootMerkleBranch::from_inner(siblings)
            .map_err(|_| "taproot merkle branch is too long")?,
    };
    let genesis_hash =
        BlockHash::from_str(&spec.genesis_hash).map_err(|error| error.to_string())?;
    let env = ElementsEnv::new(
        Arc::new(tx),
        witness_utxos.into_iter().map(ElementsUtxo::from).collect(),
        spec.input_index,
        cmr,
        control_block.clone(),
        None,
        genesis_hash,
    );
    let witness_values =
        build_witness_values_from_types(spec.witnesses.as_ref(), &abi.witness_types)?;
    let satisfied = compiled
        .satisfy_with_env(witness_values, Some(&env))
        .map_err(|error| format!("covenant satisfaction failed: {error}"))?;
    let redeem = satisfied.redeem();
    let mut machine = BitMachine::for_program(redeem).map_err(|error| error.to_string())?;
    machine
        .exec(redeem, &env)
        .map_err(|error| format!("covenant execution failed: {error}"))?;
    let (program, witness) = redeem.to_vec_with_witness();
    pset.inputs_mut()[input_index].final_script_witness = Some(vec![
        witness,
        program,
        cmr.as_ref().to_vec(),
        control_block.serialize(),
    ]);
    Ok(pset.to_string())
}

fn dry_run_covenant(spec: &CovenantDryRunSpec) -> Result<(), String> {
    let compiled = compile_program(&spec.source, &spec.arguments, spec.include_debug_symbols)?;
    let abi = compiled
        .generate_abi_meta()
        .map_err(|error| error.to_string())?;
    let cmr = compiled.commit().cmr();
    let tx: Transaction = decode_hex_consensus(&spec.transaction_hex, "transaction_hex")?;
    let witness_utxos = resolve_witness_utxos(&tx, &spec.parent_transactions)?;
    if usize::try_from(spec.input_index).map_err(|_| "input_index is invalid")? >= tx.input.len() {
        return Err(format!("input_index {} is out of range", spec.input_index));
    }

    let extra_leaves = decode_extra_leaves(&spec.extra_leaf_payloads)?;
    let leaf_version = simplicityhl::simplicity::leaf_version();
    let tapleaf = elements::taproot::TapLeafHash::from_script(
        &Script::from(cmr.as_ref().to_vec()),
        leaf_version,
    )
    .to_byte_array();
    let mut merkle_root = tapleaf;
    let mut siblings = Vec::with_capacity(extra_leaves.len());
    for payload in &extra_leaves {
        let hash = tapdata_hash(payload);
        siblings.push(sha256::Hash::from_byte_array(hash));
        merkle_root = build_tapbranch(merkle_root, hash);
    }

    let secp = Secp256k1::new();
    let nums_key =
        XOnlyPublicKey::from_slice(&NUMS_KEY_BYTES).map_err(|error| error.to_string())?;
    let spend_info = TaprootSpendInfo::new_key_spend(
        &secp,
        nums_key,
        Some(TapNodeHash::from_byte_array(merkle_root)),
    );
    let control_block = ControlBlock {
        leaf_version,
        output_key_parity: spend_info.output_key_parity(),
        internal_key: nums_key,
        merkle_branch: TaprootMerkleBranch::from_inner(siblings)
            .map_err(|_| "taproot merkle branch is too long")?,
    };
    let genesis_hash =
        BlockHash::from_str(&spec.genesis_hash).map_err(|error| error.to_string())?;
    let utxos = witness_utxos.into_iter().map(ElementsUtxo::from).collect();
    let env = ElementsEnv::new(
        Arc::new(tx),
        utxos,
        spec.input_index,
        cmr,
        control_block,
        None,
        genesis_hash,
    );
    let witness_values =
        build_witness_values_from_types(spec.witnesses.as_ref(), &abi.witness_types)?;
    let satisfied = compiled
        .satisfy_with_env(witness_values, Some(&env))
        .map_err(|error| format!("covenant satisfaction failed: {error}"))?;
    let redeem = satisfied.redeem();
    let mut machine = BitMachine::for_program(redeem).map_err(|error| error.to_string())?;
    machine
        .exec(redeem, &env)
        .map(|_| ())
        .map_err(|error| format!("covenant execution failed: {error}"))
}

fn resolve_witness_utxos(tx: &Transaction, parent_hexes: &[String]) -> Result<Vec<TxOut>, String> {
    let mut parents = std::collections::HashMap::new();
    for (index, encoded) in parent_hexes.iter().enumerate() {
        let parent: Transaction =
            decode_hex_consensus(encoded, &format!("parent_transactions[{index}]"))?;
        let txid = parent.txid();
        if parents.insert(txid, parent).is_some() {
            return Err(format!("duplicate parent transaction {txid}"));
        }
    }
    tx.input
        .iter()
        .enumerate()
        .map(|(index, input)| {
            let prevout = input.previous_output;
            let parent = parents.get(&prevout.txid).ok_or_else(|| {
                format!(
                    "missing parent transaction {} for input {index}",
                    prevout.txid
                )
            })?;
            parent
                .output
                .get(prevout.vout as usize)
                .cloned()
                .ok_or_else(|| format!("parent {} has no output {}", prevout.txid, prevout.vout))
        })
        .collect()
}

fn decode_hex_consensus<T: elements::encode::Decodable>(
    value: &str,
    path: &str,
) -> Result<T, String> {
    let bytes = hex::decode(value).map_err(|error| format!("invalid {path} hex: {error}"))?;
    deserialize(&bytes).map_err(|error| format!("invalid {path}: {error}"))
}

/// Compile, satisfy, and execute a small Core-jet program in the Bit Machine.
///
/// Real lending dry-runs use an `ElementsEnv` built from the finalized transaction
/// and all witness UTXOs. This proves the compiler and evaluator survive the
/// browser-WASM dependency boundary without claiming to be that final adapter.
#[wasm_bindgen]
pub fn execute_core_self_test() -> Result<(), JsValue> {
    execute_core().map_err(js_error)
}

fn execute_core() -> Result<(), String> {
    let compiled = CompiledProgram::new(
        CORE_EXECUTION_PROBE,
        Arguments::default(),
        false,
        Box::new(CoreJetHinter::new()),
    )?;
    let satisfied = compiled.satisfy(WitnessValues::default())?;
    let redeem = satisfied.redeem();
    let mut machine = BitMachine::for_program(redeem).map_err(|error| error.to_string())?;
    machine
        .exec(redeem, &CoreEnv::new())
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Build an explicit-input/explicit-output PSET v2 from JSON and return base64.
///
/// The production runtime must add wallet inputs, change, blinding, issuances,
/// ordering rules, and covenant witnesses. This probe demonstrates that the
/// low-level Elements PSET primitives needed for an Apogee adapter compile and run
/// independently of the reference CLI and its blocking network stack.
#[wasm_bindgen]
pub fn build_explicit_pset_json(spec_json: &str) -> Result<String, JsValue> {
    build_explicit_pset(spec_json).map_err(js_error)
}

fn build_explicit_pset(spec_json: &str) -> Result<String, String> {
    let spec: ExplicitPsetSpec =
        serde_json::from_str(spec_json).map_err(|error| error.to_string())?;
    let input_asset = AssetId::from_str(&spec.input.asset).map_err(|error| error.to_string())?;
    let input_amount = amount(&spec.input.amount, "input.amount")?;
    let input_script = script(&spec.input.script_pub_key)?;
    let txid = Txid::from_str(&spec.input.txid).map_err(|error| error.to_string())?;

    let mut pset = PartiallySignedTransaction::new_v2();
    let mut input = Input::from_prevout(OutPoint::new(txid, spec.input.vout));
    input.witness_utxo = Some(TxOut {
        asset: Asset::Explicit(input_asset),
        value: Value::Explicit(input_amount),
        nonce: Nonce::Null,
        script_pubkey: input_script,
        witness: TxOutWitness::default(),
    });
    input.asset = Some(input_asset);
    input.amount = Some(input_amount);
    pset.add_input(input);

    let mut spent = 0u64;
    for (index, output) in spec.outputs.iter().enumerate() {
        let asset = AssetId::from_str(&output.asset).map_err(|error| error.to_string())?;
        if asset != input_asset {
            return Err(format!(
                "outputs[{index}].asset must match the probe input asset"
            ));
        }
        let output_amount = amount(&output.amount, &format!("outputs[{index}].amount"))?;
        spent = spent
            .checked_add(output_amount)
            .ok_or_else(|| "output amount overflow".to_owned())?;
        pset.add_output(Output::new_explicit(
            script(&output.script_pub_key)?,
            output_amount,
            asset,
            None,
        ));
    }

    let fee_asset = AssetId::from_str(&spec.fee.asset).map_err(|error| error.to_string())?;
    if fee_asset != input_asset {
        return Err("fee.asset must match the probe input asset".to_owned());
    }
    let fee = amount(&spec.fee.amount, "fee.amount")?;
    spent = spent
        .checked_add(fee)
        .ok_or_else(|| "fee amount overflow".to_owned())?;
    if spent != input_amount {
        return Err(format!(
            "probe input amount {input_amount} must equal outputs plus fee {spent}"
        ));
    }
    pset.add_output(Output::new_explicit(Script::new(), fee, fee_asset, None));
    Ok(pset.to_string())
}

/// Build the ordered multi-asset PSET used by a manifest host adapter.
/// Input unblinding secrets remain inside Apogee's engine and are used only to
/// balance confidential change outputs; they are never returned separately.
#[wasm_bindgen]
pub fn build_manifest_pset_json(spec_json: &str) -> Result<String, JsValue> {
    let spec: ManifestPsetSpec =
        serde_json::from_str(spec_json).map_err(|error| js_error(error.to_string()))?;
    build_manifest_pset(&spec).map_err(js_error)
}

/// Estimate the conservative signed discounted vsize and required fee for a
/// manifest PSET. Contract adapters must finalize every non-wallet input first;
/// any remaining unsigned inputs must be Apogee's standard native SegWit
/// P2WPKH. A fully finalized keyless transaction needs no added satisfaction
/// weight.
#[wasm_bindgen]
pub fn estimate_manifest_fee_json(spec_json: &str) -> Result<String, JsValue> {
    let spec: ManifestFeeEstimateSpec =
        serde_json::from_str(spec_json).map_err(|error| js_error(error.to_string()))?;
    let result = estimate_manifest_fee(&spec).map_err(js_error)?;
    serde_json::to_string(&result).map_err(|error| js_error(error.to_string()))
}

fn estimate_manifest_fee(spec: &ManifestFeeEstimateSpec) -> Result<ManifestFeeEstimate, String> {
    let pset = PartiallySignedTransaction::from_str(&spec.pset)
        .map_err(|error| format!("invalid pset: {error}"))?;
    let fee_rate = amount(&spec.fee_rate_sat_per_kvb, "fee_rate_sat_per_kvb")?;
    if fee_rate == 0 {
        return Err("fee_rate_sat_per_kvb must be greater than zero".to_owned());
    }
    if pset.inputs().is_empty() {
        return Err("manifest PSET has no inputs".to_owned());
    }

    let mut unsigned_wallet_inputs = 0usize;
    for (index, input) in pset.inputs().iter().enumerate() {
        if input.final_script_sig.is_some() || input.final_script_witness.is_some() {
            continue;
        }
        let witness_utxo = input
            .witness_utxo
            .as_ref()
            .ok_or_else(|| format!("unsigned PSET input {index} is missing witness_utxo"))?;
        if !witness_utxo.script_pubkey.is_v0_p2wpkh() {
            return Err(format!(
                "unsigned PSET input {index} is not a supported native SegWit P2WPKH wallet input"
            ));
        }
        unsigned_wallet_inputs += 1;
    }
    let transaction = pset.extract_tx().map_err(|error| error.to_string())?;
    let satisfaction_weight = unsigned_wallet_inputs
        .checked_mul(ELWPKH_MAX_SATISFACTION_WEIGHT)
        .ok_or_else(|| "wallet input satisfaction weight overflow".to_owned())?;
    let discount_weight = transaction
        .discount_weight()
        .checked_add(satisfaction_weight)
        .ok_or_else(|| "manifest transaction weight overflow".to_owned())?;
    let discount_vsize = discount_weight.div_ceil(4);
    let required_fee = (discount_vsize as u128)
        .checked_mul(u128::from(fee_rate))
        .ok_or_else(|| "manifest fee calculation overflow".to_owned())?
        .div_ceil(1000);
    let required_fee =
        u64::try_from(required_fee).map_err(|_| "manifest required fee exceeds u64".to_owned())?;

    Ok(ManifestFeeEstimate {
        discount_vsize,
        required_fee: required_fee.to_string(),
        unsigned_wallet_inputs,
    })
}

fn build_manifest_pset(spec: &ManifestPsetSpec) -> Result<String, String> {
    if spec.inputs.is_empty() {
        return Err("manifest PSET must contain at least one input".to_owned());
    }
    let fee_output_index = spec
        .fee
        .output_index
        .map(|index| index as usize)
        .unwrap_or(spec.outputs.len());
    if fee_output_index > spec.outputs.len() {
        return Err(format!(
            "fee.output_index {fee_output_index} is out of range for {} non-fee outputs",
            spec.outputs.len()
        ));
    }
    let mut pset = PartiallySignedTransaction::new_v2();
    if let Some(locktime) = spec.locktime {
        pset.global.tx_data.fallback_locktime = Some(LockTime::from_consensus(locktime));
    }
    let mut secrets = std::collections::HashMap::with_capacity(spec.inputs.len());
    let mut balances = std::collections::HashMap::<AssetId, u128>::new();

    for (index, entry) in spec.inputs.iter().enumerate() {
        let txid = Txid::from_str(&entry.txid)
            .map_err(|error| format!("invalid inputs[{index}].txid: {error}"))?;
        let witness_utxo: TxOut =
            decode_hex_consensus(&entry.tx_out, &format!("inputs[{index}].tx_out"))?;
        let asset = AssetId::from_str(&entry.asset)
            .map_err(|error| format!("invalid inputs[{index}].asset: {error}"))?;
        let input_amount = amount(&entry.amount, &format!("inputs[{index}].amount"))?;
        *balances.entry(asset).or_default() += u128::from(input_amount);
        let mut input = Input::from_prevout(OutPoint::new(txid, entry.vout));
        input.asset = Some(asset);
        input.amount = Some(input_amount);
        input.sequence = entry.sequence.map(Sequence);

        if let Some(issuance) = &entry.issuance {
            let contract_hash = contract_hash(
                &issuance.contract_hash,
                &format!("inputs[{index}].issuance.contract_hash"),
            )?;
            let issuance_amount = amount(
                &issuance.asset_amount,
                &format!("inputs[{index}].issuance.asset_amount"),
            )?;
            if issuance_amount == 0 {
                return Err(format!(
                    "inputs[{index}].issuance.asset_amount must be greater than zero"
                ));
            }
            let issued_asset =
                AssetId::new_issuance(OutPoint::new(txid, entry.vout), contract_hash);
            *balances.entry(issued_asset).or_default() += u128::from(issuance_amount);
            input.issuance_value_amount = Some(issuance_amount);
            // An issuance with no reissuance tokens must encode a null token
            // amount. Encoding an explicit zero creates an invalid Elements
            // value commitment and nodes reject the transaction as unbalanced.
            input.issuance_inflation_keys = None;
            input.issuance_blinding_nonce = Some(elements::secp256k1_zkp::ZERO_TWEAK);
            input.issuance_asset_entropy = Some(contract_hash.to_byte_array());
            input.blinded_issuance = Some(0);
        }

        let (asset_bf, value_bf) = match (
            entry.asset_blinding_factor.as_deref(),
            entry.value_blinding_factor.as_deref(),
        ) {
            (None, None) => (AssetBlindingFactor::zero(), ValueBlindingFactor::zero()),
            (Some(asset_bf), Some(value_bf)) => {
                let asset_bf = AssetBlindingFactor::from_str(asset_bf).map_err(|error| {
                    format!("invalid inputs[{index}].asset_blinding_factor: {error}")
                })?;
                let value_bf = ValueBlindingFactor::from_str(value_bf).map_err(|error| {
                    format!("invalid inputs[{index}].value_blinding_factor: {error}")
                })?;
                input.set_abf(asset_bf);
                (asset_bf, value_bf)
            }
            _ => {
                return Err(format!(
                "inputs[{index}] must provide both asset_blinding_factor and value_blinding_factor"
            ))
            }
        };
        validate_input_secrets(
            &witness_utxo,
            asset,
            input_amount,
            asset_bf,
            value_bf,
            index,
        )?;
        input.witness_utxo = Some(witness_utxo);
        secrets.insert(
            index,
            TxOutSecrets::new(asset, asset_bf, input_amount, value_bf),
        );
        pset.add_input(input);
    }

    let mut has_blinded_output = false;
    for (index, entry) in spec.outputs.iter().enumerate() {
        let asset = AssetId::from_str(&entry.asset)
            .map_err(|error| format!("invalid outputs[{index}].asset: {error}"))?;
        let amount = amount(&entry.amount, &format!("outputs[{index}].amount"))?;
        spend_balance(&mut balances, asset, amount, &format!("outputs[{index}]"))?;
        let script_pubkey = script(&entry.script_pub_key)?;
        if script_pubkey.is_empty() {
            return Err(format!(
                "outputs[{index}].script_pub_key must not be empty; use the fee field for the sole Elements fee output"
            ));
        }
        let blinding_key = entry
            .blinding_public_key
            .as_deref()
            .map(PublicKey::from_str)
            .transpose()
            .map_err(|error| format!("invalid outputs[{index}].blinding_public_key: {error}"))?;
        let mut output = Output::new_explicit(script_pubkey, amount, asset, blinding_key);
        match (output.blinding_key, entry.blinder_index) {
            (Some(_), Some(blinder_index)) if (blinder_index as usize) < spec.inputs.len() => {
                output.blinder_index = Some(blinder_index);
                has_blinded_output = true;
            }
            (Some(_), Some(_)) => {
                return Err(format!("outputs[{index}].blinder_index is out of range"));
            }
            (Some(_), None) => {
                return Err(format!("outputs[{index}].blinder_index is required"));
            }
            (None, Some(_)) => {
                return Err(format!(
                    "outputs[{index}].blinder_index requires blinding_public_key"
                ));
            }
            (None, None) => {}
        }
        pset.add_output(output);
    }

    let fee_asset = AssetId::from_str(&spec.fee.asset)
        .map_err(|error| format!("invalid fee.asset: {error}"))?;
    let fee_amount = amount(&spec.fee.amount, "fee.amount")?;
    spend_balance(&mut balances, fee_asset, fee_amount, "fee")?;
    pset.insert_output(
        Output::new_explicit(Script::new(), fee_amount, fee_asset, None),
        fee_output_index,
    );

    if has_blinded_output {
        pset.blind_last(&mut OsRng, &Secp256k1::new(), &secrets)
            .map_err(|error| format!("PSET blinding failed: {error}"))?;
    }
    validate_manifest_fee_output(&pset, fee_output_index, fee_asset, fee_amount)?;
    if let Some((asset, remainder)) = balances.iter().find(|(_, amount)| **amount != 0) {
        return Err(format!(
            "manifest PSET is unbalanced for asset {asset}: {remainder} input units remain"
        ));
    }
    pset.sanity_check().map_err(|error| error.to_string())?;
    Ok(pset.to_string())
}

fn validate_manifest_fee_output(
    pset: &PartiallySignedTransaction,
    expected_index: usize,
    expected_asset: AssetId,
    expected_amount: u64,
) -> Result<(), String> {
    let fee_indices = pset
        .outputs()
        .iter()
        .enumerate()
        .filter_map(|(index, output)| output.script_pubkey.is_empty().then_some(index))
        .collect::<Vec<_>>();
    if fee_indices != [expected_index] {
        return Err(format!(
            "manifest PSET must contain exactly one Elements fee output at index {expected_index}"
        ));
    }
    let fee = &pset.outputs()[expected_index];
    if fee.asset != Some(expected_asset)
        || fee.amount != Some(expected_amount)
        || fee.asset_comm.is_some()
        || fee.amount_comm.is_some()
        || fee.blinding_key.is_some()
        || fee.ecdh_pubkey.is_some()
        || fee.blinder_index.is_some()
        || fee.value_rangeproof.is_some()
        || fee.asset_surjection_proof.is_some()
        || fee.blind_value_proof.is_some()
        || fee.blind_asset_proof.is_some()
    {
        return Err(format!(
            "manifest PSET fee output at index {expected_index} must be explicit and unblinded"
        ));
    }
    Ok(())
}

fn validate_input_secrets(
    tx_out: &TxOut,
    asset: AssetId,
    amount: u64,
    asset_bf: AssetBlindingFactor,
    value_bf: ValueBlindingFactor,
    index: usize,
) -> Result<(), String> {
    let secp = Secp256k1::new();
    let expected_asset = Asset::new_confidential(&secp, asset, asset_bf);
    match tx_out.asset {
        Asset::Explicit(actual) if actual == asset && asset_bf == AssetBlindingFactor::zero() => {}
        Asset::Confidential(actual) if expected_asset.commitment() == Some(actual) => {}
        _ => {
            return Err(format!(
                "inputs[{index}] asset/unblinding data does not match tx_out"
            ))
        }
    }
    let expected_value = Value::new_confidential(
        &secp,
        amount,
        expected_asset
            .commitment()
            .expect("confidential asset commitment"),
        value_bf,
    );
    match tx_out.value {
        Value::Explicit(actual) if actual == amount && value_bf == ValueBlindingFactor::zero() => {}
        Value::Confidential(actual) if expected_value.commitment() == Some(actual) => {}
        _ => {
            return Err(format!(
                "inputs[{index}] amount/unblinding data does not match tx_out"
            ))
        }
    }
    Ok(())
}

fn spend_balance(
    balances: &mut std::collections::HashMap<AssetId, u128>,
    asset: AssetId,
    amount: u64,
    path: &str,
) -> Result<(), String> {
    let available = balances.entry(asset).or_default();
    let amount = u128::from(amount);
    if *available < amount {
        return Err(format!(
            "{path} spends more asset {asset} than the inputs provide"
        ));
    }
    *available -= amount;
    Ok(())
}

fn contract_hash(value: &str, path: &str) -> Result<ContractHash, String> {
    let bytes = hex::decode(value).map_err(|error| format!("invalid {path}: {error}"))?;
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| format!("invalid {path}: expected 32 bytes"))?;
    Ok(ContractHash::from_byte_array(bytes))
}

fn script(value: &str) -> Result<Script, String> {
    hex::decode(value)
        .map(Script::from)
        .map_err(|error| format!("invalid script hex: {error}"))
}

fn amount(value: &str, path: &str) -> Result<u64, String> {
    value
        .parse::<u64>()
        .map_err(|_| format!("{path} must be an unsigned 64-bit decimal string"))
}

fn js_error(error: String) -> JsValue {
    JsValue::from_str(&error)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CovenantCompileSpec {
    source: String,
    #[serde(default)]
    arguments: serde_json::Value,
    #[serde(default)]
    extra_leaf_payloads: Vec<String>,
    network: String,
    #[serde(default)]
    include_debug_symbols: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TransactionOutputInspectionSpec {
    transaction_hex: String,
    vout: u32,
}

#[derive(Serialize)]
struct TransactionOutputInspection {
    txid: String,
    vout: u32,
    tx_out: String,
    script_pub_key: String,
    asset: Option<String>,
    amount: Option<String>,
    explicit: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AddressInspectionSpec {
    address: String,
    network: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IssuanceAssetSpec {
    txid: String,
    vout: u32,
    contract_hash: String,
}

#[derive(Serialize)]
struct AddressInspection {
    script_pub_key: String,
    blinding_public_key: String,
}

#[derive(Serialize)]
struct CovenantCommitments {
    cmr: String,
    tapleaf_hash: String,
    merkle_root: String,
    script_pub_key: String,
    script_hash: String,
    address: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CovenantDryRunSpec {
    source: String,
    #[serde(default)]
    arguments: serde_json::Value,
    #[serde(default)]
    extra_leaf_payloads: Vec<String>,
    witnesses: Option<serde_json::Value>,
    transaction_hex: String,
    parent_transactions: Vec<String>,
    input_index: u32,
    genesis_hash: String,
    #[serde(default)]
    include_debug_symbols: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CovenantPsetFinalizeSpec {
    pset: String,
    source: String,
    #[serde(default)]
    arguments: serde_json::Value,
    #[serde(default)]
    extra_leaf_payloads: Vec<String>,
    witnesses: Option<serde_json::Value>,
    input_index: u32,
    genesis_hash: String,
    #[serde(default)]
    include_debug_symbols: bool,
}

fn decode_extra_leaves(values: &[String]) -> Result<Vec<Vec<u8>>, String> {
    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            hex::decode(value.trim_start_matches("0x"))
                .map_err(|error| format!("invalid extra_leaf_payloads[{index}]: {error}"))
        })
        .collect()
}

fn network_params(network: &str) -> Result<&'static AddressParams, String> {
    match network {
        "liquid" => Ok(&AddressParams::LIQUID),
        "liquid-testnet" => Ok(&AddressParams::LIQUID_TESTNET),
        "elements-regtest" => Ok(&AddressParams::ELEMENTS),
        _ => Err(format!("unsupported network '{network}'")),
    }
}

fn tapdata_hash(data: &[u8]) -> [u8; 32] {
    tagged_hash(b"TapData", &[data])
}

fn build_tapbranch(a: [u8; 32], b: [u8; 32]) -> [u8; 32] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    tagged_hash(b"TapBranch/elements", &[&lo, &hi])
}

fn tagged_hash(tag: &[u8], values: &[&[u8]]) -> [u8; 32] {
    let tag_hash = sha256::Hash::hash(tag);
    let mut engine = sha256::HashEngine::default();
    engine.input(tag_hash.as_ref());
    engine.input(tag_hash.as_ref());
    for value in values {
        engine.input(value);
    }
    sha256::Hash::from_engine(engine).to_byte_array()
}

fn build_witness_values_from_types(
    witnesses: Option<&serde_json::Value>,
    witness_types: &WitnessTypes,
) -> Result<WitnessValues, String> {
    use simplicityhl::{parse::ParseFromStr as _, str::WitnessName, value::Value};

    let mut map = std::collections::HashMap::new();
    if let Some(values) = witnesses.and_then(serde_json::Value::as_object) {
        for (name, definition) in values {
            if definition.get("type").and_then(serde_json::Value::as_str) != Some("simplicityhl") {
                return Err(format!("witness '{name}' must have type 'simplicityhl'"));
            }
            let value_text = definition
                .get("value")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| format!("witness '{name}' must have a string value"))?;
            let witness_name = WitnessName::parse_from_str(name)
                .map_err(|error| format!("invalid witness name '{name}': {error}"))?;
            let ty = witness_types
                .get(&witness_name)
                .ok_or_else(|| format!("witness '{name}' is not declared by the program"))?;
            let value = Value::parse_from_str(value_text, ty)
                .map_err(|error| format!("invalid witness '{name}': {error}"))?;
            map.insert(witness_name, value);
        }
    }
    for (name, ty) in witness_types.iter() {
        if !map.contains_key(name) {
            map.insert(name.shallow_clone(), zero_value_for_type(ty));
        }
    }
    Ok(WitnessValues::from(map))
}

fn zero_value_for_type(ty: &simplicityhl::ResolvedType) -> simplicityhl::Value {
    use simplicityhl::{
        num::U256,
        types::{TypeInner, UIntType},
        value::{UIntValue, Value, ValueConstructible},
    };

    match ty.as_inner() {
        TypeInner::Boolean => Value::from(false),
        TypeInner::UInt(uint_ty) => Value::from(match uint_ty {
            UIntType::U1 => UIntValue::U1(0),
            UIntType::U2 => UIntValue::U2(0),
            UIntType::U4 => UIntValue::U4(0),
            UIntType::U8 => UIntValue::U8(0),
            UIntType::U16 => UIntValue::U16(0),
            UIntType::U32 => UIntValue::U32(0),
            UIntType::U64 => UIntValue::U64(0),
            UIntType::U128 => UIntValue::U128(0),
            UIntType::U256 => UIntValue::U256(U256::from_byte_array([0; 32])),
        }),
        TypeInner::Tuple(elements) => {
            Value::tuple(elements.iter().map(|element| zero_value_for_type(element)))
        }
        TypeInner::Either(left, right) => Value::left(zero_value_for_type(left), (**right).clone()),
        TypeInner::Option(inner) => Value::none((**inner).clone()),
        TypeInner::Array(element, size) => Value::array(
            (0..*size)
                .map(|_| zero_value_for_type(element))
                .collect::<Vec<_>>(),
            (**element).clone(),
        ),
        TypeInner::List(element, bound) => {
            Value::list(std::iter::empty(), (**element).clone(), *bound)
        }
        _ => Value::unit(),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExplicitPsetSpec {
    input: ExplicitInput,
    outputs: Vec<ExplicitOutput>,
    fee: ExplicitFee,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExplicitInput {
    txid: String,
    vout: u32,
    asset: String,
    amount: String,
    script_pub_key: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExplicitOutput {
    asset: String,
    amount: String,
    script_pub_key: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExplicitFee {
    asset: String,
    amount: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestPsetSpec {
    inputs: Vec<ManifestPsetInput>,
    outputs: Vec<ManifestPsetOutput>,
    fee: ManifestFee,
    locktime: Option<u32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestFee {
    asset: String,
    amount: String,
    output_index: Option<u32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestPsetInput {
    txid: String,
    vout: u32,
    tx_out: String,
    asset: String,
    amount: String,
    asset_blinding_factor: Option<String>,
    value_blinding_factor: Option<String>,
    sequence: Option<u32>,
    issuance: Option<ManifestPsetIssuance>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestPsetIssuance {
    contract_hash: String,
    asset_amount: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestPsetOutput {
    script_pub_key: String,
    asset: String,
    amount: String,
    blinding_public_key: Option<String>,
    blinder_index: Option<u32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestFeeEstimateSpec {
    pset: String,
    fee_rate_sat_per_kvb: String,
}

#[derive(Serialize)]
struct ManifestFeeEstimate {
    discount_vsize: usize,
    required_fee: String,
    unsigned_wallet_inputs: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    const POLICY_ASSET: &str = "144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49";
    const PRINCIPAL_ASSET: &str =
        "38fca2d939696061a8f76d4e6b5eecd54e3b4221c846f24a6b279e79952850a5";
    const BORROWER_NFT: &str = "8734a76badb98fd22150ec9a537684dd3824c30d80b2bcc1f4b0ff635fa8d97c";
    const LENDER_NFT: &str = "99396282d5ef54a51a1d9ceebd20710b6eb9a47055b275db4e8d1a7334c14502";
    const ASSET_AUTH: &str = include_str!(
        "../../../src/tx-manifest/builtins/simplicity-lending-v3/sources/asset_auth.simf"
    );
    const ASSET_AUTH_VAULT: &str = include_str!(
        "../../../src/tx-manifest/builtins/simplicity-lending-v3/sources/asset_auth_vault.simf"
    );
    const LENDING: &str = include_str!(
        "../../../src/tx-manifest/builtins/simplicity-lending-v3/sources/lending.simf"
    );
    const SCRIPT_AUTH: &str = include_str!(
        "../../../src/tx-manifest/builtins/simplicity-lending-v3/sources/script_auth.simf"
    );
    const ACCEPTANCE_TX: &str = include_str!(
        "../fixtures/e69e0e401919dcd8a4721f3d33cd044375080d9578905a456d097c73f6d39231.hex"
    );
    const OFFER_TX: &str = include_str!(
        "../fixtures/baa0de011d4addd0ab4bf0b00c34bb797f67487be7517136af04ac39b184bff1.hex"
    );
    const PRINCIPAL_PARENT_TX: &str = include_str!(
        "../fixtures/224160fb671be79394438747de2313bdc01c56d8f02a91bf5609e40f4f4bf3d3.hex"
    );
    const FEE_PARENT_TX: &str = include_str!(
        "../fixtures/16b28b36dbba9115a97a0f90dc65585715b9637b6206adaaf871ff9e216f2ab4.hex"
    );

    fn pinned_source(source: &str) -> &str {
        source
            .strip_suffix('\n')
            .expect("bundled checkout adds one LF to the no-final-newline upstream source")
    }

    fn argument(value: impl Into<String>, ty: &str) -> serde_json::Value {
        serde_json::json!({ "value": value.into(), "type": ty })
    }

    fn reversed_asset(asset: &str) -> String {
        let bytes = hex::decode(asset).unwrap();
        format!(
            "0x{}",
            bytes
                .into_iter()
                .rev()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        )
    }

    fn commitments(
        source: &str,
        entries: Vec<(&str, serde_json::Value)>,
        extra_leaf_payloads: Vec<String>,
    ) -> CovenantCommitments {
        let arguments = serde_json::Value::Object(
            entries
                .into_iter()
                .map(|(name, value)| (name.to_owned(), value))
                .collect(),
        );
        compile_covenant(&CovenantCompileSpec {
            source: source.to_owned(),
            arguments,
            extra_leaf_payloads,
            network: "liquid-testnet".to_owned(),
            include_debug_symbols: true,
        })
        .unwrap()
    }

    fn vault(
        keeper: &str,
        active: bool,
        keeper_burn: bool,
        finalized_hash: &str,
    ) -> CovenantCommitments {
        commitments(
            pinned_source(ASSET_AUTH_VAULT),
            vec![
                (
                    "VAULT_ASSET_ID",
                    argument(reversed_asset(PRINCIPAL_ASSET), "u256"),
                ),
                (
                    "KEEPER_AUTH_ASSET_ID",
                    argument(reversed_asset(keeper), "u256"),
                ),
                (
                    "SUPPLIER_AUTH_ASSET_ID",
                    argument(reversed_asset(BORROWER_NFT), "u256"),
                ),
                ("KEEPER_AUTH_ASSET_AMOUNT", argument("1", "u64")),
                (
                    "FINALIZED_VAULT_COV_HASH",
                    argument(format!("0x{finalized_hash}"), "u256"),
                ),
                ("IS_ACTIVE", argument(active.to_string(), "bool")),
                (
                    "WITH_KEEPER_ASSET_BURN",
                    argument(keeper_burn.to_string(), "bool"),
                ),
                ("WITH_SUPPLIER_ASSET_BURN", argument("true", "bool")),
            ],
            vec![],
        )
    }

    fn lending_vector() -> (serde_json::Value, CovenantCommitments, CovenantCommitments) {
        let zero = "00".repeat(32);
        let finalized_lender = vault(LENDER_NFT, false, true, &zero);
        let lender = vault(LENDER_NFT, true, true, &finalized_lender.script_hash);
        let finalized_protocol = vault(PRINCIPAL_ASSET, false, false, &zero);
        let protocol = vault(
            PRINCIPAL_ASSET,
            true,
            false,
            &finalized_protocol.script_hash,
        );
        let principal = commitments(
            pinned_source(ASSET_AUTH),
            vec![
                ("ASSET_ID", argument(reversed_asset(BORROWER_NFT), "u256")),
                ("ASSET_AMOUNT", argument("1", "u64")),
                ("WITH_ASSET_BURN", argument("false", "bool")),
            ],
            vec![],
        );
        let entries = vec![
            (
                "COLLATERAL_ASSET_ID",
                argument(reversed_asset(POLICY_ASSET), "u256"),
            ),
            (
                "PRINCIPAL_ASSET_ID",
                argument(reversed_asset(PRINCIPAL_ASSET), "u256"),
            ),
            (
                "BORROWER_NFT_ASSET_ID",
                argument(reversed_asset(BORROWER_NFT), "u256"),
            ),
            (
                "LENDER_NFT_ASSET_ID",
                argument(reversed_asset(LENDER_NFT), "u256"),
            ),
            ("COLLATERAL_AMOUNT", argument("1000", "u64")),
            ("PRINCIPAL_AMOUNT", argument("100", "u64")),
            ("PRINCIPAL_INTEREST_RATE", argument("10000", "u64")),
            ("LOAN_EXPIRATION_TIME", argument("2604140", "u32")),
            (
                "LENDER_VAULT_COV_HASH",
                argument(format!("0x{}", lender.script_hash), "u256"),
            ),
            (
                "FINALIZED_LENDER_VAULT_COV_HASH",
                argument(format!("0x{}", finalized_lender.script_hash), "u256"),
            ),
            (
                "PROTOCOL_FEE_VAULT_COV_HASH",
                argument(format!("0x{}", protocol.script_hash), "u256"),
            ),
            (
                "FINALIZED_PROTOCOL_FEE_VAULT_COV_HASH",
                argument(format!("0x{}", finalized_protocol.script_hash), "u256"),
            ),
            (
                "PRINCIPAL_OUTPUT_SCRIPT_HASH",
                argument(format!("0x{}", principal.script_hash), "u256"),
            ),
        ];
        let arguments = serde_json::Value::Object(
            entries
                .clone()
                .into_iter()
                .map(|(name, value)| (name.to_owned(), value))
                .collect(),
        );
        let debt = format!("{}{:016x}", "00".repeat(24), 200u64);
        let pending = commitments(
            pinned_source(LENDING),
            entries.clone(),
            vec!["00".repeat(32), debt.clone()],
        );
        let active = commitments(
            pinned_source(LENDING),
            entries,
            vec![format!("{}01", "00".repeat(31)), debt],
        );
        (arguments, pending, active)
    }

    #[test]
    fn compiles_source_from_memory() {
        let cmr = compile_cmr("fn main() { assert!(true); }", "{}", true).unwrap();
        assert_eq!(cmr.len(), 64);
        assert!(cmr.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn compiles_p2pk_elements_jets_from_memory() {
        let source = r#"
fn main() {
    let sig: Signature = witness::SIGNATURE;
    jet::bip_0340_verify((param::PUB_KEY, jet::sig_all_hash()), sig);
}
"#;
        let arguments = serde_json::json!({
            "PUB_KEY": {
                "value": "0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
                "type": "u256"
            }
        });
        let cmr = compile_cmr(source, &arguments.to_string(), true).unwrap();
        assert_eq!(cmr.len(), 64);
    }

    #[test]
    fn executes_simplicity_core_program() {
        execute_core().unwrap();
    }

    #[test]
    fn inspects_caller_supplied_transaction_outputs() {
        let encoded = inspect_transaction_output_json(
            &serde_json::json!({
                "transaction_hex": OFFER_TX.trim(),
                "vout": 0,
            })
            .to_string(),
        )
        .unwrap();
        let inspected: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(
            inspected["txid"],
            "baa0de011d4addd0ab4bf0b00c34bb797f67487be7517136af04ac39b184bff1"
        );
        assert_eq!(inspected["vout"], 0);
        assert_eq!(inspected["explicit"], true);
        assert!(inspected["tx_out"].as_str().unwrap().len() > 80);
    }

    #[test]
    fn inspects_confidential_wallet_destinations() {
        let generator = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
        let spend_key = elements::bitcoin::PublicKey::from_str(generator).unwrap();
        let blinding_key = elements::secp256k1_zkp::PublicKey::from_str(generator).unwrap();
        let address = Address::p2wpkh(
            &spend_key,
            Some(blinding_key),
            &AddressParams::LIQUID_TESTNET,
        );
        let encoded = inspect_address_json(
            &serde_json::json!({
                "address": address.to_string(),
                "network": "liquid-testnet",
            })
            .to_string(),
        )
        .unwrap();
        let inspected: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(inspected["blinding_public_key"], generator);
        assert_eq!(inspected["script_pub_key"].as_str().unwrap().len(), 44);
    }

    #[test]
    fn builds_balanced_explicit_pset_v2() {
        let spec = serde_json::json!({
            "input": {
                "txid": "00".repeat(32),
                "vout": 0,
                "asset": POLICY_ASSET,
                "amount": "1000",
                "script_pub_key": "51"
            },
            "outputs": [{
                "asset": POLICY_ASSET,
                "amount": "900",
                "script_pub_key": "51"
            }],
            "fee": {
                "asset": POLICY_ASSET,
                "amount": "100"
            }
        });
        let encoded = build_explicit_pset(&spec.to_string()).unwrap();
        let parsed = PartiallySignedTransaction::from_str(&encoded).unwrap();
        assert_eq!(parsed.inputs().len(), 1);
        assert_eq!(parsed.outputs().len(), 2);
    }

    #[test]
    fn estimates_unsigned_elwpkh_manifest_fees() {
        let wallet_script = format!("0014{}", "11".repeat(20));
        let spec = serde_json::json!({
            "input": {
                "txid": "00".repeat(32),
                "vout": 0,
                "asset": POLICY_ASSET,
                "amount": "1000",
                "script_pub_key": wallet_script
            },
            "outputs": [{
                "asset": POLICY_ASSET,
                "amount": "900",
                "script_pub_key": "51"
            }],
            "fee": {
                "asset": POLICY_ASSET,
                "amount": "100"
            }
        });
        let pset = build_explicit_pset(&spec.to_string()).unwrap();
        let parsed = PartiallySignedTransaction::from_str(&pset).unwrap();
        let expected_vsize = (parsed.extract_tx().unwrap().discount_weight()
            + ELWPKH_MAX_SATISFACTION_WEIGHT)
            .div_ceil(4);
        let estimate = estimate_manifest_fee(&ManifestFeeEstimateSpec {
            pset,
            fee_rate_sat_per_kvb: "1000".to_owned(),
        })
        .unwrap();
        assert_eq!(estimate.discount_vsize, expected_vsize);
        assert_eq!(estimate.required_fee, expected_vsize.to_string());
        assert_eq!(estimate.unsigned_wallet_inputs, 1);
    }

    #[test]
    fn estimates_fully_finalized_keyless_manifest_fees() {
        let wallet_script = format!("0014{}", "11".repeat(20));
        let spec = serde_json::json!({
            "input": {
                "txid": "00".repeat(32),
                "vout": 0,
                "asset": POLICY_ASSET,
                "amount": "1000",
                "script_pub_key": wallet_script
            },
            "outputs": [{
                "asset": POLICY_ASSET,
                "amount": "900",
                "script_pub_key": "51"
            }],
            "fee": {
                "asset": POLICY_ASSET,
                "amount": "100"
            }
        });
        let encoded = build_explicit_pset(&spec.to_string()).unwrap();
        let mut parsed = PartiallySignedTransaction::from_str(&encoded).unwrap();
        parsed.inputs_mut()[0].final_script_witness =
            Some(vec![vec![0x30; 72], vec![0x02; 33]]);
        let expected_vsize = parsed.extract_tx().unwrap().discount_vsize();
        let estimate = estimate_manifest_fee(&ManifestFeeEstimateSpec {
            pset: parsed.to_string(),
            fee_rate_sat_per_kvb: "1000".to_owned(),
        })
        .unwrap();
        assert_eq!(estimate.discount_vsize, expected_vsize);
        assert_eq!(estimate.required_fee, expected_vsize.to_string());
        assert_eq!(estimate.unsigned_wallet_inputs, 0);
    }

    #[test]
    fn estimates_real_acceptance_at_or_above_its_signed_vsize() {
        let original: Transaction =
            decode_hex_consensus(ACCEPTANCE_TX.trim(), "acceptance").unwrap();
        let parents = vec![
            OFFER_TX.trim().to_owned(),
            PRINCIPAL_PARENT_TX.trim().to_owned(),
            FEE_PARENT_TX.trim().to_owned(),
        ];
        let witness_utxos = resolve_witness_utxos(&original, &parents).unwrap();
        let mut pset = PartiallySignedTransaction::from_tx(original.clone());
        for (input, witness_utxo) in pset.inputs_mut().iter_mut().zip(witness_utxos) {
            input.witness_utxo = Some(witness_utxo);
        }
        for index in [2usize, 3usize] {
            pset.inputs_mut()[index].final_script_sig = None;
            pset.inputs_mut()[index].final_script_witness = None;
        }
        let estimate = estimate_manifest_fee(&ManifestFeeEstimateSpec {
            pset: pset.to_string(),
            fee_rate_sat_per_kvb: "1000".to_owned(),
        })
        .unwrap();
        assert_eq!(estimate.unsigned_wallet_inputs, 2);
        assert!(estimate.discount_vsize >= original.discount_vsize());
        assert!(estimate.discount_vsize <= original.discount_vsize() + 2);
    }

    #[test]
    fn builds_ordered_balanced_multi_asset_manifest_pset() {
        let tx_out = |asset: &str, amount: u64| {
            elements::encode::serialize_hex(&TxOut {
                asset: Asset::Explicit(AssetId::from_str(asset).unwrap()),
                value: Value::Explicit(amount),
                nonce: Nonce::Null,
                script_pubkey: Script::from(vec![0x51]),
                witness: TxOutWitness::default(),
            })
        };
        let spec = serde_json::json!({
            "inputs": [
                {
                    "txid": "11".repeat(32), "vout": 0,
                    "tx_out": tx_out(POLICY_ASSET, 100),
                    "asset": POLICY_ASSET, "amount": "100"
                },
                {
                    "txid": "22".repeat(32), "vout": 1,
                    "tx_out": tx_out(PRINCIPAL_ASSET, 250),
                    "asset": PRINCIPAL_ASSET, "amount": "250"
                }
            ],
            "outputs": [
                { "script_pub_key": "51", "asset": PRINCIPAL_ASSET, "amount": "100" },
                { "script_pub_key": "52", "asset": PRINCIPAL_ASSET, "amount": "150" },
                { "script_pub_key": "53", "asset": POLICY_ASSET, "amount": "90" }
            ],
            "fee": { "asset": POLICY_ASSET, "amount": "10" }
        });
        let parsed = PartiallySignedTransaction::from_str(
            &build_manifest_pset(&serde_json::from_value(spec).unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(parsed.inputs().len(), 2);
        assert_eq!(parsed.outputs().len(), 4);
        assert_eq!(parsed.outputs()[0].script_pubkey, Script::from(vec![0x51]));
        assert_eq!(parsed.outputs()[1].script_pubkey, Script::from(vec![0x52]));
        assert_eq!(parsed.outputs()[2].script_pubkey, Script::from(vec![0x53]));
        assert!(parsed.outputs()[3].script_pubkey.is_empty());
    }

    #[test]
    fn places_the_fee_at_an_explicit_index_without_reordering_other_outputs() {
        let tx_out = elements::encode::serialize_hex(&TxOut {
            asset: Asset::Explicit(AssetId::from_str(POLICY_ASSET).unwrap()),
            value: Value::Explicit(100),
            nonce: Nonce::Null,
            script_pubkey: Script::from(vec![0x51]),
            witness: TxOutWitness::default(),
        });
        let spec = serde_json::json!({
            "inputs": [{
                "txid": "55".repeat(32), "vout": 0, "tx_out": tx_out,
                "asset": POLICY_ASSET, "amount": "100"
            }],
            "outputs": [
                { "script_pub_key": "51", "asset": POLICY_ASSET, "amount": "90" },
                { "script_pub_key": "6a01", "asset": POLICY_ASSET, "amount": "0" },
                { "script_pub_key": "6a02", "asset": POLICY_ASSET, "amount": "0" }
            ],
            "fee": { "asset": POLICY_ASSET, "amount": "10", "output_index": 1 }
        });
        let parsed = PartiallySignedTransaction::from_str(
            &build_manifest_pset(&serde_json::from_value(spec).unwrap()).unwrap(),
        )
        .unwrap();

        assert_eq!(parsed.outputs().len(), 4);
        assert_eq!(parsed.outputs()[0].script_pubkey, Script::from(vec![0x51]));
        assert!(parsed.outputs()[1].script_pubkey.is_empty());
        assert_eq!(
            parsed.outputs()[1].asset,
            Some(AssetId::from_str(POLICY_ASSET).unwrap())
        );
        assert_eq!(parsed.outputs()[1].amount, Some(10));
        assert_eq!(
            parsed.outputs()[2].script_pubkey,
            Script::from(vec![0x6a, 0x01])
        );
        assert_eq!(
            parsed.outputs()[3].script_pubkey,
            Script::from(vec![0x6a, 0x02])
        );
        assert_eq!(
            parsed
                .outputs()
                .iter()
                .filter(|output| output.script_pubkey.is_empty())
                .count(),
            1
        );
    }

    #[test]
    fn rejects_an_out_of_range_fee_output_index() {
        let tx_out = elements::encode::serialize_hex(&TxOut {
            asset: Asset::Explicit(AssetId::from_str(POLICY_ASSET).unwrap()),
            value: Value::Explicit(100),
            nonce: Nonce::Null,
            script_pubkey: Script::from(vec![0x51]),
            witness: TxOutWitness::default(),
        });
        let spec = serde_json::json!({
            "inputs": [{
                "txid": "66".repeat(32), "vout": 0, "tx_out": tx_out,
                "asset": POLICY_ASSET, "amount": "100"
            }],
            "outputs": [
                { "script_pub_key": "51", "asset": POLICY_ASSET, "amount": "90" }
            ],
            "fee": { "asset": POLICY_ASSET, "amount": "10", "output_index": 2 }
        });

        assert_eq!(
            build_manifest_pset(&serde_json::from_value(spec).unwrap()).unwrap_err(),
            "fee.output_index 2 is out of range for 1 non-fee outputs"
        );
    }

    #[test]
    fn rejects_an_empty_script_in_the_non_fee_output_list() {
        let tx_out = elements::encode::serialize_hex(&TxOut {
            asset: Asset::Explicit(AssetId::from_str(POLICY_ASSET).unwrap()),
            value: Value::Explicit(100),
            nonce: Nonce::Null,
            script_pubkey: Script::from(vec![0x51]),
            witness: TxOutWitness::default(),
        });
        let spec = serde_json::json!({
            "inputs": [{
                "txid": "77".repeat(32), "vout": 0, "tx_out": tx_out,
                "asset": POLICY_ASSET, "amount": "100"
            }],
            "outputs": [
                { "script_pub_key": "", "asset": POLICY_ASSET, "amount": "90" }
            ],
            "fee": { "asset": POLICY_ASSET, "amount": "10", "output_index": 0 }
        });

        assert_eq!(
            build_manifest_pset(&serde_json::from_value(spec).unwrap()).unwrap_err(),
            "outputs[0].script_pub_key must not be empty; use the fee field for the sole Elements fee output"
        );
    }

    #[test]
    fn builds_new_asset_issuance_with_locktime() {
        let txid = Txid::from_str(&"44".repeat(32)).unwrap();
        let contract_hash = ContractHash::from_str(&"00".repeat(32)).unwrap();
        let issued_asset = AssetId::new_issuance(OutPoint::new(txid, 0), contract_hash);
        let tx_out = elements::encode::serialize_hex(&TxOut {
            asset: Asset::Explicit(AssetId::from_str(POLICY_ASSET).unwrap()),
            value: Value::Explicit(1000),
            nonce: Nonce::Null,
            script_pubkey: Script::from(vec![0x51]),
            witness: TxOutWitness::default(),
        });
        let spec = serde_json::json!({
            "locktime": 123,
            "inputs": [{
                "txid": txid.to_string(), "vout": 0, "tx_out": tx_out,
                "asset": POLICY_ASSET, "amount": "1000",
                "issuance": { "contract_hash": contract_hash.to_string(), "asset_amount": "2" }
            }],
            "outputs": [
                { "script_pub_key": "51", "asset": issued_asset.to_string(), "amount": "1" },
                { "script_pub_key": "52", "asset": issued_asset.to_string(), "amount": "1" },
                { "script_pub_key": "53", "asset": POLICY_ASSET, "amount": "990" }
            ],
            "fee": { "asset": POLICY_ASSET, "amount": "10" }
        });
        let parsed = PartiallySignedTransaction::from_str(
            &build_manifest_pset(&serde_json::from_value(spec).unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(
            parsed.global.tx_data.fallback_locktime,
            Some(LockTime::from_consensus(123))
        );
        let input = &parsed.inputs()[0];
        assert_eq!(input.issuance_value_amount, Some(2));
        assert_eq!(input.issuance_inflation_keys, None);
        assert_eq!(
            input.issuance_asset_entropy,
            Some(contract_hash.to_byte_array())
        );
    }

    #[test]
    fn blinds_manifest_change_inside_the_runtime() {
        let tx_out = elements::encode::serialize_hex(&TxOut {
            asset: Asset::Explicit(AssetId::from_str(POLICY_ASSET).unwrap()),
            value: Value::Explicit(100),
            nonce: Nonce::Null,
            script_pubkey: Script::from(vec![0x51]),
            witness: TxOutWitness::default(),
        });
        let spec = serde_json::json!({
            "inputs": [{
                "txid": "33".repeat(32), "vout": 0, "tx_out": tx_out,
                "asset": POLICY_ASSET, "amount": "100"
            }],
            "outputs": [{
                "script_pub_key": "51", "asset": POLICY_ASSET, "amount": "90",
                "blinding_public_key": "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
                "blinder_index": 0
            }],
            "fee": { "asset": POLICY_ASSET, "amount": "10", "output_index": 0 }
        });
        let parsed = PartiallySignedTransaction::from_str(
            &build_manifest_pset(&serde_json::from_value(spec).unwrap()).unwrap(),
        )
        .unwrap();
        assert!(parsed.outputs()[0].script_pubkey.is_empty());
        assert!(parsed.outputs()[0].amount_comm.is_none());
        assert!(parsed.outputs()[0].asset_comm.is_none());
        assert!(parsed.outputs()[1].amount_comm.is_some());
        assert!(parsed.outputs()[1].asset_comm.is_some());
        assert!(parsed.outputs()[1].value_rangeproof.is_some());
    }

    #[test]
    fn reproduces_confirmed_lending_acceptance_commitments() {
        assert_eq!(
            hex::encode(sha256::Hash::hash(pinned_source(LENDING).as_bytes()).to_byte_array()),
            "a9b4ade7d131f963a0da014b45f08cc49094194cd76490a30495e3dc93749b8a"
        );
        let (_, pending, active) = lending_vector();
        println!("cmr={}", pending.cmr);
        println!("pending={}", pending.script_pub_key);
        println!("active={}", active.script_pub_key);
        assert_eq!(
            pending.cmr,
            "2b14b174c7b6b399ebc45590907e3d5cff6f0f85a47b7abdfc91caaa72259460"
        );
        assert_eq!(
            pending.script_pub_key,
            "51205cbb261891773b64de44c7ac66f89a9415ce7ba5f9cc94aa5113d0c04ea0171c"
        );
        assert_eq!(
            active.script_pub_key,
            "5120b401a8cd425b46144b0ce0551c585ecd316127ddfc882b7dda68e0b1cb9db2c1"
        );
    }

    #[test]
    fn executes_confirmed_lending_acceptance_offline() {
        let (arguments, pending, _) = lending_vector();
        let debt = format!("{}{:016x}", "00".repeat(24), 200u64);
        dry_run_covenant(&CovenantDryRunSpec {
            source: pinned_source(LENDING).to_owned(),
            arguments,
            extra_leaf_payloads: vec!["00".repeat(32), debt],
            witnesses: Some(serde_json::json!({
                "PATH": { "type": "simplicityhl", "value": "Left(Left(()))" }
            })),
            transaction_hex: ACCEPTANCE_TX.trim().to_owned(),
            parent_transactions: vec![
                OFFER_TX.trim().to_owned(),
                PRINCIPAL_PARENT_TX.trim().to_owned(),
                FEE_PARENT_TX.trim().to_owned(),
            ],
            input_index: 0,
            genesis_hash: "a771da8e52ee6ad581ed1e9a99825e5b3b7992225534eaa2ae23244fe26ab1c1"
                .to_owned(),
            include_debug_symbols: true,
        })
        .unwrap();

        dry_run_covenant(&CovenantDryRunSpec {
            source: pinned_source(SCRIPT_AUTH).to_owned(),
            arguments: serde_json::json!({
                "SCRIPT_HASH": argument(format!("0x{}", pending.script_hash), "u256")
            }),
            extra_leaf_payloads: vec![],
            witnesses: Some(serde_json::json!({
                "INPUT_SCRIPT_INDEX": { "type": "simplicityhl", "value": "0" }
            })),
            transaction_hex: ACCEPTANCE_TX.trim().to_owned(),
            parent_transactions: vec![
                OFFER_TX.trim().to_owned(),
                PRINCIPAL_PARENT_TX.trim().to_owned(),
                FEE_PARENT_TX.trim().to_owned(),
            ],
            input_index: 1,
            genesis_hash: "a771da8e52ee6ad581ed1e9a99825e5b3b7992225534eaa2ae23244fe26ab1c1"
                .to_owned(),
            include_debug_symbols: true,
        })
        .unwrap();
    }

    #[test]
    fn reproduces_confirmed_lending_pset_covenant_witnesses() {
        let original: Transaction =
            decode_hex_consensus(ACCEPTANCE_TX.trim(), "acceptance").unwrap();
        let parents = vec![
            OFFER_TX.trim().to_owned(),
            PRINCIPAL_PARENT_TX.trim().to_owned(),
            FEE_PARENT_TX.trim().to_owned(),
        ];
        let witness_utxos = resolve_witness_utxos(&original, &parents).unwrap();
        let mut pset = PartiallySignedTransaction::from_tx(original.clone());
        for (input, witness_utxo) in pset.inputs_mut().iter_mut().zip(witness_utxos) {
            input.witness_utxo = Some(witness_utxo);
        }
        let (lending_arguments, pending, _) = lending_vector();
        let debt = format!("{}{:016x}", "00".repeat(24), 200u64);
        let pset = finalize_covenant_pset(&CovenantPsetFinalizeSpec {
            pset: pset.to_string(),
            source: pinned_source(LENDING).to_owned(),
            arguments: lending_arguments,
            extra_leaf_payloads: vec!["00".repeat(32), debt],
            witnesses: Some(serde_json::json!({
                "PATH": { "type": "simplicityhl", "value": "Left(Left(()))" }
            })),
            input_index: 0,
            genesis_hash: "a771da8e52ee6ad581ed1e9a99825e5b3b7992225534eaa2ae23244fe26ab1c1"
                .to_owned(),
            include_debug_symbols: true,
        })
        .unwrap();
        let pset = finalize_covenant_pset(&CovenantPsetFinalizeSpec {
            pset,
            source: pinned_source(SCRIPT_AUTH).to_owned(),
            arguments: serde_json::json!({
                "SCRIPT_HASH": argument(format!("0x{}", pending.script_hash), "u256")
            }),
            extra_leaf_payloads: vec![],
            witnesses: Some(serde_json::json!({
                "INPUT_SCRIPT_INDEX": { "type": "simplicityhl", "value": "0" }
            })),
            input_index: 1,
            genesis_hash: "a771da8e52ee6ad581ed1e9a99825e5b3b7992225534eaa2ae23244fe26ab1c1"
                .to_owned(),
            include_debug_symbols: true,
        })
        .unwrap();
        let finalized = PartiallySignedTransaction::from_str(&pset)
            .unwrap()
            .extract_tx()
            .unwrap();
        assert_eq!(
            elements::encode::serialize_hex(&finalized),
            elements::encode::serialize_hex(&original)
        );
    }
}
