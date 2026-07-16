// Persistent connection status bar pinned to the bottom of the side panel.
// Surfaces, at a glance, whether any dApp is connected to the wallet — with a
// green status light when connected — so the user no longer has to open Settings
// to check. Driven by the same connected-sites state the Settings card uses
// (`apogee_connected_sites` in session storage, kept live via broadcasts).

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { StatusDot } from "@/sidepanel/components/ui";
import { wallet } from "@/sidepanel/wallet-client";
import type { ApprovalRequest } from "@/engine/protocol";

export type ConnectionStatus = "connected" | "idle" | "pending";

/** Short, human-readable host for a connected-site origin. Falls back to the
 *  raw origin (minus the scheme) if the URL won't parse. */
function siteHost(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin.replace(/^https?:\/\//, "");
  }
}

/** Reads connected dApps and keeps them live, plus a transient "a site is
 *  requesting to connect" flag. Reuses the broadcast pattern from Wallet.tsx
 *  (apogee/sites-changed) and App.tsx (approval lifecycle). */
function useConnectionStatus(): {
  status: ConnectionStatus;
  host?: string;
  count: number;
} {
  const [sites, setSites] = useState<string[]>([]);
  const [pendingConnect, setPendingConnect] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => void wallet.getConnectedSites().then((s) => alive && setSites(s)).catch(() => {});
    load();

    const onMsg = (msg: unknown) => {
      if (!msg || typeof msg !== "object") return;
      const m = msg as {
        type?: string;
        request?: ApprovalRequest;
      };
      if (m.type === "apogee/sites-changed") {
        setPendingConnect(false); // a connect decision resolved
        load();
      } else if (m.type === "apogee/approval-request" && m.request?.kind === "connect") {
        setPendingConnect(true);
      } else if (m.type === "apogee/approval-expired" || m.type === "apogee/locked") {
        setPendingConnect(false);
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => {
      alive = false;
      chrome.runtime.onMessage.removeListener(onMsg);
    };
  }, []);

  if (pendingConnect) return { status: "pending", count: sites.length };
  if (sites.length === 0) return { status: "idle", count: 0 };
  return {
    status: "connected",
    host: sites.length === 1 ? siteHost(sites[0]) : undefined,
    count: sites.length,
  };
}

export function ConnectionBar({ onManage }: { onManage: () => void }) {
  const { status, host, count } = useConnectionStatus();

  // Nothing to surface when no app is connected and none is requesting access —
  // keep the bottom of the panel clear instead of advertising an empty state.
  if (status === "idle") return null;

  let label: ReactNode;
  if (status === "pending") {
    label = "Connection request…";
  } else if (count > 1) {
    label = (
      <>
        Connected ·{" "}
        <span className="text-[color:var(--text-primary)]">{count} apps</span>
      </>
    );
  } else {
    label = (
      <>
        Connected · <span className="text-[color:var(--text-primary)]">{host}</span>
      </>
    );
  }

  return (
    <footer className="relative z-10 shrink-0 border-t border-[color:var(--border-strong)] bg-[color:var(--surface-soft)]">
      <button
        type="button"
        onClick={onManage}
        aria-label="Manage connected apps"
        className="flex h-9 w-full items-center gap-2 px-4 text-left transition-colors hover:bg-[color:var(--surface-elevated)]"
      >
        <StatusDot tone={status} pulse={status === "pending"} />
        <span className="truncate text-xs text-[color:var(--text-secondary)]">{label}</span>
        <ChevronRight size={14} className="ml-auto shrink-0 text-[color:var(--text-subtle)]" />
      </button>
    </footer>
  );
}
