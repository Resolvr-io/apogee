import { describe, expect, it, vi } from "vitest";
import { LIQUID_TESTNET_GENESIS_HASH } from "./network";
import { resolveDeclarativeChainSnapshot } from "./declarative-chain";

const TXID = "11".repeat(32);
const TX_HEX = "0200000000";
const BASE = "http://127.0.0.1:3001";

function response(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    text: async () => String(body),
    json: async () => body,
  } as Response;
}

function chainFetch(status: Record<string, unknown>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/block-height/0")) return response(LIQUID_TESTNET_GENESIS_HASH);
    if (url.endsWith("/blocks/tip/height")) return response("123");
    if (url.endsWith("/fee-estimates")) return response({ "1": 0.1 });
    if (url.endsWith(`/tx/${TXID}/hex`)) return response(TX_HEX);
    if (url.endsWith(`/tx/${TXID}/status`)) return response(status);
    if (url.endsWith(`/tx/${TXID}/outspend/0`)) return response({ spent: false });
    return response("missing", false);
  }) as typeof fetch;
}

const inspect = vi.fn(async () => ({
  txid: TXID,
  vout: 0,
  tx_out: "aa",
  script_pub_key: "0014" + "22".repeat(20),
  asset: "33".repeat(32),
  amount: "500",
  explicit: true,
}));

describe("declarative chain evidence", () => {
  it("accepts an unspent mempool head without inventing a confirmation policy", async () => {
    const snapshot = await resolveDeclarativeChainSnapshot(
      [{ id: "state", outpoint: { txid: TXID, vout: 0 } }],
      inspect,
      BASE,
      LIQUID_TESTNET_GENESIS_HASH,
      chainFetch({ confirmed: false }),
    );
    expect(snapshot.inputs[0]).toMatchObject({
      id: "state",
      confirmed: false,
      blockHeight: null,
      amount: "500",
    });
    expect(snapshot.feeRateSatPerKvb).toBe("100");
  });

  it("retains a verified confirmation height for review and policy checks", async () => {
    const snapshot = await resolveDeclarativeChainSnapshot(
      [{ id: "state", outpoint: { txid: TXID, vout: 0 } }],
      inspect,
      BASE,
      LIQUID_TESTNET_GENESIS_HASH,
      chainFetch({ confirmed: true, block_height: 120 }),
    );
    expect(snapshot.inputs[0]).toMatchObject({ confirmed: true, blockHeight: 120 });
  });

  it("rejects spent, duplicate, mismatched, and confidential provided inputs", async () => {
    await expect(resolveDeclarativeChainSnapshot(
      [
        { id: "a", outpoint: { txid: TXID, vout: 0 } },
        { id: "b", outpoint: { txid: TXID, vout: 0 } },
      ],
      inspect,
      BASE,
      LIQUID_TESTNET_GENESIS_HASH,
      chainFetch({ confirmed: false }),
    )).rejects.toThrow(/duplicated/);

    const spentFetch = chainFetch({ confirmed: false });
    vi.mocked(spentFetch).mockImplementation(async (input) =>
      String(input).endsWith("/outspend/0")
        ? response({ spent: true })
        : chainFetch({ confirmed: false })(input),
    );
    await expect(resolveDeclarativeChainSnapshot(
      [{ id: "state", outpoint: { txid: TXID, vout: 0 } }],
      inspect,
      BASE,
      LIQUID_TESTNET_GENESIS_HASH,
      spentFetch,
    )).rejects.toThrow(/already spent/);

    const confidentialInspect = vi.fn(async () => ({
      ...(await inspect()),
      explicit: false,
      asset: undefined,
      amount: undefined,
    }));
    await expect(resolveDeclarativeChainSnapshot(
      [{ id: "state", outpoint: { txid: TXID, vout: 0 } }],
      confidentialInspect,
      BASE,
      LIQUID_TESTNET_GENESIS_HASH,
      chainFetch({ confirmed: false }),
    )).rejects.toThrow(/explicit provided inputs/);
  });
});
