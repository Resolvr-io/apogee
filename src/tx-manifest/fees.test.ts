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

function candidate(selectionFee: string, actualFee = selectionFee): TxManifestFeeCandidate {
  return {
    pset: `pset-at-${actualFee}`,
    feeSelectionTarget: selectionFee,
    review: { fee: actualFee },
  };
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
        {
          feeRateSatPerKvb: "100",
          maxFee: "1000",
          exactFee: "80",
          exactSelectionFee: "80",
        },
        prepare,
        async () => ({ discountVsize: 790, requiredFee: "79", unsignedWalletInputs: 1 }),
      ),
    ).resolves.toEqual(candidate("80"));
    expect(prepare).toHaveBeenCalledOnce();

    await expect(
      convergeTxManifestFee(
        {
          feeRateSatPerKvb: "100",
          maxFee: "1000",
          exactFee: "80",
          exactSelectionFee: "80",
        },
        prepare,
        async () => ({ discountVsize: 810, requiredFee: "81", unsignedWalletInputs: 1 }),
      ),
    ).rejects.toThrow("reviewed fee");
  });

  it("accepts sub-floor change folded above the selection fee", async () => {
    const prepare = vi.fn(async (fee: string) =>
      fee === "80" ? candidate("80", "86") : candidate(fee),
    );
    await expect(
      convergeTxManifestFee(
        { feeRateSatPerKvb: "100", maxFee: "1000" },
        prepare,
        async ({ pset }) => ({
          discountVsize: 850,
          requiredFee: pset === "pset-at-1" ? "80" : "85",
          unsignedWalletInputs: 1,
        }),
      ),
    ).resolves.toEqual(candidate("80", "86"));
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("revalidates both the reviewed selection target and folded actual fee", async () => {
    const prepare = vi.fn(async (fee: string) => candidate(fee, "86"));
    await expect(
      convergeTxManifestFee(
        {
          feeRateSatPerKvb: "100",
          maxFee: "1000",
          exactFee: "86",
          exactSelectionFee: "80",
        },
        prepare,
        async () => ({ discountVsize: 850, requiredFee: "85", unsignedWalletInputs: 1 }),
      ),
    ).resolves.toEqual(candidate("80", "86"));
    expect(prepare).toHaveBeenCalledWith("80");

    await expect(
      convergeTxManifestFee(
        {
          feeRateSatPerKvb: "100",
          maxFee: "1000",
          exactFee: "85",
          exactSelectionFee: "80",
        },
        prepare,
        async () => ({ discountVsize: 850, requiredFee: "85", unsignedWalletInputs: 1 }),
      ),
    ).rejects.toThrow("reviewed fee");
  });

  it("requires exact actual and selection fees as a pair", async () => {
    await expect(
      convergeTxManifestFee(
        { feeRateSatPerKvb: "100", maxFee: "1000", exactFee: "80" },
        async (fee) => candidate(fee),
      ),
    ).rejects.toThrow("supplied together");
  });

  it("applies the fee cap to a folded actual fee", async () => {
    await expect(
      convergeTxManifestFee(
        { feeRateSatPerKvb: "100", maxFee: "85" },
        async (fee) => candidate(fee, "86"),
      ),
    ).rejects.toThrow("fee cap");
  });

  it("rejects a required fee implying an implausible rate for the transaction size", async () => {
    await expect(
      convergeTxManifestFee(
        { feeRateSatPerKvb: "100", maxFee: "100000" },
        async (fee) => candidate(fee),
        async () => ({ discountVsize: 500, requiredFee: "50000", unsignedWalletInputs: 1 }),
      ),
    ).rejects.toThrow("implausibly high");
  });
});
