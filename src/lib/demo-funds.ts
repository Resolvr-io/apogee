// Demo funds for screenshots (Debug panel toggle; debug builds only, see
// lib/debug.ts). While enabled, the Wallet screen PRESENTS this canned dataset
// instead of live data — purely display-level: the engine, keystore, and real
// wallet state are untouched, and a send still validates against the real
// balance. The history deliberately sums to the balance on BOTH assets so the
// numbers hold up under scrutiny in a screenshot:
//   LBTC: +250 000 − 420 026 + 75 000 + 1 500 000 − 180 540 + 272 000
//          + 827 457 − 166 460                            = 2 157 431 sats
//   USDt:  +100.42 − 15.00 + 65.00                        = 150.42
//
// The dataset is deliberately MAINNET-shaped — mainnet asset ids and `lq1`
// addresses — so a screenshot taken on a testnet wallet never advertises
// testnet. The network placard is suppressed alongside it (see App.tsx).
// DEMO_UTXOS backs the Coins view and sums to the same per-asset totals, so
// the two screens agree with each other and with the history above.

import { useEffect, useState } from "react";
import type { SyncResult, WalletTxDTO, WalletUtxoDTO } from "@/engine/protocol";
import { LBTC_MAINNET_ASSET_ID, USDT_LIQUID_ASSET_ID } from "@/lib/asset-registry";
import { DEBUG_ENTERPRISE_BUILD } from "@/lib/debug";
import { browser } from "@/lib/ext";

export const DEMO_FUNDS_KEY = "apogee:debug:demofunds";

/** The Settings > Debug "Demo funds" toggle. Live-updating so flipping it
 *  applies without leaving the screen, and always false outside debug builds.
 *  Lives here rather than in one screen because both the wallet surfaces and
 *  the header placard have to agree on it. */
export function useDemoFunds(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!DEBUG_ENTERPRISE_BUILD) return;
    void browser.storage.local.get(DEMO_FUNDS_KEY).then((o) => setOn(o[DEMO_FUNDS_KEY] === true));
    const onChanged = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area === "local" && DEMO_FUNDS_KEY in changes) {
        setOn(changes[DEMO_FUNDS_KEY].newValue === true);
      }
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, []);
  return on;
}

export const DEMO_SYNC: SyncResult = {
  lbtcSats: 2_157_431,
  balance: {
    [LBTC_MAINNET_ASSET_ID]: 2_157_431,
    [USDT_LIQUID_ASSET_ID]: 15_042_000_000, // 150.42 USDt (precision 8)
  },
  policyAssetHex: LBTC_MAINNET_ASSET_ID,
};

// Coins view (Settings > Coins). Five L-BTC outputs so per-asset consolidation
// has something to act on in a screenshot, and two USDt outputs. Per-asset
// totals match DEMO_SYNC exactly:
//   LBTC: 812 457 + 650 000 + 420 000 + 180 540 + 94 434 = 2 157 431 sats
//   USDt: 90.42 + 60.00                                  = 150.42
// One output is left unconfidential so the list's confidentiality column has
// both states to render.
//
// The addresses are synthetic but SHAPED like the real thing: every character
// after the prefix is in the bech32 charset (which excludes 1, b, i and o), the
// confidential ones are 102 chars like a real blech32 Liquid address, and the
// unconfidential one is 42. They carry no valid checksum and nothing parses
// them — the expanded coin row renders the string verbatim, so it only has to
// survive being read, not being decoded. Don't send anything to them.
export const DEMO_UTXOS: WalletUtxoDTO[] = [
  {
    txid: "e1b5d90c72f486a3e8d1c5b92f0a67d4c3e8f2a15b6d09e7c4a3f8b1d6e25c90",
    vout: 0,
    address: "lq1qqkqa6s7ycncrp2467t05m5wdh9794y49tnwpag0u6swvanm7ml4e2ylg6mpy3a5eq25yumflmg6k6psjqlatuzy4lgtph3h3n9",
    asset: LBTC_MAINNET_ASSET_ID,
    amount: "812457",
    confidential: true,
  },
  {
    txid: "6a2e8cd59f1b74e0c3a8d62f9b5e17c4a0d83f6e2b9c51d7a4f0e8b3c6d92a5f",
    vout: 1,
    address: "lq1qqu8w88r0kz4qal6mesmmnugkfqnl4uyt5vx58q0dzs7adqssmmtyp2gv26749z8tv66af9utdgdg6a87xtvmrmseuk24d2jw0p",
    asset: LBTC_MAINNET_ASSET_ID,
    amount: "650000",
    confidential: true,
  },
  {
    txid: "74d1b8f52a0c96e3d7f4b1a85c2e60d9f3b7a4c18e5d20f6b9c3a7e14d80f5b2",
    vout: 0,
    address: "lq1qqmqk8c34cs08lfjn9ckjrvvngu328m28ysvmzsmewshd2l47qvrs58qg82547ucsctqrfunntp39sfete7mvx8prqd2tjdepf4",
    asset: LBTC_MAINNET_ASSET_ID,
    amount: "420000",
    confidential: true,
  },
  {
    txid: "51e7a3c90d6f24b8e1a5c7d30f9b62e48c1d5a7f0e3b96c24d8a1f5e7c30b96d",
    vout: 2,
    address: "lq1qqj2a2pstjh927kq3zn84ft5ghdehjkupfklc6n344js57zxu60p90v4jems87xg4gclaztujjn4u48anjde6v8sftclmrwcedw",
    asset: LBTC_MAINNET_ASSET_ID,
    amount: "180540",
    confidential: true,
  },
  {
    txid: "0c7f3a94e6b25d18f0c4a7e93b5d61f8a2c60e4d97b3f15a8e0c62d4b9f37a15",
    vout: 1,
    // Unconfidential, so the list shows both confidentiality states.
    address: "ex1qs8p002fh9xng00p8erzrdjp7py58c9fjfwhzp0",
    asset: LBTC_MAINNET_ASSET_ID,
    amount: "94434",
    confidential: false,
  },
  {
    txid: "2f9c5e70b3d81a46c9e2f5b708d4a1c6e3f90b25d7a8c41e6b0d3f9a25c78e01",
    vout: 0,
    address: "lq1qqpr0sasuxcadu93e0f5enmd6czy90wvlc079f4nge5hlvwhwt22s922aan7x94j4clejgf72mqm4gyezsm4sarj5ph0f3rf0kx",
    asset: USDT_LIQUID_ASSET_ID,
    amount: "9042000000", // 90.42 USDt
    confidential: true,
  },
  {
    txid: "3b7e9d215c8f04a6d1e7b3f9c2a85d40e6f1c7a92b5d8e30f4a6c1b7d9e2f584",
    vout: 1,
    address: "lq1qqsgc63g3m696syus5gh55t5eh2lnt6772j0qj3wx6pl9h6k5ztv7gk4te3zgwzngy7x7zf94xen2nkl6j7648fq6m09rhcdyff",
    asset: USDT_LIQUID_ASSET_ID,
    amount: "6000000000", // 60.00 USDt
    confidential: true,
  },
];

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
