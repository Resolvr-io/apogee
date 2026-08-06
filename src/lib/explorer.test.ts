// Tests for outbound explorer links.
//
// These PIN the URL mapping; they do not validate it. A green run proves nobody
// has changed the shape by accident, not that `testnet` is the right segment for
// liquid.network's testnet UI — the explorer is a single-page app that answers
// 200 with an identical body for every path, so only a human clicking a link
// establishes that. Treat the mapping itself as manually verified and these
// cases as the thing that keeps it from drifting.
//
// The segment is the trap worth guarding: our network identifier is
// `liquidtestnet` and the explorer's REST prefix is `liquidtestnet`, but its web
// UI wants `testnet`. The obvious implementation — dropping the identifier into
// the path the way the old blockstream.info URLs did — fails only in front of a
// user.

import { describe, expect, it } from "vitest";
import type { LiquidNetwork } from "@/keystore/keystore";
import { explorerAssetUrl, explorerTxUrl } from "./explorer";

const TXID = "cee35b449187a60929294f0478b4c819ae8a8aecf0c99e2d7aaf671dc36949c7";

describe("explorerTxUrl", () => {
  it("puts mainnet at the root, with no network segment", () => {
    expect(explorerTxUrl("liquid", TXID)).toBe(`https://liquid.network/tx/${TXID}`);
  });

  it("uses the explorer's UI segment for testnet, not our network identifier", () => {
    expect(explorerTxUrl("liquidtestnet", TXID)).toBe(`https://liquid.network/testnet/tx/${TXID}`);
    expect(explorerTxUrl("liquidtestnet", TXID)).not.toContain("liquidtestnet");
  });

  it("has no link for regtest", () => {
    expect(explorerTxUrl("regtest", TXID)).toBeNull();
  });

  it("builds an absolute https URL with the txid as the last segment", () => {
    for (const network of ["liquid", "liquidtestnet"] as const) {
      const url = explorerTxUrl(network, TXID);
      expect(url).not.toBeNull();
      const parsed = new URL(url!);
      expect(parsed.protocol).toBe("https:");
      expect(parsed.hostname).toBe("liquid.network");
      expect(parsed.pathname.split("/").pop()).toBe(TXID);
      // No doubled or trailing slashes from assembling the segment by hand.
      expect(parsed.pathname).not.toMatch(/\/\/|\/$/);
    }
  });

  /**
   * Wallet records carry the network as a typed-but-unvalidated string, so a
   * record written by a newer build and read back by an older one can arrive with
   * a name the lookup has never heard of. The cast is the point of the test: it
   * reproduces what the type system cannot.
   *
   * `__proto__` is in the list because it is the case a nullish guard alone does
   * not catch — it indexes to `Object.prototype`, not `undefined`, and produced
   * a live link to `https://liquid.network[object Object]/tx/…` until the lookup
   * was gated on `Object.hasOwn`.
   */
  it("returns null for a network outside the union rather than a broken link", () => {
    for (const unknown of ["liquidmutinynet", "", "liquid-testnet", "__proto__", "constructor", "toString"]) {
      const url = explorerTxUrl(unknown as LiquidNetwork, TXID);
      expect(url).toBeNull();
      // Stringified, so this still reads as an assertion about the URL rather
      // than about null: a regression to `=== null` returns
      // "https://liquid.network/undefinedtx/…" and gets caught here.
      expect(String(url)).not.toContain("undefined");
    }
  });

  it("refuses a txid that is not a 32-byte hash", () => {
    for (const bad of ["", "abc", TXID.slice(0, 63), `${TXID}0`, `${TXID}?x=1`, "../../address/foo"]) {
      expect(explorerTxUrl("liquid", bad)).toBeNull();
    }
    // Case is the one thing it is relaxed about — hex is hex.
    expect(explorerTxUrl("liquid", TXID.toUpperCase())).toBe(
      `https://liquid.network/tx/${TXID.toUpperCase()}`,
    );
  });

  /**
   * Exhaustiveness over `LiquidNetwork` is enforced by `Record<LiquidNetwork, …>`
   * at compile time, not here — this list is hardcoded, so a fourth variant added
   * later would be silently skipped. Its job is narrower: every network the
   * keystore can report today yields either a usable link or an explicit null.
   */
  it("yields a usable link or an explicit null for each network in use today", () => {
    const networks: LiquidNetwork[] = ["liquid", "liquidtestnet", "regtest"];
    for (const network of networks) {
      const url = explorerTxUrl(network, TXID);
      expect(url === null || url.startsWith("https://liquid.network/")).toBe(true);
    }
  });
});

/**
 * The asset route is `assets/asset/:id` — the single-asset view is a child of the
 * assets section in mempool's Liquid frontend, not a top-level `asset/:id`. Pinned
 * because the mistake is undetectable at runtime: a wrong route renders an empty
 * page rather than a 404, for the same single-page-app reason described above.
 */
describe("explorerAssetUrl", () => {
  const LBTC = "6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d";

  it("nests the asset page under /assets", () => {
    expect(explorerAssetUrl("liquid", LBTC)).toBe(`https://liquid.network/assets/asset/${LBTC}`);
    expect(explorerAssetUrl("liquidtestnet", LBTC)).toBe(
      `https://liquid.network/testnet/assets/asset/${LBTC}`,
    );
  });

  it("is not a top-level /asset/ path", () => {
    expect(explorerAssetUrl("liquid", LBTC)).not.toBe(`https://liquid.network/asset/${LBTC}`);
  });

  it("applies the same network and id guards as the transaction link", () => {
    expect(explorerAssetUrl("regtest", LBTC)).toBeNull();
    expect(explorerAssetUrl("__proto__" as LiquidNetwork, LBTC)).toBeNull();
    for (const bad of ["", "abc", `${LBTC}0`, "../../tx/foo"]) {
      expect(explorerAssetUrl("liquid", bad)).toBeNull();
    }
  });
});
