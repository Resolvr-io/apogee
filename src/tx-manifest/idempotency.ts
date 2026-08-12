import type { LiquidExecuteTxManifestResult } from "@/provider/liquid-rpc";
import type { Enc } from "@/keystore/crypto";
import type { LiquidNetwork } from "@/keystore/keystore";

export type TxManifestTerminalRecord = {
  key: string;
  invocationDigest: `sha256:${string}`;
  completedAt: number;
  result: LiquidExecuteTxManifestResult;
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
  promise: Promise<LiquidExecuteTxManifestResult>;
};

const RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_RECORDS = 100;

/** Origin/account/chain-scoped terminal-result deduplication for manifest broadcasts. */
export class TxManifestIdempotency {
  private readonly inFlight = new Map<string, InFlight>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: TxManifestExecutionStore,
    private readonly now: () => number = Date.now,
  ) {}

  async execute(
    key: string,
    invocationDigest: `sha256:${string}`,
    operation: () => Promise<LiquidExecuteTxManifestResult>,
    resume?: (checkpoint: TxManifestCheckpointRecord) => Promise<LiquidExecuteTxManifestResult>,
  ): Promise<LiquidExecuteTxManifestResult> {
    const existing = await this.find(key);
    if (existing) {
      this.requireSameInvocation(existing.invocationDigest, invocationDigest);
      if (isFailed(existing)) throw new Error(existing.message);
      if (!isCheckpoint(existing)) return existing.result;
      if (!resume) throw new Error("This TX Manifest execution must be resumed from its checkpoint.");
    }
    const running = this.inFlight.get(key);
    if (running) {
      this.requireSameInvocation(running.invocationDigest, invocationDigest);
      return running.promise;
    }
    const promise = (existing && isCheckpoint(existing) ? resume!(existing) : operation()).then(
      async (result) => {
        await this.persistTerminal({ key, invocationDigest, completedAt: this.now(), result });
        return result;
      },
    );
    this.inFlight.set(key, { invocationDigest, promise });
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key);
    }
  }

  /** Save-before-broadcast transition. Unresolved checkpoints are never aged out. */
  async checkpoint(
    record: Omit<TxManifestCheckpointRecord, "state" | "checkpointedAt">,
  ): Promise<void> {
    const checkpoint: TxManifestCheckpointRecord = {
      ...record,
      state: "checkpointed",
      checkpointedAt: this.now(),
    };
    const write = this.writeQueue.then(async () => {
      const records = await this.store.load();
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
    this.writeQueue = write.catch(() => {});
    return write;
  }

  /** Permanently-invalid exact bytes require a fresh dapp request id and plan. */
  async failCheckpoint(
    key: string,
    invocationDigest: `sha256:${string}`,
    details: string,
  ): Promise<void> {
    const failure: TxManifestFailedRecord = {
      state: "failed",
      key,
      invocationDigest,
      failedAt: this.now(),
      message: `This saved TX Manifest transaction is no longer valid. Submit the action again with a new requestId. ${details}`,
    };
    const write = this.writeQueue.then(async () => {
      const records = await this.store.load();
      const existing = records.find((candidate) => candidate.key === key);
      if (!existing || !isCheckpoint(existing)) {
        throw new Error("No unresolved TX Manifest checkpoint exists for this request.");
      }
      this.requireSameInvocation(existing.invocationDigest, invocationDigest);
      await this.store.save(
        records.filter((candidate) => candidate.key !== key).concat(failure),
      );
    });
    this.writeQueue = write.catch(() => {});
    return write;
  }

  async clear(): Promise<void> {
    const write = this.writeQueue.then(() => this.store.save([]));
    this.writeQueue = write.catch(() => {});
    return write;
  }

  private async find(key: string): Promise<TxManifestExecutionRecord | undefined> {
    const cutoff = this.now() - RETENTION_MS;
    return (await this.store.load()).find(
      (record) =>
        record.key === key &&
        (isCheckpoint(record) ||
          (isFailed(record) ? record.failedAt >= cutoff : record.completedAt >= cutoff)),
    );
  }

  private async persistTerminal(record: TxManifestTerminalRecord): Promise<void> {
    const write = this.writeQueue.then(async () => {
      const cutoff = this.now() - RETENTION_MS;
      const current = await this.store.load();
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
    this.writeQueue = write.catch(() => {});
    return write;
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
