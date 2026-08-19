import { describe, expect, it } from "vitest";
import {
  TX_MANIFEST_MINIMUM_POST_FEE_LBTC_CHANGE,
  txManifestLbtcChangeDecision,
} from "./change-policy";

function decide(remainder: string) {
  return txManifestLbtcChangeDecision(
    [{ amount: (1_000n + BigInt(remainder)).toString() }],
    "900",
    "100",
  );
}

describe("txManifestLbtcChangeDecision", () => {
  it("documents and enforces the 7-sat post-fee boundary", () => {
    expect(TX_MANIFEST_MINIMUM_POST_FEE_LBTC_CHANGE).toBe("7");

    expect(decide("0")).toEqual({
      selectionFee: "100",
      actualFee: "100",
      postFeeChange: "0",
      foldedChange: "0",
    });
    expect(decide("1")).toMatchObject({ actualFee: "101", postFeeChange: "0", foldedChange: "1" });
    expect(decide("6")).toMatchObject({ actualFee: "106", postFeeChange: "0", foldedChange: "6" });
    expect(decide("7")).toMatchObject({ actualFee: "100", postFeeChange: "7", foldedChange: "0" });
    expect(decide("8")).toMatchObject({ actualFee: "100", postFeeChange: "8", foldedChange: "0" });
  });

  it("accounts for fixed L-BTC outputs before classifying change", () => {
    expect(
      txManifestLbtcChangeDecision([{ amount: "600" }, { amount: "506" }], "1000", "100"),
    ).toEqual({
      selectionFee: "100",
      actualFee: "106",
      postFeeChange: "0",
      foldedChange: "6",
    });
  });

  it("rejects malformed amounts and underfunded selections", () => {
    expect(() => txManifestLbtcChangeDecision([{ amount: "10.5" }], "0", "1")).toThrow(
      "selected input amount",
    );
    expect(() => txManifestLbtcChangeDecision([{ amount: "99" }], "0", "100")).toThrow(
      "do not cover",
    );
    expect(() => txManifestLbtcChangeDecision([{ amount: "100" }], "0", "0")).toThrow(
      "greater than zero",
    );
  });
});
