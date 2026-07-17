// Demo funds for screenshots (Debug panel toggle; debug builds only, see
// lib/debug.ts). While enabled, the Wallet screen PRESENTS this canned dataset
// instead of live data — purely display-level: the engine, keystore, and real
// wallet state are untouched, and a send still validates against the real
// balance. The history deliberately sums to the balance on BOTH assets so the
// numbers hold up under scrutiny in a screenshot:
//   L-BTC: +250 000 − 420 026 + 75 000 + 1 500 000 − 180 540 + 272 000
//          + 827 457 − 166 460                            = 2 157 431 sats
//   USDt:  +100.42 − 15.00 + 65.00                        = 150.42

import type { SyncResult, WalletTxDTO } from "@/engine/protocol";
import { LBTC_MAINNET_ASSET_ID, USDT_LIQUID_ASSET_ID } from "@/lib/asset-registry";

export const DEMO_FUNDS_KEY = "apogee:debug:demofunds";

export const DEMO_SYNC: SyncResult = {
  lbtcSats: 2_157_431,
  balance: {
    [LBTC_MAINNET_ASSET_ID]: 2_157_431,
    [USDT_LIQUID_ASSET_ID]: 15_042_000_000, // 150.42 USDt (precision 8)
  },
  policyAssetHex: LBTC_MAINNET_ASSET_ID,
};

// Timestamps relative to load so the relative labels ("2h ago") stay fresh.
const NOW = Math.floor(Date.now() / 1000);
const H = 3_977_120; // plausible recent Liquid mainnet height
const DAY = 86_400;

// Newest first (the list renders in order).
export const DEMO_TXS: WalletTxDTO[] = [
  {
    txid: "8f3a1c47d2e6905b7a4f8c21e9d05376b1a8e4c2f7d90135a6b8c4e2d7f09a51",
    balanceChange: 250_000,
    fee: 26,
    height: H - 92,
    timestamp: NOW - 2 * 3600,
    assetDeltas: { [LBTC_MAINNET_ASSET_ID]: 250_000 },
  },
  {
    txid: "3b7e9d215c8f04a6d1e7b3f9c2a85d40e6f1c7a92b5d8e30f4a6c1b7d9e2f584",
    balanceChange: 0,
    fee: 27,
    height: H - 410,
    timestamp: NOW - 26 * 3600,
    assetDeltas: { [USDT_LIQUID_ASSET_ID]: 10_042_000_000 }, // +100.42 USDt
  },
  {
    txid: "c4d81f36a9e2507b3c6d94e1f8a27b50d3e9f6c14a7b2d85e0c3f9a61b4d7e28",
    balanceChange: -420_026,
    fee: 26,
    height: H - 1780,
    timestamp: NOW - 3 * DAY,
    assetDeltas: { [LBTC_MAINNET_ASSET_ID]: -420_026 },
  },
  {
    txid: "51e7a3c90d6f24b8e1a5c7d30f9b62e48c1d5a7f0e3b96c24d8a1f5e7c30b96d",
    balanceChange: 75_000,
    fee: 29,
    height: H - 2350,
    timestamp: NOW - 4 * DAY,
    assetDeltas: { [LBTC_MAINNET_ASSET_ID]: 75_000 },
  },
  {
    txid: "9d2c6f81a4e7305b8d2f6c9a1e4b70d5f3a8c2e61b9d40f7a5c8e3b16d92f470",
    balanceChange: 0,
    fee: 27,
    height: H - 2980,
    timestamp: NOW - 5 * DAY,
    assetDeltas: { [USDT_LIQUID_ASSET_ID]: -1_500_000_000 }, // −15.00 USDt
  },
  {
    txid: "6a2e8cd59f1b74e0c3a8d62f9b5e17c4a0d83f6e2b9c51d7a4f0e8b3c6d92a5f",
    balanceChange: 1_500_000,
    fee: 30,
    height: H - 3660,
    timestamp: NOW - 6 * DAY,
    assetDeltas: { [LBTC_MAINNET_ASSET_ID]: 1_500_000 },
  },
  {
    txid: "b8f04d27c5a91e63f7b2d80c4a6e19f5d3c7b0a28e6f41d9c5b3a7e02f8d61c4",
    balanceChange: -180_540,
    fee: 26,
    height: H - 5420,
    timestamp: NOW - 9 * DAY,
    assetDeltas: { [LBTC_MAINNET_ASSET_ID]: -180_540 },
  },
  {
    txid: "2f9c5e70b3d81a46c9e2f5b708d4a1c6e3f90b25d7a8c41e6b0d3f9a25c78e01",
    balanceChange: 0,
    fee: 28,
    height: H - 6100,
    timestamp: NOW - 10 * DAY,
    assetDeltas: { [USDT_LIQUID_ASSET_ID]: 6_500_000_000 }, // +65.00 USDt
  },
  {
    txid: "74d1b8f52a0c96e3d7f4b1a85c2e60d9f3b7a4c18e5d20f6b9c3a7e14d80f5b2",
    balanceChange: 272_000,
    fee: 27,
    height: H - 7300,
    timestamp: NOW - 12 * DAY,
    assetDeltas: { [LBTC_MAINNET_ASSET_ID]: 272_000 },
  },
  {
    txid: "e1b5d90c72f486a3e8d1c5b92f0a67d4c3e8f2a15b6d09e7c4a3f8b1d6e25c90",
    balanceChange: 827_457,
    fee: 28,
    height: H - 8900,
    timestamp: NOW - 14 * DAY,
    assetDeltas: { [LBTC_MAINNET_ASSET_ID]: 827_457 },
  },
  {
    txid: "0c7f3a94e6b25d18f0c4a7e93b5d61f8a2c60e4d97b3f15a8e0c62d4b9f37a15",
    balanceChange: -166_460,
    fee: 26,
    height: H - 13200,
    timestamp: NOW - 21 * DAY,
    assetDeltas: { [LBTC_MAINNET_ASSET_ID]: -166_460 },
  },
];
