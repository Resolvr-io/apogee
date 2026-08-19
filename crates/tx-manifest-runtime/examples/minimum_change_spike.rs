use std::str::FromStr;

use apogee_tx_manifest_runtime::{build_manifest_pset_json, estimate_manifest_fee_json};
use elements::{
    confidential::{Asset, Nonce, Value},
    encode::serialize_hex,
    Address, AddressParams, AssetId, Script, TxOut, TxOutWitness,
};
use serde_json::{json, Value as JsonValue};

const POLICY_ASSET: &str = "144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49";
const BLINDING_KEY: &str = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

fn main() {
    let rates = [100_u64, 1_000, 10_000];
    let long_term_rate = 100_u64;
    let explicit_baseline = estimate(&build(false, false, 1), 1_000);
    let confidential_baseline = estimate(&build(true, false, 1), 1_000);
    let confidential_change = estimate(&build(true, true, 1), 1_000);
    let explicit_change = estimate(&build(false, true, 1), 1_000);
    let two_inputs = estimate(&build(false, false, 2), 1_000);

    let measurements = json!({
        "discountVsize": {
            "explicitBaseline": explicit_baseline["discount_vsize"],
            "explicitPlusConfidentialChange": explicit_change["discount_vsize"],
            "confidentialBaseline": confidential_baseline["discount_vsize"],
            "confidentialPlusConfidentialChange": confidential_change["discount_vsize"],
            "oneWalletInput": explicit_baseline["discount_vsize"],
            "twoWalletInputs": two_inputs["discount_vsize"]
        },
        "marginalDiscountVbytes": {
            "confidentialChangeAfterExplicitOutput":
                as_u64(&explicit_change, "discount_vsize")
                    - as_u64(&explicit_baseline, "discount_vsize"),
            "confidentialChangeAfterConfidentialOutput":
                as_u64(&confidential_change, "discount_vsize")
                    - as_u64(&confidential_baseline, "discount_vsize"),
            "futureP2wpkhInput":
                as_u64(&two_inputs, "discount_vsize")
                    - as_u64(&explicit_baseline, "discount_vsize")
        },
        "sameRateBreakEvenSats": rates.into_iter().map(|rate| {
            let create = as_u64(&explicit_change, "discount_vsize")
                - as_u64(&explicit_baseline, "discount_vsize");
            let spend = as_u64(&two_inputs, "discount_vsize")
                - as_u64(&explicit_baseline, "discount_vsize");
            json!({
                "feeRateSatPerKvb": rate,
                "createCost": fee(create, rate),
                "futureSpendCost": fee(spend, rate),
                "grossRemainderFloor": fee(create, rate) + fee(spend, rate),
                "postCreationChangeFloor": fee(spend, rate)
            })
        }).collect::<Vec<_>>(),
        "recommendedPolicySats": {
            "longTermSpendRateSatPerKvb": long_term_rate,
            "postCreationChangeFloor": fee(
                as_u64(&two_inputs, "discount_vsize")
                    - as_u64(&explicit_baseline, "discount_vsize"),
                long_term_rate,
            ),
            "conservativeGrossRemainderFloorByLiveRate": rates.into_iter().map(|rate| {
                let create = as_u64(&explicit_change, "discount_vsize")
                    - as_u64(&explicit_baseline, "discount_vsize");
                let spend = as_u64(&two_inputs, "discount_vsize")
                    - as_u64(&explicit_baseline, "discount_vsize");
                json!({
                    "liveFeeRateSatPerKvb": rate,
                    "floor": fee(create, rate) + fee(spend, long_term_rate)
                })
            }).collect::<Vec<_>>()
        }
    });
    println!("{}", serde_json::to_string_pretty(&measurements).unwrap());
}

fn build(confidential_fixed_output: bool, include_change: bool, input_count: usize) -> String {
    let input_total = 100_000_u64;
    let fixed_amount = 90_000_u64;
    let change_amount = if include_change { 1_000 } else { 0 };
    let fee = input_total - fixed_amount - change_amount;
    let input_amount = input_total / input_count as u64;
    let wallet_script = wallet_script();
    let inputs = (0..input_count)
        .map(|index| {
            json!({
                "txid": format!("{:02x}", index + 1).repeat(32),
                "vout": index,
                "tx_out": explicit_tx_out(input_amount, &wallet_script),
                "asset": POLICY_ASSET,
                "amount": input_amount.to_string()
            })
        })
        .collect::<Vec<_>>();
    let mut outputs = vec![if confidential_fixed_output {
        confidential_output(fixed_amount, &wallet_script, 0)
    } else {
        json!({
            "script_pub_key": hex::encode(wallet_script.as_bytes()),
            "asset": POLICY_ASSET,
            "amount": fixed_amount.to_string()
        })
    }];
    if include_change {
        outputs.push(confidential_output(change_amount, &wallet_script, 0));
    }
    build_manifest_pset_json(
        &json!({
            "inputs": inputs,
            "outputs": outputs,
            "fee": { "asset": POLICY_ASSET, "amount": fee.to_string() }
        })
        .to_string(),
    )
    .expect("manifest PSET builds")
}

fn confidential_output(amount: u64, script: &Script, blinder_index: u32) -> JsonValue {
    json!({
        "script_pub_key": hex::encode(script.as_bytes()),
        "asset": POLICY_ASSET,
        "amount": amount.to_string(),
        "blinding_public_key": BLINDING_KEY,
        "blinder_index": blinder_index
    })
}

fn estimate(pset: &str, rate: u64) -> JsonValue {
    let encoded = estimate_manifest_fee_json(
        &json!({
            "pset": pset,
            "fee_rate_sat_per_kvb": rate.to_string()
        })
        .to_string(),
    )
    .expect("fee estimate succeeds");
    serde_json::from_str(&encoded).unwrap()
}

fn wallet_script() -> Script {
    let address = Address::p2wpkh(
        &elements::bitcoin::PublicKey::from_str(BLINDING_KEY).unwrap(),
        None,
        &AddressParams::ELEMENTS,
    );
    address.script_pubkey()
}

fn explicit_tx_out(amount: u64, script: &Script) -> String {
    serialize_hex(&TxOut {
        asset: Asset::Explicit(AssetId::from_str(POLICY_ASSET).unwrap()),
        value: Value::Explicit(amount),
        nonce: Nonce::Null,
        script_pubkey: script.clone(),
        witness: TxOutWitness::default(),
    })
}

fn as_u64(value: &JsonValue, field: &str) -> u64 {
    value[field].as_u64().unwrap()
}

fn fee(vbytes: u64, rate_sat_per_kvb: u64) -> u64 {
    (vbytes * rate_sat_per_kvb).div_ceil(1_000)
}
