// Class-name join utility.
export function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

// Middle-truncate a long identifier (address, txid, asset id) to
// "first…last" with a single-glyph ellipsis. Returns the original when
// truncation wouldn't shorten it.
export function shortenHex(value: string, head = 8, tail = 8): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

// A BIP32 master fingerprint is exactly 8 hex characters. Empty/short = unreadable
// (e.g. a Jade key-origin that didn't parse), which callers must treat as invalid.
export function isValidFingerprint(fp: string): boolean {
  return /^[0-9a-fA-F]{8}$/.test(fp);
}
