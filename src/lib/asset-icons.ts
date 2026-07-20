// Asset icons for the token list. USDt ships bundled (instant, offline); other
// assets resolve at runtime from liquid.network's asset-icon endpoint
// (mempool's open-source Liquid instance, serving the public asset registry's
// artwork) and are cached as data-URIs in chrome.storage.local. Lookup failures
// are remembered in-memory only, so an icon registered later can still surface
// after a panel restart.

import type { LiquidNetwork } from "@/keystore/keystore";
import { LBTC_MAINNET_ASSET_ID, LBTC_TESTNET_ASSET_ID, USDT_LIQUID_ASSET_ID } from "@/lib/asset-registry";

export const BUNDLED_ASSET_ICONS: Record<string, string> = {
  [LBTC_MAINNET_ASSET_ID]: "/icons/assets/lbtc.svg",
  [LBTC_TESTNET_ASSET_ID]: "/icons/assets/lbtc.svg",
  [USDT_LIQUID_ASSET_ID]: "/icons/assets/usdt.png",
};

const ICON_API: Record<LiquidNetwork, string | null> = {
  liquid: "https://liquid.network/api/v1/asset",
  liquidtestnet: "https://liquid.network/liquidtestnet/api/v1/asset",
  regtest: null,
};

const CACHE_PREFIX = "apogee:asseticon:";
const failed = new Set<string>(); // in-memory negative cache (session only)

/** Icon source for an asset: bundled path, cached/fetched data-URI, or null
 *  (caller renders a monogram fallback). */
export async function assetIconSrc(
  assetId: string,
  network: LiquidNetwork,
): Promise<string | null> {
  const bundled = BUNDLED_ASSET_ICONS[assetId];
  if (bundled) return bundled;
  if (!/^[0-9a-f]{64}$/i.test(assetId) || failed.has(assetId)) return null;
  const key = CACHE_PREFIX + assetId;
  const cached = (await chrome.storage.local.get(key))[key];
  if (typeof cached === "string") return cached;
  const base = ICON_API[network];
  if (!base) return null;
  try {
    const res = await fetch(`${base}/${assetId}/icon`);
    if (!res.ok) throw new Error(`${res.status}`);
    const blob = await res.blob();
    // Sanity: only cache actual, reasonably-sized images.
    if (!blob.type.startsWith("image/") || blob.size > 200_000) throw new Error("not an icon");
    const dataUri = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error ?? new Error("icon read failed"));
      r.readAsDataURL(blob);
    });
    await chrome.storage.local.set({ [key]: dataUri });
    return dataUri;
  } catch {
    failed.add(assetId);
    return null;
  }
}
