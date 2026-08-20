import { describe, expect, it, vi } from "vitest";
import type { AcceptOfferWalletCandidate } from "./wallet-host";
import { selectUnspentRouletteWalletInputs } from "./roulette-wallet-host";

const ASSET = "11".repeat(32);

function candidate(txidByte: string, vout: number, amount: string): AcceptOfferWalletCandidate {
  return {
    txid: txidByte.repeat(64),
    vout,
    txOut: "00",
    scriptPubKey: `0014${"22".repeat(20)}`,
    assetId: ASSET,
    amount,
    assetBlindingFactor: "00".repeat(32),
    valueBlindingFactor: "00".repeat(32),
    address: "ert1wallet",
    parentTransaction: "00",
  };
}

describe("selectUnspentRouletteWalletInputs", () => {
  it("drops a stale deterministic choice and reselects a chain-unspent coin", async () => {
    const stale = candidate("a", 1, "1000");
    const fresh = candidate("b", 2, "1200");
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(init).toMatchObject({ method: "GET", cache: "no-store" });
      const url = String(input);
      return new Response(JSON.stringify({ spent: url.includes(stale.txid) }), { status: 200 });
    });

    await expect(selectUnspentRouletteWalletInputs(
      [stale, fresh],
      "http://127.0.0.1:3000/",
      ASSET,
      "1000",
      [],
      "roulette fee inputs",
      "0",
      fetcher,
    )).resolves.toEqual([fresh]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails closed on malformed outspend responses", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    await expect(selectUnspentRouletteWalletInputs(
      [candidate("c", 0, "1000")],
      "http://127.0.0.1:3000",
      ASSET,
      "1000",
      [],
      "roulette fee inputs",
      "0",
      fetcher,
    )).rejects.toThrow("invalid outspend data");
  });
});
