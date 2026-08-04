// Tests for outbound explorer links.
//
// The one that matters is the testnet path. liquid.network's web UI uses
// `testnet` while its REST API answers under `liquidtestnet`, and our own
// network identifier is the latter — so the obvious implementation, dropping the
// identifier straight into the path the way the blockstream.info URLs did,
// produces a link that loads the explorer and then shows nothing. HTTP probing
// will not catch it either: the explorer is a single-page app that returns 200
// with an identical body for any path, so a wrong segment fails only in front of
// a user.

import { describe, expect, it } from "vitest";
import type { LiquidNetwork } from "@/keystore/keystore";
import { explorerTxUrl } from "./explorer";

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

  it("covers every network the keystore can report", () => {
    const networks: LiquidNetwork[] = ["liquid", "liquidtestnet", "regtest"];
    for (const network of networks) {
      // Either a usable link or an explicit null — never `undefined`, which is
      // what a missing entry in the lookup would silently produce.
      const url = explorerTxUrl(network, TXID);
      expect(url === null || url.startsWith("https://liquid.network/")).toBe(true);
    }
  });
});
