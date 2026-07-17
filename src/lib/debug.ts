// Local debug builds. A gitignored .env.local can bake Blockstream enterprise
// API credentials into a LOCAL build (never commit credentials — anything in a
// distributed bundle is publicly readable). Without .env.local every flag here
// is false, the Debug card never renders, the manifest gains no extra hosts,
// and all enterprise code paths are inert.
//
// The Debug toggle (Settings > Debug, storage key below) routes scans and
// broadcasts to the authenticated enterprise endpoint through the same
// per-network override channel the Chain server setting uses; the offscreen
// document's fetch wrapper attaches the OAuth bearer token.

import type { LiquidNetwork } from "@/keystore/keystore";

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

export const ENTERPRISE_CLIENT_ID = env.VITE_BS_ENTERPRISE_CLIENT_ID;
export const ENTERPRISE_CLIENT_SECRET = env.VITE_BS_ENTERPRISE_CLIENT_SECRET;

/** True only in a local build with credentials baked from .env.local. */
export const DEBUG_ENTERPRISE_BUILD = Boolean(ENTERPRISE_CLIENT_ID && ENTERPRISE_CLIENT_SECRET);

/** chrome.storage.local key for the Debug toggle (boolean). */
export const DEBUG_ENTERPRISE_KEY = "apogee:debug:enterprise";

export const ENTERPRISE_ROOTS: Record<LiquidNetwork, string | null> = {
  liquid: "https://enterprise.blockstream.info/liquid/api",
  liquidtestnet: "https://enterprise.blockstream.info/liquidtestnet/api",
  regtest: null,
};

export const ENTERPRISE_TOKEN_URL =
  "https://login.blockstream.com/realms/blockstream-public/protocol/openid-connect/token";
