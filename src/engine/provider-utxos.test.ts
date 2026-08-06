import { describe, expect, it } from "vitest";
import { collectProviderUtxos } from "./provider-utxos";

const ASSET = "6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d";
const OTHER_ASSET = "11".repeat(32);
const SCRIPT = "0014272f557c30d2f520b6d4ae1dbdddaaf08708939f";
const TXOUT = `01${reverseHex(ASSET)}01000000000001e2400016${SCRIPT}`;
const TXID = "4b33bd9a251311bd7f247ea19b3cf9887977ba4d9abe2ec7886de24094252586";
const TRANSACTION = bytes(
  `020000000001${"00".repeat(32)}ffffffff00ffffffff01${TXOUT}00000000`,
);

describe("collectProviderUtxos", () => {
  it("returns only the selected asset and never projects blinding factors", () => {
    const result = collectProviderUtxos(
      {
        transactions: () => [walletTransaction()],
        utxos: () => [walletUtxo(ASSET), walletUtxo(OTHER_ASSET)],
      },
      ASSET,
    );

    expect(result).toEqual([
      {
        txid: TXID,
        vout: 0,
        asset: ASSET,
        amount: "123456",
        address: "ex1qexample",
        scriptPubKey: SCRIPT,
        txOut: TXOUT,
        confidential: false,
      },
    ]);
    expect(Object.keys(result[0] ?? {})).not.toContain("assetBf");
    expect(Object.keys(result[0] ?? {})).not.toContain("valueBf");
  });

  it("fails closed when the raw previous transaction is unavailable", () => {
    expect(() =>
      collectProviderUtxos(
        { transactions: () => [], utxos: () => [walletUtxo(ASSET)] },
        ASSET,
      ),
    ).toThrow(`wallet transaction unavailable for UTXO ${TXID}`);
  });
});

function walletTransaction() {
  return {
    txid: () => ({ toString: () => TXID }),
    tx: () => ({ toBytes: () => TRANSACTION }),
  };
}

function walletUtxo(asset: string) {
  return {
    outpoint: () => ({ txid: () => ({ toString: () => TXID }), vout: () => 0 }),
    unblinded: () => ({
      asset: () => ({ toString: () => asset }),
      value: () => ({ toString: () => "123456" }),
      isExplicit: () => true,
      // These mimic the sensitive methods on LWK's full object. The structural
      // collector cannot access them, and the assertions above prove they do not
      // appear on its wire result.
      assetBlindingFactor: () => ({ toString: () => "aa".repeat(32) }),
      valueBlindingFactor: () => ({ toString: () => "bb".repeat(32) }),
    }),
    address: () => ({ toString: () => "ex1qexample" }),
    scriptPubkey: () => ({ bytes: () => bytes(SCRIPT) }),
  };
}

function bytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
}

function reverseHex(value: string): string {
  return value.match(/../g)?.reverse().join("") ?? "";
}
