import type { LiquidNetwork } from "@/keystore/keystore";

/**
 * blockstream.info Esplora explorer URL for a txid; null for regtest (no public
 * explorer). Uses Blockstream — the same backend the wallet syncs against — for
 * both networks; the LiquidNetwork values are already the explorer path segments.
 */
export function explorerTxUrl(network: LiquidNetwork, txid: string): string | null {
  if (network === "regtest") return null;
  return `https://blockstream.info/${network}/tx/${txid}`;
}
