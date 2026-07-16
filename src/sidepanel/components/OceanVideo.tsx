// Animated moonlit-sea loop for the bottom of the side-panel scene. Ports the
// loop-seam crossfade from astrolabe/apps/www (SeaVideo.tsx) with one change for
// smoothness: instead of cross-dissolving both layers (which dips to the dark
// backing at the midpoint), the incoming layer fades IN ON TOP of the outgoing
// one (which stays opaque until fully covered) — no brightness dip, just a
// gentle occlusion at the seam. An opaque backing still sits behind both so the
// sky can't show through before the first frame, and a bottom-dim overlay
// matches the static poster's footer fade. Rendered only while the "Background
// animation" setting is on — Scene picks this vs the static poster.

import { useEffect, useRef } from "react";

const SRC = "/scene/ocean-waves.mp4";
const POSTER = "/scene/ocean-waves-poster.jpg";
// Crossfade window in seconds — must match the opacity transition on
// .apogee-ocean-layer (see theme.css).
const FADE = 1.5;

export function OceanVideo() {
  const aRef = useRef<HTMLVideoElement>(null);
  const bRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const a = aRef.current;
    const b = bRef.current;
    if (!a) return;
    a.muted = true;

    const play = (v: HTMLVideoElement) => {
      const p = v.play();
      if (p) p.catch(() => {}); // cold-origin autoplay is fine once muted
    };

    // Fallback: a single looping layer if the second element isn't mounted.
    if (!b) {
      a.loop = true;
      play(a);
      a.addEventListener("canplay", () => play(a), { once: true });
      return;
    }

    // Two-layer seam crossfade. The incoming layer is promoted on top (z 2) and
    // faded in over the outgoing one, which stays opaque (z 1) until the fade
    // completes — so the dark backing never shows through at the midpoint.
    b.muted = true;
    let active = a;
    let idle = b;
    let swapping = false;
    let swapTimer: ReturnType<typeof window.setTimeout> | null = null;
    play(active);
    active.addEventListener("canplay", () => play(active), { once: true });

    const onTime = (e: Event) => {
      const v = e.currentTarget as HTMLVideoElement;
      if (v !== active || swapping || !v.duration) return;
      if (v.currentTime < v.duration - FADE) return;
      swapping = true;
      const outgoing = active;
      const incoming = idle;
      incoming.currentTime = 0;
      play(incoming);
      // Promote the incoming layer on top; the outgoing stays opaque beneath it.
      incoming.style.zIndex = "2";
      outgoing.style.zIndex = "1";
      incoming.style.opacity = "1";
      active = incoming;
      idle = outgoing;
      swapTimer = window.setTimeout(() => {
        // Incoming now fully covers the outgoing — hide + reset it for next time.
        outgoing.pause();
        outgoing.currentTime = 0;
        outgoing.style.opacity = "0";
        swapping = false;
      }, FADE * 1000);
    };
    a.addEventListener("timeupdate", onTime);
    b.addEventListener("timeupdate", onTime);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      b.removeEventListener("timeupdate", onTime);
      // A mid-crossfade unmount would otherwise leave the trailing swap timer to
      // fire on detached nodes; cancel it and stop both videos.
      if (swapTimer != null) window.clearTimeout(swapTimer);
      a.pause();
      b.pause();
    };
  }, []);

  return (
    <div className="apogee-ocean apogee-ocean--video">
      {/* opaque backing so the sky can't show through before the first frame */}
      <div className="apogee-sea-bg" />
      <video
        ref={aRef}
        className="apogee-ocean-layer"
        muted
        playsInline
        preload="auto"
        poster={POSTER}
        style={{ opacity: 1, zIndex: 2 }}
      >
        <source src={SRC} type="video/mp4" />
      </video>
      <video
        ref={bRef}
        className="apogee-ocean-layer"
        muted
        playsInline
        preload="auto"
        poster={POSTER}
        style={{ opacity: 0, zIndex: 1 }}
      >
        <source src={SRC} type="video/mp4" />
      </video>
      {/* bottom darkening, matching the static poster's footer fade */}
      <div className="apogee-ocean-dim" />
    </div>
  );
}
