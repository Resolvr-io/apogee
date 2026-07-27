// Tests for detector selection.
//
// The property that matters: the native path is used wherever it exists, and the jsQR
// fallback ONLY where it doesn't. Getting this backwards would either regress Chrome
// to a slower main-thread decode, or leave Firefox with the dead end this fixes
// (`BarcodeDetector` is Chromium-only, so Firefox previously showed "QR scanning
// isn't supported in this browser" for both address and seed-phrase scanning).
//
// The decode itself needs a camera and a real frame, so it is verified by hand in
// both browsers, not here.

import { describe, expect, it, vi } from "vitest";
import { createDetector, hasNativeDetector } from "./detect";

/** A window-ish object exposing a fake native detector. */
function withNative(rawValue: string | null) {
  const detect = vi.fn().mockResolvedValue(rawValue == null ? [] : [{ rawValue }]);
  return { win: { BarcodeDetector: class { detect = detect } }, detect };
}

describe("hasNativeDetector", () => {
  it("detects a usable native detector", () => {
    expect(hasNativeDetector({ BarcodeDetector: class {} })).toBe(true);
  });

  it("reports absent on Firefox-shaped globals", () => {
    // Firefox exposes no BarcodeDetector at all.
    expect(hasNativeDetector({})).toBe(false);
  });

  it("does not accept a non-constructor", () => {
    // A truthy-but-unusable value must not be treated as available, or `new` throws
    // at scan time instead of falling back.
    expect(hasNativeDetector({ BarcodeDetector: true })).toBe(false);
    expect(hasNativeDetector({ BarcodeDetector: {} })).toBe(false);
    expect(hasNativeDetector(undefined)).toBe(false);
  });
});

describe("createDetector", () => {
  it("uses the native detector when present, passing the video element through", async () => {
    const { win, detect } = withNative("lq1address");
    const d = createDetector(win);
    const video = { videoWidth: 640, videoHeight: 480 } as HTMLVideoElement;
    await expect(d(video)).resolves.toBe("lq1address");
    // Native decodes straight from the element — no canvas copy.
    expect(detect).toHaveBeenCalledWith(video);
  });

  it("returns null from the native path when no code is visible", async () => {
    const { win } = withNative(null);
    const d = createDetector(win);
    await expect(d({} as HTMLVideoElement)).resolves.toBeNull();
  });

  it("treats a whitespace-only decode as no scan", async () => {
    // A QR can legitimately encode only spaces. Truthiness alone would deliver it
    // and start a scan that downstream validation must then reject. Both backends
    // trim, so they can't disagree about what counts as a scan.
    const detect = vi.fn().mockResolvedValue([{ rawValue: "   \n " }]);
    const d = createDetector({ BarcodeDetector: class { detect = detect } });
    await expect(d({} as HTMLVideoElement)).resolves.toBeNull();
  });

  it("trims surrounding whitespace off a real value", async () => {
    // Addresses and seed phrases are pasted/scanned with stray whitespace often
    // enough that trimming is the useful behavior, not just a guard.
    const detect = vi.fn().mockResolvedValue([{ rawValue: "  lq1address\n" }]);
    const d = createDetector({ BarcodeDetector: class { detect = detect } });
    await expect(d({} as HTMLVideoElement)).resolves.toBe("lq1address");
  });

  it("ignores a native result with an empty rawValue", async () => {
    // A detected-but-empty barcode must not be delivered as a scan; for the seed
    // path that would hand an empty string to the one-shot channel.
    const detect = vi.fn().mockResolvedValue([{ rawValue: "" }]);
    const d = createDetector({ BarcodeDetector: class { detect = detect } });
    await expect(d({} as HTMLVideoElement)).resolves.toBeNull();
  });

  it("builds the fallback without needing a DOM", () => {
    // Construction must not touch `document` — the canvas is created lazily on the
    // first frame. This also means selection is testable without jsdom.
    expect(() => createDetector({})).not.toThrow();
  });

  it("fallback returns null for a frame with no dimensions yet", async () => {
    // Before the camera produces a frame videoWidth/Height are 0; decoding that
    // would read an empty buffer. Must bail before touching the canvas.
    const d = createDetector({});
    await expect(
      d({ videoWidth: 0, videoHeight: 0 } as HTMLVideoElement),
    ).resolves.toBeNull();
  });
});
