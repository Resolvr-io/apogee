// Wallet engine core. lwk_wasm (Wollet / Signer / EsploraClient) lives here,
// driven through the single `handle(req)` dispatcher. Two hosts import it:
//   • Chrome  — the offscreen document (src/offscreen/offscreen.ts), since the
//     MV3 service worker is ephemeral and CSP-restricted.
//   • Firefox — the background event page (no offscreen API), which calls
//     `handle` in-process.
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
import { verifyDealerPset } from "@/engine/verify-dealer-pset";
import type {
  AddressDTO,
  AssetInfo,
  ChainServerHealth,
  DerivedWallet,
  DescriptorInfo,
  EngineRequest,
  ManifestCovenantSpend,
  ManifestLeg,
  ManifestOutputRef,
  ManifestTxLeg,
  PrepareManifestResult,
  PrepareSendResult,
  ProviderProbe,
  ProbeStatus,
  RunManifestResult,
  SendResult,
  SignSwapPsetWireResult,
  SyncResult,
  UtxoDTO,
  WalletTxDTO,
} from "@/engine/protocol";
import {
  MANIFEST_ERROR_PREFIX,
  ManifestError,
  planAction,
  type PlannedInput,
  type PlannedOutput,
} from "@/manifest/runner";
import { buildArguments, NUMS_KEY } from "@/manifest/covenant";
import { buildWitnessValues } from "@/manifest/witness";
import { SwelError } from "@/manifest/swel";

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
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${SCAN_STATE_PREFIX}${network}:${hex.slice(0, 16)}`;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Max witness weight reserved for a covenant input's Simplicity spend, so lwk
 * sizes the fee with it included. A keyless Simplicity witness (control block +
 * program + witness data) is large and hard to predict up front; this is a
 * deliberate OVER-estimate — too low underpays the fee, too high only
 * over-reserves it. TUNE against a real finalized Settle's witness weight once
 * one has been measured on testnet.
 */
const COVENANT_WITNESS_MAX_WEIGHT = 100_000;

/**
 * Fetch a UTXO's funding transaction from Esplora. lwk exposes no tx-by-txid call
 * and an ExternalUtxo needs the whole funding tx, so this is a plain REST GET of
 * the raw hex.
 */
async function fetchFundingTx(
  lwk: typeof Lwk,
  esploraRoot: string,
  txid: string,
): Promise<Lwk.Transaction> {
  const url = `${esploraRoot.replace(/\/$/, "")}/tx/${txid}/hex`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Couldn't fetch the covenant funding transaction (HTTP ${res.status}).`);
  }
  return new lwk.Transaction((await res.text()).trim());
}

/**
 * Turn each planned covenant input into an lwk `ExternalUtxo`, enforcing the hard
 * gate first: the address WE derived from the manifest must equal the on-chain
 * script of the UTXO being spent. A lie about any committed field changes the
 * derived address, so it fails HERE rather than as a covenant rejection after the
 * user approved. The covenant output must be explicit (unblinded) — its secrets
 * come straight from the funding tx, never from the caller's claim.
 */
async function buildCovenantUtxos(
  lwk: typeof Lwk,
  inputs: PlannedInput[],
  esploraRoot: string,
): Promise<Lwk.ExternalUtxo[]> {
  const utxos: Lwk.ExternalUtxo[] = [];
  for (const inp of inputs) {
    const fundingTx = await fetchFundingTx(lwk, esploraRoot, inp.providedInput.txid);
    const prevout = fundingTx.outputs[inp.providedInput.vout];
    if (!prevout) {
      throw new Error(`Funding tx for "${inp.id}" has no output ${inp.providedInput.vout}.`);
    }
    const derivedSpk = new lwk.Address(inp.address).scriptPubkey().toString();
    const onchainSpk = prevout.scriptPubkey().toString();
    if (derivedSpk !== onchainSpk) {
      throw new Error(
        `Input "${inp.id}": the derived covenant address does not match the UTXO on chain.`,
      );
    }
    const asset = prevout.asset();
    const value = prevout.value();
    if (!asset || value === undefined) {
      throw new Error(`Input "${inp.id}": the covenant UTXO is confidential; an explicit one is required.`);
    }
    const secrets = lwk.TxOutSecrets.fromExplicit(asset, value);
    utxos.push(
      new lwk.ExternalUtxo(inp.providedInput.vout, fundingTx, secrets, COVENANT_WITNESS_MAX_WEIGHT, true),
    );
  }
  return utxos;
}

/** Decode an even-length hex string to bytes — for an OP_RETURN payload the runner
 *  already encoded to exact bytes. */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || (hex.length > 0 && !/^[0-9a-fA-F]+$/.test(hex))) {
    throw new Error("OP_RETURN payload isn't valid hex.");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
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
 * median of whoever answers (≥2 required). The hosts are already in
 * host_permissions — they're a subset of the sources lwk itself uses.
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

export async function handle(req: EngineRequest): Promise<unknown> {
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
      const balance = balanceToRecord(entry.wollet.balance());
      const result: SyncResult = {
        lbtcSats: balance[entry.policyAssetHex] ?? 0,
        balance,
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
      const txs: WalletTxDTO[] = entry.wollet.transactions().map((tx) => {
        const txid = tx.txid().toString();
        const spends = new Set<string>();
        for (const input of tx.inputs()) {
          const spent = input.get();
          if (spent) spends.add(spent.outpoint().txid().toString());
        }
        spendsFrom.set(txid, spends);
        const assetDeltas = balanceToRecord(tx.balance());
        return {
          txid,
          balanceChange: assetDeltas[entry.policyAssetHex] ?? 0,
          fee: Number(tx.fee()),
          height: tx.height() ?? null,
          timestamp: tx.timestamp() ?? null,
          assetDeltas,
        };
      });
      return orderTransactionsNewestFirst(txs, spendsFrom);
    }

    case "signPset": {
      const signer = new lwk.Signer(new lwk.Mnemonic(req.mnemonic), lwkNetwork(lwk, req.network));
      return signer.sign(new lwk.Pset(req.pset)).toString();
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
          ticker: c.ticker ?? null,
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
      const originFp = descriptor.match(/\[([0-9a-fA-F]{8})[/\]]/);
      if (!originFp) {
        throw new Error("Descriptor is missing a key fingerprint, e.g. [a1b2c3d4/84h/...].");
      }
      const info: DescriptorInfo = { fingerprint: originFp[1].toLowerCase(), mainnet: wd.isMainnet() };
      return info;
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
        const balances = balanceToRecord(entry.wollet.balance());
        if ((balances[entry.policyAssetHex] ?? 0) <= 0) {
          throw new Error("You need LBTC to pay the network fee — this wallet has none.");
        }
      }

      // Token "send max" = the full token balance as a fixed amount (there is no
      // asset drain in lwk, and none is needed: the fee comes from LBTC, so
      // sending the entire token balance is an ordinary fixed send). Resolve the
      // amount here from the live wallet balance rather than trusting the UI's
      // possibly-stale figure.
      let sats = req.sats;
      if (isToken && req.drain) {
        sats = balanceToRecord(entry.wollet.balance())[req.asset as string] ?? 0;
      }

      // Guard the fixed-amount path so a non-integer/negative amount can't reach
      // BigInt() and throw raw. (LBTC drain skips this — the builder sets the
      // amount.)
      if ((isToken || !req.drain) && (!Number.isSafeInteger(sats) || sats <= 0)) {
        throw new Error("Invalid send amount.");
      }

      let pset: Lwk.Pset;
      try {
        pset = isToken
          ? new lwk.TxBuilder(net)
              .addRecipient(addr, BigInt(sats), assetId as Lwk.AssetId)
              .finish(entry.wollet)
          : req.drain
            ? new lwk.TxBuilder(net).drainLbtcWallet().drainLbtcTo(addr).finish(entry.wollet)
            : new lwk.TxBuilder(net).addLbtcRecipient(addr, BigInt(sats)).finish(entry.wollet);
      } catch (e) {
        // A token send with ample token balance can still fail on the LBTC fee;
        // translate lwk's generic insufficient-funds into the actionable cause.
        const m = e instanceof Error ? e.message.toLowerCase() : "";
        if (isToken && m.includes("insufficient")) {
          const balances = balanceToRecord(entry.wollet.balance());
          if ((balances[req.asset as string] ?? 0) >= sats) {
            throw new Error("Not enough LBTC to pay the network fee.");
          }
        }
        throw e;
      }

      // Derive fee AND recipient amount from the PSET we actually built — never
      // from caller-supplied `sats`. lwk reports the wallet's net per-asset
      // deltas for this PSET (negative for a spend). For LBTC the policy delta's
      // magnitude is recipient + fee, so the recipient receives (-netPolicy - fee);
      // for a token the fee lives entirely in the policy delta, so the recipient
      // amount is simply the magnitude of the token delta — no fee term. Computed
      // from the wallet's own inputs/change so it holds even with confidential
      // recipient outputs (per-output reads are undefined when blinded).
      const psetBalance = entry.wollet.psetDetails(pset).balance();
      const fee = Number(psetBalance.feesIn(net.policyAsset()));
      const deltas = balanceToRecord(psetBalance.balances());
      const recipientAmount = isToken
        ? -(deltas[req.asset as string] ?? 0)
        : -(deltas[entry.policyAssetHex] ?? 0) - fee;

      const result: PrepareSendResult = {
        pset: pset.toString(),
        fee,
        recipientSats: recipientAmount,
        assetId: isToken ? (req.asset as string) : entry.policyAssetHex,
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

    case "prepareManifest": {
      const net = lwkNetwork(lwk, req.network);
      const entry = await ensureWollet(lwk, req.descriptor, req.network);
      // Resolve the action first. This is where covenant addresses are DERIVED
      // from the manifest's own .simf source — the caller never gets to name a
      // destination. planAction refuses anything it can't fully account for.
      // Errors from here describe the CALLER's own manifest back to it and leak
      // nothing about wallet state, so they're safe to forward verbatim. The
      // engine boundary is a string channel that drops the error class, hence the
      // explicit marker — an allowlist by prefix alone would eventually let an
      // internal message through. See PROVIDER_SAFE_ERRORS in the background.
      let plan;
      try {
        plan = planAction(lwk, {
          manifestText: req.manifest,
          action: req.action,
          sources: req.sources,
          instanceText: req.instance,
          providedInputs: req.providedInputs,
          actionParams: req.actionParams,
          network: req.network,
        });
      } catch (e) {
        if (e instanceof ManifestError || e instanceof SwelError) {
          throw new Error(`${MANIFEST_ERROR_PREFIX}${e.message}`);
        }
        throw e;
      }

      // lwk's WASM methods CONSUME the AssetId they're handed (its pointer is
      // freed after one use), so never cache one — capture the hex string (safe
      // to reuse) and mint a fresh AssetId per call. prepareSend follows the same
      // rule by calling net.policyAsset() fresh at each site. Reusing a single
      // cached AssetId here surfaced as "null pointer passed to rust".
      const policyAssetHex = net.policyAsset().toString();
      const assetIdFor = (asset: string): Lwk.AssetId =>
        asset === "lbtc" || asset === "bitcoin" ? net.policyAsset() : lwk.AssetId.fromString(asset);

      // `Address.parse` REJECTS non-blinded addresses ("Expected a blinded
      // address but got a non-blinded one"), and a covenant address is always
      // unconfidential — its script is the contract. So parse with the plain
      // constructor. Skipping parse's network check is safe here and only here:
      // we DERIVED this address ourselves from `req.network` moments ago rather
      // than accepting one from the caller, so it cannot be for another network.
      const covenantAddress = (a: string): Lwk.Address => new lwk.Address(a);

      // Covenant inputs to spend (empty for a constructor like Fund). Each is
      // verified against its on-chain script here before it can enter the tx.
      const covenantUtxos =
        plan.inputs.length > 0
          ? await buildCovenantUtxos(lwk, plan.inputs, ESPLORA[req.network])
          : [];

      let builder = new lwk.TxBuilder(net);
      // Track which outputs we add, in the order we add them, so the vout of each
      // covenant output is known before broadcast. `change` is left to lwk (it
      // appends and may omit it entirely when there's nothing to return).
      const added: PlannedOutput[] = [];
      for (const o of plan.outputs) {
        if (o.wallet === "change") continue; // lwk builds change itself
        if (o.opReturnData !== undefined) {
          // On-chain metadata (an OP_RETURN discovery record). A zero-value OP_RETURN
          // carrying the already-encoded payload; it isn't a spendable output, so it
          // never enters `added`.
          builder = builder.addOpReturn(hexToBytes(o.opReturnData));
        } else if (o.address) {
          if (o.amountSat === undefined) throw new Error(`Output "${o.id}" has no amount.`);
          // A covenant output is always explicit (unblinded) — its script is the
          // contract, and blinding it would hide the very thing being committed to. A
          // fixed external destination (the discovery beacon) is explicit for the same
          // reason: it's a known NUMS P2TR address, not a wallet address to blind to.
          builder = builder.addExplicitRecipient(covenantAddress(o.address), o.amountSat, assetIdFor(o.asset));
          // Only covenant outputs WE derived are spendable created UTXOs handed back to
          // the caller; an external beacon output is paid but not tracked as one.
          if (!o.external) added.push(o);
        } else if (o.wallet === "recipient") {
          // Pays the user's own wallet — e.g. Settle's `taker_out`, the asset
          // released from the covenant. A fresh wallet address receives it
          // (blinded is fine; it's ours). Its amount rides the built PSET like any
          // other, so the approval's net effect stays PSET-derived.
          if (o.amountSat === undefined) throw new Error(`Output "${o.id}" has no amount.`);
          const to = entry.wollet.address(null).address();
          builder = builder.addRecipient(to, o.amountSat, assetIdFor(o.asset));
        }
      }
      if (covenantUtxos.length > 0) builder = builder.addExternalUtxos(covenantUtxos);
      const pset = builder.finish(entry.wollet);

      // Enforce declared `required_index` on covenant outputs (consensus-critical:
      // a covenant's spend witness can commit to a specific output index and check
      // the asset/amount/script of THAT index). A reordering by lwk must fail here,
      // not on chain after approval.
      const psetOutScripts = pset.outputs().map((po) => po.scriptPubkey().toString());
      for (const o of plan.outputs) {
        if (o.requiredIndex === undefined || !o.address) continue;
        const want = covenantAddress(o.address).scriptPubkey().toString();
        if (psetOutScripts[o.requiredIndex] !== want) {
          throw new Error(`Output "${o.id}" must be at index ${o.requiredIndex}, but the built tx disagrees.`);
        }
      }

      // Locate each covenant input in the built PSET (by outpoint) and package what
      // signBroadcastManifest needs to finalize it — it never re-runs the planner.
      const psetInputs = pset.inputs();
      const covenantSpends: ManifestCovenantSpend[] = plan.inputs.map((inp) => {
        const idx = psetInputs.findIndex(
          (pi) =>
            pi.previousTxid().toString() === inp.providedInput.txid &&
            pi.previousVout() === inp.providedInput.vout,
        );
        if (idx === -1) throw new Error(`Couldn't locate covenant input "${inp.id}" in the built transaction.`);
        return {
          inputIndex: idx,
          source: inp.source,
          compileParams: inp.compileParams,
          debugSymbols: inp.debugSymbols,
          witnesses: inp.witnesses,
        };
      });

      // The amounts the user approves come from the built PSET's own wallet
      // delta, never from the manifest's claims or the caller's params — the
      // same rule prepareSend follows.
      const details = entry.wollet.psetDetails(pset);
      const psetBalance = details.balance();
      const fee = Number(psetBalance.feesIn(net.policyAsset()));
      const net_ = balanceToRecord(psetBalance.balances());

      // Map each covenant output back to its vout. Read from the PSET's own
      // outputs, not extractTx() — nothing is signed yet, and the vout indices
      // are already fixed at this point.
      const psetOutputs = pset.outputs().map((po) => po.scriptPubkey().toString());
      const outputs: ManifestOutputRef[] = added.map((o) => {
        const script = covenantAddress(o.address as string).scriptPubkey().toString();
        const idx = psetOutputs.indexOf(script);
        const vout = idx === -1 ? undefined : idx;
        if (vout === undefined) {
          // The address we derived isn't in the transaction we just built —
          // refuse rather than hand back a reference that points nowhere.
          throw new Error(`Couldn't locate output "${o.id}" in the built transaction.`);
        }
        return {
          utxo_type: o.utxoType ?? "",
          utxo_id: o.id,
          vout,
          amount_sat: String(o.amountSat),
          asset: o.asset === "lbtc" ? policyAssetHex : o.asset,
          address: o.address as string,
        };
      });

      // Covenant INPUT legs are `derived: true` — we recomputed the address and
      // matched it against the on-chain script. That badge covers the COMMITTED
      // terms only; it says nothing about fields the covenant never inspects on
      // its spend path (see task 04).
      const inputLegs: ManifestLeg[] = plan.inputs.map((inp) => ({
        id: inp.id,
        kind: "input" as const,
        label: inp.description,
        address: inp.address,
        amountSat: inp.amountSat !== undefined ? String(inp.amountSat) : "",
        asset: inp.asset === "lbtc" ? policyAssetHex : inp.asset,
        derived: true,
        mine: false,
      }));
      const outputLegs: ManifestLeg[] = added.map((o) => ({
        id: o.id,
        kind: "output" as const,
        label: o.description,
        address: o.address,
        amountSat: String(o.amountSat),
        asset: o.asset === "lbtc" ? policyAssetHex : o.asset,
        derived: Boolean(o.address), // we computed this address; we weren't handed it
        mine: false,
      }));
      // Enumerate the FULL transaction from the built PSET — every input the
      // wallet gathered and every output it created (funding, change, fee), not
      // just the covenant legs. Covenant legs are annotated from inputLegs/
      // outputLegs (their prose + verified badge, keyed by PSET position); the
      // wallet's own legs are blinded, so their amount/asset read as null — that
      // is expected (the authoritative totals live in `net`).
      const contractInputByIndex = new Map<number, ManifestLeg>();
      covenantSpends.forEach((cs, i) => contractInputByIndex.set(cs.inputIndex, inputLegs[i]));
      const contractOutputByVout = new Map<number, ManifestLeg>();
      outputs.forEach((o, i) => contractOutputByVout.set(o.vout, outputLegs[i]));

      const txInputs: ManifestTxLeg[] = pset.inputs().map((pi, idx) => {
        const contract = contractInputByIndex.get(idx);
        const wu = pi.witnessUtxo();
        const amt = wu?.value();
        const ast = wu?.asset();
        return {
          amountSat: amt !== undefined ? Number(amt) : null,
          asset: ast !== undefined ? ast.toString() : null,
          ref: `${pi.previousTxid().toString()}:${pi.previousVout()}`,
          role: contract ? "contract" : "wallet",
          verified: contract?.derived ?? false,
          label: contract?.label,
        };
      });

      const txOutputs: ManifestTxLeg[] = pset.outputs().map((po, idx) => {
        const contract = contractOutputByVout.get(idx);
        // The fee output is the one with an empty scriptPubkey (Elements).
        const isFee = po.scriptPubkey().bytes().length === 0;
        const amt = po.amount(); // explicit value, or undefined when blinded
        const ast = po.asset();
        const role: ManifestTxLeg["role"] = isFee
          ? "fee"
          : contract
            ? "contract"
            : amt === undefined
              ? "wallet" // blinded → the user's own change / receipt
              : "external"; // explicit non-covenant (e.g. an OP_RETURN beacon)
        return {
          amountSat:
            amt !== undefined
              ? Number(amt)
              : contract && contract.amountSat !== ""
                ? Number(contract.amountSat)
                : null,
          asset: ast !== undefined ? ast.toString() : contract ? contract.asset : isFee ? policyAssetHex : null,
          ref: contract?.address,
          role,
          verified: contract?.derived ?? false,
          label: contract?.label,
        };
      });

      const result: PrepareManifestResult = {
        pset: pset.toString(),
        review: {
          protocol: plan.protocol,
          action: plan.action,
          description: plan.description,
          intent: plan.intent,
          net: net_,
          policyAssetHex,
          fee,
          txInputs,
          txOutputs,
          trust: "unverified",
        },
        instance: plan.instance
          ? JSON.stringify({ template: plan.instance.template, fields: plan.instance.fields }, null, 2)
          : undefined,
        outputs,
        covenantSpends,
      };
      return result;
    }

    case "signBroadcastManifest": {
      const net = lwkNetwork(lwk, req.network);
      const signer = new lwk.Signer(new lwk.Mnemonic(req.mnemonic), net);
      const entry = await ensureWollet(lwk, req.descriptor, req.network);

      // Sign the wallet inputs and finalize them. For a constructor (Fund) there's
      // no covenant input, so the finalized PSET is broadcastable as-is.
      const finalized = entry.wollet.finalize(signer.sign(new lwk.Pset(req.pset)));

      let txid: string;
      if (req.covenantSpends.length === 0) {
        txid = await broadcastResilient(lwk, net, req.network, finalized);
      } else {
        // Keyless covenant spend: extract the tx (wallet inputs finalized, the
        // covenant input's witness still empty) and add each covenant input's
        // Simplicity witness. No signature — the PATH witness is the whole story.
        const client = new lwk.EsploraClient(net, ESPLORA[req.network], false, 1, false);
        const nums = lwk.XOnlyPublicKey.fromString(NUMS_KEY);
        let tx = finalized.extractTx();
        for (const cov of req.covenantSpends) {
          // Prevouts for the whole tx, in input order (finalizeTransaction consumes
          // the array, so rebuild it per input). `inputs()` returns fresh copies.
          const utxos = finalized.inputs().map((pi) => {
            const u = pi.witnessUtxo();
            if (!u) throw new Error("A PSET input is missing its prevout; can't finalize the covenant.");
            return u;
          });
          const args = buildArguments(lwk, cov.compileParams);
          const program = cov.debugSymbols
            ? lwk.SimplicityProgram.loadWithDebugSymbols(cov.source, args, true)
            : lwk.SimplicityProgram.load(cov.source, args);
          tx = program.finalizeTransaction(
            tx,
            nums,
            utxos,
            cov.inputIndex,
            buildWitnessValues(lwk, cov.witnesses),
            net,
            lwk.SimplicityLogLevel.None,
          );
        }
        txid = (await client.broadcastTx(tx)).toString();
      }

      // The created UTXOs only become addressable once the txid exists; the
      // caller needs them to spend the contract later.
      const result: RunManifestResult = {
        txid,
        utxos: req.outputs.map((o) => ({ ...o, txid })),
      };
      return result;
    }
  }
}
