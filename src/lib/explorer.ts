import type { LiquidNetwork } from "@/keystore/keystore";

/**
 * Path segment liquid.network uses in its web UI, per network.
 *
 * This mapping is the whole reason the module needs more than one line. It is
 * not the `LiquidNetwork` identifier and it is not the explorer's REST prefix
 * either: mainnet is the explorer's default network so it takes no segment,
 * while testnet is `testnet` in the UI even though the same host answers REST
 * calls under `liquidtestnet`. blockstream.info happened to accept our
 * identifiers verbatim as path segments, which is why nothing had to translate
 * them before.
 */
const EXPLORER_PATH: Record<LiquidNetwork, string | null> = {
  liquid: "",
  liquidtestnet: "testnet/",
  regtest: null, // local chain — nothing public to link to
};

/**
 * liquid.network URL for a txid; null where there is no public explorer.
 *
 * liquid.network over blockstream.info because it reads better on exactly the
 * transactions this wallet produces: confidential amounts, asset labels, and the
 * fee breakdown are all legible without cross-referencing, and it surfaces the
 * discounted vsize that actually governs what a blinded transaction costs. It is
 * also the Esplora backend Apogee already syncs against by default, so a link
 * now shows the same view of the chain the wallet itself is reading.
 */
export function explorerTxUrl(network: LiquidNetwork, txid: string): string | null {
  const path = EXPLORER_PATH[network];
  if (path === null) return null;
  return `https://liquid.network/${path}tx/${txid}`;
}
