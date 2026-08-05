// Well-known Liquid asset ids → display labels. Unknown assets fall back
// to a shortened hex id, or a name/ticker fetched from the Liquid registry.

export const LBTC_MAINNET_ASSET_ID =
  "6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d";
export const LBTC_TESTNET_ASSET_ID =
  "144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49";
export const USDT_LIQUID_ASSET_ID =
  "ce091c998b83c78bb71a632313ba3760f1763d9cfcffae02258ffa9865a37bd2";
export const USDT_TESTNET_ASSET_ID =
  "b612eb46313a2cd6ebabd8b7a8eed5696e29898b87a43bff41c94f51acef9d73";

/** Locally-known asset metadata. `precision` is the issued asset's decimal
 *  places (from its issuance contract) — kept here so known assets display
 *  correctly without a registry round-trip: KNOWN_ASSETS entries are skipped
 *  by the registry fetch, so a label-only entry would otherwise render raw
 *  base units (USDt showed 100,660,712 instead of 1.00660712). */
export interface KnownAsset {
  label: string;
  precision: number;
  /** True for USD-pegged stablecoins: the UI may show an approximate fiat
   *  value (1 unit ≈ $1) converted into the chosen display currency. Named
   *  for the peg currency because the conversion assumes 1 unit = 1 USD —
   *  do not reuse for a token pegged to something other than USD without
   *  generalizing this to carry the peg currency (see usdToFiat in
   *  Wallet.tsx and portfolioTotal in lib/portfolio.ts, both of which are
   *  hardcoded to a USD rate — the latter folds these balances into the
   *  headline portfolio figure). */
  pegUsd?: boolean;
}

export const KNOWN_ASSETS: Record<string, KnownAsset> = {
  [LBTC_TESTNET_ASSET_ID]: { label: "LBTC (testnet)", precision: 8 },
  [LBTC_MAINNET_ASSET_ID]: { label: "LBTC", precision: 8 },
  [USDT_LIQUID_ASSET_ID]: { label: "USDt", precision: 8, pegUsd: true },
  [USDT_TESTNET_ASSET_ID]: { label: "USDt (testnet)", precision: 8, pegUsd: true },
};
