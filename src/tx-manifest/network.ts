import type { LiquidNetwork } from "@/keystore/keystore";
import type { TxManifestCovenantCompileSpec } from "./runtime";

export const LIQUID_TESTNET_GENESIS_HASH =
  "a771da8e52ee6ad581ed1e9a99825e5b3b7992225534eaa2ae23244fe26ab1c1" as const;
export const SIMPLICITY_LENDING_V3_REGTEST_GENESIS_HASH =
  "00902a6b70c2ca83b5d9c815d96a0e2f4202179316970d14ea1847dae5b1ca21" as const;
export const SIMPLICITY_LENDING_V3_REGTEST_CHAIN =
  "bip122:00902a6b70c2ca83b5d9c815d96a0e2f" as const;

/** Production supports testnet; the controlled browser harness may also opt into regtest. */
export function isTxManifestExecutionNetwork(network: LiquidNetwork): boolean {
  return network === "liquidtestnet" || (__TX_MANIFEST_REGTEST__ && network === "regtest");
}

export function txManifestRuntimeNetwork(
  network: LiquidNetwork,
): TxManifestCovenantCompileSpec["network"] {
  if (!isTxManifestExecutionNetwork(network)) {
    throw new Error("TX Manifest execution is not enabled for this Liquid network.");
  }
  return network === "regtest" ? "elements-regtest" : "liquid-testnet";
}

export function txManifestExpectedGenesisHash(network: LiquidNetwork): string {
  if (!isTxManifestExecutionNetwork(network)) {
    throw new Error("TX Manifest execution is not enabled for this Liquid network.");
  }
  return network === "regtest"
    ? SIMPLICITY_LENDING_V3_REGTEST_GENESIS_HASH
    : LIQUID_TESTNET_GENESIS_HASH;
}
