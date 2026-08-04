import type { LiquidNetwork } from "@/keystore/keystore";

/**
 * Path segment liquid.network uses in its web UI, per network.
 *
 * `testnet` is not a typo for our own `liquidtestnet` identifier. The same host
 * serves both under different names: the UI wants `/testnet/…` while the REST
 * API answers on `/liquidtestnet/api/…`. Three other places here use the REST
 * spelling — the Esplora provider list (`engine-core.ts:70`), icon lookups
 * (`asset-icons.ts:20`) and the chain-server chooser (`Wallet.tsx:2107`) — so
 * anyone grepping for `liquid.network` finds four URLs and this is the one that
 * looks wrong. It isn't. Changing it to match the others yields a link that
 * loads the explorer and then shows nothing, and no automated check will catch
 * that: the explorer is a single-page app that answers 200 with an identical
 * body for every path, including deliberate nonsense.
 *
 * Mainnet is the explorer's default network and takes no segment at all.
 */
const EXPLORER_PATH: Record<LiquidNetwork, string | null> = {
  liquid: "",
  liquidtestnet: "/testnet",
  regtest: null, // local chain — nothing public to link to
};

/** A Liquid txid is a 32-byte hash; anything else means a bug further upstream. */
const TXID = /^[0-9a-f]{64}$/i;

/**
 * liquid.network URL for a txid, or null when there is nothing worth linking to.
 *
 * liquid.network over blockstream.info because it reads better on exactly the
 * transactions this wallet produces: confidential amounts, asset labels and the
 * fee breakdown are legible without cross-referencing, and it surfaces the
 * discounted vsize that actually governs what a blinded transaction costs. It is
 * also the Esplora backend Apogee already syncs against by default, so a link
 * now shows the same view of the chain the wallet itself is reading — and
 * clicking one no longer tells a second server which transaction you are
 * looking at.
 */
export function explorerTxUrl(network: LiquidNetwork, txid: string): string | null {
  // Why `Object.hasOwn` rather than indexing straight in: wallet records carry
  // the network as a string that is typed but never validated on load, so a
  // record written by a newer build and read back by an older one arrives here
  // under a name this map has never heard of. Most such names index to
  // `undefined`, but every object literal also inherits `__proto__`,
  // `constructor` and the rest from Object.prototype — so
  // `EXPLORER_PATH["__proto__"]` is `Object.prototype`, an object rather than
  // undefined, and a nullish check alone waves it through into
  // `https://liquid.network[object Object]/tx/…` rendered as a live link.
  if (!Object.hasOwn(EXPLORER_PATH, network)) return null;

  // `== null` covers `undefined` too, so this stays correct even if the guard
  // above is ever loosened.
  const path = EXPLORER_PATH[network];
  if (path == null) return null;

  // No link at all beats a link that cannot resolve. Mirrors the guard the other
  // liquid.network URL builder applies to asset ids (`asset-icons.ts:35`).
  if (!TXID.test(txid)) return null;

  return `https://liquid.network${path}/tx/${txid}`;
}
