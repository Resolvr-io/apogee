// SideSwap JSON-RPC WebSocket client (Track 1 transport).
//
// docs: sideswap.io/docs — JSON-RPC 2.0 over WebSocket, no batch requests.
// Every swap action is a single `"market"` method with the action named inside
// `params` (e.g. `{"method":"market","params":{"list_markets":{}}}`), and the
// response mirrors it (`result: {"list_markets": {...}}`). After `start_quotes`
// the server pushes async `{"method":"market","params":{"quote":{...}}}`
// notifications carrying the dealer's quotes.
//
// Types are **wire types** — snake_case to mirror the API exactly so they're
// easy to audit against the docs. Amounts are `number` (SideSwap's wire form),
// which is exact up to 2^53 (~90M USDt at 8 decimals / ~90M L-BTC) — covers
// retail sizes; the verification gate downstream uses BigInt for the exact
// PSET-derived comparison. Hardening to BigInt-end-to-end is a later task if
// whale-sized swaps matter.
//
// Host-agnostic: the WebSocket runs wherever this is imported. For a near-instant
// swap (quote → sign → broadcast in seconds) the service worker or offscreen
// document both suffice; the hosting decision is made when the flow is wired.

import type { LiquidNetwork } from "@/keystore/keystore";

const ENDPOINTS: Record<LiquidNetwork, string> = {
  liquid: "wss://api.sideswap.io/json-rpc-ws",
  liquidtestnet: "wss://api-testnet.sideswap.io/json-rpc-ws",
  // SideSwap has no regtest endpoint; regtest is dev-only so a swap there would
  // never be real — fall back to the testnet server rather than fail to construct.
  regtest: "wss://api-testnet.sideswap.io/json-rpc-ws",
};

// Default per-request timeout: a hung SideSwap call must not block the swap, and
// quotes carry their own (shorter) ttl anyway.
const REQUEST_TIMEOUT_MS = 15_000;

export type SideSwapAssetType = "Base" | "Quote";
export type SideSwapTradeDir = "Sell" | "Buy";

export interface SideSwapAssetPair {
  base: string; // asset id hex
  quote: string; // asset id hex
}

export interface SideSwapMarket {
  asset_pair: SideSwapAssetPair;
  fee_asset: SideSwapAssetType;
  type?: string;
}

/** A wallet UTXO with its unblinding data, as `start_quotes` requires. The
 *  blinding factors (`asset_bf`, `value_bf`) come from `WolletTxOut.unblinded()`
 *  in the offscreen engine. */
export interface SideSwapUtxo {
  txid: string;
  vout: number;
  asset: string;
  asset_bf: string;
  value: number;
  value_bf: string;
  redeem_script: string | null;
}

export interface SideSwapStartQuotesReq {
  asset_pair: SideSwapAssetPair;
  asset_type: SideSwapAssetType;
  amount: number;
  trade_dir: SideSwapTradeDir;
  utxos: SideSwapUtxo[];
  receive_address: string;
  change_address: string;
}

export interface SideSwapQuoteSuccess {
  base_amount: number;
  quote_amount: number;
  fixed_fee: number;
  server_fee: number;
  quote_id: number;
  ttl: number; // ms the quote can be accepted
}

export interface SideSwapQuoteLowBalance {
  available: number;
  base_amount: number;
  fixed_fee: number;
  quote_amount: number;
  server_fee: number;
}

// The dealer's quote is one of these states (the server tags the `status` object
// with the variant name as the key).
export type SideSwapQuoteStatus =
  | { Success: SideSwapQuoteSuccess }
  | { LowBalance: SideSwapQuoteLowBalance }
  | { Error: { error_msg: string } };

export interface SideSwapQuoteNotification {
  amount: number;
  asset_pair: SideSwapAssetPair;
  asset_type: SideSwapAssetType;
  quote_sub_id: number;
  status: SideSwapQuoteStatus;
  trade_dir: SideSwapTradeDir;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SideSwapClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private quoteHandler: ((quote: SideSwapQuoteNotification) => void) | null = null;

  constructor(private readonly network: LiquidNetwork) {}

  /** Register the receiver for async `quote` notifications (after start_quotes). */
  onQuote(handler: (quote: SideSwapQuoteNotification) => void): void {
    this.quoteHandler = handler;
  }

  /** Open the WebSocket. Resolves once connected; rejects on error. */
  connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    const ws = new WebSocket(ENDPOINTS[this.network]);
    this.ws = ws;
    ws.onmessage = (ev) => this.handleMessage(ev.data as string);
    ws.onclose = () => this.failAll(new Error("SideSwap WebSocket closed"));
    return new Promise<void>((resolve, reject) => {
      ws.onerror = () => reject(new Error("SideSwap WebSocket connection failed"));
      ws.onopen = () => resolve();
    });
  }

  /** Close the connection and fail any in-flight requests. Safe to call repeatedly. */
  disconnect(): void {
    this.failAll(new Error("SideSwap client disconnected"));
    this.ws?.close();
    this.ws = null;
  }

  /** Whether the underlying socket is open. */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async listMarkets(): Promise<{ markets: SideSwapMarket[] }> {
    return this.call("list_markets", {});
  }

  async startQuotes(req: SideSwapStartQuotesReq): Promise<{ fee_asset: SideSwapAssetType; quote_sub_id: number }> {
    return this.call("start_quotes", req);
  }

  /** Fetch the dealer-built unsigned PSET for an accepted quote. */
  async getQuote(quoteId: number): Promise<{ pset: string; ttl: number }> {
    return this.call("get_quote", { quote_id: quoteId });
  }

  /** Submit the signed PSET; the server broadcasts and returns the swap txid. */
  async takerSign(quoteId: number, pset: string): Promise<{ txid: string }> {
    return this.call("taker_sign", { quote_id: quoteId, pset });
  }

  // ---- internals -----------------------------------------------------------

  /** Send a `market` action and await its result, unwrapping the action key. */
  private call<T>(action: string, params: object): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("SideSwap client not connected"));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method: "market", params: { [action]: params } });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`SideSwap '${action}' timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      ws.send(payload);
    });
  }

  private handleMessage(data: string): void {
    let msg: { id?: number; method?: string; result?: Record<string, unknown>; error?: { message?: string } };
    try {
      msg = JSON.parse(data);
    } catch {
      return; // ignore malformed frames
    }

    // Response to a request we sent (has our id).
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new Error(msg.error.message ?? "SideSwap error"));
      } else {
        // result is `{ <action>: <output> }` — unwrap by the single key present.
        const out = msg.result ? Object.values(msg.result)[0] : undefined;
        pending.resolve(out);
      }
      return;
    }

    // Async notification: a quote pushed after start_quotes.
    if (msg.method === "market") {
      const params = (msg as { params?: { quote?: SideSwapQuoteNotification } }).params;
      if (params?.quote) this.quoteHandler?.(params.quote);
    }
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
