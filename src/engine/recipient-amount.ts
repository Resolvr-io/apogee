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

/** String-valued counterpart used by the browser RPC path, where issued-asset
 * amounts can exceed JavaScript's safe-integer range. */
export interface ExactRecipientAmountInput {
  deltas: Record<string, string>;
  fee: string;
  recipientsCount: number;
  amount: string;
  drain: boolean;
  isToken: boolean;
  assetId?: string;
  policyAssetHex: string;
  policyBalance: string;
}

export interface ExactRecipientAmount {
  amount: string;
  toSelf: boolean;
}

export function exactRecipientAmount(input: ExactRecipientAmountInput): ExactRecipientAmount {
  const fee = BigInt(input.fee);
  const requested = BigInt(input.amount);
  const policyBalance = BigInt(input.policyBalance);
  const netPolicy = BigInt(input.deltas[input.policyAssetHex] ?? "0");
  const tokenDelta = input.isToken
    ? BigInt(input.deltas[input.assetId ?? ""] ?? "0")
    : 0n;
  // Both signals must agree before saying funds return to this wallet: LWK found
  // no external recipient, and the net deltas show only the policy-asset fee.
  // Requiring the deltas makes a missed external output fail safe as a normal
  // outflow instead of presenting it as a harmless self-send.
  const toSelf =
    input.recipientsCount === 0 &&
    netPolicy === -fee &&
    (!input.isToken || tokenDelta === 0n);

  if (toSelf) {
    // An LBTC drain's requested amount is intentionally zero; derive what the
    // destination receives from the wallet balance less the prepared fee.
    const amount =
      input.isToken || !input.drain
        ? requested
        : policyBalance > fee
          ? policyBalance - fee
          : 0n;
    return { amount: amount.toString(), toSelf: true };
  }

  // External token movement is its asset delta. External LBTC movement includes
  // the fee in the policy delta, so subtract it to get the recipient amount.
  const amount = input.isToken ? -tokenDelta : -netPolicy - fee;
  if (amount < 0n) throw new Error("The prepared transaction has an invalid recipient amount.");
  return { amount: amount.toString(), toSelf: false };
}

export function recipientAmount(input: RecipientAmountInput): RecipientAmount {
  const result = exactRecipientAmount({
    deltas: Object.fromEntries(
      Object.entries(input.deltas).map(([asset, amount]) => [asset, String(amount)]),
    ),
    fee: String(input.fee),
    recipientsCount: input.recipientsCount,
    amount: String(input.sats),
    drain: input.drain,
    isToken: input.isToken,
    assetId: input.assetId,
    policyAssetHex: input.policyAssetHex,
    policyBalance: String(input.policyBalance),
  });
  return { amount: Number(result.amount), toSelf: result.toSelf };
}
