import { describe, expect, it, vi } from "vitest";
import {
  LIQUID_RPC_ERROR_CODES,
  LIQUID_RPC_ERROR_REASONS,
  LiquidRpcError,
} from "./liquid-rpc-errors";
import { finalizeAndBroadcastProviderPset } from "./liquid-provider-pset-broadcast";

describe("finalizeAndBroadcastProviderPset", () => {
  it("finalizes before the last authorization check and only then broadcasts", async () => {
    const order: string[] = [];
    const txid = await finalizeAndBroadcastProviderPset("signed", {
      finalize: vi.fn(async (pset) => {
        order.push(`finalize:${pset}`);
        return "finalized";
      }),
      authorize: vi.fn(async () => {
        order.push("authorize");
      }),
      broadcast: vi.fn(async (pset) => {
        order.push(`broadcast:${pset}`);
        return "11".repeat(32);
      }),
    });

    expect(txid).toBe("11".repeat(32));
    expect(order).toEqual(["finalize:signed", "authorize", "broadcast:finalized"]);
  });

  it("rejects an incomplete PSET without authorizing or broadcasting", async () => {
    const authorize = vi.fn(async () => undefined);
    const broadcast = vi.fn(async () => "22".repeat(32));

    await expect(
      finalizeAndBroadcastProviderPset("partial", {
        finalize: async () => {
          throw new Error("raw LWK finalization detail");
        },
        authorize,
        broadcast,
      }),
    ).rejects.toMatchObject({
      code: LIQUID_RPC_ERROR_CODES.INVALID_PARAMS,
      message: "This PSET is incomplete and cannot be broadcast.",
      data: {
        reason: LIQUID_RPC_ERROR_REASONS.INVALID_PARAMS,
        method: "signPset",
        capability: "broadcast",
        cause: "incomplete_transaction",
      },
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("preserves a late authorization failure and never broadcasts", async () => {
    const unauthorized = new LiquidRpcError(
      LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
      "This site was disconnected before Apogee could broadcast the transaction.",
      LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
    );
    const broadcast = vi.fn(async () => "33".repeat(32));

    await expect(
      finalizeAndBroadcastProviderPset("signed", {
        finalize: async () => "finalized",
        authorize: async () => {
          throw unauthorized;
        },
        broadcast,
      }),
    ).rejects.toBe(unauthorized);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("preserves an authorization failure at the final broadcast gate", async () => {
    const unauthorized = new LiquidRpcError(
      LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
      "This site was disconnected before Apogee could broadcast the transaction.",
      LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
    );

    await expect(
      finalizeAndBroadcastProviderPset("signed", {
        finalize: async () => "finalized",
        authorize: async () => undefined,
        broadcast: async () => {
          throw unauthorized;
        },
      }),
    ).rejects.toBe(unauthorized);
  });

  it("maps broadcaster failures without returning the signed PSET", async () => {
    const error = await finalizeAndBroadcastProviderPset("secret-signed-pset", {
      finalize: async () => "finalized",
      authorize: async () => undefined,
      broadcast: async () => {
        throw new Error("raw Esplora response");
      },
    }).catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      code: LIQUID_RPC_ERROR_CODES.CHAIN_UNAVAILABLE,
      message: "Apogee could not broadcast the signed transaction.",
      data: {
        reason: LIQUID_RPC_ERROR_REASONS.CHAIN_UNAVAILABLE,
        method: "signPset",
        capability: "broadcast",
        cause: "broadcast_failed",
      },
    });
    expect(JSON.stringify(error)).not.toContain("secret-signed-pset");
    expect(JSON.stringify(error)).not.toContain("raw Esplora response");
  });
});
