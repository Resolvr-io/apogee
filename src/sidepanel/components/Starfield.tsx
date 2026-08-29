// Star canvas for the celestial backdrop. Three depth layers; stars parallax
// (and wrap) against the wallet's scroll so nearer layers drift more than far
// ones. Redraws only while scrolling (rAF-coalesced).

import { useEffect, useRef } from "react";
import { subscribeScene } from "@/sidepanel/scene-scroll";

// `p` is each layer's parallax factor against the scene's scroll offset, and it
// is the ONE place the sky's depth is set: the scroll gesture, a sub-view
// transition and the intro all read it, so a change here changes all three.
//
// Held well below the moon's own travel on purpose. The moon crosses 185px over
// the offset's full 329px range, so the near layer at 0.19 moves about a third
// of that. It used to be 0.55, which put the near layer at 181px — near enough
// to the moon's distance that the sky read as falling with it rather than
// sitting behind it. That was invisible under a scroll the user paces
// themselves, and obvious the moment the intro played it over a bare
// background at a fixed speed.
/**
 * How much of its layer's parallax a star keeps at the very bottom of the
 * panel, tapering linearly from the full amount at the top.
 *
 * Without this every star in a layer moves the same distance whatever its
 * height, and one just above the horizon sweeps as far as one overhead — which
 * reads as the horizon moving too fast, because a real sky's apparent motion
 * falls away toward it. Not zero: the horizon should still drift, or the field
 * looks pinned along its bottom edge.
 *
 * `p` below is therefore the value at the TOP of the panel, not an average.
 */
const HORIZON_DEPTH = 0.15;

const LAYERS = [
  { density: 1 / 7000, r: [0.4, 0.9], a: [0.25, 0.55], p: 0.04 },
  { density: 1 / 18000, r: [0.8, 1.4], a: [0.4, 0.75], p: 0.1 },
  { density: 1 / 48000, r: [1.3, 2.0], a: [0.55, 1.0], p: 0.19 },
];

type Star = { x: number; y: number; r: number; a: number; gold: boolean; p: number };

export function Starfield() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const parent = canvas?.parentElement;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !parent || !ctx) return;

    let w = 0;
    let h = 0;
    let stars: Star[] = [];
    let raf = 0;
    let pendingY = 0;

    const build = () => {
      w = parent.clientWidth;
      h = parent.clientHeight;
      if (w === 0 || h === 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = [];
      for (const layer of LAYERS) {
        const count = Math.round(w * h * layer.density);
        for (let i = 0; i < count; i++) {
          // Hoisted because the parallax factor below is derived from it.
          const y = Math.random() * h;
          stars.push({
            x: Math.random() * w,
            y,
            r: layer.r[0] + Math.random() * (layer.r[1] - layer.r[0]),
            a: layer.a[0] + Math.random() * (layer.a[1] - layer.a[0]),
            gold: Math.random() < 0.12,
            // Fixed from the star's starting height rather than recomputed as it
            // moves: a factor that changed with y would make a single star
            // accelerate as it travelled, which is a worse artifact than the one
            // it fixes. A wrapped star keeps the factor it was born with, and at
            // this travel distance only stars within a few dozen pixels of an
            // edge ever wrap — the bottom of which the mask has already faded.
            p: layer.p * (HORIZON_DEPTH + (1 - HORIZON_DEPTH) * (1 - y / h)),
          });
        }
      }
    };

    const draw = (scrollY: number) => {
      if (w === 0 || h === 0) return;
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        let y = s.y - scrollY * s.p;
        y = ((y % h) + h) % h; // wrap for an endless field
        ctx.beginPath();
        ctx.arc(s.x, y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = s.gold ? `rgba(176,206,255,${s.a})` : `rgba(226,234,250,${s.a})`;
        ctx.fill();
      }
    };

    const onScroll = (scrollY: number) => {
      pendingY = scrollY;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          draw(pendingY);
        });
      }
    };

    build();
    draw(0);
    const unsub = subscribeScene(onScroll);
    const ro = new ResizeObserver(() => {
      build();
      draw(pendingY);
    });
    ro.observe(parent);
    return () => {
      unsub();
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return <canvas ref={ref} className="apogee-starfield" aria-hidden="true" />;
}
