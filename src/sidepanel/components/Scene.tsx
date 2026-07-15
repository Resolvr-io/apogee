// Celestial backdrop rendered once behind the whole side panel: night-sky
// gradient → star canvas → moon (masked photo + halo + bright core) → blue
// horizon glow → moonlit ocean pinned at the bottom. The ocean is the animated
// mp4 (OceanVideo, with a loop-seam crossfade) by default, or the static poster
// JPG when the "Background animation" setting is off. Purely decorative.

import { Starfield } from "./Starfield";
import { OceanVideo } from "./OceanVideo";

export function Scene({ animated = true }: { animated?: boolean }) {
  return (
    <div className="apogee-scene" aria-hidden="true">
      <div className="apogee-sky" />
      <Starfield />
      <div className="apogee-glow" />
      <div className="apogee-moon">
        <div className="apogee-moon-halo" />
        <img className="apogee-moon-img" src="/scene/moon-photo.jpg" alt="" />
        <div className="apogee-moon-core" />
      </div>
      {animated ? <OceanVideo /> : <div className="apogee-ocean" />}
    </div>
  );
}
