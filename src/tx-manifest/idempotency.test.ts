import { describe, expect, it, vi } from "vitest";
import type { LiquidExecuteTxManifestResult } from "@/provider/liquid-rpc";
import {
  TxManifestIdempotency,
  type TxManifestTerminalRecord,
  type TxManifestTerminalStore,
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

function memoryStore(): TxManifestTerminalStore & { records: TxManifestTerminalRecord[] } {
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
});
