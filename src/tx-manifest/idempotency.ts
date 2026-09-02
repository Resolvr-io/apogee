import type { LiquidExecuteTxManifestResult } from "@/provider/liquid-rpc";
import type { Enc } from "@/keystore/crypto";
import type { LiquidNetwork } from "@/keystore/keystore";
import {
  requireTxManifestSigningMode,
  type TxManifestSigningMode,
} from "@/tx-manifest/adapters/types";

export type TxManifestTerminalRecord = {
  key: string;
  invocationDigest: `sha256:${string}`;
  completedAt: number;
  /**
   * Only the txid is durable. Every other `LiquidExecuteTxManifestResult`
   * field is an echo of the caller's own request, so a retry reconstructs
   * them instead of Apogee holding counterparty/account metadata at rest.
   */
  txid: string;
};

/**
 * A finalized transaction that has been durably saved but has not yet reached
 * a durable terminal result. Wallet-signed payloads are seed-sealed; the
 * signature-free variant below may contain only already-public transaction
 * bytes and their review.
 */
type TxManifestCheckpointRecordBase<SigningMode extends TxManifestSigningMode> = {
  state: "checkpointed";
  signingMode: SigningMode;
  key: string;
  invocationDigest: `sha256:${string}`;
  checkpointedAt: number;
  walletId: string;
  network: LiquidNetwork;
};

/**
 * Wallet-signed transactions remain seed-sealed. A signature-free manifest
 * transaction may instead use a local cleartext checkpoint: its complete bytes
 * are already public transaction data, and requiring the seed merely to save
 * them would make an otherwise keyless action depend on an unlocked signer.
 */
export type TxManifestCheckpointRecord =
  | (TxManifestCheckpointRecordBase<"wallet"> & {
      sealedPayload: Enc;
      publicPayload?: never;
    })
  | (TxManifestCheckpointRecordBase<"none"> & {
      sealedPayload?: never;
      publicPayload: string;
    });

type TxManifestCheckpointWriteBase<SigningMode extends TxManifestSigningMode> = Omit<
  TxManifestCheckpointRecordBase<SigningMode>,
  "state" | "checkpointedAt"
>;

export type TxManifestCheckpointWrite =
  | (TxManifestCheckpointWriteBase<"wallet"> & {
      sealedPayload: Enc;
      publicPayload?: never;
    })
  | (TxManifestCheckpointWriteBase<"none"> & {
      sealedPayload?: never;
      publicPayload: string;
    });

export type TxManifestFailedRecord = {
  state: "failed";
  key: string;
  invocationDigest: `sha256:${string}`;
  failedAt: number;
  message: string;
  /** Corrupt unresolved checkpoints must never age out into a replayable request. */
  permanent?: true;
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
/** Same shape the provider validates inbound txids against. */
const TXID = /^[0-9a-f]{64}$/;

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
    operation: (
      generation: TxManifestExecutionGeneration,
    ) => Promise<LiquidExecuteTxManifestResult>,
    /**
     * Rebuilds the full result from a cached txid. Every other result field
     * is an echo of the caller's own (invocation-digest-matched) request, so
     * only the txid needs to be read back from durable storage.
     */
    reconstruct: (txid: string) => LiquidExecuteTxManifestResult,
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
      if (!isCheckpoint(existing)) {
        // Fail closed. This is the LAST check before a reconstructed result
        // reaches the dapp: liquid-rpc-validation only validates txids on the
        // way in, so nothing downstream re-checks this one. A merely non-empty
        // string isn't enough — a truncated record would still surface as
        // status "broadcast" with an unusable id.
        if (!TXID.test(existing.txid ?? "")) {
          throw new Error("This TX Manifest result is unreadable. Submit the action again with a new requestId.");
        }
        return reconstruct(existing.txid);
      }
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
    record: TxManifestCheckpointWrite,
    generation: TxManifestExecutionGeneration,
  ): Promise<void> {
    this.assertActive(generation);
    const signingMode = requireTxManifestSigningMode(record.signingMode);
    const common = {
      state: "checkpointed",
      checkpointedAt: this.now(),
      key: record.key,
      invocationDigest: record.invocationDigest,
      walletId: record.walletId,
      network: record.network,
    } as const;
    let checkpoint: TxManifestCheckpointRecord;
    if (signingMode === "none") {
      if (typeof record.publicPayload !== "string" || record.sealedPayload !== undefined) {
        throw new Error("A signature-free TX Manifest requires a public checkpoint payload.");
      }
      checkpoint = { ...common, signingMode, publicPayload: record.publicPayload };
    } else {
      if (record.publicPayload !== undefined || !isEncryptedPayload(record.sealedPayload)) {
        throw new Error("A wallet-signing TX Manifest requires a sealed checkpoint payload.");
      }
      checkpoint = { ...common, signingMode, sealedPayload: record.sealedPayload };
    }
    return this.queueGenerationWrite(generation, async () => {
      const records = await this.store.load();
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
      const records = await this.store.load();
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
    const records = await this.store.load();
    this.assertActive(generation);
    this.assertStorageReady();
    return records.find(
      (record) =>
        record.key === key &&
        (isCheckpoint(record) ||
          (isFailed(record)
            ? record.permanent === true || record.failedAt >= cutoff
            : record.completedAt >= cutoff)),
    );
  }

  private async persistTerminal(
    record: TxManifestTerminalRecord,
    generation: TxManifestExecutionGeneration,
  ): Promise<void> {
    return this.queueGenerationWrite(generation, async () => {
      const cutoff = this.now() - RETENTION_MS;
      const current = await this.store.load();
      this.assertActive(generation);
      const unresolved = current.filter(
        (candidate) =>
          candidate.key !== record.key &&
          (isCheckpoint(candidate) || (isFailed(candidate) && candidate.permanent === true)),
      );
      const terminals = current
        .filter(
          (candidate): candidate is TxManifestTerminalRecord | TxManifestFailedRecord =>
            !isCheckpoint(candidate) &&
            !(isFailed(candidate) && candidate.permanent === true) &&
            candidate.key !== record.key &&
            (isFailed(candidate)
              ? candidate.failedAt >= cutoff
              : candidate.completedAt >= cutoff),
        )
        .concat(record)
        .sort((a, b) => recordTime(b) - recordTime(a))
        .slice(0, MAX_RECORDS);
      await this.store.save([...unresolved, ...terminals]);
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

/**
 * Normalize records loaded from durable storage.
 *
 * Terminal records written before this store trimmed itself down held the whole
 * `LiquidExecuteTxManifestResult` under `result`. They still match in `find()`,
 * so without this a dapp retrying a requestId inside the retention window gets
 * a result whose `txid` is `undefined` — dropped outright by JSON
 * serialization, i.e. "broadcast" with nothing to track.
 *
 * Migrating on read rather than bumping the storage key is deliberate: dedup
 * has to survive the upgrade, because losing it means a second approval prompt
 * and a second broadcast of the same manifest. The next write persists the
 * trimmed shape. Extracted here (rather than living in the background's store
 * adapter) so it is testable — that module registers listeners at import and
 * can't be loaded under Node.
 */
export function migrateStoredTxManifestRecords(value: unknown): TxManifestExecutionRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((record) => {
    // Drop non-objects outright. Every later read assumes a record shape, so
    // passing one through poisons every future execution until storage is
    // cleared. Safe to drop in a way that dropping a terminal record is not: a
    // non-object was never a dedup entry, so nothing is lost, and the next
    // write removes it from disk.
    if (!record || typeof record !== "object") return [];
    const candidate = record as Record<string, unknown>;
    if (candidate.state === "checkpointed") {
      const migrated = migrateCheckpointRecord(candidate);
      return migrated ? [migrated] : [];
    }
    if ("txid" in candidate || !("result" in candidate)) {
      return record as TxManifestExecutionRecord;
    }
    const result = candidate.result as Record<string, unknown> | null;
    if (!result || typeof result !== "object" || typeof result.txid !== "string") {
      return record as TxManifestExecutionRecord;
    }
    return {
      key: candidate.key,
      invocationDigest: candidate.invocationDigest,
      completedAt: candidate.completedAt,
      txid: result.txid,
    } as TxManifestExecutionRecord;
  });
}

function migrateCheckpointRecord(
  candidate: Record<string, unknown>,
): TxManifestCheckpointRecord | TxManifestFailedRecord | null {
  if (
    typeof candidate.key !== "string" ||
    typeof candidate.invocationDigest !== "string" ||
    !candidate.invocationDigest.startsWith("sha256:") ||
    typeof candidate.checkpointedAt !== "number" ||
    typeof candidate.walletId !== "string" ||
    (candidate.network !== "liquid" &&
      candidate.network !== "liquidtestnet" &&
      candidate.network !== "regtest")
  ) {
    return null;
  }
  const sealed = isEncryptedPayload(candidate.sealedPayload);
  const publicPayload = typeof candidate.publicPayload === "string";
  if (
    (candidate.signingMode === undefined || candidate.signingMode === "wallet") &&
    sealed &&
    !publicPayload
  ) {
    return {
      state: "checkpointed",
      signingMode: "wallet",
      key: candidate.key,
      invocationDigest: candidate.invocationDigest as `sha256:${string}`,
      checkpointedAt: candidate.checkpointedAt,
      walletId: candidate.walletId,
      network: candidate.network,
      sealedPayload: candidate.sealedPayload as Enc,
    };
  }
  if (
    (candidate.signingMode === undefined || candidate.signingMode === "none") &&
    publicPayload &&
    !sealed
  ) {
    return {
      state: "checkpointed",
      signingMode: "none",
      key: candidate.key,
      invocationDigest: candidate.invocationDigest as `sha256:${string}`,
      checkpointedAt: candidate.checkpointedAt,
      walletId: candidate.walletId,
      network: candidate.network,
      publicPayload: candidate.publicPayload as string,
    };
  }
  return {
    state: "failed",
    key: candidate.key,
    invocationDigest: candidate.invocationDigest as `sha256:${string}`,
    failedAt: candidate.checkpointedAt,
    message: "This saved TX Manifest checkpoint is unreadable. Submit the action again with a new requestId.",
    permanent: true,
  };
}

function isEncryptedPayload(value: unknown): value is Enc {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as Partial<Enc>).iv === "string" &&
    typeof (value as Partial<Enc>).ct === "string",
  );
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
  return isCheckpoint(record) || (isFailed(record) && record.permanent === true) || recordTime(record) >= cutoff;
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
