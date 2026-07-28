// What the destination of a prepared send actually receives, and whether that
// destination is one of our own addresses.
//
// Pure and separate from the engine so it can be tested: `prepareSend` runs
// behind `loadLwk()` + a live Wollet, so none of the branches below were
// reachable from a test — which is why the self-send case reported 0 through two
// releases before anyone noticed.
//
// The amount is derived from the PSET the wallet actually built, never from what
// a caller asked for, EXCEPT on a proven self-send (see `toSelf` below) where no
// funds leave the wallet and there is nothing on the PSET's balance side to read.

/** Everything the calculation needs, all plain numbers. */
export interface RecipientAmountInput {
  /** Net per-asset deltas from the wallet's point of view (negative = spend). */
  deltas: Record<string, number>;
  /** Network fee in policy-asset units. */
  fee: number;
  /** How many outputs do NOT belong to this wallet. */
  recipientsCount: number;
  /** The amount handed to the builder. Meaningless for an LBTC drain. */
  sats: number;
  drain: boolean;
  isToken: boolean;
  /** Asset id of the token being sent, when `isToken`. */
  assetId?: string;
  policyAssetHex: string;
  /** Wallet's policy-asset balance. Only read for an LBTC drain to ourselves. */
  policyBalance: number;
}

export interface RecipientAmount {
  /** Base units of the sent asset that reach the destination. Never negative. */
  amount: number;
  /** The destination belongs to this wallet: the amount returns, fee is the cost. */
  toSelf: boolean;
}

export function recipientAmount(input: RecipientAmountInput): RecipientAmount {
  const netPolicy = input.deltas[input.policyAssetHex] ?? 0;
  const tokenDelta = input.isToken ? (input.deltas[input.assetId ?? ""] ?? 0) : 0;

  // Two independent signals must agree before we treat this as paying ourselves.
  //
  //  - No output falls outside the wallet. (`recipients()` excludes wallet-owned
  //    outputs, so an empty list means nothing leaves.)
  //  - The deltas show the exact signature of a pure self-send: the policy asset
  //    moved by precisely the fee, and a token not at all.
  //
  // The second condition exists because the first one's dangerous failure mode is
  // a FALSE POSITIVE — an output that really is external but that lwk didn't list.
  // That would show "returns to you" over funds that are in fact gone. Any such
  // outflow shows up as a delta beyond the fee, so requiring both makes the
  // dangerous direction fail safe: we drop to the PSET-derived amount below,
  // which is exactly what a normal external send uses.
  const toSelf =
    input.recipientsCount === 0 &&
    netPolicy === -input.fee &&
    (!input.isToken || tokenDelta === 0);

  if (toSelf) {
    // An LBTC drain is the one path where `sats` says nothing — the builder
    // chooses the amount, so the caller's value arrives as 0. A drain pays the
    // destination every input it spends, less the fee. Clamped at 0: the balance
    // read can come back empty if lwk's balance JSON fails, and `0 - fee` would
    // otherwise render a negative amount on a signing screen.
    const amount =
      input.isToken || !input.drain
        ? input.sats
        : Math.max(0, input.policyBalance - input.fee);
    return { amount, toSelf: true };
  }

  // Funds leave the wallet, so the deltas carry the real gross flow. For a token
  // the fee sits entirely in the policy delta, so the token delta needs no fee
  // term; for LBTC the policy delta's magnitude is recipient + fee.
  const amount = input.isToken ? -tokenDelta : -netPolicy - input.fee;
  return { amount, toSelf: false };
}
