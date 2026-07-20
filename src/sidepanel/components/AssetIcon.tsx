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
}: {
  assetId: string;
  label: string;
  network: LiquidNetwork;
  size?: string;
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
      className={`flex ${size} shrink-0 items-center justify-center rounded-full border border-[color:var(--border-hover)] bg-[color:var(--accent-soft)] text-[10px] font-semibold text-[color:var(--accent-strong)]`}
    >
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}
