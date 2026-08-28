// Main wallet screen. A non-scrolling balance "frame" sits above a scrollable
// activity list and shrinks once the list is scrolled (the balance stays in
// view but compacts). Send/Receive live under the balance; a hide toggle swaps
// amounts for star glyphs; the balance pulses while syncing or when funds
// are still unconfirmed. Sending is stubbed until the tx-builder engine op.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  FileCode2,
  Eye,
  EyeOff,
  Lock,
  QrCode,
  RefreshCw,
  Share,
  Telescope,
  Unplug,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { WalletExport } from "@/sidepanel/components/wallet-export";
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
import { KNOWN_ASSETS, policyAssetId } from "@/lib/asset-registry";
import { type Denom, assetRows, heroSubtitle, portfolioTotal } from "@/lib/portfolio";
import { DEBUG_ENTERPRISE_BUILD, DEBUG_ENTERPRISE_KEY } from "@/lib/debug";
import { DEMO_FUNDS_KEY, DEMO_SYNC, DEMO_TXS, DEMO_UTXOS, useDemoFunds } from "@/lib/demo-funds";
import { cancelBalanceStrike, restrikeBalance } from "@/sidepanel/balance-strike";
import { useBalanceStrike } from "@/sidepanel/balance-warmup";
import { useHeroCollapse } from "@/sidepanel/hero-collapse";
import {
  moonRise,
  parkSceneMoon,
  resetSceneScroll,
  setSceneScroll,
} from "@/sidepanel/scene-scroll";
import { cn, shortenHex } from "@/lib/utils";
import { browser } from "@/lib/ext";
import { encodeStandardSeedQr } from "@/lib/seed-qr";
import {
  formatAssetAmount,
  formatAssetAmountExact,
  formatBaseUnits,
  formatBtc,
  formatFiat,
  formatRelative,
  formatSats,
  formatTimestamp,
  satsToFiat,
} from "@/lib/format";
import {
  bumpPendingPolls,
  CONSOLIDATION_SETTLE_MS,
  exhaustedBroadcastIds,
  landedBroadcastIds,
  type ConsolidationBroadcast,
} from "@/lib/consolidation";
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

export type View = "home" | "receive" | "send" | "swap" | "settings" | "coins" | "export";

const HIDE_KEY = "apogee:hideBalance";
const TX_PAGE = 25; // transactions rendered per lazy-load page
// Auto-hide a revealed seed phrase (and its QR) after this window, so the secret
// isn't left on screen if the user steps away. Long enough for the slow paths
// this view actually exists for: transcribing 24 words by hand, or lining up
// another device's camera on the QR. Deliberately a trade — a longer window is
// more exposure — but a timeout that fires mid-transcription just gets
// re-triggered, which is worse.
const SEED_REVEAL_TIMEOUT_S = 60;

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

/**
 * Why a sync happened, which is what decides how loudly it shows:
 *
 *   "initial"    — mount and wallet switch. Spinner and errors, no strike: the
 *                  first figure of a session strikes on its own arming, and
 *                  re-arming here would replay it on the remount that returning
 *                  from the step-up screen causes.
 *   "manual"     — the Sync button. Spinner, errors, and a re-strike of the
 *                  numerals even if the figure is unchanged.
 *   "background" — the 20s poll, tab focus, the settle poll, the demo toggle.
 *                  Silent: no spinner flash, no transient error surfaced. These
 *                  still strike when the balance genuinely moves, which is the
 *                  point — a flicker every 20s regardless would be noise.
 *
 * A boolean can't carry this: "initial" and "manual" are both non-silent and
 * differ only in the strike.
 */
type SyncKind = "initial" | "manual" | "background";

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
    // A denomination swap doesn't earn a flicker — the figure itself didn't
    // move. If one is mid-flight it would smear across the reshaped string
    // (reconciled glyph spans mixing reused animation progress with fresh
    // mounts — see cancelBalanceStrike in balance-strike.ts), so a toggle
    // stops the animation instead: whatever shows next is static.
    cancelBalanceStrike();
  }, []);
  const cycle = useCallback(() => {
    // Outside the updater: side effects in a state updater run twice under
    // StrictMode's double-invoke.
    cancelBalanceStrike();
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
  homeTopSeq,
}: {
  state: KeystoreState;
  view: View;
  onView: (v: View) => void;
  onToast: (n: ToastNotice) => void;
  onReset: () => void;
  // Bumped by the header logo click (see App). Each bump scrolls the activity
  // list back to the top — which expands the hero (sentinel back in view) and
  // shows the newest transactions — so the logo reads as "home", from anywhere.
  homeTopSeq: number;
}) {
  const active = state.wallets.find((w) => w.id === state.activeWalletId) ?? state.wallets[0];
  // Watch-only wallets have no key/signer: track balance + receive, but no Send.
  const watchOnly = active.signer === "watch";
  const [watchInfo, setWatchInfo] = useState(false); // watch-only explainer modal
  // Asset preselected for the Send screen (set when launching from a token row).
  const [sendAssetId, setSendAssetId] = useState<string | null>(null);
  // Asset preselected for the Swap screen (set when launching from a token row).
  const [swapAssetId, setSwapAssetId] = useState<string | null>(null);
  // Pending Coins consolidations, keyed by asset id. Lives here rather than in
  // Coins itself: Coins fully unmounts whenever `view` leaves "coins" (Settings,
  // then back), and this has to survive that round trip — see the type's doc
  // comment in lib/consolidation.ts for what broke when it didn't.
  const [coinBroadcasts, setCoinBroadcasts] = useState<Record<string, ConsolidationBroadcast>>({});
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
  // Hero collapse (see hero-collapse.ts). Lives with the other hooks — the home
  // view renders conditionally below — and is keyed on the home view being
  // mounted, because the component persists across views while this DOM swaps.
  const homeActive = view === "home";
  const collapse = useHeroCollapse(scrollRef, homeActive);
  const { compact } = collapse;
  const figureBtnRef = useRef<HTMLButtonElement>(null);

  // Folding hides whatever was focused in the folded rows — visibility: hidden
  // dumps focus on <body> and loses the user's place in the tab order. Hand it
  // to the figure, the one interactive element that survives both states, so
  // focus stays in the region instead of falling out of the panel.
  useEffect(() => {
    if (!compact) return;
    const frame = collapse.frameRef.current;
    const active = document.activeElement;
    if (frame && active instanceof HTMLElement && frame.contains(active) && active !== figureBtnRef.current) {
      figureBtnRef.current?.focus({ preventScroll: true });
    }
  }, [compact, collapse.frameRef]);

  // The list's scroll drives the celestial backdrop (see scene-scroll.ts): the
  // moon rises off the top of the panel as the hero compacts, and the starfield
  // depth-parallaxes against the offset. rAF-coalesced like the starfield's own
  // redraw, so the two never drift. Keyed on the home view for the same reason
  // as the collapse above (the list element the listener binds to is remounted
  // by every sub-view trip), and the cleanup resets the scene — leaving the
  // view or locking must not strand the moon off-screen for a view that never
  // scrolled.
  useEffect(() => {
    if (!homeActive) return;
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const report = () => {
      // Guarded like the starfield's own redraw (see Starfield.tsx): a scroll
      // gesture delivers several events per frame, and without the guard each
      // one queues another callback — redundant writes per frame, and the
      // cleanup could only ever cancel the newest handle.
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setSceneScroll(moonRise(el.scrollTop), el.scrollTop);
      });
    };
    el.addEventListener("scroll", report, { passive: true });
    return () => {
      el.removeEventListener("scroll", report);
      if (raf) cancelAnimationFrame(raf);
      // Only the LOCK case wants the moon walked back down here. Leaving home
      // for a sub-view is handled by the park effect below, which raises it
      // instead — a reset would drop the moon straight onto that view's back
      // button. Parking is idempotent and cancels this, but doing both would
      // still ease the moon down and back up for no reason.
      resetSceneScroll();
    };
  }, [homeActive]);

  // Every view but home stacks a second header (back button + title) beneath the
  // app header, and the moon's resting position is behind exactly that band. So
  // the moon animates up and out for the whole time a sub-view is showing, and
  // back down on the way home. Unconditional by design — see parkSceneMoon,
  // which honors prefers-reduced-motion by cutting the animation rather than the
  // move, because this is layout and not decoration.
  useEffect(() => {
    parkSceneMoon(!homeActive);
  }, [homeActive]);

  // Release on unmount, separately, because neither effect above does. The
  // scroll effect returns early while a sub-view is showing so it registers no
  // cleanup in that state, and the park effect has none.
  //
  // Both lock paths happen to be safe: App.tsx calls setView("home") BEFORE
  // awaiting refresh(), so the park eases down while still mounted. A factory
  // reset does not — onReset only clears recovery and refreshes, leaving
  // view === "settings", so <Wallet> unmounts from a sub-view. Without this,
  // --moon-rise and --scene-recede stay at 1 for the whole onboarding flow that
  // follows: moon parked off-screen, horizon glow dead, water dimmed.
  useEffect(() => () => parkSceneMoon(false), []);

  // The logo click's "home" — scroll the list back to the newest transactions,
  // expanding the hero on the way past the sentinel. Smooth for the same
  // reason the settings drawer scroll is; instant under reduced motion.
  useEffect(() => {
    if (homeTopSeq === 0) return;
    scrollRef.current?.scrollTo({
      top: 0,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }, [homeTopSeq]);

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
  // Also read by the "not final" pulse below — hoisted so the two don't
  // duplicate the same `txs.some(...)` scan.
  const hasUnconfirmed = txs.some((t) => t.height === null);
  // Balance strike (the neon warm-up). MUST live up here with the other hooks:
  // `view !== "home"` returns early below, so calling it beside the hero render
  // made it conditional — React saw fewer hooks on Settings and blanked the panel.
  //
  // A figure is only "ready" to strike once real numerals are on screen; stars, a
  // spinner or the rate-failed dash would otherwise consume the arming and the
  // balance would arrive already lit. The settling signal is an unconfirmed tx,
  // NOT `pulse` — that also covers syncing and a pending rate, and neither of
  // those is a confirmation.
  // The Animations preference, read here for the strike (the Settings toggle
  // and the Scene hold their own subscriptions). `loaded` gates the DECISION,
  // not just the rendering: the preference starts at its optimistic default,
  // and striking before it lands would consume the arming for someone who has
  // animations off — the same window App guards the intro cinematic against.
  // With animations off, `ready` stays false, the arming is held, and turning
  // animations back on strikes the figure then showing.
  const [animated, , animationsLoaded] = useAnimations();
  const strikeEpoch = useBalanceStrike(
    String(total.totalSats),
    hasUnconfirmed,
    // `ready` means "real numerals are ON SCREEN" — including the view. The
    // hook lives above the `view !== "home"` early return (hooks can't be
    // conditional), so without this an arming could spend on a decision whose
    // hero isn't rendered, or be consumed by stars, a spinner or the
    // rate-failed dash, and the ~1.3s window would lapse before anything lit.
    // Held here instead, the strike spends on the false→true edge when the
    // home view remounts with figures actually showing.
    homeActive &&
      !(hidden || !sync) &&
      (denom !== "fiat" || rate != null) &&
      animationsLoaded &&
      animated,
  );
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

  // Returns the sync result so the settle poll can detect when the balance moves.
  const refresh = useCallback(
    async (kind: SyncKind = "initial"): Promise<SyncResult | null> => {
      if (!active) return null;
      const silent = kind === "background";
      if (!silent) setSyncing(true);
      if (!silent) setError("");
      try {
        const result = await wallet.sync(active.id);
        const transactions = await wallet.getTransactions(active.id);
        // Pressing Sync is an explicit "tell me where I stand", so the numerals
        // light again even when the figure hasn't moved — the spinner stopping
        // is otherwise the only acknowledgement, and it stops whether or not the
        // sync found anything.
        //
        // restrikeBalance() rather than armBalanceStrike() because it must also
        // nudge a still-mounted hero — see balance-warmup.ts for why the lock
        // paths deliberately don't. Armed here rather than on the click for two
        // reasons: the strike then runs on the fresh figure instead of the stale
        // one, and a sync that threw gets the error notice rather than a
        // flourish. It also has to be the same React task as the setSync below —
        // batched into one render — or the balance landing and the arming are
        // two passes, and the second restarts the animation mid-flicker.
        if (kind === "manual") restrikeBalance();
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
    void refresh("initial");
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
      const result = await refresh("background");
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
      if (!document.hidden) void refresh("background");
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
  }, [active?.id]);

  // Toggling demo funds (debug builds) is a DISPLAY substitution — the canned
  // dataset never enters liveSync — so there is nothing to clear, and clearing it
  // was the bug: turning demo off nulled the real balance and left stars until
  // the 20s poll or a manual refresh.
  //
  // The seen-set still has to re-seed, though: `txs` swaps wholesale, so without
  // this, switching on would toast a fabricated "Received 250,000 sats" and
  // switching off would toast real history as if it had just arrived. Re-poll too,
  // so the live figure is current rather than however stale it was when demo
  // funds took over the display.
  // Keyed on the VALUE, not a "has run" flag: StrictMode re-invokes effects on
  // mount, and a flag would read the second pass as a toggle and fire a refresh
  // that never happens in production. Comparing values is idempotent — a re-run
  // with demoFunds unchanged does nothing, on mount or otherwise.
  const lastDemoFunds = useRef(demoFunds);
  useEffect(() => {
    if (lastDemoFunds.current === demoFunds) return;
    lastDemoFunds.current = demoFunds;
    seenTxids.current = null;
    void refresh("background");
  }, [demoFunds, refresh]);

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
      title:
        tx.txManifest?.status === "verified"
          ? tx.txManifest.actionLabel
          : received
            ? "Received"
            : "Sent",
      message,
      kind: received ? "success" : "info",
    });
  }, [sync, txs, onToast, denom, rate, fiat]);

  // Render more transactions as the sentinel scrolls into view. Keyed on
  // homeActive like the collapse and scene wiring: the pill lives in the home
  // JSX, so a sub-view trip detaches it, and without re-attaching on return
  // the observer would keep watching the dead node — paging silently dead
  // until some refresh changed txs.length.
  useEffect(() => {
    if (!homeActive) return;
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
  }, [visible, txs.length, homeActive]);

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
        {view === "export" && (
          <WalletExport
            wallet={active}
            wallets={state.wallets}
            txs={txs}
            assets={assets}
            policyAssetHex={sync?.policyAssetHex}
          />
        )}
        {view === "coins" && (
          <Coins
            walletId={active.id}
            network={active.network}
            watchOnly={active.signer === "watch"}
            // Demo funds is mainnet-shaped, so the policy asset and the label
            // source must come from the same dataset the list does — otherwise
            // a testnet wallet's real policy id wouldn't match the demo
            // outputs and every L-BTC row would render as an unknown token.
            assets={demoFunds ? {} : liveAssets}
            policyAsset={demoFunds ? DEMO_SYNC.policyAssetHex : liveSync?.policyAssetHex}
            hidden={hidden}
            isJade={active.signer === "jade"}
            demo={demoFunds}
            broadcasts={coinBroadcasts}
            setBroadcasts={setCoinBroadcasts}
          />
        )}
      </SubView>
    );
  }

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
  // The figure is keyed by the strike epoch so a re-strike (a Sync landing while
  // a strike is still playing) mounts fresh glyph spans and the flicker restarts
  // — TelemetryNumber only builds the animated spans on the warmup false→true
  // edge, so an unchanged `warmup` would coalesce into the running animation.
  let amountNode: React.ReactNode;
  if (showStars) {
    amountNode = <HiddenValue count={5} size={16} gap={9} className="telemetry-stars" />;
  } else if (denom === "fiat") {
    amountNode =
      rate != null ? (
        <TelemetryNumber
          key={strikeEpoch}
          value={formatFiat(satsToFiat(sats, rate), fiat)}
          wide
          warmup={strikeEpoch > 0}
        />
      ) : rateFailed ? (
        "—"
      ) : (
        <Spinner className="size-6" />
      );
  } else if (denom === "sats") {
    amountNode = <TelemetryNumber key={strikeEpoch} value={formatSats(sats)} wide warmup={strikeEpoch > 0} />;
  } else {
    amountNode = <TelemetryNumber key={strikeEpoch} value={formatBtc(sats)} wide warmup={strikeEpoch > 0} />;
  }
  const subtitle = heroSubtitle({ denom, fiat, total, rate, missingCount });

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Balance frame — fixed above the scrollable activity list. No bottom
          padding: the activity list's pt-6 (which sizes its feather ramp) already
          supplies the gap below Send/Receive, so pb-5 here would double it.
          While the list is scrolled the frame compacts (see hero-collapse.ts):
          the rows fold away and the figure shrinks, so the list gets the space
          the summary was holding. The fold is eased — see .apogee-hero-frame
          and .apogee-collapse-slot in theme.css. */}
      <div
        ref={collapse.frameRef}
        // pt as a ternary, NOT base-plus-override: both classes are the same
        // specificity, and Tailwind emits padding utilities in numeric order —
        // the larger value wins the cascade no matter the class order, so a
        // compact "pt-2" layered over a base "pt-6" silently never applied (the
        // compact strip rode around with the expanded frame's 24px of top air).
        className={cn(
          "apogee-hero-frame shrink-0 px-4",
          compact ? "pt-2 apogee-hero-frame--compact" : "pt-6",
        )}
      >
        <div className="apogee-collapse-slot">
          <div className="flex items-center justify-between">
            <IconButton label={hidden ? "Show balance" : "Hide balance"} onClick={toggleHidden}>
              {hidden ? <EyeOff size={16} /> : <Eye size={16} />}
            </IconButton>
            <IconButton label="Sync" onClick={() => refresh("manual")} disabled={syncing}>
              <RefreshCw size={16} className={syncing ? "animate-spin" : undefined} />
            </IconButton>
          </div>
        </div>

        <button
          ref={figureBtnRef}
          type="button"
          onClick={cycleDenom}
          // No point cycling the denomination while the amount is hidden (or not
          // yet synced) — the value is stars, so only the unit label would change.
          disabled={showStars}
          aria-label={showStars ? undefined : "Change denomination"}
          className={cn(
            "apogee-hero-figure flex w-full flex-col items-center text-[color:var(--text-strong)]",
            // gap as a ternary like the paddings (same Tailwind cascade trap):
            // the compact pair runs its line-height proportionally taller, so
            // the same flex gap there reads 2px tighter against the digits —
            // compact keeps the half step.
            compact ? "gap-0.5 py-1.5" : "gap-1 py-4",
            pulse && "animate-pulse",
          )}
        >
          <span
            className={cn(
              "apogee-hero-figure-glyph flex items-center justify-center",
              compact ? "h-8 text-2xl" : "h-9 text-3xl",
            )}
          >
            {amountNode}
          </span>
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
        {/* One slot for the bar AND the chart it opens, so both fold together.
            The chart stays mounted while compact — its state and fetched history
            ride out the fold, and it lays out clipped rather than remounting
            when the frame re-expands. */}
        <div className="apogee-collapse-slot">
          <div>
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
          </div>
        </div>

        <div className="apogee-collapse-slot apogee-collapse-slot--gap">
          <div className="flex gap-2">
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
      </div>

      {/* Scrollable activity list. Feathered top edge (matching the settings
          SubView) so rows dissolve as they scroll up instead of hard-cutting;
          pt-10 sizes the content to the 40px mask ramp so headings sit at full
          opacity at rest. pb-8 rather than pb-4: the transient version badge
          (VersionBadge, bottom-2) floats over this area for the first ~15s
          after unlock — exactly when a fresh balance gets scrolled — and the
          last row must clear it, not land on it. */}
      <div
        ref={scrollRef}
        className="apogee-scrollbar apogee-feather-top flex-1 overflow-y-auto px-4 pb-8 pt-10"
      >
        {/* Collapse sentinel (see hero-collapse.ts) — first child so it reads the
            head of the scroll content. Sits inside the pt-10 ramp, which deepens
            the effective collapse threshold by its own height; one pixel, and it
            costs the list's content exactly one pixel of offset. */}
        <div ref={collapse.sentinelRef} aria-hidden className="h-px w-full" />
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
        {/* Collapse spacer (see hero-collapse.ts): grows by exactly the height
            the frame loses — tracked frame-by-frame while the fold animates —
            so compacting never changes the scrollable range and can't clamp the
            scroll into the bounce this exists to prevent. Height is written
            imperatively by the hook, not rendered. */}
        <div ref={collapse.spacerRef} aria-hidden />
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

  const isManifest = tx.txManifest != null;

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
  // Three annotation states, and only ONE of them is a caution (see
  // tx-manifest/history.ts). "unsupported" means the marker names a bundle this
  // VERSION does not carry — a transaction made against a contract that shipped
  // on another branch reads that way forever, with nothing wrong with it — so it
  // gets neutral copy and neutral color. "unverified" is the real caution: the
  // bundle IS known and the marker failed a check (ambiguous marker, no
  // wallet-owned input, shape mismatch). Note neither state claims the
  // transaction was authenticated, so the copy must not imply it either.
  const manifestLabel =
    tx.txManifest?.status === "verified"
      ? tx.txManifest.actionLabel
      : tx.txManifest?.status === "unsupported"
        ? "Unrecognized contract"
        : tx.txManifest?.status === "unverified"
          ? "Unverified contract marker"
          : null;
  const activityIdentity = (
    <span className="flex min-w-0 flex-1 flex-col">
      {manifestLabel && (
        <span
          className={cn(
            "truncate text-sm",
            tx.txManifest?.status === "verified"
              ? "text-[color:var(--text-primary)]"
              : tx.txManifest?.status === "unsupported"
                ? // Quiet, not orange: an unknown bundle is missing information,
                  // not a problem with the transaction.
                  "text-[color:var(--text-secondary)]"
                : "text-[color:var(--warning-text)]",
          )}
          title={manifestLabel}
        >
          {manifestLabel}
        </span>
      )}
      <span
        className={cn(
          "text-[color:var(--text-primary)]",
          manifestLabel && "text-[11px] text-[color:var(--text-subtle)]",
          !manifestLabel && "text-sm",
        )}
      >
        {formatRelative(tx.timestamp)}
      </span>
    </span>
  );
  return (
    <details className="drawer">
      <summary className="flex items-center gap-2.5 px-3 py-2">
        <span
          aria-label={isSwap ? "Swap" : isManifest ? "Contract" : receive ? "Received" : "Sent"}
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full",
            isSwap || isManifest
              ? "bg-[color:var(--accent-soft)] text-[color:var(--accent-strong)]"
              : receive
                ? "bg-[color:var(--success-bg)] text-[color:var(--success-text)]"
                : "bg-[color:var(--danger-bg)] text-[color:var(--danger-text)]",
          )}
        >
          {isSwap ? (
            <ArrowLeftRight size={16} />
          ) : isManifest ? (
            <FileCode2 size={16} />
          ) : receive ? (
            <ArrowDownLeft size={16} />
          ) : (
            <ArrowUpRight size={16} />
          )}
        </span>
        {isSwap ? (
          <>
            {activityIdentity}
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
            {activityIdentity}
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
        {tx.txManifest?.status === "verified" && (
          <>
            <Row
              label="Protocol"
              value={`${tx.txManifest.protocolLabel} ${tx.txManifest.version}`}
            />
            <Row label="Action" value={tx.txManifest.actionLabel} />
            <Row label="Manifest" value="Verified wallet action" />
            <Row
              label="Bundle"
              value={shortenHex(tx.txManifest.bundleHash.replace(/^sha256:/, ""), 6, 6)}
            />
          </>
        )}
        {tx.txManifest?.status === "unsupported" && (
          <>
            <Row label="Manifest" value="Not supported in this version" />
            {/* The bundle hash is the ONLY thing that identifies which contract
                this was, and the annotation already carries it — withholding it
                here left "unsupported" impossible to act on. */}
            <Row
              label="Bundle"
              value={shortenHex(tx.txManifest.bundleHash.replace(/^sha256:/, ""), 6, 6)}
            />
          </>
        )}
        {tx.txManifest?.status === "unverified" && (
          <Row label="Manifest" value="Marker could not be verified" />
        )}
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

function Coins({
  walletId,
  network,
  watchOnly,
  assets,
  policyAsset: policyAssetProp,
  hidden,
  isJade,
  demo,
  broadcasts,
  setBroadcasts,
}: {
  walletId: string;
  network: LiquidNetwork;
  watchOnly: boolean;
  assets: Record<string, AssetInfo>;
  policyAsset?: string;
  hidden: boolean;
  isJade?: boolean;
  // Debug demo funds: present DEMO_UTXOS instead of the wallet's real outputs
  // (display-only, like the Wallet screen's demo dataset). Consolidation is
  // inert while it's on — the real outputs aren't the ones on screen, so
  // signing against them from this list would spend what the user can't see.
  demo?: boolean;
  // Owned by the parent (Wallet), not local state — this component unmounts on
  // every trip through Settings and back, and the pending-broadcast record has
  // to survive that. See the type's doc comment in lib/consolidation.ts.
  broadcasts: Record<string, ConsolidationBroadcast>;
  setBroadcasts: React.Dispatch<React.SetStateAction<Record<string, ConsolidationBroadcast>>>;
}) {
  const [liveUtxos, setUtxos] = useState<WalletUtxoDTO[] | null>(null);
  const utxos = demo ? DEMO_UTXOS : liveUtxos;
  const [error, setError] = useState("");
  const [busyAsset, setBusyAsset] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "info" | "error"; msg: string } | null>(null);

  // Auto-lock "never" steps up auth on every local send (background/index.ts),
  // so consolidation needs the same password field the other signing surfaces
  // render — without it the background rejects with "Enter your password to
  // send." and this screen has nowhere to type it.
  //
  // Starts `null` (unknown), not a guessed default: a guessed default of "15"
  // made `needsPassword` briefly read `false` on a Never wallet, so a confirm
  // click inside that window failed with the background's rejection and only
  // then did the password field appear. `null` disables Confirm below until
  // the real value lands — a local storage read, so in practice imperceptible.
  //
  // A REJECTED read falls back to 0 (needsPassword), not null: the service
  // worker can be asleep or mid-restart when this fires, and null would leave
  // Confirm disabled forever with nothing on screen to explain why. 0 renders
  // the password field, which the background ignores when it doesn't actually
  // need one (see Swap.tsx) — safe on any wallet, correct on a Never one.
  const [autoLock, setAutoLock] = useState<number | null>(null);
  const [password, setPassword] = useState("");
  const needsPassword = !isJade && autoLock === 0;
  useEffect(() => {
    void wallet
      .getAutoLock()
      .then(setAutoLock)
      .catch(() => setAutoLock(0));
  }, []);

  // A monotonic request id orders overlapping loads: the balance-changed
  // listener and the settle poll both fire loads whose responses can land out
  // of order, and a stale list must never overwrite a fresher one.
  const loadSeq = useRef(0);
  // Mirrors `utxos` for the load callback, which is memoized on [walletId]
  // alone and so can't close over the current list. It decides whether a
  // failed reload blanks the screen (no list yet) or surfaces inline — a
  // refresh failure mid-consolidation must not strand the pending card.
  const utxosRef = useRef<WalletUtxoDTO[] | null>(null);
  useEffect(() => {
    utxosRef.current = utxos;
  }, [utxos]);
  // Returns a promise that always resolves (both outcomes are handled below),
  // so the settle poll can sequence its next tick after the reload has actually
  // landed rather than after the sync alone.
  const loadUtxos = useCallback(() => {
    // Demo funds owns the list; a real load would only race it and could
    // surface a live-wallet error over a screenshot.
    if (demo) return Promise.resolve();
    const seq = ++loadSeq.current;
    setError("");
    return wallet.getUtxos(walletId).then(
      (u) => {
        if (seq !== loadSeq.current) return;
        setUtxos(u);
        setError("");
        setNotice((n) => (n?.tone === "error" ? null : n));
      },
      (e) => {
        if (seq !== loadSeq.current) return;
        const msg = errMessage(e);
        if (utxosRef.current === null) setError(msg);
        else setNotice({ tone: "error", msg });
      },
    );
  }, [walletId, demo]);

  useEffect(() => {
    loadUtxos();
  }, [loadUtxos]);

  // Auto-refresh when a broadcast lands (the background fires this after every
  // successful send), so the coin list updates without a manual reload.
  useEffect(() => {
    const onMsg = (msg: { type?: string }) => {
      if (msg.type === "apogee/balance-changed") loadUtxos();
    };
    browser.runtime.onMessage.addListener(onMsg);
    return () => browser.runtime.onMessage.removeListener(onMsg);
  }, [loadUtxos]);

  // Broadcast consolidations awaiting their first sighting, keyed by asset:
  // the txid plus the outpoints the tx spends. getUtxos reads the wollet's
  // last sync, so poll sync + reload on the home view's settle cadence until
  // the spent outpoints drop out of the list — that's the moment the sync has
  // caught the mempool tx, and the card clears. When an entry's OWN poll
  // budget runs out, only that entry flips to a terminal "stuck" state (no
  // spinner, dismissable), so one slow-to-confirm tx can't wedge another's
  // card, and can't wedge the screen either.
  //
  // `broadcasts` itself (not a separate counter) is what re-arms this effect:
  // bumping `polls` on every pending entry after each attempt changes its
  // identity and re-triggers the effect, so a failed sync or an unchanged
  // `utxos` still costs budget and the card always terminates.
  useEffect(() => {
    const entries = Object.entries(broadcasts);
    // The demo dataset can't adjudicate a real broadcast: its outpoints are
    // unrelated to the spend a pending consolidation snapshotted, so every one
    // of them would read as "absent from this list" — landed — the moment demo
    // funds is toggled on. Wait it out; the real utxos resume once it's off.
    if (demo || !utxos || entries.length === 0) return;

    const present = new Set(utxos.map((u) => `${u.txid}:${u.vout}`));
    const landed = landedBroadcastIds(broadcasts, present);
    if (landed.length > 0) {
      setBroadcasts((b) => {
        const next = { ...b };
        for (const id of landed) delete next[id];
        return next;
      });
      return;
    }

    const justExhausted = exhaustedBroadcastIds(broadcasts);
    if (justExhausted.length > 0) {
      setBroadcasts((b) => {
        const next = { ...b };
        for (const id of justExhausted) next[id] = { ...next[id], stuck: true };
        return next;
      });
      return;
    }

    const pending = entries.filter(([, b]) => !b.stuck);
    if (pending.length === 0) return;
    const t = window.setTimeout(() => {
      void wallet
        .sync(walletId)
        .then(loadUtxos, () => undefined)
        .finally(() => setBroadcasts(bumpPendingPolls));
    }, CONSOLIDATION_SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [broadcasts, utxos, loadUtxos, walletId, setBroadcasts, demo]);

  // `broadcasts` now lives in the parent and is keyed by asset id alone, which
  // was fine while only one wallet could ever be mounted under it. Nothing
  // switches `active.id` under a live Wallet today (no wallet-switcher UI, and
  // keystore's setActiveWallet/removeWallet have no callers) — but the whole
  // point of hoisting this record was to outlive things, so key it by wallet
  // too rather than relying on that staying true.
  const broadcastKey = useCallback((assetId: string) => `${walletId}:${assetId}`, [walletId]);

  function dismissBroadcast(assetId: string) {
    setBroadcasts((b) => {
      const next = { ...b };
      delete next[broadcastKey(assetId)];
      return next;
    });
  }

  const [pendingConsolidation, setPendingConsolidation] = useState<{
    assetId: string;
    count: number;
    feeAmount: string;
    pset: string;
    address: string;
    recipientAmount: string;
    toSelf: boolean;
    isToken: boolean;
  } | null>(null);

  async function startConsolidate(assetId: string, isToken: boolean, count: number) {
    // The list on screen is the demo dataset, so there is nothing here to
    // consolidate — building against the wallet's real outputs would spend
    // coins the screenshot never showed. The control stays enabled so it can
    // be captured; it just says so instead of acting.
    if (demo) {
      setNotice({ tone: "info", msg: "Demo funds is on — consolidation is disabled." });
      return;
    }
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
        count,
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
    // Keep the card mounted while signing: a Jade round-trip takes real time,
    // and the Confirm button's spinner is the only progress cue. The card
    // clears on success (replaced by the pending-broadcast card) and stays on
    // error so the user can retry or cancel.
    setBusyAsset(p.assetId);
    setNotice(null);
    try {
      const sent = await wallet.send(
        p.pset,
        {
          address: p.address,
          recipientAmount: p.recipientAmount,
          feeAmount: p.feeAmount,
          drain: true,
          toSelf: p.toSelf,
          ...(p.isToken
            ? { assetId: p.assetId, assetPrecision: undefined, assetTicker: undefined }
            : {}),
        },
        needsPassword ? password : undefined,
      );
      // Track the tx instead of a one-line notice: the pending card shows the
      // txid and the poll above clears it once the list reflects the spend.
      setBroadcasts((b) => ({
        ...b,
        [broadcastKey(p.assetId)]: {
          txid: sent.txid,
          spent: (utxos ?? []).filter((u) => u.asset === p.assetId).map((u) => `${u.txid}:${u.vout}`),
          polls: 0,
        },
      }));
      setPendingConsolidation(null);
      setPassword("");
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

  // Full-screen error only before the first list lands; once UTXOs are on
  // screen, a failed refresh surfaces through the notice slot so the list and
  // the pending-consolidation card stay mounted.
  if (!utxos) {
    if (error) return <ErrorText>{error}</ErrorText>;
    return <LoadingPill />;
  }

  if (utxos.length === 0) {
    return <p className="py-8 text-center text-sm text-[color:var(--text-subtle)]">No unspent outputs.</p>;
  }

  // Group by asset, L-BTC (policy asset) first, then by asset id. The parent
  // passes the authoritative id from the last sync (correct on regtest too);
  // the network-derived constant is only the not-yet-synced fallback.
  const policyAsset = policyAssetProp ?? policyAssetId(network);
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
        const broadcast = broadcasts[broadcastKey(assetId)];
        const broadcastUrl = broadcast ? explorerTxUrl(network, broadcast.txid) : null;
        return (
          <div key={assetId}>
            <div className="mb-1.5 flex items-center gap-2">
              <AssetIcon assetId={assetId} label={label} network={network} size="size-5" />
              <span className="text-sm font-medium text-[color:var(--text-primary)]">{label}</span>
              <span className="ml-auto text-xs text-[color:var(--text-subtle)]">
                {hidden ? (
                  <HiddenValue count={3} size={6} className="text-[color:var(--text-subtle)]" />
                ) : (
                  formatAssetAmountExact(total.toString(), precision)
                )}
                {" · "}
                {groupUtxos.length} output{groupUtxos.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="apogee-panel divide-y divide-[color:var(--border-soft)] overflow-hidden rounded-xl border border-[color:var(--border-default)]">
              {groupUtxos.map((u) => (
                <CoinRow key={`${u.txid}:${u.vout}`} utxo={u} assetId={assetId} label={label} precision={precision} network={network} hidden={hidden} />
              ))}
            </div>
            {groupUtxos.length > 1 && !watchOnly && !broadcast && pendingConsolidation?.assetId !== assetId && (
              <Button
                variant="secondary"
                size="sm"
                className="mt-2 w-full"
                disabled={busyAsset !== null}
                onClick={() => void startConsolidate(assetId, isToken, groupUtxos.length)}
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
                  Network fee: {formatBaseUnits(pendingConsolidation.feeAmount)} sats
                </p>
                {needsPassword && (
                  <Field label="Password (auto-lock is off)">
                    <Input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoFocus
                    />
                  </Field>
                )}
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    disabled={busyAsset !== null || autoLock === null || (needsPassword && !password)}
                    onClick={() => void confirmConsolidate()}
                  >
                    {busyAsset ? <Spinner className="size-3" /> : "Confirm"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="flex-1"
                    disabled={busyAsset !== null}
                    onClick={() => {
                      setPendingConsolidation(null);
                      setPassword("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            {broadcast && (
              <div className="mt-2 rounded-xl border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] p-3">
                {broadcast.stuck ? (
                  <p className="text-sm text-[color:var(--text-primary)]">
                    Still pending — the network hasn't shown it yet. Check the explorer.
                  </p>
                ) : (
                  <p className="flex items-center gap-2 text-sm text-[color:var(--text-primary)]">
                    <Spinner className="size-3" />
                    Consolidation pending
                  </p>
                )}
                <div className="mt-1.5 flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate font-mono text-xs text-[color:var(--text-subtle)]" title={broadcast.txid}>
                    {shortenHex(broadcast.txid, 8, 8)}
                  </span>
                  <span className="flex items-center gap-0.5">
                    <CopyIconButton value={broadcast.txid} label="Copy transaction id" />
                    {broadcastUrl && (
                      <a
                        href={broadcastUrl}
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
                {broadcast.stuck && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-2 w-full"
                    onClick={() => dismissBroadcast(assetId)}
                  >
                    Dismiss
                  </Button>
                )}
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
  hidden,
}: {
  utxo: WalletUtxoDTO;
  assetId: string;
  label: string;
  precision: number | null;
  network: LiquidNetwork;
  hidden: boolean;
}) {
  const explorer = explorerTxUrl(network, utxo.txid);
  return (
    <details className="drawer">
      <summary className="flex items-center gap-2.5 px-3 py-2">
        <span
          role="img"
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
          {hidden ? (
            <HiddenValue count={3} size={8} className="text-[color:var(--text-subtle)]" />
          ) : (
            <TelemetryNumber value={`${formatAssetAmountExact(utxo.amount, precision)} ${label}`} glow={false} />
          )}
        </span>
        <ChevronDown size={14} className="drawer-chevron text-[color:var(--text-subtle)]" />
      </summary>
      <div className="flex flex-col gap-2 border-t border-[color:var(--border-soft)] px-3 py-2 text-xs">
        <div className="flex items-center justify-between gap-3">
          {/* The copy button beside it exposes the value, so this label is not
              a keyboard stop — the tooltip is a mouse affordance only. */}
          <span title={`${utxo.txid}:${utxo.vout}`} className="text-[color:var(--text-subtle)]">
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
        <Row
          label="Amount"
          value={hidden ? "•••" : `${formatAssetAmountExact(utxo.amount, precision)} ${label}`}
        />
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
  const [qrFormat, setQrFormat] = useState<"seedqr" | "text">("seedqr");
  const [qrBrightness, setQrBrightness] = useState(100);
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
  // Read through the same live hook the wallet screens use, so the switch and
  // what's on screen can't disagree; this card only writes.
  const demoFundsOn = useDemoFunds();
  function toggleDemoFunds(on: boolean) {
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
  // Also restarts on a text/QR toggle: asking for the QR means starting a
  // separate action on another device (lining up a phone camera, driving a
  // Jade's scanner), which deserves a full window rather than whatever time
  // was left over from the text view, where copy-paste is the usual path.
  //
  // Format and brightness are in the deps for the same reason: calibrating the
  // dimmer while aiming a camera is the workflow this view exists for, and
  // actively dragging a slider is about as clear an "I'm still here" signal as
  // there is. Without them the seed hides mid-calibration and drops the user
  // back to the password prompt. It does mean the window can be held open by
  // fiddling, which is moot — they're already looking at the phrase.
  // Encoding runs on live seed material and throws on anything outside the
  // BIP-39 English wordlist. There is no error boundary in this app, so calling
  // it bare in render would blank the whole side panel WHILE a seed is on
  // screen. Memoized (the countdown re-renders every second, so this would
  // otherwise re-encode the seed ~60x per reveal) and null on failure, which
  // falls back to the plain-word QR rather than losing the view.
  const seedQr = useMemo(() => {
    if (!seed) return null;
    try {
      return encodeStandardSeedQr(seed);
    } catch {
      return null;
    }
  }, [seed]);

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
  }, [seed, showQr, qrFormat, qrBrightness]);

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
                Animations
              </span>
              <span className="text-[11px] text-[color:var(--text-subtle)]">
                Background scene and the balance strike
              </span>
            </span>
            <Switch checked={animated} onChange={setAnimated} label="Animations" />
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
        {/* Raw button (not the Button component) so it reads as a settings row.
            .settings-row (theme.css) carries the pointer cursor and the
            full-card hit area — including the width fix for a bare button's
            shrink-wrap, which the drawer summaries don't need but share. */}
        <button
          type="button"
          onClick={() => onView("coins")}
          className="settings-row"
        >
          <span className="console-overline">Coins</span>
          <ChevronRight size={16} className="text-[color:var(--text-subtle)]" />
        </button>
      </Card>

      {/* OUTSIDE the local-signer gate below on purpose: a Jade and a
          watch-only wallet have exactly the same public data to export, and
          they are the cases where an export matters most, since there is no
          seed phrase to fall back on. A row rather than a drawer: four values
          each needing a tag, a reveal and a copy do not fit under everything
          else in a 400px column. */}
      <Card>
        <button type="button" onClick={() => onView("export")} className="settings-row">
          {/* Share: a tray with an arrow leaving it, which is what this row does
              — hand wallet data to something outside Apogee.

              Two shapes were ruled out on the way here. A key reads as spending
              authority, which is the one thing none of this grants, so it would
              contradict every line of copy on the screen it opens. A
              box-with-arrow-out (LogOut) reads as sign out, and the app header
              directly above already carries a Lock, so the two would compete.

              A leading icon here and not on the Coins row above is the rule
              rather than an inconsistency: an icon marks rows that disclose
              something, the way Eye marks "Reveal seed phrase" below. Coins is
              navigation to a list and discloses nothing new. */}
          <span className="flex items-center gap-1.5 console-overline">
            <Share size={13} />
            Export wallet data
          </span>
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
                setQrFormat("seedqr");
                setQrBrightness(100);
              }
            }}
          >
            <summary className="settings-row">
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
                    <div className="flex flex-col items-center gap-1.5">
                      <div
                        className="flex justify-center rounded-lg p-3"
                        style={{ background: qrBgColor(qrBrightness) }}
                      >
                        {/* size drives module resolution; the classes let the
                            rendered svg scale down instead of overflowing a
                            narrowed side panel, where the clipped edge would be
                            unscannable and unreachable by scrolling. */}
                        <QRCodeSVG
                          value={qrFormat === "seedqr" && seedQr ? seedQr : seed}
                          size={260}
                          className="h-auto w-full max-w-[260px]"
                          level="M"
                          fgColor="#000000"
                          bgColor={qrBgColor(qrBrightness)}
                        />
                      </div>
                      {/* Both formats scan into a Jade; other wallets' scanners
                          generally read only the plain-word one, so the choice
                          stays the user's. Deliberately NOT .console-overline:
                          its uppercase transform mangles "SeedQR" into
                          "SEEDQR", which doesn't read. */}
                      <div className="mt-2 flex w-full gap-1" role="group" aria-label="QR format">
                        {([
                          ["seedqr", "SeedQR"],
                          ["text", "Text"],
                        ] as const).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => setQrFormat(value)}
                            aria-pressed={qrFormat === value}
                            className={cn(
                              "flex-1 rounded-md border px-2 py-1 text-[11px] transition",
                              qrFormat === value
                                ? "border-[color:var(--accent)] bg-[color:var(--accent-soft)] text-[color:var(--text-strong)]"
                                : "border-[color:var(--border-default)] text-[color:var(--text-subtle)] hover:border-[color:var(--border-hover)]",
                            )}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <div className="mt-2 flex w-full items-center gap-2">
                        <span className="console-overline text-[10px] text-[color:var(--text-secondary)]">
                          Brightness
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={qrBrightness}
                          onChange={(e) => setQrBrightness(Number(e.target.value))}
                          aria-label="QR brightness"
                          className="telemetry-slider flex-1"
                          style={{
                            background: `linear-gradient(to right, var(--telemetry-halo) ${qrBrightness}%, color-mix(in srgb, var(--telemetry-halo) 14%, transparent) ${qrBrightness}%)`,
                          }}
                        />
                        <span className="font-telemetry telemetry-glow w-7 text-right text-xs leading-none">
                          {qrBrightness}
                        </span>
                      </div>
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
          <summary className="settings-row">
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
            <summary className="settings-row">
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
          <summary className="settings-row">
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

/** Interpolates the SeedQR background between white (100, max contrast) and a
 *  dark gray (0) — foreground stays pure black throughout. Screens can't get
 *  brighter than white via CSS, so this control is really a dimmer: useful
 *  when a camera's exposure is blown out by screen glare, not for exceeding
 *  the display's own peak brightness. */
function qrBgColor(brightness: number): string {
  const level = Math.round(64 + ((255 - 64) * Math.max(0, Math.min(100, brightness))) / 100);
  const hex = level.toString(16).padStart(2, "0");
  return `#${hex}${hex}${hex}`;
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
  // buttons, and "Show as QR code" then swaps the phrase for a QR plus a format
  // toggle and a brightness row —
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
      // 44px and not 12: the non-centered container wears .apogee-feather-top,
      // whose mask runs transparent -> opaque across its first 40px, so a header
      // parked inside that band gets scrolled into view and then half dissolved.
      // 44 = 40 + the 4px of full opacity it keeps. KEEP IN SYNC with that
      // gradient in theme.css.
      const target = details.querySelector("summary") ?? details;
      const top = target.getBoundingClientRect().top - cRect.top - 44;
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
          center ? "flex flex-col justify-center" : "apogee-feather-top pt-10",
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
  return view === "receive" ? "Receive" : view === "send" ? "Send" : view === "swap" ? "Swap" : view === "coins" ? "Coins" : view === "export" ? "Export wallet data" : "Settings";
}
