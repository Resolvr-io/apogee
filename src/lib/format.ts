// Amount formatting. LBTC has 8 decimals like Bitcoin.

const SATS_PER_BTC = 100_000_000;

/** Group a sats integer with thousands separators, e.g. 1234567 → "1,234,567". */
export function formatSats(sats: number): string {
  return Math.trunc(sats).toLocaleString("en-US");
}

/** Render sats as a fixed-8 LBTC string, e.g. 123456 → "0.00123456". */
export function formatBtc(sats: number): string {
  return (sats / SATS_PER_BTC).toLocaleString("en-US", {
    minimumFractionDigits: 8,
    maximumFractionDigits: 8,
  });
}

/**
 * Render a Liquid token amount in its own units given the asset's `precision`
 * (decimal places). Balances arrive as integer base units, so a precision-3
 * "TEST" balance of 1000 → "1.000". A null/0 precision shows the raw integer
 * with thousands separators (the safe fallback for unregistered assets).
 */
export function formatAssetAmount(amount: number, precision: number | null): string {
  const p = precision && precision > 0 ? precision : 0;
  const value = p > 0 ? amount / 10 ** p : amount;
  // Trim non-significant trailing zeros, padding to at most two decimals
  // (fewer when the asset's precision is lower): a precision-8 stablecoin
  // shows 150.42 (not 150.42000000) and 15.00 (currency-style), while
  // meaningful digits keep full precision (1.00660712 stays complete).
  return value.toLocaleString("en-US", {
    minimumFractionDigits: Math.min(2, p),
    maximumFractionDigits: p,
  });
}

/** Parse a user-typed asset amount into integer base units at the given
 *  precision, or null when invalid (empty, malformed, negative, more decimals
 *  than the asset allows, or beyond safe-integer range). String math — float
 *  multiplication corrupts values like 0.07 at precision 8. */
export function parseAssetAmount(text: string, precision: number): number | null {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  const p = precision > 0 ? precision : 0;
  if (frac.length > p) return null;
  const units = BigInt(whole) * 10n ** BigInt(p) + BigInt(frac.padEnd(p, "0") || "0");
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(units);
}

/** Convert a sats amount to fiat given the BTC price in that fiat. */
export function satsToFiat(sats: number, btcPrice: number): number {
  return (sats / SATS_PER_BTC) * btcPrice;
}

/** Render a fiat amount in the currency's native minor units, e.g.
 *  1234.5 → "$1,234.50" (USD) but "¥1,235" (JPY has no minor unit). */
export function formatFiat(value: number, currency = "USD"): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency,
  });
}

/** Always-relative age of a unix-seconds timestamp ("Just now", "5m ago",
 *  "3d ago", "1mo ago", "2y ago"); "Pending" when unconfirmed. */
export function formatRelative(timestamp: number | null): string {
  if (!timestamp) return "Pending";
  const secs = Math.max(0, Date.now() / 1000 - timestamp);
  if (secs < 60) return "Just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(secs / 3600);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(secs / 86_400);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Full date + time for a unix-seconds timestamp; "Unconfirmed" when null. */
export function formatTimestamp(timestamp: number | null): string {
  if (!timestamp) return "Unconfirmed";
  return new Date(timestamp * 1000).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}
