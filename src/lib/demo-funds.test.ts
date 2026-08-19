// The demo dataset's whole value is that the three surfaces AGREE: the Coins
// list, the balance, and the activity history all describe one wallet. That was
// asserted only in comments, which is exactly what a future amount tweak breaks
// silently — so pin it here.

import { describe, expect, it, vi } from "vitest";

// demo-funds.ts also exports the `useDemoFunds` hook, so importing it pulls in
// lib/ext — which touches `chrome` at module load. Only the datasets are under
// test here.
vi.mock("@/lib/ext", () => ({
  browser: {
    storage: {
      local: { get: vi.fn(() => Promise.resolve({})), set: vi.fn() },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  },
}));

import { DEMO_SYNC, DEMO_TXS, DEMO_UTXOS } from "./demo-funds";

/** bech32's data charset — 1, b, i and o are excluded to avoid transcription
 *  ambiguity, so their presence is the cheapest tell that an address is fake. */
const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function sumBy<T>(items: readonly T[], asset: (t: T) => string, amount: (t: T) => bigint) {
  const out = new Map<string, bigint>();
  for (const i of items) out.set(asset(i), (out.get(asset(i)) ?? 0n) + amount(i));
  return out;
}

describe("demo funds", () => {
  it("has Coins outputs summing to the balance on every asset", () => {
    const totals = sumBy(
      DEMO_UTXOS,
      (u) => u.asset,
      (u) => BigInt(u.amount),
    );
    for (const [asset, balance] of Object.entries(DEMO_SYNC.balance)) {
      expect(totals.get(asset), `asset ${asset}`).toBe(BigInt(balance));
    }
    // No output belongs to an asset the balance doesn't mention.
    expect([...totals.keys()].sort()).toEqual(Object.keys(DEMO_SYNC.balance).sort());
  });

  it("has activity deltas summing to the balance on every asset", () => {
    const totals = new Map<string, bigint>();
    for (const tx of DEMO_TXS) {
      for (const [asset, delta] of Object.entries(tx.assetDeltas)) {
        totals.set(asset, (totals.get(asset) ?? 0n) + BigInt(delta));
      }
    }
    for (const [asset, balance] of Object.entries(DEMO_SYNC.balance)) {
      expect(totals.get(asset), `asset ${asset}`).toBe(BigInt(balance));
    }
  });

  it("keeps lbtcSats in step with the policy asset's balance", () => {
    expect(BigInt(DEMO_SYNC.lbtcSats)).toBe(BigInt(DEMO_SYNC.balance[DEMO_SYNC.policyAssetHex]));
  });

  it("uses mainnet-shaped confidential addresses that read as real ones", () => {
    for (const { address, confidential } of DEMO_UTXOS) {
      const sep = address.lastIndexOf("1");
      const data = address.slice(sep + 1);
      for (const ch of data) {
        expect(BECH32.includes(ch), `${address} contains non-bech32 "${ch}"`).toBe(true);
      }
      // Mainnet prefix only — a testnet-looking address would defeat the point.
      expect(address.startsWith("lq1")).toBe(true);
      // All confidential, matching what the wallet actually produces, and the
      // blinding key is what makes them this long.
      expect(confidential).toBe(true);
      expect(address.length).toBe(102);
    }
  });
});
