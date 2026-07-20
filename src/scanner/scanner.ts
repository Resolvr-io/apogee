// Standalone QR scanner, opened in a popup window from the side panel. MV3 side
// panels can't surface the camera permission prompt; a normal extension window
// can. On a successful scan it messages the value back to the side panel
// (apogee/qr-result) and closes.

import { browser } from "@/lib/ext";

type BarcodeDetectorCtor = new (opts: { formats: string[] }) => {
  detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>;
};

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

const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;

async function start(): Promise<void> {
  if (!Detector) {
    status.textContent = "QR scanning isn't supported in this browser.";
    return;
  }
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
  status.textContent = "Point the camera at a QR code";
  const detector = new Detector({ formats: ["qr_code"] });
  const tick = async () => {
    try {
      const codes = await detector.detect(video);
      if (codes.length > 0 && codes[0]?.rawValue) {
        browser.runtime.sendMessage({ type: "apogee/qr-result", value: codes[0].rawValue });
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
