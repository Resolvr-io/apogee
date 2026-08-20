import { describe, expect, it, vi } from "vitest";
import {
  isKnownTxManifestBroadcastError,
  isPermanentTxManifestBroadcastError,
  lookupTxManifestTransaction,
  parseTxManifestCheckpointPayload,
} from "./broadcast-checkpoint";

const TXID = "11".repeat(32);

describe("lookupTxManifestTransaction", () => {
  it("reports found when either automatic provider recognizes the transaction", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response("02000000", { status: 200 }));

    await expect(
      lookupTxManifestTransaction("liquidtestnet", TXID, undefined, fetcher),
    ).resolves.toBe("found");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("only reports missing when every applicable provider returns 404", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    await expect(
      lookupTxManifestTransaction("liquidtestnet", TXID, undefined, fetcher),
    ).resolves.toBe("missing");
  });

  it("keeps outages ambiguous and respects a configured server", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    await expect(
      lookupTxManifestTransaction("regtest", TXID, "http://127.0.0.1:1234/api/", fetcher),
    ).resolves.toBe("unknown");
    expect(fetcher).toHaveBeenCalledWith(
      `http://127.0.0.1:1234/api/tx/${TXID}/hex`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not mistake an unknown transaction's false status body for retrievable bytes", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"confirmed":false}', { status: 200 }));

    await expect(
      lookupTxManifestTransaction("regtest", TXID, "http://127.0.0.1:1234/api", fetcher),
    ).resolves.toBe("unknown");
  });
});

describe("isPermanentTxManifestBroadcastError", () => {
  it("distinguishes invalid exact bytes from ambiguous network failures", () => {
    expect(isPermanentTxManifestBroadcastError(new Error("bad-txns-inputs-missingorspent"))).toBe(
      true,
    );
    expect(isPermanentTxManifestBroadcastError(new Error("mandatory-script-verify-flag failed"))).toBe(
      true,
    );
    expect(isPermanentTxManifestBroadcastError(new Error("min relay fee not met"))).toBe(false);
    expect(isPermanentTxManifestBroadcastError(new Error("txn-mempool-conflict"))).toBe(false);
    expect(isPermanentTxManifestBroadcastError(new Error("502 Bad Gateway"))).toBe(false);
    expect(isPermanentTxManifestBroadcastError(new Error("transaction already in mempool"))).toBe(
      false,
    );
  });
});

describe("isKnownTxManifestBroadcastError", () => {
  it("recognizes only errors that prove the exact transaction is already present", () => {
    expect(isKnownTxManifestBroadcastError(new Error("transaction already in mempool"))).toBe(
      true,
    );
    expect(isKnownTxManifestBroadcastError(new Error("txn-already-in-mempool"))).toBe(true);
    expect(isKnownTxManifestBroadcastError(new Error("txn-mempool-conflict"))).toBe(false);
  });
});

describe("parseTxManifestCheckpointPayload", () => {
  it("rejects malformed or non-hex transaction data", () => {
    expect(() => parseTxManifestCheckpointPayload("null")).toThrow("Invalid");
    expect(() =>
      parseTxManifestCheckpointPayload(
        JSON.stringify({ version: 1, transactionHex: "xyz", txid: TXID, result: {}, review: {} }),
      ),
    ).toThrow("Invalid");
  });
});
