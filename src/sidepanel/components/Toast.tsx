// Transient wallet notification (funds received / sent), shown near the bottom of
// the side panel. A small card bordered + tinted
// by kind. The auto-dismiss timer is owned by the caller (App).

export type ToastKind = "success" | "info" | "error";

export interface ToastNotice {
  id: number;
  title: string;
  message: string;
  kind: ToastKind;
}

export function ToastView({ toast }: { toast: ToastNotice | null }) {
  if (!toast) return null;
  const border =
    toast.kind === "success"
      ? "border-[color:var(--success-border)]"
      : toast.kind === "error"
        ? "border-[color:var(--danger-border)]"
        : "border-[color:var(--accent-soft)]";
  const titleColor =
    toast.kind === "success"
      ? "text-[color:var(--success-text)]"
      : toast.kind === "error"
        ? "text-[color:var(--danger-text)]"
        : "text-[color:var(--accent-strong)]";
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center px-4"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div
        key={toast.id}
        className={`apogee-toast-in pointer-events-auto w-full max-w-[16rem] rounded-2xl border bg-[color:var(--surface-card)] px-4 py-3 shadow-[0_18px_40px_var(--shadow-strong)] ${border}`}
      >
        <p className={`text-sm font-semibold ${titleColor}`}>{toast.title}</p>
        <p className="mt-0.5 text-xs text-[color:var(--text-muted)]">{toast.message}</p>
      </div>
    </div>
  );
}
