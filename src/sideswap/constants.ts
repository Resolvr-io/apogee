// Shared swap constants — imported by both the service worker (enforcement) and
// the swap UI (display), so the two never drift. Kept dependency-free so the UI
// can import it without pulling the orchestrator/client runtime into its bundle.

/** Independent cap on the Liquid network fee for an instant swap, in sats. This is
 *  the independent estimate the verification gate requires — never derived from
 *  dealer data.
 *
 *  Measured against a real mainnet swap (2 USDt → L-BTC, txid `fb083646…`,
 *  block 3,989,114): **6,149 vsize, 53 sats** — 2 inputs, 6 outputs. So 1000 sats
 *  is ~19× headroom, comfortable rather than tight.
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
