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
  ArrowLeftRight,
  ArrowUp,
  ArrowUpRight,
  Activity,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Eye,
  EyeOff,
  Lock,
  QrCode,
  RefreshCw,
  Telescope,
  Unplug,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import type {
  AssetInfo,
  ChainServerHealth,
  PriceHistory,
  PriceRange,
  SyncResult,
  WalletTxDTO,
  WalletUtxoDTO,
} from "@/engine/protocol";
import { PriceChart } from "@/sidepanel/components/PriceChart";
import type { KeystoreState, LiquidNetwork, WalletInfo } from "@/keystore/keystore";
import { explorerAssetUrl, explorerTxUrl } from "@/lib/explorer";
import { APP_VERSION_DISPLAY } from "@/version";
import { STORE_LISTING_URL } from "@/lib/store-links";
import type { UpdateCheck } from "@/lib/version-check";
import { KNOWN_ASSETS } from "@/lib/asset-registry";
import { type Denom, assetRows, heroSubtitle, portfolioTotal } from "@/lib/portfolio";
import { DEBUG_ENTERPRISE_BUILD, DEBUG_ENTERPRISE_KEY } from "@/lib/debug";
import { DEMO_FUNDS_KEY, DEMO_SYNC, DEMO_TXS } from "@/lib/demo-funds";
import { cn, shortenHex } from "@/lib/utils";
import { browser } from "@/lib/ext";
import {
  formatAssetAmount,
  formatAssetAmountExact,
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
import { Swap } from "@/sidepanel/screens/Swap";
import type { ToastNotice } from "@/sidepanel/components/Toast";

export type View = "home" | "receive" | "send" | "swap" | "settings" | "coins";

const HIDE_KEY = "apogee:hideBalance";
const TX_PAGE = 25; // transactions rendered per lazy-load page
// Auto-hide a revealed seed phrase (and its QR) after this window, so the secret
// isn't left on screen if the user steps away.
const SEED_REVEAL_TIMEOUT_S = 30;

function useHideBalance(): [boolean, () => void] {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    void browser.storage.local.get(HIDE_KEY).then((o) => setHidden(Boolean(o[HIDE_KEY])));
  }, []);
  const toggle = useCallback(() => {
    setHidden((h) => {
      const next = !h;
      void browser.storage.local.set({ [HIDE_KEY]: next });
      return next;
    });
  }, []);
  return [hidden, toggle];
}

/** Debug builds: the Settings > Debug "Demo funds" toggle. Live-updating so
 *  flipping it applies without leaving the wallet screen. Always false outside
 *  debug builds. */
/**
 * A rate is only usable if it is a finite positive number.
 *
 * `priceFailed` is what gives the balance's "not final" pulse a terminal state,
 * and it was only ever set from `.catch` — so a `getRate` that *resolves* NaN or
 * 0 left `pricePending` true with nothing to end it, and the figure pulsed
 * forever. That is the exact failure the terminal state was added to prevent.
 * Not reachable through today's rate path, which throws rather than resolving
 * junk, but the guard costs nothing and the assumption is not enforced anywhere
 * upstream.
 */
function usableRate(r: number | null): number | null {
  return typeof r === "number" && Number.isFinite(r) && r > 0 ? r : null;
}

function useDemoFunds(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!DEBUG_ENTERPRISE_BUILD) return;
    void browser.storage.local.get(DEMO_FUNDS_KEY).then((o) => setOn(o[DEMO_FUNDS_KEY] === true));
    const onChanged = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area === "local" && DEMO_FUNDS_KEY in changes) {
        setOn(changes[DEMO_FUNDS_KEY].newValue === true);
      }
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, []);
  return on;
}

// Tap-to-cycle order — matches the Display settings dropdown (Sats > LBTC > Fiat).
const DENOM_ORDER: Denom[] = ["sats", "btc", "fiat"];
const DENOM_KEY = "apogee:denomination";
const FIAT_KEY = "apogee:fiat";
const FIAT_OPTIONS = ["USD", "EUR", "GBP", "CAD", "AUD", "CHF", "JPY"];

function useFiat(): [string, (code: string) => void] {
  const [fiat, setFiat] = useState("USD");
  useEffect(() => {
    void browser.storage.local.get(FIAT_KEY).then((o) => {
      if (typeof o[FIAT_KEY] === "string") setFiat(o[FIAT_KEY]);
    });
  }, []);
  const update = useCallback((code: string) => {
    setFiat(code);
    void browser.storage.local.set({ [FIAT_KEY]: code });
  }, []);
  return [fiat, update];
}

function useDenomination(): [Denom, (d: Denom) => void, () => void] {
  // Sats by default — the balance is tap-to-cycle, and Display settings can set
  // it explicitly. Both write the same persisted key.
  const [denom, setDenom] = useState<Denom>("sats");
  useEffect(() => {
    void browser.storage.local.get(DENOM_KEY).then((o) => {
      const v = o[DENOM_KEY];
      if (v === "btc" || v === "sats" || v === "fiat") setDenom(v);
    });
  }, []);
  const set = useCallback((d: Denom) => {
    setDenom(d);
    void browser.storage.local.set({ [DENOM_KEY]: d });
  }, []);
  const cycle = useCallback(() => {
    setDenom((cur) => {
      const next = DENOM_ORDER[(DENOM_ORDER.indexOf(cur) + 1) % DENOM_ORDER.length];
      void browser.storage.local.set({ [DENOM_KEY]: next });
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
  // Asset preselected for the Swap screen (set when launching from a token row).
  const [swapAssetId, setSwapAssetId] = useState<string | null>(null);
  const [hidden, toggleHidden] = useHideBalance();
  const [denom, setDenom, cycleDenom] = useDenomination();
  const [fiat, setFiat] = useFiat();
  const [rate, setRate] = useState<number | null>(null);
  const [rateFailed, setRateFailed] = useState(false);
  // Price trace. Collapsed by default; the history is fetched on first open and
  // whenever the range or currency changes, never on a timer.
  const [chartOpen, setChartOpen] = useState(false);
  const [chartRange, setChartRange] = useState<PriceRange>("24h");
  const [history, setHistory] = useState<PriceHistory | null>(null);
  const [chartError, setChartError] = useState(false);
  const [price24h, setPrice24h] = useState<number | null>(null);
  // BTC→USD rate, fetched only when a USD-pegged token is held and the display
  // currency isn't USD — it converts the peg into the chosen fiat
  // (peggedFiat = units × rate/rateUsd). USD display needs no conversion.
  const [rateUsd, setRateUsd] = useState<number | null>(null);
  // Terminal state for that fetch. Without it a wallet holding a pegged token
  // whose USD rate never arrives would pulse forever, which reads as a stuck sync.
  const [rateUsdFailed, setRateUsdFailed] = useState(false);
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
      .then((r) => {
        if (!alive) return;
        const usable = usableRate(r);
        if (usable === null) return setRateFailed(true);
        setRate(usable);
      })
      .catch(() => alive && setRateFailed(true));
    return () => {
      alive = false;
    };
  }, [fiat]);

  // 24h-ago price for the bar's delta — one ~148-byte point, so the always-visible
  // bar stays honest without pulling the full series on every wallet open. Runs
  // alongside the balance's spot-rate fetch; both are one-shot, never polled.
  useEffect(() => {
    let alive = true;
    setPrice24h(null);
    wallet
      .getPrice24hAgo(fiat)
      .then((p) => alive && setPrice24h(p))
      .catch(() => {}); // no delta is fine — the bar still shows the price
    return () => {
      alive = false;
    };
  }, [fiat]);

  /** 24h change for the bar. Prefers the open chart's own series when it's showing
   *  the 24h range, so the bar and the trace can't disagree by a refresh. */
  const barDelta = (() => {
    if (chartOpen && history && history.range === "24h" && history.points.length >= 2) {
      const f = history.points[0];
      const l = history.points[history.points.length - 1];
      return f > 0 ? ((l - f) / f) * 100 : null;
    }
    if (rate == null || price24h == null || price24h <= 0) return null;
    return ((rate - price24h) / price24h) * 100;
  })();

  // Lazy price-history fetch. Gated on `chartOpen`, so a collapsed chart issues no
  // request; the engine caches upstream, so re-opening or switching range inside the
  // TTL costs nothing further. Clearing `history` on range/currency change is what
  // shows the spinner instead of briefly drawing the previous window's trace.
  useEffect(() => {
    if (!chartOpen) return;
    let alive = true;
    setChartError(false);
    // Deliberately NOT clearing `history` first. The engine caches the whole series,
    // so a range change resolves in ~0ms — blanking to a spinner produced a visible
    // flash of nothing on every toggle. Keeping the old trace mounted lets the chart
    // cross-fade to the new one instead (see PriceChart's `points` transition).
    wallet
      .getPriceHistory(fiat, chartRange)
      .then((h) => alive && setHistory(h))
      .catch(() => alive && setChartError(true));
    return () => {
      alive = false;
    };
  }, [chartOpen, chartRange, fiat]);

  // BTC in USD. The display rate already IS it when the currency is USD, which is
  // why the dedicated fetch below skips that case. The peg is to USD, so valuing a
  // stablecoin needs this rate rather than the display-currency one.
  const btcUsd = fiat === "USD" ? rate : rateUsd;
  // The whole portfolio as one LBTC-denominated figure — see lib/portfolio.ts.
  const total = portfolioTotal({ sync, btcUsd });
  const holdsPeggedToken = total.holdsPegged;
  useEffect(() => {
    if (fiat === "USD" || !holdsPeggedToken) {
      setRateUsd(null);
      setRateUsdFailed(false);
      return;
    }
    let alive = true;
    setRateUsdFailed(false);
    wallet
      .getRate("USD")
      .then((r) => {
        if (!alive) return;
        const usable = usableRate(r);
        if (usable === null) return setRateUsdFailed(true);
        setRateUsd(usable);
      })
      .catch(() => alive && setRateUsdFailed(true));
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
    browser.runtime.onMessage.addListener(onMsg);
    return () => browser.runtime.onMessage.removeListener(onMsg);
  }, [settleAfterTx]);

  // Best-effort: resolve names/tickers for unknown token assets from the
  // registry (known assets + LBTC are skipped; failures leave a hex fallback).
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
        ? `${formatBtc(amt)} LBTC`
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
        // Coins is the only second-level screen (Settings → Coins); its back
        // returns to Settings. Every other subview is entered from Home.
        onBack={() => onView(view === "coins" ? "settings" : "home")}
        center={view === "receive" || view === "send" || view === "swap"}
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
            // Applies to LBTC only — tokens enter in their own precision.
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
        {view === "swap" && (
          <Swap
            sync={sync}
            assets={assets}
            network={active.network}
            unit={denom === "btc" ? "btc" : "sats"}
            initialSendAssetId={swapAssetId ?? undefined}
            onDone={() => {
              setSwapAssetId(null);
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
            onView={onView}
          />
        )}
        {view === "coins" && <Coins walletId={active.id} network={active.network} watchOnly={active.signer === "watch"} />}
      </SubView>
    );
  }

  const hasUnconfirmed = txs.some((t) => t.height === null);
  // A held token whose price hasn't landed means the figure is still settling —
  // reuse the existing "not final" affordance rather than inventing one.
  // `priceFailed` gives it a terminal state so it can't pulse forever.
  const priceFailed = fiat === "USD" ? rateFailed : rateUsdFailed;
  const pulse = syncing || hasUnconfirmed || (total.pricePending && !priceFailed);
  // Holdings the total can't account for: no price source at all, plus the
  // pegged ones whose rate fetch has given up.
  const missingCount = total.unpricedCount + (priceFailed ? total.pendingCount : 0);

  // Main balance presentation, driven by the tap-to-cycle denomination. The
  // figure is the whole portfolio in LBTC terms — one integer rendered three
  // ways, so the denominations cannot disagree.
  const sats = total.totalSats;
  const showStars = hidden || !sync;
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
  const subtitle = heroSubtitle({ denom, fiat, total, rate, missingCount });

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
          {/* nowrap for the same reason: the figure above is a fixed h-9, so a
              wrapped subtitle is the only way this block can change height. The
              line is longest when the balance is a total with a cross-denomination
              readout beside it (see heroSubtitle) — measured at 316px inside the
              328px frame for a 1,000-BTC balance with 9 unpriced assets, so the
              ellipsis only ever engages past that. Truncating is the right failure:
              it keeps the frame's height AND stops a long line spilling the panel. */}
          <span className="max-w-full truncate font-telemetry text-xs uppercase tracking-wide text-[color:var(--text-subtle)]">
            {showStars ? " " : subtitle}
          </span>
        </button>

        {/* Rate bar — always visible, the whole row is the expand control. The
            collapsed state costs no history request: the price comes from the spot
            rate the balance already fetched, and the delta from a single ~148-byte
            point. The full ~147 KB series is only pulled once expanded. */}
        {/* Deliberately unboxed: no border, no fill. A framed bar reads as a widget
            bolted into the panel, and the surrounding UI floats its readouts in space
            (see the balance subtitle above). Wide letter-spacing and generous gaps do
            the separating instead of a container. */}
        <button
          type="button"
          onClick={() => setChartOpen((o) => !o)}
          aria-expanded={chartOpen}
          aria-label={chartOpen ? "Hide price chart" : "Show price chart"}
          className="group flex w-full items-center justify-center gap-3 py-2 text-left"
        >
          <Activity
            size={12}
            className={cn(
              "shrink-0 transition-colors",
              chartOpen
                ? "text-[color:var(--accent-strong)]"
                : "text-[color:var(--text-subtle)] group-hover:text-[color:var(--text-secondary)]",
            )}
          />
          {/* Name the PAIR, not just BTC: the figure beside it is a BTC/fiat rate,
              not a property of Bitcoin. It also stops the reading depending on the
              currency symbol — CAD renders "CA$" and AUD "A$", so a bare "BTC $…"
              would be ambiguous between them and USD. */}
          <span className="font-telemetry text-[11px] uppercase tracking-[0.18em] text-[color:var(--text-subtle)]">
            BTC/{fiat}
          </span>
          {rate != null ? (
            <TelemetryNumber
              value={formatFiat(rate, fiat)}
              glow={false}
              className="text-xs tracking-wide text-[color:var(--text-secondary)]"
            />
          ) : (
            <span className="text-xs text-[color:var(--text-subtle)]">—</span>
          )}
          {barDelta != null && (
            <span
              className={cn(
                "text-[11px] tracking-wide",
                barDelta >= 0
                  ? "text-[color:var(--accent-mint)]"
                  : "text-[color:var(--accent-amber)]",
              )}
            >
              {barDelta >= 0 ? "▲" : "▼"} {Math.abs(barDelta).toFixed(2)}%
            </span>
          )}
          <ChevronDown
            size={12}
            className={cn(
              "shrink-0 text-[color:var(--text-subtle)] transition-transform group-hover:text-[color:var(--text-secondary)]",
              chartOpen && "rotate-180",
            )}
          />
        </button>
        {chartOpen && (
          <div className="pt-2">
            {chartError ? (
              // Say so in place rather than collapsing — a silent close looks broken.
              <p className="py-3 text-center text-xs text-[color:var(--text-subtle)]">
                Price history unavailable.
              </p>
            ) : history ? (
              <PriceChart
                history={history}
                range={chartRange}
                onRangeChange={setChartRange}
                formatPrice={(v) => formatFiat(v, fiat)}
              />
            ) : (
              <div className="flex justify-center py-6">
                <Spinner className="size-5" />
              </div>
            )}
          </div>
        )}

        <div className="mt-3 flex gap-2">
          {watchOnly ? (
            // Watch-only wallets hold no key: the Send slot becomes a dashed
            // marker that opens an explainer on tap.
            <button
              type="button"
              onClick={() => setWatchInfo(true)}
              aria-label="Why is there no Send?"
              title="Watch-only"
              className="inline-flex h-12 flex-1 items-center justify-center rounded-full border border-dashed border-[color:var(--border-hover)] text-[color:var(--text-subtle)] transition hover:border-[color:var(--accent-strong)] hover:text-[color:var(--text-secondary)]"
            >
              <Telescope size={18} />
            </button>
          ) : (
            <Button
              className="h-12 flex-1 rounded-full px-0"
              aria-label="Send"
              title="Send"
              onClick={() => {
                setSendAssetId(null);
                onView("send");
              }}
            >
              <ArrowUp size={18} strokeWidth={2.5} />
            </Button>
          )}
          {!watchOnly && (
            <Button
              variant="secondary"
              className="h-12 flex-1 rounded-full px-0"
              aria-label="Swap"
              title="Swap"
              onClick={() => onView("swap")}
            >
              <ArrowLeftRight size={18} strokeWidth={2.5} />
            </Button>
          )}
          <Button
            className="h-12 flex-1 rounded-full px-0"
            aria-label="Receive"
            title="Receive"
            onClick={() => onView("receive")}
          >
            <ArrowDown size={18} strokeWidth={2.5} />
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
          // Itemize L-BTC exactly when the hero stops being the L-BTC balance.
          // This is the same flag that makes the subtitle say "total", so the
          // headline and the list beneath it can never disagree about what the
          // headline is.
          itemizePolicyAsset={total.tokensIncluded}
          rate={rate}
          denom={denom}
          onSend={
            watchOnly
              ? null
              : (id) => {
                  setSendAssetId(id);
                  onView("send");
                }
          }
          onSwap={
            watchOnly
              ? null
              : (id) => {
                  setSwapAssetId(id);
                  onView("swap");
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
  itemizePolicyAsset,
  rate,
  denom,
  onSend,
  onSwap,
}: {
  sync: SyncResult | null;
  hidden: boolean;
  assets: Record<string, AssetInfo>;
  network: LiquidNetwork;
  fiat: string;
  usdToFiat: number | null; // 1 USD in the display currency (null = unknown)
  itemizePolicyAsset: boolean; // include L-BTC as a row — see the call site
  rate: number | null; // BTC in the display currency, for the L-BTC row's value
  denom: Denom; // L-BTC rows follow it; tokens stay in their own precision
  onSend: ((assetId: string) => void) | null; // null → no send affordance (watch-only)
  onSwap: ((assetId: string) => void) | null; // null → no swap affordance (watch-only)
}) {
  // Selection and order live in lib/portfolio.ts so the rule that keeps the hero
  // and this list in agreement is covered by tests. See `assetRows`.
  const rows = assetRows(sync, itemizePolicyAsset);
  if (rows.length === 0) return null;

  /**
   * L-BTC follows the denomination; tokens stay in their own precision.
   *
   * The whole point of the L-BTC row is that the hero can be read against its
   * parts, so rendering it in LBTC while the hero counts sats defeats it. Every
   * other L-BTC figure in the panel already honors the setting — `TxRow` takes
   * `denom`, Send and Swap take `unit={denom === "btc" ? "btc" : "sats"}` with
   * "Applies to LBTC only — tokens enter in their own precision". This matches
   * `TxRow` rather than Send/Swap, including fiat: those two collapse fiat to
   * sats because they are *input* fields and fiat entry is not supported, a
   * constraint a display list does not have.
   */
  const policyAmount = (amt: number): string =>
    denom === "btc"
      ? formatBtc(amt)
      : denom === "fiat"
        ? rate != null
          ? formatFiat(satsToFiat(amt, rate), fiat)
          : "—"
        : formatSats(amt);
  return (
    <div className="mt-1">
      {/* "Assets", not "Tokens": L-BTC is the policy asset rather than a token,
          and the heading has to stay true in both modes. */}
      <h2 className="mb-2 px-1 console-overline console-ruled">
        Assets
      </h2>
      <div className="apogee-panel divide-y divide-[color:var(--border-soft)] overflow-hidden rounded-2xl border border-[color:var(--border-default)]">
        {rows.map(([asset, amt]) => {
          const info = assets[asset];
          const isPolicy = asset === sync?.policyAssetHex;
          const assetExplorer = explorerAssetUrl(network, asset);
          const label =
            KNOWN_ASSETS[asset]?.label ?? info?.ticker ?? info?.name ?? shortenHex(asset, 6, 6);
          // Scale the raw base-unit balance by the asset's precision (e.g. a
          // precision-3 TEST balance of 1000 → "1.000"); unknown precision falls
          // back to the raw integer.
          const precision = KNOWN_ASSETS[asset]?.precision ?? info?.precision ?? null;
          const amountLabel = isPolicy ? policyAmount(amt) : formatAssetAmount(amt, precision);
          // USD-pegged stablecoins have an approximate fiat value (1 unit ≈ $1,
          // converted into the display currency). Anything else has no price
          // source, so no figure is shown — honest over guessed.
          //
          // L-BTC is the exception: its price is the display rate the whole panel
          // already runs on, so leaving its row valueless while a stablecoin
          // beside it shows one would be a gap with no reason behind it.
          const fiatValue = isPolicy
            ? rate != null
              ? satsToFiat(amt, rate)
              : null
            : KNOWN_ASSETS[asset]?.pegUsd && usdToFiat != null && precision != null
              ? (amt / 10 ** precision) * usdToFiat
              : null;
          // The fiat equivalent is shown only in the expandable drawer, not the
          // row summary: a summary line rendered in the body font beneath a
          // telemetry-font amount read as a typeface mix.
          return (
            <details
              key={asset}
              className="drawer"
            >
              <summary className="flex items-center justify-between px-3 py-2">
                {/* size-8 + gap-2.5 is deliberately the same icon size and gap the
                    activity rows use, so both lists share one left structure:
                    px-3 (12px) + 32px icon + 10px gap puts every label and
                    timestamp on the same 54px column, with the icons sharing both
                    a left edge and a center. Anything smaller here needs an offset
                    to compensate, and the compensation is what drifts. */}
                {/* min-w-0 + truncate: both children of this justify-between summary
                    default to min-width:auto, so text won't shrink below its content,
                    and the panel is overflow-hidden — an over-long label would push
                    into the amount and clip it rather than truncate itself. `label`
                    falls back to the registry's `info.name`, which is unbounded, and
                    the wider icon leaves it 12px less room. Same pattern as the
                    activity row and the asset-id row. */}
                <span className="flex min-w-0 items-center gap-2.5">
                  <AssetIcon
                    assetId={asset}
                    label={label}
                    network={network}
                    size="size-8"
                    // Keeps the glyph-to-disc ratio the default was drawn at — 10px
                    // in a 20px disc — now that the disc is 32px. Leaving the 10px
                    // default would fill 31% instead of 50% and read as an emptier
                    // circle than the icons beside it.
                    textSize="text-base"
                  />
                  <span className="truncate text-sm text-[color:var(--text-primary)]">{label}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="flex flex-col items-end">
                    <span className="text-sm text-[color:var(--text-strong)]">
                      {hidden ? (
                        <HiddenValue count={3} size={8} className="text-[color:var(--text-subtle)]" />
                      ) : (
                        <TelemetryNumber value={amountLabel} glow={false} />
                      )}
                    </span>
                    {/* No fiat line in the summary: it rendered in the body font
                        beneath a telemetry amount, so the two typefaces read as a
                        mix. The equivalent still lives in the expandable drawer
                        below (Value (<fiat>)). */}
                  </span>
                  <ChevronDown size={14} className="drawer-chevron text-[color:var(--text-subtle)]" />
                </span>
              </summary>
              <div className="flex flex-col gap-2 border-t border-[color:var(--border-soft)] px-3 py-2 text-xs">
                {/* Controls, not characters. The id used to render as 20 of its 64
                    hex digits, which is enough to verify an asset against a known
                    value at a glance — a real need, for developers, and nobody
                    else. It was also the widest thing in the drawer, so it is now
                    the label's tooltip: no width at all, and the whole id rather
                    than a truncation. The copy control cannot serve that purpose,
                    since its own tooltip has to say what the button does.
                    The pointer cursor is the only hint that hovering is worth it —
                    `cursor-help`'s question mark read as an offer of documentation
                    rather than of a value. */}
                <div className="flex items-center justify-between gap-3">
                  <span tabIndex={0} title={asset} className="cursor-pointer text-[color:var(--text-subtle)]">
                    Asset ID
                  </span>
                  <span className="flex items-center gap-0.5">
                    <CopyIconButton value={asset} label="Copy asset ID" />
                    {assetExplorer && (
                      <a
                        href={assetExplorer}
                        target="_blank"
                        rel="noreferrer"
                        title="View asset in explorer"
                        aria-label="View asset in explorer"
                        className="icon-btn size-6 shrink-0"
                      >
                        <ExternalLink size={13} />
                      </a>
                    )}
                  </span>
                </div>
                {/* The only place the fiat equivalent appears — the row summary no
                    longer carries one in any currency. Hidden while the balance is
                    hidden, so the drawer can't reveal what the row masks. */}
                {!hidden && fiatValue != null && (
                  <Row label={`Value (${fiat})`} value={`≈ ${formatFiat(fiatValue, fiat)}`} />
                )}
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
                {onSwap && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full"
                    onClick={() => onSwap(asset)}
                  >
                    <ArrowLeftRight size={14} /> Swap {label}
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
  // A token-only movement nets ~0 LBTC, so the policy-asset delta reads as "+0".
  // Show the token delta instead (precision-scaled + ticker), mirroring the
  // desktop wallet's issuance/redemption rows.
  const token = Object.entries(tx.assetDeltas ?? {}).find(
    ([id, d]) => id !== policyAssetHex && d !== 0,
  );

  // Swap detection: one asset went out, another came in (opposite signs).
  const isSwap =
    token != null &&
    tx.balanceChange !== 0 &&
    ((tx.balanceChange > 0 && token[1] < 0) || (tx.balanceChange < 0 && token[1] > 0));

  const receive = token ? token[1] > 0 : tx.balanceChange >= 0;
  const pending = tx.height === null;
  const explorer = explorerTxUrl(network, tx.txid);

  // LBTC amount in the chosen denomination (mirrors the balance). Every formatter
  // preserves the sign, so the receive prefix carries over unchanged from sats.
  const lbtcAmount = (satsValue: number): string =>
    denom === "btc"
      ? formatBtc(satsValue)
      : denom === "fiat"
        ? rate != null
          ? formatFiat(satsToFiat(satsValue, rate), fiat)
          : "—"
        : formatSats(satsValue);
  const unitLabel = denom === "btc" ? "LBTC" : denom === "fiat" ? fiat : "sats";

  // Format a token amount with its label.
  const tokenAmountText = (id: string, delta: number): string => {
    const info = assets[id];
    const label = KNOWN_ASSETS[id]?.label ?? info?.ticker ?? info?.name ?? shortenHex(id, 4, 4);
    return `${delta > 0 ? "+" : ""}${formatAssetAmount(delta, KNOWN_ASSETS[id]?.precision ?? info?.precision ?? null)} ${label}`;
  };

  // For swaps, compute both legs. "sent" is the outflow, "received" is the inflow.
  let swapSentText: string | undefined;
  let swapRecvText: string | undefined;
  if (isSwap && token) {
    const [tokenId, tokenDelta] = token;
    if (tx.balanceChange < 0) {
      // Sent LBTC, received token
      swapSentText = `${lbtcAmount(tx.balanceChange)} ${unitLabel}`;
      swapRecvText = tokenAmountText(tokenId, tokenDelta);
    } else {
      // Sent token, received LBTC
      swapSentText = tokenAmountText(tokenId, tokenDelta);
      swapRecvText = `+${lbtcAmount(tx.balanceChange)} ${unitLabel}`;
    }
  }

  let amountText: string;
  if (token && !isSwap) {
    amountText = tokenAmountText(token[0], token[1]);
  } else if (!isSwap) {
    amountText = `${receive ? "+" : ""}${lbtcAmount(tx.balanceChange)}`;
  } else {
    amountText = ""; // not used for swap rows
  }
  return (
    <details className="drawer">
      <summary className="flex items-center gap-2.5 px-3 py-2">
        <span
          aria-label={isSwap ? "Swap" : receive ? "Received" : "Sent"}
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full",
            isSwap
              ? "bg-[color:var(--accent-soft)] text-[color:var(--accent-strong)]"
              : receive
                ? "bg-[color:var(--success-bg)] text-[color:var(--success-text)]"
                : "bg-[color:var(--danger-bg)] text-[color:var(--danger-text)]",
          )}
        >
          {isSwap ? <ArrowLeftRight size={16} /> : receive ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}
        </span>
        {isSwap ? (
          <>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm text-[color:var(--text-primary)]">{formatRelative(tx.timestamp)}</span>
            </span>
            <span className="ml-auto flex items-center gap-2">
              <span className={cn("text-sm text-[color:var(--text-strong)]", pending && "animate-pulse")}>
                {hidden ? (
                  <HiddenValue count={3} size={8} className="text-[color:var(--text-subtle)]" />
                ) : (
                  // Same readout as the send/receive rows below: a swap row's figure
                  // is an amount, so it takes the telemetry face. Left in the body
                  // face, swap rows read as a separate list from the rest.
                  <TelemetryNumber value={swapRecvText ?? ""} glow={false} />
                )}
              </span>
              <ChevronDown size={14} className="drawer-chevron text-[color:var(--text-subtle)]" />
            </span>
          </>
        ) : (
          <>
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
          </>
        )}
      </summary>
      <div className="flex flex-col gap-2 border-t border-[color:var(--border-soft)] px-3 py-2 text-xs">
        {/* Controls, not characters — the same treatment as the asset drawer's id
            row, so the two identifiers in this panel read alike: the full value on
            the label's tooltip, copy and explorer as icons. */}
        <div className="flex items-center justify-between gap-3">
          <span tabIndex={0} title={tx.txid} className="cursor-pointer text-[color:var(--text-subtle)]">
            Txid
          </span>
          <span className="flex items-center gap-0.5">
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
        {isSwap && swapSentText && swapRecvText && (
          <>
            <Row label="Delivered" value={swapSentText.replace(/^[+-]/, "")} />
            <Row label="Received" value={swapRecvText.replace(/^\+/, "")} />
          </>
        )}
        <Row
          label="Fee"
          value={denom === "fiat" ? lbtcAmount(tx.fee) : `${lbtcAmount(tx.fee)} ${unitLabel}`}
        />
      </div>
    </details>
  );
}

function Coins({ walletId, network, watchOnly }: { walletId: string; network: LiquidNetwork; watchOnly: boolean }) {
  const [utxos, setUtxos] = useState<WalletUtxoDTO[] | null>(null);
  const [assets, setAssets] = useState<Record<string, AssetInfo>>({});
  const [error, setError] = useState("");
  const [busyAsset, setBusyAsset] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "info" | "error"; msg: string } | null>(null);

  const loadUtxos = useCallback(() => {
    let alive = true;
    setError("");
    wallet
      .getUtxos(walletId)
      .then((u) => {
        if (!alive) return;
        setUtxos(u);
        const unknown = [...new Set(u.map((x) => x.asset))].filter(
          (id) => !(id in KNOWN_ASSETS) && !(id in assets),
        );
        if (unknown.length === 0) return;
        void (async () => {
          const fetched: Record<string, AssetInfo> = {};
          for (const id of unknown) {
            try {
              fetched[id] = await wallet.getAsset(id, network);
            } catch {
              /* UI falls back to shortened hex */
            }
          }
          if (alive && Object.keys(fetched).length > 0) {
            setAssets((prev) => ({ ...prev, ...fetched }));
          }
        })();
      })
      .catch((e) => {
        if (alive) setError(errMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [walletId, network, assets]);

  useEffect(() => loadUtxos(), [loadUtxos]);

  // Auto-refresh when a broadcast lands (the background fires this after every
  // successful send), so the coin list updates without a manual reload.
  useEffect(() => {
    const onMsg = (msg: { type?: string }) => {
      if (msg.type === "apogee/balance-changed") loadUtxos();
    };
    browser.runtime.onMessage.addListener(onMsg);
    return () => browser.runtime.onMessage.removeListener(onMsg);
  }, [loadUtxos]);

  const [pendingConsolidation, setPendingConsolidation] = useState<{
    assetId: string;
    label: string;
    count: number;
    fee: string;
    pset: string;
    address: string;
    recipientAmount: string;
    feeAmount: string;
    toSelf: boolean;
    isToken: boolean;
  } | null>(null);

  async function startConsolidate(assetId: string, isToken: boolean, label: string, count: number) {
    setBusyAsset(assetId);
    setNotice(null);
    try {
      const addr = await wallet.getAddress(walletId);
      const prepared = await wallet.prepareSend(
        addr.address,
        0,
        true,
        isToken ? assetId : undefined,
      );
      setPendingConsolidation({
        assetId,
        label,
        count,
        fee: prepared.feeAmount,
        pset: prepared.pset,
        address: addr.address,
        recipientAmount: prepared.recipientAmount,
        feeAmount: prepared.feeAmount,
        toSelf: prepared.toSelf,
        isToken,
      });
    } catch (e) {
      setNotice({ tone: "error", msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusyAsset(null);
    }
  }

  async function confirmConsolidate() {
    const p = pendingConsolidation;
    if (!p) return;
    setBusyAsset(p.assetId);
    setPendingConsolidation(null);
    setNotice(null);
    try {
      await wallet.send(p.pset, {
        address: p.address,
        recipientAmount: p.recipientAmount,
        feeAmount: p.feeAmount,
        drain: true,
        toSelf: p.toSelf,
        ...(p.isToken
          ? { assetId: p.assetId, assetPrecision: undefined, assetTicker: undefined }
          : {}),
      });
      setNotice({ tone: "info", msg: "Consolidation broadcast." });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/reject|declin|denied|cancel/i.test(msg)) {
        setNotice({ tone: "info", msg: "Consolidation cancelled." });
      } else {
        setNotice({ tone: "error", msg });
      }
    } finally {
      setBusyAsset(null);
    }
  }

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!utxos) return <LoadingPill />;

  if (utxos.length === 0) {
    return <p className="py-8 text-center text-sm text-[color:var(--text-subtle)]">No unspent outputs.</p>;
  }

  // Group by asset, L-BTC (policy asset) first, then by asset id.
  const lbtcMainnet = "6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d";
  const lbtcTestnet = "144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49";
  const policyAsset = network === "liquid" ? lbtcMainnet : lbtcTestnet;
  const groups = new Map<string, WalletUtxoDTO[]>();
  for (const u of utxos) {
    const arr = groups.get(u.asset) ?? [];
    arr.push(u);
    groups.set(u.asset, arr);
  }
  const sortedAssets = [...groups.keys()].sort((a, b) => {
    if (a === policyAsset) return -1;
    if (b === policyAsset) return 1;
    return a.localeCompare(b);
  });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-[color:var(--text-subtle)]">
        {utxos.length} unspent output{utxos.length === 1 ? "" : "s"} across {groups.size} asset{groups.size === 1 ? "" : "s"}.
      </p>
      {notice && (
        <p className={`text-xs ${notice.tone === "error" ? "text-[color:var(--danger-text)]" : "text-[color:var(--text-secondary)]"}`}>
          {notice.msg}
        </p>
      )}
      {sortedAssets.map((assetId) => {
        const groupUtxos = groups.get(assetId)!;
        const info = assets[assetId];
        const knownLabel = KNOWN_ASSETS[assetId]?.label?.replace(/ \(testnet\)$/, "");
        const label = knownLabel ?? info?.ticker ?? info?.name ?? shortenHex(assetId, 6, 6);
        const precision = KNOWN_ASSETS[assetId]?.precision ?? info?.precision ?? null;
        const total = groupUtxos.reduce((sum, u) => sum + BigInt(u.amount), 0n);
        const isToken = assetId !== policyAsset;
        return (
          <div key={assetId}>
            <div className="mb-1.5 flex items-center gap-2">
              <AssetIcon assetId={assetId} label={label} network={network} size="size-5" />
              <span className="text-sm font-medium text-[color:var(--text-primary)]">{label}</span>
              <span className="ml-auto text-xs text-[color:var(--text-subtle)]">
                {formatAssetAmountExact(total.toString(), precision)} · {groupUtxos.length} output{groupUtxos.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="apogee-panel divide-y divide-[color:var(--border-soft)] overflow-hidden rounded-xl border border-[color:var(--border-default)]">
              {groupUtxos.map((u) => (
                <CoinRow key={`${u.txid}:${u.vout}`} utxo={u} assetId={assetId} label={label} precision={precision} network={network} />
              ))}
            </div>
            {groupUtxos.length > 1 && !watchOnly && pendingConsolidation?.assetId !== assetId && (
              <Button
                variant="secondary"
                size="sm"
                className="mt-2 w-full"
                disabled={busyAsset !== null}
                onClick={() => void startConsolidate(assetId, isToken, label, groupUtxos.length)}
              >
                {busyAsset === assetId ? <Spinner className="size-3" /> : `Combine ${groupUtxos.length} outputs`}
              </Button>
            )}
            {pendingConsolidation?.assetId === assetId && (
              <div className="mt-2 rounded-xl border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] p-3">
                <p className="text-sm text-[color:var(--text-primary)]">
                  Combine {pendingConsolidation.count} outputs into 1?
                </p>
                <p className="mt-1 text-xs text-[color:var(--text-subtle)]">
                  Network fee: {pendingConsolidation.fee} sats
                </p>
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    disabled={busyAsset !== null}
                    onClick={() => void confirmConsolidate()}
                  >
                    {busyAsset ? <Spinner className="size-3" /> : "Confirm"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="flex-1"
                    disabled={busyAsset !== null}
                    onClick={() => setPendingConsolidation(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CoinRow({
  utxo,
  assetId,
  label,
  precision,
  network,
}: {
  utxo: WalletUtxoDTO;
  assetId: string;
  label: string;
  precision: number | null;
  network: LiquidNetwork;
}) {
  const explorer = explorerTxUrl(network, utxo.txid);
  return (
    <details className="drawer">
      <summary className="flex items-center gap-2.5 px-3 py-2">
        <span
          aria-label={utxo.confidential ? "Confidential" : "Unconfidential"}
          className={`flex size-8 shrink-0 items-center justify-center rounded-full ${
            utxo.confidential
              ? "bg-[color:var(--accent-soft)] text-[color:var(--accent-strong)]"
              : "bg-[color:var(--surface-soft)] text-[color:var(--text-subtle)]"
          }`}
        >
          {utxo.confidential ? <Lock size={14} /> : <Eye size={14} />}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-[color:var(--text-subtle)]" title={utxo.address}>
          {shortenHex(utxo.address, 8, 8)}
        </span>
        <span className="ml-auto text-sm text-[color:var(--text-strong)]">
          <TelemetryNumber value={`${formatAssetAmountExact(utxo.amount, precision)} ${label}`} glow={false} />
        </span>
        <ChevronDown size={14} className="drawer-chevron text-[color:var(--text-subtle)]" />
      </summary>
      <div className="flex flex-col gap-2 border-t border-[color:var(--border-soft)] px-3 py-2 text-xs">
        <div className="flex items-center justify-between gap-3">
          <span tabIndex={0} title={`${utxo.txid}:${utxo.vout}`} className="cursor-pointer text-[color:var(--text-subtle)]">
            Outpoint
          </span>
          <span className="flex items-center gap-0.5">
            <CopyIconButton value={`${utxo.txid}:${utxo.vout}`} label="Copy outpoint" />
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
        <Row label="Address" value={utxo.address} mono />
        <Row label="Asset" value={assetId} mono />
        <Row label="Amount" value={`${formatAssetAmountExact(utxo.amount, precision)} ${label}`} />
        <Row label="Confidential" value={utxo.confidential ? "Yes" : "No"} />
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
        Receive LBTC & assets
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
  onView,
}: {
  wallet: WalletInfo;
  fiat: string;
  onFiatChange: (code: string) => void;
  denom: Denom;
  onDenomChange: (d: Denom) => void;
  onReset: () => void;
  onView: (v: View) => void;
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
  // to browser.storage — the SW checks the same key on every scan/broadcast.
  const [debugEnterprise, setDebugEnterprise] = useState(false);
  useEffect(() => {
    if (!DEBUG_ENTERPRISE_BUILD) return;
    void browser.storage.local
      .get(DEBUG_ENTERPRISE_KEY)
      .then((o) => setDebugEnterprise(o[DEBUG_ENTERPRISE_KEY] === true));
  }, []);
  function toggleDebugEnterprise(on: boolean) {
    setDebugEnterprise(on);
    void browser.storage.local.set({ [DEBUG_ENTERPRISE_KEY]: on });
  }
  const [demoFundsOn, setDemoFundsOn] = useState(false);
  useEffect(() => {
    if (!DEBUG_ENTERPRISE_BUILD) return;
    void browser.storage.local
      .get(DEMO_FUNDS_KEY)
      .then((o) => setDemoFundsOn(o[DEMO_FUNDS_KEY] === true));
  }, []);
  function toggleDemoFunds(on: boolean) {
    setDemoFundsOn(on);
    void browser.storage.local.set({ [DEMO_FUNDS_KEY]: on });
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
    browser.runtime.onMessage.addListener(onMsg);
    return () => browser.runtime.onMessage.removeListener(onMsg);
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
              <option value="btc">LBTC</option>
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

      <Card>
        <button
          type="button"
          onClick={() => onView("coins")}
          className="flex w-full items-center justify-between text-left"
        >
          <span className="console-overline">Coins</span>
          <ChevronRight size={16} className="text-[color:var(--text-subtle)]" />
        </button>
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
          legible over the moonlit-sea backdrop on every view. The update link
          sits in the row's spare width beside the wordmark and is shorter than
          the two-line stack, so the footer's height is unchanged by it. */}
      <footer className="-mx-4 -mb-4 mt-auto flex items-end justify-between gap-3 px-4 pt-4 pb-5 text-[color:var(--text-muted)]">
        <div className="flex flex-col gap-2">
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
        </div>
        <UpdateCheckLink />
      </footer>
    </div>
  );
}

// Settings footer: check the published release against this build, on click
// only. Sits in the footer row's spare width beside the wordmark; the wordmark +
// copyright stack is taller than this link plus its result line, so neither
// state changes the footer's height. The result replaces itself in place rather
// than appending, so repeat presses can't grow the row.
function UpdateCheckLink() {
  const [state, setState] = useState<"idle" | "checking" | "done" | "error">("idle");
  const [result, setResult] = useState<UpdateCheck | null>(null);
  const [error, setError] = useState("");
  // A resolved check must not call setState after the panel navigates away.
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  async function check() {
    setState("checking");
    setError("");
    try {
      const r = await wallet.checkUpdate();
      if (!alive.current) return;
      setResult(r);
      setState("done");
    } catch (e) {
      if (!alive.current) return;
      setError(errMessage(e));
      setState("error");
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
      <button
        type="button"
        onClick={check}
        disabled={state === "checking"}
        className="text-xs text-[color:var(--text-subtle)] underline underline-offset-2 transition-colors hover:text-[color:var(--text-muted)] disabled:no-underline"
      >
        {state === "checking" ? "Checking…" : "Check for updates"}
      </button>
      {state === "done" && result && (
        <span className="text-[11px] text-[color:var(--text-subtle)]">
          {result.newer ? (
            // Released, not necessarily installable yet: a store can still be
            // reviewing it, so this points at the listing instead of promising
            // the update is already waiting there.
            <a
              href={STORE_LISTING_URL}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-[color:var(--text-muted)]"
            >
              Version {result.latest} is available
            </a>
          ) : (
            "You're on the latest version."
          )}
        </span>
      )}
      {state === "error" && (
        <span className="text-[11px] text-[color:var(--text-subtle)]">{error}</span>
      )}
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
  const scrollRef = useRef<HTMLDivElement>(null);

  // When a collapsible drawer (<details>) grows, scroll its header into view if
  // the revealed content would otherwise fall below the fold.
  //
  // The listener is on the capture phase because `toggle` is specified
  // bubbles:false — that is the event's definition, not a gap in our browser
  // floors, so the capture flag is permanent. Don't drop it: a React `onToggle`
  // on an ancestor, or a bubble-phase listener here, sees nothing at all.
  //
  // `toggle` alone is not enough, because a drawer can grow more than once and
  // only the first growth is a toggle. "Reveal seed phrase" opens to just a
  // password form; submitting it swaps in the phrase, a countdown and two
  // buttons, and "Show as QR code" then swaps the phrase for a 180px QR —
  // together more height than the toggle itself revealed, and both are React
  // state changes that fire no event on the element. So the toggle only decides
  // WHAT to watch, and a ResizeObserver decides WHEN to act. It also removes the
  // need to measure on a frame timer: it reports the box after layout, whereas a
  // requestAnimationFrame could still measure the pre-expansion scroll range and
  // under-scroll as a result.
  //
  // Live wherever SubView hosts a drawer: the three Settings sections, and Swap's
  // "Quoted by SideSwap" disclosure on its confirm screen. Receive and Send have
  // none. Swap's container is centered rather than feathered, so its geometry
  // differs from the Settings screen this was measured against.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    // Last measured height per open drawer, so growth can be told from shrinkage.
    // Only growth scrolls. A drawer can shrink with no user action at all — the
    // seed phrase auto-hides on a timer, and ChainServerStatus re-probes every 30s
    // and can drop provider rows — and a shrink that leaves the bottom still
    // clipped falls through the clipping check below, so without this it would
    // slide the view out from under whoever is reading.
    const heights = new WeakMap<Element, number>();

    const revealIfClipped = (details: HTMLDetailsElement) => {
      if (!details.open || !container.contains(details)) return;
      const cRect = container.getBoundingClientRect();
      const dRect = details.getBoundingClientRect();
      // Already fully in view — leave it, so opening a section near the top
      // doesn't jump.
      if (dRect.bottom <= cRect.bottom + 1) return;
      // Bring the section's header near the top, which reveals everything below
      // it — or, for a section taller than the viewport, the most useful anchor.
      // 28px and not 12: the non-centered container wears .apogee-feather-top,
      // whose mask runs transparent -> opaque across its first 24px, so a header
      // parked inside that band gets scrolled into view and then half dissolved.
      // KEEP IN SYNC with that gradient in theme.css.
      const target = details.querySelector("summary") ?? details;
      const top = target.getBoundingClientRect().top - cRect.top - 28;
      // Downward only. A drawer taller than the viewport can be scrolled into,
      // putting its header above the top edge while the bottom is still clipped;
      // this delta then goes negative and would yank the reader back up to the
      // header, away from the controls they were using.
      if (top <= 0) return;
      container.scrollBy({
        top,
        // Reduced motion is honored across the app (theme.css, scene-scroll,
        // ShootingStars) — a scroll nobody asked for should honor it too.
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    };

    // One observer for every open drawer. observe() fires immediately with the
    // current box, so opening a drawer is handled here too rather than needing a
    // separate measurement path.
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const details = entry.target;
        if (!(details instanceof HTMLDetailsElement)) continue;
        const height = entry.contentRect.height;
        const previous = heights.get(details);
        heights.set(details, height);
        // No baseline yet means this is the callback observe() fires on open, which
        // is itself the growth that opened the drawer.
        if (previous === undefined || height > previous) revealIfClipped(details);
      }
    });

    const onToggle = (e: Event) => {
      const details = e.target;
      if (!(details instanceof HTMLDetailsElement)) return;
      // Watch only what's open: a closed drawer can't be clipped, and dropping it
      // clears the baseline so a reopen counts as growth again.
      if (details.open) {
        observer.observe(details);
      } else {
        observer.unobserve(details);
        heights.delete(details);
      }
    };

    container.addEventListener("toggle", onToggle, true);
    return () => {
      container.removeEventListener("toggle", onToggle, true);
      observer.disconnect();
    };
  }, []);

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
        ref={scrollRef}
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
  return view === "receive" ? "Receive" : view === "send" ? "Send" : view === "swap" ? "Swap" : view === "coins" ? "Coins" : "Settings";
}
