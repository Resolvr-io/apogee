// Static celestial backdrop rendered once behind the whole side panel:
// night-sky gradient → star canvas → moon (masked photo + halo + bright core)
// → blue horizon glow → moonlit ocean pinned at the bottom. The moonlight
// reflection in the ocean lines up under the centered moon. Purely decorative.

import { Starfield } from "./Starfield";

export function Scene() {
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
      <div className="apogee-ocean" />
    </div>
  );
}
