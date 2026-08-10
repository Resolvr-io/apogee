import type { LiquidExecuteTxManifestResult } from "@/provider/liquid-rpc";

export type TxManifestTerminalRecord = {
  key: string;
  invocationDigest: `sha256:${string}`;
  completedAt: number;
  result: LiquidExecuteTxManifestResult;
};

export interface TxManifestTerminalStore {
  load(): Promise<TxManifestTerminalRecord[]>;
  save(records: TxManifestTerminalRecord[]): Promise<void>;
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
    private readonly store: TxManifestTerminalStore,
    private readonly now: () => number = Date.now,
  ) {}

  async execute(
    key: string,
    invocationDigest: `sha256:${string}`,
    operation: () => Promise<LiquidExecuteTxManifestResult>,
  ): Promise<LiquidExecuteTxManifestResult> {
    const existing = await this.find(key);
    if (existing) {
      this.requireSameInvocation(existing.invocationDigest, invocationDigest);
      return existing.result;
    }
    const running = this.inFlight.get(key);
    if (running) {
      this.requireSameInvocation(running.invocationDigest, invocationDigest);
      return running.promise;
    }
    const promise = operation().then(async (result) => {
      await this.persist({ key, invocationDigest, completedAt: this.now(), result });
      return result;
    });
    this.inFlight.set(key, { invocationDigest, promise });
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key);
    }
  }

  private async find(key: string): Promise<TxManifestTerminalRecord | undefined> {
    const cutoff = this.now() - RETENTION_MS;
    return (await this.store.load()).find(
      (record) => record.key === key && record.completedAt >= cutoff,
    );
  }

  private async persist(record: TxManifestTerminalRecord): Promise<void> {
    const write = this.writeQueue.then(async () => {
      const cutoff = this.now() - RETENTION_MS;
      const records = (await this.store.load())
        .filter((candidate) => candidate.key !== record.key && candidate.completedAt >= cutoff)
        .concat(record)
        .sort((a, b) => b.completedAt - a.completedAt)
        .slice(0, MAX_RECORDS);
      await this.store.save(records);
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
