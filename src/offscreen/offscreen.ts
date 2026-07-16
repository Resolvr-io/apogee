// Engine host. lwk_wasm (Wollet / Signer / EsploraClient) lives here: the MV3
// service worker is ephemeral and CSP-restricted, so the wasm wallet engine
// runs in this persistent offscreen document. The service worker drives it over
// chrome.runtime messages tagged `target: "offscreen"`.
//
// The message listener is registered SYNCHRONOUSLY and lwk_wasm is loaded lazily
// on first use, so a request can't be dropped while the wasm initializes
// (a standard lazy-load pattern for the wasm engine).
//
// Watch-only Wollets are cached per descriptor so repeated sync/balance/address
// calls reuse applied chain state. The signing seed is NEVER cached — it arrives
// per `signPset` call from the keystore and is dropped when the call returns.

import type * as Lwk from "lwk_wasm";
import type { LiquidNetwork } from "@/keystore/keystore";
import type {
  AddressDTO,
  AssetInfo,
  DerivedWallet,
  DescriptorInfo,
  EngineRequest,
  PrepareSendResult,
  SendResult,
  SyncResult,
  WalletTxDTO,
} from "@/engine/protocol";

console.log("[apogee] offscreen ready");

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

/** Plain Esplora REST roots — used for broadcasting (POST /tx). */
const ESPLORA: Record<LiquidNetwork, string> = {
  liquid: "https://blockstream.info/liquid/api",
  liquidtestnet: "https://blockstream.info/liquidtestnet/api",
  regtest: "http://localhost:3000",
};

interface CachedWollet {
  wollet: Lwk.Wollet;
  policyAssetHex: string;
}
const wollets = new Map<string, CachedWollet>();

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
 *  Amounts are coerced to JS number; safe for L-BTC (max supply ~2.1e15 sats is
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

function ensureWollet(lwk: typeof Lwk, descriptor: string, network: LiquidNetwork): CachedWollet {
  let entry = wollets.get(descriptor);
  if (!entry) {
    const net = lwkNetwork(lwk, network);
    const wollet = new lwk.Wollet(net, new lwk.WolletDescriptor(descriptor));
    entry = { wollet, policyAssetHex: net.policyAsset().toString() };
    wollets.set(descriptor, entry);
  }
  return entry;
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
    m.includes("network")
  );
}

type ScanUpdate = Awaited<ReturnType<Lwk.EsploraClient["fullScan"]>>;

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
    return new lwk.EsploraClient(net, esploraUrl, false, 1, false).fullScan(wollet);
  }

  const WATERFALLS_ATTEMPTS = 2;
  let lastErr: unknown;
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

  // Waterfalls is persistently failing (e.g. an upstream 500) — fall back to a
  // plain Esplora scan, which reaches a different server.
  try {
    console.warn("[apogee] waterfalls unavailable, falling back to Esplora", lastErr);
    return await new lwk.EsploraClient(net, ESPLORA[network], false, 1, false).fullScan(wollet);
  } catch (e) {
    console.error("[apogee] Esplora fallback also failed", e);
    throw new Error("Couldn't reach the chain server. Check your connection and try again.");
  }
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
    const r = await fetch(url);
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

async function handle(req: EngineRequest): Promise<unknown> {
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
      const entry = ensureWollet(lwk, req.descriptor, req.network);
      const net = lwkNetwork(lwk, req.network);
      // Waterfalls (one encrypted-descriptor request) with retry + age-recipient
      // re-fetch and a plain-Esplora fallback; an explicit esploraUrl override
      // scans that endpoint directly. See fullScanResilient.
      const update = await fullScanResilient(lwk, entry.wollet, net, req.network, req.esploraUrl);
      if (update) entry.wollet.applyUpdate(update);
      const balance = balanceToRecord(entry.wollet.balance());
      const result: SyncResult = {
        lbtcSats: balance[entry.policyAssetHex] ?? 0,
        balance,
        policyAssetHex: entry.policyAssetHex,
      };
      return result;
    }

    case "getAddress": {
      const entry = ensureWollet(lwk, req.descriptor, req.network);
      const r = entry.wollet.address(req.index ?? null);
      const dto: AddressDTO = { index: r.index(), address: r.address().toString() };
      return dto;
    }

    case "getBalance": {
      const entry = ensureWollet(lwk, req.descriptor, req.network);
      return balanceToRecord(entry.wollet.balance());
    }

    case "getTransactions": {
      const entry = ensureWollet(lwk, req.descriptor, req.network);
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

    case "getRate": {
      // Median BTC price in `currency` across several public price sources.
      try {
        const rates = await new lwk.PricesFetcher().rates(new lwk.CurrencyCode(req.currency));
        return rates.median();
      } catch (e) {
        // lwk hardcodes its supported fiats (JPY is missing, for one); quote
        // the same public sources directly for anything it refuses.
        console.warn(`[apogee] lwk rate fetch failed for ${req.currency}, using fallback`, e);
        return fallbackRate(req.currency);
      }
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
      const entry = ensureWollet(lwk, req.descriptor, req.network);
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

      // Confidential recipient. Send max drains all L-BTC (fee taken from the
      // amount); otherwise send exactly the requested sats. Guard the fixed-amount
      // path so a non-integer/negative sats can't reach BigInt() and throw raw.
      if (!req.drain && (!Number.isSafeInteger(req.sats) || req.sats <= 0)) {
        throw new Error("Invalid send amount.");
      }
      const pset: Lwk.Pset = req.drain
        ? new lwk.TxBuilder(net).drainLbtcWallet().drainLbtcTo(addr).finish(entry.wollet)
        : new lwk.TxBuilder(net).addLbtcRecipient(addr, BigInt(req.sats)).finish(entry.wollet);

      // Derive fee AND recipient amount from the PSET we actually built — never
      // from caller-supplied `sats`. lwk reports the wallet's net policy-asset
      // delta for this PSET (negative for a spend); its magnitude is
      // recipient + fee, so the recipient receives (-netPolicy - fee). Correct for
      // both drain (where the built PSET, not `sats`, sets the amount) and a fixed
      // send, and computed from the wallet's own inputs/change so it holds even
      // with confidential recipient outputs (unlike per-output reads).
      const psetBalance = entry.wollet.psetDetails(pset).balance();
      const fee = Number(psetBalance.feesIn(net.policyAsset()));
      const netPolicy = balanceToRecord(psetBalance.balances())[entry.policyAssetHex] ?? 0;
      const recipientSats = -netPolicy - fee;

      const result: PrepareSendResult = {
        pset: pset.toString(),
        fee,
        recipientSats,
      };
      return result;
    }

    case "signBroadcast": {
      const net = lwkNetwork(lwk, req.network);
      const signer = new lwk.Signer(new lwk.Mnemonic(req.mnemonic), net);
      const entry = ensureWollet(lwk, req.descriptor, req.network);
      const signed = entry.wollet.finalize(signer.sign(new lwk.Pset(req.pset)));
      const client = new lwk.EsploraClient(net, ESPLORA[req.network], false, 1, false);
      const txid = await client.broadcast(signed);
      const result: SendResult = { txid: txid.toString() };
      return result;
    }

    case "finalizeBroadcast": {
      // The PSET was already signed elsewhere (the Jade device). Finalize it with
      // the watch-only wollet (no seed needed) and broadcast.
      const net = lwkNetwork(lwk, req.network);
      const entry = ensureWollet(lwk, req.descriptor, req.network);
      const signed = entry.wollet.finalize(new lwk.Pset(req.pset));
      const client = new lwk.EsploraClient(net, ESPLORA[req.network], false, 1, false);
      const txid = await client.broadcast(signed);
      const result: SendResult = { txid: txid.toString() };
      return result;
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;
  handle(msg.req as EngineRequest)
    .then((value) => sendResponse({ ok: true, value }))
    .catch((err: unknown) => sendResponse({ ok: false, error: errMsg(err) }));
  return true; // async sendResponse
});

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
