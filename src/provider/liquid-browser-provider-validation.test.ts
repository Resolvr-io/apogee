import { describe, expect, it } from "vitest";
import { parseLiquidProviderRequest } from "./liquid-browser-provider-validation";

const LIQUID_CHAIN = "bip122:1466275836220db2944ca059a3a10ef6";

describe("parseLiquidProviderRequest", () => {
  it("copies a connection request and drops untrusted fields", () => {
    expect(
      parseLiquidProviderRequest({
        id: "caller-id",
        method: "wallet_connect",
        params: {
          chains: [LIQUID_CHAIN],
          methods: ["getBalance", "futureMethod"],
          events: ["futureEvent"],
          origin: "https://forged.example",
        },
      }),
    ).toEqual({
      method: "wallet_connect",
      params: {
        chains: [LIQUID_CHAIN],
        methods: ["getBalance", "futureMethod"],
        events: ["futureEvent"],
      },
    });
  });

  it("rejects duplicate grants and lifecycle capabilities", () => {
    expect(() =>
      parseLiquidProviderRequest({
        method: "wallet_connect",
        params: { methods: ["getBalance", "getBalance"] },
      }),
    ).toThrow(expect.objectContaining({ code: -32602 }));
    expect(() =>
      parseLiquidProviderRequest({
        method: "wallet_connect",
        params: { methods: ["wallet_disconnect"] },
      }),
    ).toThrow(expect.objectContaining({ code: -32602 }));
    expect(() =>
      parseLiquidProviderRequest({
        method: "wallet_connect",
        params: { methods: ["getBalance"], events: ["wallet_connectionChanged"] },
      }),
    ).toThrow(expect.objectContaining({ code: -32602 }));
  });

  it("accepts empty lifecycle params and rejects unexpected ones", () => {
    expect(parseLiquidProviderRequest({ method: "wallet_getConnection" })).toEqual({
      method: "wallet_getConnection",
      params: {},
    });
    expect(() =>
      parseLiquidProviderRequest({ method: "wallet_disconnect", params: { origin: "forged" } }),
    ).toThrow(expect.objectContaining({ code: -32602 }));
  });

  it("uses invalid-request and method-not-found errors at the provider boundary", () => {
    expect(() => parseLiquidProviderRequest(null)).toThrow(
      expect.objectContaining({ code: -32600 }),
    );
    expect(() => parseLiquidProviderRequest({ method: "unknown" })).toThrow(
      expect.objectContaining({ code: -32601 }),
    );
  });

  it("delegates profile requests to the pinned ELIP validator", () => {
    expect(parseLiquidProviderRequest({ id: 7, method: "getBalance" })).toEqual({
      method: "getBalance",
      params: {},
    });
  });
});
