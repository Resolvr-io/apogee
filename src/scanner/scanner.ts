// Standalone QR scanner, opened in a popup window from the side panel. MV3 side
// panels can't surface the camera permission prompt; a normal extension window
// can.
//
// TWO delivery paths, chosen by the `?secret=1` query flag:
//
//   default        — broadcast `apogee/qr-result` to every extension context.
//                    Fine for a payment address (public data).
//   ?secret=1      — hand the value to the SERVICE WORKER via
//                    `apogee/qr-secret`, which parks it for exactly one
//                    `apogee/qr-secret-claim`. Used for seed-phrase import.
//
// Why the split: `runtime.sendMessage` with no target fans out to all extension
// pages, so a broadcast seed phrase would be readable by any other extension
// context that happens to be listening. Today only our own pages exist, so this
// isn't a live vulnerability — but a seed should not be the thing that relies on
// that. The SW path keeps the phrase point-to-point and single-use, and the
// scanner never renders the decoded text on screen in secret mode.

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
            await browser.runtime.sendMessage({ type: "apogee/qr-secret", value });
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
