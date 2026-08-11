import { describe, expect, it } from "vitest";
import {
  recoverExplicitWalletInputCandidate,
  selectAcceptOfferWalletInputs,
  selectClaimLenderVaultWalletInputs,
  selectManifestWalletInputs,
  type AcceptOfferWalletCandidate,
} from "./wallet-host";

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
    expect(selection.principalInputs.map(({ amount }) => amount)).toEqual(["3000"]);
    expect(selection.feeInputs.map(({ amount }) => amount)).toEqual(["1000"]);
  });

  it("combines L-BTC principal and fee into one deterministic funding target", () => {
    const selection = selectAcceptOfferWalletInputs(
      [coin("c", 0, POLICY, "2500"), coin("a", 0, POLICY, "2000")],
      POLICY,
      "3000",
      POLICY,
      "1000",
    );
    expect(selection.principalInputs.map(({ txid }) => txid[0])).toEqual(["a", "c"]);
    expect(selection.feeInputs).toEqual([]);
  });
});

describe("selectManifestWalletInputs", () => {
  it("finds an exact fragmented subset and returns canonical outpoint order", () => {
    const selected = selectManifestWalletInputs(
      [
        coin("d", 0, PRINCIPAL, "1200"),
        coin("b", 1, PRINCIPAL, "800"),
        coin("a", 2, PRINCIPAL, "700"),
      ],
      PRINCIPAL,
      "2000",
    );
    expect(selected.map(({ txid }) => txid[0])).toEqual(["b", "d"]);
  });

  it("uses stable outpoints to break otherwise identical selections", () => {
    const selected = selectManifestWalletInputs(
      [
        coin("d", 0, PRINCIPAL, "600"),
        coin("c", 0, PRINCIPAL, "600"),
        coin("b", 0, PRINCIPAL, "400"),
        coin("a", 0, PRINCIPAL, "400"),
      ],
      PRINCIPAL,
      "1000",
    );
    expect(selected.map(({ txid }) => txid[0])).toEqual(["a", "c"]);
  });

  it("prefers dust-safe change when the caller supplies a minimum-change floor", () => {
    const selected = selectManifestWalletInputs(
      [coin("a", 0, PRINCIPAL, "1001"), coin("b", 0, PRINCIPAL, "1200")],
      PRINCIPAL,
      "1000",
      [],
      "principal inputs",
      "100",
    );
    expect(selected.map(({ amount }) => amount)).toEqual(["1200"]);
  });

  it("rejects balances requiring more than the bounded input count", () => {
    const fragmented = Array.from({ length: 13 }, (_, index) =>
      coin(index.toString(16), 0, PRINCIPAL, "1"),
    );
    expect(() => selectManifestWalletInputs(fragmented, PRINCIPAL, "13")).toThrow(
      /at most 12 inputs/,
    );
  });
});

describe("selectClaimLenderVaultWalletInputs", () => {
  it("requires the exact wallet-owned NFT and a distinct fee input", () => {
    const nft = coin("a", 2, PRINCIPAL, "1");
    const fee = coin("b", 0, POLICY, "1000");
    const selected = selectClaimLenderVaultWalletInputs(
      [fee, nft],
      { txid: nft.txid, vout: nft.vout },
      PRINCIPAL,
      POLICY,
      "1000",
    );
    expect(selected).toEqual({ lenderNftInput: nft, feeInputs: [fee] });
  });

  it("rejects a supplied NFT that the wallet does not own", () => {
    expect(() =>
      selectClaimLenderVaultWalletInputs(
        [coin("b", 0, POLICY, "1000")],
        { txid: "a".repeat(64), vout: 2 },
        PRINCIPAL,
        POLICY,
        "1000",
      ),
    ).toThrow(/not an unspent coin owned/);
  });

  it("recovers an explicit NFT only when its verified script belongs to the wallet", () => {
    const fee = coin("b", 0, POLICY, "1000");
    const resolvedNft = coin("a", 2, PRINCIPAL, "1");
    const recovered = recoverExplicitWalletInputCandidate(
      [fee],
      { txid: resolvedNft.txid, vout: resolvedNft.vout },
      resolvedNft,
      [{ address: resolvedNft.address, scriptPubKey: resolvedNft.scriptPubKey }],
      resolvedNft.parentTransaction,
    );
    expect(
      selectClaimLenderVaultWalletInputs(
        recovered,
        { txid: resolvedNft.txid, vout: resolvedNft.vout },
        PRINCIPAL,
        POLICY,
        "1000",
      ).lenderNftInput,
    ).toMatchObject({ txid: resolvedNft.txid, vout: resolvedNft.vout });
  });

  it("does not recover an explicit NFT for a foreign wallet script", () => {
    const resolvedNft = coin("a", 2, PRINCIPAL, "1");
    const recovered = recoverExplicitWalletInputCandidate(
      [coin("b", 0, POLICY, "1000")],
      { txid: resolvedNft.txid, vout: resolvedNft.vout },
      resolvedNft,
      [{ address: "tlq1foreign", scriptPubKey: "0014" + "44".repeat(20) }],
      resolvedNft.parentTransaction,
    );
    expect(recovered).toHaveLength(1);
  });
});
