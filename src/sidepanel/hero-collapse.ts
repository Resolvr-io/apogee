// The hero collapse — scrolling the activity list minimizes the balance frame:
// the rate bar (open chart included), the Send/Swap/Receive row and the eye/sync
// row fold away and the figure shrinks, handing the list the space the summary
// was occupying. Scrolling back to the top restores everything. The fold itself
// is eased in CSS (`.apogee-hero-frame` in theme.css); this module owns the
// state and the bookkeeping that keeps it from fighting the scroll.
//
// Three mechanics make that safe:
//
//   1. Collapse is driven by a one-pixel sentinel at the head of the list
//      content and an IntersectionObserver — never a scroll listener reading
//      scrollTop. Collapsing resizes the list viewport (it is flex-1 under a
//      shrink-0 frame), so a threshold on scrollTop would be reading a value the
//      collapse itself perturbs. The sentinel's visibility depends only on the
//      viewport's TOP edge, which the collapse never moves.
//
//   2. A spacer at the foot of the list carries only as much of the fold as the
//      scroll geometry needs (see spacerHeight). Without it, collapsing
//      shortens the page, the scroll clamps at the new bottom, and on a short
//      list (few transactions) the clamped scrollTop pops the sentinel back
//      into view — collapse, expand, collapse, a bounce the user can never
//      scroll out of. With too much of it, a blank band trails the last row
//      for no mechanical reason.
//
//   3. Because the fold is a ~300ms transition, the spacer has to track the
//      frame height frame-by-frame while it animates — the viewport grows
//      gradually, and a spacer holding still would re-open the clamp bounce
//      continuously throughout the animation. So the spacer is written
//      imperatively from the frame's ResizeObserver (per-fire), not from React
//      state: the whole fold costs zero extra renders of the Wallet tree.

import { useEffect, useRef, useState } from "react";

/** How far past the top the scroll has to go before the hero compacts. The
 *  sentinel sits inside the list's pt-10 feather ramp, so the effective distance
 *  is this plus the ramp — enough that the collapse reads as "you've committed
 *  to the list", not as a twitch on the first drag. */
const COLLAPSE_MARGIN_PX = 48;

/** Where the fold actually fires: the observer margin, the 40px feather ramp
 *  the sentinel sits inside, and the sentinel itself. Both mode transitions
 *  happen at this scroll offset and nowhere else, so it is the bottom distance
 *  the foot spacer ever has to guarantee — the clamp the spacer prevents can
 *  only bite at a transition, and a transition can only happen here.
 *
 *  Exported because scene-scroll.ts's moon dead zone is this same fact: the
 *  moon leaves in lockstep with the fold, so the two must not drift. */
export const COLLAPSE_THRESHOLD_PX = COLLAPSE_MARGIN_PX + 40 + 1;

/** When the fold's transition is over and a height can be trusted as settled.
 *  Mirrors --hero-collapse-ms (300ms) in theme.css plus slack; mid-transition
 *  heights are recorded continuously (they self-correct), but the settle
 *  capture below guarantees each mode's RESTING height lands even if the
 *  observer's last fire was mid-animation. */
const SETTLE_MS = 400;

/** The frame's height in each mode, as last measured. `null` until the frame
 *  has laid out in that mode at least once. */
export type CollapseHeights = { expanded: number | null; compact: number | null };

/** Record a measured frame height under whichever mode it was taken in. Only
 *  the matching slot is written, so a measurement that arrives for the other
 *  mode (the resize that the mode flip itself causes, delivered late) can't
 *  poison the delta. Equal values return the same object — ResizeObserver
 *  callbacks fire per layout pass, and this keeps the state identity stable. */
export function observedHeights(
  h: CollapseHeights,
  compact: boolean,
  height: number,
): CollapseHeights {
  const slot = compact ? "compact" : "expanded";
  return h[slot] === height ? h : { ...h, [slot]: height };
}

/** What the list's foot spacer should measure: only as much of the fold as the
 *  scroll geometry actually needs, never the whole thing.
 *
 *  The spacer prevents the mode transitions from clamping the scroll (see
 *  mechanic 2 above). A transition fires at COLLAPSE_THRESHOLD_PX of scroll,
 *  so it is safe without any spacer as long as the list's natural range — its
 *  scrollable distance with no spacer and the frame expanded — reaches
 *  threshold + fold. Beyond that the spacer is pure visual cost: a blank band
 *  after the last row that no transition can ever be endangered by. So the
 *  spacer is clamped to `threshold + fold − naturalRange`, which is zero for
 *  any list long enough to scroll meaningfully (no gap after the last
 *  transaction) and shrinks toward just-enough on short lists.
 *
 *  `naturalRange: null` means the geometry can't be read (refs missing) — fall
 *  back to the full fold, the safe-but-gappy answer. */
export function spacerHeight(
  h: CollapseHeights,
  compact: boolean,
  naturalRange: number | null,
): number {
  if (!compact || h.expanded == null) return 0;
  // The most the frame can possibly fold by. Unmeasured compact assumes the
  // worst case (collapses to nothing) rather than zero — an under-sized spacer
  // in the gap before the first compact measurement is the clamp bounce.
  const fold = h.compact == null ? h.expanded : Math.max(0, h.expanded - h.compact);
  if (naturalRange == null) return fold;
  return Math.max(0, Math.min(fold, COLLAPSE_THRESHOLD_PX + fold - naturalRange));
}

/**
 * Drives the hero collapse for the Wallet home view. Attach `sentinelRef` to a
 * one-pixel div as the list's FIRST child (inside the scroll container),
 * `frameRef` to the balance frame above it, and `spacerRef` to a div at the
 * list's foot — its height is written imperatively as the frame folds (see
 * mechanic 3 above), so it renders with no inline style of its own.
 *
 * `active` must be true exactly while that DOM is mounted. The Wallet component
 * stays mounted across views — only its home JSX swaps out — so every trip to
 * Settings/Send/Receive detaches the sentinel and mounts a fresh one on return.
 * The detach alone delivers an `isIntersecting: false` entry that would latch
 * `compact` on; worse, an observer keyed on the stable refs would keep watching
 * the dead sentinel and never see the new one, leaving the hero stuck compact
 * with nothing able to flip it back. The flag re-runs the wiring when the home
 * view returns, and resets the latch while it's away.
 *
 * The heights come from a ResizeObserver on the frame rather than being derived
 * from the class math: the expanded height isn't fixed — the chart opens, the
 * subtitle wraps to nothing while hidden — and a stale delta would under-size
 * the spacer and reopen the clamp bounce this exists to prevent.
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

  // Read by the ResizeObserver callback below, which closes over nothing else.
  // Assigned during render so any callback — which only ever runs post-layout,
  // i.e. after the commit that flipped the mode — sees the current value; an
  // effect-assigned ref could land after the resize entry it is meant to label.
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
    // The list's natural range: how far it could scroll with NO spacer and the
    // frame expanded. Measured from the live DOM rather than derived — content
    // grows with every paged-in batch, and a stale range would leave a gap
    // behind after the list grows past the threshold. Costs a forced layout,
    // but every caller runs post-layout (the flip effect after its commit, the
    // resize observer in its own callback).
    const written = spacer.offsetHeight;
    const contentNatural = list.scrollHeight - written;
    const expandedH = heightsRef.current.expanded ?? frame.offsetHeight;
    const viewportExpanded = list.clientHeight + expandedH - frame.offsetHeight;
    const naturalRange = contentNatural - viewportExpanded;
    spacer.style.height = `${Math.round(
      spacerHeight(heightsRef.current, compactNow, naturalRange),
    )}px`;
  };

  // The mode flip writes the spacer immediately, ahead of any observer fire:
  // on the FIRST collapse the compact height has never been measured, and this
  // is what applies the over-compensation (see spacerHeight) in the same layout
  // as the fold's first frame rather than one late.
  useEffect(() => {
    writeSpacer(compact);
  }, [compact]);

  // While the home DOM is away, the hero can't be compact — the remounted list
  // starts at scrollTop 0, so expanded is the correct state to return to. Doing
  // it here rather than trusting the fresh observer's initial entry also spares
  // a first painted frame of stale-compact home.
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
        // Positive rootMargin GROWS the intersection window upward, so the
        // sentinel counts as visible until it is COLLAPSE_MARGIN_PX above the
        // viewport — the observer delivers the hysteresis for free.
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
      // Border-box (offsetHeight), not the entry's contentRect: the content box
      // excludes the frame's own padding, and the padding is PART of the
      // collapse (pt-6 → pt-2) — mixing boxes here skews the delta by exactly
      // the padding change and the spacer over-compensates forever after.
      // Layout is already clean inside a resize callback, so the forced reflow
      // is free.
      heightsRef.current = observedHeights(heightsRef.current, compactRef.current, frame.offsetHeight);
      writeSpacer(compactRef.current);
      // Settle capture: re-read after the fold's transition so each mode's
      // RESTING height is what persists — a mid-animation fire that happened to
      // be the last one (an interrupted expand, say) would otherwise leave a
      // short "expanded" height behind and under-size every collapse until the
      // next full expand settles. One pending capture at a time; the latest
      // reschedule wins, and cleanup cancels a pending capture on unmount.
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
