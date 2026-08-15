// Standalone QR scanner, opened in a popup window from the side panel. MV3 side
// panels can't surface the camera permission prompt; a normal extension window
// can.
//
// TWO delivery paths, chosen by the `?secret=1` query flag:
//
//   default        — broadcast `apogee/qr-result` to every extension context.
//                    Fine for a payment address (public data).
//   ?secret=1      — hand the value to the SERVICE WORKER over the dedicated
//                    `apogee-secret` port as `apogee/qr-secret`, which parks it
//                    for exactly one `apogee/qr-secret-claim`. Used for
//                    seed-phrase import.
//
// Why the split: `runtime.sendMessage` with no target fans out to all extension
// pages, so a broadcast seed phrase would be readable by any other extension
// context that happens to be listening. A runtime.connect port delivers frames
// only to the two connected ends, which is what a seed requires. The SW path
// also keeps the phrase single-use, and the scanner never renders the decoded
// text on screen in secret mode.

import { browser } from "@/lib/ext";
import { createDetector } from "./detect";

/** Seed-phrase mode: deliver via the SW's one-shot channel, never broadcast, and
 *  don't echo the decoded value into the page. */
const SECRET = new URLSearchParams(location.search).get("secret") === "1";

const video = document.getElementById("video") as HTMLVideoElement;
const status = document.getElementById("status") as HTMLElement;
const cancel = document.getElementById("cancel") as HTMLButtonElement;

let stream: MediaStream | null = null;
let raf = 0;

function cleanup(): void {
  if (raf) cancelAnimationFrame(raf);
  stream?.getTracks().forEach((t) => t.stop());
}

/** Hand a scanned seed phrase to the service worker over the point-to-point
 *  `apogee-secret` port. Resolves once the SW has parked it; rejects if the
 *  port drops without a reply (nothing was stored, so retrying is safe). */
function sendSecret(value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const port = browser.runtime.connect({ name: "apogee-secret" });
    const finish = (err?: Error) => {
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      port.disconnect();
      err ? reject(err) : resolve();
    };
    const onMessage = () => finish();
    const onDisconnect = () => finish(new Error("port closed before the scan was stored"));
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    port.postMessage({ type: "apogee/qr-secret", value });
  });
}

cancel.addEventListener("click", () => window.close());
window.addEventListener("pagehide", cleanup);

async function start(): Promise<void> {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  } catch (e) {
    const name = (e as { name?: string }).name;
    status.textContent =
      name === "NotAllowedError"
        ? "Camera access was denied."
        : name === "NotFoundError"
          ? "No camera was found."
          : "Couldn't start the camera.";
    return;
  }
  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    // autoplay may reject; detection still runs once frames arrive
  }
  status.textContent = SECRET
    ? "Point the camera at your seed-phrase QR"
    : "Point the camera at a QR code";
  // Native BarcodeDetector on Chromium; jsQR fallback where it's missing (Firefox).
  const detect = createDetector();
  const tick = async () => {
    try {
      const value = await detect(video);
      if (value) {
        // Await the secret hand-off before closing: the window tearing down mid-send
        // would drop the phrase and look like a scan that silently did nothing.
        if (SECRET) {
          try {
            await sendSecret(value);
          } catch {
            status.textContent = "Couldn't hand off the scan. Close and try again.";
            return; // leave the window open; retrying is safe, the value wasn't stored
          }
        } else {
          browser.runtime.sendMessage({ type: "apogee/qr-result", value });
        }
        cleanup();
        window.close();
        return;
      }
    } catch {
      // transient per-frame detect errors are fine
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

void start();
