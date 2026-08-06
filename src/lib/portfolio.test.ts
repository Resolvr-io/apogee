// Tests for the portfolio total behind the balance hero.
//
// Two properties carry the design. First, the total is ONE integer that the
// three denominations are rendered from, so a sats figure and a fiat figure can
// never describe different portfolios (the alternative — a fiat total plus an
// independently-computed "incl. $x in tokens" line — has no such guarantee).
// Second, the total never guesses and never silently understates: an asset with
// no price source is excluded from the figure AND announced in the subtitle.

import { describe, expect, it } from "vitest";
import {
  KNOWN_ASSETS,
  LBTC_MAINNET_ASSET_ID,
  USDT_LIQUID_ASSET_ID,
  USDT_TESTNET_ASSET_ID,
} from "./asset-registry";
import { satsToFiat } from "./format";
import { assetRows, heroSubtitle, portfolioTotal, type PortfolioSync } from "./portfolio";

const BTC_USD = 64_500;
const LBTC = 2_157_431; // sats — the demo dataset's LBTC balance
const USDT_UNITS = 15_042_000_000; // 150.42 USDt at precision 8
/** An asset with no KNOWN_ASSETS entry: a self-issued asset or an unlisted token. */
const UNKNOWN_ASSET = "a".repeat(64);

/** DEMO_SYNC's shape: `balance` carries the policy asset alongside the tokens. */
function sync(balance: Record<string, number> = {}, lbtcSats = LBTC): PortfolioSync {
  return {
    lbtcSats,
    balance: { [LBTC_MAINNET_ASSET_ID]: lbtcSats, ...balance },
    policyAssetHex: LBTC_MAINNET_ASSET_ID,
  };
}

describe("portfolioTotal", () => {
  it("leaves an LBTC-only wallet exactly as it was", () => {
    const t = portfolioTotal({ sync: sync(), btcUsd: BTC_USD });
    expect(t.totalSats).toBe(LBTC);
    expect(t.lbtcSats).toBe(LBTC);
    expect(t.tokensIncluded).toBe(false);
    expect(t.tokenUsd).toBeNull();
    expect(t.tokenSats).toBeNull();
    expect(t.holdsPegged).toBe(false);
    expect(t.pricePending).toBe(false);
    expect(t.pendingCount).toBe(0);
    expect(t.unpricedCount).toBe(0);
  });

  it("does not double-count the policy asset's own balance entry", () => {
    // `balance` contains the LBTC entry as well as `lbtcSats`; summing both
    // would report twice the holding.
    const t = portfolioTotal({ sync: sync(), btcUsd: BTC_USD });
    expect(t.totalSats).toBe(LBTC);
  });

  it("folds a USD-pegged token into the total", () => {
    const t = portfolioTotal({
      sync: sync({ [USDT_LIQUID_ASSET_ID]: USDT_UNITS }),
      btcUsd: BTC_USD,
    });
    expect(t.tokenUsd).toBeCloseTo(150.42, 8);
    expect(t.tokenSats).toBe(233_209);
    expect(t.totalSats).toBe(LBTC + 233_209);
    expect(t.tokensIncluded).toBe(true);
    expect(t.holdsPegged).toBe(true);
    expect(t.pricePending).toBe(false);
  });

  it("sums multiple pegged tokens", () => {
    const t = portfolioTotal({
      sync: sync({
        [USDT_LIQUID_ASSET_ID]: USDT_UNITS,
        [USDT_TESTNET_ASSET_ID]: 5_000_000_000, // 50.00
      }),
      btcUsd: BTC_USD,
    });
    expect(t.tokenUsd).toBeCloseTo(200.42, 8);
  });

  // The claim that justifies denominating the total in LBTC: re-denominating
  // one integer agrees with summing the parts in fiat, so the sats, LBTC and
  // fiat views cannot disagree.
  it.each([
    ["USD", BTC_USD],
    ["JPY", 9_870_000],
  ])("re-denominating the total agrees with summing in fiat (%s)", (_currency, rate) => {
    const t = portfolioTotal({
      sync: sync({ [USDT_LIQUID_ASSET_ID]: USDT_UNITS }),
      btcUsd: BTC_USD,
    });
    const viaTotal = satsToFiat(t.totalSats, rate);
    const viaParts = satsToFiat(t.lbtcSats, rate) + (t.tokenUsd as number) * (rate / BTC_USD);
    // The only gap is rounding tokenSats to a whole sat, so the bound is what
    // one sat is worth — stated in the currency rather than as a flat cent,
    // since a cent is meaningless in a currency with no minor unit.
    expect(Math.abs(viaTotal - viaParts)).toBeLessThanOrEqual(satsToFiat(1, rate));
  });

  it("never partially credits a pegged token while the rate is missing", () => {
    const t = portfolioTotal({
      sync: sync({ [USDT_LIQUID_ASSET_ID]: USDT_UNITS }),
      btcUsd: null,
    });
    expect(t.totalSats).toBe(LBTC);
    expect(t.tokenSats).toBeNull();
    expect(t.tokenUsd).toBeNull();
    expect(t.tokensIncluded).toBe(false);
    expect(t.pricePending).toBe(true);
    expect(t.pendingCount).toBe(1);
    // Must stay true, or the caller's rate fetch is gated on a flag that needs
    // the rate — a deadlock that leaves the token permanently unvalued.
    expect(t.holdsPegged).toBe(true);
  });

  it("treats a non-positive rate as no rate", () => {
    const t = portfolioTotal({
      sync: sync({ [USDT_LIQUID_ASSET_ID]: USDT_UNITS }),
      btcUsd: 0,
    });
    expect(t.pricePending).toBe(true);
    expect(t.totalSats).toBe(LBTC);
  });

  it("counts an asset with no price source as unpriced, and leaves the total alone", () => {
    const t = portfolioTotal({
      sync: sync({ [UNKNOWN_ASSET]: 1_000 }),
      btcUsd: BTC_USD,
    });
    expect(t.unpricedCount).toBe(1);
    expect(t.totalSats).toBe(LBTC);
    expect(t.tokenUsd).toBeNull();
    expect(t.holdsPegged).toBe(false);
    // Specifically NOT scaled as if precision were 8 and pegged to a dollar.
    expect(t.tokenSats).toBeNull();
  });

  it("counts unpriced assets alongside a priced one", () => {
    const t = portfolioTotal({
      sync: sync({
        [USDT_LIQUID_ASSET_ID]: USDT_UNITS,
        [UNKNOWN_ASSET]: 1_000,
        ["b".repeat(64)]: 7,
      }),
      btcUsd: BTC_USD,
    });
    expect(t.unpricedCount).toBe(2);
    expect(t.tokenSats).toBe(233_209);
  });

  it("ignores zero balances on every counter", () => {
    const t = portfolioTotal({
      sync: sync({ [USDT_LIQUID_ASSET_ID]: 0, [UNKNOWN_ASSET]: 0 }),
      btcUsd: BTC_USD,
    });
    expect(t.holdsPegged).toBe(false);
    expect(t.unpricedCount).toBe(0);
    expect(t.pendingCount).toBe(0);
    expect(t.totalSats).toBe(LBTC);
  });

  /**
   * A malformed registry entry must land in `unpricedCount`, where the subtitle
   * announces it, rather than contribute a wrong number or a silent zero.
   *
   * The failure this guards is quiet in both directions: a huge precision makes
   * `10 ** precision` Infinity and `amt / Infinity` zero, so the holding vanishes
   * from the total with nothing said; a negative one multiplies the balance
   * instead of dividing it. Neither throws, so without the guard the only symptom
   * is a wrong headline figure.
   */
  it.each([
    ["a precision beyond Liquid's 0-8 range", 400],
    ["a negative precision", -2],
    ["a fractional precision", 2.5],
    ["a non-numeric precision", Number.NaN],
  ])("treats %s as unpriced rather than mis-scaling the balance", (_label, precision) => {
    const MALFORMED = "c".repeat(64);
    KNOWN_ASSETS[MALFORMED] = { label: "BAD", precision, pegUsd: true };
    try {
      const t = portfolioTotal({
        sync: sync({ [MALFORMED]: 15_042_000_000 }),
        btcUsd: BTC_USD,
      });
      expect(t.unpricedCount).toBe(1);
      expect(t.totalSats).toBe(LBTC);
      expect(t.tokenUsd).toBeNull();
      expect(t.holdsPegged).toBe(false);
      expect(Number.isFinite(t.totalSats)).toBe(true);
    } finally {
      delete KNOWN_ASSETS[MALFORMED];
    }
  });

  it("still accepts the precision bounds themselves", () => {
    for (const precision of [0, 8]) {
      const ASSET = "d".repeat(64);
      KNOWN_ASSETS[ASSET] = { label: "OK", precision, pegUsd: true };
      try {
        const t = portfolioTotal({ sync: sync({ [ASSET]: 100 }), btcUsd: BTC_USD });
        expect(t.unpricedCount).toBe(0);
        expect(t.holdsPegged).toBe(true);
      } finally {
        delete KNOWN_ASSETS[ASSET];
      }
    }
  });

  it("returns zeros while unsynced", () => {
    const t = portfolioTotal({ sync: null, btcUsd: BTC_USD });
    expect(t).toEqual({
      totalSats: 0,
      lbtcSats: 0,
      tokenSats: null,
      tokenUsd: null,
      holdsPegged: false,
      tokensIncluded: false,
      pricePending: false,
      pendingCount: 0,
      unpricedCount: 0,
    });
  });

  it("values a token-only wallet — the case the hero used to render as 0", () => {
    const t = portfolioTotal({
      sync: sync({ [USDT_LIQUID_ASSET_ID]: 50_000_000 }, 0), // 0.50 USDt, no LBTC
      btcUsd: BTC_USD,
    });
    expect(t.lbtcSats).toBe(0);
    expect(t.totalSats).toBe(775);
    expect(t.tokensIncluded).toBe(true);
  });
});

/**
 * The rule that keeps the hero and the list beneath it in agreement, which is why
 * it lives in this module rather than in the component: it is the one piece of
 * this feature a component test would otherwise have to cover.
 */
describe("assetRows", () => {
  it("omits L-BTC while the hero is just the L-BTC balance", () => {
    // An L-BTC-only wallet: nothing to itemize, so the section disappears
    // entirely rather than restating the hero in a one-row list.
    expect(assetRows(sync(), false)).toEqual([]);
  });

  it("lists L-BTC first once the hero is a total", () => {
    const rows = assetRows(sync({ [USDT_LIQUID_ASSET_ID]: USDT_UNITS }), true);
    expect(rows.map(([asset]) => asset)).toEqual([LBTC_MAINNET_ASSET_ID, USDT_LIQUID_ASSET_ID]);
    expect(rows).toEqual([
      [LBTC_MAINNET_ASSET_ID, LBTC],
      [USDT_LIQUID_ASSET_ID, USDT_UNITS],
    ]);
  });

  it("keeps L-BTC first regardless of the order the balance map arrives in", () => {
    // Object key order follows insertion, and the sync result is not sorted, so
    // the anchor position has to be enforced rather than assumed.
    const out = assetRows(
      {
        lbtcSats: LBTC,
        balance: { [USDT_LIQUID_ASSET_ID]: USDT_UNITS, [LBTC_MAINNET_ASSET_ID]: LBTC },
        policyAssetHex: LBTC_MAINNET_ASSET_ID,
      },
      true,
    );
    expect(out[0][0]).toBe(LBTC_MAINNET_ASSET_ID);
  });

  it("still lists other assets when the hero is not a total", () => {
    // An unpriceable holding contributes nothing, so the hero stays the plain
    // L-BTC balance — but the asset is still held and still shown.
    const rows = assetRows(sync({ [UNKNOWN_ASSET]: 1_000 }), false);
    expect(rows).toEqual([[UNKNOWN_ASSET, 1_000]]);
  });

  it("drops zero balances so a spent-out asset leaves no empty row", () => {
    expect(assetRows(sync({ [USDT_LIQUID_ASSET_ID]: 0 }), true).map(([a]) => a)).toEqual([
      LBTC_MAINNET_ASSET_ID,
    ]);
  });

  it("omits a zero L-BTC balance even when itemizing", () => {
    const rows = assetRows(sync({ [USDT_LIQUID_ASSET_ID]: USDT_UNITS }, 0), true);
    expect(rows).toEqual([[USDT_LIQUID_ASSET_ID, USDT_UNITS]]);
  });

  it("has nothing to show while unsynced", () => {
    expect(assetRows(null, true)).toEqual([]);
  });
});

describe("heroSubtitle", () => {
  const lbtcOnly = portfolioTotal({ sync: sync(), btcUsd: BTC_USD });
  const withToken = portfolioTotal({
    sync: sync({ [USDT_LIQUID_ASSET_ID]: USDT_UNITS }),
    btcUsd: BTC_USD,
  });

  // Byte-identical to the pre-total strings: a wallet holding only LBTC must
  // see no change whatsoever from this feature.
  it.each([
    ["sats", "sats"],
    ["btc", "LBTC · 2,157,431 sats"],
    ["fiat", "USD · 2,157,431 sats"],
  ] as const)("keeps today's copy in %s mode when no token contributes", (denom, expected) => {
    expect(
      heroSubtitle({ denom, fiat: "USD", total: lbtcOnly, rate: BTC_USD, missingCount: 0 }),
    ).toBe(expected);
  });

  it.each([
    ["sats", "total sats · $1,541.96"],
    ["btc", "total LBTC · $1,541.96"],
    ["fiat", "total USD · 2,390,640 sats"],
  ] as const)("names the figure a total in %s mode when a token contributes", (denom, expected) => {
    expect(
      heroSubtitle({ denom, fiat: "USD", total: withToken, rate: BTC_USD, missingCount: 0 }),
    ).toBe(expected);
  });

  it("keeps the currency code so $ can't be read as the wrong dollar", () => {
    const line = heroSubtitle({
      denom: "fiat",
      fiat: "CAD",
      total: withToken,
      rate: 88_000,
      missingCount: 0,
    });
    expect(line).toBe("total CAD · 2,390,640 sats");
  });

  it("drops the secondary rather than trailing a separator when the rate is unknown", () => {
    expect(
      heroSubtitle({ denom: "sats", fiat: "USD", total: withToken, rate: null, missingCount: 0 }),
    ).toBe("total sats");
    expect(
      heroSubtitle({ denom: "btc", fiat: "USD", total: withToken, rate: null, missingCount: 0 }),
    ).toBe("total LBTC");
  });

  it.each([1, 2])("announces %i excluded holding(s) in the tokens branch", (n) => {
    expect(
      heroSubtitle({ denom: "sats", fiat: "USD", total: withToken, rate: BTC_USD, missingCount: n }),
    ).toBe(`total sats · $1,541.96 · +${n} unpriced`);
  });

  it("announces excluded holdings in the no-tokens branch too", () => {
    expect(
      heroSubtitle({ denom: "sats", fiat: "USD", total: lbtcOnly, rate: BTC_USD, missingCount: 1 }),
    ).toBe("sats · +1 unpriced");
  });

  // The line must not wrap: the figure above sits in a fixed h-9, so a wrapped
  // subtitle is the only way the balance frame can change height and shift the
  // Send/Receive row beneath it. `truncate` on the span is the actual guard —
  // character count is only a proxy for width, and no unit test can measure a
  // rendered px. What this bound is for is catching a change that makes the line
  // categorically longer: a third figure, or reverting to a phrasing like
  // "+ N unpriced assets".
  //
  // The fixtures deliberately include a 1,000-BTC balance, which is the case
  // Wallet.tsx cites as the widest it measured. An earlier version of this test
  // asserted <= 44 while only ever exercising the 2.1M-sat fixture — the cited
  // case is 46, so the bound passed by never testing what it claimed to cover.
  it("stays on one line for the widest realistic balance", () => {
    const huge = portfolioTotal({
      sync: sync({ [USDT_LIQUID_ASSET_ID]: USDT_UNITS }, 100_000_000_000),
      btcUsd: BTC_USD,
    });
    const lines = (["sats", "btc", "fiat"] as const).flatMap((denom) =>
      [lbtcOnly, withToken, huge].flatMap((total) =>
        [0, 2, 9].map((missingCount) =>
          heroSubtitle({ denom, fiat: "USD", total, rate: BTC_USD, missingCount }),
        ),
      ),
    );
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(48);
    // And the widest case really is the one Wallet.tsx names, so that comment
    // stays honest if someone reshuffles the copy.
    expect(Math.max(...lines.map((l) => l.length))).toBe(
      heroSubtitle({ denom: "fiat", fiat: "USD", total: huge, rate: BTC_USD, missingCount: 9 })
        .length,
    );
  });
});
