// Reset the idle auto-lock on genuine side-panel user input (pointer/keyboard).
// The 20s background sync poll is a setInterval with no user event, so it can't
// trigger this — an unattended wallet still idle-locks, but an active user stays
// unlocked.
//
// Two sends keep lastActivityAt accurate to the true last input:
//  - a throttled keep-alive (≤ once / THROTTLE_MS) during continuous activity;
//  - a trailing send TRAIL_MS after the final input, so the exact end of a burst
//    is recorded (a pure throttle would lag up to THROTTLE_MS behind it).

import { useEffect } from "react";
import { wallet } from "@/sidepanel/wallet-client";

const THROTTLE_MS = 1000;
const TRAIL_MS = 500;

export function useIdleHeartbeat(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let lastSent = 0;
    let trailing: number | null = null;
    const send = () => {
      lastSent = Date.now();
      void wallet.touch().catch(() => {});
    };
    const onActivity = () => {
      if (Date.now() - lastSent >= THROTTLE_MS) send();
      // Re-arm the trailing send on every input so it fires only after activity
      // truly stops — capturing the real last-input moment.
      if (trailing != null) window.clearTimeout(trailing);
      trailing = window.setTimeout(send, TRAIL_MS);
    };
    window.addEventListener("pointerdown", onActivity);
    window.addEventListener("keydown", onActivity);
    return () => {
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
      if (trailing != null) window.clearTimeout(trailing);
    };
  }, [active]);
}
