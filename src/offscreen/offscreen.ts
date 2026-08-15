// Chrome offscreen document — the engine host on Chrome. The MV3 service worker
// is ephemeral and CSP-restricted, so the wasm wallet engine runs here in a
// persistent offscreen page. (Firefox has no offscreen API — there the background
// event page imports the same core and calls `handle` in-process.)
//
// The service worker drives the engine over a dedicated runtime.connect port,
// NOT broadcast runtime.sendMessage: engine requests carry the unlocked mnemonic
// (sign/derive/restore), and an untargeted sendMessage fans out to every
// extension context — side panel, prompt, signing tabs — so any stray listener
// or page XSS would receive signing material on every send. A port is
// point-to-point: only the two connected ends see the frames.
import { browser } from "@/lib/ext";
import { handle } from "@/engine/engine-core";
import type { EnginePortMessage, EngineRequest } from "@/engine/protocol";

const PORT_NAME = "apogee-engine";
// The service worker is routinely evicted (MV3), which tears the port down. This
// side reconnects on a short cadence; connecting wakes the worker, so the next
// engine call finds the port already re-established.
const RECONNECT_MS = 250;

function connect(): void {
  const port = browser.runtime.connect({ name: PORT_NAME });
  port.onMessage.addListener((msg: unknown) => {
    const { id, req } = msg as EnginePortMessage;
    handle(req as EngineRequest)
      .then((value) => port.postMessage({ id, ok: true, value }))
      .catch((err: unknown) => port.postMessage({ id, ok: false, error: errMsg(err) }));
  });
  port.onDisconnect.addListener(() => {
    setTimeout(connect, RECONNECT_MS);
  });
}

console.log("[apogee] offscreen ready");
connect();

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
