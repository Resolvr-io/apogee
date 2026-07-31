// Shared asset icon: bundled artwork (instant), a registry-fetched icon (async,
// cached), or a monogram disc fallback (first letter of the label). Used by the
// token list and the Send asset picker.

import { useEffect, useState } from "react";
import type { LiquidNetwork } from "@/keystore/keystore";
import { BUNDLED_ASSET_ICONS, assetIconSrc } from "@/lib/asset-icons";

export function AssetIcon({
  assetId,
  label,
  network,
  size = "size-5",
  textSize = "text-[10px]",
}: {
  assetId: string;
  label: string;
  network: LiquidNetwork;
  size?: string;
  // The monogram fallback's glyph, sized separately from the disc. Without this
  // the letter stays 10px however large `size` gets: on a 32px disc that fills
  // 31% against the ~50% of a 20px disc, so the fallback reads visibly emptier
  // than the real icons beside it. Callers that enlarge `size` should raise this
  // too. Assets with no bundled or registry icon are exactly the ones that land
  // here, so it is the likely path in any list of unknown tokens.
  textSize?: string;
}) {
  const [src, setSrc] = useState<string | null>(() => BUNDLED_ASSET_ICONS[assetId] ?? null);
  useEffect(() => {
    let alive = true;
    void assetIconSrc(assetId, network).then((s) => {
      if (alive) setSrc(s);
    });
    return () => {
      alive = false;
    };
  }, [assetId, network]);
  return src ? (
    <img src={src} alt="" className={`${size} shrink-0 rounded-full`} />
  ) : (
    <span
      className={`flex ${size} shrink-0 items-center justify-center rounded-full border border-[color:var(--border-hover)] bg-[color:var(--accent-soft)] ${textSize} font-semibold text-[color:var(--accent-strong)]`}
    >
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}
