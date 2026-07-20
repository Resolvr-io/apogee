// Custom asset-picker dropdown. Native <select>/<option> can't render images,
// so this is a console-styled button + popover: each row shows the asset icon
// (bundled, registry, or monogram fallback) next to its label. Matches the
// console-select look (h-11, same border/bg, phosphor focus ring, chevron) and
// supports keyboard nav (arrows/enter/esc) and click-outside-to-close.

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { LiquidNetwork } from "@/keystore/keystore";
import { AssetIcon } from "@/sidepanel/components/AssetIcon";
import { cn } from "@/lib/utils";

export interface AssetOption {
  id: string;
  label: string;
}

export function AssetSelect({
  options,
  value,
  network,
  onChange,
}: {
  options: AssetOption[];
  value: string;
  network: LiquidNetwork;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Seed the highlight on the selected option when opening.
  useEffect(() => {
    if (!open) return;
    const i = options.findIndex((o) => o.id === value);
    setActive(i >= 0 ? i : 0);
  }, [open, options, value]);

  function choose(id: string) {
    onChange(id);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = options[active];
      if (o) choose(o.id);
    }
  }

  const selected = options.find((o) => o.id === value) ?? options[0];

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="console-select flex h-11 w-full items-center gap-2 rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] px-3 text-left text-sm text-[color:var(--text-strong)] outline-none focus:border-[color:var(--accent)]"
      >
        {selected && <AssetIcon assetId={selected.id} label={selected.label} network={network} />}
        <span className="min-w-0 flex-1 truncate">{selected?.label}</span>
        <ChevronDown
          size={14}
          className={cn(
            "shrink-0 text-[color:var(--text-subtle)] transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-md border border-[color:var(--border-strong)] bg-[color:var(--surface-elevated)] py-1 shadow-lg shadow-black/40"
        >
          {options.map((o, i) => (
            <li key={o.id} role="option" aria-selected={o.id === value}>
              <button
                type="button"
                onClick={() => choose(o.id)}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
                  i === active && "bg-[color:var(--surface-soft)]",
                )}
              >
                <AssetIcon assetId={o.id} label={o.label} network={network} />
                <span className="min-w-0 flex-1 truncate text-[color:var(--text-strong)]">
                  {o.label}
                </span>
                {o.id === value && <Check size={14} className="shrink-0 text-[color:var(--accent)]" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
