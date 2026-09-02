import { describe, expect, it, vi } from "vitest";
import {
  requireTxManifestFinalTransactionTxid,
  txManifestPsetForFinalization,
} from "./signing";

describe("txManifestPsetForFinalization", () => {
  it("passes signature-free bytes through without invoking a signer", async () => {
    const sign = vi.fn(async () => "signed");
    await expect(txManifestPsetForFinalization("none", "prepared", sign)).resolves.toEqual({
      signingMode: "none",
      pset: "prepared",
    });
    expect(sign).not.toHaveBeenCalled();
  });

  it("signs a wallet-signing plan exactly once", async () => {
    const sign = vi.fn(async () => "signed");
    await expect(txManifestPsetForFinalization("wallet", "prepared", sign)).resolves.toEqual({
      signingMode: "wallet",
      pset: "signed",
    });
    expect(sign).toHaveBeenCalledExactlyOnceWith("prepared");
  });

  it("fails closed on an unknown mode before invoking a signer", async () => {
    const sign = vi.fn(async () => "signed");
    await expect(txManifestPsetForFinalization("future", "prepared", sign)).rejects.toThrow(
      "Unsupported TX Manifest signing mode.",
    );
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("requireTxManifestFinalTransactionTxid", () => {
  it("accepts the exact reviewed transaction template", () => {
    const txid = "11".repeat(32);
    expect(() => requireTxManifestFinalTransactionTxid(txid, txid)).not.toThrow();
  });

  it("rejects a tampered finalized transaction before covenant verification", () => {
    expect(() =>
      requireTxManifestFinalTransactionTxid("11".repeat(32), "22".repeat(32)),
    ).toThrow("does not match the reviewed template");
  });
});
