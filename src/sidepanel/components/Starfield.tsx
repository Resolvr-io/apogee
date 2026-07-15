// Star canvas for the celestial backdrop. Three depth layers; stars parallax
// (and wrap) against the wallet's scroll so nearer layers drift more than far
// ones. Redraws only while scrolling (rAF-coalesced).

import { useEffect, useRef } from "react";
import { subscribeScene } from "@/sidepanel/scene-scroll";

const LAYERS = [
  { density: 1 / 7000, r: [0.4, 0.9], a: [0.25, 0.55], p: 0.12 },
  { density: 1 / 18000, r: [0.8, 1.4], a: [0.4, 0.75], p: 0.3 },
  { density: 1 / 48000, r: [1.3, 2.0], a: [0.55, 1.0], p: 0.55 },
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
          stars.push({
            x: Math.random() * w,
            y: Math.random() * h,
            r: layer.r[0] + Math.random() * (layer.r[1] - layer.r[0]),
            a: layer.a[0] + Math.random() * (layer.a[1] - layer.a[0]),
            gold: Math.random() < 0.12,
            p: layer.p,
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
