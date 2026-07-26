// Shared swap constants — imported by both the service worker (enforcement) and
// the swap UI (display), so the two never drift. Kept dependency-free so the UI
// can import it without pulling the orchestrator/client runtime into its bundle.

/** Independent cap on the Liquid network fee for an instant swap, in sats. This is
 *  the independent estimate the verification gate requires — never derived from
 *  dealer data.
 *
 *  Measured against two real mainnet swaps, one per direction:
 *    - 2 USDt → L-BTC (`fb083646…`, block 3,989,114): 6,149 vsize, **53 sats**
 *    - 1550 sats L-BTC → USDt (`84c5bc08…`, block 3,989,117): 6,258 vsize, **60 sats**
 *  Both ~6,200 vsize at ~0.01 sat/vbyte, so 1000 sats is ~17× headroom — comfortable
 *  rather than tight. The cap only binds on an L-BTC send (fee is in the send asset);
 *  on a USDt send the dealer covers the fee and this is a no-op.
 *
 *  If this ever becomes a live feerate × vsize calculation, size it off that real
 *  figure: confidential-transaction range proofs make a swap PSET **thousands** of
 *  vbytes, not the few hundred a bare P2WPKH intuition suggests. A 200–300 vbyte
 *  assumption would compute a cap far below the true fee and reject valid swaps. */
export const SWAP_MAX_FEE_SATS = 1000;

/** Marker the service worker prefixes onto a `SwapLowBalanceError` so the side
 *  panel can recognize a genuine one and read the dealer's fillable amount.
 *
 *  Only an Error's `message` survives the SW→UI hop (the router serializes with
 *  `errMsg`), so the amount has to travel inside the string — and the dealer
 *  controls part of that string, since a dealer failure arrives as
 *  `dealer error: ${error_msg}`. The panel's parse is anchored at position 0 on
 *  this marker, which the dealer's text can never occupy, so a hostile
 *  `error_msg` echoing the marker cannot fabricate a fillable figure.
 *
 *  Lives here (not in the panel) because it's a contract between the service
 *  worker that writes it and the panel that reads it. */
export const LOW_BALANCE_PREFIX = "SWAP_LOW_BALANCE:";
