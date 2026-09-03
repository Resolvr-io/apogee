import { useCallback, useEffect, useRef, useState } from "react";
import { Compass, Lock, RotateCcw, Settings } from "lucide-react";
import type { KeystoreState } from "@/keystore/keystore";
import { DEBUG_ENTERPRISE_BUILD } from "@/lib/debug";
import { useDemoFunds } from "@/lib/demo-funds";
import { armBalanceStrike } from "@/sidepanel/balance-strike";
import { ErrorText, IconButton, LoadingPill } from "@/sidepanel/components/ui";
import { ToastView, type ToastNotice } from "@/sidepanel/components/Toast";
import { ConnectionBar } from "@/sidepanel/components/ConnectionBar";
import { driveIntroStarfield } from "@/sidepanel/scene-scroll";
import { VersionBadge, useTransientChrome } from "@/sidepanel/components/VersionBadge";
import { errMessage, wallet } from "@/sidepanel/wallet-client";
import { browser } from "@/lib/ext";
import { Scene, type SceneIntro } from "@/sidepanel/components/Scene";
import { useAnimations } from "@/sidepanel/use-animations";
import { useIdleHeartbeat } from "@/sidepanel/use-idle-heartbeat";
import { Onboarding } from "@/sidepanel/screens/Onboarding";
import { StepUp, Unlock } from "@/sidepanel/screens/Unlock";
import { Wallet, type View } from "@/sidepanel/screens/Wallet";
import { ApprovalOverlay } from "@/sidepanel/screens/Approval";
import type { ApprovalRequest } from "@/engine/protocol";

// One-time first-run cinematic: the moon descends, the water lights under it,
// and the UI fades in last (Scene `intro` + theme.css). Plays once per install,
// on the first onboarding; the flag deliberately survives wallet/reset, which
// removes only its own keys.
const MOON_INTRO_KEY = "apogee:moonIntroPlayed";

/** Total timeline length. KEEP IN SYNC with the .apogee-scene--intro block in
 *  theme.css, where the water dim currently ends last at 5.1s. */
const MOON_INTRO_MS = 5_100;

/** Longest the pre-decision hold may black out the panel. Generous next to a
 *  service-worker round trip, short next to a user wondering if it crashed. */
const HOLD_CAP_MS = 2_500;

// localStorage throws rather than degrades — SecurityError when storage is
// blocked, quota on setItem — and this is read in a useState initializer, where
// a throw escapes App's render entirely. A failed READ reports "already played":
// no cinematic beats a white screen.
function introFlagRead(): boolean {
  try {
    return localStorage.getItem(MOON_INTRO_KEY) !== null;
  } catch {
    return true;
  }
}
function introFlagWrite(played: boolean): void {
  try {
    if (played) localStorage.setItem(MOON_INTRO_KEY, "1");
    else localStorage.removeItem(MOON_INTRO_KEY);
  } catch {
    /* cosmetic — a wallet that can't persist this still works */
  }
}

/** The scene is decorative, so reduced motion resolves to "no intro" outright
 *  rather than playing a timeline whose animations CSS has disabled. */
function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

/**
 * Decide the intro phase. "hold" parks the scene until the keystore state
 * arrives, so a genuine first run never flashes the finished sky before the
 * descent.
 *
 * The played-once flag is in `localStorage`, not `browser.storage.local` — the
 * only such use in the codebase, because it must be readable SYNCHRONOUSLY at
 * first render or every open spends a frame or two holding on the async read.
 * It is written as soon as the decision lands, including the "off" path, so a
 * pre-feature install holds exactly once and a later reset-to-onboarding doesn't
 * replay a cinematic whose "first time" already happened.
 *
 * The phase is owned here rather than latched inside Scene so the debug replay
 * can re-arm it; `end` is called when the timeline finishes.
 *
 * `error` is here because the hold is a full-panel blackout: Body renders the
 * load failure inside the held wrapper, so holding through a failed getState()
 * shows an empty panel with no error and nothing to retry — most likely on
 * exactly the open this runs for, the first after an install.
 */
function useMoonIntro(
  state: KeystoreState | null,
  error: string,
  recovering: boolean,
  animated: boolean,
  animationsLoaded: boolean,
): { intro: SceneIntro; end: () => void; replay: () => void } {
  // Settled HERE, not at decision time, because the HOLD has to be skipped too:
  // the reduced-motion rules leave held content at opacity 1, so a phase that
  // merely blocks input shows a complete, opaque onboarding screen whose buttons
  // silently do nothing. Deciding at init means such a user never holds at all.
  const [phase, setPhase] = useState<SceneIntro>(() =>
    introFlagRead() || prefersReducedMotion() ? false : "hold",
  );
  useEffect(() => {
    if (phase !== "hold") return;
    if (state === null) {
      // Never hold over a failure. The flag stays UNWRITTEN so a genuine first
      // run still gets its cinematic once the wallet state can actually load.
      if (error) setPhase(false);
      return;
    }
    // Settle everything that does NOT depend on the animation preference first.
    // Load-bearing, not tidiness: waiting first held Unlock and Wallet behind a
    // storage read that could not affect them, invisible and not `inert`, with
    // Unlock's autoFocus landing in a password field the user cannot see. This
    // order leaves the onboarding chooser as the only screen that can outlive
    // `state` inside the hold, and it carries no autoFocus.
    const onboarding = !state.initialized || state.wallets.length === 0;
    if (!onboarding || recovering) {
      introFlagWrite(true);
      setPhase(false);
      return;
    }
    // The preference is read asynchronously and starts at its optimistic
    // default, so deciding before it lands can play the cinematic for someone
    // who turned Animations off.
    if (!animationsLoaded) return;
    // Reduced motion leaves the flag UNWRITTEN, so every place that asks agrees
    // on the PHASE: none plays a cinematic. Writing first made this one disagree
    // for a toggle landing in the decision window, because `matchMedia().matches`
    // flips synchronously with the OS setting, ahead of the `change` dispatch.
    //
    // Narrower than "nothing writes under reduced motion" — the non-onboarding
    // exit above, the hold cap below, and `replay()` all write outside that rule.
    // None is a reduced-motion decision, and an RM user never holds again anyway
    // because the initializer short-circuits.
    if (prefersReducedMotion()) {
      setPhase(false);
      return;
    }
    introFlagWrite(true);
    // `animated` folds in the Background-animation preference: with it off the
    // scene is the static poster, and a cinematic over a still would half-play.
    // Unlike reduced motion this DOES consume the first run — a deliberate
    // preference about decoration, not a sensitivity to it.
    setPhase(animated ? "play" : false);
  }, [phase, state, error, recovering, animated, animationsLoaded]);

  // Cap the hold. Everything above resolves on a state or an error, but the hold
  // blacks out the whole panel, so a sendMessage that never settles rather than
  // rejecting bricks the UI. Resolving to "no intro" costs a cinematic; not
  // resolving costs the wallet.
  //
  // The flag IS written here, losing the cinematic for good on this install.
  // That's the point: unwritten, the degradation recurs, so a machine reliably
  // slower than the cap blacks out for the full cap on every open — silently,
  // since the LoadingPill renders inside the held wrapper.
  useEffect(() => {
    if (phase !== "hold") return;
    const t = window.setTimeout(() => {
      introFlagWrite(true);
      setPhase(false);
    }, HOLD_CAP_MS);
    return () => window.clearTimeout(t);
  }, [phase]);

  // Reduced motion turned on MID-FLIGHT ends the phase, hold or play. Otherwise
  // the preference is honored at init and at decision time but nowhere between,
  // and both phases fail the same way: the media query makes the wrapper fully
  // visible — the hold via `opacity: 1`, the play by deleting its animation —
  // while `inert` stays on, leaving opaque unclickable controls.
  //
  // `play` is the harder half to spot: killing a running animation fires
  // `animationcancel`, NOT `animationend`, so `contentReady` never flips and
  // nothing lifts `inert` until the 5.35s backstop.
  //
  // The unwritten flag applies to the hold only — a `play` reached through the
  // decision effect already has it written, and a REPLAYED one is cleared on
  // purpose.
  //
  // Checked at attach too, not only on `change`, so a flip between render and
  // commit self-corrects. That also covers `replay()`, which reads the preference
  // synchronously and sets "play" a frame later.
  useEffect(() => {
    if (!phase || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches) {
      setPhase(false);
      return;
    }
    const onChange = () => {
      if (mq.matches) setPhase(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [phase]);

  const end = useCallback(() => setPhase(false), []);

  // Safety net for a lost animationend — an interrupted animation, a node
  // removed mid-flight. The phase is load-bearing beyond the CSS (it gates the
  // version badge and the content fade), so a stuck "play" is not cosmetic.
  useEffect(() => {
    if (phase !== "play") return;
    const t = window.setTimeout(() => setPhase(false), MOON_INTRO_MS + 250);
    return () => window.clearTimeout(t);
  }, [phase]);

  // Debug replay: clear the flag as well as re-arming the timeline, so the next
  // panel open replays too (subject to the same first-run eligibility) rather
  // than only this one showing it.
  const rearm = useRef(0);
  useEffect(() => () => cancelAnimationFrame(rearm.current), []);
  const replay = useCallback(() => {
    introFlagWrite(false);
    setPhase(false);
    // Reduced motion gets no phase here either, for the same reason it gets
    // none at init: CSS would disable every animation, so "play" would park the
    // UI behind a timeline that never runs and never ends. Clearing the flag is
    // the whole of the replay for such a user — there is no cinematic to see.
    if (prefersReducedMotion()) return;
    // One frame at `false` so a re-run restarts the CSS animations; setting
    // "play" while already "play" would leave them mid-flight.
    cancelAnimationFrame(rearm.current);
    rearm.current = requestAnimationFrame(() => setPhase("play"));
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
  // Bumped every time the header logo is clicked. The wallet home listens and
  // scrolls its activity list to the top, so the logo is "home" in full: back
  // to the balance view, the hero expanded, the newest transactions in view —
  // even when already on the balance, deep in the list.
  const [homeTopSeq, setHomeTopSeq] = useState(0);
  // Debug builds only: suppresses the network placard so a screenshot taken on
  // a testnet wallet reads as mainnet, matching the demo dataset.
  const demoFunds = useDemoFunds();
  const [animationsPref, , animationsLoaded] = useAnimations();
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
        // The numerals strike again on the next unlock — being locked out and
        // back in is exactly the moment the display should read as coming alive.
        armBalanceStrike();
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

  // needsStepUp: auto-lock is "never" and this panel session hasn't re-verified
  // the password — treat it like locked for what the panel shows (see StepUp).
  const unlocked = Boolean(
    state && state.initialized && !state.locked && !state.needsStepUp && state.wallets.length > 0,
  );
  // Same first-run test useMoonIntro gates the cinematic on. Nothing to replay
  // once a wallet exists by any route (create / restore / watch-only / Jade), so
  // the debug control retires with the screen it belongs to.
  const preWallet = Boolean(state && (!state.initialized || state.wallets.length === 0));
  // The animated ocean is a lock/intro backdrop only — never on the wallet itself.
  const animated = !unlocked && animationsPref;
  // Same treatment as VersionBadge, out of the same hook so the durations have
  // one definition. Not the same clock: this instance starts with the panel and
  // the badge's starts when the intro ends, so on first run the badge outlasts
  // the button. Called here rather than inside the button so a replay can't
  // restart the timer and leave the button visible in a screenshot taken
  // afterwards — and the badge re-arming on replay is deliberate, which is
  // exactly why the two can't be put on one clock.
  const { shown: chromeShown } = useTransientChrome();
  const { intro: moonIntro, end: endMoonIntro, replay: replayMoonIntro } = useMoonIntro(
    state,
    error,
    recovering,
    animated,
    animationsLoaded,
  );
  // The intro's moon is a CSS keyframe and the starfield only moves when JS says
  // so, which left it descending through a sky nailed in place. Keyed on the
  // phase, so a replay re-runs the sweep and a capped hold resets the sky rather
  // than stranding it parked from a descent that never played.
  useEffect(() => driveIntroStarfield(moonIntro), [moonIntro]);

  // Defence in depth only: the replay handler clears this before re-arming the
  // phase, which is what actually closes the stale-`true` frame, and no other
  // path reaches "play" with it set. Kept so a future second caller of `replay`
  // cannot reopen that window by forgetting to clear it.
  const [contentReady, setContentReady] = useState(false);
  useEffect(() => {
    if (moonIntro) setContentReady(false);
  }, [moonIntro]);
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
    armBalanceStrike();
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
      <div
        // Faded out during the intro. Where `inert` below doesn't also apply —
        // the one-commit Unlock/Wallet hold — that hides content from the eye but
        // not from the tab order, so Unlock's password field is focused and
        // typeable while invisible for that commit.
        //
        // Keyed on the CONTENT fade, not the phase: the phase ends at 5.1s with
        // the water dim but this finishes at 4.8s, so keying on the phase left
        // the UI opaque and apparently ready for ~300ms while still swallowing
        // input. `target === currentTarget` because animationend bubbles.
        //
        // NOT applied to a hold that can be showing Unlock. `inert` blocks the
        // imperative focus React fires for `autoFocus` at mount and nothing
        // re-fires it when inert lifts, so holding over the render that mounts
        // Unlock costs its password field the focus it has always had. Not a
        // race: `setPhase` runs in an effect, so the commit mounting Unlock is
        // ALWAYS under "hold", and that commit is both the only moment
        // `autoFocus` can fire and the only moment focusable content is
        // invisible.
        //
        // `preWallet` is what makes the rest safe — it is exactly the effect's
        // `onboarding` test, so an inert hold is only ever the chooser, which
        // carries no `autoFocus`. That closes an escalation plain
        // `pointer-events: none` could not: the CSS stops a pointer but not
        // Enter/Space on a focused invisible control, so a blind Tab+Enter on the
        // chooser mounted a seed-phrase Textarea, invisible and typeable. The
        // residual exposure is the a11y tree and a live one-commit Unlock.
        //
        // Give the chooser an `autoFocus`, or extend the intro to the unlock
        // screen, and this regresses silently on first run: change the phase gate
        // too, or drop `inert` here.
        inert={moonIntro === "play" ? !contentReady : moonIntro === "hold" && preWallet}
        onAnimationEnd={(e) => {
          if (e.target === e.currentTarget) setContentReady(true);
        }}
        className={`relative z-10 flex min-h-0 flex-1 flex-col ${introContentClass}`}
      >
        {unlocked && (
          <header className="relative z-10 flex h-14 shrink-0 items-center gap-2 px-4">
            <button
              type="button"
              onClick={() => {
                setView("home");
                setHomeTopSeq((n) => n + 1);
              }}
              aria-label="Go to balance"
              className="flex items-center transition-opacity hover:opacity-80"
            >
              <img src="/icons/apogee-logo.svg" alt="Apogee" className="h-6 w-auto" />
            </button>
            {/* Layout utilities only: .console-placard lives in @layer base, so any
                type/color utility added alongside would silently win over it. The
                caps come from text-transform, leaving the DOM text readable.

                Demo funds presents a mainnet-shaped wallet for screenshots, so
                the caution placard would contradict it — a capture taken on a
                testnet wallet must not advertise testnet. Suppressed only in
                debug builds with the toggle on; ordinary builds can't reach it. */}
            {activeNetwork && activeNetwork !== "liquid" && !demoFunds && (
              <span className="console-placard -translate-x-1/2 -translate-y-1/2 absolute top-1/2 left-1/2">
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
            homeTopSeq={homeTopSeq}
          />
          {/* Mounted only once the intro is over. The badge shows for a fixed
              window from MOUNT and then removes itself, so leaving it mounted
              through the cinematic spent a third of that window at opacity 0 —
              and, since the timer never restarts, a replay after the window had
              already lapsed showed no version at all. Gating the mount gives it
              its full life whenever it appears, and a replay re-arms it. With no
              intro (`moonIntro === false`) this is the previous behavior exactly.

              Inside <main>, not beside it, and that placement is load-bearing
              now the badge takes clicks. main is flex-1 with the connection bar
              as a shrink-0 sibling below, so main's bottom edge IS the top of
              the bar: a badge anchored here cannot reach into the bar's 36px
              full-width button. Anchored to the wrapper instead, its bottom-2
              band sat inside that button and stole every click at the panel's
              horizontal centre.

              main is also `relative z-10`, so it is a stacking context, and the
              modals nested inside Body (watch-only z-40, forgot-password z-30,
              the asset dropdown z-30) are compared against the badge here and
              win. As a sibling of main they could not: their z was local to
              main's layer and could never outrank main's sibling. */}
          {!moonIntro && <VersionBadge />}
        </main>
        {unlocked && <ConnectionBar onManage={() => setView("settings")} />}
      </div>
      {/* Gated on DEBUG_ENTERPRISE_BUILD — the same enterprise-credential flag
          as the Settings Debug card, so an .env.local without Blockstream keys
          gets neither. Replay
          the first-run intro without reinstalling. Bottom RIGHT to stay clear of
          the dev overlay in the opposite corner, and outside the fade wrapper so
          it stays reachable while the cinematic plays. Not during the hold —
          `preWallet` needs a loaded state and the hold is precisely the window
          before one arrives — which costs nothing, since the hold is the part
          with nothing to watch.

          It fades out on the version badge's timer, so this screen can be
          photographed from a debug build without the button in shot. Once faded
          it stays MOUNTED and keeps its hit area, because opacity does not
          affect hit-testing: hovering the corner brings it back, moving away
          takes it again, and focus-visible reveals it so it is not lost to the
          keyboard. Two durations on purpose — a second to match the badge on the
          way out, 150ms on hover, because a control that takes a full second to
          answer the pointer reads as broken rather than gentle. */}
      {DEBUG_ENTERPRISE_BUILD && preWallet && (
        <button
          type="button"
          onClick={() => {
            // Cleared here, not only in the effect: the effect runs after the
            // render that first commits "play", so that render would still see
            // a stale `true` and paint one frame at opacity 0 without `inert`.
            setContentReady(false);
            replayMoonIntro();
          }}
          aria-label="Replay intro"
          title="Replay intro (debug build only)"
          className={`absolute right-3 bottom-3 z-30 flex h-8 w-8 items-center justify-center rounded-full border border-[color:var(--warning-border)] bg-[color:var(--warning-bg)] text-[color:var(--warning-text)] transition-opacity duration-1000 hover:duration-150 motion-reduce:transition-none ${
            chromeShown
              ? "opacity-100 hover:opacity-80"
              : "opacity-0 hover:opacity-100 focus-visible:opacity-100"
          }`}
        >
          <RotateCcw size={14} />
        </button>
      )}
      <ToastView toast={toast} />
      {approval && (
        <ApprovalOverlay
          request={approval}
          onClose={() => {
            setApproval(null);
            void refresh();
          }}
        />
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
  homeTopSeq,
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
  homeTopSeq: number;
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
  if (state.needsStepUp) {
    return <StepUp onDone={refresh} />;
  }
  return (
    <Wallet
      state={state}
      view={view}
      onView={onView}
      onToast={onToast}
      onReset={onReset}
      homeTopSeq={homeTopSeq}
    />
  );
}
