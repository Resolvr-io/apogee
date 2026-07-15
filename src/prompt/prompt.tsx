import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ApprovalRequest } from "@/engine/protocol";
import { Spinner } from "@/sidepanel/components/ui";
import { Approval } from "@/sidepanel/screens/Approval";
import "../sidepanel/theme.css";

// Standalone approval popup — opened by the service worker when no side panel is
// available to host the overlay. Reads the pending approval id from the URL,
// fetches its details, renders the shared Approval UI, and closes itself once
// the user approves or rejects.
function Prompt() {
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    if (!id) {
      setError("No pending request.");
      return;
    }
    chrome.runtime
      .sendMessage({ type: "apogee/get-approval", id })
      .then((res: { ok: boolean; value?: ApprovalRequest; error?: string }) => {
        if (res?.ok && res.value) setRequest(res.value);
        else setError(res?.error ?? "This request expired.");
      })
      .catch(() => setError("Apogee is unavailable."));
  }, []);

  return (
    <div className="min-h-screen p-4">
      {request ? (
        <Approval request={request} onClose={() => window.close()} />
      ) : (
        <div className="flex h-screen items-center justify-center px-6 text-center text-sm text-[color:var(--text-secondary)]">
          {error || <Spinner />}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Prompt />
  </StrictMode>,
);
