// Compact UI primitives for the side panel, styled with the design tokens
// (see theme.css). Local and self-contained.

import { useEffect, useRef, useState } from "react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";
import { AlertTriangle, Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger";

// Console-panel buttons: uppercase, letterspaced labels (Satoshi — the
// telemetry face is too thin for small bright fills). Primary reads as a lit
// lamp cell (inset top bevel + a faint phosphor halo); secondary is a quiet
// translucent console cell.
const VARIANTS: Record<Variant, string> = {
  primary:
    "border border-[color:var(--accent)] bg-[linear-gradient(180deg,var(--accent-strong)_0%,var(--accent)_100%)] text-[color:var(--text-on-accent)] shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_8px_20px_var(--shadow-soft),0_0_14px_color-mix(in_srgb,var(--accent)_28%,transparent)] hover:brightness-110",
  secondary:
    "border border-[color:var(--border-default)] bg-[color:color-mix(in_srgb,var(--surface-soft)_66%,transparent)] text-[color:var(--text-soft)] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--accent-strong)_10%,transparent)] hover:border-[color:var(--border-hover)] hover:text-[color:var(--text-strong)]",
  ghost: "text-[color:var(--text-secondary)] hover:text-[color:var(--text-strong)]",
  danger:
    "border border-[color:var(--danger-border)] bg-[color:var(--danger-bg)] text-[color:var(--danger-text)] hover:brightness-110",
};

type Size = "md" | "sm";

const SIZES: Record<Size, string> = {
  md: "h-10 gap-2 px-4 text-[12.5px]",
  sm: "h-8 gap-1.5 px-3 text-[11px]",
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center rounded-md font-semibold uppercase tracking-[0.08em] transition disabled:pointer-events-none disabled:opacity-50",
        SIZES[size],
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}

// Focus lights a phosphor ring rather than only swapping the border color.
const FIELD_BASE =
  "w-full rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] px-3 text-sm text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-subtle)] focus:border-[color:var(--accent)] focus:shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent)_30%,transparent),0_0_12px_color-mix(in_srgb,var(--accent)_18%,transparent)]";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn("h-11", FIELD_BASE, className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn("min-h-20 resize-none py-2 leading-relaxed", FIELD_BASE, className)} {...props} />;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-[color:var(--text-secondary)]">{label}</span>
      {children}
    </label>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "apogee-panel rounded-xl border border-[color:var(--border-default)] p-4 shadow-[0_16px_36px_var(--shadow-soft)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block size-4 animate-spin rounded-full border-2 border-[color:color-mix(in_srgb,var(--text-strong)_30%,transparent)] border-t-[color:var(--accent-strong)]",
        className,
      )}
    />
  );
}

export type StatusTone = "connected" | "idle" | "pending" | "error";

/** Small status light (connected/idle/pending/error) styled with the design
 *  tokens — the green-dot idiom used across the Astrolabe apps. Token-driven, so
 *  no color is hardcoded: tone maps to a CSS variable set in theme.css. */
export function StatusDot({
  tone,
  pulse = false,
  className,
}: {
  tone: StatusTone;
  pulse?: boolean;
  className?: string;
}) {
  const color: Record<StatusTone, string> = {
    connected: "var(--success-text)",
    idle: "var(--text-subtle)",
    pending: "var(--warning-text)",
    error: "var(--danger-text)",
  };
  return (
    <span
      className={cn("inline-block size-2 shrink-0 rounded-full", pulse && "animate-pulse", className)}
      // Lit tones glow like a panel indicator lamp; idle stays a flat dot.
      style={{
        backgroundColor: color[tone],
        boxShadow: tone === "idle" ? undefined : `0 0 7px ${color[tone]}`,
      }}
    />
  );
}

/** Accessible on/off toggle (`role="switch"`), token-styled for the panel. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-[background-color,box-shadow] disabled:opacity-50",
        // On = a lit indicator: accent track with a soft phosphor halo.
        checked
          ? "bg-[color:var(--accent)] shadow-[0_0_10px_color-mix(in_srgb,var(--accent)_55%,transparent),inset_0_1px_0_rgba(255,255,255,0.3)]"
          : "bg-[color:var(--border-hover)]",
      )}
    >
      <span
        className={cn(
          "inline-block size-4 transform rounded-full bg-[color:var(--text-on-accent)] shadow transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

/** A standalone loading indicator that stays legible over the dark scene: a
 *  contrasting capsule wrapping the spinner and an optional label. */
export function LoadingPill({ label = "Loading…", className }: { label?: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-[color:var(--border-hover)] bg-[color:var(--surface-card)] px-3.5 py-1.5 text-xs font-medium text-[color:var(--text-secondary)] shadow-[0_6px_18px_var(--shadow-strong)]",
        className,
      )}
    >
      <Spinner className="size-3.5" />
      {label}
    </span>
  );
}

export function ErrorText({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <div
      role="alert"
      className="selectable flex items-start gap-2 rounded-lg border border-[color:var(--danger-border)] bg-[color:var(--danger-bg)] px-3 py-2.5 text-left text-xs leading-relaxed text-[color:var(--danger-text)]"
    >
      <AlertTriangle className="mt-px size-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

// A row of star glyphs (the Apogee mark) standing in for a hidden or
// not-yet-loaded numeric value, instead of dots/bullets.
export function HiddenValue({
  count = 5,
  size = 18,
  gap = 4,
  className,
}: {
  count?: number;
  size?: number;
  gap?: number;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center align-middle", className)} style={{ gap }}>
      {Array.from({ length: count }, (_, i) => (
        <svg key={i} width={size} height={size} viewBox="0 0 68 68" fill="none" aria-hidden="true">
          <path
            d="M61.8082 27.8143C49.871 27.8143 40.1735 18.1051 40.1735 6.17965C40.1735 2.77909 37.3945 0 33.9939 0C30.5933 0 27.8142 2.77909 27.8142 6.17965C27.8142 18.1168 18.1051 27.8143 6.17963 27.8143C2.77907 27.8143 0 30.5933 0 33.9939C0 37.3945 2.77907 40.1736 6.17963 40.1736C18.1168 40.1736 27.8142 49.8827 27.8142 61.8082C27.8142 65.2087 30.5933 67.9878 33.9939 67.9878C37.3945 67.9878 40.1735 65.2087 40.1735 61.8082C40.1735 49.871 49.8827 40.1736 61.8082 40.1736C65.2087 40.1736 67.9878 37.3945 67.9878 33.9939C67.9878 30.5933 65.2087 27.8143 61.8082 27.8143Z"
            fill="currentColor"
          />
        </svg>
      ))}
    </span>
  );
}

/** Amount rendered in the telemetry face (see theme.css). `glow` adds the
 *  phosphor ink + halo — reserved for the hero balance; list rows pass
 *  glow={false} and inherit their context color. Digits 0 and 2–9 share one
 *  advance width in Apogee Telemetry, so the typewriter grid of the source
 *  lettering comes for free; only the "1" is narrow (0.52ch, both widths). It
 *  gets a 0.7ch cell — enough padding to keep a hint of the grid without
 *  reading as a gap next to the wide digits. */
export function TelemetryNumber({
  value,
  wide = false,
  glow = true,
  className,
}: {
  value: string;
  wide?: boolean;
  glow?: boolean;
  className?: string;
}) {
  // Letter runs — currency prefixes (the A in A$, CHF) and unit suffixes
  // (asset tickers) — render smaller via .telemetry-unit so they read as
  // symbols next to the digits; sign glyphs ($, £, ¥, €) keep full size (the
  // face's ¥ and € come from our font patch, see tools/patch-telemetry-font.py).
  const segments = value.split(/([A-Za-z]+)/);
  return (
    <span
      className={cn(wide ? "font-telemetry-wide" : "font-telemetry", glow && "telemetry-glow", className)}
    >
      {segments.map((seg, si) =>
        /^[A-Za-z]/.test(seg) ? (
          <span key={si} className="telemetry-unit">
            {seg}
          </span>
        ) : (
          Array.from(seg).map((ch, i) =>
            ch === "1" ? (
              <span key={`${si}-${i}`} className="inline-block w-[0.7ch] text-center">
                1
              </span>
            ) : (
              ch
            ),
          )
        ),
      )}
    </span>
  );
}

// Centered entry-screen layout (onboarding choose + unlock): the large Apogee
// lockup above a title/subtitle, with the screen's actions below.
export function WelcomeShell({
  title,
  subtitle,
  children,
}: {
  title?: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-5 py-8">
      <img src="/icons/apogee-logo.svg" alt="Apogee" className="h-12 w-auto" />
      <div className="flex flex-col gap-1.5 text-center">
        {title && <h1 className="text-lg font-semibold text-[color:var(--text-strong)]">{title}</h1>}
        <p className="text-sm text-[color:var(--text-secondary)]">{subtitle}</p>
      </div>
      <div className="w-full">{children}</div>
    </div>
  );
}

export function IconButton({
  label,
  onClick,
  disabled,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn("icon-btn size-8", className)}
    >
      {children}
    </button>
  );
}

export function CopyButton({
  value,
  label = "Copy",
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    [],
  );
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          return; // clipboard blocked/failed — don't show a misleading "Copied"
        }
        setCopied(true);
        if (timer.current != null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

/** Compact copy control for inline value rows (asset ids, txids): a ghost icon
 *  that flips to a success check for a moment after copying. The big CopyButton
 *  stays for deliberate primary actions (address, seed phrase). */
export function CopyIconButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          return; // clipboard blocked/failed — don't show a misleading check
        }
        setCopied(true);
        if (timer.current != null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1500);
      }}
      className="icon-btn size-6 shrink-0"
    >
      {copied ? (
        <Check size={13} className="text-[color:var(--success-text)]" />
      ) : (
        <Copy size={13} />
      )}
    </button>
  );
}

// Centered dialog overlay. Closes on backdrop click or Esc. Used for one-off
// notices (e.g. the Firefox hardware-wallet limitation) where a full step would
// be heavier than needed.
export function Modal({
  open,
  onClose,
  title,
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** Optional heading rendered at the top. Omit to place the heading inside
   *  `children` (e.g. below an illustration). Still used for the dialog's
   *  accessible name when provided. */
  title?: string;
  /** Accessible name for the dialog when `title` is omitted (i.e. the heading
   *  lives inside `children`). Ignored when `title` is set. */
  label?: string;
  children: ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  // Read onClose through a ref so the effect can key on `open` alone: an inline
  // onClose (new identity each render) would otherwise re-run the effect and
  // bounce focus/re-subscribe the listener on every parent render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    // Move focus into the dialog on open (so screen readers announce it and Esc
    // works), and restore it to the trigger on close.
    const prevFocus = document.activeElement as HTMLElement | null;
    cardRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prevFocus?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title ?? label}
        className="w-full max-w-sm rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--surface-elevated)] p-5 shadow-lg shadow-black/40 focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {title && <h2 className="text-lg font-semibold text-[color:var(--text-strong)]">{title}</h2>}
        <div className={cn(title && "mt-3", "space-y-3 text-sm text-[color:var(--text-secondary)]")}>
          {children}
        </div>
      </div>
    </div>
  );
}
