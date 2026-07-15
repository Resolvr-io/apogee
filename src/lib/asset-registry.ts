// Well-known Liquid asset ids → display labels. Unknown assets fall back
// to a shortened hex id, or a name/ticker fetched from the Liquid registry.

export const LBTC_MAINNET_ASSET_ID =
  "6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d";
export const LBTC_TESTNET_ASSET_ID =
  "144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49";
export const USDT_LIQUID_ASSET_ID =
  "ce091c998b83c78bb71a632313ba3760f1763d9cfcffae02258ffa9865a37bd2";

export const KNOWN_ASSETS: Record<string, string> = {
  [LBTC_TESTNET_ASSET_ID]: "L-BTC (testnet)",
  [LBTC_MAINNET_ASSET_ID]: "L-BTC",
  [USDT_LIQUID_ASSET_ID]: "USDt",
};
