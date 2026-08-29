// Dealer-PSET verification gate for SideSwap instant swaps.
//
// Before the wallet signs a PSET the dealer built, this confirms from the
// wallet's own point of view (`Wollet.psetDetails()`) that the PSET does what the
// accepted quote said:
//
//   1. We receive at least the agreed amount. Net from the wallet's POV, so a
//      positive inflow can only come from an output we own — which also catches a
//      dealer redirecting the receive output away from us.
//   2. No input drain. `Signer.sign` signs EVERY input matching our descriptor
//      regardless of asset, so this covers the send asset (outflow ≤ offered +
//      fee) AND every other asset (must net ≥ 0). Otherwise a dealer folds in a
//      UTXO of some other token we hold, paid to themselves, undetected.
//   3. The fee is within the caller's required cap, so a hostile dealer can't
//      inflate it to burn our L-BTC. The fee cancels out of check 2, so this cap
//      is what actually bounds it.
//
// Deliberately NO separate "a recipient output carries the receive asset" check:
// `recipients()` lists only outputs that DON'T belong to the wallet, and the
// receive output is paid to our own address. Such a check rejects the happy path
// while adding nothing over check 1.
//
// Pure over a parsed PSET + Wollet: no network, no mutation, no signing.
// `psetDetails` takes the Pset by reference, so it can be signed afterward. The
// tampered-PSET cases (inflated send amount, third-asset drain, redirected
// receive output) are what prove these checks hold.

import type * as Lwk from "lwk_wasm";

/** Swap terms the caller derived from the accepted SideSwap quote. */
export interface VerifyDealerPsetTerms {
  sendAssetId: string; // hex asset being spent (e.g. the L-BTC policy asset)
  sendAmount: bigint; // amount offered in start_quotes (base units)
  recvAssetId: string; // hex asset being received (e.g. USDt)
  minRecvAmount: bigint; // minimum acceptable receive — caller applies slippage
  /** Required cap on the network fee, in the SEND asset. Liquid fees are always
   *  in the policy asset, so this bounds the fee when sending L-BTC. Sending USDt
   *  makes the send-asset fee 0 (the real fee reduces the received L-BTC, bounded
   *  by `minRecvAmount`), so the cap is a no-op that direction — but it stays
   *  REQUIRED so no caller can leave the L-BTC-send fee unbounded. */
  maxFee: bigint;
  /** Independent upper bound on the send-asset principal, excluding fee. Critical
   *  in receive-exact mode: without it the dealer's own quoted send amount is the
   *  only bound. Derive it from the user-reviewed estimate plus a tolerance,
   *  never from the execution-time quote. */
  maxSendAmount?: bigint;
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
  // Enrich with wallet input metadata (derivation paths, witness UTXOs) before
  // reading balances. Dealer-built PSETs lack it, and without addDetails
  // psetDetails returns empty balances — every check then passes trivially on
  // 0 inflow, 0 outflow, 0 fee.
  pset.addDetails(wollet);
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

  // 2a. Independent send-amount cap. In receive-exact mode the dealer chooses the
  //     send amount, so `sendAmount` above is dealer-derived; this cap, set from
  //     the user-reviewed estimate, is the real protection against a runaway
  //     quote.
  if (terms.maxSendAmount != null && sent > terms.maxSendAmount + fee + TOL) {
    return { ok: false, reason: `spend ${sent} exceeds user-approved cap ${terms.maxSendAmount} + fee ${fee}` };
  }

  // 2b. No drain on any OTHER asset — see the header: sign() covers every
  //     matching input regardless of asset.
  for (const [asset, net] of balances) {
    if (asset !== terms.sendAssetId && net < -TOL) {
      return { ok: false, reason: `unexpected outflow of asset ${asset}: ${net}` };
    }
  }

  // 3. Fee cap. Required, so the fee stays bounded even though it cancels out of
  //    check 2.
  if (fee > terms.maxFee) {
    return { ok: false, reason: `fee ${fee} exceeds cap ${terms.maxFee}` };
  }

  return { ok: true, sent, received, fee };
}
