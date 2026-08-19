import { describe, expect, it, vi } from "vitest";
import type { LiquidExecuteTxManifestResult } from "@/provider/liquid-rpc";
import {
  TxManifestIdempotency,
  txManifestIdempotencyKey,
  type TxManifestCheckpointRecord,
  type TxManifestExecutionRecord,
  type TxManifestExecutionStore,
} from "./idempotency";

const DIGEST = `sha256:${"11".repeat(32)}` as const;
const OTHER_DIGEST = `sha256:${"22".repeat(32)}` as const;
const RESULT: LiquidExecuteTxManifestResult = {
  requestId: "offer-3",
  chainId: `bip122:${"33".repeat(16)}`,
  accountIdentifier: `bip122:${"33".repeat(16)}:${"44".repeat(16)}`,
  bundleHash: `sha256:${"55".repeat(32)}`,
  action: "AcceptOffer",
  status: "broadcast",
  txid: "66".repeat(32),
};

function memoryStore(): TxManifestExecutionStore & { records: TxManifestExecutionRecord[] } {
  return {
    records: [],
    async load() {
      return [...this.records];
    },
    async save(records) {
      this.records = [...records];
    },
  };
}

function checkpointRecord(
  overrides: Partial<TxManifestCheckpointRecord> = {},
): TxManifestCheckpointRecord {
  return {
    state: "checkpointed",
    key: "scope",
    invocationDigest: DIGEST,
    checkpointedAt: 1_000,
    walletId: "wallet-1",
    network: "liquidtestnet",
    sealedPayload: { iv: "iv", ct: "ciphertext" },
    ...overrides,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("TxManifestIdempotency", () => {
  it("coalesces concurrent retries and persists the terminal result", async () => {
    const store = memoryStore();
    const coordinator = new TxManifestIdempotency(store, () => 1_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = vi.fn(async () => {
      await gate;
      return RESULT;
    });
    const first = coordinator.execute("scope", DIGEST, operation);
    const second = coordinator.execute("scope", DIGEST, operation);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([RESULT, RESULT]);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(store.records).toHaveLength(1);
    await expect(coordinator.execute("scope", DIGEST, operation)).resolves.toEqual(RESULT);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("rejects request-id reuse with different request data", async () => {
    const store = memoryStore();
    store.records = [{ key: "scope", invocationDigest: DIGEST, completedAt: 1_000, result: RESULT }];
    const coordinator = new TxManifestIdempotency(store, () => 1_000);
    await expect(coordinator.execute("scope", OTHER_DIGEST, vi.fn())).rejects.toThrow(
      "already used",
    );
  });

  it("rejects conflicting data while the original request is still in flight", async () => {
    const coordinator = new TxManifestIdempotency(memoryStore(), () => 1_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = vi.fn(async () => {
      await gate;
      return RESULT;
    });

    const running = coordinator.execute("scope", DIGEST, operation);
    await expect(coordinator.execute("scope", OTHER_DIGEST, vi.fn())).rejects.toThrow(
      "already used",
    );
    release();
    await expect(running).resolves.toEqual(RESULT);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("releases failed and rejected requests so the identical request can retry", async () => {
    const store = memoryStore();
    const coordinator = new TxManifestIdempotency(store, () => 1_000);
    const rejected = Object.assign(new Error("You rejected the request."), { code: 4001 });
    const operation = vi
      .fn<() => Promise<LiquidExecuteTxManifestResult>>()
      .mockRejectedValueOnce(rejected)
      .mockResolvedValueOnce(RESULT);

    await expect(coordinator.execute("scope", DIGEST, operation)).rejects.toBe(rejected);
    expect(store.records).toEqual([]);
    await expect(coordinator.execute("scope", DIGEST, operation)).resolves.toEqual(RESULT);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(store.records).toHaveLength(1);
  });

  it("does not cache a result when durable terminal persistence fails", async () => {
    const store = memoryStore();
    const saveFailure = new Error("storage unavailable");
    const save = vi
      .spyOn(store, "save")
      .mockRejectedValueOnce(saveFailure)
      .mockImplementation(async (records) => {
        store.records = [...records];
      });
    const coordinator = new TxManifestIdempotency(store, () => 1_000);
    const operation = vi.fn(async () => RESULT);

    await expect(coordinator.execute("scope", DIGEST, operation)).rejects.toBe(saveFailure);
    await expect(coordinator.execute("scope", DIGEST, operation)).resolves.toEqual(RESULT);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("resumes a durable checkpoint instead of rebuilding the transaction", async () => {
    const store = memoryStore();
    store.records = [checkpointRecord()];
    const coordinator = new TxManifestIdempotency(store, () => 2_000);
    const operation = vi.fn(async () => RESULT);
    const resume = vi.fn(async () => RESULT);

    await expect(coordinator.execute("scope", DIGEST, operation, resume)).resolves.toEqual(RESULT);
    expect(operation).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledOnce();
    expect(store.records).toEqual([
      { key: "scope", invocationDigest: DIGEST, completedAt: 2_000, result: RESULT },
    ]);
  });

  it("leaves the checkpoint durable when recovery or terminal persistence fails", async () => {
    const store = memoryStore();
    const coordinator = new TxManifestIdempotency(store, () => 2_000);
    const interrupted = new Error("broadcast response lost");

    await expect(
      coordinator.execute("scope", DIGEST, async (generation) => {
        await coordinator.checkpoint({
          key: "scope",
          invocationDigest: DIGEST,
          walletId: "wallet-1",
          network: "liquidtestnet",
          sealedPayload: { iv: "iv", ct: "ciphertext" },
        }, generation);
        throw interrupted;
      }),
    ).rejects.toBe(interrupted);
    expect(store.records).toEqual([checkpointRecord({ checkpointedAt: 2_000 })]);

    await expect(
      coordinator.execute("scope", DIGEST, vi.fn(), async () => {
        throw interrupted;
      }),
    ).rejects.toBe(interrupted);
    expect(store.records).toEqual([checkpointRecord({ checkpointedAt: 2_000 })]);
  });

  it("recovers from the checkpoint when terminal persistence fails after broadcast", async () => {
    const store = memoryStore();
    const terminalFailure = new Error("terminal storage unavailable");
    let saves = 0;
    vi.spyOn(store, "save").mockImplementation(async (records) => {
      saves += 1;
      if (saves === 2) throw terminalFailure;
      store.records = [...records];
    });
    const coordinator = new TxManifestIdempotency(store, () => 2_000);
    const operation = vi.fn(async (generation) => {
      await coordinator.checkpoint({
        key: "scope",
        invocationDigest: DIGEST,
        walletId: "wallet-1",
        network: "liquidtestnet",
        sealedPayload: { iv: "iv", ct: "ciphertext" },
      }, generation);
      return RESULT;
    });
    const resume = vi.fn(async () => RESULT);

    await expect(coordinator.execute("scope", DIGEST, operation, resume)).rejects.toBe(
      terminalFailure,
    );
    expect(store.records).toEqual([checkpointRecord({ checkpointedAt: 2_000 })]);

    await expect(coordinator.execute("scope", DIGEST, operation, resume)).resolves.toEqual(RESULT);
    expect(operation).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
    expect(store.records).toEqual([
      { key: "scope", invocationDigest: DIGEST, completedAt: 2_000, result: RESULT },
    ]);
  });

  it("never runs the irreversible operation when checkpoint persistence fails", async () => {
    const store = memoryStore();
    vi.spyOn(store, "save").mockRejectedValueOnce(new Error("storage unavailable"));
    const coordinator = new TxManifestIdempotency(store, () => 2_000);
    const broadcast = vi.fn();

    await expect(
      coordinator.execute("scope", DIGEST, async (generation) => {
        await coordinator.checkpoint({
          key: "scope",
          invocationDigest: DIGEST,
          walletId: "wallet-1",
          network: "liquidtestnet",
          sealedPayload: { iv: "iv", ct: "ciphertext" },
        }, generation);
        broadcast();
        return RESULT;
      }),
    ).rejects.toThrow("storage unavailable");
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("marks permanently invalid checkpoints and requires a new request id", async () => {
    const store = memoryStore();
    store.records = [checkpointRecord()];
    const coordinator = new TxManifestIdempotency(store, () => 2_000);

    await expect(
      coordinator.execute("scope", DIGEST, vi.fn(), async (_checkpoint, generation) => {
        await coordinator.failCheckpoint("scope", DIGEST, "inputs spent", generation);
        throw new Error("inputs spent");
      }),
    ).rejects.toThrow("inputs spent");
    await expect(coordinator.execute("scope", DIGEST, vi.fn(), vi.fn())).rejects.toThrow(
      "new requestId",
    );
    expect(store.records).toEqual([
      expect.objectContaining({
        state: "failed",
        key: "scope",
        invocationDigest: DIGEST,
        failedAt: 2_000,
      }),
    ]);
  });

  it("does not persist a terminal result after the wallet is reset", async () => {
    const store = memoryStore();
    const coordinator = new TxManifestIdempotency(store, () => 2_000);
    const started = deferred();
    const release = deferred();
    const running = coordinator.execute("scope", DIGEST, async () => {
      started.resolve();
      await release.promise;
      return RESULT;
    });

    await started.promise;
    await coordinator.clear();
    release.resolve();

    await expect(running).rejects.toThrow("invalidated because the wallet was reset");
    expect(store.records).toEqual([]);
  });

  it("does not use a stale result loaded across a wallet reset", async () => {
    const store = memoryStore();
    store.records = [
      { key: "scope", invocationDigest: DIGEST, completedAt: 1_000, result: RESULT },
    ];
    const loadStarted = deferred();
    const releaseLoad = deferred();
    vi.spyOn(store, "load").mockImplementationOnce(async () => {
      const stale = [...store.records];
      loadStarted.resolve();
      await releaseLoad.promise;
      return stale;
    });
    const coordinator = new TxManifestIdempotency(store, () => 2_000);
    const operation = vi.fn(async () => RESULT);
    const running = coordinator.execute("scope", DIGEST, operation);

    await loadStarted.promise;
    await coordinator.clear();
    releaseLoad.resolve();

    await expect(running).rejects.toThrow("invalidated because the wallet was reset");
    expect(operation).not.toHaveBeenCalled();
    expect(store.records).toEqual([]);
  });

  it("fails closed until checkpoint storage is successfully cleared", async () => {
    const store = memoryStore();
    store.records = [
      { key: "scope", invocationDigest: DIGEST, completedAt: 1_000, result: RESULT },
    ];
    vi.spyOn(store, "save")
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockImplementation(async (records) => {
        store.records = [...records];
      });
    const coordinator = new TxManifestIdempotency(store, () => 2_000);

    await expect(coordinator.clear()).rejects.toThrow("storage unavailable");
    const blocked = vi.fn(async () => RESULT);
    await expect(coordinator.execute("scope", DIGEST, blocked)).rejects.toThrow(
      "checkpoint storage could not be cleared",
    );
    expect(blocked).not.toHaveBeenCalled();

    await coordinator.clear();
    await expect(coordinator.execute("scope", DIGEST, blocked)).resolves.toEqual(RESULT);
    expect(blocked).toHaveBeenCalledOnce();
  });

  it("rejects a post-reset checkpoint before an irreversible operation", async () => {
    const store = memoryStore();
    const coordinator = new TxManifestIdempotency(store, () => 2_000);
    const started = deferred();
    const release = deferred();
    const broadcast = vi.fn();
    const running = coordinator.execute("scope", DIGEST, async (generation) => {
      started.resolve();
      await release.promise;
      await coordinator.checkpoint({
        key: "scope",
        invocationDigest: DIGEST,
        walletId: "wallet-1",
        network: "liquidtestnet",
        sealedPayload: { iv: "iv", ct: "ciphertext" },
      }, generation);
      broadcast();
      return RESULT;
    });

    await started.promise;
    await coordinator.clear();
    release.resolve();

    await expect(running).rejects.toThrow("invalidated because the wallet was reset");
    expect(broadcast).not.toHaveBeenCalled();
    expect(store.records).toEqual([]);
  });

  it("does not broadcast when reset begins during checkpoint persistence", async () => {
    const store = memoryStore();
    const saveStarted = deferred();
    const releaseSave = deferred();
    let saveCount = 0;
    vi.spyOn(store, "save").mockImplementation(async (records) => {
      saveCount += 1;
      if (saveCount === 1) {
        saveStarted.resolve();
        await releaseSave.promise;
      }
      store.records = [...records];
    });
    const coordinator = new TxManifestIdempotency(store, () => 2_000);
    const broadcast = vi.fn();
    const running = coordinator.execute("scope", DIGEST, async (generation) => {
      await coordinator.checkpoint({
        key: "scope",
        invocationDigest: DIGEST,
        walletId: "wallet-1",
        network: "liquidtestnet",
        sealedPayload: { iv: "iv", ct: "ciphertext" },
      }, generation);
      broadcast();
      return RESULT;
    });

    await saveStarted.promise;
    const clearing = coordinator.clear();
    releaseSave.resolve();

    await expect(running).rejects.toThrow("invalidated because the wallet was reset");
    await clearing;
    expect(broadcast).not.toHaveBeenCalled();
    expect(store.records).toEqual([]);
  });

  it("does not replace a checkpoint with a failure after reset", async () => {
    const store = memoryStore();
    store.records = [checkpointRecord()];
    const coordinator = new TxManifestIdempotency(store, () => 2_000);
    const resumeStarted = deferred();
    const releaseResume = deferred();
    const running = coordinator.execute(
      "scope",
      DIGEST,
      vi.fn(),
      async (_checkpoint, generation) => {
        resumeStarted.resolve();
        await releaseResume.promise;
        await coordinator.failCheckpoint("scope", DIGEST, "inputs spent", generation);
        throw new Error("inputs spent");
      },
    );

    await resumeStarted.promise;
    await coordinator.clear();
    releaseResume.resolve();

    await expect(running).rejects.toThrow("invalidated because the wallet was reset");
    expect(store.records).toEqual([]);
  });

  it("keeps a new same-key execution isolated from the invalidated one", async () => {
    const store = memoryStore();
    const coordinator = new TxManifestIdempotency(store, () => 2_000);
    const oldStarted = deferred();
    const releaseOld = deferred();
    const old = coordinator.execute("scope", DIGEST, async () => {
      oldStarted.resolve();
      await releaseOld.promise;
      return RESULT;
    });

    await oldStarted.promise;
    await coordinator.clear();
    const replacement = { ...RESULT, txid: "77".repeat(32) };
    await expect(
      coordinator.execute("scope", DIGEST, async () => replacement),
    ).resolves.toEqual(replacement);
    releaseOld.resolve();

    await expect(old).rejects.toThrow("invalidated because the wallet was reset");
    expect(store.records).toEqual([
      { key: "scope", invocationDigest: DIGEST, completedAt: 2_000, result: replacement },
    ]);
  });

  it("keeps unresolved checkpoints regardless of age and terminal retention", async () => {
    const store = memoryStore();
    store.records = [checkpointRecord({ checkpointedAt: 1 })];
    let now = 10_000 + 8 * 24 * 60 * 60_000;
    const coordinator = new TxManifestIdempotency(store, () => now);

    for (let index = 0; index < 101; index += 1) {
      now += 1;
      await coordinator.execute(`terminal-${index}`, DIGEST, async () => ({
        ...RESULT,
        requestId: `request-${index}`,
        txid: index.toString(16).padStart(64, "0"),
      }));
    }

    expect(store.records).toHaveLength(101);
    expect(store.records).toContainEqual(checkpointRecord({ checkpointedAt: 1 }));
  });

  it("expires stale terminal results and retries the operation", async () => {
    const store = memoryStore();
    store.records = [{ key: "scope", invocationDigest: DIGEST, completedAt: 1_000, result: RESULT }];
    const now = 1_000 + 7 * 24 * 60 * 60_000 + 1;
    const coordinator = new TxManifestIdempotency(store, () => now);
    const replacement = { ...RESULT, txid: "77".repeat(32) };
    const operation = vi.fn(async () => replacement);

    await expect(coordinator.execute("scope", DIGEST, operation)).resolves.toEqual(replacement);
    expect(operation).toHaveBeenCalledOnce();
    expect(store.records).toEqual([
      { key: "scope", invocationDigest: DIGEST, completedAt: now, result: replacement },
    ]);
  });

  it("keeps only the newest one hundred terminal results", async () => {
    const store = memoryStore();
    let now = 10_000;
    const coordinator = new TxManifestIdempotency(store, () => now);

    for (let index = 0; index < 101; index += 1) {
      now += 1;
      await coordinator.execute(`scope-${index}`, DIGEST, async () => ({
        ...RESULT,
        requestId: `request-${index}`,
        txid: index.toString(16).padStart(64, "0"),
      }));
    }

    expect(store.records).toHaveLength(100);
    expect(store.records[0]?.key).toBe("scope-100");
    expect(store.records.at(-1)?.key).toBe("scope-1");
  });
});

describe("txManifestIdempotencyKey", () => {
  it("isolates the same request id by origin, account, and chain", () => {
    const base = {
      origin: "https://lending.example",
      accountIdentifier: "account-a",
      chainId: "chain-a",
      requestId: "retry-1",
    };
    const keys = [
      txManifestIdempotencyKey(base),
      txManifestIdempotencyKey({ ...base, origin: "https://other.example" }),
      txManifestIdempotencyKey({ ...base, accountIdentifier: "account-b" }),
      txManifestIdempotencyKey({ ...base, chainId: "chain-b" }),
    ];

    expect(new Set(keys)).toHaveLength(keys.length);
  });
});
