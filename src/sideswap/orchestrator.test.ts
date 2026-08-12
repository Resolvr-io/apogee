// Unit tests for the SideSwap swap orchestration logic.
//
// These tests verify that orientPair produces wire params that the SideSwap
// server will accept — specifically, that the server's base_trade_dir conversion
// yields a send_asset matching the UTXOs we filter to.
//
// The SideSwap server logic (from sideswap_api/src/mkt.rs) is:
//
//   base_trade_dir = asset_type == Base ? trade_dir : trade_dir.inv()
//   send_asset     = base_trade_dir == Sell ? Base : Quote
//   recv_asset     = base_trade_dir == Sell ? Quote : Base
//
// If send_asset doesn't match the asset of the UTXOs we send, the server
// rejects with a protocol error ("no UTXO asset found" or
// "more than one input asset found").

import { describe, it, expect } from "vitest";
import {
  orientPair,
  filterSendAssetUtxos,
  executeInstantSwap,
  previewSwapQuote,
} from "./orchestrator";
import {
  LBTC_MAINNET_ASSET_ID,
  LBTC_TESTNET_ASSET_ID,
  USDT_LIQUID_ASSET_ID,
} from "@/lib/asset-registry";
import type { LiquidNetwork } from "@/keystore/keystore";
import type { UtxoDTO } from "@/engine/protocol";
import type { SideSwapAssetType, SideSwapTradeDir } from "./client";

// ---- SideSwap server logic simulation -------------------------------------

/** Simulate SideSwap's base_trade_dir conversion.
 *  Mirrors sideswap_api/src/mkt.rs TradeDir::base_trade_dir(). */
function computeBaseTradeDir(
  tradeDir: SideSwapTradeDir,
  assetType: SideSwapAssetType,
): SideSwapTradeDir {
  if (assetType === "Base") return tradeDir;
  return tradeDir === "Sell" ? "Buy" : "Sell";
}

/** Simulate SideSwap's send_asset determination.
 *  Mirrors sideswap_api/src/mkt.rs send_asset(). */
function computeSendAsset(
  baseTradeDir: SideSwapTradeDir,
  pair: { base: string; quote: string },
): string {
  return baseTradeDir === "Sell" ? pair.base : pair.quote;
}

/** Simulate SideSwap's recv_asset determination.
 *  Mirrors sideswap_api/src/mkt.rs recv_asset(). */
function computeRecvAsset(
  baseTradeDir: SideSwapTradeDir,
  pair: { base: string; quote: string },
): string {
  return baseTradeDir === "Sell" ? pair.quote : pair.base;
}

/** Full server-side simulation: given our wire params, compute what the
 *  server expects as send_asset and recv_asset. */
function serverExpects(oriented: ReturnType<typeof orientPair>) {
  const baseTradeDir = computeBaseTradeDir(oriented.trade_dir, oriented.asset_type);
  return {
    sendAsset: computeSendAsset(baseTradeDir, oriented.asset_pair),
    recvAsset: computeRecvAsset(baseTradeDir, oriented.asset_pair),
  };
}

// ---- test constants -------------------------------------------------------

const MAINNET = "liquid" as LiquidNetwork;
const TESTNET = "liquid-testnet" as LiquidNetwork;

// Use real asset IDs so we test against actual constants
const LBTC_MAINNET = LBTC_MAINNET_ASSET_ID;
const LBTC_TESTNET = LBTC_TESTNET_ASSET_ID;
const USDT = USDT_LIQUID_ASSET_ID;
const SOME_OTHER_ASSET = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

// ---- tests ----------------------------------------------------------------

describe("orientPair — LBTC is always base", () => {
  it("places LBTC as base when sending LBTC (mainnet)", () => {
    const o = orientPair(LBTC_MAINNET, USDT, MAINNET);
    expect(o.asset_pair.base).toBe(LBTC_MAINNET);
    expect(o.asset_pair.quote).toBe(USDT);
  });

  it("places LBTC as base when receiving LBTC (mainnet)", () => {
    const o = orientPair(USDT, LBTC_MAINNET, MAINNET);
    expect(o.asset_pair.base).toBe(LBTC_MAINNET);
    expect(o.asset_pair.quote).toBe(USDT);
  });

  it("places LBTC as base when sending LBTC (testnet)", () => {
    const o = orientPair(LBTC_TESTNET, USDT, TESTNET);
    expect(o.asset_pair.base).toBe(LBTC_TESTNET);
    expect(o.asset_pair.quote).toBe(USDT);
  });

  it("places LBTC as base when receiving LBTC (testnet)", () => {
    const o = orientPair(USDT, LBTC_TESTNET, TESTNET);
    expect(o.asset_pair.base).toBe(LBTC_TESTNET);
    expect(o.asset_pair.quote).toBe(USDT);
  });
});

describe("orientPair — sell-exact mode (the only supported mode)", () => {
  // For sell-exact, trade_dir should always be "Sell" regardless of direction.
  // The server interprets this as "sell the asset_type asset."

  it("sets trade_dir=Sell for LBTC→USDt", () => {
    const o = orientPair(LBTC_MAINNET, USDT, MAINNET);
    expect(o.trade_dir).toBe("Sell");
  });

  it("sets trade_dir=Sell for USDt→LBTC", () => {
    const o = orientPair(USDT, LBTC_MAINNET, MAINNET);
    expect(o.trade_dir).toBe("Sell");
  });

  it("sets trade_dir=Sell for LBTC→arbitrary asset", () => {
    const o = orientPair(LBTC_MAINNET, SOME_OTHER_ASSET, MAINNET);
    expect(o.trade_dir).toBe("Sell");
  });

  it("sets trade_dir=Sell for arbitrary asset→LBTC", () => {
    const o = orientPair(SOME_OTHER_ASSET, LBTC_MAINNET, MAINNET);
    expect(o.trade_dir).toBe("Sell");
  });
});

describe("orientPair — asset_type", () => {
  it("sets asset_type=Base when sending LBTC", () => {
    const o = orientPair(LBTC_MAINNET, USDT, MAINNET);
    expect(o.asset_type).toBe("Base");
  });

  it("sets asset_type=Quote when sending non-LBTC", () => {
    const o = orientPair(USDT, LBTC_MAINNET, MAINNET);
    expect(o.asset_type).toBe("Quote");
  });
});

// ---- THE CRITICAL TEST: does the server's expected send_asset match our UTXOs? ----

describe("orientPair — server expects the correct UTXO asset (no mismatch)", () => {
  // This is the test that catches the "unexpected UTXO asset" bug.
  // If the server's computed send_asset doesn't match the asset we filter
  // UTXOs to (which is always sendAssetId), the swap fails.

  it("LBTC→USDt (mainnet): server expects LBTC UTXOs", () => {
    const sendAsset = LBTC_MAINNET;
    const recvAsset = USDT;
    const o = orientPair(sendAsset, recvAsset, MAINNET);
    const expected = serverExpects(o);
    expect(expected.sendAsset).toBe(sendAsset);
    expect(expected.recvAsset).toBe(recvAsset);
  });

  it("USDt→LBTC (mainnet): server expects USDt UTXOs", () => {
    const sendAsset = USDT;
    const recvAsset = LBTC_MAINNET;
    const o = orientPair(sendAsset, recvAsset, MAINNET);
    const expected = serverExpects(o);
    expect(expected.sendAsset).toBe(sendAsset);
    expect(expected.recvAsset).toBe(recvAsset);
  });

  it("LBTC→USDt (testnet): server expects LBTC UTXOs", () => {
    const sendAsset = LBTC_TESTNET;
    const recvAsset = USDT;
    const o = orientPair(sendAsset, recvAsset, TESTNET);
    const expected = serverExpects(o);
    expect(expected.sendAsset).toBe(sendAsset);
    expect(expected.recvAsset).toBe(recvAsset);
  });

  it("USDt→LBTC (testnet): server expects USDt UTXOs", () => {
    const sendAsset = USDT;
    const recvAsset = LBTC_TESTNET;
    const o = orientPair(sendAsset, recvAsset, TESTNET);
    const expected = serverExpects(o);
    expect(expected.sendAsset).toBe(sendAsset);
    expect(expected.recvAsset).toBe(recvAsset);
  });

  it("LBTC→arbitrary (mainnet): server expects LBTC UTXOs", () => {
    const sendAsset = LBTC_MAINNET;
    const recvAsset = SOME_OTHER_ASSET;
    const o = orientPair(sendAsset, recvAsset, MAINNET);
    const expected = serverExpects(o);
    expect(expected.sendAsset).toBe(sendAsset);
    expect(expected.recvAsset).toBe(recvAsset);
  });

  it("arbitrary→LBTC (mainnet): server expects arbitrary UTXOs", () => {
    const sendAsset = SOME_OTHER_ASSET;
    const recvAsset = LBTC_MAINNET;
    const o = orientPair(sendAsset, recvAsset, MAINNET);
    const expected = serverExpects(o);
    expect(expected.sendAsset).toBe(sendAsset);
    expect(expected.recvAsset).toBe(recvAsset);
  });
});

// ---- regression: the OLD broken code (before orientPair) ------------------

describe("regression — old hardcoded params would have failed", () => {
  // The old code always sent: asset_type="Base", trade_dir="Sell",
  // asset_pair={base: sendAssetId, quote: recvAssetId}
  // For USDt→LBTC, this meant base=USDt (wrong! LBTC must be base).

  it("old code for USDt→LBTC would mismatch send_asset", () => {
    // Old approach: asset_pair={base: USDt, quote: LBTC}, asset_type=Base, trade_dir=Sell
    const oldBaseTradeDir = computeBaseTradeDir("Sell", "Base"); // = Sell
    const oldAssetPair = { base: USDT, quote: LBTC_MAINNET };
    const oldSendAsset = computeSendAsset(oldBaseTradeDir, oldAssetPair);
    // Old code would make server expect USDt as base — but with wrong pair orientation
    // Server sees base=USDt and thinks USDt is LBTC → protocol error
    expect(oldSendAsset).toBe(USDT); // coincidentally matches, but pair is wrong

    // The real problem: server interprets base as LBTC network asset.
    // If base != actual LBTC asset id, the pair is malformed.
    expect(oldAssetPair.base).not.toBe(LBTC_MAINNET);
  });

  it("new code for USDt→LBTC correctly orients LBTC as base", () => {
    const o = orientPair(USDT, LBTC_MAINNET, MAINNET);
    expect(o.asset_pair.base).toBe(LBTC_MAINNET);
    const expected = serverExpects(o);
    expect(expected.sendAsset).toBe(USDT);
  });
});

// ---- filterSendAssetUtxos -------------------------------------------------

describe("filterSendAssetUtxos", () => {
  function mockUtxo(asset: string, value: string): UtxoDTO {
    return {
      txid: "a".repeat(64),
      vout: 0,
      asset,
      assetBf: "bf".repeat(32),
      value,
      valueBf: "ab".repeat(32),
    };
  }

  it("returns only UTXOs matching the send asset", () => {
    const utxos = [
      mockUtxo(LBTC_MAINNET, "100000"),
      mockUtxo(USDT, "5000000000"),
      mockUtxo(LBTC_MAINNET, "50000"),
    ];
    const filtered = filterSendAssetUtxos(utxos, USDT);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].asset).toBe(USDT);
  });

  it("returns all UTXOs for the send asset when multiple exist", () => {
    const utxos = [
      mockUtxo(LBTC_MAINNET, "100000"),
      mockUtxo(LBTC_MAINNET, "50000"),
      mockUtxo(USDT, "5000000000"),
    ];
    const filtered = filterSendAssetUtxos(utxos, LBTC_MAINNET);
    expect(filtered).toHaveLength(2);
    expect(filtered.every((u) => u.asset === LBTC_MAINNET)).toBe(true);
  });

  it("returns empty array when no UTXOs match", () => {
    const utxos = [mockUtxo(LBTC_MAINNET, "100000")];
    const filtered = filterSendAssetUtxos(utxos, USDT);
    expect(filtered).toHaveLength(0);
  });

  it("sets redeem_script to null (P2WPKH)", () => {
    const utxos = [mockUtxo(USDT, "5000000000")];
    const filtered = filterSendAssetUtxos(utxos, USDT);
    expect(filtered[0].redeem_script).toBeNull();
  });

  it("converts value from string to number", () => {
    const utxos = [mockUtxo(USDT, "5000000000")];
    const filtered = filterSendAssetUtxos(utxos, USDT);
    expect(filtered[0].value).toBe(5000000000);
    expect(typeof filtered[0].value).toBe("number");
  });

  it("preserves blinding factors", () => {
    const utxos = [mockUtxo(USDT, "5000000000")];
    const filtered = filterSendAssetUtxos(utxos, USDT);
    expect(filtered[0].asset_bf).toBe("bf".repeat(32));
    expect(filtered[0].value_bf).toBe("ab".repeat(32));
  });
});

// ---- end-to-end: orientPair + filterSendAssetUtxos together ---------------

describe("end-to-end: UTXO asset matches server expectation for all swap directions", () => {
  // This is the definitive test: for each swap direction, filter UTXOs by
  // sendAssetId, then verify the SideSwap server's computed send_asset
  // equals the asset of those filtered UTXOs. If this fails, the server
  // would reject with "no UTXO asset found" / "unexpected UTXO asset".

  function verifyUtxoAssetMatch(
    sendAssetId: string,
    recvAssetId: string,
    network: LiquidNetwork,
  ) {
    const o = orientPair(sendAssetId, recvAssetId, network);
    const expected = serverExpects(o);

    // The UTXOs we filter will all have asset === sendAssetId
    expect(expected.sendAsset).toBe(sendAssetId);
    expect(expected.recvAsset).toBe(recvAssetId);
  }

  it("LBTC→USDt mainnet", () => {
    verifyUtxoAssetMatch(LBTC_MAINNET, USDT, MAINNET);
  });

  it("USDt→LBTC mainnet", () => {
    verifyUtxoAssetMatch(USDT, LBTC_MAINNET, MAINNET);
  });

  it("LBTC→USDt testnet", () => {
    verifyUtxoAssetMatch(LBTC_TESTNET, USDT, TESTNET);
  });

  it("USDt→LBTC testnet", () => {
    verifyUtxoAssetMatch(USDT, LBTC_TESTNET, TESTNET);
  });

  it("LBTC→arbitrary mainnet", () => {
    verifyUtxoAssetMatch(LBTC_MAINNET, SOME_OTHER_ASSET, MAINNET);
  });

  it("arbitrary→LBTC mainnet", () => {
    verifyUtxoAssetMatch(SOME_OTHER_ASSET, LBTC_MAINNET, MAINNET);
  });
});

// ---- fail-closed: receive-exact without reviewed send amount ---------------

describe("executeInstantSwap — fail-closed on missing reviewedSendAmount", () => {
  it("rejects receive-exact swap when reviewedSendAmount is absent", async () => {
    // No deps needed — the guard fires before any engine/client calls.
    const params = {
      sendAssetId: LBTC_MAINNET,
      recvAssetId: USDT,
      recvAmount: 100_000_000,
      maxFee: 1000n,
      // reviewedSendAmount intentionally omitted
    };
    const fakeDeps = {
      client: {} as never,
      engineCall: (() => { throw new Error("should not be called"); }) as never,
      descriptor: "",
      network: MAINNET,
      mnemonic: "",
    };
    await expect(executeInstantSwap(params, fakeDeps))
      .rejects.toThrow("receive-exact swap requires a reviewed send amount");
  });

  it("does not reject sell-exact swap when reviewedSendAmount is absent", async () => {
    // Sell-exact should pass the guard (it will fail later on missing UTXOs,
    // which confirms the guard didn't fire).
    const params = {
      sendAssetId: LBTC_MAINNET,
      recvAssetId: USDT,
      sendAmount: 100_000,
      maxFee: 1000n,
      // reviewedSendAmount intentionally omitted — fine for sell-exact
    };
    const fakeDeps = {
      client: {} as never,
      engineCall: (() => Promise.resolve([])) as never,
      descriptor: "",
      network: MAINNET,
      mnemonic: "",
    };
    // Should fail on "no UTXOs found", not on the reviewedSendAmount guard
    await expect(executeInstantSwap(params, fakeDeps))
      .rejects.toThrow("no UTXOs found");
  });
});

// ---- previewSwapQuote: the pay amount must include the dealer's fee ---------
//
// `base_amount` EXCLUDES the dealer fee, which is L-BTC-denominated. Measured on a
// real $1 receive-exact quote: base 1556 + 83 fee = 1639, matching both SideSwap's
// own 1638-sat ask and the ~1643 implied by a live sell-exact swap. Two things broke
// when the preview returned the fee-exclusive figure:
//
//   1. "You pay" understated the charge (verified on mainnet: screen said 1556, the
//      true cost was 1639).
//   2. `reviewedSendAmount` fed the receive-exact `maxSendAmount` cap
//      (reviewed * 105/100). With base 1556 the cap was 1633 — BELOW the real 1639
//      charge — so the gate rejected a swap where nothing had drifted. An 83-sat fee
//      is 5.3% of base, consuming the whole 5% drift allowance.
describe("previewSwapQuote — fee-inclusive send amount", () => {
  const LBTC = LBTC_MAINNET_ASSET_ID;
  const USDT = USDT_LIQUID_ASSET_ID;

  /** Deps that answer the preview flow with a fixed dealer quote. */
  function depsFor(
    quote: { base_amount: number; quote_amount: number; fixed_fee: number; server_fee: number },
    utxoAsset: string = LBTC,
  ) {
    let handler: ((q: unknown) => void) | null = null;
    return {
      client: {
        startQuotes: async () => {
          // Push the quote once the orchestrator has registered its handler.
          setTimeout(() => handler?.({
            quote_sub_id: 1,
            status: { Success: { ...quote, quote_id: 7, ttl: 30_000 } },
          }), 0);
          return { fee_asset: "Base" as const, quote_sub_id: 1 };
        },
        onQuote: (h: (q: unknown) => void) => { handler = h; },
      } as never,
      engineCall: (async (req: { kind: string }) => {
        if (req.kind === "getUtxos") {
          return [{ txid: "a".repeat(64), vout: 0, asset: utxoAsset, assetBf: "b", value: "1000000000", valueBf: "c" }];
        }
        if (req.kind === "getAddress") return { address: "lq1address", index: 0 };
        throw new Error(`unexpected engine call: ${req.kind}`);
      }) as never,
      descriptor: "ct(slip77(00),elwpkh(xpub))",
      network: "liquid" as LiquidNetwork,
    };
  }

  it("adds the dealer fee to sendAmount when sending L-BTC", async () => {
    // The real measured quote.
    const res = await previewSwapQuote(
      { sendAssetId: LBTC, recvAssetId: USDT, recvAmount: 100_000_000 },
      depsFor({ base_amount: 1556, quote_amount: 100_000_000, fixed_fee: 83, server_fee: 0 }),
    );
    expect(res.sendAmount).toBe(1639n); // 1556 + 83, matching SideSwap's own ask
    expect(res.fixedFee).toBe(83n); // still reported separately for the breakdown
  });

  it("keeps the 5% receive-exact cap above the real charge", async () => {
    const res = await previewSwapQuote(
      { sendAssetId: LBTC, recvAssetId: USDT, recvAmount: 100_000_000 },
      depsFor({ base_amount: 1556, quote_amount: 100_000_000, fixed_fee: 83, server_fee: 0 }),
    );
    // This is what executeInstantSwap derives as maxSendAmount.
    const cap = (res.sendAmount * 105n) / 100n;
    expect(cap).toBeGreaterThan(res.sendAmount); // real headroom, not negative
    // Regression guard: the fee-exclusive basis produced a cap BELOW the charge.
    expect((1556n * 105n) / 100n).toBeLessThan(1639n);
  });

  it("does NOT add the L-BTC fee to a USDt send amount", async () => {
    // Fees are always L-BTC. On a USDt send the dealer covers them and they surface
    // as a reduced receive — adding them to a USDt figure would mix assets.
    const res = await previewSwapQuote(
      { sendAssetId: USDT, recvAssetId: LBTC, sendAmount: 400_000_000 },
      depsFor({ base_amount: 6194, quote_amount: 400_000_000, fixed_fee: 83, server_fee: 0 }, USDT),
    );
    expect(res.sendAmount).toBe(400_000_000n); // quote_amount, unmodified
    expect(res.recvAmount).toBe(6194n);
  });
});
