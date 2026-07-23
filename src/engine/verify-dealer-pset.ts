// Dealer-PSET verification gate for SideSwap instant swaps (Track 1, plan task 4).
//
// Before the wallet signs a PSET the SideSwap dealer built (the `get_quote`
// response), this confirms — from the wallet's own point of view, via
// `Wollet.psetDetails()` — that the PSET does what the accepted quote said:
//
//   1. We receive at least the agreed amount of the receive asset, paid to OUR
//      address (not the dealer's).
//   2. We spend no more than the offered amount + quoted fee of the send asset.
//      A larger outflow means the dealer folded extra wallet inputs into the
//      PSET — a drain, since `Signer.sign` signs every input matching our
//      descriptor whether we offered it or not.
//   3. The fee is within an optional cap.
//
// Pure over a parsed PSET + Wollet: no network, no wallet mutation, no signing.
// It consumes the Pset (`psetDetails` takes ownership); re-parse from base64 to
// sign. UNVALIDATED against a live dealer PSET until the Track 1 spike lands —
// its tampered-PSET negative test is what proves these checks actually hold.

import type * as Lwk from "lwk_wasm";

/** Swap terms the caller derived from the accepted SideSwap quote. */
export interface VerifyDealerPsetTerms {
  sendAssetId: string; // hex asset being spent (e.g. the L-BTC policy asset)
  sendAmount: bigint; // amount offered in start_quotes (base units)
  recvAssetId: string; // hex asset being received (e.g. USDt)
  minRecvAmount: bigint; // minimum acceptable receive — caller applies slippage
  recvAddress: string; // confidential address the dealer was told to pay
  maxFee?: bigint; // optional fee cap in the send asset (base units)
}

export type VerifyDealerPsetResult =
  | { ok: true; sent: bigint; received: bigint; fee: bigint }
  | { ok: false; reason: string };

// 1-unit floor so confidential-amount rounding never rejects a fair swap.
const TOL = 1n;

export function verifyDealerPset(
  pset: Lwk.Pset,
  wollet: Lwk.Wollet,
  terms: VerifyDealerPsetTerms,
): VerifyDealerPsetResult {
  const balance = wollet.psetDetails(pset).balance();
  // Net per asset from the wallet's POV (negative = spent, positive = received).
  const balances = balance.balances().entries() as Map<string, bigint>;
  const fees = balance.fees().entries() as Map<string, bigint>;

  const sendNet = balances.get(terms.sendAssetId) ?? 0n;
  const recvNet = balances.get(terms.recvAssetId) ?? 0n;
  const sent = sendNet < 0n ? -sendNet : 0n; // outflow of the spend asset
  const received = recvNet > 0n ? recvNet : 0n; // inflow of the receive asset
  const fee = fees.get(terms.sendAssetId) ?? 0n;

  // 1. Fair receive — did we get paid at least the agreed amount?
  if (received < terms.minRecvAmount) {
    return { ok: false, reason: `receive ${received} < minimum ${terms.minRecvAmount}` };
  }

  // 2. No drain — outflow of the send asset must not exceed offered + fee.
  if (sent > terms.sendAmount + fee + TOL) {
    return { ok: false, reason: `spend ${sent} exceeds offered ${terms.sendAmount} + fee ${fee}` };
  }

  // 3. Paid to our address, our asset. (Both sides are canonical Liquid bech32
  //    from the same wallet, so an exact string compare is safe.)
  const paidToUs = balance.recipients().some(
    (r) =>
      r.address()?.toString() === terms.recvAddress &&
      r.asset()?.toString() === terms.recvAssetId &&
      (r.value() ?? 0n) >= terms.minRecvAmount,
  );
  if (!paidToUs) {
    return { ok: false, reason: `no output to ${terms.recvAddress} of ${terms.recvAssetId}` };
  }

  // 4. Fee within the optional cap.
  if (terms.maxFee !== undefined && fee > terms.maxFee) {
    return { ok: false, reason: `fee ${fee} exceeds cap ${terms.maxFee}` };
  }

  return { ok: true, sent, received, fee };
}
