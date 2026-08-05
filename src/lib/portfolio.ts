// Portfolio total for the balance hero. Extracted from Wallet.tsx so the
// arithmetic and the copy are unit-testable (the component needs a DOM, and
// vitest only collects `src/**/*.test.ts`).
//
// The hero used to show LBTC only, so a wallet holding nothing but USDt read
// "0 sats" while the Tokens list below showed a real balance. It now shows the
// whole portfolio, denominated in LBTC like SideSwap's "Total Value" — one
// `totalSats` integer rendered through the existing sats / LBTC / fiat
// formatters, so the three denominations cannot disagree with each other.
//
// Display-only, like everything downstream of a price (see docs/price-sources.md):
// Send and Swap read per-asset balances straight off the sync result, so a wrong
// rate can misprice this figure but cannot change what leaves the wallet.

import { KNOWN_ASSETS } from "@/lib/asset-registry";
import { SATS_PER_BTC, formatFiat, formatSats, satsToFiat } from "@/lib/format";

/** Hero denomination, tap-to-cycle in DENOM_ORDER. */
export type Denom = "btc" | "sats" | "fiat";

/** Liquid issuance contracts carry 0-8 decimal places, so anything outside that
 *  is malformed metadata rather than an exotic asset. Bounded in both directions
 *  because `10 ** precision` overflows to Infinity well before it errors, and
 *  `amt / Infinity` is 0 — the asset would then contribute nothing to the total
 *  *silently*, which is the one outcome this module is built to avoid. */
const MAX_PRECISION = 8;

/** The subset of SyncResult the total needs. Typed structurally so this module
 *  stays free of engine/protocol imports. */
export interface PortfolioSync {
  lbtcSats: number;
  balance: Record<string, number>; // assetIdHex → integer base units
  policyAssetHex: string; // which key in `balance` is LBTC
}

export interface PortfolioTotal {
  /** The hero figure: LBTC plus every priceable token, in sats. */
  totalSats: number;
  /** The LBTC balance alone (0 when unsynced). */
  lbtcSats: number;
  /** Sats-equivalent of the priced tokens; null when nothing could be priced. */
  tokenSats: number | null;
  /** USD value of the priced tokens; null when none could be priced. */
  tokenUsd: number | null;
  /** A pegged token is held with a positive balance — true even when its value
   *  couldn't be computed, so it can gate the BTC/USD rate fetch without
   *  deadlocking against a total that needs that rate. */
  holdsPegged: boolean;
  /** True when the hero is no longer just the LBTC balance, so it must say "total". */
  tokensIncluded: boolean;
  /** Pegged tokens are held but the BTC/USD rate hasn't landed, so their value
   *  is missing from the total. */
  pricePending: boolean;
  /** How many pegged assets are waiting on that rate (0 unless pricePending). */
  pendingCount: number;
  /** Held non-policy assets with no price source at all (no pegUsd entry). */
  unpricedCount: number;
}

/**
 * Fold a sync result into one LBTC-denominated total.
 *
 * `btcUsd` is the BTC price in USD specifically — the peg is to USD, so
 * converting a stablecoin balance into sats needs that rate and not the
 * display-currency one. Null when it isn't known yet or the fetch failed; the
 * tokens are then left out of the total entirely rather than partially credited.
 */
export function portfolioTotal({
  sync,
  btcUsd,
}: {
  sync: PortfolioSync | null;
  btcUsd: number | null;
}): PortfolioTotal {
  if (!sync) {
    return {
      totalSats: 0,
      lbtcSats: 0,
      tokenSats: null,
      tokenUsd: null,
      holdsPegged: false,
      tokensIncluded: false,
      pricePending: false,
      pendingCount: 0,
      unpricedCount: 0,
    };
  }

  const priced = btcUsd != null && btcUsd > 0;
  let tokenUsd: number | null = null;
  let holdsPegged = false;
  let pendingCount = 0;
  let unpricedCount = 0;

  for (const [asset, amt] of Object.entries(sync.balance)) {
    // The policy asset is already `lbtcSats`; counting its `balance` entry too
    // would double the LBTC holding.
    if (asset === sync.policyAssetHex || amt <= 0) continue;
    const known = KNOWN_ASSETS[asset];
    // `precision` is required on a KnownAsset, so a pegged asset always has one.
    // The guard is defensive: a future malformed entry should land in the
    // unpriced count — where it is at least announced — rather than mis-scale a
    // balance by 10^8 or vanish into a division by Infinity.
    if (
      !known?.pegUsd ||
      !Number.isInteger(known.precision) ||
      known.precision < 0 ||
      known.precision > MAX_PRECISION
    ) {
      unpricedCount += 1;
      continue;
    }
    holdsPegged = true;
    if (!priced) {
      pendingCount += 1;
      continue;
    }
    tokenUsd = (tokenUsd ?? 0) + amt / 10 ** known.precision;
  }

  const tokenSats =
    tokenUsd != null && priced ? Math.round((tokenUsd / (btcUsd as number)) * SATS_PER_BTC) : null;

  return {
    totalSats: sync.lbtcSats + (tokenSats ?? 0),
    lbtcSats: sync.lbtcSats,
    tokenSats,
    tokenUsd,
    holdsPegged,
    tokensIncluded: tokenSats != null && tokenSats > 0,
    pricePending: pendingCount > 0,
    pendingCount,
    unpricedCount,
  };
}

/**
 * The line under the hero figure. Source strings are lowercase except tickers
 * and currency codes — the span carries `uppercase`.
 *
 * With no token contributing, the string is exactly what it was before the
 * total existed, so a single-asset wallet sees no change at all. When one does
 * contribute, the line names the figure as a total and gives the other
 * denomination beside it: a figure that is neither the LBTC balance nor the
 * token balance is unreadable without the word (SideSwap labels the same figure
 * "Total Value"). The unit stays in the label because `formatFiat` renders "$"
 * for USD, CAD and AUD alike — same reason the rate bar names the pair.
 *
 * `rate` is BTC in the *display* currency, for the fiat secondary; null when
 * unknown. `missingCount` is how many held assets are absent from the total.
 */
export function heroSubtitle({
  denom,
  fiat,
  total,
  rate,
  missingCount,
}: {
  denom: Denom;
  fiat: string;
  total: PortfolioTotal;
  rate: number | null;
  missingCount: number;
}): string {
  const unit = denom === "sats" ? "sats" : denom === "fiat" ? fiat : "LBTC";
  const satsFigure = `${formatSats(total.totalSats)} sats`;
  const fiatFigure = rate != null ? formatFiat(satsToFiat(total.totalSats, rate), fiat) : null;

  let line: string;
  if (total.tokensIncluded) {
    // The hero is a total, so the secondary is the other denomination of that
    // same total — never a component of it.
    const secondary = denom === "fiat" ? satsFigure : fiatFigure;
    line = secondary ? `total ${unit} · ${secondary}` : `total ${unit}`;
  } else if (denom === "sats") {
    line = unit;
  } else {
    // btc and fiat modes have always named the sats figure alongside, and with
    // no token contributing `totalSats` is the LBTC balance.
    line = `${unit} · ${satsFigure}`;
  }
  // Never silently understate: an excluded holding is announced rather than
  // rounded away. Shorter than "+ N unpriced asset(s)", which doesn't fit
  // beside a total on a 360px panel.
  if (missingCount > 0) line += ` · +${missingCount} unpriced`;
  return line;
}
