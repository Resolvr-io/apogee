/** Settle-poll cadence for a broadcast consolidation, mirroring the home
 *  view's settleAfterTx: this many tries, this far apart. */
export const CONSOLIDATION_SETTLE_POLLS = 12;
export const CONSOLIDATION_SETTLE_MS = 5000;

/** A broadcast consolidation has landed once any outpoint it spends is gone
 *  from the wallet's UTXO set: the sync has seen the mempool tx (or a
 *  conflict). "Any", not "all" — coin selection can legitimately leave an
 *  output unspent when the balance moves between prepare and broadcast, and
 *  an every-outpoint predicate would then never fire, wedging the pending
 *  card. */
export function consolidationLanded(spent: string[], present: ReadonlySet<string>): boolean {
  return spent.some((op) => !present.has(op));
}
