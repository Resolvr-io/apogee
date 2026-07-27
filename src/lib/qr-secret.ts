// One-shot hand-off for a QR-scanned seed phrase.
//
// A seed phrase must NOT travel over `runtime.sendMessage` with no target: that
// fans out to every extension context, so the secret would be delivered to any
// page that happens to be listening. Only Apogee's own pages exist today, but a
// seed shouldn't depend on that. The scanner hands the value to the service
// worker, which parks it here for exactly one claim.
//
// Extracted from background/index.ts so the claim semantics — single-use and
// time-boxed — are unit-testable; that module registers listeners at import and
// can't be loaded under Node. See docs/seed-qr-import.md.

/** How long a parked phrase stays claimable. An unclaimed value (window closed,
 *  user walked away) must not linger in service-worker memory. */
export const QR_SECRET_TTL_MS = 90_000;

export interface ParkedSecret {
  value: string;
  at: number;
}

/** Read-and-clear. Returns the value only if it is still fresh, and ALWAYS clears
 *  — the clear is unconditional and happens before the freshness test, so a stale
 *  value can never be claimed twice and a second claim always returns null.
 *
 *  Deliberately pure: the caller owns the storage slot, which in the service
 *  worker is a module-level variable and never `storage.*` (persisting a seed
 *  phrase would make it recoverable from disk or survive a crash). */
export function claimSecret(
  held: ParkedSecret | null,
  now: number,
): { value: string | null; next: null } {
  const fresh = held != null && now - held.at < QR_SECRET_TTL_MS;
  return { value: fresh ? held.value : null, next: null };
}
