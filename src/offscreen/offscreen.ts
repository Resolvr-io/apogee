// Offscreen document — the engine host. The MV3 service worker is ephemeral and
// CSP-restricted, so the wasm wallet engine runs here in a persistent offscreen
// page; this adapter relays requests to the shared engine core's `handle()`.
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
//
// Deliberate consequence: while the offscreen document lives (the whole browser
// session, from the first engine call), an open port keeps the SW alive or
// resurrects it within the reconnect delay — no cold starts, at the cost of the
// worker's resident memory for the session. Secret lifetime is unaffected: the
// unwrapping key already lives in storage.session and survives eviction anyway.
const RECONNECT_MS = 250;
// Backoff when reconnects keep failing (worker failing to start, extension
// mid-reload): a fixed 250ms cadence against a dead worker spins hard while
// logging "Unchecked runtime.lastError" every attempt. Doubled per consecutive
// failure, reset once a connection serves a message.
const RECONNECT_MAX_MS = 5_000;
let reconnectDelay = RECONNECT_MS;

function connect(): void {
  const port = browser.runtime.connect({ name: PORT_NAME });
  port.onMessage.addListener((msg: unknown) => {
    reconnectDelay = RECONNECT_MS; // a live, serving connection — reset the backoff
    const { id, req } = msg as EnginePortMessage;
    handle(req as EngineRequest)
      .then((value) => port.postMessage({ id, ok: true, value }))
      .catch((err: unknown) => port.postMessage({ id, ok: false, error: errMsg(err) }));
  });
  port.onDisconnect.addListener(() => {
    // Read it so a failed connect doesn't log "Unchecked runtime.lastError".
    void browser.runtime.lastError;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(RECONNECT_MAX_MS, reconnectDelay * 2);
    setTimeout(connect, delay);
  });
}

console.log("[apogee] offscreen ready");
// Engine requests arrive over the dedicated port only — the broadcast listener
// this file used to carry was removed with the port rewrite, which is also what
// retired the co-installed-extension sender gate on it.
connect();

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
