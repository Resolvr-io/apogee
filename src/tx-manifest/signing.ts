import {
  requireTxManifestSigningMode,
  type TxManifestSigningMode,
} from "./adapters";

/** Return the exact prepared PSET unless the trusted plan explicitly requires wallet signing. */
export async function txManifestPsetForFinalization(
  signingModeValue: unknown,
  preparedPset: string,
  signWalletPset: (pset: string) => Promise<string>,
): Promise<{ signingMode: TxManifestSigningMode; pset: string }> {
  const signingMode = requireTxManifestSigningMode(signingModeValue);
  if (signingMode === "none") return { signingMode, pset: preparedPset };
  return { signingMode, pset: await signWalletPset(preparedPset) };
}

/**
 * Bind finalized bytes to the refreshed, reviewed unsigned transaction.
 * Elements txids exclude witnesses but commit every input outpoint/sequence,
 * locktime, and output asset/value/nonce/script, which is the exact template a
 * wallet signature or covenant witness must not be allowed to replace.
 */
export function requireTxManifestFinalTransactionTxid(
  expectedTxid: string,
  finalTxid: string,
): void {
  if (
    !/^[0-9a-f]{64}$/.test(expectedTxid) ||
    !/^[0-9a-f]{64}$/.test(finalTxid) ||
    expectedTxid !== finalTxid
  ) {
    throw new Error("The finalized TX Manifest transaction does not match the reviewed template.");
  }
}
