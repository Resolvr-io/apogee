import type { WalletInfo } from "@/keystore/keystore";
import {
  requireTxManifestSigningMode,
  type TxManifestSigningMode,
} from "@/tx-manifest/adapters/types";
import { isTxManifestExecutionNetwork } from "@/tx-manifest/network";
import {
  LIQUID_WALLET_RPC_METHODS,
  type LiquidExecuteTxManifestParams,
} from "./liquid-rpc";
import {
  LIQUID_RPC_ERROR_CODES,
  LIQUID_RPC_ERROR_REASONS,
  LiquidRpcError,
} from "./liquid-rpc-errors";

export type TxManifestExecutionConnection = {
  walletId: string;
  chainId: string;
  accountIdentifier: string;
  permissions: { methods: readonly string[] };
};

export type TxManifestAuthorizationDependencies<
  Connection extends TxManifestExecutionConnection,
  Result,
> = {
  loadConnection(origin: string): Promise<Connection | null>;
  loadWallet(walletId: string): Promise<WalletInfo>;
  disconnect(origin: string): Promise<void>;
  continueExecution(connection: Connection, wallet: WalletInfo): Promise<Result>;
};

/**
 * Fail-closed authorization boundary for TX Manifest execution.
 *
 * Preparation, approval, signing, and broadcast are reachable only through the
 * continuation. Keeping every cheap identity/capability guard ahead of that one
 * boundary makes it possible to prove denials cannot open an approval or submit a
 * transaction without importing the service worker into unit tests.
 */
export async function withAuthorizedProviderTxManifestExecution<
  Connection extends TxManifestExecutionConnection,
  Result,
>(
  origin: string,
  invocation: LiquidExecuteTxManifestParams,
  dependencies: TxManifestAuthorizationDependencies<Connection, Result>,
): Promise<Result> {
  const connection = await dependencies.loadConnection(origin);
  if (
    !connection?.permissions.methods.includes(
      LIQUID_WALLET_RPC_METHODS.EXECUTE_TX_MANIFEST,
    )
  ) {
    throw providerError(
      LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
      "This origin is not authorized to execute TX Manifests.",
      LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
    );
  }
  if (invocation.chainId !== connection.chainId) {
    throw providerError(
      LIQUID_RPC_ERROR_CODES.INVALID_PARAMS,
      "The TX Manifest chain must exactly match the connected wallet.",
      LIQUID_RPC_ERROR_REASONS.INVALID_PARAMS,
      { path: "params.chainId" },
    );
  }
  if (invocation.accountIdentifier !== connection.accountIdentifier) {
    throw providerError(
      LIQUID_RPC_ERROR_CODES.INVALID_PARAMS,
      "The TX Manifest account must exactly match the connected wallet.",
      LIQUID_RPC_ERROR_REASONS.INVALID_PARAMS,
      { path: "params.accountIdentifier" },
    );
  }

  let wallet: WalletInfo;
  try {
    wallet = await dependencies.loadWallet(connection.walletId);
  } catch {
    await dependencies.disconnect(origin);
    throw providerError(
      LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
      "The connected wallet is no longer available.",
      LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
    );
  }
  if (!isTxManifestExecutionNetwork(wallet.network)) {
    throw providerError(
      LIQUID_RPC_ERROR_CODES.UNSUPPORTED_CAPABILITY,
      "TX Manifest execution is not enabled for this Liquid network.",
      LIQUID_RPC_ERROR_REASONS.UNSUPPORTED_CAPABILITY,
      {
        method: LIQUID_WALLET_RPC_METHODS.EXECUTE_TX_MANIFEST,
        cause: "network",
      },
    );
  }
  return dependencies.continueExecution(connection, wallet);
}

function providerError(
  code: (typeof LIQUID_RPC_ERROR_CODES)[keyof typeof LIQUID_RPC_ERROR_CODES],
  message: string,
  reason: (typeof LIQUID_RPC_ERROR_REASONS)[keyof typeof LIQUID_RPC_ERROR_REASONS],
  data?: unknown,
): LiquidRpcError {
  return new LiquidRpcError(code, message, reason, data);
}

/** Apply signer restrictions after the trusted adapter resolves its execution plan. */
export function requireTxManifestSigningCapability(
  wallet: WalletInfo,
  signingModeValue: unknown,
): TxManifestSigningMode {
  const signingMode = requireTxManifestSigningMode(signingModeValue);
  if (signingMode === "none") return signingMode;
  if (wallet.signer !== "local") {
    throw providerError(
      LIQUID_RPC_ERROR_CODES.UNSUPPORTED_CAPABILITY,
      wallet.signer === "jade"
        ? "Jade TX Manifest execution is not enabled until BIP340 signing support is verified."
        : "A watch-only wallet cannot execute TX Manifests.",
      LIQUID_RPC_ERROR_REASONS.UNSUPPORTED_CAPABILITY,
      {
        method: LIQUID_WALLET_RPC_METHODS.EXECUTE_TX_MANIFEST,
        cause: wallet.signer,
      },
    );
  }
  return signingMode;
}
