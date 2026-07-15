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
  Unplug,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import type { AssetInfo, SyncResult, WalletTxDTO } from "@/engine/protocol";
import type { KeystoreState, LiquidNetwork, WalletInfo } from "@/keystore/keystore";
import { explorerTxUrl } from "@/lib/explorer";
import { APP_VERSION_DISPLAY } from "@/version";
import { KNOWN_ASSETS } from "@/lib/asset-registry";
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
  ErrorText,
  Field,
  HiddenValue,
  IconButton,
  Input,
  LoadingPill,
  Spinner,
  StatusDot,
  Switch,
} from "@/sidepanel/components/ui";
import { errMessage, unlockErrMessage, wallet } from "@/sidepanel/wallet-client";
import { useAnimations } from "@/sidepanel/use-animations";
import { Send } from "@/sidepanel/screens/Send";
import type { ToastNotice } from "@/sidepanel/components/Toast";

export type View = "home" | "receive" | "send" | "settings";

const HIDE_KEY = "apogee:hideBalance";
const TX_PAGE = 25; // transactions rendered per lazy-load page

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

type Denom = "btc" | "sats" | "fiat";
const DENOM_ORDER: Denom[] = ["btc", "sats", "fiat"];
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
  const [hidden, toggleHidden] = useHideBalance();
  const [denom, setDenom, cycleDenom] = useDenomination();
  const [fiat, setFiat] = useFiat();
  const [rate, setRate] = useState<number | null>(null);
  const [rateFailed, setRateFailed] = useState(false);
  const [sync, setSync] = useState<SyncResult | null>(null);
  const [txs, setTxs] = useState<WalletTxDTO[]>([]);
  const [assets, setAssets] = useState<Record<string, AssetInfo>>({});
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
  }, [active?.id]);

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
    onToast({
      id: Date.now(),
      title: received ? "Received" : "Sent",
      message: `${formatSats(Math.abs(tx.balanceChange))} sats`,
      kind: received ? "success" : "info",
    });
  }, [sync, txs, onToast]);

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
        {view === "receive" && <Receive walletId={active.id} />}
        {view === "send" && (
          <Send
            maxSats={sync ? sync.lbtcSats : 0}
            network={active.network}
            // Enter in BTC when that's the chosen denomination; sats otherwise
            // (incl. fiat — the hero shows sats alongside the fiat figure).
            unit={denom === "btc" ? "btc" : "sats"}
            // A Jade wallet signs on-device in a tab; the Send UI cues the user.
            isJade={active.signer === "jade"}
            onDone={() => {
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
    amountNode = <HiddenValue count={5} size={16} gap={9} />;
  } else if (denom === "fiat") {
    amountNode =
      rate != null ? (
        formatFiat(satsToFiat(sats, rate), fiat)
      ) : rateFailed ? (
        "—"
      ) : (
        <Spinner className="size-6" />
      );
  } else if (denom === "sats") {
    amountNode = formatSats(sats);
  } else {
    amountNode = formatBtc(sats);
  }
  let subtitle = unitLabel;
  if (!showStars && denom === "btc") {
    subtitle = `L-BTC · ${formatSats(sats)} sats`;
  } else if (!showStars && denom === "fiat") {
    subtitle = `${fiat} · ${formatSats(sats)} sats`;
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Balance frame — fixed above the scrollable activity list. */}
      <div className="shrink-0 px-4 pb-5 pt-6">
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
          aria-label="Change denomination"
          className={cn(
            "flex w-full flex-col items-center gap-0.5 py-4 text-[color:var(--text-strong)]",
            pulse && "animate-pulse",
          )}
        >
          <span className="flex h-9 items-center justify-center text-3xl font-semibold tracking-tight">
            {amountNode}
          </span>
          <span className="text-xs uppercase tracking-wide text-[color:var(--text-subtle)]">
            {subtitle}
          </span>
        </button>

        <div className="mt-3 flex gap-2">
          <Button className="flex-1" onClick={() => onView("send")}>
            <ArrowUp size={16} /> Send
          </Button>
          <Button variant="secondary" className="flex-1" onClick={() => onView("receive")}>
            <ArrowDown size={16} /> Receive
          </Button>
        </div>
      </div>

      {/* Scrollable activity list. */}
      <div ref={scrollRef} className="apogee-scrollbar flex-1 overflow-y-auto px-4 pb-4 pt-1">
        <ErrorText>{error}</ErrorText>
        <Tokens sync={sync} hidden={hidden} assets={assets} />
        <h2 className="mb-2 mt-3 px-1 text-xs font-semibold uppercase tracking-wide text-[color:var(--text-overline)]">
          Activity
        </h2>
        {txs.length === 0 ? (
          <p className="px-1 text-xs text-[color:var(--text-subtle)]">
            {syncing ? "Loading…" : "No transactions yet."}
          </p>
        ) : (
          <>
            <div className="apogee-panel divide-y divide-[color:var(--border-soft)] overflow-hidden rounded-2xl border border-[color:var(--border-default)]">
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
    </div>
  );
}

function Tokens({
  sync,
  hidden,
  assets,
}: {
  sync: SyncResult | null;
  hidden: boolean;
  assets: Record<string, AssetInfo>;
}) {
  const tokens = sync
    ? Object.entries(sync.balance).filter(([a, amt]) => a !== sync.policyAssetHex && amt > 0)
    : [];
  if (tokens.length === 0) return null;
  return (
    <div className="mt-1">
      <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-[color:var(--text-overline)]">
        Tokens
      </h2>
      <div className="apogee-panel divide-y divide-[color:var(--border-soft)] overflow-hidden rounded-2xl border border-[color:var(--border-default)]">
        {tokens.map(([asset, amt]) => {
          const info = assets[asset];
          const label =
            KNOWN_ASSETS[asset] ?? info?.ticker ?? info?.name ?? shortenHex(asset, 6, 6);
          // Scale the raw base-unit balance by the asset's precision (e.g. a
          // precision-3 TEST balance of 1000 → "1.000"); unknown precision falls
          // back to the raw integer.
          const amountLabel = formatAssetAmount(amt, info?.precision ?? null);
          return (
            <details
              key={asset}
              className="drawer"
            >
              <summary className="flex items-center justify-between px-3 py-2">
                <span className="text-sm text-[color:var(--text-primary)]">{label}</span>
                <span className="flex items-center gap-2">
                  <span className="text-[color:var(--text-strong)]">
                    {hidden ? (
                      <HiddenValue count={3} size={8} className="text-[color:var(--text-subtle)]" />
                    ) : (
                      amountLabel
                    )}
                  </span>
                  <ChevronDown size={14} className="drawer-chevron text-[color:var(--text-subtle)]" />
                </span>
              </summary>
              <div className="flex flex-col gap-2 border-t border-[color:var(--border-soft)] px-3 py-2 text-xs">
                <div className="flex flex-col gap-1">
                  <span className="text-[color:var(--text-subtle)]">Asset ID</span>
                  <span className="break-all font-mono text-[color:var(--text-primary)]">{asset}</span>
                </div>
                {info?.name && <Row label="Name" value={info.name} />}
                {info?.ticker && <Row label="Ticker" value={info.ticker} />}
                {info?.precision != null && <Row label="Precision" value={String(info.precision)} />}
                <CopyButton value={asset} label="Copy asset ID" />
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
    const label = KNOWN_ASSETS[id] ?? info?.ticker ?? info?.name ?? shortenHex(id, 4, 4);
    amountText = `${delta > 0 ? "+" : ""}${formatAssetAmount(delta, info?.precision ?? null)} ${label}`;
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
          <span
            className={cn("text-sm font-medium text-[color:var(--text-strong)]", pending && "animate-pulse")}
          >
            {hidden ? (
              <HiddenValue count={3} size={8} className="text-[color:var(--text-subtle)]" />
            ) : (
              amountText
            )}
          </span>
          <ChevronDown size={14} className="drawer-chevron text-[color:var(--text-subtle)]" />
        </span>
      </summary>
      <div className="flex flex-col gap-2 border-t border-[color:var(--border-soft)] px-3 py-2 text-xs">
        <div className="flex flex-col gap-1">
          <span className="text-[color:var(--text-subtle)]">Transaction</span>
          <span className="break-all font-mono text-[color:var(--text-primary)]">{tx.txid}</span>
        </div>
        <Row label="Time" value={formatTimestamp(tx.timestamp)} />
        <Row label="Status" value={pending ? "Unconfirmed" : `Block ${tx.height}`} />
        <Row
          label="Fee"
          value={denom === "fiat" ? lbtcAmount(tx.fee) : `${lbtcAmount(tx.fee)} ${unitLabel}`}
        />
        <div className="mt-1 grid grid-cols-2 gap-2">
          <CopyButton value={tx.txid} label="Copy txid" className="w-full" />
          {explorer && (
            <a
              href={explorer}
              target="_blank"
              rel="noreferrer"
              className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] text-xs font-semibold text-[color:var(--text-primary)] transition hover:border-[color:var(--border-hover)]"
            >
              <ExternalLink size={13} /> Explorer
            </a>
          )}
        </div>
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
      <h2 className="mb-3 text-center text-xs font-semibold uppercase tracking-wide text-[color:var(--text-overline)]">
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
          <p className="w-full break-all rounded-lg border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] p-3 font-mono text-xs text-[color:var(--text-strong)]">
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
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--text-overline)]">
          Wallet
        </h2>
        <dl className="flex flex-col gap-1 text-xs">
          <Row label="Label" value={info.label} />
          <Row label="Network" value={info.network} />
          <Row label="Signer" value={info.signer === "jade" ? "Blockstream Jade" : "Local seed"} />
          <Row label="Fingerprint" value={info.fingerprint} mono />
          <Row label="Version" value={`v${APP_VERSION_DISPLAY}`} />
        </dl>
      </Card>

      {sites.length > 0 && (
        <Card>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--text-overline)]">
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
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--text-overline)]">
          Display
        </h2>
        <div className="flex flex-col gap-3">
          <Field label="Denomination">
            <select
              value={denom}
              onChange={(e) => onDenomChange(e.target.value as Denom)}
              className="h-11 w-full rounded-lg border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] px-3 text-sm text-[color:var(--text-strong)] outline-none focus:border-[color:var(--accent)]"
            >
              <option value="sats">Sats</option>
              <option value="btc">L-BTC</option>
              <option value="fiat">{fiat}</option>
            </select>
          </Field>
          <Field label="Currency">
            <select
              value={fiat}
              onChange={(e) => onFiatChange(e.target.value)}
              className="h-11 w-full rounded-lg border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] px-3 text-sm text-[color:var(--text-strong)] outline-none focus:border-[color:var(--accent)]"
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
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--text-overline)]">
          Security
        </h2>
        <Field label="Auto-lock after inactivity">
          <select
            value={autoLock}
            onChange={(e) => changeAutoLock(Number(e.target.value))}
            className="h-11 w-full rounded-lg border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] px-3 text-sm text-[color:var(--text-strong)] outline-none focus:border-[color:var(--accent)]"
          >
            {AUTO_LOCK_OPTIONS.map((o) => (
              <option key={o.minutes} value={o.minutes}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      </Card>

      {info.signer !== "jade" && (
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
              <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[color:var(--text-overline)]">
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
                    <p className="break-words rounded-lg border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] p-3 font-mono text-xs text-[color:var(--text-strong)]">
                      {seed}
                    </p>
                  )}
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
            <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[color:var(--danger-text)]">
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
      <footer className="-mx-4 -mb-4 mt-auto flex flex-col gap-2 px-4 pt-10 pb-5 text-[color:var(--text-muted)]">
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
        <h1 className="text-sm font-semibold text-[color:var(--text-strong)]">{title}</h1>
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

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[color:var(--text-subtle)]">{label}</dt>
      <dd className={cn("truncate text-[color:var(--text-primary)]", mono && "font-mono")}>{value}</dd>
    </div>
  );
}

function titleFor(view: View): string {
  return view === "receive" ? "Receive" : view === "send" ? "Send" : "Settings";
}
