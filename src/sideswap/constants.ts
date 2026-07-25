// Shared swap constants — imported by both the service worker (enforcement) and
// the swap UI (display), so the two never drift. Kept dependency-free so the UI
// can import it without pulling the orchestrator/client runtime into its bundle.

/** Independent cap on the Liquid network fee for an instant swap, in sats.
 *  Covers any reasonable swap (a swap PSET is ~200–300 vbytes at 0.1–1 sat/vbyte).
 *  This is the independent estimate the verification gate requires — never derived
 *  from dealer data. TODO before mainnet: replace with a live feerate × vsize. */
export const SWAP_MAX_FEE_SATS = 1000;
