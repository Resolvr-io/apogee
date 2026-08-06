import {
  LIQUID_RPC_ERROR_CODES,
  LIQUID_RPC_ERROR_REASONS,
  LiquidRpcError,
} from "./liquid-rpc-errors";

export interface ProviderPsetBroadcastOperations {
  /** Produce a fully finalized PSET or reject when any input is incomplete. */
  finalize: (signedPset: string) => Promise<string>;
  /** Re-check the origin, wallet, network, and lock state before submission. */
  authorize: () => Promise<void>;
  /** Submit the already-finalized PSET and return its transaction id. */
  broadcast: (finalizedPset: string) => Promise<string>;
}

/**
 * Finalize, re-authorize, then broadcast an approved provider PSET.
 *
 * Finalization is deliberately separated from submission: an incomplete PSET
 * is still caller-controlled transaction data, while a network rejection is a
 * chain availability failure. Authorization sits between them so revocation or
 * locking that happens during finalization prevents the irreversible action.
 */
export async function finalizeAndBroadcastProviderPset(
  signedPset: string,
  operations: ProviderPsetBroadcastOperations,
): Promise<string> {
  let finalizedPset: string;
  try {
    finalizedPset = await operations.finalize(signedPset);
  } catch {
    throw new LiquidRpcError(
      LIQUID_RPC_ERROR_CODES.INVALID_PARAMS,
      "This PSET is incomplete and cannot be broadcast.",
      LIQUID_RPC_ERROR_REASONS.INVALID_PARAMS,
      {
        method: "signPset",
        capability: "broadcast",
        cause: "incomplete_transaction",
      },
    );
  }

  // Do not catch this error: the caller supplies the precise authorization or
  // lock-state failure, and it must survive unchanged across the RPC boundary.
  await operations.authorize();

  try {
    return await operations.broadcast(finalizedPset);
  } catch (error) {
    // The broadcast implementation may place one final authorization gate at
    // the head of its own work queue. Preserve that precise failure rather
    // than misreporting a revocation or lock as a network outage.
    if (error instanceof LiquidRpcError) throw error;
    throw new LiquidRpcError(
      LIQUID_RPC_ERROR_CODES.CHAIN_UNAVAILABLE,
      "Apogee could not broadcast the signed transaction.",
      LIQUID_RPC_ERROR_REASONS.CHAIN_UNAVAILABLE,
      { method: "signPset", capability: "broadcast", cause: "broadcast_failed" },
    );
  }
}
