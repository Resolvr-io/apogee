import { describe, expect, it } from "vitest";
import { formatAssetAmountExact, formatBaseUnits } from "./format";

describe("exact amount formatting", () => {
  it("groups values above JavaScript's safe-integer range without rounding", () => {
    expect(formatBaseUnits("18446744073709551615")).toBe("18,446,744,073,709,551,615");
  });

  it("places an asset decimal point using string math", () => {
    expect(formatAssetAmountExact("18446744073709551615", 8)).toBe(
      "184,467,440,737.09551615",
    );
    expect(formatAssetAmountExact("100000000", 8)).toBe("1.00");
  });
});
