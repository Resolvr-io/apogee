import { describe, expect, it } from "vitest";
import {
  LBTC_MAINNET_ASSET_ID,
  LBTC_TESTNET_ASSET_ID,
  policyAssetId,
} from "./asset-registry";

describe("policyAssetId", () => {
  it("returns mainnet LBTC for liquid", () => {
    expect(policyAssetId("liquid")).toBe(LBTC_MAINNET_ASSET_ID);
  });

  it("returns testnet LBTC for liquidtestnet", () => {
    expect(policyAssetId("liquidtestnet")).toBe(LBTC_TESTNET_ASSET_ID);
  });

  it("returns testnet LBTC for regtest", () => {
    expect(policyAssetId("regtest")).toBe(LBTC_TESTNET_ASSET_ID);
  });
});
