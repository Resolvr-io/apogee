// Error translation for the side panel — pure string/logic helpers, no extension
// runtime. Kept separate from wallet-client.ts (which imports @/lib/ext and so
// touches the `chrome` global at module load) so these stay unit-testable in a
// plain Node environment. wallet-client re-exports everything here, so existing
// `from "@/sidepanel/wallet-client"` imports keep working.

import { LOW_BALANCE_PREFIX } from "@/sideswap/constants";

/** Surface an unknown thrown value as a message string. */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- unlock-throttle error translation ----
//
// The keystore refuses guarded password attempts with machine-readable codes
// (UNLOCK_THROTTLED:<epochMs> / UNLOCK_BLOCKED) so every surface with a password
// field — unlock screen, approval overlay, reveal-seed form, swap step-up —
// renders the same friendly text instead of a raw code.

/** Epoch ms when the next attempt is allowed, if `err` is a cooldown refusal. */
export function throttledUntil(err: unknown): number | null {
  const m = /^UNLOCK_THROTTLED:(\d+)$/.exec(errMessage(err));
  return m ? Number(m[1]) : null;
}

/** True when `err` is the hard lock (only recovery/reset can proceed). */
export function isUnlockBlocked(err: unknown): boolean {
  return errMessage(err) === "UNLOCK_BLOCKED";
}

export const UNLOCK_BLOCKED_TEXT =
  "Too many failed attempts. Restore from your recovery phrase or reset Apogee to continue.";

/** Render "wait" durations as e.g. "45s" or "2m 30s". */
export function formatCooldown(msLeft: number): string {
  const s = Math.max(1, Math.ceil(msLeft / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

/** Friendly text for any password-attempt error (throttle-aware). */
export function unlockErrMessage(err: unknown): string {
  if (isUnlockBlocked(err)) return UNLOCK_BLOCKED_TEXT;
  const until = throttledUntil(err);
  if (until !== null) {
    return `Too many failed attempts. Try again in ${formatCooldown(until - Date.now())}.`;
  }
  return errMessage(err);
}

// ---- swap error classification ----
//
// The orchestrator/verification gate throws technical reasons ("spend 1000
// exceeds offered 999 + fee 0", "receive … < minimum"). Swap users should see
// plain language, not PSET internals — and the CALLER needs to know whether the
// reviewed quote is still safe to reuse on a retry.
//
// The two are separated deliberately. `swapErrorKind` drives control flow (may
// the user press Confirm again with the same quote?), `swapErrorMessage` only
// renders text. Matching is on substrings because the throw sites use free-form
// strings; tagging SwapError with a discriminant code at the throw site is the
// proper fix and would let this collapse to a switch.

export type SwapErrorKind =
  | "auth" // password missing/wrong/throttled — quote is untouched, safe to reuse
  | "stale-quote" // gate rejected or dealer re-quoted — the reviewed quote is no longer trustworthy
  | "unknown"; // anything else — treat conservatively, like stale-quote

/** The dealer's fillable amount (base units) from a genuine LowBalance refusal,
 *  or null. Anchored (`^`) on `LOW_BALANCE_PREFIX`, so a dealer `error_msg`
 *  echoing the marker mid-string can't inject a fabricated amount. */
export function lowBalanceAvailable(err: unknown): bigint | null {
  const m = new RegExp(`^${LOW_BALANCE_PREFIX}(\\d+)$`).exec(errMessage(err));
  return m ? BigInt(m[1]) : null;
}

/** Classify a swap failure. `auth` is the ONLY kind where the reviewed quote may
 *  be reused for a retry: nothing about the swap terms changed, the user just
 *  needs to re-enter (or wait out) their password. Every other kind means the
 *  terms the user approved may no longer hold, so the caller must re-quote. */
export function swapErrorKind(err: unknown): SwapErrorKind {
  const raw = errMessage(err);
  // Throttle refusals come from verifyPassword sharing the unlock throttle.
  if (isUnlockBlocked(err) || throttledUntil(err) !== null) return "auth";
  if (raw.startsWith("Enter your password to swap")) return "auth";
  if (raw.startsWith(LOW_BALANCE_PREFIX)) return "stale-quote";
  const m = raw.toLowerCase();
  // Gate rejections are prefixed by the orchestrator; dealer/quote failures mean
  // the dealer's terms moved. Both invalidate the reviewed quote. (A dealer
  // echoing any of these substrings only ever lands itself in `stale-quote`,
  // which is the conservative kind — the quote is dropped either way.)
  if (
    m.includes("verification gate rejected") ||
    m.includes("dealer error") ||
    m.includes("timed out waiting for dealer quote")
  ) {
    return "stale-quote";
  }
  return "unknown";
}

/** Plain-language text for a swap error, falling back to the raw message. */
export function swapErrorMessage(err: unknown): string {
  const raw = errMessage(err);
  // Password throttle/lockout already has friendly, cooldown-aware copy.
  if (isUnlockBlocked(err) || throttledUntil(err) !== null) return unlockErrMessage(err);
  if (raw.startsWith("Enter your password to swap")) return raw; // already friendly
  // Anchored on the SW's marker, so a dealer `error_msg` echoing "LowBalance"
  // can't force this copy onto an unrelated failure. Never leaks the numeric
  // suffix — the caller renders the figure via `lowBalanceAvailable` (it needs
  // asset precision to format), so this stays generic.
  if (raw.startsWith(LOW_BALANCE_PREFIX)) {
    return "The dealer can't fill a swap this size right now. Try a smaller amount.";
  }
  const m = raw.toLowerCase();
  if (m.includes("timed out waiting for dealer quote"))
    return "The dealer didn't respond in time — please try again.";
  if (m.includes("dealer error")) return "The dealer declined the swap. Try again.";
  if (m.includes("no utxos")) return "No spendable outputs for that asset.";
  // Verification-gate rejection — the swap was NOT signed. Anchored on the
  // orchestrator's prefix rather than loose terms like "exceeds", which would
  // also swallow unrelated balance-validation copy.
  if (m.includes("verification gate rejected")) {
    return "The rate moved or the quote changed unfavorably, so the swap was not signed. Get a fresh quote and try again.";
  }
  return raw;
}
