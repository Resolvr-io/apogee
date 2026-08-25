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
import { digitCycle } from "@/sidepanel/digit-cycle";

type Variant = "primary" | "secondary" | "ghost" | "danger";

// Console-panel buttons: uppercase, letterspaced labels (Satoshi — the
// telemetry face is too thin for small bright fills). Primary reads as a lit
// lamp cell (inset top bevel + a faint phosphor halo); secondary is a quiet
// translucent console cell.
const VARIANTS: Record<Variant, string> = {
  primary:
    "border border-[color:var(--accent)] bg-[linear-gradient(180deg,var(--accent-strong)_0%,var(--accent)_100%)] text-[color:var(--text-on-accent)] shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_8px_20px_var(--shadow-soft),0_0_14px_color-mix(in_srgb,var(--accent)_28%,transparent)] transition-shadow duration-300 hover:brightness-110 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_8px_20px_var(--shadow-soft),0_0_22px_color-mix(in_srgb,var(--accent-bright)_50%,transparent),0_0_40px_color-mix(in_srgb,var(--accent-bright)_20%,transparent)]",
  secondary:
    "border border-[color:var(--border-default)] bg-[color:color-mix(in_srgb,var(--surface-soft)_66%,transparent)] text-[color:var(--text-soft)] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--accent-strong)_10%,transparent)] transition-shadow duration-300 hover:border-[color:var(--border-hover)] hover:text-[color:var(--text-strong)] hover:shadow-[inset_0_1px_0_color-mix(in_srgb,var(--accent-strong)_10%,transparent),0_0_18px_color-mix(in_srgb,var(--accent-bright)_35%,transparent),0_0_36px_color-mix(in_srgb,var(--accent-bright)_14%,transparent)]",
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

/**
 * Split an amount string into the figure and its trailing unit label.
 *
 * A ticker (`USDt`, `sats`, `LBTC`, `Tether USD`) is a label rather than a figure,
 * so `TelemetryNumber` renders it outside the telemetry span, where it inherits the
 * row's own font. That is what makes it identical to the token row's asset label,
 * and it keeps the telemetry face's lowercase 't' — a bare cross that reads as a
 * dagger at label size — out of a ticker.
 *
 * The ticker is the trailing run of whitespace-separated words after the figure,
 * where every word starts with a letter and contains only letters and digits. Each
 * clause is load-bearing:
 *
 *   - Anchored on the FIGURE, not on the last whitespace, and the `.*?` is LAZY.
 *     The engine takes the earliest split that yields a valid tail, so the ticker
 *     is the LONGEST trailing run of words — which is what makes `USDT base units`
 *     come out whole instead of just `units`. Anchoring on the last space (or
 *     making this greedy) splits a multi-word label: `1,234 Tether USD` would keep
 *     "Tether" inside the telemetry span and send only "USD" to the body face,
 *     spreading one label across two treatments.
 *   - Every word must START with a letter, which keeps a currency prefix (the A in
 *     A$, or CHF) in the figure where its geometry is tuned.
 *   - Words may contain ONLY letters and digits, which keeps an unregistered
 *     asset's shortened id out of this path: `tokenAmountText` falls back to
 *     shortenHex(id) — `1a2b…c3d4` — whose ellipsis fails the test, so the id
 *     stays whole in the telemetry face rather than being split mid-token.
 *
 * Know where that last clause draws the line: a label carrying anything but
 * letters, digits and single spaces stays WHOLLY in the figure. `USDC.e`, `L-BTC`,
 * `Tether USD (Wormhole)` and `Token 2049` all fall out of the ticker path on the
 * punctuation or the trailing numeral. That matches the behavior before this rule
 * existed, and those letters at least render at full size (see the prefix-only
 * note where .telemetry-unit is applied) — but it is a boundary, not a bug, and
 * registry-supplied names carry punctuation routinely.
 *
 * The prefix/suffix split assumes a prefixing locale, which holds because
 * formatFiat pins en-US (see lib/format.ts). Under a suffixing locale
 * (`1.234,50 CHF`) the code would classify as a ticker and drop out of the
 * telemetry face — worth knowing before any localization pass.
 *
 * Exported for the table test in ui.test.ts; this rule has been rewritten once
 * already and the rewrite changed behavior for an input nobody had enumerated.
 */
export function splitFigureAndTicker(value: string): { figure: string; ticker: string } {
  const m = /^(.*?\d\S*)(\s+)((?:[A-Za-z][A-Za-z0-9]*)(?:\s+[A-Za-z][A-Za-z0-9]*)*)$/.exec(value);
  if (!m) return { figure: value, ticker: "" };
  // The separator is captured and kept on the figure rather than re-emitted as a
  // single space: `figure + ticker` must reconstruct the input exactly, or a
  // multi-space separator would silently lose a character on the way to the DOM.
  return { figure: m[1] + m[2], ticker: m[3] };
}

/**
 * Break a figure into runs and mark which letter runs are currency prefixes.
 *
 * Only a letter run that precedes the first digit counts — `.telemetry-unit`'s
 * geometry is derived from the telemetry `$`'s S body, so it means "part of a
 * compound currency symbol" (the A in A$, or CHF), not "letters". Letters that
 * FOLLOW digits are a different animal: an unregistered asset's shortened id, or a
 * label whose punctuation kept it out of the ticker path. Shrinking and raising
 * those spells `1a2b…c3d4` out in two sizes, so they render at full size.
 *
 * Exported and tested for the same reason `splitFigureAndTicker` is: it decides
 * typography silently, and three guards elsewhere depend on how it treats a
 * LEADING letter run — amounts lead with digits, Swap keeps placeholders out of
 * TelemetryNumber, and the version string is passed as `console` rather than
 * `amount`. If this rule drifts, those guards' rationale drifts with it and
 * nothing else would notice.
 */
export function figureSegments(
  figureText: string,
): Array<{ text: string; letters: boolean; prefix: boolean }> {
  let seenDigit = false;
  // split() with a capture group yields alternating non-letter / letter runs, so a
  // letter segment is always PURE letters — a digit can only appear in the others.
  return figureText.split(/([A-Za-z]+)/).map((text) => {
    const letters = /^[A-Za-z]/.test(text);
    const prefix = letters && !seenDigit;
    if (!letters) seenDigit ||= /\d/.test(text);
    return { text, letters, prefix };
  });
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
  warmup = false,
  className,
}: {
  value: string;
  wide?: boolean;
  glow?: boolean;
  // Play the neon strike once as these numerals appear (see .telemetry-digit).
  // Callers decide this via useBalanceStrike() (balance-warmup.ts); passing it
  // on every render would replay the flicker on every balance poll.
  warmup?: boolean;
  className?: string;
}) {
  // Letter runs before the digits — currency prefixes (the A in A$, CHF) —
  // render smaller via .telemetry-unit so they read as symbols next to the
  // figures; sign glyphs ($, £, ¥, €) keep full size (the face's ¥ and € come
  // from our font patch, see tools/patch-telemetry-font.py).
  const { figure: figureText, ticker } = splitFigureAndTicker(value);

  // Counts glyphs across segments so the beat sequence runs the whole figure
  // rather than restarting at each separator.
  let warmupIndex = 0;
  // The per-glyph beat as inline custom properties (see .telemetry-digit).
  const digitStyle = (index: number): React.CSSProperties => {
    const { delay, duration } = digitCycle(index);
    return {
      "--digit-delay": `${delay}ms`,
      "--digit-dur": `${duration}ms`,
    } as React.CSSProperties;
  };

  // `glow` covers the figure only: a ticker is a label, and the phosphor halo
  // belongs to the numerals. Nothing inlines a unit into a glow'd value today
  // (the hero balance carries its unit as a separate subtitle), so this is only
  // worth knowing if one ever does.
  const figureNode = (
    <span
      className={cn(
        wide ? "font-telemetry-wide" : "font-telemetry",
        glow && "telemetry-glow",
        // With no ticker this is the only element, so a caller's className stays
        // on it rather than moving to a wrapper — non-inherited properties
        // (padding, background, transform) would otherwise apply a level out.
        !ticker && className,
      )}
    >
      {figureSegments(figureText).map((seg, si) => {
        if (seg.letters) {
          // A currency prefix (the A in A$, CHF) is one compound symbol, so it
          // takes ONE beat of the warm-up rather than per-letter beats — it
          // strikes alongside the numerals it belongs to instead of sitting
          // lit while they stutter. Trailing letter runs (asset-id fragments)
          // stay static: they follow the figure rather than introducing it.
          const strikes = warmup && seg.prefix;
          if (!strikes) {
            return (
              <span key={si} className={seg.prefix ? "telemetry-unit" : undefined}>
                {seg.text}
              </span>
            );
          }
          return (
            <span
              key={si}
              className="telemetry-digit telemetry-unit"
              style={digitStyle(warmupIndex++)}
            >
              {seg.text}
            </span>
          );
        }
        return (
          Array.from(seg.text).map((ch, i) => {
            // The "1" cell (see the doc comment) is a span either way; warm-up
            // needs one around EVERY glyph so each can carry its own beat, and
            // separators come along so the whole figure strikes as one sign.
            const narrow = ch === "1";
            if (!warmup) {
              return narrow ? (
                <span key={`${si}-${i}`} className="inline-block w-[0.7ch] text-center">
                  1
                </span>
              ) : (
                ch
              );
            }
            return (
              <span
                key={`${si}-${i}`}
                className={cn(
                  "telemetry-digit",
                  narrow && "w-[0.7ch] text-center",
                )}
                style={digitStyle(warmupIndex++)}
              >
                {ch}
              </span>
            );
          })
        );
      })}
    </span>
  );

  if (!ticker) return figureNode;
  return (
    <span className={className}>
      {figureNode}
      <span>{ticker}</span>
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
