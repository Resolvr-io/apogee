import { describe, expect, expectTypeOf, it } from "vitest";
import {
  LIQUID_IDENTITY_CURVE,
  LIQUID_IDENTITY_SHARED_KEY_KDF,
  LIQUID_WALLET_DESCRIPTOR_CHANGED_EVENT,
  type LiquidEcdsaSignMessageResult,
  type LiquidEventMap,
  type LiquidGetBalanceResult,
  type LiquidProvider,
  type LiquidResult,
  type LiquidSignMessageResult,
  type LiquidWalletDescriptorEntry,
} from "./liquid-rpc";
import {
  deserializeLiquidRpcError,
  LIQUID_RPC_ERROR_CODES,
  LIQUID_RPC_ERROR_REASONS,
  LiquidRpcError,
  serializeLiquidRpcError,
} from "./liquid-rpc-errors";
import {
  isLiquidAccountIdentifier,
  isLiquidAssetId,
  isLiquidChainId,
  parseLiquidRpcRequest,
} from "./liquid-rpc-validation";

const CHAIN_ID = "bip122:1466275836220db2944ca059a3a10ef6";
const ACCOUNT_ID = `${CHAIN_ID}:b781-7bc7-db64-c3de-3937-7eb7-c9ab-f799`;
const ASSET_ID =
  `${CHAIN_ID}/elip144:6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d`;
const PUBLIC_KEY =
  "04c95ff5052c66d17ecbf08eafe00aade2071830b0bafc8e87b3debffbfa1b733" +
  "272900303e6688e025f9744e6c6e6961c5861138cc4e909eeedd84c84311b5ca1";

describe("Liquid Wallet RPC types", () => {
  it("maps method names to their result types", () => {
    expectTypeOf<LiquidResult<"getBalance">>().toEqualTypeOf<LiquidGetBalanceResult>();
    expectTypeOf<LiquidResult<"signMessage">>().toEqualTypeOf<LiquidSignMessageResult>();
    expectTypeOf<LiquidEcdsaSignMessageResult["messageHash"]>().toEqualTypeOf<string>();
  });

  it("uses a typed event payload and unsubscribe function", () => {
    expectTypeOf<LiquidEventMap[typeof LIQUID_WALLET_DESCRIPTOR_CHANGED_EVENT]>().toMatchTypeOf<{
      descriptors: LiquidWalletDescriptorEntry[];
    }>();
    expectTypeOf<LiquidProvider["on"]>().returns.toEqualTypeOf<() => void>();
  });
});

describe("ELIP-0144 identifiers", () => {
  it("accepts the identifiers from the draft examples", () => {
    expect(isLiquidChainId(CHAIN_ID)).toBe(true);
    expect(isLiquidAccountIdentifier(ACCOUNT_ID)).toBe(true);
    expect(isLiquidAssetId(ASSET_ID)).toBe(true);
  });

  it("rejects malformed or non-canonical identifiers", () => {
    expect(isLiquidChainId("bip122:ABCDEF")).toBe(false);
    expect(isLiquidAccountIdentifier(`${CHAIN_ID}:b7817bc7db64c3de39377eb7c9abf799`)).toBe(false);
    expect(isLiquidAssetId(`${CHAIN_ID}/unknown:${"0".repeat(64)}`)).toBe(false);
  });
});

describe("parseLiquidRpcRequest", () => {
  it("accepts omitted params for asset reads and drops a caller-supplied id", () => {
    expect(parseLiquidRpcRequest({ id: 42, method: "getBalance" })).toEqual({
      method: "getBalance",
      params: {},
    });
  });

  it("accepts ordered descriptor preferences, including an unknown future format", () => {
    expect(
      parseLiquidRpcRequest({
        method: "getWalletDescriptor",
        params: {
          descriptorType: "publicWalletDescriptor",
          descriptorFormat: [
            { format: "future-format", ignored: true },
            { format: "bip380-split-branches" },
          ],
        },
      }),
    ).toEqual({
      method: "getWalletDescriptor",
      params: {
        descriptorType: "publicWalletDescriptor",
        descriptorFormat: [
          { format: "future-format" },
          { format: "bip380-split-branches" },
        ],
      },
    });
  });

  it("copies and validates the draft sendTransfer example", () => {
    expect(
      parseLiquidRpcRequest({
        method: "sendTransfer",
        params: {
          account: ACCOUNT_ID,
          amount: "123000000",
          assetId: ASSET_ID,
          memo: "4c6971756964",
          recipientAddress:
            "lq1qqfk0uw9vlmqlggzs7cxmw49x8ks37l87udspmpt3ssgxjrkqqlww63xvus3c5gaz89r2kd393c4fvurwxf06qj87y2kd3vsln",
          source: "page-controlled",
          type: "wallet/reset",
        },
      }),
    ).toEqual({
      method: "sendTransfer",
      params: {
        account: ACCOUNT_ID,
        amount: "123000000",
        assetId: ASSET_ID,
        memo: "4c6971756964",
        recipientAddress:
          "lq1qqfk0uw9vlmqlggzs7cxmw49x8ks37l87udspmpt3ssgxjrkqqlww63xvus3c5gaz89r2kd393c4fvurwxf06qj87y2kd3vsln",
      },
    });
  });

  it("accepts and copies identity requests", () => {
    expect(
      parseLiquidRpcRequest({
        method: "getIdentitySharedKey",
        params: {
          identity: "ssh://jade@blockstream.com",
          curve: LIQUID_IDENTITY_CURVE,
          theirPublicKey: PUBLIC_KEY,
          index: 0,
          kdf: LIQUID_IDENTITY_SHARED_KEY_KDF,
          kdfSalt: "00010203",
          kdfInfo: "4c6971756964",
        },
      }),
    ).toEqual({
      method: "getIdentitySharedKey",
      params: {
        identity: "ssh://jade@blockstream.com",
        curve: LIQUID_IDENTITY_CURVE,
        theirPublicKey: PUBLIC_KEY,
        index: 0,
        kdf: LIQUID_IDENTITY_SHARED_KEY_KDF,
        kdfSalt: "00010203",
        kdfInfo: "4c6971756964",
      },
    });
  });

  it.each([
    {
      method: "getUTXOs",
      params: { assetId: ASSET_ID },
    },
    {
      method: "getIdentityPublicKey",
      params: {
        identity: "ssh://jade@blockstream.com",
        curve: LIQUID_IDENTITY_CURVE,
      },
    },
    {
      method: "signIdentity",
      params: {
        identity: "ssh://jade@blockstream.com",
        curve: LIQUID_IDENTITY_CURVE,
        challenge: "00",
      },
    },
  ])("accepts the $method request shape", ({ method, params }) => {
    expect(parseLiquidRpcRequest({ method, params })).toEqual({ method, params });
  });

  it("accepts a selective signPset request", () => {
    expect(
      parseLiquidRpcRequest({
        method: "signPset",
        params: {
          pset: "cHNldA==",
          signInputs: [{ index: 0, address: "ex1qexample", sighashTypes: [1, 129] }],
          broadcast: false,
        },
      }),
    ).toEqual({
      method: "signPset",
      params: {
        pset: "cHNldA==",
        signInputs: [{ index: 0, address: "ex1qexample", sighashTypes: [1, 129] }],
        broadcast: false,
      },
    });
  });

  it("allows an empty UTF-8 message and the default signing protocol", () => {
    expect(
      parseLiquidRpcRequest({
        method: "signMessage",
        params: { address: "ex1qexample", message: "" },
      }),
    ).toEqual({
      method: "signMessage",
      params: { address: "ex1qexample", message: "" },
    });
  });

  it("keeps Wallet ABI parameters opaque but copies them into a plain object", () => {
    const params = Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, {
      version: 1,
      action: { kind: "build" },
    });
    expect(parseLiquidRpcRequest({ method: "processConfidentialTransaction", params })).toEqual({
      method: "processConfidentialTransaction",
      params: { version: 1, action: { kind: "build" } },
    });
  });

  it("rejects unknown methods with a structured method-not-found error", () => {
    expectRpcError(
      () => parseLiquidRpcRequest({ method: "wallet/reset", params: {} }),
      LIQUID_RPC_ERROR_CODES.METHOD_NOT_FOUND,
      LIQUID_RPC_ERROR_REASONS.METHOD_NOT_FOUND,
      "method",
    );
  });

  it.each([
    {
      name: "numeric transfer amount",
      request: {
        method: "sendTransfer",
        params: { recipientAddress: "ex1qexample", amount: 10 },
      },
      path: "params.amount",
    },
    {
      name: "non-canonical asset id",
      request: { method: "getBalance", params: { assetId: ASSET_ID.toUpperCase() } },
      path: "params.assetId",
    },
    {
      name: "oversized memo",
      request: {
        method: "sendTransfer",
        params: { recipientAddress: "ex1qexample", amount: "1", memo: "aa".repeat(81) },
      },
      path: "params.memo",
    },
    {
      name: "compressed identity public key",
      request: {
        method: "getIdentitySharedKey",
        params: {
          identity: "ssh://example.com",
          curve: "nist256p1",
          theirPublicKey: `02${"00".repeat(32)}`,
          kdf: "hkdf-sha256",
          kdfSalt: "",
          kdfInfo: "00",
        },
      },
      path: "params.theirPublicKey",
    },
    {
      name: "bare ANYONECANPAY sighash flag",
      request: {
        method: "signPset",
        params: {
          pset: "cHNldA==",
          signInputs: [{ index: 0, address: "ex1qexample", sighashTypes: [128] }],
        },
      },
      path: "params.signInputs[0].sighashTypes[0]",
    },
    {
      name: "duplicate PSET input indexes",
      request: {
        method: "signPset",
        params: {
          pset: "cHNldA==",
          signInputs: [
            { index: 0, address: "ex1qexample" },
            { index: 0, address: "ex1qexample2" },
          ],
        },
      },
      path: "params.signInputs",
    },
  ])("rejects $name", ({ request, path }) => {
    expectRpcError(
      () => parseLiquidRpcRequest(request),
      LIQUID_RPC_ERROR_CODES.INVALID_PARAMS,
      LIQUID_RPC_ERROR_REASONS.INVALID_PARAMS,
      path,
    );
  });
});

describe("LiquidRpcError serialization", () => {
  it("round-trips code, message, reason, and details", () => {
    const original = new LiquidRpcError(
      LIQUID_RPC_ERROR_CODES.INVALID_PARAMS,
      "Bad amount",
      LIQUID_RPC_ERROR_REASONS.INVALID_PARAMS,
      { path: "params.amount" },
    );
    const restored = deserializeLiquidRpcError(serializeLiquidRpcError(original));
    expect(restored).toMatchObject({
      code: LIQUID_RPC_ERROR_CODES.INVALID_PARAMS,
      message: "Bad amount",
      data: {
        reason: LIQUID_RPC_ERROR_REASONS.INVALID_PARAMS,
        path: "params.amount",
      },
    });
  });

  it("does not leak arbitrary internal error messages", () => {
    expect(serializeLiquidRpcError(new Error("seed phrase was ..."))).toEqual({
      code: LIQUID_RPC_ERROR_CODES.INTERNAL_ERROR,
      message: "Internal wallet error.",
      data: { reason: LIQUID_RPC_ERROR_REASONS.INTERNAL_ERROR },
    });
  });
});

function expectRpcError(
  fn: () => unknown,
  code: number,
  reason: string,
  path: string,
): void {
  try {
    fn();
    throw new Error("Expected an RPC error.");
  } catch (error) {
    expect(error).toBeInstanceOf(LiquidRpcError);
    expect(error).toMatchObject({ code, data: { reason, path } });
  }
}
