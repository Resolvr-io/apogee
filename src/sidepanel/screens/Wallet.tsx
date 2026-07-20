// Main wallet screen. A non-scrolling balance "frame" sits above a scrollable
// activity list and shrinks once the list is scrolled (the balance stays in
// view but compacts). Send/Receive live under the balance; a hide toggle swaps
// amounts for star glyphs; the balance pulses while syncing or when funds
// are still unconfirmed. Sending is stubbed until the tx-builder engine op.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowDownLeft,
  ArrowUp,
  ArrowUpRight,
  ChevronDown,
  ChevronLeft,
  ExternalLink,
  Eye,
  EyeOff,
  QrCode,
  RefreshCw,
  Telescope,
  Unplug,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import type { AssetInfo, ChainServerHealth, SyncResult, WalletTxDTO } from "@/engine/protocol";
import type { KeystoreState, LiquidNetwork, WalletInfo } from "@/keystore/keystore";
import { explorerTxUrl } from "@/lib/explorer";
import { APP_VERSION_DISPLAY } from "@/version";
import { KNOWN_ASSETS } from "@/lib/asset-registry";
import { DEBUG_ENTERPRISE_BUILD, DEBUG_ENTERPRISE_KEY } from "@/lib/debug";
import { DEMO_FUNDS_KEY, DEMO_SYNC, DEMO_TXS } from "@/lib/demo-funds";
import { cn, shortenHex } from "@/lib/utils";
import {
  formatAssetAmount,
  formatBtc,
  formatFiat,
  formatRelative,
  formatSats,
  formatTimestamp,
  satsToFiat,
} from "@/lib/format";
import {
  Button,
  Card,
  CopyButton,
  CopyIconButton,
  ErrorText,
  Field,
  HiddenValue,
  IconButton,
  Input,
  LoadingPill,
  Spinner,
  StatusDot,
  type StatusTone,
  Switch,
  TelemetryNumber,
} from "@/sidepanel/components/ui";
import { errMessage, unlockErrMessage, wallet } from "@/sidepanel/wallet-client";
import { AssetIcon } from "@/sidepanel/components/AssetIcon";
import { useAnimations } from "@/sidepanel/use-animations";
import { Send } from "@/sidepanel/screens/Send";
import type { ToastNotice } from "@/sidepanel/components/Toast";

export type View = "home" | "receive" | "send" | "settings";

const HIDE_KEY = "apogee:hideBalance";
const TX_PAGE = 25; // transactions rendered per lazy-load page
// Auto-hide a revealed seed phrase (and its QR) after this window, so the secret
// isn't left on screen if the user steps away.
const SEED_REVEAL_TIMEOUT_S = 30;

function useHideBalance(): [boolean, () => void] {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    void chrome.storage.local.get(HIDE_KEY).then((o) => setHidden(Boolean(o[HIDE_KEY])));
  }, []);
  const toggle = useCallback(() => {
    setHidden((h) => {
      const next = !h;
      void chrome.storage.local.set({ [HIDE_KEY]: next });
      return next;
    });
  }, []);
  return [hidden, toggle];
}

/** Debug builds: the Settings > Debug "Demo funds" toggle. Live-updating so
 *  flipping it applies without leaving the wallet screen. Always false outside
 *  debug builds. */
function useDemoFunds(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!DEBUG_ENTERPRISE_BUILD) return;
    void chrome.storage.local.get(DEMO_FUNDS_KEY).then((o) => setOn(o[DEMO_FUNDS_KEY] === true));
    const onChanged = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area === "local" && DEMO_FUNDS_KEY in changes) {
        setOn(changes[DEMO_FUNDS_KEY].newValue === true);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);
  return on;
}

type Denom = "btc" | "sats" | "fiat";
// Tap-to-cycle order — matches the Display settings dropdown (Sats > L-BTC > Fiat).
const DENOM_ORDER: Denom[] = ["sats", "btc", "fiat"];
const DENOM_KEY = "apogee:denomination";
const FIAT_KEY = "apogee:fiat";
const FIAT_OPTIONS = ["USD", "EUR", "GBP", "CAD", "AUD", "CHF", "JPY"];

function useFiat(): [string, (code: string) => void] {
  const [fiat, setFiat] = useState("USD");
  useEffect(() => {
    void chrome.storage.local.get(FIAT_KEY).then((o) => {
      if (typeof o[FIAT_KEY] === "string") setFiat(o[FIAT_KEY]);
    });
  }, []);
  const update = useCallback((code: string) => {
    setFiat(code);
    void chrome.storage.local.set({ [FIAT_KEY]: code });
  }, []);
  return [fiat, update];
}

function useDenomination(): [Denom, (d: Denom) => void, () => void] {
  // Sats by default — the balance is tap-to-cycle, and Display settings can set
  // it explicitly. Both write the same persisted key.
  const [denom, setDenom] = useState<Denom>("sats");
  useEffect(() => {
    void chrome.storage.local.get(DENOM_KEY).then((o) => {
      const v = o[DENOM_KEY];
      if (v === "btc" || v === "sats" || v === "fiat") setDenom(v);
    });
  }, []);
  const set = useCallback((d: Denom) => {
    setDenom(d);
    void chrome.storage.local.set({ [DENOM_KEY]: d });
  }, []);
  const cycle = useCallback(() => {
    setDenom((cur) => {
      const next = DENOM_ORDER[(DENOM_ORDER.indexOf(cur) + 1) % DENOM_ORDER.length];
      void chrome.storage.local.set({ [DENOM_KEY]: next });
      return next;
    });
  }, []);
  return [denom, set, cycle];
}

export function Wallet({
  state,
  view,
  onView,
  onToast,
  onReset,
}: {
  state: KeystoreState;
  view: View;
  onView: (v: View) => void;
  onToast: (n: ToastNotice) => void;
  onReset: () => void;
}) {
  const active = state.wallets.find((w) => w.id === state.activeWalletId) ?? state.wallets[0];
  // Watch-only wallets have no key/signer: track balance + receive, but no Send.
  const watchOnly = active.signer === "watch";
  const [watchInfo, setWatchInfo] = useState(false); // watch-only explainer modal
  // Asset preselected for the Send screen (set when launching from a token row).
  const [sendAssetId, setSendAssetId] = useState<string | null>(null);
  const [hidden, toggleHidden] = useHideBalance();
  const [denom, setDenom, cycleDenom] = useDenomination();
  const [fiat, setFiat] = useFiat();
  const [rate, setRate] = useState<number | null>(null);
  const [rateFailed, setRateFailed] = useState(false);
  // BTC→USD rate, fetched only when a USD-pegged token is held and the display
  // currency isn't USD — it converts the peg into the chosen fiat
  // (peggedFiat = units × rate/rateUsd). USD display needs no conversion.
  const [rateUsd, setRateUsd] = useState<number | null>(null);
  const [liveSync, setSync] = useState<SyncResult | null>(null);
  const [liveTxs, setTxs] = useState<WalletTxDTO[]>([]);
  const [liveAssets, setAssets] = useState<Record<string, AssetInfo>>({});
  // Debug demo funds: present the canned dataset instead of live data
  // (display-only; polling continues underneath and resumes on toggle-off).
  // Demo tokens are KNOWN_ASSETS, so label/precision/icon need no fetches.
  const demoFunds = useDemoFunds();
  const sync = demoFunds ? DEMO_SYNC : liveSync;
  const txs = demoFunds ? DEMO_TXS : liveTxs;
  const assets = demoFunds ? {} : liveAssets;
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(TX_PAGE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setRate(null);
    setRateFailed(false);
    wallet
      .getRate(fiat)
      .then((r) => alive && setRate(r))
      .catch(() => alive && setRateFailed(true));
    return () => {
      alive = false;
    };
  }, [fiat]);

  const holdsPeggedToken = Boolean(
    sync &&
      Object.entries(sync.balance).some(
        ([a, amt]) => a !== sync.policyAssetHex && amt > 0 && KNOWN_ASSETS[a]?.pegUsd,
      ),
  );
  useEffect(() => {
    if (fiat === "USD" || !holdsPeggedToken) {
      setRateUsd(null);
      return;
    }
    let alive = true;
    wallet
      .getRate("USD")
      .then((r) => alive && setRateUsd(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [fiat, holdsPeggedToken]);
  // 1 USD in the display currency, or null when unknown/not needed.
  const usdToFiat = fiat === "USD" ? 1 : rate != null && rateUsd != null ? rate / rateUsd : null;

  // `silent` background refreshes (the auto-poll / tab-focus) update balance and
  // activity without flashing the sync spinner or surfacing transient errors.
  // Returns the sync result so the settle poll can detect when the balance moves.
  const refresh = useCallback(
    async (silent = false): Promise<SyncResult | null> => {
      if (!active) return null;
      if (!silent) setSyncing(true);
      if (!silent) setError("");
      try {
        const result = await wallet.sync(active.id);
        const transactions = await wallet.getTransactions(active.id);
        setSync(result);
        setTxs(transactions);
        return result;
      } catch (e) {
        if (!silent) setError(errMessage(e));
        return null;
      } finally {
        if (!silent) setSyncing(false);
      }
    },
    [active],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // After a tx lands, the new balance only appears once Esplora indexes it (a few
  // seconds for the mempool). One refresh tends to fire too early, so poll for a
  // window — stopping as soon as the balance moves off its pre-tx value — instead
  // of waiting on the 20s tick. Keeps Apogee in step with the connected dapp.
  const balanceRef = useRef<number | null>(null);
  useEffect(() => {
    balanceRef.current = sync?.lbtcSats ?? null;
  }, [sync]);
  const settleTimer = useRef<number | null>(null);
  const settleAfterTx = useCallback(() => {
    if (settleTimer.current != null) window.clearTimeout(settleTimer.current);
    const baseline = balanceRef.current;
    let polls = 0;
    const tick = async () => {
      const result = await refresh(true);
      polls += 1;
      if ((result && result.lbtcSats !== baseline) || polls >= 12) {
        settleTimer.current = null;
        return;
      }
      settleTimer.current = window.setTimeout(tick, 5000);
    };
    void tick();
  }, [refresh]);

  useEffect(
    () => () => {
      if (settleTimer.current != null) window.clearTimeout(settleTimer.current);
    },
    [],
  );

  // Auto-refresh so sent/received funds appear without a manual sync: poll every
  // 20s and whenever the side panel regains focus.
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      if (!document.hidden) void refresh(true);
    };
    const id = setInterval(tick, 20_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [active, refresh]);

  // A send (this wallet's own, or a dapp's) broadcasts this when it lands; poll
  // until the balance settles instead of waiting for the 20s tick.
  useEffect(() => {
    const onMsg = (msg: unknown) => {
      if (msg && typeof msg === "object" && (msg as { type?: string }).type === "apogee/balance-changed") {
        settleAfterTx();
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, [settleAfterTx]);

  // Best-effort: resolve names/tickers for unknown token assets from the
  // registry (known assets + L-BTC are skipped; failures leave a hex fallback).
  useEffect(() => {
    if (!sync || !active) return;
    const ids = Object.entries(sync.balance)
      .filter(([a, amt]) => a !== sync.policyAssetHex && amt > 0 && !(a in KNOWN_ASSETS) && !(a in assets))
      .map(([a]) => a);
    if (ids.length === 0) return;
    let alive = true;
    void (async () => {
      const fetched: Record<string, AssetInfo> = {};
      for (const id of ids) {
        try {
          fetched[id] = await wallet.getAsset(id, active.network);
        } catch {
          // ignore — UI falls back to the hex id
        }
      }
      if (alive && Object.keys(fetched).length > 0) {
        setAssets((prev) => ({ ...prev, ...fetched }));
      }
    })();
    return () => {
      alive = false;
    };
  }, [sync, assets, active]);

  // Switching wallets: reset the lazy-load window and clear the prior wallet's
  // balance/activity so its data never bleeds into the new one (and the tx
  // detector below re-seeds against the new wallet instead of toasting it).
  const seenTxids = useRef<Set<string> | null>(null);
  useEffect(() => {
    setVisible(TX_PAGE);
    setSync(null);
    setTxs([]);
    seenTxids.current = null;
  }, [active?.id, demoFunds]);

  // Toast on transactions the user hasn't seen yet. The first synced load seeds
  // the "seen" set silently (so historical activity doesn't fire); every later
  // sync diffs against it and toasts the newest change as Received / Sent.
  useEffect(() => {
    if (!sync) return; // wait for the first completed sync
    if (seenTxids.current === null) {
      seenTxids.current = new Set(txs.map((t) => t.txid));
      return;
    }
    const seen = seenTxids.current;
    const fresh = txs.filter((t) => !seen.has(t.txid));
    if (fresh.length === 0) return;
    for (const t of fresh) seen.add(t.txid);
    const tx = fresh[0]; // newest only, so a batch of history doesn't stack toasts
    if (tx.balanceChange === 0) return;
    const received = tx.balanceChange > 0;
    const amt = Math.abs(tx.balanceChange);
    // Mirror the chosen denomination so the toast matches the balance/activity.
    const message =
      denom === "btc"
        ? `${formatBtc(amt)} L-BTC`
        : denom === "fiat" && rate != null
          ? formatFiat(satsToFiat(amt, rate), fiat)
          : `${formatSats(amt)} sats`;
    onToast({
      id: Date.now(),
      title: received ? "Received" : "Sent",
      message,
      kind: received ? "success" : "info",
    });
  }, [sync, txs, onToast, denom, rate, fiat]);

  // Render more transactions as the sentinel scrolls into view.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible((v) => v + TX_PAGE);
      },
      { root, rootMargin: "150px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [visible, txs.length]);

  if (!active) return null;

  if (view !== "home") {
    return (
      <SubView
        title={titleFor(view)}
        onBack={() => onView("home")}
        center={view === "receive" || view === "send"}
      >
        {view === "receive" && (
          <>
            <Receive walletId={active.id} />
            {/* Easy return without hunting for the small top-left back arrow. */}
            <Button variant="secondary" className="mt-3 w-full" onClick={() => onView("home")}>
              Done
            </Button>
          </>
        )}
        {view === "send" && (
          <Send
            sync={sync}
            assets={assets}
            initialAssetId={sendAssetId ?? undefined}
            network={active.network}
            // Enter in BTC when that's the chosen denomination; sats otherwise
            // (incl. fiat — the hero shows sats alongside the fiat figure).
            // Applies to L-BTC only — tokens enter in their own precision.
            unit={denom === "btc" ? "btc" : "sats"}
            // A Jade wallet signs on-device in a tab; the Send UI cues the user.
            isJade={active.signer === "jade"}
            onDone={() => {
              setSendAssetId(null);
              // The send already broadcasts apogee/balance-changed, which drives the
              // settle poll; no extra refresh needed here.
              onView("home");
            }}
          />
        )}
        {view === "settings" && (
          <SettingsBody
            wallet={active}
            fiat={fiat}
            onFiatChange={setFiat}
            denom={denom}
            onDenomChange={setDenom}
            onReset={onReset}
          />
        )}
      </SubView>
    );
  }

  const hasUnconfirmed = txs.some((t) => t.height === null);
  const pulse = syncing || hasUnconfirmed;

  // Main balance presentation, driven by the tap-to-cycle denomination.
  const sats = sync ? sync.lbtcSats : 0;
  const showStars = hidden || !sync;
  const unitLabel = denom === "sats" ? "sats" : denom === "fiat" ? fiat : "L-BTC";
  let amountNode: React.ReactNode;
  if (showStars) {
    amountNode = <HiddenValue count={5} size={16} gap={9} className="telemetry-stars" />;
  } else if (denom === "fiat") {
    amountNode =
      rate != null ? (
        <TelemetryNumber value={formatFiat(satsToFiat(sats, rate), fiat)} wide />
      ) : rateFailed ? (
        "—"
      ) : (
        <Spinner className="size-6" />
      );
  } else if (denom === "sats") {
    amountNode = <TelemetryNumber value={formatSats(sats)} wide />;
  } else {
    amountNode = <TelemetryNumber value={formatBtc(sats)} wide />;
  }
  let subtitle = unitLabel;
  if (!showStars && denom === "btc") {
    subtitle = `L-BTC · ${formatSats(sats)} sats`;
  } else if (!showStars && denom === "fiat") {
    subtitle = `${fiat} · ${formatSats(sats)} sats`;
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Balance frame — fixed above the scrollable activity list. No bottom
          padding: the activity list's pt-6 (which sizes its feather ramp) already
          supplies the gap below Send/Receive, so pb-5 here would double it. */}
      <div className="shrink-0 px-4 pt-6">
        <div className="flex items-center justify-between">
          <IconButton label={hidden ? "Show balance" : "Hide balance"} onClick={toggleHidden}>
            {hidden ? <EyeOff size={16} /> : <Eye size={16} />}
          </IconButton>
          <IconButton label="Sync" onClick={() => refresh()} disabled={syncing}>
            <RefreshCw size={16} className={syncing ? "animate-spin" : undefined} />
          </IconButton>
        </div>

        <button
          type="button"
          onClick={cycleDenom}
          // No point cycling the denomination while the amount is hidden (or not
          // yet synced) — the value is stars, so only the unit label would change.
          disabled={showStars}
          aria-label={showStars ? undefined : "Change denomination"}
          className={cn(
            "flex w-full flex-col items-center gap-0.5 py-4 text-[color:var(--text-strong)]",
            pulse && "animate-pulse",
          )}
        >
          <span className="flex h-9 items-center justify-center text-3xl">{amountNode}</span>
          {/* No denomination label while hidden — the unit is irrelevant when the
              amount is stars. A non-breaking space holds the line so toggling
              hide doesn't shift the Send/Receive row. */}
          <span className="font-telemetry text-xs uppercase tracking-wide text-[color:var(--text-subtle)]">
            {showStars ? " " : subtitle}
          </span>
        </button>

        <div className="mt-3 flex gap-2">
          {watchOnly ? (
            // Watch-only wallets hold no key: the Send slot becomes a dashed
            // marker that opens an explainer on tap (matches the button width).
            <button
              type="button"
              onClick={() => setWatchInfo(true)}
              aria-label="Why is there no Send?"
              className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-md border border-dashed border-[color:var(--border-hover)] px-4 text-[12.5px] font-semibold uppercase tracking-[0.08em] text-[color:var(--text-subtle)] transition hover:border-[color:var(--accent-strong)] hover:text-[color:var(--text-secondary)]"
            >
              <Telescope size={16} /> Watch-only
            </button>
          ) : (
            <Button
              className="flex-1"
              onClick={() => {
                setSendAssetId(null);
                onView("send");
              }}
            >
              <ArrowUp size={16} /> Send
            </Button>
          )}
          <Button variant="secondary" className="flex-1" onClick={() => onView("receive")}>
            <ArrowDown size={16} /> Receive
          </Button>
        </div>
      </div>

      {/* Scrollable activity list. Feathered top edge (matching the settings
          SubView) so rows dissolve as they scroll up instead of hard-cutting;
          pt-6 sizes the content to the 24px mask ramp so headings sit at full
          opacity at rest. */}
      <div
        ref={scrollRef}
        className="apogee-scrollbar apogee-feather-top flex-1 overflow-y-auto px-4 pb-4 pt-6"
      >
        <ErrorText>{error}</ErrorText>
        <Tokens
          sync={sync}
          hidden={hidden}
          assets={assets}
          network={active.network}
          fiat={fiat}
          usdToFiat={usdToFiat}
          onSend={
            watchOnly
              ? null
              : (id) => {
                  setSendAssetId(id);
                  onView("send");
                }
          }
        />
        <h2 className="mb-2 mt-3 px-1 console-overline console-ruled">
          Activity
        </h2>
        {txs.length === 0 ? (
          <p className="px-1 text-xs text-[color:var(--text-subtle)]">
            {syncing ? "Loading…" : "No transactions yet."}
          </p>
        ) : (
          <>
            <div className="apogee-panel divide-y divide-[color:var(--border-soft)] overflow-hidden rounded-xl border border-[color:var(--border-default)]">
              {txs.slice(0, visible).map((tx) => (
                <TxRow
                  key={tx.txid}
                  tx={tx}
                  hidden={hidden}
                  network={active.network}
                  assets={assets}
                  policyAssetHex={sync?.policyAssetHex}
                  denom={denom}
                  rate={rate}
                  fiat={fiat}
                />
              ))}
            </div>
            {visible < txs.length && (
              <div ref={sentinelRef} className="flex items-center justify-center py-4">
                <LoadingPill />
              </div>
            )}
          </>
        )}
      </div>

      {watchInfo && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-[color:var(--overlay)] p-4"
          onClick={() => setWatchInfo(false)}
        >
          <div className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <Card>
              <div className="flex flex-col items-center gap-3 py-2 text-center">
                <span className="flex size-12 items-center justify-center rounded-full bg-[color:var(--accent-soft)] text-[color:var(--accent-strong)]">
                  <Telescope size={24} />
                </span>
                <h2 className="text-lg font-semibold text-[color:var(--text-strong)]">
                  Watch-only wallet
                </h2>
                <p className="text-sm text-[color:var(--text-secondary)]">
                  Apogee holds no private keys for this wallet, so it can track and receive but not
                  send. To spend, open it in the wallet that holds its keys, or import the private
                  key into Apogee.
                </p>
                <Button variant="secondary" className="w-full" onClick={() => setWatchInfo(false)}>
                  Got it
                </Button>
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function Tokens({
  sync,
  hidden,
  assets,
  network,
  fiat,
  usdToFiat,
  onSend,
}: {
  sync: SyncResult | null;
  hidden: boolean;
  assets: Record<string, AssetInfo>;
  network: LiquidNetwork;
  fiat: string;
  usdToFiat: number | null; // 1 USD in the display currency (null = unknown)
  onSend: ((assetId: string) => void) | null; // null → no send affordance (watch-only)
}) {
  const tokens = sync
    ? Object.entries(sync.balance).filter(([a, amt]) => a !== sync.policyAssetHex && amt > 0)
    : [];
  if (tokens.length === 0) return null;
  return (
    <div className="mt-1">
      <h2 className="mb-2 px-1 console-overline console-ruled">
        Tokens
      </h2>
      <div className="apogee-panel divide-y divide-[color:var(--border-soft)] overflow-hidden rounded-2xl border border-[color:var(--border-default)]">
        {tokens.map(([asset, amt]) => {
          const info = assets[asset];
          const label =
            KNOWN_ASSETS[asset]?.label ?? info?.ticker ?? info?.name ?? shortenHex(asset, 6, 6);
          // Scale the raw base-unit balance by the asset's precision (e.g. a
          // precision-3 TEST balance of 1000 → "1.000"); unknown precision falls
          // back to the raw integer.
          const precision = KNOWN_ASSETS[asset]?.precision ?? info?.precision ?? null;
          const amountLabel = formatAssetAmount(amt, precision);
          // USD-pegged stablecoins show an approximate fiat value (1 unit ≈ $1,
          // converted into the display currency). Anything else has no price
          // source, so no figure is shown — honest over guessed.
          const fiatValue =
            KNOWN_ASSETS[asset]?.pegUsd && usdToFiat != null && precision != null
              ? (amt / 10 ** precision) * usdToFiat
              : null;
          return (
            <details
              key={asset}
              className="drawer"
            >
              <summary className="flex items-center justify-between px-3 py-2">
                <span className="flex items-center gap-2">
                  <AssetIcon assetId={asset} label={label} network={network} />
                  <span className="text-sm text-[color:var(--text-primary)]">{label}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="flex flex-col items-end">
                    <span className="text-[color:var(--text-strong)]">
                      {hidden ? (
                        <HiddenValue count={3} size={8} className="text-[color:var(--text-subtle)]" />
                      ) : (
                        <TelemetryNumber value={amountLabel} glow={false} />
                      )}
                    </span>
                    {!hidden && fiatValue != null && (
                      <span className="text-[11px] text-[color:var(--text-subtle)]">
                        ≈ {formatFiat(fiatValue, fiat)}
                      </span>
                    )}
                  </span>
                  <ChevronDown size={14} className="drawer-chevron text-[color:var(--text-subtle)]" />
                </span>
              </summary>
              <div className="flex flex-col gap-2 border-t border-[color:var(--border-soft)] px-3 py-2 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[color:var(--text-subtle)]">Asset ID</span>
                  {/* Middle-truncated to one line; hover shows the full id and the
                      copy button below carries the full value. */}
                  <span className="flex items-center gap-0.5">
                    <span title={asset} className="font-mono text-[color:var(--text-primary)]">
                      {shortenHex(asset, 10, 10)}
                    </span>
                    <CopyIconButton value={asset} label="Copy asset ID" />
                  </span>
                </div>
                {info?.name && <Row label="Name" value={info.name} />}
                {info?.ticker && <Row label="Ticker" value={info.ticker} />}
                {info?.precision != null && <Row label="Precision" value={String(info.precision)} />}
                {onSend && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-1 w-full"
                    onClick={() => onSend(asset)}
                  >
                    <ArrowUp size={14} /> Send {label}
                  </Button>
                )}
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}

function TxRow({
  tx,
  hidden,
  network,
  assets,
  policyAssetHex,
  denom,
  rate,
  fiat,
}: {
  tx: WalletTxDTO;
  hidden: boolean;
  network: LiquidNetwork;
  assets: Record<string, AssetInfo>;
  policyAssetHex?: string;
  denom: Denom;
  rate: number | null;
  fiat: string;
}) {
  // A token-only movement nets ~0 L-BTC, so the policy-asset delta reads as "+0".
  // Show the token delta instead (precision-scaled + ticker), mirroring the
  // desktop wallet's issuance/redemption rows.
  const token = Object.entries(tx.assetDeltas ?? {}).find(
    ([id, d]) => id !== policyAssetHex && d !== 0,
  );
  const receive = token ? token[1] > 0 : tx.balanceChange >= 0;
  const pending = tx.height === null;
  const explorer = explorerTxUrl(network, tx.txid);

  // L-BTC amount in the chosen denomination (mirrors the balance). Every formatter
  // preserves the sign, so the receive prefix carries over unchanged from sats.
  const lbtcAmount = (satsValue: number): string =>
    denom === "btc"
      ? formatBtc(satsValue)
      : denom === "fiat"
        ? rate != null
          ? formatFiat(satsToFiat(satsValue, rate), fiat)
          : "—"
        : formatSats(satsValue);
  const unitLabel = denom === "btc" ? "L-BTC" : denom === "fiat" ? fiat : "sats";

  let amountText: string;
  if (token) {
    const [id, delta] = token;
    const info = assets[id];
    const label = KNOWN_ASSETS[id]?.label ?? info?.ticker ?? info?.name ?? shortenHex(id, 4, 4);
    amountText = `${delta > 0 ? "+" : ""}${formatAssetAmount(delta, KNOWN_ASSETS[id]?.precision ?? info?.precision ?? null)} ${label}`;
  } else {
    amountText = `${receive ? "+" : ""}${lbtcAmount(tx.balanceChange)}`;
  }
  return (
    <details className="drawer">
      <summary className="flex items-center gap-2.5 px-3 py-2">
        <span
          aria-label={receive ? "Received" : "Sent"}
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full",
            receive
              ? "bg-[color:var(--success-bg)] text-[color:var(--success-text)]"
              : "bg-[color:var(--danger-bg)] text-[color:var(--danger-text)]",
          )}
        >
          {receive ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}
        </span>
        <span className="text-sm text-[color:var(--text-primary)]">{formatRelative(tx.timestamp)}</span>
        <span className="ml-auto flex items-center gap-2">
          <span className={cn("text-sm text-[color:var(--text-strong)]", pending && "animate-pulse")}>
            {hidden ? (
              <HiddenValue count={3} size={8} className="text-[color:var(--text-subtle)]" />
            ) : (
              <TelemetryNumber value={amountText} glow={false} />
            )}
          </span>
          <ChevronDown size={14} className="drawer-chevron text-[color:var(--text-subtle)]" />
        </span>
      </summary>
      <div className="flex flex-col gap-2 border-t border-[color:var(--border-soft)] px-3 py-2 text-xs">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[color:var(--text-subtle)]">Txid</span>
          {/* Middle-truncated to one line; hover shows the full txid and the
              copy control carries the full value. */}
          <span className="flex items-center gap-0.5">
            <span title={tx.txid} className="font-mono text-[color:var(--text-primary)]">
              {shortenHex(tx.txid, 10, 10)}
            </span>
            <CopyIconButton value={tx.txid} label="Copy txid" />
            {explorer && (
              <a
                href={explorer}
                target="_blank"
                rel="noreferrer"
                title="View in explorer"
                aria-label="View in explorer"
                className="icon-btn size-6 shrink-0"
              >
                <ExternalLink size={13} />
              </a>
            )}
          </span>
        </div>
        <Row label="Time" value={formatTimestamp(tx.timestamp)} />
        <Row label="Status" value={pending ? "Unconfirmed" : `Block ${tx.height}`} />
        <Row
          label="Fee"
          value={denom === "fiat" ? lbtcAmount(tx.fee) : `${lbtcAmount(tx.fee)} ${unitLabel}`}
        />
      </div>
    </details>
  );
}

function Receive({ walletId }: { walletId: string }) {
  const [address, setAddress] = useState("");
  const [qr, setQr] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    wallet
      .getAddress(walletId)
      .then(async (r) => {
        if (!alive) return;
        setAddress(r.address);
        try {
          const uri = await wallet.qr(r.address);
          if (alive) setQr(uri);
        } catch {
          // QR is best-effort; the address + copy button still work without it.
        }
      })
      .catch((e) => alive && setError(errMessage(e)));
    return () => {
      alive = false;
    };
  }, [walletId]);

  return (
    <Card>
      <h2 className="mb-3 text-center console-overline console-ruled--center">
        Receive L-BTC & assets
      </h2>
      {error ? (
        <ErrorText>{error}</ErrorText>
      ) : address ? (
        <div className="flex flex-col items-center gap-3">
          <div className="rounded-2xl bg-white p-3">
            <div className="relative size-44">
              {qr ? (
                <img src={qr} alt="Receive address QR" className="size-full [image-rendering:pixelated]" />
              ) : (
                <div className="flex size-full items-center justify-center">
                  <Spinner />
                </div>
              )}
              {qr && (
                <span className="absolute inset-0 m-auto flex size-8 items-center justify-center rounded-lg bg-white">
                  <img src="/icons/icon128.png" alt="" className="size-7 rounded-md" />
                </span>
              )}
            </div>
          </div>
          <p className="selectable w-full break-all rounded-lg border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] p-3 font-mono text-xs text-[color:var(--text-strong)]">
            {address}
          </p>
          <CopyButton value={address} label="Copy address" />
        </div>
      ) : (
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      )}
    </Card>
  );
}

const AUTO_LOCK_OPTIONS = [
  { label: "1 minute", minutes: 1 },
  { label: "5 minutes", minutes: 5 },
  { label: "15 minutes", minutes: 15 },
  { label: "30 minutes", minutes: 30 },
  { label: "1 hour", minutes: 60 },
  { label: "Never", minutes: 0 },
];

// Type-to-confirm word for the destructive full reset — a deliberate speed bump
// so the wallet can't be wiped with a single click.
const RESET_WORD = "RESET";

function SettingsBody({
  wallet: info,
  fiat,
  onFiatChange,
  denom,
  onDenomChange,
  onReset,
}: {
  wallet: WalletInfo;
  fiat: string;
  onFiatChange: (code: string) => void;
  denom: Denom;
  onDenomChange: (d: Denom) => void;
  onReset: () => void;
}) {
  const [password, setPassword] = useState("");
  const [seed, setSeed] = useState("");
  const [showQr, setShowQr] = useState(false);
  const [revealSecs, setRevealSecs] = useState(SEED_REVEAL_TIMEOUT_S);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [autoLock, setAutoLockState] = useState(15);
  const [resetConfirm, setResetConfirm] = useState("");
  const [resetting, setResetting] = useState(false);
  const [animated, setAnimated] = useAnimations();

  // Wipe the keystore + all app data on this device, then drop back to
  // onboarding. Funds stay on-chain, recoverable from the recovery phrase.
  async function doReset() {
    setResetting(true);
    try {
      await wallet.reset();
      onReset();
    } catch (err) {
      setError(errMessage(err));
      setResetting(false);
    }
  }

  useEffect(() => {
    void wallet.getAutoLock().then(setAutoLockState).catch(() => {});
  }, []);

  // Chain-server override (Advanced): "" (automatic) or a preset URL. The
  // stored value is re-read on load and after a failed save so the select
  // always reflects what is persisted. (Free-form custom URLs were removed —
  // planned to return inside a future debug panel; the SW/engine plumbing
  // still accepts any validated URL.)
  const [serverMode, setServerMode] = useState<string>("");
  const [serverBusy, setServerBusy] = useState(false);
  // Controlled so the health probe only runs while the drawer is open.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Debug builds: the enterprise toggle (see lib/debug.ts). Read/written straight
  // to chrome.storage — the SW checks the same key on every scan/broadcast.
  const [debugEnterprise, setDebugEnterprise] = useState(false);
  useEffect(() => {
    if (!DEBUG_ENTERPRISE_BUILD) return;
    void chrome.storage.local
      .get(DEBUG_ENTERPRISE_KEY)
      .then((o) => setDebugEnterprise(o[DEBUG_ENTERPRISE_KEY] === true));
  }, []);
  function toggleDebugEnterprise(on: boolean) {
    setDebugEnterprise(on);
    void chrome.storage.local.set({ [DEBUG_ENTERPRISE_KEY]: on });
  }
  const [demoFundsOn, setDemoFundsOn] = useState(false);
  useEffect(() => {
    if (!DEBUG_ENTERPRISE_BUILD) return;
    void chrome.storage.local
      .get(DEMO_FUNDS_KEY)
      .then((o) => setDemoFundsOn(o[DEMO_FUNDS_KEY] === true));
  }, []);
  function toggleDemoFunds(on: boolean) {
    setDemoFundsOn(on);
    void chrome.storage.local.set({ [DEMO_FUNDS_KEY]: on });
  }
  // Screenshot helper: hide the Debug card briefly. Plain component state, so
  // leaving and reopening Settings also brings it back (SettingsBody remounts).
  const [debugHidden, setDebugHidden] = useState(false);
  const debugHideTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (debugHideTimer.current != null) window.clearTimeout(debugHideTimer.current);
    },
    [],
  );
  function hideDebugPanel() {
    setDebugHidden(true);
    if (debugHideTimer.current != null) window.clearTimeout(debugHideTimer.current);
    debugHideTimer.current = window.setTimeout(() => setDebugHidden(false), 60_000);
  }
  const [serverMsg, setServerMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const chainPresets = chainPresetsFor(info.network);
  const loadChainServer = useCallback(() => {
    void wallet
      .getChainServer(info.network)
      .then((url) => {
        if (!url) {
          setServerMode("");
        } else if (chainPresetsFor(info.network).some((p) => p.url === url)) {
          setServerMode(url);
        } else {
          // A custom URL persisted by an older build: the picker is presets-only
          // now (custom entry is planned for a future debug panel), so clear it
          // rather than let an unrepresentable override keep steering scans.
          setServerMode("");
          void wallet.setChainServer(info.network, "").catch(() => {});
        }
      })
      .catch(() => {});
  }, [info.network]);
  useEffect(() => {
    loadChainServer();
  }, [loadChainServer]);

  async function saveChainServer(url: string) {
    setServerBusy(true);
    setServerMsg(null);
    try {
      await wallet.setChainServer(info.network, url);
      setServerMsg({ ok: true, text: url ? "Server saved." : "Back to automatic." });
    } catch (err) {
      setServerMsg({ ok: false, text: errMessage(err) });
      loadChainServer(); // snap the select back to what's actually persisted
    } finally {
      setServerBusy(false);
    }
  }

  // Once revealed, count down and auto-hide the seed (phrase + QR) so it isn't
  // left exposed. Cleared on unmount and whenever `seed` is reset (drawer close).
  useEffect(() => {
    if (!seed) return;
    setRevealSecs(SEED_REVEAL_TIMEOUT_S);
    const tick = window.setInterval(() => setRevealSecs((s) => Math.max(0, s - 1)), 1000);
    const hide = window.setTimeout(() => {
      setSeed("");
      setShowQr(false);
    }, SEED_REVEAL_TIMEOUT_S * 1000);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(hide);
    };
  }, [seed]);

  function changeAutoLock(minutes: number) {
    setAutoLockState(minutes);
    void wallet.setAutoLock(minutes).catch(() => {});
  }

  async function reveal(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setSeed(await wallet.revealMnemonic(info.id, password));
      setPassword("");
    } catch (err) {
      // Shares the unlock throttle (same password oracle) — translate its codes.
      setError(unlockErrMessage(err));
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  // Dapps connected via window.apogee. Refreshes on the SW's sites-changed broadcast.
  const [sites, setSites] = useState<string[]>([]);
  useEffect(() => {
    const load = () => void wallet.getConnectedSites().then(setSites).catch(() => {});
    load();
    const onMsg = (m: unknown) => {
      if (m && typeof m === "object" && (m as { type?: string }).type === "apogee/sites-changed") {
        load();
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);
  function revokeSite(origin: string) {
    setSites((s) => s.filter((o) => o !== origin));
    void wallet.disconnectSite(origin).catch(() => {});
  }

  return (
    <div className="flex min-h-full flex-col gap-3">
      <Card>
        <h2 className="mb-2 console-overline console-ruled">
          Wallet
        </h2>
        <dl className="flex flex-col gap-1 text-xs">
          <Row label="Label" value={info.label} />
          <Row label="Network" value={info.network} />
          <Row
            label="Signer"
            value={
              info.signer === "jade"
                ? "Blockstream Jade"
                : info.signer === "watch"
                  ? "Watch-only (no key)"
                  : "Local seed"
            }
          />
          <Row label="Fingerprint" value={info.fingerprint.toUpperCase()} console />
          <Row label="Version" value={`v${APP_VERSION_DISPLAY}`} console />
        </dl>
      </Card>

      {sites.length > 0 && (
        <Card>
          <h2 className="mb-2 console-overline console-ruled">
            Connected apps
          </h2>
          <ul className="flex flex-col gap-2">
            {sites.map((origin) => (
              <li key={origin} className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  <StatusDot tone="connected" />
                  <span className="truncate text-xs text-[color:var(--text-primary)]">{origin}</span>
                </span>
                <Button variant="secondary" size="sm" onClick={() => revokeSite(origin)}>
                  <Unplug size={14} /> Revoke
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <h2 className="mb-2 console-overline console-ruled">
          Display
        </h2>
        <div className="flex flex-col gap-3">
          <Field label="Denomination">
            <select
              value={denom}
              onChange={(e) => onDenomChange(e.target.value as Denom)}
              className="console-select h-11 w-full rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] px-3 text-sm text-[color:var(--text-strong)] outline-none focus:border-[color:var(--accent)]"
            >
              <option value="sats">Sats</option>
              <option value="btc">L-BTC</option>
              <option value="fiat">Fiat</option>
            </select>
          </Field>
          <Field label="Currency">
            <select
              value={fiat}
              onChange={(e) => onFiatChange(e.target.value)}
              className="console-select h-11 w-full rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] px-3 text-sm text-[color:var(--text-strong)] outline-none focus:border-[color:var(--accent)]"
            >
              {FIAT_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex items-center justify-between gap-3">
            <span className="flex flex-col">
              <span className="text-xs font-medium text-[color:var(--text-secondary)]">
                Background animation
              </span>
              <span className="text-[11px] text-[color:var(--text-subtle)]">
                Lock and intro screens only
              </span>
            </span>
            <Switch checked={animated} onChange={setAnimated} label="Background animation" />
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="mb-2 console-overline console-ruled">
          Security
        </h2>
        <Field label="Auto-lock after inactivity">
          <select
            value={autoLock}
            onChange={(e) => changeAutoLock(Number(e.target.value))}
            className="console-select h-11 w-full rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] px-3 text-sm text-[color:var(--text-strong)] outline-none focus:border-[color:var(--accent)]"
          >
            {AUTO_LOCK_OPTIONS.map((o) => (
              <option key={o.minutes} value={o.minutes}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      </Card>

      {info.signer === "local" && (
        <Card>
          {/* Collapsed by default to save space. Closing the drawer clears any
              revealed phrase and the password field, so re-revealing is a
              deliberate open + re-confirm. */}
          <details
            className="drawer"
            onToggle={(e) => {
              if (!e.currentTarget.open) {
                setSeed("");
                setPassword("");
                setError("");
                setShowQr(false);
              }
            }}
          >
            <summary className="flex cursor-pointer items-center justify-between">
              <span className="flex items-center gap-1.5 console-overline">
                <Eye size={13} />
                Reveal seed phrase
              </span>
              <ChevronDown size={14} className="drawer-chevron text-[color:var(--text-subtle)]" />
            </summary>
            <div className="mt-3">
              {seed ? (
                <div className="flex flex-col gap-2">
                  {showQr ? (
                    <div className="flex justify-center rounded-lg bg-white p-3">
                      <QRCodeSVG value={seed} size={180} level="M" />
                    </div>
                  ) : (
                    <p className="selectable break-words rounded-lg border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] p-3 font-mono text-xs text-[color:var(--text-strong)]">
                      {seed}
                    </p>
                  )}
                  <div className="mt-0.5 flex flex-col items-center gap-1.5">
                    <div className="flex items-baseline justify-center gap-2">
                      <span className="console-overline text-[10px] text-[color:var(--text-secondary)]">
                        Auto-hides in
                      </span>
                      <span className="font-telemetry telemetry-glow text-lg leading-none">{revealSecs}</span>
                      <span className="console-overline text-[10px] text-[color:var(--text-secondary)]">
                        sec
                      </span>
                    </div>
                    <div
                      className="h-[3px] w-full overflow-hidden rounded-full"
                      style={{ background: "color-mix(in srgb, var(--telemetry-halo) 14%, transparent)" }}
                    >
                      <div
                        className="h-full rounded-full transition-[width] duration-1000 ease-linear"
                        style={{
                          width: `${(revealSecs / SEED_REVEAL_TIMEOUT_S) * 100}%`,
                          background: "var(--telemetry-halo)",
                          boxShadow: "0 0 6px color-mix(in srgb, var(--telemetry-halo) 65%, transparent)",
                        }}
                      />
                    </div>
                  </div>
                  <CopyButton value={seed} label="Copy seed phrase" className="w-full" />
                  <Button variant="secondary" onClick={() => setShowQr((v) => !v)}>
                    <QrCode size={14} /> {showQr ? "Hide QR code" : "Show as QR code"}
                  </Button>
                </div>
              ) : (
                <form onSubmit={reveal} className="flex flex-col gap-2">
                  <Field label="Confirm password">
                    <Input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </Field>
                  <ErrorText>{error}</ErrorText>
                  <Button type="submit" variant="secondary" disabled={busy || !password}>
                    {busy ? <Spinner /> : "Reveal"}
                  </Button>
                </form>
              )}
            </div>
          </details>
        </Card>
      )}

      <Card>
        <details
          className="drawer"
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary className="flex cursor-pointer items-center justify-between">
            <span className="console-overline">Advanced</span>
            <ChevronDown size={14} className="drawer-chevron text-[color:var(--text-subtle)]" />
          </summary>
          <div className="mt-3 flex flex-col gap-2">
          <Field label="Chain server">
            <select
              value={serverMode}
              disabled={serverBusy}
              onChange={(e) => {
                const v = e.target.value;
                setServerMode(v);
                setServerMsg(null);
                void saveChainServer(v);
              }}
              className="console-select h-11 w-full rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] px-3 text-sm text-[color:var(--text-strong)] outline-none focus:border-[color:var(--accent)]"
            >
              <option value="">Automatic (recommended)</option>
              {chainPresets.map((p) => (
                <option key={p.url} value={p.url}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          {advancedOpen && <ChainServerStatus network={info.network} />}
          {serverBusy && (
            <p className="text-xs text-[color:var(--text-subtle)]">Checking server…</p>
          )}
          {serverMsg &&
            (serverMsg.ok ? (
              <p className="text-xs text-[color:var(--success-text)]">{serverMsg.text}</p>
            ) : (
              <ErrorText>{serverMsg.text}</ErrorText>
            ))}
          <p className="text-xs leading-relaxed text-[color:var(--text-subtle)]">
            Balances, history, and broadcasts use this server. Automatic picks the fastest
            available and falls back during outages.
          </p>
          </div>
        </details>
      </Card>

      {DEBUG_ENTERPRISE_BUILD && !debugHidden && (
        <Card className="border-dashed border-[color:color-mix(in_srgb,var(--accent-amber)_50%,transparent)]">
          <details className="drawer">
            <summary className="flex cursor-pointer items-center justify-between">
              <span className="console-overline text-[color:var(--warning-text)]">Debug</span>
              <ChevronDown size={14} className="drawer-chevron text-[color:var(--text-subtle)]" />
            </summary>
            <div className="mt-3 flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col">
              <span className="text-sm text-[color:var(--text-primary)]">Enterprise chain server</span>
              <span className="text-xs text-[color:var(--text-subtle)]">
                Local build only. Overrides the chain server above.
              </span>
            </div>
              <Switch
                checked={debugEnterprise}
                onChange={toggleDebugEnterprise}
                label="Enterprise chain server"
              />
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <div className="flex min-w-0 flex-col">
                <span className="text-sm text-[color:var(--text-primary)]">Demo funds</span>
                <span className="text-xs text-[color:var(--text-subtle)]">
                  Show an artificial balance and activity for screenshots.
                </span>
              </div>
              <Switch checked={demoFundsOn} onChange={toggleDemoFunds} label="Demo funds" />
            </div>
            <Button variant="secondary" size="sm" className="mt-3 w-full" onClick={hideDebugPanel}>
              Hide panel for one minute
            </Button>
          </details>
        </Card>
      )}

      <Card className="border-[color:var(--danger-border)]">
        {/* Collapsed by default — the reset controls only appear once the user
            opens the drawer, so a wipe takes a deliberate open + type-to-confirm. */}
        <details
          className="drawer"
          onToggle={(e) => {
            if (!e.currentTarget.open) setResetConfirm("");
          }}
        >
          <summary className="flex cursor-pointer items-center justify-between">
            <span className="flex items-center gap-1.5 console-overline text-[color:var(--danger-text)]">
              <AlertTriangle size={13} />
              Danger zone
            </span>
            <ChevronDown size={14} className="drawer-chevron text-[color:var(--text-subtle)]" />
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            <p className="text-xs leading-relaxed text-[color:var(--text-secondary)]">
              Reset Apogee — permanently delete this wallet and all app data on this device. Your
              funds stay on-chain and recoverable from your recovery phrase.
            </p>
            <Field label={`Type ${RESET_WORD} to confirm`}>
              <Input
                value={resetConfirm}
                onChange={(e) => setResetConfirm(e.target.value)}
                placeholder={RESET_WORD}
                autoCapitalize="characters"
                spellCheck={false}
              />
            </Field>
            <Button
              variant="danger"
              className="w-full"
              onClick={doReset}
              disabled={resetting || resetConfirm.trim().toUpperCase() !== RESET_WORD}
            >
              {resetting ? <Spinner /> : "Reset Apogee"}
            </Button>
          </div>
        </details>
      </Card>

      {/* Resolvr footer: masked monochrome wordmark stacked over the copyright.
          The bottom darkening gradient is global (App shell), so this stays
          legible over the moonlit-sea backdrop on every view. */}
      <footer className="-mx-4 -mb-4 mt-auto flex flex-col gap-2 px-4 pt-4 pb-5 text-[color:var(--text-muted)]">
        <div
          className="h-[28px] w-[92px] bg-current"
          style={{
            maskImage: "url(/icons/resolvr-logo.svg)",
            maskSize: "contain",
            maskRepeat: "no-repeat",
            WebkitMaskImage: "url(/icons/resolvr-logo.svg)",
            WebkitMaskSize: "contain",
            WebkitMaskRepeat: "no-repeat",
          }}
          role="img"
          aria-label="Resolvr"
        />
        <span className="text-xs">© 2026 Resolvr, Inc.</span>
      </footer>
    </div>
  );
}

// ---- shared bits ----

function SubView({
  title,
  onBack,
  center,
  children,
}: {
  title: string;
  onBack: () => void;
  center?: boolean;
  children: React.ReactNode;
}) {
  return (
    // min-h-0 lets the scroll container actually shrink + scroll inside the flex
    // column; without it the content overflows and the footer gets clipped.
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-4 py-3">
        <IconButton label="Back" onClick={onBack}>
          <ChevronLeft size={18} />
        </IconButton>
        <h1 className="console-title text-[13px]">{title}</h1>
      </div>
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto px-4 pb-4",
          center ? "flex flex-col justify-center" : "apogee-feather-top pt-6",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** Color-coded chain-server health badge for the Advanced drawer. Probes on
 *  open and every 30s while open; a manual re-check button sits at the right.
 *  In automatic mode a per-provider breakdown shows which fallback is carrying
 *  the load when the primary (Waterfalls, encrypted) is down — the headline
 *  distinguishes "On fallback server" from a plain "Slow". */
function ChainServerStatus({ network }: { network: LiquidNetwork }) {
  const [health, setHealth] = useState<ChainServerHealth | null>(null);
  const [probing, setProbing] = useState(true);

  const probe = useCallback(async () => {
    setProbing(true);
    try {
      setHealth(await wallet.probeChainServer(network));
    } catch {
      setHealth(null);
    } finally {
      setProbing(false);
    }
  }, [network]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const h = await wallet.probeChainServer(network);
        if (!cancelled) setHealth(h);
      } catch {
        if (!cancelled) setHealth(null);
      } finally {
        if (!cancelled) setProbing(false);
      }
    };
    void run();
    const id = window.setInterval(run, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [network]);

  const tone: StatusTone =
    health == null
      ? "idle"
      : health.status === "up"
        ? "connected"
        : health.status === "slow"
          ? "pending"
          : "error";

  // Headline: distinguish a primary outage riding on a fallback ("On fallback
  // server") from a merely slow primary ("Slow") — the single most useful thing
  // the badge can say during the exact outage it was built to diagnose.
  let headline: string;
  if (health == null) {
    headline = probing ? "Checking chain server…" : "Status unknown";
  } else if (health.status === "up") {
    headline = "Chain server connected";
  } else if (health.status === "down") {
    headline = "Unreachable";
  } else if (
    health.mode === "automatic" &&
    health.providers?.[0]?.status === "down" &&
    health.providers.slice(1).some((p) => p.status !== "down")
  ) {
    headline = "On fallback server";
  } else {
    headline = "Slow";
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] px-3 py-2">
      <div className="flex items-center gap-2">
        <StatusDot tone={tone} pulse={probing} />
        <span className="text-xs text-[color:var(--text-secondary)]">{headline}</span>
        {health?.latencyMs != null && (
          <span className="text-[11px] text-[color:var(--text-subtle)]">{health.latencyMs} ms</span>
        )}
        <button
          type="button"
          onClick={probe}
          disabled={probing}
          aria-label="Re-check chain server"
          className="ml-auto text-[color:var(--text-subtle)] transition-colors hover:text-[color:var(--text-primary)] disabled:opacity-50"
        >
          <RefreshCw size={13} className={probing ? "animate-spin" : undefined} />
        </button>
      </div>
      {health?.providers && health.providers.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-[color:var(--text-subtle)]">
            Automatic uses these servers
          </span>
          {health.providers.map((p, i) => {
            const ptone: StatusTone =
              p.status === "up" ? "connected" : p.status === "slow" ? "pending" : "error";
            // The first provider is the Waterfalls primary — the encrypted
            // default that isn't offered in the dropdown (pinning it would scan
            // it unencrypted, defeating its purpose).
            const isPrimary = i === 0;
            return (
              <div key={p.label} className="flex items-center gap-2">
                <StatusDot tone={ptone} />
                <span className="text-[11px] text-[color:var(--text-secondary)]">
                  {p.label}
                  {isPrimary && (
                    <span className="text-[color:var(--text-subtle)]"> · encrypted default</span>
                  )}
                </span>
                {p.latencyMs != null ? (
                  <span className="ml-auto text-[11px] text-[color:var(--text-subtle)]">
                    {p.status === "slow" ? "slow · " : ""}
                    {p.latencyMs} ms
                  </span>
                ) : (
                  <span className="ml-auto text-[11px] text-[color:var(--danger-text)]">down</span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {health?.mode === "pinned" && health.status === "down" && (
        <p className="text-[11px] leading-relaxed text-[color:var(--text-subtle)]">
          That server isn't responding. Switch to Automatic to use the fallbacks.
        </p>
      )}
    </div>
  );
}

/** Known-good Esplora presets for the Chain server setting, per network.
 *  Regtest gets none (localhost setups are custom by nature). */
function chainPresetsFor(network: LiquidNetwork): Array<{ label: string; url: string }> {
  switch (network) {
    case "liquid":
      return [
        { label: "Liquid.network", url: "https://liquid.network/api" },
        { label: "Blockstream.info", url: "https://blockstream.info/liquid/api" },
      ];
    case "liquidtestnet":
      return [
        { label: "Liquid.network", url: "https://liquid.network/liquidtestnet/api" },
        { label: "Blockstream.info", url: "https://blockstream.info/liquidtestnet/api" },
      ];
    case "regtest":
      return [];
  }
}

function Row({
  label,
  value,
  mono,
  console: consoleValue,
}: {
  label: string;
  value: string;
  mono?: boolean;
  console?: boolean; // telemetry-face readout (fingerprint, version)
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[color:var(--text-subtle)]">{label}</dt>
      <dd
        className={cn(
          "truncate text-[color:var(--text-primary)]",
          mono && "font-mono",
          consoleValue && "console-value text-[13px]",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function titleFor(view: View): string {
  return view === "receive" ? "Receive" : view === "send" ? "Send" : "Settings";
}
