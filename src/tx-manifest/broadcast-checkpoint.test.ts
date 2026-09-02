import { describe, expect, it, vi } from "vitest";
import {
  isKnownTxManifestBroadcastError,
  isPermanentTxManifestBroadcastError,
  lookupTxManifestTransaction,
  parseTxManifestCheckpointPayload,
  readTxManifestCheckpointPayload,
  requireTxManifestRecoveryPlanBinding,
} from "./broadcast-checkpoint";
import type { TxManifestApprovalReviewDTO } from "@/engine/protocol";
import type { TxManifestCheckpointRecord } from "./idempotency";

const TXID = "11".repeat(32);
const AUTHORIZATION = {
  requirementDigest: `sha256:${"33".repeat(32)}` as const,
  planDigest: `sha256:${"44".repeat(32)}` as const,
  feeSelectionTarget: "10",
};

describe("lookupTxManifestTransaction", () => {
  it("reports found when either automatic provider recognizes the transaction", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

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
      `http://127.0.0.1:1234/api/tx/${TXID}/status`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
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

  it("normalizes legacy signed payloads and preserves explicit keyless mode", () => {
    const base = { version: 1, transactionHex: "00", txid: TXID, result: {}, review: {} };
    expect(parseTxManifestCheckpointPayload(JSON.stringify(base)).signingMode).toBe("wallet");
    expect(
      parseTxManifestCheckpointPayload(
        JSON.stringify({ ...base, signingMode: "none", authorization: AUTHORIZATION }),
      ).signingMode,
    ).toBe("none");
    expect(() =>
      parseTxManifestCheckpointPayload(JSON.stringify({ ...base, signingMode: "none" })),
    ).toThrow("Invalid");
    expect(() =>
      parseTxManifestCheckpointPayload(
        JSON.stringify({ ...base, signingMode: "future" }),
      ),
    ).toThrow("Invalid");
  });
});

describe("readTxManifestCheckpointPayload", () => {
  const base = {
    version: 1,
    transactionHex: "00",
    txid: TXID,
    result: {},
    review: {},
  };

  it("reads a public keyless checkpoint without opening the keystore", async () => {
    const checkpoint: TxManifestCheckpointRecord = {
      state: "checkpointed",
      signingMode: "none",
      key: "scope",
      invocationDigest: `sha256:${"22".repeat(32)}`,
      checkpointedAt: 1,
      walletId: "watch-wallet",
      network: "liquidtestnet",
      publicPayload: JSON.stringify({
        ...base,
        signingMode: "none",
        authorization: AUTHORIZATION,
      }),
    };
    const openWalletPayload = vi.fn();

    await expect(
      readTxManifestCheckpointPayload(checkpoint, openWalletPayload),
    ).resolves.toMatchObject({ signingMode: "none", txid: TXID });
    expect(openWalletPayload).not.toHaveBeenCalled();
  });

  it("opens a wallet checkpoint and rejects a payload mode mismatch", async () => {
    const checkpoint: TxManifestCheckpointRecord = {
      state: "checkpointed",
      signingMode: "wallet",
      key: "scope",
      invocationDigest: `sha256:${"22".repeat(32)}`,
      checkpointedAt: 1,
      walletId: "wallet",
      network: "liquidtestnet",
      sealedPayload: { iv: "iv", ct: "ct" },
    };
    const openWalletPayload = vi.fn(async () =>
      JSON.stringify({
        ...base,
        signingMode: "none",
        authorization: AUTHORIZATION,
      }),
    );

    await expect(
      readTxManifestCheckpointPayload(checkpoint, openWalletPayload),
    ).rejects.toThrow("signing mode does not match");
    expect(openWalletPayload).toHaveBeenCalledOnce();
  });
});

describe("requireTxManifestRecoveryPlanBinding", () => {
  function payload() {
    return parseTxManifestCheckpointPayload(JSON.stringify({
      version: 1,
      signingMode: "none",
      authorization: AUTHORIZATION,
      transactionHex: "00",
      txid: TXID,
      result: {},
      review: { action: "generic.Execute", fee: "10" },
    }));
  }

  it("accepts only a freshly reproduced keyless plan, txid, and authoritative review", async () => {
    const checkpoint = payload();
    await expect(requireTxManifestRecoveryPlanBinding({
      payload: checkpoint,
      requirementDigest: AUTHORIZATION.requirementDigest,
      refreshedPlanDigest: AUTHORIZATION.planDigest,
      refreshedTxid: TXID,
      refreshedReview: checkpoint.review,
    })).resolves.toBeUndefined();
  });

  it("rejects a coherent public-checkpoint transaction replacement", async () => {
    const checkpoint = payload();
    checkpoint.txid = "55".repeat(32);
    checkpoint.result = { ...checkpoint.result, txid: checkpoint.txid };
    await expect(requireTxManifestRecoveryPlanBinding({
      payload: checkpoint,
      requirementDigest: AUTHORIZATION.requirementDigest,
      refreshedPlanDigest: AUTHORIZATION.planDigest,
      refreshedTxid: TXID,
      refreshedReview: checkpoint.review,
    })).rejects.toThrow("refreshed template");
  });

  it("rejects replaced plan or review authority", async () => {
    const checkpoint = payload();
    await expect(requireTxManifestRecoveryPlanBinding({
      payload: checkpoint,
      requirementDigest: AUTHORIZATION.requirementDigest,
      refreshedPlanDigest: `sha256:${"66".repeat(32)}`,
      refreshedTxid: TXID,
      refreshedReview: checkpoint.review,
    })).rejects.toThrow("execution plan");
    await expect(requireTxManifestRecoveryPlanBinding({
      payload: checkpoint,
      requirementDigest: AUTHORIZATION.requirementDigest,
      refreshedPlanDigest: AUTHORIZATION.planDigest,
      refreshedTxid: TXID,
      refreshedReview: {
        ...checkpoint.review,
        fee: "11",
      } as TxManifestApprovalReviewDTO,
    })).rejects.toThrow("review does not match");
  });
});
