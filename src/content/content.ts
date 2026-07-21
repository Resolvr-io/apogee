// Content script (ISOLATED world). Bridges the MAIN-world page provider
// (window.apogee) to the service worker: it receives postMessage requests from
// the provider, relays them to the background via browser.runtime, and posts the
// reply back. The ISOLATED world is the only one of the two that can reach
// browser.runtime, so this hop is required.
//
// Per-site approval routing (connect/sign prompts) lands in a follow-up; for now
// the bridge forwards the small set of provider methods straight through.

import { browser } from "@/lib/ext";

const PROVIDER_METHODS = new Set([
  "connect",
  "disconnect",
  "getAccount",
  "getStatus",
  "getNewAddress",
  "getBalance",
  "getAssetInfo",
  "send",
]);

interface ProviderMessage {
  source: "apogee-provider";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

function isProviderMessage(data: unknown): data is ProviderMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { source?: unknown }).source === "apogee-provider" &&
    typeof (data as { id?: unknown }).id === "string" &&
    typeof (data as { method?: unknown }).method === "string"
  );
}

function reply(id: string, body: { ok: true; value: unknown } | { ok: false; error: string }): void {
  // "*" (not window.origin) so this same-window reply still delivers in sandboxed/
  // opaque-origin frames; the provider gates inbound on event.source === window.
  window.postMessage({ source: "apogee-content", id, ...body }, "*");
}

window.addEventListener("message", (event) => {
  // Only accept messages from this same window (the page provider).
  if (event.source !== window) return;
  const data = event.data;
  if (!isProviderMessage(data)) return;

  const { id, method, params } = data;

  // If the extension was reloaded/updated, this already-injected content script
  // is orphaned: browser.runtime is invalidated and can never reach the (new)
  // service worker. Signal the page to reload instead of letting the request
  // hang — only a fresh page load re-injects a working bridge.
  if (!browser.runtime?.id) {
    reply(id, { ok: false, error: "PROVIDER_DISCONNECTED" });
    return;
  }

  if (!PROVIDER_METHODS.has(method)) {
    reply(id, { ok: false, error: `Unknown method: ${method}` });
    return;
  }

  // Never let page-supplied params decide routing. Previously params was spread
  // AFTER `type`, so a page could set params.type = "wallet/reset" (etc.) and
  // reach privileged service-worker handlers straight through the bridge. Copy
  // only real fields (dropping any `type`/`source`) and pin `type` last so
  // `provider/<method>` always wins. The service worker also authenticates the
  // sender origin, so wallet/* and apogee/* are unreachable from here regardless.
  const safeParams: Record<string, unknown> = {};
  if (params && typeof params === "object" && !Array.isArray(params)) {
    for (const [k, v] of Object.entries(params)) {
      if (k !== "type" && k !== "source") safeParams[k] = v;
    }
  }

  browser.runtime
    .sendMessage({ ...safeParams, type: `provider/${method}` })
    .then((res: { ok: true; value: unknown } | { ok: false; error: string } | undefined) => {
      reply(id, res ?? { ok: false, error: "No response from Apogee" });
    })
    .catch((err: unknown) => {
      // A reloaded/updated extension invalidates this bridge mid-flight; surface
      // it as PROVIDER_DISCONNECTED so the page can prompt a reload.
      const message = err instanceof Error ? err.message : String(err);
      const orphaned =
        !browser.runtime?.id || /context invalidated|Receiving end does not exist/i.test(message);
      reply(id, { ok: false, error: orphaned ? "PROVIDER_DISCONNECTED" : message });
    });
});

console.debug("[apogee] content bridge ready");
