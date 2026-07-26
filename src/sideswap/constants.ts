// Shared swap constants — imported by both the service worker (enforcement) and
// the swap UI (display), so the two never drift. Kept dependency-free so the UI
// can import it without pulling the orchestrator/client runtime into its bundle.

/** Independent cap on the Liquid network fee for an instant swap, in sats. This is
 *  the independent estimate the verification gate requires — never derived from
 *  dealer data. Deliberately generous: the gate rejects a swap whose fee exceeds
 *  this, so a tight cap would refuse fair swaps.
 *
 *  Two mainnet swaps measured 53 and 60 sats at ~6,200 vsize, so 1000 is ~17×
 *  headroom. If this ever becomes a live feerate × vsize calculation, size it off
 *  that real figure: confidential-transaction range proofs make a swap PSET
 *  **thousands** of vbytes, not the few hundred a bare P2WPKH intuition suggests,
 *  so a 200–300 vbyte assumption would compute a cap far below the true fee and
 *  reject valid swaps. */
export const SWAP_MAX_FEE_SATS = 1000;

/** Typical actual network fee for a swap, in sats — for DISPLAY estimates only,
 *  never for verification (the gate uses `SWAP_MAX_FEE_SATS`, which must stay a
 *  generous ceiling so a slightly larger real fee can't reject a fair swap).
 *
 *  Two mainnet swaps measured 53 and 60 sats, so ~60 is representative. Using the
 *  1000-sat cap in a cost-percentage display would overstate wildly on a small
 *  swap — it computes ~66% for a $1 swap whose real cost was ~9% — and scare users
 *  away from legitimate trades. */
export const SWAP_TYPICAL_FEE_SATS = 60;

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
