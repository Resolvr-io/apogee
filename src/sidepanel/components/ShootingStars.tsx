// Occasional shooting stars for the lock/intro sky. A dedicated canvas on a
// continuous rAF loop, mounted only while the animated backdrop is shown (locked
// + Animations on — see Scene). A meteor streaks the upper sky roughly
// every 9–25s, on a shallow downward diagonal, fading in and out. The base
// Starfield only redraws on scroll, so meteors live on their own layer here.
// Meteor logic mirrors the Astrolabe site's starfield.

import { useEffect, useRef } from "react";

// Vertical bounds for the meteor layer, as fractions of the panel height. The
// fade itself is the `.apogee-meteors` mask in theme.css — these MUST match its
// gradient stops (currently `#000 34%, transparent 58%`): FADE_END is where a
// meteor is fully invisible, so it's also where one can be retired without
// clipping anything the user can still see. The waterline (.apogee-ocean) starts
// at 72%, so a meteor is gone well before the horizon.
const FADE_START = 0.34;
const FADE_END = 0.58;
// Spawn strictly above FADE_START so no meteor is born already fading. Leaves
// most of the band ahead of it to streak through.
const SPAWN_BAND = FADE_START * 0.7; // ≈ top 24%

type Meteor = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  len: number;
  life: number;
  max: number;
  size: number; // trail width + head radius scale
  bright: number; // peak alpha
};

export function ShootingStars({ firstSpawnMs }: { firstSpawnMs?: number } = {}) {
  const ref = useRef<HTMLCanvasElement>(null);
  // Read through a ref so changing it cannot restart the rAF loop; the loop
  // reads it only when arming the first spawn.
  const firstSpawn = useRef(firstSpawnMs);
  firstSpawn.current = firstSpawnMs;

  useEffect(() => {
    const canvas = ref.current;
    const parent = canvas?.parentElement;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !parent || !ctx) return;

    let w = 0;
    let h = 0;
    let raf = 0;
    let meteors: Meteor[] = [];
    let nextAt = 0; // performance.now() timestamp for the next spawn
    let lastT = 0; // performance.now() timestamp of the last tick

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
    };

    // Spawn a meteor in the upper sky, angling left or right on a shallow descent.
    const spawn = () => {
      const dir = Math.random() < 0.5 ? 1 : -1;
      const sp = 10 + Math.random() * 7;
      const sx = dir > 0 ? Math.random() * w * 0.45 : w * 0.55 + Math.random() * w * 0.45;
      // Born above FADE_START, so a meteor is never half-faded at birth.
      const sy = Math.random() * h * SPAWN_BAND;
      const life = 34 + Math.random() * 18;
      // Vary each meteor so the sky isn't uniform: some are faint thin slivers,
      // others bright and bold with a correspondingly longer trail.
      const size = 1 + Math.random() * 1.4; // ~1.0–2.4
      const bright = 0.5 + Math.random() * 0.45; // peak alpha ~0.5–0.95
      meteors.push({
        x: sx,
        y: sy,
        vx: dir * sp * (0.78 + Math.random() * 0.16),
        vy: sp * (0.42 + Math.random() * 0.22),
        len: (80 + Math.random() * 70) * (0.7 + size * 0.2),
        life,
        max: life,
        size,
        bright,
      });
    };

    const frame = () => {
      const now = performance.now();
      if (lastT === 0) lastT = now;
      // Equivalent frames elapsed since the last tick, at the ~60fps the speed/
      // life constants below assume. A hidden/occluded panel can have rAF
      // throttled or paused for a long stretch while performance.now() keeps
      // advancing regardless — scaling movement and decay by elapsed time
      // (instead of a fixed amount per call) keeps a meteor's real-world
      // lifespan correct. Otherwise it barely decays while throttled, several
      // spawn and pile up unseen (spawn timing below is wall-clock based), and
      // they'd all render at once on the first frame after the panel is
      // foregrounded again.
      const steps = (now - lastT) / (1000 / 60);
      lastT = now;
      ctx.clearRect(0, 0, w, h);
      ctx.lineCap = "round";
      for (let i = meteors.length - 1; i >= 0; i--) {
        const m = meteors[i];
        m.x += m.vx * steps;
        m.y += m.vy * steps;
        m.life -= steps;
        const sp = Math.hypot(m.vx, m.vy) || 1;
        const tx = m.x - (m.vx / sp) * m.len;
        const ty = m.y - (m.vy / sp) * m.len;
        // Retire on the TAIL, never the head, on BOTH axes. The head leads the
        // travel, so dropping a meteor the moment the head passes a bound cuts a
        // trail that is still on-screen at full opacity — a trail runs up to
        // ~160px behind the head, far more than the 60px buffer. Testing the tail
        // instead means the whole streak is past the bound before it goes: below
        // the mask's transparent stop (vertically, so alpha is already zero), or
        // fully off-canvas (horizontally). Either way it ends by fading or by
        // being genuinely gone, never by being clipped mid-trail.
        if (m.life <= 0 || tx < -60 || tx > w + 60 || ty > h * FADE_END) {
          meteors.splice(i, 1);
          continue;
        }
        const a = Math.sin((1 - m.life / m.max) * Math.PI) * m.bright; // ease in/out
        const grad = ctx.createLinearGradient(m.x, m.y, tx, ty);
        grad.addColorStop(0, `rgba(220,232,255,${a})`);
        grad.addColorStop(1, "rgba(220,232,255,0)");
        ctx.strokeStyle = grad;
        ctx.lineWidth = m.size;
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        ctx.fillStyle = `rgba(255,255,255,${a})`;
        ctx.beginPath();
        ctx.arc(m.x, m.y, 0.6 + m.size * 0.45, 0, Math.PI * 2);
        ctx.fill();
      }
      // Kept wall-clock based (a throttled panel should still get roughly one
      // meteor per real 9–25s window) — but applied after the update loop
      // above, so a meteor spawned on a resume tick (where `steps` can be
      // large) isn't immediately killed by that same tick's decrement.
      if (nextAt === 0) {
        // The intro asks for a specific first meteor so one is always crossing
        // the sky as the logo arrives; everywhere else the first is random in a
        // 2.5-5s window. Subsequent spawns are random either way.
        nextAt = now + (firstSpawn.current ?? 2500 + Math.random() * 2500);
      } else if (now >= nextAt) {
        spawn();
        nextAt = now + 9000 + Math.random() * 16000; // then every ~9–25s
      }
      raf = requestAnimationFrame(frame);
    };

    // Respect the OS reduced-motion preference (as the scene's other motion does):
    // no rAF loop while it's set, and stop/start if the setting flips at runtime.
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const start = () => {
      if (!raf && !reduce.matches) raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      meteors = [];
      // Reset so a restart behaves like a fresh mount: otherwise nextAt is
      // already in the past (an immediate meteor instead of the usual 2.5–5s
      // lead-in) and lastT is stale (one large, harmless `steps` on resume).
      lastT = 0;
      nextAt = 0;
      if (w && h) ctx.clearRect(0, 0, w, h);
    };
    const onReduceChange = () => (reduce.matches ? stop() : start());

    build();
    start();
    reduce.addEventListener("change", onReduceChange);
    const ro = new ResizeObserver(() => build());
    ro.observe(parent);
    return () => {
      stop();
      reduce.removeEventListener("change", onReduceChange);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={ref} className="apogee-meteors" aria-hidden="true" />;
}
