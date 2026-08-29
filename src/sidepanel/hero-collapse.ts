// The hero collapse — scrolling the activity list minimizes the balance frame:
// the rate bar, the Send/Swap/Receive row and the eye/sync row fold away and the
// figure shrinks, handing the list that space. The fold is eased in CSS
// (`.apogee-hero-frame`); this module owns the state and the bookkeeping that
// keeps it from fighting the scroll.
//
// Three mechanics make that safe:
//
//   1. A one-pixel sentinel plus an IntersectionObserver, never a scroll
//      listener reading scrollTop. Collapsing resizes the list viewport, so a
//      scrollTop threshold would read a value the collapse itself perturbs. The
//      sentinel depends only on the viewport's TOP edge, which never moves.
//
//   2. A foot spacer carrying only as much of the fold as the scroll geometry
//      needs (see spacerHeight). Without it, collapsing shortens the page, the
//      scroll clamps, and on a short list the clamped scrollTop pops the
//      sentinel back into view — collapse, expand, collapse, a bounce the user
//      can't scroll out of. With too much of it, a blank band trails the last
//      row.
//
//   3. The spacer tracks the frame height frame-by-frame through the ~300ms
//      transition, because a spacer holding still would reopen the clamp bounce
//      for the whole animation. It's written imperatively from the frame's
//      ResizeObserver, so the fold costs zero renders of the Wallet tree.

import { useEffect, useRef, useState } from "react";

/** How far past the top the scroll goes before the hero compacts. The sentinel
 *  sits inside the list's pt-10 feather ramp, so the effective distance is this
 *  plus the ramp — enough to read as "committed to the list", not a twitch. */
const COLLAPSE_MARGIN_PX = 48;

/** Where the fold actually fires: the observer margin, the 40px feather ramp,
 *  and the sentinel. Both mode transitions happen at this offset and nowhere
 *  else, so it's the bottom distance the foot spacer ever has to guarantee.
 *
 *  Exported because scene-scroll's moon dead zone is this same fact — the moon
 *  leaves in lockstep with the fold, so the two must not drift. */
export const COLLAPSE_THRESHOLD_PX = COLLAPSE_MARGIN_PX + 40 + 1;

/** When a height can be trusted as settled. Mirrors --hero-collapse-ms (300ms)
 *  in theme.css plus slack. */
const SETTLE_MS = 400;

/** The frame's height in each mode, as last measured. `null` until the frame has
 *  laid out in that mode at least once. */
export type CollapseHeights = { expanded: number | null; compact: number | null };

/** Record a measured height under the mode it was taken in. Only the matching
 *  slot is written, so a late measurement for the other mode — the resize the
 *  mode flip itself causes — can't poison the delta. Equal values return the
 *  same object, keeping state identity stable across per-layout observer fires. */
export function observedHeights(
  h: CollapseHeights,
  compact: boolean,
  height: number,
): CollapseHeights {
  const slot = compact ? "compact" : "expanded";
  return h[slot] === height ? h : { ...h, [slot]: height };
}

/** What the foot spacer should measure: only as much of the fold as the scroll
 *  geometry needs.
 *
 *  A transition fires at COLLAPSE_THRESHOLD_PX, so no spacer is needed at all as
 *  long as the list's natural range — its scrollable distance with no spacer and
 *  the frame expanded — reaches threshold + fold. Beyond that the spacer is pure
 *  visual cost. Clamping to `threshold + fold − naturalRange` gives zero for any
 *  list long enough to scroll meaningfully and just-enough on short ones.
 *
 *  `naturalRange: null` means the geometry can't be read — fall back to the full
 *  fold, the safe-but-gappy answer. */
export function spacerHeight(
  h: CollapseHeights,
  compact: boolean,
  naturalRange: number | null,
): number {
  if (!compact || h.expanded == null) return 0;
  // Unmeasured compact assumes the worst case (folds to nothing) rather than
  // zero: an under-sized spacer before the first compact measurement is the
  // clamp bounce.
  const fold = h.compact == null ? h.expanded : Math.max(0, h.expanded - h.compact);
  if (naturalRange == null) return fold;
  return Math.max(0, Math.min(fold, COLLAPSE_THRESHOLD_PX + fold - naturalRange));
}

/**
 * Drives the hero collapse for the Wallet home view. Attach `sentinelRef` to a
 * one-pixel div as the list's FIRST child, `frameRef` to the balance frame, and
 * `spacerRef` to a div at the list's foot — its height is written imperatively,
 * so it renders with no inline style of its own.
 *
 * `active` must be true exactly while that DOM is mounted. Wallet stays mounted
 * across views, so every trip to Settings/Send/Receive detaches the sentinel and
 * mounts a fresh one on return. The detach alone delivers an
 * `isIntersecting: false` that would latch `compact` on; worse, an observer keyed
 * on the stable refs would keep watching the dead sentinel and never see the new
 * one, leaving the hero stuck compact with nothing able to flip it back.
 *
 * Heights come from a ResizeObserver rather than the class math: the expanded
 * height isn't fixed (the chart opens, the subtitle wraps away), and a stale
 * delta would under-size the spacer and reopen the bounce.
 */
export function useHeroCollapse(
  listRef: React.RefObject<HTMLDivElement | null>,
  active: boolean,
): {
  compact: boolean;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  frameRef: React.RefObject<HTMLDivElement | null>;
  spacerRef: React.RefObject<HTMLDivElement | null>;
} {
  const [compact, setCompact] = useState(false);
  const heightsRef = useRef<CollapseHeights>({ expanded: null, compact: null });
  const sentinelRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);

  // Assigned during render so the ResizeObserver callback — which only runs
  // post-layout, after the commit that flipped the mode — sees the current
  // value. An effect-assigned ref could land after the entry it is meant to
  // label.
  const compactRef = useRef(false);
  compactRef.current = compact;

  const writeSpacer = (compactNow: boolean) => {
    const spacer = spacerRef.current;
    if (!spacer) return;
    const list = listRef.current;
    const frame = frameRef.current;
    if (!list || !frame) {
      spacer.style.height = "0px";
      return;
    }
    // Measured live rather than derived: content grows with every paged-in
    // batch, and a stale range leaves a gap behind once the list passes the
    // threshold. The forced layout is free — every caller already runs
    // post-layout.
    const written = spacer.offsetHeight;
    const contentNatural = list.scrollHeight - written;
    const expandedH = heightsRef.current.expanded ?? frame.offsetHeight;
    const viewportExpanded = list.clientHeight + expandedH - frame.offsetHeight;
    const naturalRange = contentNatural - viewportExpanded;
    spacer.style.height = `${Math.round(
      spacerHeight(heightsRef.current, compactNow, naturalRange),
    )}px`;
  };

  // Ahead of any observer fire: on the FIRST collapse the compact height has
  // never been measured, and this applies the over-compensation in the same
  // layout as the fold's first frame rather than one late.
  useEffect(() => {
    writeSpacer(compact);
  }, [compact]);

  // While the home DOM is away the hero can't be compact — the remounted list
  // starts at scrollTop 0. Doing it here rather than trusting the fresh
  // observer's initial entry also spares a painted frame of stale-compact home.
  useEffect(() => {
    if (!active) setCompact(false);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const sentinel = sentinelRef.current;
    const root = listRef.current;
    if (!sentinel || !root || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        // Positive rootMargin grows the window upward, so the sentinel counts as
        // visible until it is COLLAPSE_MARGIN_PX above the viewport — hysteresis
        // for free.
        setCompact(!entries[0].isIntersecting);
      },
      { root, rootMargin: `${COLLAPSE_MARGIN_PX}px 0px 0px 0px`, threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [listRef, active]);

  useEffect(() => {
    if (!active) return;
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === "undefined") return;
    let settle: number | null = null;
    const ro = new ResizeObserver(() => {
      // Border-box, not the entry's contentRect: padding is PART of the collapse
      // (pt-6 → pt-2), and mixing boxes skews the delta by exactly the padding
      // change, over-compensating the spacer forever after.
      heightsRef.current = observedHeights(heightsRef.current, compactRef.current, frame.offsetHeight);
      writeSpacer(compactRef.current);
      // Re-read after the transition so each mode's RESTING height persists. A
      // mid-animation fire that happened to be the last one (an interrupted
      // expand) would otherwise leave a short "expanded" height behind and
      // under-size every collapse until the next full expand settles.
      if (settle != null) window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        settle = null;
        heightsRef.current = observedHeights(
          heightsRef.current,
          compactRef.current,
          frame.offsetHeight,
        );
        writeSpacer(compactRef.current);
      }, SETTLE_MS);
    });
    ro.observe(frame);
    return () => {
      if (settle != null) window.clearTimeout(settle);
      ro.disconnect();
    };
  }, [active]);

  return { compact, sentinelRef, frameRef, spacerRef };
}
