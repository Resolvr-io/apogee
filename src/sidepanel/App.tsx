import { useCallback, useEffect, useRef, useState } from "react";
import { Compass, Lock, RotateCcw, Settings } from "lucide-react";
import type { KeystoreState } from "@/keystore/keystore";
import { DEBUG_ENTERPRISE_BUILD } from "@/lib/debug";
import { ErrorText, IconButton, LoadingPill } from "@/sidepanel/components/ui";
import { ToastView, type ToastNotice } from "@/sidepanel/components/Toast";
import { ConnectionBar } from "@/sidepanel/components/ConnectionBar";
import { VersionBadge } from "@/sidepanel/components/VersionBadge";
import { errMessage, wallet } from "@/sidepanel/wallet-client";
import { browser } from "@/lib/ext";
import { Scene, type SceneIntro } from "@/sidepanel/components/Scene";
import { useAnimations } from "@/sidepanel/use-animations";
import { useIdleHeartbeat } from "@/sidepanel/use-idle-heartbeat";
import { Onboarding } from "@/sidepanel/screens/Onboarding";
import { Unlock } from "@/sidepanel/screens/Unlock";
import { Wallet, type View } from "@/sidepanel/screens/Wallet";
import { Approval } from "@/sidepanel/screens/Approval";
import type { ApprovalRequest } from "@/engine/protocol";

// One-time first-run cinematic: the moon descends from above the panel, the
// water lights up under it, and the UI fades in last (Scene `intro` +
// theme.css). Plays exactly once per install — on the first onboarding (no
// seed, no Jade) — then never again; the flag deliberately survives
// wallet/reset, which removes only its own keys.
const MOON_INTRO_KEY = "apogee:moonIntroPlayed";

/**
 * Decide the intro phase. "hold" parks the scene (moon above the panel, UI
 * hidden) until the keystore state arrives, so a genuine first run never
 * flashes the finished sky before the descent.
 *
 * The played-once flag lives in `localStorage`, not `browser.storage.local` —
 * the only such use in the codebase, and deliberate: the flag must be readable
 * SYNCHRONOUSLY at first render, or every panel open would spend a frame or two
 * in the hold state waiting on the async read. localStorage is available in
 * every extension page (only the service worker lacks it), and a cosmetic flag
 * has no reason to be visible outside this panel. The flag is written as soon
 * as the decision lands — including the "off" path, so a pre-feature install
 * (flag unset, wallets exist) holds exactly once and a later reset-to-
 * onboarding doesn't replay a cinematic whose "first time" already happened.
 *
 * The phase is owned here rather than latched inside Scene so the debug replay
 * can re-arm it; `end` is called when the timeline finishes.
 */
function useMoonIntro(
  state: KeystoreState | null,
  recovering: boolean,
  animated: boolean,
): { intro: SceneIntro; end: () => void; replay: () => void } {
  const [phase, setPhase] = useState<SceneIntro>(() =>
    localStorage.getItem(MOON_INTRO_KEY) ? false : "hold",
  );
  useEffect(() => {
    if (phase !== "hold") return;
    if (state === null) return; // need the keystore state to decide eligibility
    const onboarding = !state.initialized || state.wallets.length === 0;
    localStorage.setItem(MOON_INTRO_KEY, "1");
    // `animated` folds in the Background-animation preference: with it off the
    // scene is the static poster, and a cinematic over a still would half-play.
    setPhase(onboarding && !recovering && animated ? "play" : false);
  }, [phase, state, recovering, animated]);

  const end = useCallback(() => setPhase(false), []);
  // Debug replay: clear the flag as well as re-arming the timeline, so the next
  // panel open replays too (subject to the same first-run eligibility) rather
  // than only this one showing it.
  const replay = useCallback(() => {
    localStorage.removeItem(MOON_INTRO_KEY);
    setPhase(false);
    // One frame at `false` so a re-run restarts the CSS animations; setting
    // "play" while already "play" would leave them mid-flight.
    requestAnimationFrame(() => setPhase("play"));
  }, []);

  return { intro: phase, end, replay };
}

// Root shell + router. The view is derived from the keystore state the service
// worker reports: not-initialized → onboarding, locked → unlock, else the
// wallet. The wallet's sub-view (home/receive/send/settings) is held here so the
// header's Settings/Lock controls can drive it. `refresh()` re-reads state.
export function App() {
  const [state, setState] = useState<KeystoreState | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("home");
  const [animationsPref] = useAnimations();
  // Forgot-password "Import wallet": show the restore form without wiping the
  // existing vault — the wipe happens only when a valid phrase is submitted.
  const [recovering, setRecovering] = useState(false);
  // A dapp-initiated spend awaiting approval — shown as an overlay over the panel.
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  // Transient received/sent notification (driven by the wallet's tx detection).
  const [toast, setToast] = useState<ToastNotice | null>(null);
  const toastTimer = useRef<number | null>(null);
  const showToast = useCallback((notice: ToastNotice) => {
    setToast(notice);
    if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);
  useEffect(
    () => () => {
      if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  const refresh = useCallback(async () => {
    try {
      setError("");
      setState(await wallet.getState());
    } catch (e) {
      setError(errMessage(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Service-worker broadcasts: idle auto-lock, and dapp spend-approval requests
  // (shown as an overlay when this side panel is the open surface).
  useEffect(() => {
    const onMsg = (msg: unknown) => {
      if (!msg || typeof msg !== "object") return;
      const m = msg as { type?: string; request?: ApprovalRequest; id?: string };
      if (m.type === "apogee/locked") {
        setApproval(null); // dismiss any stale approval overlay on lock
        // Reset to the balance view: auto-lock can fire while the user is on a
        // sub-view (e.g. Settings), and without this they'd return there after
        // unlocking (or recovering a seed) instead of the balance. Manual lock
        // already resets in lock().
        setView("home");
        // apogee/locked is broadcast only by the idle auto-lock alarm (a manual
        // lock via wallet/lock doesn't broadcast), so surface it to the user.
        showToast({
          id: Date.now(),
          title: "Wallet auto-locked",
          message: "Locked after a period of inactivity.",
          kind: "info",
        });
        void refresh();
      } else if (m.type === "apogee/approval-request" && m.request) {
        setApproval(m.request);
      } else if (m.type === "apogee/approval-expired") {
        // The SW expired (or force-rejected) this approval — an overlay left up
        // would look approvable but only ever error. Dismiss it if it matches.
        setApproval((cur) => (cur && cur.id === m.id ? null : cur));
      }
    };
    browser.runtime.onMessage.addListener(onMsg);
    return () => browser.runtime.onMessage.removeListener(onMsg);
  }, [refresh, showToast]);

  const unlocked = Boolean(state && state.initialized && !state.locked && state.wallets.length > 0);
  // Same first-run test useMoonIntro gates the cinematic on. Nothing to replay
  // once a wallet exists by any route (create / restore / watch-only / Jade), so
  // the debug control retires with the screen it belongs to.
  const preWallet = Boolean(state && (!state.initialized || state.wallets.length === 0));
  // The animated ocean is a lock/intro backdrop only — never on the wallet itself.
  const animated = !unlocked && animationsPref;
  const { intro: moonIntro, end: endMoonIntro, replay: replayMoonIntro } = useMoonIntro(
    state,
    recovering,
    animated,
  );
  // Content hold/fade class — the UI arrives after the moon has settled.
  const introContentClass =
    moonIntro === "play"
      ? "apogee-intro-content apogee-intro-content--play"
      : moonIntro === "hold"
        ? "apogee-intro-content apogee-intro-content--hold"
        : "apogee-intro-content";
  // Genuine side-panel input re-arms the idle auto-lock (background polling can't).
  useIdleHeartbeat(unlocked);
  const activeWallet =
    state && !state.locked ? state.wallets.find((w) => w.id === state.activeWalletId) : undefined;
  const activeNetwork = activeWallet?.network;

  async function lock() {
    await wallet.lock();
    setView("home");
    await refresh();
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <Scene animated={animated} intro={moonIntro} onIntroEnd={endMoonIntro} />
      {/* Bottom darkening gradient over the moonlit-sea backdrop, on every view,
          so content (and the settings footer) stays legible. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-40"
        style={{
          background:
            "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.85) 55%, rgba(0,0,0,0.96) 100%)",
        }}
      />
      {/* Everything the user reads sits in one wrapper so the intro can hold it
          back and fade it in once the moon has settled. It is the only in-flow
          child of the panel, so it fills the same box the header/main/footer
          filled before — VersionBadge's absolute anchor is unchanged. Toasts and
          the approval overlay stay outside: neither is decorative, and neither
          should ever wait on a cinematic. */}
      <div className={`relative z-10 flex min-h-0 flex-1 flex-col ${introContentClass}`}>
        {unlocked && (
          <header className="relative z-10 flex h-14 shrink-0 items-center gap-2 px-4">
            <button
              type="button"
              onClick={() => setView("home")}
              aria-label="Go to balance"
              className="flex items-center transition-opacity hover:opacity-80"
            >
              <img src="/icons/apogee-logo.svg" alt="Apogee" className="h-6 w-auto" />
            </button>
            {activeNetwork && activeNetwork !== "liquid" && (
              <span className="-translate-x-1/2 -translate-y-1/2 absolute top-1/2 left-1/2 rounded-full border border-[color:var(--warning-border)] bg-[color:var(--warning-bg)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--warning-text)]">
                {activeNetwork === "liquidtestnet" ? "Testnet" : "Regtest"}
              </span>
            )}
            <div className="ml-auto flex items-center gap-1">
              <IconButton label="Guide" onClick={() => void wallet.openGuide()}>
                <Compass size={16} />
              </IconButton>
              {/* Toggle: pressing Settings while it's open goes back rather than being
                  inert, which is what the icon staying highlighted implies. */}
              <IconButton
                label={view === "settings" ? "Close settings" : "Settings"}
                onClick={() => setView(view === "settings" ? "home" : "settings")}
              >
                <Settings size={16} />
              </IconButton>
              <IconButton label="Lock" onClick={lock}>
                <Lock size={16} />
              </IconButton>
            </div>
          </header>
        )}
        <main className="relative z-10 flex min-h-0 flex-1 flex-col">
          <Body
            state={state}
            error={error}
            refresh={refresh}
            view={view}
            onView={setView}
            onToast={showToast}
            recovering={recovering}
            onImport={() => setRecovering(true)}
            onExitRecovery={() => setRecovering(false)}
            onReset={() => {
              setRecovering(false);
              void refresh();
            }}
          />
        </main>
        {unlocked && <ConnectionBar onManage={() => setView("settings")} />}
        {/* Mounted only once the intro is over. The badge shows for a fixed
            window from MOUNT and then removes itself, so leaving it mounted
            through the cinematic spent a third of that window at opacity 0 —
            and, since the timer never restarts, a replay after the window had
            already lapsed showed no version at all. Gating the mount gives it
            its full life whenever it appears, and a replay re-arms it. With no
            intro (`moonIntro === false`) this is the previous behavior exactly. */}
        {!moonIntro && <VersionBadge />}
      </div>
      {/* Local debug builds only (see lib/debug.ts — needs .env.local): replay
          the first-run intro without reinstalling. Bottom RIGHT to stay clear of
          the dev overlay in the opposite corner, and outside the fade wrapper so
          it stays reachable while the cinematic is holding the UI back. */}
      {DEBUG_ENTERPRISE_BUILD && preWallet && (
        <button
          type="button"
          onClick={replayMoonIntro}
          aria-label="Replay intro"
          title="Replay intro (debug build only)"
          className="absolute right-3 bottom-3 z-30 flex h-8 w-8 items-center justify-center rounded-full border border-[color:var(--warning-border)] bg-[color:var(--warning-bg)] text-[color:var(--warning-text)] transition-opacity hover:opacity-80"
        >
          <RotateCcw size={14} />
        </button>
      )}
      <ToastView toast={toast} />
      {approval && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[color:var(--overlay)] p-4">
          <div className="w-full max-w-sm">
            <Approval
              request={approval}
              onClose={() => {
                setApproval(null);
                void refresh();
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Body({
  state,
  error,
  refresh,
  view,
  onView,
  onToast,
  recovering,
  onImport,
  onExitRecovery,
  onReset,
}: {
  state: KeystoreState | null;
  error: string;
  refresh: () => void;
  view: View;
  onView: (v: View) => void;
  onToast: (n: ToastNotice) => void;
  recovering: boolean;
  onImport: () => void;
  onExitRecovery: () => void;
  onReset: () => void;
}) {
  if (!state) {
    return (
      <div className="flex flex-1 items-center justify-center">
        {error ? <ErrorText>{error}</ErrorText> : <LoadingPill />}
      </div>
    );
  }
  // Forgot-password import: restore over the existing (locked) vault. Cancelling
  // returns to the lock screen with the vault intact.
  if (recovering) {
    return (
      <Onboarding
        initialStep="restore"
        replace
        onCancel={onExitRecovery}
        onDone={() => {
          onExitRecovery();
          onView("home");
          refresh();
        }}
      />
    );
  }
  if (!state.initialized || state.wallets.length === 0) {
    // Land on the balance screen after setup (create/restore/hardware/watch-only),
    // not a stale sub-view — e.g. if onboarding was reached by resetting from Settings.
    return (
      <Onboarding
        onDone={() => {
          onView("home");
          refresh();
        }}
      />
    );
  }
  if (state.locked) {
    return <Unlock onDone={refresh} onImport={onImport} onReset={onReset} />;
  }
  return (
    <Wallet state={state} view={view} onView={onView} onToast={onToast} onReset={onReset} />
  );
}
