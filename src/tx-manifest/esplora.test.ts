import { describe, expect, it, vi } from "vitest";
import type {
  AcceptOfferRequirementPlan,
  ClaimLenderVaultRequirementPlan,
} from "./requirements";
import {
  resolveAcceptOfferChainSnapshot,
  resolveClaimLenderVaultChainSnapshot,
  LIQUID_TESTNET_GENESIS_HASH,
} from "./esplora";
import { SIMPLICITY_LENDING_V3_REGTEST_GENESIS_HASH } from "./network";

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
      if (url.endsWith("/fee-estimates")) return response({ "1": 0.25 });
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
      LIQUID_TESTNET_GENESIS_HASH,
      fetcher,
    );
    expect(result.esploraUrl).toBe("https://test.invalid/api");
    expect(result.snapshot.tipHeight).toBe(321);
    expect(result.snapshot.pendingOffer.txid).toBe(PENDING);
    expect(result.snapshot.lenderNftAuthorization.txid).toBe(NFT);
    expect(result.snapshot.parentTransactions).toEqual(["pending-raw", "nft-raw"]);
    expect(result.snapshot.feePolicy).toEqual({
      feeRateSatPerKvb: "250",
      maxFee: "1000",
    });
  });

  it("accepts an explicitly configured server for the expected regtest genesis", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/block-height/0")) {
        return response(SIMPLICITY_LENDING_V3_REGTEST_GENESIS_HASH);
      }
      if (url.endsWith("/blocks/tip/height")) return response("99");
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
      asset: "44".repeat(32),
      amount: "1",
      explicit: true,
    }));

    const result = await resolveAcceptOfferChainSnapshot(
      plan(),
      POLICY,
      inspect,
      "http://127.0.0.1:3002/api/",
      SIMPLICITY_LENDING_V3_REGTEST_GENESIS_HASH,
      fetcher,
    );

    expect(result.esploraUrl).toBe("http://127.0.0.1:3002/api");
    expect(result.snapshot.genesisHash).toBe(SIMPLICITY_LENDING_V3_REGTEST_GENESIS_HASH);
    expect(result.snapshot.tipHeight).toBe(99);
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
      resolveAcceptOfferChainSnapshot(
        plan(),
        POLICY,
        vi.fn(),
        "https://test.invalid",
        LIQUID_TESTNET_GENESIS_HASH,
        fetcher,
      ),
    ).rejects.toThrow("already spent");
  });
});

describe("resolveClaimLenderVaultChainSnapshot", () => {
  it("resolves both the covenant and wallet-supplied NFT from confirmed unspent outputs", async () => {
    const claimPlan = {
      constraints: { maxFee: "1000" },
      covenantInputs: [{ outpoint: { txid: PENDING, vout: 1 } }],
      walletInputs: [{ outpoint: { txid: NFT, vout: 2 } }, { assetId: "lbtc" }],
    } as unknown as ClaimLenderVaultRequirementPlan;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/block-height/0")) return response(LIQUID_TESTNET_GENESIS_HASH);
      if (url.endsWith("/blocks/tip/height")) return response("444");
      if (url.endsWith("/status")) return response({ confirmed: true });
      if (url.includes("/outspend/")) return response({ spent: false });
      if (url.includes(PENDING)) return response("vault-raw");
      if (url.includes(NFT)) return response("wallet-nft-raw");
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const inspect = vi.fn(async (hex: string, vout: number) => ({
      txid: hex === "vault-raw" ? PENDING : NFT,
      vout,
      tx_out: "00",
      script_pub_key: "51",
      asset: hex === "vault-raw" ? "44".repeat(32) : "55".repeat(32),
      amount: hex === "vault-raw" ? "190" : "1",
      explicit: true,
    }));
    const result = await resolveClaimLenderVaultChainSnapshot(
      claimPlan,
      POLICY,
      inspect,
      "https://test.invalid/api",
      LIQUID_TESTNET_GENESIS_HASH,
      fetcher,
    );
    expect(result.snapshot.tipHeight).toBe(444);
    expect(result.snapshot.lenderVault.txid).toBe(PENDING);
    expect(result.snapshot.lenderNft.txid).toBe(NFT);
    expect(result.snapshot.parentTransactions).toEqual(["vault-raw", "wallet-nft-raw"]);
    expect(result.snapshot.feePolicy).toEqual({
      feeRateSatPerKvb: "100",
      maxFee: "1000",
    });
  });
});
