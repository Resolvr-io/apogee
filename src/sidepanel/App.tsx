import { useCallback, useEffect, useRef, useState } from "react";
import { Compass, Lock, Settings } from "lucide-react";
import type { KeystoreState } from "@/keystore/keystore";
import { ErrorText, IconButton, LoadingPill } from "@/sidepanel/components/ui";
import { ToastView, type ToastNotice } from "@/sidepanel/components/Toast";
import { ConnectionBar } from "@/sidepanel/components/ConnectionBar";
import { VersionBadge } from "@/sidepanel/components/VersionBadge";
import { errMessage, wallet } from "@/sidepanel/wallet-client";
import { Scene } from "@/sidepanel/components/Scene";
import { useAnimations } from "@/sidepanel/use-animations";
import { useIdleHeartbeat } from "@/sidepanel/use-idle-heartbeat";
import { Onboarding } from "@/sidepanel/screens/Onboarding";
import { Unlock } from "@/sidepanel/screens/Unlock";
import { Wallet, type View } from "@/sidepanel/screens/Wallet";
import { Approval } from "@/sidepanel/screens/Approval";
import type { ApprovalRequest } from "@/engine/protocol";

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
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, [refresh, showToast]);

  const unlocked = Boolean(state && state.initialized && !state.locked && state.wallets.length > 0);
  // The animated ocean is a lock/intro backdrop only — never on the wallet itself.
  const animated = !unlocked && animationsPref;
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
      <Scene animated={animated} />
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
            <IconButton
              label="Guide"
              onClick={() =>
                void chrome.tabs.create({ url: chrome.runtime.getURL("src/guide/guide.html") })
              }
            >
              <Compass size={16} />
            </IconButton>
            <IconButton label="Settings" onClick={() => setView("settings")}>
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
      <VersionBadge />
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
