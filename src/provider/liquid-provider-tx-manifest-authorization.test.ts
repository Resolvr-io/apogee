import { describe, expect, it, vi } from "vitest";
import type { WalletInfo, WalletSigner } from "@/keystore/keystore";
import { SIMPLICITY_LENDING_V3_TESTNET_CHAIN } from "@/tx-manifest/builtins/simplicity-lending-v3";
import {
  LIQUID_WALLET_RPC_METHODS,
  type LiquidExecuteTxManifestParams,
} from "./liquid-rpc";
import {
  LIQUID_RPC_ERROR_CODES,
  LIQUID_RPC_ERROR_REASONS,
} from "./liquid-rpc-errors";
import {
  requireTxManifestSigningCapability,
  withAuthorizedProviderTxManifestExecution,
  type TxManifestAuthorizationDependencies,
  type TxManifestExecutionConnection,
} from "./liquid-provider-tx-manifest-authorization";

const ORIGIN = "https://lending.example";
const ACCOUNT_ID = `${SIMPLICITY_LENDING_V3_TESTNET_CHAIN}:wallet-account`;
const INVOCATION: LiquidExecuteTxManifestParams = {
  protocolVersion: "0.1",
  requestId: "create-offer-1",
  chainId: SIMPLICITY_LENDING_V3_TESTNET_CHAIN,
  accountIdentifier: ACCOUNT_ID,
  manifest: { bundleHash: `sha256:${"11".repeat(32)}` },
  action: "lending_contract.CreateOffer",
  arguments: {},
};
const CONNECTION: TxManifestExecutionConnection = {
  walletId: "wallet-1",
  chainId: INVOCATION.chainId,
  accountIdentifier: INVOCATION.accountIdentifier,
  permissions: { methods: [LIQUID_WALLET_RPC_METHODS.EXECUTE_TX_MANIFEST] },
};
const WALLET: WalletInfo = {
  id: CONNECTION.walletId,
  label: "Test wallet",
  network: "liquidtestnet",
  signer: "local",
  descriptor: "ct(test)",
  fingerprint: "12345678",
  createdAt: 1,
};

type Dependencies = TxManifestAuthorizationDependencies<
  TxManifestExecutionConnection,
  string
>;

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    loadConnection: vi.fn(async () => CONNECTION),
    loadWallet: vi.fn(async () => WALLET),
    disconnect: vi.fn(async () => undefined),
    continueExecution: vi.fn(async () => "continued"),
    ...overrides,
  };
}

function wallet(signer: WalletSigner, network: WalletInfo["network"] = "liquidtestnet") {
  return { ...WALLET, signer, network };
}

describe("withAuthorizedProviderTxManifestExecution", () => {
  it.each([
    ["has no connection", null],
    [
      "lacks the execution permission",
      { ...CONNECTION, permissions: { methods: [LIQUID_WALLET_RPC_METHODS.GET_BALANCE] } },
    ],
  ])("rejects an origin that %s before loading the wallet", async (_label, connection) => {
    const deps = dependencies({ loadConnection: vi.fn(async () => connection) });

    await expect(
      withAuthorizedProviderTxManifestExecution(ORIGIN, INVOCATION, deps),
    ).rejects.toMatchObject({
      code: LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
      data: { reason: LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED },
    });
    expect(deps.loadWallet).not.toHaveBeenCalled();
    expect(deps.continueExecution).not.toHaveBeenCalled();
  });

  it("reports a chain mismatch at the chain field and never continues", async () => {
    const deps = dependencies();

    await expect(
      withAuthorizedProviderTxManifestExecution(
        ORIGIN,
        { ...INVOCATION, chainId: `bip122:${"22".repeat(16)}` },
        deps,
      ),
    ).rejects.toMatchObject({
      code: LIQUID_RPC_ERROR_CODES.INVALID_PARAMS,
      data: {
        reason: LIQUID_RPC_ERROR_REASONS.INVALID_PARAMS,
        path: "params.chainId",
      },
    });
    expect(deps.loadWallet).not.toHaveBeenCalled();
    expect(deps.continueExecution).not.toHaveBeenCalled();
  });

  it("reports an account mismatch at the account field and never continues", async () => {
    const deps = dependencies();

    await expect(
      withAuthorizedProviderTxManifestExecution(
        ORIGIN,
        { ...INVOCATION, accountIdentifier: `${INVOCATION.chainId}:other-account` },
        deps,
      ),
    ).rejects.toMatchObject({
      code: LIQUID_RPC_ERROR_CODES.INVALID_PARAMS,
      data: {
        reason: LIQUID_RPC_ERROR_REASONS.INVALID_PARAMS,
        path: "params.accountIdentifier",
      },
    });
    expect(deps.loadWallet).not.toHaveBeenCalled();
    expect(deps.continueExecution).not.toHaveBeenCalled();
  });

  it("disconnects a stale wallet connection and never continues", async () => {
    const deps = dependencies({
      loadWallet: vi.fn(async () => {
        throw new Error("wallet missing");
      }),
    });

    await expect(
      withAuthorizedProviderTxManifestExecution(ORIGIN, INVOCATION, deps),
    ).rejects.toMatchObject({
      code: LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
      data: { reason: LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED },
    });
    expect(deps.disconnect).toHaveBeenCalledExactlyOnceWith(ORIGIN);
    expect(deps.continueExecution).not.toHaveBeenCalled();
  });

  it("rejects mainnet before entering the approval and broadcast continuation", async () => {
    const deps = dependencies({ loadWallet: vi.fn(async () => wallet("local", "liquid")) });

    await expect(
      withAuthorizedProviderTxManifestExecution(ORIGIN, INVOCATION, deps),
    ).rejects.toMatchObject({
      code: LIQUID_RPC_ERROR_CODES.UNSUPPORTED_CAPABILITY,
      data: {
        reason: LIQUID_RPC_ERROR_REASONS.UNSUPPORTED_CAPABILITY,
        method: LIQUID_WALLET_RPC_METHODS.EXECUTE_TX_MANIFEST,
        cause: "network",
      },
    });
    expect(deps.continueExecution).not.toHaveBeenCalled();
  });

  it.each(["local", "jade", "watch"] as const)(
    "defers %s signer restrictions until after requirements resolution",
    async (signer) => {
      const deps = dependencies({ loadWallet: vi.fn(async () => wallet(signer)) });

      await expect(
        withAuthorizedProviderTxManifestExecution(ORIGIN, INVOCATION, deps),
      ).resolves.toBe("continued");
      expect(deps.continueExecution).toHaveBeenCalledExactlyOnceWith(
        CONNECTION,
        expect.objectContaining({ signer }),
      );
    },
  );

  it("continues exactly once for the authorized matching testnet software wallet", async () => {
    const deps = dependencies();

    await expect(
      withAuthorizedProviderTxManifestExecution(ORIGIN, INVOCATION, deps),
    ).resolves.toBe("continued");
    expect(deps.disconnect).not.toHaveBeenCalled();
    expect(deps.continueExecution).toHaveBeenCalledExactlyOnceWith(CONNECTION, WALLET);
  });
});

describe("requireTxManifestSigningCapability", () => {
  it.each(["local", "jade", "watch"] as const)(
    "allows a signature-free plan with a %s wallet",
    (signer) => {
      expect(requireTxManifestSigningCapability(wallet(signer), "none")).toBe("none");
    },
  );

  it("allows wallet signing only with the software signer", () => {
    expect(requireTxManifestSigningCapability(wallet("local"), "wallet")).toBe("wallet");
  });

  it.each([
    ["jade", "Jade TX Manifest execution is not enabled"],
    ["watch", "A watch-only wallet cannot execute TX Manifests"],
  ] as const)("rejects %s for a wallet-signing plan", (signer, message) => {
    expect(() => requireTxManifestSigningCapability(wallet(signer), "wallet")).toThrow(message);
  });

  it("fails closed on an unknown signing mode", () => {
    expect(() => requireTxManifestSigningCapability(wallet("local"), "future")).toThrow(
      "Unsupported TX Manifest signing mode.",
    );
  });
});
