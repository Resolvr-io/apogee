// Celestial backdrop rendered once behind the whole side panel: night-sky
// gradient → star canvas → moon (masked photo + halo + bright core) → blue
// horizon glow → moonlit ocean pinned at the bottom. The ocean is the animated
// mp4 (OceanVideo, with a loop-seam crossfade) by default, or the static poster
// JPG when the "Animations" setting is off. While animated, occasional
// shooting stars streak the upper sky (ShootingStars). Purely decorative.
//
// `intro` drives the one-time first-run cinematic (see useMoonIntro in App.tsx
// and the .apogee-scene--intro rules in theme.css): "hold" parks the moon above
// the panel while the played-once flag is read, "play" runs the descend-and-
// reveal timeline once. The phase is owned by App, not latched here, so the
// debug control can replay it; `onIntroEnd` reports the timeline's end and App
// drops the phase. Every fill state ends on the static styles, so the swap is
// invisible.

import { Starfield } from "./Starfield";
import { INTRO_CONTENT_IN_MS, INTRO_METEOR_LEAD_MS } from "@/sidepanel/scene-scroll";
import { ShootingStars } from "./ShootingStars";
import { OceanVideo } from "./OceanVideo";

export type SceneIntro = "hold" | "play" | false;

export function Scene({
  animated = true,
  intro = false,
  onIntroEnd,
}: {
  animated?: boolean;
  intro?: SceneIntro;
  onIntroEnd?: () => void;
}) {
  const sceneClass =
    intro === "play"
      ? "apogee-scene apogee-scene--intro"
      : intro === "hold"
        ? "apogee-scene apogee-scene--intro-hold"
        : "apogee-scene";
  return (
    <div className={sceneClass} aria-hidden="true">
      <div className="apogee-sky" />
      <Starfield />
      {/* Keyed on the phase so the timer starts when "play" does, not at mount:
          the hold runs for however long the panel takes to load, so a delay
          measured from mount would land anywhere. Remounting also clears any
          meteor in flight, which at the intro's start is none. */}
      {animated && (
        <ShootingStars
          key={intro === "play" ? "intro" : "ambient"}
          firstSpawnMs={
            intro === "play" ? INTRO_CONTENT_IN_MS - INTRO_METEOR_LEAD_MS : undefined
          }
        />
      )}
      <div className="apogee-glow" />
      <div className="apogee-moon">
        <div className="apogee-moon-halo" />
        <img className="apogee-moon-img" src="/scene/moon-photo.jpg" alt="" />
        <div className="apogee-moon-core" />
      </div>
      {animated ? <OceanVideo /> : <div className="apogee-ocean" />}
      {/* Scroll-away water dim (see .apogee-scroll-dim in theme.css and
          scene-scroll.ts): as the history list scrolls the moon off the top,
          the sea dims and the horizon glow dies with it. Driven by the
          --scene-recede var, invisible at rest, and unconnected to the intro's
          dim element above. */}
      <div className="apogee-scroll-dim" />
      {/* The water dim finishes last (2.3s delay + 2.8s = 5.1s, against the
          moon's 5.0s and the UI's 4.8s), so its end is the timeline's end.
          KEEP IN SYNC with the timeline in theme.css and MOON_INTRO_MS in
          App.tsx, whose fallback timer covers an animationend that never
          arrives. A reduced-motion user is resolved to no phase at init, and any
          phase is ended mid-flight if the preference turns on — so `intro` is
          false and this node does not render for them, EXCEPT across the frames
          between the query matching and that listener committing. An interrupted
          animation can still swallow the event — killing a running animation
          fires `animationcancel`, not `animationend` — which is what the
          fallback is actually for. */}
      {intro && (
        <div className="apogee-intro-dim" onAnimationEnd={() => onIntroEnd?.()} />
      )}
    </div>
  );
}
