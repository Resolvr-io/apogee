import { describe, expect, it, vi } from "vitest";
import {
  convergeTxManifestFee,
  fetchTxManifestFeeRate,
  TX_MANIFEST_FALLBACK_FEE_RATE_SAT_PER_KVB,
  TX_MANIFEST_MAX_FEE,
  txManifestFeePolicy,
  type TxManifestFeeCandidate,
} from "./fees";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function candidate(fee: string): TxManifestFeeCandidate {
  return { pset: `pset-at-${fee}`, review: { fee } };
}

describe("fetchTxManifestFeeRate", () => {
  it("converts Esplora sat/vB estimates to rounded-up integer sat/kvB", async () => {
    const fetcher = vi.fn(async () => response({ "1": 0.1234 })) as unknown as typeof fetch;
    await expect(fetchTxManifestFeeRate(fetcher, "https://example.test/api/")).resolves.toBe("124");
    expect(fetcher).toHaveBeenCalledWith(
      "https://example.test/api/fee-estimates",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("uses the deterministic fallback when estimates are unavailable", async () => {
    const fetcher = vi.fn(async () => response({}, 503)) as unknown as typeof fetch;
    await expect(fetchTxManifestFeeRate(fetcher, "https://example.test")).resolves.toBe(
      TX_MANIFEST_FALLBACK_FEE_RATE_SAT_PER_KVB,
    );
  });
});

describe("txManifestFeePolicy", () => {
  it("keeps the dapp cap authoritative beneath Apogee's wallet ceiling", () => {
    expect(txManifestFeePolicy("250", "1000")).toEqual({
      feeRateSatPerKvb: "250",
      maxFee: "1000",
    });
    expect(txManifestFeePolicy("250", "999999").maxFee).toBe(TX_MANIFEST_MAX_FEE);
    expect(txManifestFeePolicy("250").maxFee).toBe(TX_MANIFEST_MAX_FEE);
  });
});

describe("convergeTxManifestFee", () => {
  it("rebuilds monotonically until a fee-dependent transaction shape settles", async () => {
    const preparedFees: string[] = [];
    const prepare = vi.fn(async (fee: string) => {
      preparedFees.push(fee);
      return candidate(fee);
    });
    const requiredByCandidate = new Map([
      ["pset-at-1", "80"],
      ["pset-at-80", "105"],
      ["pset-at-105", "105"],
    ]);
    const estimate = vi.fn(async ({ pset }: { pset: string; feeRateSatPerKvb: string }) => ({
      discountVsize: 1_050,
      requiredFee: requiredByCandidate.get(pset) ?? "999",
      unsignedWalletInputs: pset === "pset-at-1" ? 1 : 2,
    }));

    await expect(
      convergeTxManifestFee(
        { feeRateSatPerKvb: "100", maxFee: "1000" },
        prepare,
        estimate,
      ),
    ).resolves.toEqual(candidate("105"));
    expect(preparedFees).toEqual(["1", "80", "105"]);
  });

  it("rejects an estimate above the dapp or wallet maximum", async () => {
    await expect(
      convergeTxManifestFee(
        { feeRateSatPerKvb: "100", maxFee: "50" },
        async (fee) => candidate(fee),
        async () => ({ discountVsize: 510, requiredFee: "51", unsignedWalletInputs: 1 }),
      ),
    ).rejects.toThrow("fee cap");
  });

  it("revalidates an exact reviewed fee without silently increasing it", async () => {
    const prepare = vi.fn(async (fee: string) => candidate(fee));
    await expect(
      convergeTxManifestFee(
        { feeRateSatPerKvb: "100", maxFee: "1000", exactFee: "80" },
        prepare,
        async () => ({ discountVsize: 790, requiredFee: "79", unsignedWalletInputs: 1 }),
      ),
    ).resolves.toEqual(candidate("80"));
    expect(prepare).toHaveBeenCalledOnce();

    await expect(
      convergeTxManifestFee(
        { feeRateSatPerKvb: "100", maxFee: "1000", exactFee: "80" },
        prepare,
        async () => ({ discountVsize: 810, requiredFee: "81", unsignedWalletInputs: 1 }),
      ),
    ).rejects.toThrow("reviewed fee");
  });
});
