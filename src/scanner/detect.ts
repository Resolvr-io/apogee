// QR detection, with a fallback for platforms that lack the native API.
//
// `BarcodeDetector` (hardware-accelerated, decodes straight from a video element)
// is NOT universally available on Chrome: it ships on Android, macOS and ChromeOS,
// but desktop Windows and Linux have no implementation. Without a fallback the
// scanner dead-ends there with "QR scanning isn't supported in this browser",
// breaking address scanning and seed-phrase import for those users.
//
// So: use the native detector when present, otherwise decode with jsQR (pure JS, no
// Worker and no wasm, so the extension CSP `script-src 'self' 'wasm-unsafe-eval'`
// needs no change). jsQR needs pixels rather than a video element, hence the
// offscreen-canvas draw.
//
// Split out of scanner.ts so the selection logic is unit-testable — scanner.ts
// touches `document` and a live MediaStream at module load.

import jsQR from "jsqr";

/** Minimal shape of the native detector we rely on. */
type BarcodeDetectorCtor = new (opts: { formats: string[] }) => {
  detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>;
};

/** Reads one QR value from a video frame, or null if none is visible. */
export type Detect = (video: HTMLVideoElement) => Promise<string | null>;

/** True when the browser has a usable native `BarcodeDetector`.
 *
 *  Not used in the scan path — `createDetector` branches internally. Kept because
 *  the distinction is worth being able to assert directly, and a caller that wants
 *  to explain WHY it fell back (a UI hint, say) needs it. */
export function hasNativeDetector(win: unknown = globalThis): boolean {
  return typeof (win as { BarcodeDetector?: unknown })?.BarcodeDetector === "function";
}

/** Native path: hand the video element straight to the platform decoder. */
function nativeDetect(Ctor: BarcodeDetectorCtor): Detect {
  const detector = new Ctor({ formats: ["qr_code"] });
  return async (video) => {
    const codes = await detector.detect(video);
    // Trimmed like the jsQR path, so the two backends can't disagree about what
    // counts as a scan: a QR encoding only whitespace is a decode with nothing in
    // it, and delivering it starts a scan that can't succeed.
    const value = codes[0]?.rawValue?.trim();
    return value ? value : null;
  };
}

/** Fallback path: copy the frame to a canvas and decode the pixels with jsQR.
 *
 *  The canvas is created once and reused — allocating one per frame would churn a
 *  full-resolution buffer at animation-frame rate. It's also capped: decoding scales
 *  with pixel count, and jsQR runs on the main thread, so a 1080p camera frame would
 *  make the loop visibly stutter. A QR only needs enough resolution for its modules
 *  to be distinguishable, and ~640px on the long edge is ample for a code held up to
 *  a webcam. */
function jsqrDetect(maxEdge = 640): Detect {
  // Created lazily on the first frame, not at construction: building the detector
  // shouldn't require a DOM, so selection stays testable and a caller that never
  // scans allocates nothing.
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  return async (video) => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    // Frames aren't available until the stream produces one.
    if (vw === 0 || vh === 0) return null;
    if (!canvas) {
      canvas = document.createElement("canvas");
      ctx = canvas.getContext("2d", { willReadFrequently: true });
    }
    if (!ctx) return null;
    const scale = Math.min(1, maxEdge / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.drawImage(video, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    // "attemptBoth" also tries an inverted image, which catches light-on-dark codes —
    // worth the extra pass here since a wallet's own exported QR may be rendered on a
    // dark background.
    const code = jsQR(data, w, h, { inversionAttempts: "attemptBoth" });
    // Trim before the truthiness check: a QR encoding only whitespace is a decode
    // with nothing in it, and delivering it would start a scan that can't succeed.
    const value = code?.data?.trim();
    return value ? value : null;
  };
}

/** Pick the best available detector. Native when the browser has it, jsQR otherwise,
 *  so QR scanning works whether or not the platform ships a native decoder. */
export function createDetector(win: unknown = globalThis): Detect {
  const Ctor = (win as { BarcodeDetector?: BarcodeDetectorCtor })?.BarcodeDetector;
  return typeof Ctor === "function" ? nativeDetect(Ctor) : jsqrDetect();
}
