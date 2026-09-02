// Wallet engine core. lwk_wasm (Wollet / Signer / EsploraClient) lives here,
// driven through the single `handle(req)` dispatcher. Its one runtime host is the
// offscreen document (src/offscreen/offscreen.ts) — the MV3 service worker is
// ephemeral and CSP-restricted, so it can't hold wasm itself.
// lwk_wasm is loaded lazily on first use, so a request can't be dropped while the
// wasm initializes (a standard lazy-load pattern).
//
// Watch-only Wollets are cached per descriptor so repeated sync/balance/address
// calls reuse applied chain state. The signing seed is NEVER cached — it arrives
// per `signPset` call from the keystore and is dropped when the call returns.

import type * as Lwk from "lwk_wasm";
import type { LiquidNetwork } from "@/keystore/keystore";
import {
  DEBUG_ENTERPRISE_BUILD,
  ENTERPRISE_CLIENT_ID,
  ENTERPRISE_CLIENT_SECRET,
  ENTERPRISE_TOKEN_URL,
} from "@/lib/debug";
import { SCAN_STATE_DB } from "@/engine/protocol";
import { exactRecipientAmount } from "./recipient-amount";
import { extractElementsTxOut } from "./elements-txout";
import { collectProviderUtxos } from "./provider-utxos";
import {
  analyzeAndSignProviderPset,
  analyzeProviderPset,
  type NormalizedProviderPsetSignInput,
} from "./provider-pset-analyzer";
import { publicWalletDescriptor } from "./public-wallet-descriptor";
import { verifyDealerPset } from "@/engine/verify-dealer-pset";
import { getTxManifestSupport } from "@/tx-manifest/registry";
import { resolveTxManifestRequirementsWithAdapter } from "@/tx-manifest/adapters";
import { txManifestHistoryAnnotation } from "@/tx-manifest/history";
import { convergeTxManifestFee } from "@/tx-manifest/fees";
import {
  TX_MANIFEST_MINIMUM_POST_FEE_LBTC_CHANGE,
  txManifestLbtcChangeDecision,
} from "@/tx-manifest/change-policy";
import {
  isTxManifestExecutionNetwork,
  txManifestRuntimeNetwork,
} from "@/tx-manifest/network";
import {
  dryRunLendingV3AcceptOfferExecution,
  prepareLendingV3AcceptOffer,
} from "@/tx-manifest/prepare-accept-offer";
import {
  dryRunLendingV3ClaimLenderVaultExecution,
  prepareLendingV3ClaimLenderVault,
} from "@/tx-manifest/prepare-claim-lender-vault";
import {
  prepareLendingV3CreateFactory,
  prepareLendingV3CreateOffer,
} from "@/tx-manifest/prepare-create";
import { prepareLendingV3BorrowerAction } from "@/tx-manifest/prepare-lending-action";
import {
  SIMPLICITY_LENDING_V3_CANCEL_OFFER,
  SIMPLICITY_LENDING_V3_CLAIM_PRINCIPAL,
  SIMPLICITY_LENDING_V3_CREATE_FACTORY,
  SIMPLICITY_LENDING_V3_CREATE_OFFER,
  SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER,
  SIMPLICITY_LENDING_V3_REPAY_LOAN,
} from "@/tx-manifest/builtins/simplicity-lending-v3";
import {
  recoverExplicitWalletInputCandidate,
  selectAcceptOfferWalletInputs,
  selectClaimLenderVaultWalletInputs,
  selectManifestWalletInputs,
  selectManifestWalletInputByOutpoint,
  type AcceptOfferWalletCandidate,
  type HostedPreparedAcceptOfferExecution,
  type HostedPreparedClaimLenderVaultExecution,
  type HostedPreparedNewLendingExecution,
} from "@/tx-manifest/wallet-host";
import {
  compileTxManifestCovenant,
  buildTxManifestPset,
  dryRunTxManifestCovenant,
  finalizeTxManifestCovenant,
  inspectTxManifestAddress,
  inspectTxManifestTransactionOutput,
  estimateTxManifestFee,
} from "@/tx-manifest/runtime";
import type {
  AddressDTO,
  AssetInfo,
  ChainServerHealth,
  DerivedWallet,
  DescriptorInfo,
  EngineRequest,
  PrepareSendResult,
  PriceHistory,
  PriceRange,
  ProviderProbe,
  ProviderPsetAnalysisResultDTO,
  ProviderPsetSignInputDTO,
  ProviderPsetSignResultDTO,
  PublicWalletDescriptorDTO,
  ProbeStatus,
  SendResult,
  SignSwapPsetWireResult,
  SyncResult,
  UtxoDTO,
  WalletIdentity,
  WalletUtxoDTO,
  WalletTxDTO,
} from "@/engine/protocol";

let lwkPromise: Promise<typeof Lwk> | null = null;
function loadLwk(): Promise<typeof Lwk> {
  if (!lwkPromise) lwkPromise = import("lwk_wasm");
  return lwkPromise;
}

/**
 * Waterfalls servers (the public instance behind liquidwebwallet.org).
 * Waterfalls collapses a full descriptor scan into a SINGLE request, instead of
 * the ~40 gap-limit address queries a plain Esplora scan fires — which is what
 * trips public-endpoint rate limits (HTTP 429). lwk first fetches the server's
 * age recipient key (/v1/server_recipient) and ENCRYPTS the descriptor to it,
 * so our explicit ct(slip77(...)) blinding key is never sent in cleartext.
 */
const WATERFALLS: Record<LiquidNetwork, string> = {
  liquid: "https://waterfalls.liquidwebwallet.org/liquid/api",
  liquidtestnet: "https://waterfalls.liquidwebwallet.org/liquidtestnet/api",
  regtest: "http://localhost:3000",
};

/** Primary plain-Esplora provider — scan fallback and broadcasts.
 *  liquid.network tolerates scan bursts; blockstream.info rate-limits the same
 *  traffic aggressively (HTTP 429), which matters most exactly when clients
 *  are failing over from waterfalls. */
const ESPLORA: Record<LiquidNetwork, string> = {
  liquid: "https://liquid.network/api",
  liquidtestnet: "https://liquid.network/liquidtestnet/api",
  regtest: "http://localhost:3000",
};

/** Second plain-Esplora provider (scan + broadcast failover). */
const ESPLORA_ALT: Record<LiquidNetwork, string> = {
  liquid: "https://blockstream.info/liquid/api",
  liquidtestnet: "https://blockstream.info/liquidtestnet/api",
  regtest: "http://localhost:3000",
};

// ---- debug: enterprise Esplora auth (local builds only; see lib/debug.ts) ----
//
// lwk's EsploraClient can't set headers, so when a debug build routes to the
// enterprise endpoint (via the chain-server override channel), this fetch
// wrapper attaches the OAuth bearer token for that host — cached and refreshed
// via the client-credentials grant. Inert (never installed) without .env.local.
const originalFetch = globalThis.fetch.bind(globalThis);
let enterpriseTokenCache: { token: string; expiresAt: number } | null = null;

async function enterpriseToken(): Promise<string> {
  if (enterpriseTokenCache && Date.now() < enterpriseTokenCache.expiresAt - 60_000) {
    return enterpriseTokenCache.token;
  }
  const res = await originalFetch(ENTERPRISE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: ENTERPRISE_CLIENT_ID ?? "",
      client_secret: ENTERPRISE_CLIENT_SECRET ?? "",
      grant_type: "client_credentials",
      scope: "openid",
    }),
  });
  if (!res.ok) throw new Error(`enterprise auth failed (${res.status})`);
  const j = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error("enterprise auth failed (no token)");
  enterpriseTokenCache = {
    token: j.access_token,
    expiresAt: Date.now() + (j.expires_in ?? 300) * 1000,
  };
  return enterpriseTokenCache.token;
}

if (DEBUG_ENTERPRISE_BUILD) {
  console.log("[apogee] debug build: enterprise auth wrapper installed");
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://enterprise.blockstream.info/")) {
      const token = await enterpriseToken();
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      headers.set("Authorization", `Bearer ${token}`);
      return originalFetch(input, { ...init, headers });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

/** Genesis block hash per network — the chain fingerprint a user-supplied
 *  Esplora server is validated against (regtest genesis varies per chain, so
 *  it's null and only reachability is checked). */
const GENESIS: Record<LiquidNetwork, string | null> = {
  liquid: "1466275836220db2944ca059a3a10ef6fd2ea684b0688d2c379296888a206003",
  liquidtestnet: "a771da8e52ee6ad581ed1e9a99825e5b3b7992225534eaa2ae23244fe26ab1c1",
  regtest: null,
};

interface CachedWollet {
  wollet: Lwk.Wollet;
  policyAssetHex: string;
  wd: Lwk.WolletDescriptor;
  stateKey: string;
  updates: string[]; // persisted scan state: serialized lwk Updates, oldest first
  lastWasTipOnly: boolean; // whether updates[last] only moved the chain tip
}
const wollets = new Map<string, CachedWollet>();

// ---- persistent scan state --------------------------------------------------
//
// lwk scan Updates are persisted per wallet so a rebuilt offscreen document
// REHYDRATES its Wollet instead of re-scanning from scratch. A from-scratch
// scan is a 40–100 request burst that public Esplora endpoints rate-limit
// (HTTP 429); with state persisted, scans are incremental — a handful of
// requests — so they stay fast and under every limiter. Updates are stored
// encrypted by lwk with a descriptor-derived key. Tip-only updates (nothing
// changed but the chain tip) replace the previous tip-only entry, keeping the
// stored array roughly the number of updates that actually changed the wallet;
// past a size cap the state is dropped outright (one fresh scan) rather than
// growing unbounded. The service worker deletes the database on wallet/reset.
// Stored in IndexedDB: an offscreen document has no browser.storage (offscreen
// pages only get browser.runtime), and the service worker can reach the same
// IndexedDB database to delete it on wallet/reset.
const SCAN_STATE_PREFIX = "apogee:scanstate:";
const SCAN_STATE_MAX_CHARS = 3_000_000; // ~3 MB of base64 per wallet
const SCAN_STORE = "updates";

function openScanDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SCAN_STATE_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(SCAN_STORE)) {
        req.result.createObjectStore(SCAN_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

// Open-per-operation with a close in finally: scan-state I/O is low frequency,
// and holding no connection means the SW's deleteDatabase on reset never blocks.
async function scanStateGet(key: string): Promise<string[] | undefined> {
  const db = await openScanDb();
  try {
    return await new Promise((resolve, reject) => {
      const rq = db.transaction(SCAN_STORE, "readonly").objectStore(SCAN_STORE).get(key);
      rq.onsuccess = () => resolve(rq.result as string[] | undefined);
      rq.onerror = () => reject(rq.error ?? new Error("IndexedDB get failed"));
    });
  } finally {
    db.close();
  }
}

async function scanStateSet(key: string, value: string[]): Promise<void> {
  const db = await openScanDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const rq = db.transaction(SCAN_STORE, "readwrite").objectStore(SCAN_STORE).put(value, key);
      rq.onsuccess = () => resolve();
      rq.onerror = () => reject(rq.error ?? new Error("IndexedDB put failed"));
    });
  } finally {
    db.close();
  }
}

async function scanStateDel(key: string): Promise<void> {
  const db = await openScanDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const rq = db.transaction(SCAN_STORE, "readwrite").objectStore(SCAN_STORE).delete(key);
      rq.onsuccess = () => resolve();
      rq.onerror = () => reject(rq.error ?? new Error("IndexedDB delete failed"));
    });
  } finally {
    db.close();
  }
}

async function scanStateKey(network: LiquidNetwork, descriptor: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(descriptor));
  const hex = bytesToHex(new Uint8Array(digest));
  return `${SCAN_STATE_PREFIX}${network}:${hex.slice(0, 16)}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Append (or tip-replace) one serialized update and persist the array. The
 *  serialization happens at the call site BEFORE applyUpdate, so we never
 *  touch the wasm Update object after handing it to the wollet.
 *
 *  Coalescing assumption (pinned deliberately): consecutive tip-only updates
 *  are each relative to the same applied base, so replacing the previous
 *  tip-only entry is equivalent to keeping both. If lwk ever made Updates
 *  strictly sequential deltas, replacement would corrupt replay — revisit if
 *  lwk's Update semantics change. */
async function persistScanUpdate(
  entry: CachedWollet,
  serialized: string,
  tipOnly: boolean,
): Promise<void> {
  try {
    if (tipOnly && entry.lastWasTipOnly && entry.updates.length > 0) {
      entry.updates[entry.updates.length - 1] = serialized;
    } else {
      entry.updates.push(serialized);
    }
    entry.lastWasTipOnly = tipOnly;
    const total = entry.updates.reduce((n, s) => n + s.length, 0);
    if (total > SCAN_STATE_MAX_CHARS) {
      // Too big to keep replaying — drop the persisted copy. The in-memory
      // wollet stays correct; the next offscreen rebuild does one fresh scan.
      entry.updates = [];
      entry.lastWasTipOnly = false;
      await scanStateDel(entry.stateKey);
      return;
    }
    await scanStateSet(entry.stateKey, entry.updates);
  } catch (e) {
    console.warn("[apogee] persisting scan state failed", e);
  }
}

function lwkNetwork(lwk: typeof Lwk, network: LiquidNetwork): Lwk.Network {
  switch (network) {
    case "liquid":
      return lwk.Network.mainnet();
    case "liquidtestnet":
      return lwk.Network.testnet();
    case "regtest":
      return lwk.Network.regtestDefault();
  }
}

function normalizeProviderPsetSignInputs(
  lwk: typeof Lwk,
  network: Lwk.Network,
  inputs: readonly ProviderPsetSignInputDTO[],
):
  | { ok: true; inputs: NormalizedProviderPsetSignInput[] }
  | { ok: false; result: ProviderPsetAnalysisResultDTO } {
  const normalized: NormalizedProviderPsetSignInput[] = [];
  for (const input of inputs) {
    try {
      const address = lwk.Address.parse(input.address, network);
      try {
        const script = address.scriptPubkey();
        try {
          normalized.push({
            index: input.index,
            address: address.toString(),
            scriptPubKey: script.toString(),
            ...(input.sighashTypes ? { sighashTypes: [...input.sighashTypes] } : {}),
          });
        } finally {
          script.free();
        }
      } finally {
        address.free();
      }
    } catch {
      return {
        ok: false,
        result: { ok: false, reason: "invalid_address", inputIndex: input.index },
      };
    }
  }
  return { ok: true, inputs: normalized };
}

/** Normalize lwk's Balance (Map or plain object) to assetHex → sats.
 *  Amounts are coerced to JS number; safe for LBTC (max supply ~2.1e15 sats is
 *  well under Number.MAX_SAFE_INTEGER, 2^53 ≈ 9e15). */
function balanceToRecord(balance: Lwk.Balance): Record<string, number> {
  const out: Record<string, number> = {};
  let raw: unknown;
  try {
    raw = balance.toJSON();
  } catch {
    raw = undefined;
  }
  if (raw instanceof Map) {
    raw.forEach((v, k) => {
      out[String(k)] = Number(v);
    });
  } else if (raw && typeof raw === "object") {
    for (const [asset, amount] of Object.entries(raw as Record<string, unknown>)) {
      out[asset] = Number(amount);
    }
  }
  return out;
}

function balanceToStringRecord(balance: Lwk.Balance): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: unknown;
  try {
    raw = balance.toJSON();
  } catch {
    raw = undefined;
  }
  if (raw instanceof Map) {
    raw.forEach((value, asset) => {
      out[String(asset)] = String(value);
    });
  } else if (raw && typeof raw === "object") {
    for (const [asset, amount] of Object.entries(raw as Record<string, unknown>)) {
      out[asset] = String(amount);
    }
  }
  return out;
}

// Order wallet transactions newest-first for display. Unconfirmed txs (no
// height) sort first, then by block height descending. Transactions in the SAME
// block share height and timestamp, so lwk can't disambiguate them; we break the
// tie by spend dependency — a tx is placed above any same-block tx whose output
// it spends, since the spender is necessarily the later of the two. `spendsFrom`
// maps each txid to the set of wallet txids it spends from.
function orderTransactionsNewestFirst(
  txs: WalletTxDTO[],
  spendsFrom: Map<string, Set<string>>,
): WalletTxDTO[] {
  const heightRank = (t: WalletTxDTO) => t.height ?? Number.MAX_SAFE_INTEGER;
  const ordered = [...txs].sort((a, b) => heightRank(b) - heightRank(a));

  // Reorder each run of same-height txs so spenders precede what they spend.
  const result: WalletTxDTO[] = [];
  for (let i = 0; i < ordered.length; ) {
    let j = i + 1;
    while (j < ordered.length && heightRank(ordered[j]) === heightRank(ordered[i])) j++;
    const group = ordered.slice(i, j);
    result.push(...(group.length > 1 ? orderBlockBySpends(group, spendsFrom) : group));
    i = j;
  }
  return result;
}

// Topological order within one block: each tx comes before any tx in the group
// whose output it spends (Kahn's algorithm). Ties keep the group's existing
// order so the result is stable. Groups are tiny — the txs sharing one block.
function orderBlockBySpends(
  group: WalletTxDTO[],
  spendsFrom: Map<string, Set<string>>,
): WalletTxDTO[] {
  const inGroup = new Set(group.map((t) => t.txid));
  // indegree[x] = number of group txs that spend x (must be emitted before x).
  const indegree = new Map<string, number>(group.map((t) => [t.txid, 0]));
  for (const t of group) {
    for (const prev of spendsFrom.get(t.txid) ?? []) {
      if (inGroup.has(prev)) indegree.set(prev, (indegree.get(prev) ?? 0) + 1);
    }
  }
  const remaining = [...group];
  const out: WalletTxDTO[] = [];
  while (remaining.length > 0) {
    // Candidates that nothing-in-group spends are the most recent. Among those,
    // emit outgoing txs (net-negative balance) first: when two same-block txs
    // have no spend relationship to order them, this matches the common
    // "received, then sent" reading. A cycle (impossible for a real tx graph)
    // falls back to the head so the loop always makes progress.
    let pick = -1;
    for (let k = 0; k < remaining.length; k++) {
      if ((indegree.get(remaining[k].txid) ?? 0) !== 0) continue;
      if (pick === -1 || (remaining[k].balanceChange < 0 && remaining[pick].balanceChange >= 0)) {
        pick = k;
      }
    }
    if (pick === -1) pick = 0;
    const [t] = remaining.splice(pick, 1);
    out.push(t);
    for (const prev of spendsFrom.get(t.txid) ?? []) {
      if (indegree.has(prev)) indegree.set(prev, (indegree.get(prev) ?? 1) - 1);
    }
  }
  return out;
}

async function ensureWollet(
  lwk: typeof Lwk,
  descriptor: string,
  network: LiquidNetwork,
): Promise<CachedWollet> {
  let entry = wollets.get(descriptor);
  if (!entry) {
    const net = lwkNetwork(lwk, network);
    const wd = new lwk.WolletDescriptor(descriptor);
    let wollet = new lwk.Wollet(net, wd);
    const stateKey = await scanStateKey(network, descriptor);
    let updates: string[] = [];
    let lastWasTipOnly = false;
    // Rehydrate persisted scan state (see the scan-state block above). Any
    // failure mid-replay leaves the wollet partial — rebuild it clean and drop
    // the stored state so the next sync starts a fresh scan.
    try {
      const stored = await scanStateGet(stateKey);
      if (Array.isArray(stored) && stored.every((s) => typeof s === "string")) {
        for (const s of stored as string[]) {
          const u = lwk.Update.deserializeDecryptedBase64(s, wd);
          lastWasTipOnly = u.onlyTip();
          wollet.applyUpdate(u);
        }
        updates = stored as string[];
        if (updates.length > 0) {
          console.log(`[apogee] rehydrated scan state (${updates.length} updates)`);
        }
      }
    } catch (e) {
      console.warn("[apogee] scan-state rehydrate failed, starting fresh", e);
      wollet = new lwk.Wollet(net, wd);
      updates = [];
      lastWasTipOnly = false;
      await scanStateDel(stateKey).catch(() => {});
    }
    entry = {
      wollet,
      policyAssetHex: net.policyAsset().toString(),
      wd,
      stateKey,
      updates,
      lastWasTipOnly,
    };
    wollets.set(descriptor, entry);
  }
  return entry;
}

/** Broadcast with one-hop failover: primary provider, then the alternate — a
 *  throttled or unreachable primary must never block a send. A user-pinned
 *  chain server (esploraUrl) is respected exactly, with no failover. */
async function broadcastResilient(
  lwk: typeof Lwk,
  net: Lwk.Network,
  network: LiquidNetwork,
  signed: Lwk.Pset,
  esploraUrl?: string,
): Promise<string> {
  if (esploraUrl) {
    const txid = await new lwk.EsploraClient(net, esploraUrl, false, 1, false).broadcast(signed);
    return txid.toString();
  }
  try {
    const txid = await new lwk.EsploraClient(net, ESPLORA[network], false, 1, false).broadcast(signed);
    return txid.toString();
  } catch (e) {
    console.warn("[apogee] broadcast via primary provider failed, trying alternate", e);
    const txid = await new lwk.EsploraClient(net, ESPLORA_ALT[network], false, 1, false).broadcast(
      signed,
    );
    return txid.toString();
  }
}

async function broadcastTransactionResilient(
  lwk: typeof Lwk,
  net: Lwk.Network,
  network: LiquidNetwork,
  transaction: Lwk.Transaction,
  esploraUrl?: string,
): Promise<string> {
  if (esploraUrl) {
    const txid = await new lwk.EsploraClient(net, esploraUrl, false, 1, false).broadcastTx(
      transaction,
    );
    return txid.toString();
  }
  try {
    const txid = await new lwk.EsploraClient(net, ESPLORA[network], false, 1, false).broadcastTx(
      transaction,
    );
    return txid.toString();
  } catch (e) {
    console.warn("[apogee] raw transaction broadcast failed, trying alternate", e);
    const txid = await new lwk.EsploraClient(
      net,
      ESPLORA_ALT[network],
      false,
      1,
      false,
    ).broadcastTx(transaction);
    return txid.toString();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A transient chain-server failure worth retrying — a 5xx/429 from waterfalls or
 * a network blip — as opposed to a hard error (malformed descriptor, parse
 * failure) that a retry can't fix.
 */
function isTransientChainError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    /\b(429|5\d\d)\b/.test(m) ||
    m.includes("internal server error") ||
    m.includes("bad gateway") ||
    m.includes("gateway time") ||
    m.includes("service unavailable") ||
    m.includes("temporarily") ||
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("failed to fetch") ||
    m.includes("load failed") ||
    m.includes("network") ||
    // wasm reqwest's message when the server is unreachable outright (down,
    // refused, DNS): a retry/fallback is exactly what these need.
    m.includes("error sending request") ||
    m.includes("connection") ||
    m.includes("dns")
  );
}

type ScanUpdate = Awaited<ReturnType<Lwk.EsploraClient["fullScan"]>>;

// Waterfalls reachability preflight. When the server is DOWN in the
// timing-out sense (host up but not answering TCP), a fetch inside lwk's
// fullScan hangs for the browser's full connect timeout — a minute or more —
// and every engine call queues behind it, freezing the wallet. So before
// handing the scan to wasm we probe the server ourselves with a short,
// abortable fetch, and on failure skip straight to plain Esplora. A failed
// probe starts a cooldown so the 20s balance poll doesn't re-pay the probe
// on every tick while the outage lasts.
let lastGoodEsplora: string | null = null; // sticky scan provider (see fullScanResilient)
const WATERFALLS_PREFLIGHT_MS = 4_000;
const WATERFALLS_COOLDOWN_MS = 5 * 60_000;
let waterfallsDownUntil = 0;

/** Quick liveness/throttle probe for a plain-Esplora provider. lwk's scan
 *  behavior against a hanging or 429-ing server is opaque (it can burn minutes
 *  before erroring), so we only hand it providers that answer a cheap request
 *  promptly. */
async function esploraReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/blocks/tip/height`, {
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Health probe thresholds for the Advanced status badge. Under PROBE_SLOW_MS is
// "up"; up to PROBE_TIMEOUT_MS is "slow"; beyond/errored is "down".
const PROBE_SLOW_MS = 1_500;
const PROBE_TIMEOUT_MS = 4_000;

/** One timed reachability probe of a chain-server root. Waterfalls exposes its
 *  own health path (/v1/server_recipient); Esplora roots answer /blocks/tip/height. */
async function probeRoot(url: string, healthPath: string): Promise<ProviderProbe> {
  const start = performance.now();
  try {
    const res = await fetch(`${url}${healthPath}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const ms = Math.round(performance.now() - start);
    if (!res.ok) return { label: "", status: "down", latencyMs: null };
    const status: ProbeStatus = ms > PROBE_SLOW_MS ? "slow" : "up";
    return { label: "", status, latencyMs: ms };
  } catch {
    return { label: "", status: "down", latencyMs: null };
  }
}

/** Overall status from a per-provider breakdown: the primary (first entry)
 *  drives the headline, but if it's down and a fallback answers, the wallet is
 *  still usable — call that "slow" (degraded) rather than alarming "down". */
function aggregateStatus(primary: ProviderProbe, fallbacks: ProviderProbe[]): ProbeStatus {
  if (primary.status !== "down") return primary.status;
  return fallbacks.some((p) => p.status !== "down") ? "slow" : "down";
}

async function waterfallsReachable(network: LiquidNetwork): Promise<boolean> {
  if (Date.now() < waterfallsDownUntil) return false;
  try {
    const res = await fetch(`${WATERFALLS[network]}/v1/server_recipient`, {
      signal: AbortSignal.timeout(WATERFALLS_PREFLIGHT_MS),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return true;
  } catch (e) {
    console.warn("[apogee] waterfalls unreachable — scanning via Esplora for now", e);
    waterfallsDownUntil = Date.now() + WATERFALLS_COOLDOWN_MS;
    return false;
  }
}

/**
 * Resilient full-scan. An explicit esploraUrl override scans that endpoint
 * directly. Otherwise we use waterfalls (one encrypted-descriptor request); on a
 * transient failure we retry with a FRESH client — which re-fetches the server's
 * age recipient via /v1/server_recipient, so a rotated server key self-heals —
 * then fall back to plain Esplora before giving up. The raw error is logged; on
 * total failure the caller gets a short, clean message (never raw server HTML).
 */
async function fullScanResilient(
  lwk: typeof Lwk,
  wollet: Lwk.Wollet,
  net: Lwk.Network,
  network: LiquidNetwork,
  esploraUrl?: string,
): Promise<ScanUpdate> {
  if (esploraUrl) {
    return new lwk.EsploraClient(net, esploraUrl, false, 4, false).fullScan(wollet);
  }


  const WATERFALLS_ATTEMPTS = 2;
  let lastErr: unknown;
  if (await waterfallsReachable(network)) {
    for (let attempt = 0; attempt < WATERFALLS_ATTEMPTS; attempt++) {
      try {
        // A fresh client re-fetches /v1/server_recipient, so a rotated server age
        // key self-heals on the retry.
        const client = new lwk.EsploraClient(net, WATERFALLS[network], true, 1, false);
        return await client.fullScan(wollet);
      } catch (e) {
        lastErr = e;
        console.warn(`[apogee] waterfalls scan failed (attempt ${attempt + 1}/${WATERFALLS_ATTEMPTS})`, e);
        if (!isTransientChainError(e)) throw e; // hard error — surface lwk's message
        if (attempt < WATERFALLS_ATTEMPTS - 1) await sleep(400 * (attempt + 1));
      }
    }
    // Persistently failing despite answering the probe (e.g. an upstream 500) —
    // start the cooldown too, so the poll doesn't keep re-trying a sick server.
    waterfallsDownUntil = Date.now() + WATERFALLS_COOLDOWN_MS;
  }

  // Waterfalls is out — scan via plain Esplora instead (concurrency 4: a
  // from-scratch scan is dozens of round-trips, which is what made the old
  // concurrency-1 fallback crawl).
  console.warn("[apogee] waterfalls unavailable, falling back to Esplora", lastErr);
  // Providers in default order: liquid.network first (it tolerates the burst a
  // scan produces), blockstream.info second (its limiter 429s bursts — but a
  // throttled provider fails its probe in ~ms and we move on). Sticky: prefer
  // whichever provider last completed a scan, so a throttled one isn't re-hit
  // on every sync.
  const providers = [ESPLORA[network], ESPLORA_ALT[network]];
  if (lastGoodEsplora && providers.includes(lastGoodEsplora)) {
    providers.sort((a, b) => (a === lastGoodEsplora ? -1 : 0) - (b === lastGoodEsplora ? -1 : 0));
  }
  for (const url of providers) {
    // Probe first: skip a throttled (429) or unresponsive provider in ~ms
    // instead of letting the wasm scan grind against it.
    if (!(await esploraReachable(url))) {
      console.warn(`[apogee] Esplora provider unresponsive/throttled, skipping: ${url}`);
      continue;
    }
    try {
      const update = await new lwk.EsploraClient(net, url, false, 4, false).fullScan(wollet);
      lastGoodEsplora = url;
      return update;
    } catch (e) {
      lastErr = e;
      console.warn(`[apogee] Esplora scan via ${url} failed`, e);
    }
  }
  console.error("[apogee] all scan providers failed", lastErr);
  throw new Error("Couldn't reach the chain server. Check your connection and try again.");
}

/**
 * Fallback BTC price for currencies lwk's PricesFetcher refuses — its
 * hardcoded supported list omits e.g. JPY, which every source below quotes.
 * Same philosophy as lwk: hit several public tickers in parallel and take the
 * median of whoever answers (≥2 required). Every host is in host_permissions —
 * all but mempool.space are a subset of the sources lwk itself uses.
 * (Coinbase is deliberately absent: it delisted JPY, and its BTC-JPY spot
 * endpoint still answers — with a stale quote ~3.4× off consensus.)
 */
async function fallbackRate(currency: string): Promise<number> {
  const c = currency.toUpperCase();
  // Validate before building URLs. The value is trusted today (it comes from the
  // fixed FIAT_OPTIONS list), but a strict 3-letter guard keeps the query-string
  // interpolation safe if a caller ever passes something arbitrary.
  if (!/^[A-Z]{3}$/.test(c)) throw new Error(`Unsupported currency: ${currency}`);
  // Require a 2xx before parsing, so an HTTP 429/5xx or an HTML error page is
  // treated as "source unavailable" (rejects, caught by allSettled below)
  // rather than parsed as a rate.
  const json = async (url: string): Promise<unknown> => {
    // Timeboxed: one hanging ticker must not stall the median.
    const r = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
    return r.json();
  };
  const sources: Array<() => Promise<number>> = [
    async () =>
      Number(
        (
          (await json(
            `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=${c.toLowerCase()}`,
          )) as Record<string, Record<string, number>>
        ).bitcoin[c.toLowerCase()],
      ),
    async () =>
      Number(
        (
          (await json(`https://api.coinpaprika.com/v1/tickers/btc-bitcoin?quotes=${c}`)) as {
            quotes: Record<string, { price: number }>;
          }
        ).quotes[c].price,
      ),
    async () =>
      Number(((await json("https://blockchain.info/ticker")) as Record<string, { last: number }>)[c].last),
    // mempool.space quotes every FIAT_OPTIONS currency (USD EUR GBP CAD CHF AUD
    // JPY) in one keyless call with no practical rate limit. It's here for margin:
    // the median needs 2 of N, and CoinGecko's free tier intermittently 429s, so
    // with only 3 sources a single bad day drops us to 1 and the rate fails. Any
    // currency it doesn't quote yields NaN, which the isFinite filter below drops.
    async () =>
      Number(((await json("https://mempool.space/api/v1/prices")) as Record<string, number>)[c]),
  ];
  const settled = await Promise.allSettled(sources.map((s) => s()));
  const rates = settled
    .filter((s): s is PromiseFulfilledResult<number> => s.status === "fulfilled")
    .map((s) => s.value)
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (rates.length < 2) throw new Error(`No price source available for ${c}`);
  const mid = Math.floor(rates.length / 2);
  return rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;
}

// ---- BTC price history (the price chart) ------------------------------------
//
// mempool.space returns the WHOLE hourly series in one response — ~24k points back
// to 2010, newest-first, plus USD→fiat rates for exactly the currencies the panel
// offers. It takes no windowing parameters (`from`, `limit`, `interval` are all
// ignored — verified), so it's all-or-nothing at ~147 KB gzipped.
//
// That shape is a good trade here rather than a cost: one fetch serves EVERY range
// and EVERY currency, so opening the chart, switching ranges, and changing currency
// cost zero further requests until the cache expires. The alternative — a per-range
// endpoint elsewhere — would mean more requests to more hosts, which is worse for a
// wallet that declares no data collection.
//
// mempool.space is already in host_permissions (it's a fallbackRate source), so this
// introduces no new third party.
const PRICE_HISTORY_TTL_MS = 10 * 60_000;
const PRICE_HISTORY_URL = "https://mempool.space/api/v1/historical-price?currency=USD";

/** Cached raw upstream response: USD points (oldest-first) + USD→fiat rates. */
let priceHistoryCache: {
  ts: number;
  usd: Array<{ time: number; usd: number }>;
  rates: Record<string, number>;
} | null = null;

/** Seconds of history per range; `all` keeps everything. */
const RANGE_SECONDS: Record<PriceRange, number | null> = {
  "24h": 24 * 3600,
  "7d": 7 * 24 * 3600,
  "30d": 30 * 24 * 3600,
  "1y": 365 * 24 * 3600,
  all: null,
};

async function fetchPriceHistoryRaw(): Promise<NonNullable<typeof priceHistoryCache>> {
  if (priceHistoryCache && Date.now() - priceHistoryCache.ts < PRICE_HISTORY_TTL_MS) {
    return priceHistoryCache;
  }
  // Timeboxed like fallbackRate: the payload is large, so allow more than the 6s
  // used for spot quotes, but never hang the panel waiting on it.
  const r = await fetch(PRICE_HISTORY_URL, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`price history unavailable (${r.status})`);
  const j = (await r.json()) as {
    prices?: Array<Record<string, number>>;
    exchangeRates?: Record<string, number>;
  };
  if (!Array.isArray(j.prices)) throw new Error("price history malformed");
  // Upstream is newest-first; the chart wants oldest-first. Drop anything
  // non-finite or non-positive rather than letting it distort the min/max scale.
  const usd = j.prices
    .map((p) => ({ time: Number(p.time), usd: Number(p.USD) }))
    // `time > 0` alongside the finite check: a hostile non-positive or absurd
    // timestamp can't crash anything, but it would distort the time axis.
    .filter((p) => Number.isFinite(p.time) && p.time > 0 && Number.isFinite(p.usd) && p.usd > 0)
    .sort((a, b) => a.time - b.time);
  if (usd.length < 2) throw new Error("price history too short");
  priceHistoryCache = { ts: Date.now(), usd, rates: j.exchangeRates ?? {} };
  return priceHistoryCache;
}

// The always-visible rate bar needs a 24h delta, but the full history is ~147 KB
// gzipped — too much to pull on every wallet open for a one-line readout. This
// queries the same endpoint with a `timestamp`, which returns exactly ONE point
// (~148 bytes) plus the fiat rates. So the bar costs ~1 KB and the full series is
// only fetched when the user actually expands the chart.
const PRICE_24H_TTL_MS = 10 * 60_000;
let price24hCache: { ts: number; usd: number; rates: Record<string, number> } | null = null;

/** BTC price 24h ago in `currency` — one point, for the bar's delta. */
async function getPrice24hAgo(currency: string): Promise<number> {
  const c = currency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new Error(`Unsupported currency: ${currency}`);
  if (!price24hCache || Date.now() - price24hCache.ts >= PRICE_24H_TTL_MS) {
    const at = Math.floor(Date.now() / 1000) - 24 * 3600;
    const r = await fetch(`${PRICE_HISTORY_URL}&timestamp=${at}`, {
      signal: AbortSignal.timeout(6_000),
    });
    if (!r.ok) throw new Error(`price history unavailable (${r.status})`);
    const j = (await r.json()) as {
      prices?: Array<Record<string, number>>;
      exchangeRates?: Record<string, number>;
    };
    const usd = Number(j.prices?.[0]?.USD);
    if (!Number.isFinite(usd) || usd <= 0) throw new Error("no 24h price point");
    price24hCache = { ts: Date.now(), usd, rates: j.exchangeRates ?? {} };
  }
  if (c === "USD") return price24hCache.usd;
  const rate = price24hCache.rates[`USD${c}`];
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`No ${c} rate for price history`);
  return price24hCache.usd * rate;
}

/** Hourly BTC price history for one range, converted to `currency`. */
async function getPriceHistory(currency: string, range: PriceRange): Promise<PriceHistory> {
  const c = currency.toUpperCase();
  // Same guard as fallbackRate: the value is trusted today (fixed FIAT_OPTIONS) but
  // a strict 3-letter check keeps the rate lookup from being fed anything arbitrary.
  if (!/^[A-Z]{3}$/.test(c)) throw new Error(`Unsupported currency: ${currency}`);
  const raw = await fetchPriceHistoryRaw();

  const secs = RANGE_SECONDS[range];
  const latest = raw.usd[raw.usd.length - 1].time;
  const window = secs == null ? raw.usd : raw.usd.filter((p) => p.time >= latest - secs);
  // A range with too little data can't be drawn; fall back to the full series rather
  // than failing, so a young range never renders as an error.
  const series = window.length >= 2 ? window : raw.usd;

  // Convert with the SAME response's USD→fiat rate, so no second request is needed
  // and the whole series moves on one consistent rate (a per-point historical FX
  // series isn't offered — this is a present-day conversion of a USD history, which
  // is the honest reading of it).
  let k = 1;
  if (c !== "USD") {
    const rate = raw.rates[`USD${c}`];
    if (!Number.isFinite(rate) || rate <= 0) throw new Error(`No ${c} rate for price history`);
    k = rate;
  }
  return {
    currency: c,
    range,
    points: series.map((p) => p.usd * k),
    times: series.map((p) => p.time),
    fromTime: series[0].time,
    toTime: series[series.length - 1].time,
  };
}

export async function handle(req: EngineRequest): Promise<unknown> {
  // These static, secret-free operations do not require the wallet WASM. Keeping
  // them ahead of loadLwk also makes support discovery available before connect.
  if (req.kind === "getTxManifestSupport") {
    return getTxManifestSupport(req.bundleHash);
  }
  if (req.kind === "resolveTxManifestRequirements") {
    return resolveTxManifestRequirementsWithAdapter(req.invocation);
  }
  if (req.kind === "compileTxManifestCovenant") {
    return compileTxManifestCovenant(req.spec);
  }
  if (req.kind === "inspectTxManifestTransactionOutput") {
    return inspectTxManifestTransactionOutput(req.transactionHex, req.vout);
  }
  if (req.kind === "inspectTxManifestAddress") {
    return inspectTxManifestAddress(req.address, req.network);
  }
  if (req.kind === "dryRunTxManifestCovenant") {
    return dryRunTxManifestCovenant(req.spec);
  }
  if (req.kind === "buildTxManifestPset") {
    return buildTxManifestPset(req.spec);
  }
  if (req.kind === "finalizeTxManifestCovenant") {
    return finalizeTxManifestCovenant(req.spec);
  }
  if (req.kind === "prepareLendingV3AcceptOffer") {
    return prepareLendingV3AcceptOffer(req.plan, req.snapshot);
  }
  if (req.kind === "dryRunLendingV3AcceptOffer") {
    return dryRunLendingV3AcceptOfferExecution({
      transactionHex: req.transactionHex,
      parentTransactions: req.parentTransactions,
      genesisHash: req.genesisHash,
      covenants: req.covenants,
    });
  }
  if (req.kind === "prepareLendingV3ClaimLenderVault") {
    return prepareLendingV3ClaimLenderVault(req.plan, req.snapshot);
  }
  if (req.kind === "dryRunLendingV3ClaimLenderVault") {
    return dryRunLendingV3ClaimLenderVaultExecution({
      transactionHex: req.transactionHex,
      parentTransactions: req.parentTransactions,
      genesisHash: req.genesisHash,
      vault: req.vault,
    });
  }
  const lwk = await loadLwk();
  switch (req.kind) {
    case "generateMnemonic":
      return lwk.Mnemonic.fromRandom(req.words ?? 12).toString();

    case "deriveWallet": {
      // `new Mnemonic` throws on an invalid BIP-39 phrase — restore validation.
      const signer = new lwk.Signer(new lwk.Mnemonic(req.mnemonic), lwkNetwork(lwk, req.network));
      // Standard BIP84 (lwk's wpkhSlip77Descriptor) — interoperable with
      // Blockstream Green/Jade, Aqua, and other standard Liquid wallets.
      const result: DerivedWallet = {
        descriptor: signer.wpkhSlip77Descriptor().toString(),
        fingerprint: signer.fingerprint(),
      };
      return result;
    }

    case "sync": {
      const entry = await ensureWollet(lwk, req.descriptor, req.network);
      const net = lwkNetwork(lwk, req.network);
      // Waterfalls (one encrypted-descriptor request) with retry + age-recipient
      // re-fetch and a plain-Esplora fallback; an explicit esploraUrl override
      // scans that endpoint directly. See fullScanResilient.
      const update = await fullScanResilient(lwk, entry.wollet, net, req.network, req.esploraUrl);
      if (update) {
        // Serialize before applyUpdate — never touch the wasm Update after
        // handing it to the wollet.
        let serialized: string | null = null;
        let tipOnly = false;
        try {
          serialized = update.serializeEncryptedBase64(entry.wd);
          tipOnly = update.onlyTip();
        } catch (e) {
          console.warn("[apogee] update serialize failed (state not persisted)", e);
        }
        entry.wollet.applyUpdate(update);
        if (serialized !== null) await persistScanUpdate(entry, serialized, tipOnly);
      }
      const walletBalance = entry.wollet.balance();
      const balance = balanceToRecord(walletBalance);
      const result: SyncResult = {
        lbtcSats: balance[entry.policyAssetHex] ?? 0,
        balance,
        balanceStrings: balanceToStringRecord(walletBalance),
        policyAssetHex: entry.policyAssetHex,
      };
      return result;
    }

    case "getAddress": {
      const entry = await ensureWollet(lwk, req.descriptor, req.network);
      const r = entry.wollet.address(req.index ?? null);
      const dto: AddressDTO = { index: r.index(), address: r.address().toString() };
      return dto;
    }

    case "getBalance": {
      const entry = await ensureWollet(lwk, req.descriptor, req.network);
      return balanceToRecord(entry.wollet.balance());
    }

    case "getTransactions": {
      const entry = await ensureWollet(lwk, req.descriptor, req.network);
      // Per tx, the wallet txids it spends from — used to order same-block txs
      // (see orderTransactionsNewestFirst). Inputs owned by others come back None.
      const spendsFrom = new Map<string, Set<string>>();
      const txs: WalletTxDTO[] = await Promise.all(entry.wollet.transactions().map(async (tx) => {
        const txid = tx.txid().toString();
        const spends = new Set<string>();
        let hasWalletOwnedInput = false;
        for (const input of tx.inputs()) {
          const spent = input.get();
          if (spent) {
            hasWalletOwnedInput = true;
            spends.add(spent.outpoint().txid().toString());
          }
        }
        spendsFrom.set(txid, spends);
        const assetDeltas = balanceToRecord(tx.balance());
        const annotation = await txManifestHistoryAnnotation(
          tx.tx().toBytes(),
          hasWalletOwnedInput,
        );
        return {
          txid,
          balanceChange: assetDeltas[entry.policyAssetHex] ?? 0,
          fee: Number(tx.fee()),
          height: tx.height() ?? null,
          timestamp: tx.timestamp() ?? null,
          assetDeltas,
          ...(annotation ? { txManifest: annotation } : {}),
        };
      }));
      return orderTransactionsNewestFirst(txs, spendsFrom);
    }

    case "prepareLendingV3AcceptOfferWithWallet": {
      if (!isTxManifestExecutionNetwork(req.network)) {
        throw new Error("The TX Manifest wallet adapter is not enabled on this network.");
      }
      const manifestNetwork = txManifestRuntimeNetwork(req.network);
      const entry = await ensureWollet(lwk, req.descriptor, req.network);
      if (entry.policyAssetHex !== req.chainSnapshot.policyAssetId) {
        throw new Error("The wallet policy asset does not match the verified chain snapshot.");
      }
      const transactions = new Map(
        entry.wollet.transactions().map((walletTx) => {
          const transaction = walletTx.tx();
          return [walletTx.txid().toString(), transaction.toBytes()] as const;
        }),
      );
      const candidates = entry.wollet.utxos().map((utxo): AcceptOfferWalletCandidate => {
        const outpoint = utxo.outpoint();
        const txid = outpoint.txid().toString();
        const transaction = transactions.get(txid);
        if (!transaction) throw new Error(`wallet transaction unavailable for UTXO ${txid}`);
        const secrets = utxo.unblinded();
        return {
          txid,
          vout: outpoint.vout(),
          txOut: bytesToHex(extractElementsTxOut(transaction, outpoint.vout())),
          scriptPubKey: bytesToHex(utxo.scriptPubkey().bytes()),
          assetId: secrets.asset().toString(),
          amount: secrets.value().toString(),
          assetBlindingFactor: secrets.assetBlindingFactor().toString(),
          valueBlindingFactor: secrets.valueBlindingFactor().toString(),
          address: utxo.address().toString(),
          parentTransaction: bytesToHex(transaction),
        };
      });
      const address = entry.wollet.address(null).address().toString();
      const destination = await inspectTxManifestAddress(address, manifestNetwork);
      return convergeTxManifestFee(
        req.chainSnapshot.feePolicy,
        async (fee): Promise<HostedPreparedAcceptOfferExecution> => {
          const selected = selectAcceptOfferWalletInputs(
            candidates,
            req.plan.intent.principalAssetId,
            req.plan.intent.principalAmount,
            req.chainSnapshot.policyAssetId,
            fee,
          );
          const combinedPrincipalAndFee = selected.feeInputs.length === 0;
          const feeDecision = txManifestLbtcChangeDecision(
            combinedPrincipalAndFee ? selected.principalInputs : selected.feeInputs,
            combinedPrincipalAndFee ? req.plan.intent.principalAmount : "0",
            fee,
          );
          const prepared = await prepareLendingV3AcceptOffer(req.plan, {
            network: manifestNetwork,
            genesisHash: req.chainSnapshot.genesisHash,
            tipHeight: req.chainSnapshot.tipHeight,
            policyAssetId: req.chainSnapshot.policyAssetId,
            pendingOffer: req.chainSnapshot.pendingOffer,
            lenderNftAuthorization: req.chainSnapshot.lenderNftAuthorization,
            principalInputs: selected.principalInputs,
            feeInputs: selected.feeInputs,
            lenderNftDestination: { scriptPubKey: destination.script_pub_key },
            principalChangeDestination: {
              scriptPubKey: destination.script_pub_key,
              blindingPublicKey: destination.blinding_public_key,
            },
            feeChangeDestination: {
              scriptPubKey: destination.script_pub_key,
              blindingPublicKey: destination.blinding_public_key,
            },
            fee: feeDecision.actualFee,
          });
          return {
            ...prepared,
            feeSelectionTarget: feeDecision.selectionFee,
            parentTransactions: [
              ...new Set([
                ...req.chainSnapshot.parentTransactions,
                ...selected.principalInputs.map((input) => input.parentTransaction),
                ...selected.feeInputs.map((input) => input.parentTransaction),
              ]),
            ],
          };
        },
        estimateTxManifestFee,
      );
    }

    case "prepareLendingV3ClaimLenderVaultWithWallet": {
      if (!isTxManifestExecutionNetwork(req.network)) {
        throw new Error("The TX Manifest wallet adapter is not enabled on this network.");
      }
      const manifestNetwork = txManifestRuntimeNetwork(req.network);
      const entry = await ensureWollet(lwk, req.descriptor, req.network);
      if (entry.policyAssetHex !== req.chainSnapshot.policyAssetId) {
        throw new Error("The wallet policy asset does not match the verified chain snapshot.");
      }
      const walletTransactions = entry.wollet.transactions();
      const transactions = new Map(
        walletTransactions.map((walletTx) => {
          const transaction = walletTx.tx();
          return [walletTx.txid().toString(), transaction.toBytes()] as const;
        }),
      );
      let candidates = entry.wollet.utxos().map((utxo): AcceptOfferWalletCandidate => {
        const outpoint = utxo.outpoint();
        const txid = outpoint.txid().toString();
        const transaction = transactions.get(txid);
        if (!transaction) throw new Error(`wallet transaction unavailable for UTXO ${txid}`);
        const secrets = utxo.unblinded();
        return {
          txid,
          vout: outpoint.vout(),
          txOut: bytesToHex(extractElementsTxOut(transaction, outpoint.vout())),
          scriptPubKey: bytesToHex(utxo.scriptPubkey().bytes()),
          assetId: secrets.asset().toString(),
          amount: secrets.value().toString(),
          assetBlindingFactor: secrets.assetBlindingFactor().toString(),
          valueBlindingFactor: secrets.valueBlindingFactor().toString(),
          address: utxo.address().toString(),
          parentTransaction: bytesToHex(transaction),
        };
      });
      const requestedNftOutpoint = req.plan.walletInputs[0].outpoint;
      const lenderNftParent = transactions.get(requestedNftOutpoint.txid);
      const walletDestinations = walletTransactions
        .find((walletTx) => walletTx.txid().toString() === requestedNftOutpoint.txid)
        ?.outputs()
        .flatMap((output) => {
          const walletOutput = output.get();
          if (!walletOutput) return [];
          const address = walletOutput.address();
          return [
            {
              address: address.toString(),
              scriptPubKey: bytesToHex(walletOutput.scriptPubkey().bytes()),
            },
          ];
        }) ?? [];
      candidates = [
        ...recoverExplicitWalletInputCandidate(
          candidates,
          requestedNftOutpoint,
          req.chainSnapshot.lenderNft,
          walletDestinations,
          lenderNftParent && bytesToHex(lenderNftParent),
        ),
      ];
      const address = entry.wollet.address(null).address().toString();
      const destination = await inspectTxManifestAddress(address, manifestNetwork);
      return convergeTxManifestFee(
        req.chainSnapshot.feePolicy,
        async (fee): Promise<HostedPreparedClaimLenderVaultExecution> => {
          const selected = selectClaimLenderVaultWalletInputs(
            candidates,
            requestedNftOutpoint,
            req.plan.intent.lenderNftAssetId,
            req.chainSnapshot.policyAssetId,
            fee,
          );
          const feeDecision = txManifestLbtcChangeDecision(selected.feeInputs, "0", fee);
          const resolvedNft = req.chainSnapshot.lenderNft;
          if (
            selected.lenderNftInput.txOut !== resolvedNft.txOut ||
            selected.lenderNftInput.scriptPubKey !== resolvedNft.scriptPubKey ||
            selected.lenderNftInput.assetId !== resolvedNft.assetId ||
            selected.lenderNftInput.amount !== resolvedNft.amount
          ) {
            throw new Error("Wallet and chain state disagree about the lender NFT input.");
          }
          const prepared = await prepareLendingV3ClaimLenderVault(req.plan, {
            network: manifestNetwork,
            genesisHash: req.chainSnapshot.genesisHash,
            tipHeight: req.chainSnapshot.tipHeight,
            policyAssetId: req.chainSnapshot.policyAssetId,
            lenderVault: req.chainSnapshot.lenderVault,
            lenderNftInput: selected.lenderNftInput,
            feeInputs: selected.feeInputs,
            principalDestination: {
              scriptPubKey: destination.script_pub_key,
              blindingPublicKey: destination.blinding_public_key,
            },
            feeChangeDestination: {
              scriptPubKey: destination.script_pub_key,
              blindingPublicKey: destination.blinding_public_key,
            },
            fee: feeDecision.actualFee,
          });
          return {
            ...prepared,
            feeSelectionTarget: feeDecision.selectionFee,
            parentTransactions: [
              ...new Set([
                ...req.chainSnapshot.parentTransactions,
                selected.lenderNftInput.parentTransaction,
                ...selected.feeInputs.map((input) => input.parentTransaction),
              ]),
            ],
          };
        },
        estimateTxManifestFee,
      );
    }

    case "prepareLendingV3NewActionWithWallet": {
      if (!isTxManifestExecutionNetwork(req.network)) {
        throw new Error("The TX Manifest wallet adapter is not enabled on this network.");
      }
      const manifestNetwork = txManifestRuntimeNetwork(req.network);
      const entry = await ensureWollet(lwk, req.descriptor, req.network);
      if (entry.policyAssetHex !== req.chainSnapshot.policyAssetId) {
        throw new Error("The wallet policy asset does not match the verified chain snapshot.");
      }
      const walletTransactions = entry.wollet.transactions();
      const transactions = new Map(
        walletTransactions.map((walletTx) => {
          const transaction = walletTx.tx();
          return [walletTx.txid().toString(), transaction.toBytes()] as const;
        }),
      );
      let candidates = entry.wollet.utxos().map((utxo): AcceptOfferWalletCandidate => {
        const walletOutpoint = utxo.outpoint();
        const txid = walletOutpoint.txid().toString();
        const transaction = transactions.get(txid);
        if (!transaction) throw new Error(`wallet transaction unavailable for UTXO ${txid}`);
        const secrets = utxo.unblinded();
        return {
          txid,
          vout: walletOutpoint.vout(),
          txOut: bytesToHex(extractElementsTxOut(transaction, walletOutpoint.vout())),
          scriptPubKey: bytesToHex(utxo.scriptPubkey().bytes()),
          assetId: secrets.asset().toString(),
          amount: secrets.value().toString(),
          assetBlindingFactor: secrets.assetBlindingFactor().toString(),
          valueBlindingFactor: secrets.valueBlindingFactor().toString(),
          address: utxo.address().toString(),
          parentTransaction: bytesToHex(transaction),
        };
      });
      const address = entry.wollet.address(null).address().toString();
      const inspectedDestination = await inspectTxManifestAddress(address, manifestNetwork);
      const currentWalletDestination = {
        address,
        scriptPubKey: inspectedDestination.script_pub_key,
      };
      const recoverNamedWalletInput = (name: string) => {
        const resolved = req.chainSnapshot.inputs[name];
        if (!resolved) throw new Error(`Verified chain snapshot is missing ${name}.`);
        const parent = transactions.get(resolved.txid);
        const transactionDestinations = walletTransactions
          .find((walletTx) => walletTx.txid().toString() === resolved.txid)
          ?.outputs()
          .flatMap((walletOutput) => {
            const owned = walletOutput.get();
            if (!owned) return [];
            return [{
              address: owned.address().toString(),
              scriptPubKey: bytesToHex(owned.scriptPubkey().bytes()),
            }];
          }) ?? [];
        candidates = [...recoverExplicitWalletInputCandidate(
          candidates,
          { txid: resolved.txid, vout: resolved.vout },
          resolved,
          [...transactionDestinations, currentWalletDestination],
          parent && bytesToHex(parent),
        )];
      };
      const confidentialDestination = {
        scriptPubKey: inspectedDestination.script_pub_key,
        blindingPublicKey: inspectedDestination.blinding_public_key,
      };
      const explicitDestination = { scriptPubKey: inspectedDestination.script_pub_key };
      const parents = (...walletInputs: AcceptOfferWalletCandidate[]) => [
        ...new Set([
          ...req.chainSnapshot.parentTransactions,
          ...walletInputs.map((input) => input.parentTransaction),
        ]),
      ];

      return convergeTxManifestFee(
        req.chainSnapshot.feePolicy,
        async (fee): Promise<HostedPreparedNewLendingExecution> => {
      if (req.plan.action === SIMPLICITY_LENDING_V3_CREATE_FACTORY) {
        const fundingInputs = selectManifestWalletInputs(
          candidates,
          req.chainSnapshot.policyAssetId,
          fee,
          [],
          "confirmed L-BTC input",
          TX_MANIFEST_MINIMUM_POST_FEE_LBTC_CHANGE,
        );
        const feeDecision = txManifestLbtcChangeDecision(fundingInputs, "0", fee);
        const prepared = await prepareLendingV3CreateFactory(req.plan, {
          network: manifestNetwork,
          genesisHash: req.chainSnapshot.genesisHash,
          tipHeight: req.chainSnapshot.tipHeight,
          policyAssetId: req.chainSnapshot.policyAssetId,
          assetContractDomain: req.assetContractDomain,
          fundingInputs,
          explicitWalletDestination: explicitDestination,
          feeChangeDestination: confidentialDestination,
          fee: feeDecision.actualFee,
        });
        const result: HostedPreparedNewLendingExecution = {
          ...prepared,
          feeSelectionTarget: feeDecision.selectionFee,
          parentTransactions: parents(...fundingInputs),
        };
        return result;
      }

      if (req.plan.action === SIMPLICITY_LENDING_V3_CREATE_OFFER) {
        recoverNamedWalletInput("factory_auth_in");
        const factoryAuthInput = selectManifestWalletInputByOutpoint(
          candidates,
          req.plan.walletInputs[0].outpoint,
          req.plan.factoryAssetId,
          "1",
          "factory auth NFT",
        );
        const combinesCollateralAndFee =
          req.plan.intent.collateralAssetId === req.chainSnapshot.policyAssetId;
        const collateralInputs = selectManifestWalletInputs(
          candidates,
          req.plan.intent.collateralAssetId,
          combinesCollateralAndFee
            ? (BigInt(req.plan.intent.collateralAmount) + BigInt(fee)).toString()
            : req.plan.intent.collateralAmount,
          [factoryAuthInput],
          "collateral input",
          combinesCollateralAndFee
            ? TX_MANIFEST_MINIMUM_POST_FEE_LBTC_CHANGE
            : "0",
        );
        const feeInputs = combinesCollateralAndFee
          ? []
          : selectManifestWalletInputs(
              candidates,
              req.chainSnapshot.policyAssetId,
              fee,
              [factoryAuthInput, ...collateralInputs],
              "distinct L-BTC fee inputs",
              TX_MANIFEST_MINIMUM_POST_FEE_LBTC_CHANGE,
            );
        const feeDecision = txManifestLbtcChangeDecision(
          combinesCollateralAndFee ? collateralInputs : feeInputs,
          combinesCollateralAndFee ? req.plan.intent.collateralAmount : "0",
          fee,
        );
        const factoryCovenant = req.chainSnapshot.inputs.factory_covenant_in;
        if (!factoryCovenant) throw new Error("Verified chain snapshot is missing factory_covenant_in.");
        const prepared = await prepareLendingV3CreateOffer(req.plan, {
          network: manifestNetwork,
          genesisHash: req.chainSnapshot.genesisHash,
          tipHeight: req.chainSnapshot.tipHeight,
          policyAssetId: req.chainSnapshot.policyAssetId,
          assetContractDomain: req.assetContractDomain,
          factoryAuthInput,
          factoryCovenant,
          collateralInputs,
          feeInputs,
          explicitWalletDestination: explicitDestination,
          changeDestination: confidentialDestination,
          fee: feeDecision.actualFee,
        });
        const result: HostedPreparedNewLendingExecution = {
          ...prepared,
          feeSelectionTarget: feeDecision.selectionFee,
          parentTransactions: parents(factoryAuthInput, ...collateralInputs, ...feeInputs),
        };
        return result;
      }

      if (req.plan.action === SIMPLICITY_LENDING_V3_CLAIM_PRINCIPAL) {
        recoverNamedWalletInput("borrower_nft_in");
        const borrowerNftInput = selectManifestWalletInputByOutpoint(candidates, req.plan.walletInputs[0].outpoint, req.plan.intent.borrowerNftAssetId, "1", "borrower NFT");
        const feeInputs = selectManifestWalletInputs(
          candidates,
          req.chainSnapshot.policyAssetId,
          fee,
          [borrowerNftInput],
          "distinct L-BTC fee inputs",
          TX_MANIFEST_MINIMUM_POST_FEE_LBTC_CHANGE,
        );
        const feeDecision = txManifestLbtcChangeDecision(feeInputs, "0", fee);
        const principalAssetAuth = req.chainSnapshot.inputs.principal_asset_auth_in;
        if (!principalAssetAuth) throw new Error("Verified chain snapshot is missing principal_asset_auth_in.");
        const prepared = await prepareLendingV3BorrowerAction(req.plan, {
          network: manifestNetwork,
          kind: "claimPrincipal",
          genesisHash: req.chainSnapshot.genesisHash,
          tipHeight: req.chainSnapshot.tipHeight,
          policyAssetId: req.chainSnapshot.policyAssetId,
          principalAssetAuth,
          borrowerNftInput,
          feeInputs,
          walletDestination: confidentialDestination,
          explicitWalletDestination: explicitDestination,
          feeChangeDestination: confidentialDestination,
          fee: feeDecision.actualFee,
        });
        return {
          ...prepared,
          feeSelectionTarget: feeDecision.selectionFee,
          parentTransactions: parents(borrowerNftInput, ...feeInputs),
        } satisfies HostedPreparedNewLendingExecution;
      }

      if (req.plan.action === SIMPLICITY_LENDING_V3_CANCEL_OFFER) {
        recoverNamedWalletInput("borrower_nft_in");
        const borrowerNftInput = selectManifestWalletInputByOutpoint(candidates, req.plan.walletInputs[0].outpoint, req.plan.intent.borrowerNftAssetId, "1", "borrower NFT");
        const feeInputs = selectManifestWalletInputs(
          candidates,
          req.chainSnapshot.policyAssetId,
          fee,
          [borrowerNftInput],
          "distinct L-BTC fee inputs",
          TX_MANIFEST_MINIMUM_POST_FEE_LBTC_CHANGE,
        );
        const feeDecision = txManifestLbtcChangeDecision(feeInputs, "0", fee);
        const pendingOffer = req.chainSnapshot.inputs.pending_offer_in;
        const lenderNftAuthorization = req.chainSnapshot.inputs.lender_nft_in;
        if (!pendingOffer || !lenderNftAuthorization) throw new Error("Verified chain snapshot is missing cancellation inputs.");
        const prepared = await prepareLendingV3BorrowerAction(req.plan, {
          network: manifestNetwork,
          kind: "cancelOffer",
          genesisHash: req.chainSnapshot.genesisHash,
          tipHeight: req.chainSnapshot.tipHeight,
          policyAssetId: req.chainSnapshot.policyAssetId,
          pendingOffer,
          lenderNftAuthorization,
          borrowerNftInput,
          feeInputs,
          walletDestination: confidentialDestination,
          explicitWalletDestination: explicitDestination,
          feeChangeDestination: confidentialDestination,
          fee: feeDecision.actualFee,
        });
        return {
          ...prepared,
          feeSelectionTarget: feeDecision.selectionFee,
          parentTransactions: parents(borrowerNftInput, ...feeInputs),
        } satisfies HostedPreparedNewLendingExecution;
      }

      if (req.plan.action === SIMPLICITY_LENDING_V3_REPAY_LOAN) {
        recoverNamedWalletInput("borrower_nft_in");
        const borrowerNftInput = selectManifestWalletInputByOutpoint(candidates, req.plan.walletInputs[0].outpoint, req.plan.intent.borrowerNftAssetId, "1", "borrower NFT");
        const combinesRepaymentAndFee =
          req.plan.intent.principalAssetId === req.chainSnapshot.policyAssetId;
        const repaymentInputs = selectManifestWalletInputs(
          candidates,
          req.plan.intent.principalAssetId,
          combinesRepaymentAndFee
            ? (BigInt(req.plan.intent.totalDebt) + BigInt(fee)).toString()
            : req.plan.intent.totalDebt,
          [borrowerNftInput],
          "repayment input",
          combinesRepaymentAndFee
            ? TX_MANIFEST_MINIMUM_POST_FEE_LBTC_CHANGE
            : "0",
        );
        const feeInputs = combinesRepaymentAndFee
          ? []
          : selectManifestWalletInputs(
              candidates,
              req.chainSnapshot.policyAssetId,
              fee,
              [borrowerNftInput, ...repaymentInputs],
              "distinct L-BTC fee inputs",
              TX_MANIFEST_MINIMUM_POST_FEE_LBTC_CHANGE,
            );
        const feeDecision = txManifestLbtcChangeDecision(
          combinesRepaymentAndFee ? repaymentInputs : feeInputs,
          combinesRepaymentAndFee ? req.plan.intent.totalDebt : "0",
          fee,
        );
        const activeOffer = req.chainSnapshot.inputs.active_offer_in;
        if (!activeOffer) throw new Error("Verified chain snapshot is missing active_offer_in.");
        const prepared = await prepareLendingV3BorrowerAction(req.plan, {
          network: manifestNetwork,
          kind: "repayLoan",
          genesisHash: req.chainSnapshot.genesisHash,
          tipHeight: req.chainSnapshot.tipHeight,
          policyAssetId: req.chainSnapshot.policyAssetId,
          activeOffer,
          borrowerNftInput,
          repaymentInputs,
          feeInputs,
          walletDestination: confidentialDestination,
          explicitWalletDestination: explicitDestination,
          principalChangeDestination: confidentialDestination,
          feeChangeDestination: confidentialDestination,
          fee: feeDecision.actualFee,
        });
        return {
          ...prepared,
          feeSelectionTarget: feeDecision.selectionFee,
          parentTransactions: parents(borrowerNftInput, ...repaymentInputs, ...feeInputs),
        } satisfies HostedPreparedNewLendingExecution;
      }

      if (req.plan.action === SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER) {
        recoverNamedWalletInput("lender_nft_in");
        const lenderNftInput = selectManifestWalletInputByOutpoint(candidates, req.plan.walletInputs[0].outpoint, req.plan.intent.lenderNftAssetId, "1", "lender NFT");
        const feeInputs = selectManifestWalletInputs(
          candidates,
          req.chainSnapshot.policyAssetId,
          fee,
          [lenderNftInput],
          "distinct L-BTC fee inputs",
          TX_MANIFEST_MINIMUM_POST_FEE_LBTC_CHANGE,
        );
        const feeDecision = txManifestLbtcChangeDecision(feeInputs, "0", fee);
        const activeOffer = req.chainSnapshot.inputs.active_offer_in;
        if (!activeOffer) throw new Error("Verified chain snapshot is missing active_offer_in.");
        const prepared = await prepareLendingV3BorrowerAction(req.plan, {
          network: manifestNetwork,
          kind: "liquidateOffer",
          genesisHash: req.chainSnapshot.genesisHash,
          tipHeight: req.chainSnapshot.tipHeight,
          policyAssetId: req.chainSnapshot.policyAssetId,
          activeOffer,
          lenderNftInput,
          feeInputs,
          walletDestination: confidentialDestination,
          explicitWalletDestination: explicitDestination,
          feeChangeDestination: confidentialDestination,
          fee: feeDecision.actualFee,
        });
        return {
          ...prepared,
          feeSelectionTarget: feeDecision.selectionFee,
          parentTransactions: parents(lenderNftInput, ...feeInputs),
        } satisfies HostedPreparedNewLendingExecution;
      }

      throw new Error("Unsupported Simplicity Lending TX Manifest action.");
        },
        estimateTxManifestFee,
      );
    }

    case "signPset": {
      const signer = new lwk.Signer(new lwk.Mnemonic(req.mnemonic), lwkNetwork(lwk, req.network));
      return signer.sign(new lwk.Pset(req.pset)).toString();
    }

    case "signTxManifestPset": {
      const entry = await ensureWollet(lwk, req.descriptor, req.network);
      const pset = new lwk.Pset(req.pset);
      let consumed = false;
      const network = lwkNetwork(lwk, req.network);
      try {
        pset.addDetails(entry.wollet);
        const mnemonic = new lwk.Mnemonic(req.mnemonic);
        const signer = new lwk.Signer(mnemonic, network);
        consumed = true;
        try {
          const signed = signer.sign(pset);
          try {
            return signed.toString();
          } finally {
            signed.free();
          }
        } finally {
          signer.free();
          mnemonic.free();
        }
      } finally {
        if (!consumed) pset.free();
        network.free();
      }
    }

    case "verifyDealerPset": {
      // Gate a dealer-built PSET (SideSwap `get_quote`) against the accepted
      // quote before signing. The seed isn't needed — only the watch-only
      // Wollet, to read the PSET's net balances from our point of view.
      const entry = await ensureWollet(lwk, req.descriptor, req.network);
      const t = req.terms;
      const result = verifyDealerPset(new lwk.Pset(req.pset), entry.wollet, {
        sendAssetId: t.sendAssetId,
        sendAmount: BigInt(t.sendAmount),
        recvAssetId: t.recvAssetId,
        minRecvAmount: BigInt(t.minRecvAmount),
        maxFee: BigInt(t.maxFee),
        maxSendAmount: t.maxSendAmount != null ? BigInt(t.maxSendAmount) : undefined,
      });
      return result.ok
        ? {
            ok: true as const,
            sent: result.sent.toString(),
            received: result.received.toString(),
            fee: result.fee.toString(),
          }
        : { ok: false as const, reason: result.reason };
    }

    case "signSwapPset": {
      // Atomic verify-then-sign for dealer-built swap PSETs. The verification
      // gate runs first — a tampered PSET never reaches the signer. addDetails
      // is called inside verifyDealerPset, so the PSET is enriched and ready
      // for signing. sign() consumes the Pset (WASM ownership) and returns a
      // new one; finalize() converts partial sigs to final_script_witness.
      const entry = await ensureWollet(lwk, req.descriptor, req.network);
      const t = req.terms;
      const pset = new lwk.Pset(req.pset);
      const verifyResult = verifyDealerPset(pset, entry.wollet, {
        sendAssetId: t.sendAssetId,
        sendAmount: BigInt(t.sendAmount),
        recvAssetId: t.recvAssetId,
        minRecvAmount: BigInt(t.minRecvAmount),
        maxFee: BigInt(t.maxFee),
        maxSendAmount: t.maxSendAmount != null ? BigInt(t.maxSendAmount) : undefined,
      });
      if (!verifyResult.ok) {
        const result: SignSwapPsetWireResult = { ok: false, reason: verifyResult.reason };
        return result;
      }
      // Signer is constructed after the gate passes so the seed stays out of
      // memory on the reject path. sign/finalize are wrapped so failures return
      // a SignSwapPsetWireResult matching the documented wire contract, not a
      // transport-level error envelope.
      try {
        const net = lwkNetwork(lwk, req.network);
        const signer = new lwk.Signer(new lwk.Mnemonic(req.mnemonic), net);
        const signedPset = signer.sign(pset);
        const finalizedPset = entry.wollet.finalize(signedPset);
        const result: SignSwapPsetWireResult = {
          ok: true,
          pset: finalizedPset.toString(),
          sent: verifyResult.sent.toString(),
          received: verifyResult.received.toString(),
          fee: verifyResult.fee.toString(),
        };
        return result;
      } catch (e: unknown) {
        const result: SignSwapPsetWireResult = {
          ok: false,
          reason: e instanceof Error ? e.message : String(e),
        };
        return result;
      }
    }

    case "getUtxos": {
      // Unspent outputs with their unblinding data — SideSwap's `start_quotes`
      // needs asset/value + both blinding factors per UTXO.
      const entry = await ensureWollet(lwk, req.descriptor, req.network);
      return entry.wollet.utxos().map((u): UtxoDTO => {
        const op = u.outpoint();
        const sec = u.unblinded();
        return {
          txid: op.txid().toString(),
          vout: op.vout(),
          asset: sec.asset().toString(),
          assetBf: sec.assetBlindingFactor().toString(),
          value: sec.value().toString(),
          valueBf: sec.valueBlindingFactor().toString(),
        };
      });
    }

    case "getWalletUtxos": {
      // UI-safe coin list: address and confidentiality, no blinding factors.
      const entry = await ensureWollet(lwk, req.descriptor, req.network);
      return entry.wollet.utxos().map((u): WalletUtxoDTO => {
        const op = u.outpoint();
        const sec = u.unblinded();
        return {
          txid: op.txid().toString(),
          vout: op.vout(),
          address: u.address().toString(),
          asset: sec.asset().toString(),
          amount: sec.value().toString(),
          confidential: !sec.isExplicit(),
        };
      });
    }

    case "getProviderUtxos": {
      const entry = await ensureWollet(lwk, req.descriptor, req.network);
      // Keep the existing SideSwap DTO separate: that internal integration
      // needs ABF/VBF values, while the browser RPC must never expose them.
      return collectProviderUtxos(entry.wollet, req.asset);
    }

    case "getRate": {
      // Median BTC price in `currency` across several public price sources.
      // lwk's fetcher carries no timeout of its own, so timebox it — a hanging
      // price source must not stall the rate (the dangling wasm call is
      // harmless: PricesFetcher is a fresh object, no wollet aliasing).
      try {
        const rates = await Promise.race([
          new lwk.PricesFetcher().rates(new lwk.CurrencyCode(req.currency)),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("rate fetch timed out")), 8_000),
          ),
        ]);
        return rates.median();
      } catch (e) {
        // lwk hardcodes its supported fiats (JPY is missing, for one); quote
        // the same public sources directly for anything it refuses or when it
        // times out.
        console.warn(`[apogee] lwk rate fetch failed for ${req.currency}, using fallback`, e);
        return fallbackRate(req.currency);
      }
    }

    case "getPrice24hAgo": {
      // One point for the rate bar's 24h delta — cheap enough to fetch on open.
      return getPrice24hAgo(req.currency);
    }

    case "getPriceHistory": {
      // Chart data. Read-only public price data, display-only — never feeds a send
      // or swap amount. Fetched only when the user opens the chart (the panel does
      // not poll), and cached, so an unopened chart costs nothing.
      return getPriceHistory(req.currency, req.range);
    }

    case "checkEsplora": {
      // Validate a user-supplied Esplora root: it must answer quickly, and it
      // must serve the wallet's chain — checked against the genesis-block hash
      // so a mainnet URL can't be saved onto a testnet wallet (or vice versa).
      const root = req.url.replace(/\/+$/, "");
      let genesis: string;
      try {
        const res = await fetch(`${root}/block-height/0`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        genesis = (await res.text()).trim();
      } catch {
        throw new Error("Couldn't reach that server. It may be down, throttled, or blocked from your connection.");
      }
      // A reachable non-Esplora host (or an SPA 404 page) answers with HTML,
      // not a block hash — call that out instead of claiming a network mismatch.
      if (!/^[0-9a-fA-F]{64}$/.test(genesis)) {
        throw new Error(
          "That URL doesn't answer like an Esplora API. Use the API root (usually ending in /api).",
        );
      }
      const expected = GENESIS[req.network];
      if (expected && genesis !== expected) {
        throw new Error("That server is for a different network than this wallet.");
      }
      return true;
    }

    case "probeChainServer": {
      // A pinned override: probe that single endpoint. Automatic: probe
      // waterfalls (the primary) plus both Esplora fallbacks so the badge can
      // show a primary outage against a working fallback.
      const waterfalls = WATERFALLS[req.network];
      const primaryEsplora = ESPLORA[req.network];
      const altEsplora = ESPLORA_ALT[req.network];
      if (req.esploraUrl) {
        const root = req.esploraUrl.replace(/\/+$/, "");
        const p = await probeRoot(root, "/blocks/tip/height");
        const health: ChainServerHealth = {
          mode: "pinned",
          status: p.status,
          latencyMs: p.latencyMs,
          url: root,
        };
        return health;
      }
      const [wf, pri, alt] = await Promise.all([
        probeRoot(waterfalls, "/v1/server_recipient"),
        probeRoot(primaryEsplora, "/blocks/tip/height"),
        probeRoot(altEsplora, "/blocks/tip/height"),
      ]);
      wf.label = "Waterfalls";
      pri.label = "Liquid.network";
      alt.label = "Blockstream";
      const providers = [wf, pri, alt];
      const health: ChainServerHealth = {
        mode: "automatic",
        status: aggregateStatus(wf, [pri, alt]),
        latencyMs: wf.latencyMs,
        providers,
      };
      return health;
    }

    case "qr":
      // 1px-per-module monochrome bitmap data-URI; scale up with CSS
      // image-rendering: pixelated. Quiet zone is added by the white plate.
      return lwk.stringToQr(req.text);

    case "getAsset": {
      // Best-effort: many issued contract tokens aren't in the public
      // registry, so any failure resolves to nulls and the UI shows hex.
      try {
        const net = lwkNetwork(lwk, req.network);
        const registry = lwk.Registry.defaultHardcodedForNetwork(net);
        const meta = await registry.fetchWithTx(
          lwk.AssetId.fromString(req.assetId),
          net.defaultEsploraClient(),
        );
        const c = JSON.parse(meta.contract().toString()) as {
          name?: string;
          ticker?: string;
          precision?: number;
        };
        const info: AssetInfo = {
          name: c.name ?? null,
          // Contract JSON is issuer-controlled — type-check like precision.
          ticker: typeof c.ticker === "string" ? c.ticker : null,
          precision: typeof c.precision === "number" ? c.precision : null,
        };
        return info;
      } catch {
        const info: AssetInfo = { name: null, ticker: null, precision: null };
        return info;
      }
    }

    case "descriptorInfo": {
      // Validate a pasted watch-only descriptor by constructing it (throws on a
      // malformed descriptor) and read its network. The master fingerprint isn't
      // exposed by WolletDescriptor, so pull it from the key-origin prefix
      // ([abcd1234/84h/...]) that standard exported descriptors carry.
      const descriptor = req.descriptor.trim();
      let wd: Lwk.WolletDescriptor;
      try {
        wd = new lwk.WolletDescriptor(descriptor);
      } catch {
        throw new Error("That doesn't look like a valid Liquid descriptor.");
      }
      // Read the fingerprint and the canonical form off the SAME serialization,
      // so what is stored and what was inspected cannot disagree.
      const canonical = wd.toString();
      const mainnet = wd.isMainnet();
      wd.free();
      const originFp = canonical.match(/\[([0-9a-fA-F]{8})[/\]]/);
      if (!originFp) {
        throw new Error("Descriptor is missing a key fingerprint, e.g. [a1b2c3d4/84h/...].");
      }
      const info: DescriptorInfo = {
        fingerprint: originFp[1].toLowerCase(),
        mainnet,
        canonical,
      };
      return info;
    }

    case "walletIdentity": {
      const network = lwkNetwork(lwk, req.network);
      const descriptor = new lwk.WolletDescriptor(req.descriptor);
      const wollet = new lwk.Wollet(network, descriptor);
      try {
        const chainId = `bip122:${network.genesisBlockHash().slice(0, 32)}`;
        const identity: WalletIdentity = {
          dwid: wollet.dwid(),
          chainId,
          policyAssetId: `${chainId}/elip144:${network.policyAsset().toString()}`,
        };
        return identity;
      } finally {
        wollet.free();
        descriptor.free();
        network.free();
      }
    }

    case "getPublicWalletDescriptor": {
      // Parsing through LWK is the authoritative syntax/policy validation. Work
      // from its canonical string so the projection helper never interprets a
      // malformed caller-controlled descriptor.
      const descriptor = new lwk.WolletDescriptor(req.descriptor);
      try {
        return publicWalletDescriptor(descriptor.toString()) satisfies PublicWalletDescriptorDTO;
      } finally {
        descriptor.free();
      }
    }

    case "analyzeProviderPset": {
      let pset: Lwk.Pset;
      try {
        pset = new lwk.Pset(req.pset);
      } catch {
        const result: ProviderPsetAnalysisResultDTO = { ok: false, reason: "malformed_pset" };
        return result;
      }

      const network = lwkNetwork(lwk, req.network);
      try {
        const normalized = normalizeProviderPsetSignInputs(lwk, network, req.signInputs);
        if (!normalized.ok) return normalized.result;

        const entry = await ensureWollet(lwk, req.descriptor, req.network);
        const policyAsset = network.policyAsset();
        try {
          return analyzeProviderPset(
            pset,
            entry.wollet,
            policyAsset.toString(),
            normalized.inputs,
          );
        } finally {
          policyAsset.free();
        }
      } catch {
        const result: ProviderPsetAnalysisResultDTO = { ok: false, reason: "analysis_failed" };
        return result;
      } finally {
        pset.free();
        network.free();
      }
    }

    case "signProviderPset": {
      let pset: Lwk.Pset;
      try {
        pset = new lwk.Pset(req.pset);
      } catch {
        const result: ProviderPsetSignResultDTO = { ok: false, reason: "malformed_pset" };
        return result;
      }

      let consumed = false;
      const network = lwkNetwork(lwk, req.network);
      try {
        const normalized = normalizeProviderPsetSignInputs(lwk, network, req.signInputs);
        if (!normalized.ok) return normalized.result;
        const entry = await ensureWollet(lwk, req.descriptor, req.network);
        const policyAsset = network.policyAsset();
        try {
          return analyzeAndSignProviderPset(
            pset,
            entry.wollet,
            policyAsset.toString(),
            normalized.inputs,
            req.expectedAnalysis,
            (candidate) => {
              const mnemonic = new lwk.Mnemonic(req.mnemonic);
              const signer = new lwk.Signer(mnemonic, network);
              consumed = true;
              try {
                return signer.sign(candidate);
              } finally {
                signer.free();
                mnemonic.free();
              }
            },
          );
        } finally {
          policyAsset.free();
        }
      } catch {
        const result: ProviderPsetSignResultDTO = { ok: false, reason: "signing_failed" };
        return result;
      } finally {
        if (!consumed) pset.free();
        network.free();
      }
    }

    case "finalizePset": {
      const entry = await ensureWollet(lwk, req.descriptor, req.network);
      const finalized = entry.wollet.finalize(new lwk.Pset(req.pset));
      try {
        return finalized.toString();
      } finally {
        finalized.free();
      }
    }

    case "extractPsetTransaction": {
      const pset = new lwk.Pset(req.pset);
      try {
        const transaction = pset.extractTx();
        try {
          return {
            transactionHex: transaction.toString(),
            txid: transaction.txid().toString(),
          };
        } finally {
          transaction.free();
        }
      } finally {
        pset.free();
      }
    }

    case "broadcastPset": {
      const net = lwkNetwork(lwk, req.network);
      const pset = new lwk.Pset(req.pset);
      try {
        const txid = await broadcastResilient(lwk, net, req.network, pset, req.esploraUrl);
        const result: SendResult = { txid };
        return result;
      } finally {
        pset.free();
        net.free();
      }
    }

    case "broadcastTransaction": {
      const net = lwkNetwork(lwk, req.network);
      const transaction = lwk.Transaction.fromString(req.transactionHex);
      try {
        const expectedTxid = transaction.txid().toString();
        const txid = await broadcastTransactionResilient(
          lwk,
          net,
          req.network,
          transaction,
          req.esploraUrl,
        );
        if (txid !== expectedTxid) {
          throw new Error("The chain server returned a different transaction id after broadcast.");
        }
        const result: SendResult = { txid };
        return result;
      } finally {
        transaction.free();
        net.free();
      }
    }

    case "prepareSend": {
      const net = lwkNetwork(lwk, req.network);
      const entry = await ensureWollet(lwk, req.descriptor, req.network);
      // Validate the recipient + network. Like Blockstream Green, we only send to
      // CONFIDENTIAL addresses — `Address.parse` rejects non-blinded ones (lwk
      // can't reliably blind a send to an unconfidential recipient). Surface that
      // as a clear, actionable error rather than lwk's raw "blinded" message.
      let addr: Lwk.Address;
      try {
        addr = lwk.Address.parse(req.address, net);
      } catch (e) {
        let probe: Lwk.Address | undefined;
        try {
          probe = new lwk.Address(req.address);
        } catch {
          throw e; // malformed address — surface lwk's parse error
        }
        if (!probe.isBlinded()) {
          throw new Error(
            "That's an unconfidential address. Liquid keeps amounts private, so please use a confidential address.",
          );
        }
        throw e; // confidential but e.g. wrong network — surface lwk's error
      }

      // Which asset moves: absent (or the policy asset itself) → the LBTC path,
      // unchanged; anything else → a token send via addRecipient. The fee is
      // ALWAYS paid in LBTC, so token sends need LBTC alongside the token.
      const isToken = typeof req.asset === "string" && req.asset !== entry.policyAssetHex;
      let assetId: Lwk.AssetId | null = null;
      if (isToken) {
        try {
          assetId = lwk.AssetId.fromString(req.asset as string);
        } catch {
          throw new Error("Invalid asset id.");
        }
        // Fee-affordability preflight: a wallet flush with tokens but empty of
        // LBTC can't pay the network fee — say so instead of surfacing lwk's
        // raw insufficient-funds error for an asset the user has plenty of.
        const balances = balanceToStringRecord(entry.wollet.balance());
        if (BigInt(balances[entry.policyAssetHex] ?? "0") <= 0n) {
          throw new Error("You need LBTC to pay the network fee — this wallet has none.");
        }
      }

      // Token "send max" = the full token balance as a fixed amount (there is no
      // asset drain in lwk, and none is needed: the fee comes from LBTC, so
      // sending the entire token balance is an ordinary fixed send). Resolve the
      // amount here from the live wallet balance rather than trusting the UI's
      // possibly-stale figure.
      let sats: bigint;
      try {
        sats =
          typeof req.sats === "string"
            ? BigInt(req.sats)
            : Number.isSafeInteger(req.sats)
              ? BigInt(req.sats)
              : -1n;
      } catch {
        sats = -1n;
      }
      if (isToken && req.drain) {
        const balance = balanceToStringRecord(entry.wollet.balance())[req.asset as string] ?? "0";
        sats = BigInt(balance);
      }

      // LWK's builder accepts an unsigned 64-bit base-unit amount. Keep the RPC
      // decimal string exact until this conversion and reject rather than round.
      const maxU64 = (1n << 64n) - 1n;
      if ((isToken || !req.drain) && (sats <= 0n || sats > maxU64)) {
        throw new Error("Invalid send amount.");
      }

      let pset: Lwk.Pset;
      try {
        pset = isToken
          ? new lwk.TxBuilder(net)
              .addRecipient(addr, sats, assetId as Lwk.AssetId)
              .finish(entry.wollet)
          : req.drain
            ? new lwk.TxBuilder(net).drainLbtcWallet().drainLbtcTo(addr).finish(entry.wollet)
            : new lwk.TxBuilder(net).addLbtcRecipient(addr, sats).finish(entry.wollet);
      } catch (e) {
        // A token send with ample token balance can still fail on the LBTC fee;
        // translate lwk's generic insufficient-funds into the actionable cause.
        const m = e instanceof Error ? e.message.toLowerCase() : "";
        if (isToken && m.includes("insufficient")) {
          const balances = balanceToStringRecord(entry.wollet.balance());
          if (BigInt(balances[req.asset as string] ?? "0") >= sats) {
            throw new Error("Not enough LBTC to pay the network fee.");
          }
        }
        throw e;
      }

      // Read the fee and the wallet's net per-asset deltas off the PSET we
      // actually built, then hand them to `exactRecipientAmount` — which lives in its
      // own module because everything here is behind loadLwk() + a live Wollet
      // and so can't be reached from a test. See recipient-amount.ts for why the
      // amount is PSET-derived rather than taken from the caller, and for the
      // one case (paying ourselves) where the PSET has nothing left to read.
      const psetBalance = entry.wollet.psetDetails(pset).balance();
      const feeAmount = psetBalance.feesIn(net.policyAsset()).toString();
      const deltas = balanceToStringRecord(psetBalance.balances());
      // Only an LBTC drain needs the wallet balance (see recipient-amount.ts), so
      // don't pay for the extra lwk read on an ordinary send.
      const policyBalance =
        !isToken && req.drain
          ? (balanceToStringRecord(entry.wollet.balance())[entry.policyAssetHex] ?? "0")
          : "0";
      const { amount: recipientAmount, toSelf } = exactRecipientAmount({
        deltas,
        fee: feeAmount,
        recipientsCount: psetBalance.recipients().length,
        amount: sats.toString(),
        drain: Boolean(req.drain),
        isToken,
        assetId: req.asset,
        policyAssetHex: entry.policyAssetHex,
        policyBalance,
      });

      const result: PrepareSendResult = {
        pset: pset.toString(),
        fee: Number(feeAmount),
        recipientSats: Number(recipientAmount),
        feeAmount,
        recipientAmount,
        assetId: isToken ? (req.asset as string) : entry.policyAssetHex,
        toSelf,
      };
      return result;
    }

    case "signBroadcast": {
      const net = lwkNetwork(lwk, req.network);
      const signer = new lwk.Signer(new lwk.Mnemonic(req.mnemonic), net);
      const entry = await ensureWollet(lwk, req.descriptor, req.network);
      const signed = entry.wollet.finalize(signer.sign(new lwk.Pset(req.pset)));
      const txid = await broadcastResilient(lwk, net, req.network, signed, req.esploraUrl);
      const result: SendResult = { txid };
      return result;
    }

    case "finalizeBroadcast": {
      // The PSET was already signed elsewhere (the Jade device). Finalize it with
      // the watch-only wollet (no seed needed) and broadcast.
      const net = lwkNetwork(lwk, req.network);
      const entry = await ensureWollet(lwk, req.descriptor, req.network);
      const signed = entry.wollet.finalize(new lwk.Pset(req.pset));
      const txid = await broadcastResilient(lwk, net, req.network, signed, req.esploraUrl);
      const result: SendResult = { txid };
      return result;
    }
  }
}
