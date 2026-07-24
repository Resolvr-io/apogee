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
// Apogee badge (circular gradient + white star) for EIP-6963 discovery —
// extracted from public/icons/apogee-logo.svg (the clipped <g> alone).
const ICON =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http://www.w3.org/2000/svg%22%20viewBox%3D%220%200%20424%20424%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22paint0_linear_807_56%22%20x1%3D%22212%22%20y1%3D%220%22%20x2%3D%22212%22%20y2%3D%22424%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%3Cstop%20stop-color%3D%22%230E2C52%22/%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%2303060C%22/%3E%3C/linearGradient%3E%3CclipPath%20id%3D%22clip0_807_56%22%3E%3Crect%20width%3D%22424%22%20height%3D%22424%22%20fill%3D%22white%22/%3E%3C/clipPath%3E%3C/defs%3E%3Cg%20clip-path%3D%22url(%23clip0_807_56)%22%3E%3Cpath%20d%3D%22M212%20424C329.084%20424%20424%20329.084%20424%20212C424%2094.9156%20329.084%200%20212%200C94.9156%200%200%2094.9156%200%20212C0%20329.084%2094.9156%20424%20212%20424Z%22%20fill%3D%22url(%23paint0_linear_807_56)%22/%3E%3Cpath%20d%3D%22M284.276%20107.841C253.257%20107.841%20228.058%2082.6674%20228.058%2051.748C228.058%2042.9312%20220.837%2035.7259%20212%2035.7259C203.164%2035.7259%20195.942%2042.9312%20195.942%2051.748C195.942%2082.6981%20170.713%20107.841%20139.725%20107.841C130.888%20107.841%20123.667%20115.046%20123.667%20123.863C123.667%20132.68%20130.888%20139.885%20139.725%20139.885C170.743%20139.885%20195.942%20165.058%20195.942%20195.978C195.942%20204.795%20203.164%20212%20212%20212C220.837%20212%20228.058%20204.795%20228.058%20195.978C228.058%20165.028%20253.287%20139.885%20284.276%20139.885C293.112%20139.885%20300.333%20132.68%20300.333%20123.863C300.333%20115.046%20293.112%20107.841%20284.276%20107.841Z%22%20fill%3D%22white%22/%3E%3C/g%3E%3C/svg%3E";

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
  // The wallet's network, learned on connect/getAccount, used to label LBTC.
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
  const APPROVAL_METHODS = new Set(["connect", "send", "runManifest"]);
  function timeoutFor(method: string): number {
    if (method === "connect") return CONNECT_TIMEOUT_MS;
    // runManifest reuses the send ceiling: it also builds ahead of the approval,
    // and the inequality that matters (page ceiling > extension worst case) holds
    // for both. See the SEND_TIMEOUT_MS note above.
    if (method === "send" || method === "runManifest") return SEND_TIMEOUT_MS;
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
    return undefined; // regtest policy asset is dynamic; leave LBTC as a plain entry
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
          out.push(isLbtc ? { assetId, value, ticker: "LBTC", precision: 8 } : { assetId, value });
          seen.add(assetId);
        }
        if (lid && !seen.has(lid)) {
          out.push({ assetId: lid, value: b.lbtcSats ?? 0, ticker: "LBTC", precision: 8 });
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
      case "liquid_runManifest": {
        // Everything crosses as TEXT: the site already has the manifest string
        // from `fetch().then(r => r.text())`, u64 amounts would lose precision
        // through JSON.parse, and hashing the literal bytes is what a publisher
        // signature will later be checkable against. Validate shape only — the
        // extension re-validates and is the actual gate.
        const action = params.action;
        const manifest = params.manifest;
        if (typeof action !== "string" || !action) {
          throw new ProviderRpcError(-32602, "liquid_runManifest requires `action` (string)");
        }
        if (typeof manifest !== "string" || !manifest) {
          throw new ProviderRpcError(
            -32602,
            "liquid_runManifest requires `manifest` as raw JSON text, not an object",
          );
        }
        // A browser wallet has no filesystem, so the manifest's `source` paths
        // (e.g. "./last_will.simf") are unresolvable — the caller must ship the
        // program text alongside. Without it we cannot derive covenant addresses,
        // and deriving them is the whole point.
        const sources = params.sources;
        if (!sources || typeof sources !== "object" || Array.isArray(sources)) {
          throw new ProviderRpcError(
            -32602,
            "liquid_runManifest requires `sources`: { './prog.simf': '<source text>' }",
          );
        }
        return (await call<unknown>("runManifest", {
          action,
          manifest,
          sources,
          instance: params.instance,
          providedInputs: params.providedInputs,
          actionParams: params.actionParams,
        })) as T;
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
            "liquid_runManifest",
          ],
          features: { hardwareSigning: true, issuedAssets: true, confidential: true },
          // The spec requires rejecting a manifest that uses an extension we
          // don't implement, so a site needs to know BEFORE it renders a button.
          txmanifest: {
            manifestVersion: "0.1.0",
            extensions: ["contract_templates"],
            // Deliberately NOT implemented yet — listed so the omission is
            // legible rather than something a site discovers by failing.
            unsupported: ["hooks", "validations", "issuance", "op_return", "state_files"],
            // No manifest signature/authority scheme exists yet; every run is
            // reviewed as "unverified".
            authenticity: "unverified",
            // A manifest run signs locally: a Jade renders its own summary and
            // cannot meaningfully display a Simplicity covenant spend.
            hardwareSigning: false,
          },
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
