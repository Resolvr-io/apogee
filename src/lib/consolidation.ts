/** Settle-poll cadence for a broadcast consolidation, mirroring the home
 *  view's settleAfterTx: this many tries, this far apart. */
export const CONSOLIDATION_SETTLE_POLLS = 12;
export const CONSOLIDATION_SETTLE_MS = 5000;

/** A consolidation broadcast awaiting its first sighting in the wallet's UTXO
 *  set, keyed by asset id. Lives in the Wallet component rather than Coins:
 *  Coins fully unmounts on every trip through Settings (or any other view),
 *  so state local to it can't survive a round trip — which used to mean the
 *  pending card, and the guard that hides the Combine button, both vanished
 *  while the mempool tx was still settling. */
export interface ConsolidationBroadcast {
  txid: string;
  spent: string[];
  stuck?: boolean;
  /** Settle-poll attempts against THIS broadcast. Per-entry rather than a
   *  shared counter: a shared counter meant starting a second consolidation
   *  reset the first's remaining budget, and an exhausted budget marked
   *  EVERY pending entry stuck rather than just the one that earned it. */
  polls: number;
}

/** A broadcast consolidation has landed once any outpoint it spends is gone
 *  from the wallet's UTXO set: the sync has seen the mempool tx (or a
 *  conflict). "Any", not "all" — coin selection can legitimately leave an
 *  output unspent when the balance moves between prepare and broadcast, and
 *  an every-outpoint predicate would then never fire, wedging the pending
 *  card. */
export function consolidationLanded(spent: string[], present: ReadonlySet<string>): boolean {
  return spent.some((op) => !present.has(op));
}

/** Ids of pending broadcasts whose spent outpoints are now gone — the moment
 *  each one's pending card should clear. */
export function landedBroadcastIds(
  broadcasts: Readonly<Record<string, ConsolidationBroadcast>>,
  present: ReadonlySet<string>,
): string[] {
  return Object.entries(broadcasts)
    .filter(([, b]) => consolidationLanded(b.spent, present))
    .map(([id]) => id);
}

/** Ids of pending (not yet stuck) broadcasts whose OWN poll budget has just
 *  run out. Per-entry, not global — see ConsolidationBroadcast's doc comment
 *  for why a shared counter was wrong. */
export function exhaustedBroadcastIds(
  broadcasts: Readonly<Record<string, ConsolidationBroadcast>>,
): string[] {
  return Object.entries(broadcasts)
    .filter(([, b]) => !b.stuck && b.polls >= CONSOLIDATION_SETTLE_POLLS)
    .map(([id]) => id);
}
