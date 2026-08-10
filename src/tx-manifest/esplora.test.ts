import { describe, expect, it, vi } from "vitest";
import type { AcceptOfferRequirementPlan } from "./requirements";
import { resolveAcceptOfferChainSnapshot, LIQUID_TESTNET_GENESIS_HASH } from "./esplora";

const PENDING = "11".repeat(32);
const NFT = "22".repeat(32);
const POLICY = "33".repeat(32);

function plan(maxFee = "1000"): AcceptOfferRequirementPlan {
  return {
    constraints: { maxFee },
    covenantInputs: [
      { outpoint: { txid: PENDING, vout: 0 } },
      { outpoint: { txid: NFT, vout: 1 } },
    ],
  } as unknown as AcceptOfferRequirementPlan;
}

function response(body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
}

describe("resolveAcceptOfferChainSnapshot", () => {
  it("verifies genesis, confirmation, spend state, and raw transaction identity", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/block-height/0")) return response(LIQUID_TESTNET_GENESIS_HASH);
      if (url.endsWith("/blocks/tip/height")) return response("321");
      if (url.endsWith("/status")) return response({ confirmed: true });
      if (url.includes("/outspend/")) return response({ spent: false });
      if (url.includes(PENDING)) return response("pending-raw");
      if (url.includes(NFT)) return response("nft-raw");
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const inspect = vi.fn(async (hex: string, vout: number) => ({
      txid: hex === "pending-raw" ? PENDING : NFT,
      vout,
      tx_out: "00",
      script_pub_key: "51",
      asset: hex === "pending-raw" ? "44".repeat(32) : "55".repeat(32),
      amount: hex === "pending-raw" ? "10" : "1",
      explicit: true,
    }));
    const result = await resolveAcceptOfferChainSnapshot(
      plan(),
      POLICY,
      inspect,
      "https://test.invalid/api/",
      fetcher,
    );
    expect(result.esploraUrl).toBe("https://test.invalid/api");
    expect(result.snapshot.tipHeight).toBe(321);
    expect(result.snapshot.pendingOffer.txid).toBe(PENDING);
    expect(result.snapshot.lenderNftAuthorization.txid).toBe(NFT);
    expect(result.snapshot.parentTransactions).toEqual(["pending-raw", "nft-raw"]);
  });

  it("fails before network access when the fee cap is too low", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(
      resolveAcceptOfferChainSnapshot(plan("999"), POLICY, vi.fn(), undefined, fetcher),
    ).rejects.toThrow("fee cap");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects spent covenant inputs", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/block-height/0")) return response(LIQUID_TESTNET_GENESIS_HASH);
      if (url.endsWith("/blocks/tip/height")) return response("321");
      if (url.endsWith("/status")) return response({ confirmed: true });
      if (url.includes("/outspend/")) return response({ spent: true });
      return response("raw");
    }) as unknown as typeof fetch;
    await expect(
      resolveAcceptOfferChainSnapshot(plan(), POLICY, vi.fn(), "https://test.invalid", fetcher),
    ).rejects.toThrow("already spent");
  });
});
