import { describe, expect, it } from "vitest";
import { selectAcceptOfferWalletInputs, type AcceptOfferWalletCandidate } from "./wallet-host";

const PRINCIPAL = "11".repeat(32);
const POLICY = "22".repeat(32);

function coin(
  txidByte: string,
  vout: number,
  assetId: string,
  amount: string,
): AcceptOfferWalletCandidate {
  return {
    txid: txidByte.repeat(64),
    vout,
    assetId,
    amount,
    address: "tlq1wallet",
    parentTransaction: "00",
    txOut: "00",
    scriptPubKey: "0014" + "33".repeat(20),
    assetBlindingFactor: "00".repeat(32),
    valueBlindingFactor: "00".repeat(32),
  };
}

describe("selectAcceptOfferWalletInputs", () => {
  it("selects the smallest sufficient deterministic distinct coins", () => {
    const selection = selectAcceptOfferWalletInputs(
      [
        coin("c", 0, PRINCIPAL, "5000"),
        coin("a", 0, PRINCIPAL, "3000"),
        coin("b", 0, POLICY, "2000"),
        coin("d", 0, POLICY, "1000"),
      ],
      PRINCIPAL,
      "2500",
      POLICY,
      "1000",
    );
    expect(selection.principalInput.amount).toBe("3000");
    expect(selection.feeInput.amount).toBe("1000");
  });

  it("requires distinct coins even when principal is L-BTC", () => {
    const shared = coin("a", 0, POLICY, "5000");
    expect(() =>
      selectAcceptOfferWalletInputs([shared], POLICY, "3000", POLICY, "1000"),
    ).toThrow("distinct L-BTC input");
    expect(
      selectAcceptOfferWalletInputs(
        [shared, coin("b", 0, POLICY, "1000")],
        POLICY,
        "3000",
        POLICY,
        "1000",
      ).feeInput.txid,
    ).toBe("b".repeat(64));
  });
});
