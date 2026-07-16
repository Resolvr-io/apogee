// Page-context provider (MAIN world). Implements the `window.liquid` interface
// — EIP-1193 `request({ method, params })` + EIP-6963 discovery — described in
// the Liquid Provider spec (docs/liquid-provider-spec.md in the apogee repo),
// backed by Apogee. The page never receives keys: `liquid_requestAccounts`
// returns a watch-only account handle and all signing is delegated to the
// extension, which authenticates the sender and gates every approval.
//
// This is a thin facade: each `liquid_*` method maps to an internal provider
// method relayed over the same postMessage bridge to the content script, so the
// service-worker router, engine, and Jade signing path are unchanged.

import { LBTC_MAINNET_ASSET_ID, LBTC_TESTNET_ASSET_ID } from "@/lib/asset-registry";

type DappNetwork = "mainnet" | "testnet" | "regtest";
type LiquidNetwork = "liquid" | "liquid-testnet" | "liquid-regtest";

interface InternalAccount {
  network: DappNetwork;
  masterFingerprint: string;
  signerKind: "local" | "jade";
}

interface AssetBalance {
  assetId: string;
  value: number;
  ticker?: string;
  precision?: number;
}

type LiquidEvent = "connect" | "disconnect" | "accountsChanged" | "networkChanged";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

// EIP-1193 provider error.
class ProviderRpcError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "ProviderRpcError";
    this.code = code;
    this.data = data;
  }
}

// Approval-method ceilings. These are SAFETY NETS for a dead bridge/worker, not
// the real deadline: the extension expires an undecided approval after 4 min
// and an unfinished Jade signing after a further 6 min (see the background's
// APPROVAL_TTL_MS / JADE_SIGN_TTL_MS), rejecting this promise promptly. Each
// ceiling therefore sits ABOVE the extension's worst case, so the page can
// never time out while the extension would still sign + broadcast — the
// sign-after-timeout hazard.
const CONNECT_TIMEOUT_MS = 300_000; // > approval TTL (4 min)
const SEND_TIMEOUT_MS = 660_000; // > approval TTL + Jade signing TTL + broadcast slack
const SPEC_VERSION = "1.0.0";
const RDNS = "io.resolvr.apogee";
const ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%2303070f'/%3E%3Cpath d='M16 5l2.7 8.3L27 16l-8.3 2.7L16 27l-2.7-8.3L5 16l8.3-2.7z' fill='%234ea1ff'/%3E%3C/svg%3E";

(() => {
  const w = window as unknown as { liquid?: unknown };

  const pending = new Map<string, PendingRequest>();
  const handlers: Record<LiquidEvent, Set<(payload: unknown) => void>> = {
    connect: new Set(),
    disconnect: new Set(),
    accountsChanged: new Set(),
    networkChanged: new Set(),
  };
  let seq = 0;
  // The wallet's network, learned on connect/getAccount, used to label L-BTC.
  let cachedNetwork: LiquidNetwork | undefined;

  // Trust boundary: same-window postMessage hop. Any script in the page could
  // forge an `apogee-content` reply, but the service worker authenticates the
  // sender and gates all signing/authorization — a forged reply can only feed
  // the page bogus display data, never move funds (the authoritative UI is
  // Apogee's own approval screen).
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data as
      | { source?: string; id?: string; ok?: boolean; value?: unknown; error?: string }
      | undefined;
    if (!data || data.source !== "apogee-content" || typeof data.id !== "string") return;
    const req = pending.get(data.id);
    if (!req) return;
    pending.delete(data.id);
    if (data.ok) req.resolve(data.value);
    else req.reject(mapError(data.error ?? "Apogee request failed"));
  });

  // Map an internal bridge error string to an EIP-1193 ProviderRpcError. The
  // original message is preserved so consumers that string-match still work.
  function mapError(message: string): ProviderRpcError {
    // The extension was reloaded/updated and this page's bridge is orphaned — the
    // page must reload to get a working provider. 4900 = "provider disconnected".
    if (message.includes("PROVIDER_DISCONNECTED") || /context invalidated/i.test(message)) {
      return new ProviderRpcError(
        4900,
        "PROVIDER_DISCONNECTED: Apogee was reloaded or updated — reload this page to reconnect.",
      );
    }
    if (message.includes("NOT_CONNECTED")) return new ProviderRpcError(4100, message);
    if (/reject|declin|denied|cancel/i.test(message)) return new ProviderRpcError(4001, message);
    return new ProviderRpcError(-32603, message);
  }

  // Methods that wait on a user approval get a long timeout; reads should return
  // promptly, so a hung read (e.g. an orphaned bridge that never replies) surfaces
  // as PROVIDER_DISCONNECTED in seconds instead of blocking for minutes.
  const APPROVAL_METHODS = new Set(["connect", "send"]);
  function timeoutFor(method: string): number {
    if (method === "connect") return CONNECT_TIMEOUT_MS;
    if (method === "send") return SEND_TIMEOUT_MS;
    if (method === "getBalance") return 60_000; // includes a chain sync
    return 20_000; // fast reads
  }

  // Internal transport: relays one internal method to the content bridge.
  function call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = `apogee-${seq++}-${Date.now()}`;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      // "*" (not window.origin) so the hop still delivers in sandboxed/opaque-
      // origin frames; the content bridge gates inbound on event.source === window.
      window.postMessage({ source: "apogee-provider", id, method, params }, "*");
      setTimeout(() => {
        if (pending.delete(id)) {
          reject(
            APPROVAL_METHODS.has(method)
              ? new ProviderRpcError(-32603, "Apogee request timed out")
              : mapError("PROVIDER_DISCONNECTED"),
          );
        }
      }, timeoutFor(method));
    });
  }

  function toSpecNetwork(n: DappNetwork): LiquidNetwork {
    return n === "mainnet" ? "liquid" : n === "testnet" ? "liquid-testnet" : "liquid-regtest";
  }

  function lbtcId(net: LiquidNetwork | undefined): string | undefined {
    if (net === "liquid") return LBTC_MAINNET_ASSET_ID;
    if (net === "liquid-testnet") return LBTC_TESTNET_ASSET_ID;
    return undefined; // regtest policy asset is dynamic; leave L-BTC as a plain entry
  }

  // Public EIP-1193 dispatch.
  async function request<T = unknown>(args: { method: string; params?: unknown }): Promise<T> {
    if (!args || typeof args.method !== "string") {
      throw new ProviderRpcError(-32602, "Invalid request: `method` is required");
    }
    const params = (args.params ?? {}) as Record<string, unknown>;
    switch (args.method) {
      case "liquid_requestAccounts": {
        const acct = await call<InternalAccount>("connect");
        cachedNetwork = toSpecNetwork(acct.network);
        return [
          { id: acct.masterFingerprint, signerKind: acct.signerKind === "jade" ? "hardware" : "local" },
        ] as T;
      }
      case "liquid_accounts": {
        const acct = await call<InternalAccount | null>("getAccount");
        if (!acct) return [] as T;
        cachedNetwork = toSpecNetwork(acct.network);
        return [
          { id: acct.masterFingerprint, signerKind: acct.signerKind === "jade" ? "hardware" : "local" },
        ] as T;
      }
      case "liquid_getNetwork": {
        const acct = await call<InternalAccount | null>("getAccount");
        if (!acct) throw new ProviderRpcError(4100, "NOT_CONNECTED: authorize with liquid_requestAccounts first");
        cachedNetwork = toSpecNetwork(acct.network);
        return cachedNetwork as T;
      }
      case "liquid_getNewAddress": {
        const a = await call<{ index: number; address: string }>("getNewAddress");
        return { address: a.address } as T;
      }
      case "liquid_getBalance": {
        const b = await call<{ locked: boolean; lbtcSats: number | null; assets: Record<string, number> }>(
          "getBalance",
        );
        if (b.locked) throw new ProviderRpcError(4100, "Wallet is locked", { reason: "locked" });
        if (!cachedNetwork) {
          const acct = await call<InternalAccount | null>("getAccount");
          if (acct) cachedNetwork = toSpecNetwork(acct.network);
        }
        const lid = lbtcId(cachedNetwork);
        const out: AssetBalance[] = [];
        const seen = new Set<string>();
        for (const [assetId, value] of Object.entries(b.assets)) {
          const isLbtc = assetId === lid;
          out.push(isLbtc ? { assetId, value, ticker: "L-BTC", precision: 8 } : { assetId, value });
          seen.add(assetId);
        }
        if (lid && !seen.has(lid)) {
          out.push({ assetId: lid, value: b.lbtcSats ?? 0, ticker: "L-BTC", precision: 8 });
        }
        return out as T;
      }
      case "liquid_getAssetInfo": {
        const assetId = typeof params.assetId === "string" ? params.assetId : "";
        return (await call("getAssetInfo", { assetId })) as T;
      }
      case "liquid_getStatus": {
        return (await call("getStatus")) as T; // { locked }
      }
      case "liquid_sendTransaction": {
        const recipients = Array.isArray(params.recipients) ? params.recipients : [];
        if (recipients.length !== 1) {
          throw new ProviderRpcError(-32602, "liquid_sendTransaction currently supports exactly one recipient");
        }
        const r = recipients[0] as { address?: unknown; amount?: unknown };
        if (typeof r.address !== "string" || !Number.isSafeInteger(r.amount)) {
          throw new ProviderRpcError(-32602, "Invalid recipient: { address: string, amount: integer }");
        }
        const sendMax = params.sendMax === true;
        const res = await call<{ txid: string }>("send", {
          address: r.address,
          sats: r.amount as number,
          drain: sendMax,
        });
        return { txid: res.txid } as T;
      }
      case "liquid_getCapabilities": {
        return {
          specVersion: SPEC_VERSION,
          methods: [
            "liquid_requestAccounts",
            "liquid_accounts",
            "liquid_getNetwork",
            "liquid_getNewAddress",
            "liquid_getBalance",
            "liquid_getAssetInfo",
            "liquid_getStatus",
            "liquid_sendTransaction",
            "liquid_disconnect",
            "liquid_getCapabilities",
          ],
          features: { hardwareSigning: true, issuedAssets: true, confidential: true },
        } as T;
      }
      case "liquid_disconnect": {
        try {
          await call("disconnect");
        } catch {
          /* best-effort */
        }
        cachedNetwork = undefined;
        for (const set of Object.values(handlers)) set.clear();
        return undefined as T;
      }
      default:
        throw new ProviderRpcError(4200, `Unsupported method: ${args.method}`);
    }
  }

  const info = Object.freeze({ uuid: crypto.randomUUID(), name: "Apogee", icon: ICON, rdns: RDNS });

  const provider = {
    isLiquid: true as const,
    info,
    request,
    on: (event: LiquidEvent, listener: (payload: unknown) => void) => {
      handlers[event]?.add(listener);
    },
    removeListener: (event: LiquidEvent, listener: (payload: unknown) => void) => {
      handlers[event]?.delete(listener);
    },
  };

  // window.liquid convenience — don't clobber a provider that loaded first;
  // multi-wallet discovery is via EIP-6963 below.
  if (!w.liquid) {
    Object.defineProperty(window, "liquid", { value: provider, writable: false, configurable: true });
  }

  // EIP-6963 announcement — the collision-free discovery path.
  function announce(): void {
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }),
    );
  }
  window.addEventListener("eip6963:requestProvider", announce);
  announce();

  console.debug("[apogee] window.liquid ready");
})();
