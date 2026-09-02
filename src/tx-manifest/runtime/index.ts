export type SimplicityArgument = { value: string; type: string };

export type TxManifestCovenantCompileSpec = {
  source: string;
  arguments: Record<string, SimplicityArgument>;
  extra_leaf_payloads: string[];
  network: "liquid" | "liquid-testnet" | "elements-regtest";
  include_debug_symbols: boolean;
};

export type TxManifestCovenantCommitments = {
  cmr: string;
  tapleaf_hash: string;
  merkle_root: string;
  script_pub_key: string;
  script_hash: string;
  address: string;
};

export type TxManifestTransactionOutputInspection = {
  txid: string;
  vout: number;
  tx_out: string;
  script_pub_key: string;
  asset?: string;
  amount?: string;
  explicit: boolean;
};

export type TxManifestAddressInspection = {
  script_pub_key: string;
  blinding_public_key: string;
};

export type TxManifestCovenantDryRunSpec = Omit<
  TxManifestCovenantCompileSpec,
  "network"
> & {
  witnesses?: Record<string, { type: "simplicityhl"; value: string }>;
  transaction_hex: string;
  parent_transactions: string[];
  input_index: number;
  genesis_hash: string;
};

export type TxManifestPsetBuildSpec = {
  inputs: Array<{
    txid: string;
    vout: number;
    tx_out: string;
    asset: string;
    amount: string;
    asset_blinding_factor?: string;
    value_blinding_factor?: string;
    sequence?: number;
    issuance?: {
      contract_hash: string;
      asset_amount: string;
    };
  }>;
  outputs: Array<{
    script_pub_key: string;
    asset: string;
    amount: string;
    blinding_public_key?: string;
    blinder_index?: number;
  }>;
  fee: {
    asset: string;
    amount: string;
    /**
     * Final transaction output index for the sole Elements fee output.
     * Omit to preserve the historical behavior of appending the fee last.
     */
    output_index?: number;
  };
  locktime?: number;
};

export type TxManifestCovenantFinalizeSpec = Omit<
  TxManifestCovenantCompileSpec,
  "network"
> & {
  pset: string;
  witnesses?: Record<string, { type: "simplicityhl"; value: string }>;
  input_index: number;
  genesis_hash: string;
};

export type TxManifestFeeEstimate = {
  discountVsize: number;
  requiredFee: string;
  unsignedWalletInputs: number;
};

type RuntimeModule = typeof import("./pkg/apogee_tx_manifest_runtime.js");
let runtimePromise: Promise<RuntimeModule> | null = null;

async function loadRuntime(): Promise<RuntimeModule> {
  if (!runtimePromise) {
    runtimePromise = import("./pkg/apogee_tx_manifest_runtime.js").then(async (runtime) => {
      await runtime.default();
      return runtime;
    });
  }
  return runtimePromise;
}

export async function compileTxManifestCovenant(
  spec: TxManifestCovenantCompileSpec,
): Promise<TxManifestCovenantCommitments> {
  const runtime = await loadRuntime();
  return JSON.parse(runtime.compile_covenant_json(JSON.stringify(spec))) as TxManifestCovenantCommitments;
}

export async function inspectTxManifestTransactionOutput(
  transactionHex: string,
  vout: number,
): Promise<TxManifestTransactionOutputInspection> {
  const runtime = await loadRuntime();
  return JSON.parse(
    runtime.inspect_transaction_output_json(
      JSON.stringify({ transaction_hex: transactionHex, vout }),
    ),
  ) as TxManifestTransactionOutputInspection;
}

export async function inspectTxManifestAddress(
  address: string,
  network: TxManifestCovenantCompileSpec["network"],
): Promise<TxManifestAddressInspection> {
  const runtime = await loadRuntime();
  return JSON.parse(
    runtime.inspect_address_json(JSON.stringify({ address, network })),
  ) as TxManifestAddressInspection;
}

export async function deriveTxManifestIssuanceAsset(spec: {
  txid: string;
  vout: number;
  contract_hash: string;
}): Promise<string> {
  const runtime = await loadRuntime();
  return runtime.derive_issuance_asset_json(JSON.stringify(spec));
}

export async function dryRunTxManifestCovenant(
  spec: TxManifestCovenantDryRunSpec,
): Promise<true> {
  const runtime = await loadRuntime();
  runtime.dry_run_covenant_json(JSON.stringify(spec));
  return true;
}

export async function buildTxManifestPset(spec: TxManifestPsetBuildSpec): Promise<string> {
  const runtime = await loadRuntime();
  return runtime.build_manifest_pset_json(JSON.stringify(spec));
}

export async function finalizeTxManifestCovenant(
  spec: TxManifestCovenantFinalizeSpec,
): Promise<string> {
  const runtime = await loadRuntime();
  return runtime.finalize_covenant_pset_json(JSON.stringify(spec));
}

export async function estimateTxManifestFee(spec: {
  pset: string;
  feeRateSatPerKvb: string;
}): Promise<TxManifestFeeEstimate> {
  const runtime = await loadRuntime();
  const result = JSON.parse(
    runtime.estimate_manifest_fee_json(
      JSON.stringify({
        pset: spec.pset,
        fee_rate_sat_per_kvb: spec.feeRateSatPerKvb,
      }),
    ),
  ) as {
    discount_vsize: number;
    required_fee: string;
    unsigned_wallet_inputs: number;
  };
  return {
    discountVsize: result.discount_vsize,
    requiredFee: result.required_fee,
    unsignedWalletInputs: result.unsigned_wallet_inputs,
  };
}
