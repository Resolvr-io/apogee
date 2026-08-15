// Chrome offscreen document — the engine host on Chrome. The MV3 service worker
// is ephemeral and CSP-restricted, so the wasm wallet engine runs here in a
// persistent offscreen page. The service worker drives it over browser.runtime
// messages tagged `target: "offscreen"`; this adapter relays them to the shared
// engine core's `handle()`. (Firefox has no offscreen API — there the background
// event page imports the same core and calls `handle` in-process.)
import { browser } from "@/lib/ext";
import { handle } from "@/engine/engine-core";
import type { EngineRequest } from "@/engine/protocol";

console.log("[apogee] offscreen ready");

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;
  // The engine will sign and broadcast with whatever the request carries, so
  // only this extension may reach it — a co-installed extension can message us
  // directly by id. Mirrors the sender gate in the background router.
  if (sender.id !== browser.runtime.id) return false;
  handle(msg.req as EngineRequest)
    .then((value) => sendResponse({ ok: true, value }))
    .catch((err: unknown) => sendResponse({ ok: false, error: errMsg(err) }));
  return true; // async sendResponse
});

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
