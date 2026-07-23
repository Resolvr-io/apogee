// Dealer-PSET verification gate for SideSwap instant swaps (Track 1, plan task 4).
//
// Before the wallet signs a PSET the SideSwap dealer built (the `get_quote`
// response), this confirms — from the wallet's own point of view, via
// `Wollet.psetDetails()` — that the PSET does what the accepted quote said:
//
//   1. We receive at least the agreed amount of the receive asset. (Net from the
//      wallet's POV, so a positive inflow can only come from an output to an
//      address the wallet owns — this is the real "paid to us" guarantee.)
//   2. No input drain. `Signer.sign` signs EVERY input matching our descriptor,
//      regardless of asset — so the check covers the send asset (outflow ≤
//      offered + fee) AND every other asset (must net ≥ 0). Otherwise a dealer
//      folding in a UTXO of some other token we hold, paid to themselves, drains
//      it undetected.
//   3. Defense-in-depth: a recipient output actually carries the receive asset.
//   4. The fee is within an optional cap.
//
// Pure over a parsed PSET + Wollet: no network, no wallet mutation, no signing.
// `psetDetails` takes the Pset by reference (does not consume it — `prepareSend`
// reuses the same object), so it could be signed afterward; the engine parses a
// fresh copy per call anyway. UNVALIDATED against a live dealer PSET until the
// Track 1 spike lands — its tampered-PSET cases (inflated send amount, a
// third-asset drain, a tampered recipient) are what prove these checks hold.

import type * as Lwk from "lwk_wasm";

/** Swap terms the caller derived from the accepted SideSwap quote. */
export interface VerifyDealerPsetTerms {
  sendAssetId: string; // hex asset being spent (e.g. the L-BTC policy asset)
  sendAmount: bigint; // amount offered in start_quotes (base units)
  recvAssetId: string; // hex asset being received (e.g. USDt)
  minRecvAmount: bigint; // minimum acceptable receive — caller applies slippage
  /** Fee cap in the SEND asset. Liquid fees are always in the policy asset
   *  (L-BTC): effective when sending L-BTC; when sending USDt the real L-BTC fee
   *  instead reduces the received L-BTC (bounded by `minRecvAmount`), so this cap
   *  is a no-op in that direction. */
  maxFee?: bigint;
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
  // Fee taken in the SEND asset (see the maxFee doc — 0 when sending USDt).
  const fee = fees.get(terms.sendAssetId) ?? 0n;

  // 1. Fair receive.
  if (received < terms.minRecvAmount) {
    return { ok: false, reason: `receive ${received} < minimum ${terms.minRecvAmount}` };
  }

  // 2. No drain on the send asset — outflow must not exceed offered + fee.
  if (sent > terms.sendAmount + fee + TOL) {
    return { ok: false, reason: `spend ${sent} exceeds offered ${terms.sendAmount} + fee ${fee}` };
  }

  // 2b. No drain on any OTHER asset. Signer.sign signs every matching input
  //     regardless of asset (header), so a UTXO of another token folded in and
  //     paid to the dealer must be rejected here, not just the send asset.
  for (const [asset, net] of balances) {
    if (asset !== terms.sendAssetId && net < -TOL) {
      return { ok: false, reason: `unexpected outflow of asset ${asset}: ${net}` };
    }
  }

  // 3. Defense-in-depth: a recipient output carries the receive asset. (Asset
  //    ids are canonical hex so the compare is safe; check 1 is the real
  //    guarantee, so this only catches a wildly malformed PSET.)
  const hasRecvOutput = balance.recipients().some(
    (r) => r.asset()?.toString() === terms.recvAssetId && (r.value() ?? 0n) >= terms.minRecvAmount,
  );
  if (!hasRecvOutput) {
    return { ok: false, reason: `no ${terms.recvAssetId} recipient output >= ${terms.minRecvAmount}` };
  }

  // 4. Fee cap (send-asset fee — see the maxFee doc).
  if (terms.maxFee !== undefined && fee > terms.maxFee) {
    return { ok: false, reason: `fee ${fee} exceeds cap ${terms.maxFee}` };
  }

  return { ok: true, sent, received, fee };
}
