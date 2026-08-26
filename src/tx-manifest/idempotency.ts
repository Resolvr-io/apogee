import type { LiquidExecuteTxManifestResult } from "@/provider/liquid-rpc";
import type { Enc } from "@/keystore/crypto";
import type { LiquidNetwork } from "@/keystore/keystore";

/**
 * L-9 (2026-08 scan): the terminal record persists ONLY the txid. The rest of
 * the result shape — requestId, chainId, accountIdentifier, bundleHash, action
 * — is reconstructible from the replayed invocation, which the digest check at
 * the top of execute() has already proven identical to the original, and
 * storing it made this table a readable lending/counterparty log for 7 days.
 * Legacy records that still carry a `result` field are trimmed on load.
 */
export type TxManifestTerminalRecord = {
  key: string;
  invocationDigest: `sha256:${string}`;
  completedAt: number;
  txid: string;
};

/**
 * A signed transaction that has been durably saved but has not yet reached a
 * durable terminal result. The sealed payload contains the exact raw
 * transaction and its reviewed result; routing metadata is authenticated as
 * AES-GCM additional data when the payload is opened.
 */
export type TxManifestCheckpointRecord = {
  state: "checkpointed";
  key: string;
  invocationDigest: `sha256:${string}`;
  checkpointedAt: number;
  walletId: string;
  network: LiquidNetwork;
  sealedPayload: Enc;
};

export type TxManifestFailedRecord = {
  state: "failed";
  key: string;
  invocationDigest: `sha256:${string}`;
  failedAt: number;
  message: string;
};

export type TxManifestExecutionRecord =
  | TxManifestTerminalRecord
  | TxManifestCheckpointRecord
  | TxManifestFailedRecord;

export interface TxManifestExecutionStore {
  load(): Promise<TxManifestExecutionRecord[]>;
  save(records: TxManifestExecutionRecord[]): Promise<void>;
}

type InFlight = {
  invocationDigest: `sha256:${string}`;
  generation: TxManifestExecutionGeneration;
  promise: Promise<LiquidExecuteTxManifestResult>;
};

declare const txManifestExecutionGenerationBrand: unique symbol;

/** Opaque lifetime token tying durable writes to one active wallet generation. */
export type TxManifestExecutionGeneration = number & {
  readonly [txManifestExecutionGenerationBrand]: true;
};

const RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_RECORDS = 100;

/** Origin/account/chain-scoped terminal-result deduplication for manifest broadcasts. */
export class TxManifestIdempotency {
  private readonly inFlight = new Map<string, InFlight>();
  private writeQueue: Promise<void> = Promise.resolve();
  private generation = 0;
  private storageResetPending = false;

  constructor(
    private readonly store: TxManifestExecutionStore,
    private readonly now: () => number = Date.now,
  ) {}

  async execute(
    key: string,
    invocationDigest: `sha256:${string}`,
    rehydrate: (txid: string) => LiquidExecuteTxManifestResult,
    operation: (
      generation: TxManifestExecutionGeneration,
    ) => Promise<LiquidExecuteTxManifestResult>,
    resume?: (
      checkpoint: TxManifestCheckpointRecord,
      generation: TxManifestExecutionGeneration,
    ) => Promise<LiquidExecuteTxManifestResult>,
  ): Promise<LiquidExecuteTxManifestResult> {
    const generation = this.currentGeneration();
    const existing = await this.find(key, generation);
    if (existing) {
      this.requireSameInvocation(existing.invocationDigest, invocationDigest);
      if (isFailed(existing)) throw new Error(existing.message);
      if (!isCheckpoint(existing)) return rehydrate(existing.txid);
      if (!resume) throw new Error("This TX Manifest execution must be resumed from its checkpoint.");
    }
    const running = this.inFlight.get(key);
    if (running) {
      this.assertActive(running.generation);
      this.requireSameInvocation(running.invocationDigest, invocationDigest);
      return running.promise;
    }
    // Defer invocation until after the in-flight entry is installed. Besides
    // preserving retry coalescing, this lets checkpoint writes carry the exact
    // generation captured here rather than looking up a mutable key later.
    const promise = Promise.resolve().then(async () => {
      this.assertActive(generation);
      const result = existing && isCheckpoint(existing)
        ? await resume!(existing, generation)
        : await operation(generation);
      this.assertActive(generation);
      await this.persistTerminal(
        { key, invocationDigest, completedAt: this.now(), txid: result.txid },
        generation,
      );
      return result;
    });
    this.inFlight.set(key, { invocationDigest, generation, promise });
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key);
    }
  }

  /** Save-before-broadcast transition. Unresolved checkpoints are never aged out. */
  async checkpoint(
    record: Omit<TxManifestCheckpointRecord, "state" | "checkpointedAt">,
    generation: TxManifestExecutionGeneration,
  ): Promise<void> {
    this.assertActive(generation);
    const checkpoint: TxManifestCheckpointRecord = {
      ...record,
      state: "checkpointed",
      checkpointedAt: this.now(),
    };
    return this.queueGenerationWrite(generation, async () => {
      const records = await this.loadNormalized();
      this.assertActive(generation);
      const cutoff = this.now() - RETENTION_MS;
      const existing = records.find(
        (candidate) => candidate.key === checkpoint.key && isCurrent(candidate, cutoff),
      );
      if (existing) {
        this.requireSameInvocation(existing.invocationDigest, checkpoint.invocationDigest);
        if (!isCheckpoint(existing)) {
          throw new Error("This TX Manifest request already has a terminal result.");
        }
      }
      await this.store.save(
        records
          .filter(
            (candidate) =>
              candidate.key !== checkpoint.key && isCurrent(candidate, cutoff),
          )
          .concat(checkpoint),
      );
    });
  }

  /** Permanently-invalid exact bytes require a fresh dapp request id and plan. */
  async failCheckpoint(
    key: string,
    invocationDigest: `sha256:${string}`,
    details: string,
    generation: TxManifestExecutionGeneration,
  ): Promise<void> {
    this.assertActive(generation);
    const failure: TxManifestFailedRecord = {
      state: "failed",
      key,
      invocationDigest,
      failedAt: this.now(),
      message: `This saved TX Manifest transaction is no longer valid. Submit the action again with a new requestId. ${details}`,
    };
    return this.queueGenerationWrite(generation, async () => {
      const records = await this.loadNormalized();
      this.assertActive(generation);
      const existing = records.find((candidate) => candidate.key === key);
      if (!existing || !isCheckpoint(existing)) {
        throw new Error("No unresolved TX Manifest checkpoint exists for this request.");
      }
      this.requireSameInvocation(existing.invocationDigest, invocationDigest);
      await this.store.save(
        records.filter((candidate) => candidate.key !== key).concat(failure),
      );
    });
  }

  /** Load with legacy terminal records trimmed to the L-9 shape, so a store
   *  written before the trim converges on its next write. */
  private async loadNormalized(): Promise<TxManifestExecutionRecord[]> {
    const records = await this.store.load();
    return records.map((record) => {
      if (!("result" in record)) return record;
      const legacy = record as { key: string; invocationDigest: `sha256:${string}`; completedAt: number; result: { txid: string } };
      return {
        key: legacy.key,
        invocationDigest: legacy.invocationDigest,
        completedAt: legacy.completedAt,
        txid: legacy.result.txid,
      };
    });
  }

  async clear(): Promise<void> {
    this.invalidate();
    this.storageResetPending = true;
    const write = this.writeQueue.then(() => this.store.save([]));
    const tracked = write.then(
      () => {
        this.storageResetPending = false;
      },
      (error: unknown) => {
        // Fail closed: stale records must not become visible in the new wallet
        // generation just because storage was temporarily unavailable.
        this.storageResetPending = true;
        throw error;
      },
    );
    this.writeQueue = tracked.catch(() => {});
    return tracked;
  }

  /** Immediately invalidate work without deleting still-valid persisted state. */
  invalidate(): void {
    this.generation += 1;
    this.inFlight.clear();
  }

  /** Fail a pending irreversible step after the wallet lifetime was reset. */
  assertActive(generation: TxManifestExecutionGeneration): void {
    if (generation !== this.currentGeneration()) {
      throw new Error("This TX Manifest execution was invalidated because the wallet was reset.");
    }
  }

  private currentGeneration(): TxManifestExecutionGeneration {
    return this.generation as TxManifestExecutionGeneration;
  }

  private async find(
    key: string,
    generation: TxManifestExecutionGeneration,
  ): Promise<TxManifestExecutionRecord | undefined> {
    // A post-reset execution must not read records before clear() reaches its
    // queued save. Conversely, an execution that began before reset must stop
    // after either side of an asynchronous load.
    const writeBarrier = this.writeQueue;
    await writeBarrier;
    this.assertActive(generation);
    this.assertStorageReady();
    const cutoff = this.now() - RETENTION_MS;
    const records = await this.loadNormalized();
    this.assertActive(generation);
    this.assertStorageReady();
    return records.find(
      (record) =>
        record.key === key &&
        (isCheckpoint(record) ||
          (isFailed(record) ? record.failedAt >= cutoff : record.completedAt >= cutoff)),
    );
  }

  private async persistTerminal(
    record: TxManifestTerminalRecord,
    generation: TxManifestExecutionGeneration,
  ): Promise<void> {
    return this.queueGenerationWrite(generation, async () => {
      const cutoff = this.now() - RETENTION_MS;
      const current = await this.loadNormalized();
      this.assertActive(generation);
      const checkpoints = current.filter(
        (candidate) => isCheckpoint(candidate) && candidate.key !== record.key,
      );
      const terminals = current
        .filter(
          (candidate): candidate is TxManifestTerminalRecord | TxManifestFailedRecord =>
            !isCheckpoint(candidate) &&
            candidate.key !== record.key &&
            (isFailed(candidate)
              ? candidate.failedAt >= cutoff
              : candidate.completedAt >= cutoff),
        )
        .concat(record)
        .sort((a, b) => recordTime(b) - recordTime(a))
        .slice(0, MAX_RECORDS);
      await this.store.save([...checkpoints, ...terminals]);
    });
  }

  private queueGenerationWrite(
    generation: TxManifestExecutionGeneration,
    operation: () => Promise<void>,
  ): Promise<void> {
    this.assertActive(generation);
    const write = this.writeQueue.then(async () => {
      this.assertActive(generation);
      this.assertStorageReady();
      await operation();
      // If clear() began while storage.save was pending, do not let the caller
      // proceed to broadcast. clear's queued empty save will run immediately
      // after this rejected write and leave storage empty.
      this.assertActive(generation);
    });
    this.writeQueue = write.catch(() => {});
    return write;
  }

  private assertStorageReady(): void {
    if (this.storageResetPending) {
      throw new Error(
        "TX Manifest checkpoint storage could not be cleared after the wallet reset.",
      );
    }
  }

  private requireSameInvocation(
    expected: `sha256:${string}`,
    actual: `sha256:${string}`,
  ): void {
    if (expected !== actual) {
      throw new Error("This TX Manifest requestId was already used for different request data.");
    }
  }
}

export function isCheckpoint(
  record: TxManifestExecutionRecord,
): record is TxManifestCheckpointRecord {
  return "state" in record && record.state === "checkpointed";
}

export function isFailed(record: TxManifestExecutionRecord): record is TxManifestFailedRecord {
  return "state" in record && record.state === "failed";
}

function recordTime(record: TxManifestTerminalRecord | TxManifestFailedRecord): number {
  return isFailed(record) ? record.failedAt : record.completedAt;
}

function isCurrent(record: TxManifestExecutionRecord, cutoff: number): boolean {
  return isCheckpoint(record) || recordTime(record) >= cutoff;
}

export function txManifestIdempotencyKey(scope: {
  origin: string;
  accountIdentifier: string;
  chainId: string;
  requestId: string;
}): string {
  return JSON.stringify([
    scope.origin,
    scope.accountIdentifier,
    scope.chainId,
    scope.requestId,
  ]);
}
