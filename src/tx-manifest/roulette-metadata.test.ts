import { describe, expect, it } from "vitest";
import { txManifestActionHintScript } from "./action-hint";
import { SIMPLICITY_ROULETTE_V1_OPEN } from "./builtins/simplicity-roulette-v1";
import { SIMPLICITY_ROULETTE_V1_BUNDLE_HASH } from "./registry";
import { decodeRouletteTransactionMetadata, rouletteMetadataScripts } from "./roulette-metadata";

const HEX = "11".repeat(32);
const DISPLAY_ASSET = Array.from(
  { length: 32 },
  (_, index) => index.toString(16).padStart(2, "0"),
).join("");

describe("roulette metadata v1", () => {
  it("encodes a complete OPEN record into bounded canonical chunks", async () => {
    const scripts = await rouletteMetadataScripts({
      action: "open",
      roundId: HEX,
      assetId: DISPLAY_ASSET,
      playerPayoutScript: `0014${"33".repeat(20)}`,
      secretCommitment: "cf507d7e0c518cfb4b33a026308d5677e6d982b619f976edbaa452c1665f5577",
      betKind: 0,
      betSelection: 17,
      stake: "100000",
      bond: "25000",
      openExpiry: 144,
      minRevealAge: 2,
      revealExpiry: 20,
      covenantVout: 0,
    });
    expect(scripts).toEqual([
      "6a4c50524c54310100000311111111268348c11111111111111111111111111111111111111111111111111111111111111111000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      "6a4c50524c54310100010311111111268348c100143333333333333333333333333333333333333333cf507d7e0c518cfb4b33a026308d5677e6d982b619f976edbaa452c1665f5577001100000000000186a0",
      "6a22524c54310100020311111111268348c100000000000061a800900002001400000000",
    ]);
    for (const [index, script] of scripts.entries()) {
      expect(script).toMatch(/^6a(?:[0-4b][0-9a-f]|4c[0-9a-f]{2})524c54310100/);
      expect(script).toContain(`${index.toString(16).padStart(2, "0")}03${"11".repeat(4)}`);
      expect((script.length - 6) / 2).toBeLessThanOrEqual(80);
    }
    const decoded = await decodeRouletteTransactionMetadata([
      "0014" + "99".repeat(20),
      ...scripts,
      await txManifestActionHintScript(SIMPLICITY_ROULETTE_V1_BUNDLE_HASH, SIMPLICITY_ROULETTE_V1_OPEN),
      "",
    ], SIMPLICITY_ROULETTE_V1_BUNDLE_HASH);
    expect(decoded?.metadata).toMatchObject({
      action: "open",
      assetId: DISPLAY_ASSET,
      playerPayoutScript: `0014${"33".repeat(20)}`,
      stake: "100000",
      covenantVout: 0,
    });
  });

  it("encodes transition links in consensus outpoint order", async () => {
    const scripts = await rouletteMetadataScripts({
      action: "settle",
      roundId: HEX,
      previous: { txid: "bb".repeat(32), vout: 0 },
      playerSecret: "55".repeat(32),
      pocket: 7,
    });
    expect(scripts).toEqual([
      "6a4c50524c54310102000211111111c0da1ba31111111111111111111111111111111111111111111111111111111111111111bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "6a35524c54310102010211111111c0da1ba300000000555555555555555555555555555555555555555555555555555555555555555507",
    ]);
  });

  it("rejects non-canonical or overflowing fields", async () => {
    await expect(rouletteMetadataScripts({
      action: "cancel",
      roundId: "AA".repeat(32),
      previous: { txid: HEX, vout: 0 },
    })).rejects.toThrow("roundId");
  });
});
