// Update check: compare the running build against the newest published release.
//
// The published version is read from this repo's GitHub Releases, which is the
// tag every store package is cut from (see the release workflow), so it is the
// authoritative "what exists" figure and one source serves both browsers.
// Neither store offers a usable public version API — the Chrome Web Store has
// none at all, and scraping a listing page would break on any markup change.
//
// A store can lag GitHub by however long review takes, so a newer tag means "a
// newer version has been released", not "your store has it yet". The wording in
// the UI says available, not installable, and links to the listing rather than
// promising an immediate update.
//
// Runs only when the user clicks Check for updates — never on open, never on a
// timer — so the extension makes no unprompted network request for this.

/** Newest published release, plus whether it is ahead of the running build. */
export interface UpdateCheck {
  /** Version string from the newest release tag, e.g. "0.6.0". */
  latest: string;
  /** True when `latest` is strictly newer than the running build. */
  newer: boolean;
}

/**
 * Strip a leading "v" from a release tag and keep only a leading version core.
 * Returns null for anything that isn't at least `N` — a tag we can't read must
 * not silently compare as 0.0.0 and claim an update.
 */
export function parseTag(tag: string): string | null {
  const m = /^v?(\d+(?:\.\d+)*)/.exec(tag.trim());
  return m ? m[1] : null;
}

/**
 * Numeric dotted-version compare: negative when `a` is older, 0 when equal,
 * positive when `a` is newer. Missing segments count as 0, so "0.6" === "0.6.0",
 * and each segment compares as a number so 0.10.0 correctly beats 0.9.0 (a
 * string compare would get that backwards).
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0; // unreadable → treat as equal
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Decide the result from a release tag and the running version. Returns null
 * when the tag is unreadable, so the caller reports "couldn't check" rather
 * than inventing a comparison.
 */
export function evaluateUpdate(tag: string, running: string): UpdateCheck | null {
  const latest = parseTag(tag);
  if (!latest) return null;
  const current = parseTag(running);
  if (!current) return null;
  return { latest, newer: compareVersions(latest, current) > 0 };
}
