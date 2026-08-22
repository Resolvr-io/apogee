// Service worker — the extension backend. It:
//  - wires the toolbar action to open the side panel,
//  - hosts the keystore (the seed-of-record; see src/keystore),
//  - manages the offscreen engine document's lifecycle, and
//  - routes wallet requests from the side panel / prompt, brokering each one
//    between the keystore (secrets) and the offscreen engine (lwk_wasm).
//
// Auto-lock alarms and provider/prompt orchestration land in later tasks.

// Vite's dynamic-import preload helper references `window.dispatchEvent()` in
// its error path. The MV3 service worker has no `window` global — only `self` —
// so a failed dynamic import crashes with "window is not defined" before the
// real error surfaces. Alias `window` to `self` to let the helper run (the
// preloadError event is a no-op here; the throw still propagates).
if (typeof window === "undefined") {
  (self as unknown as { window: typeof self }).window = self;
}

import type { LiquidNetwork } from "@/keystore/keystore";
import * as keystore from "@/keystore/keystore";
import { DEBUG_ENTERPRISE_BUILD, DEBUG_ENTERPRISE_KEY, ENTERPRISE_ROOTS } from "@/lib/debug";
import { KNOWN_ASSETS } from "@/lib/asset-registry";
import { shortenHex } from "@/lib/utils";
import { SCAN_STATE_DB } from "@/engine/protocol";
import { providerPsetReviewsMatch } from "@/engine/provider-pset-review";
import { claimSecret, type ParkedSecret } from "@/lib/qr-secret";
import { clearAssetIconCache } from "@/lib/asset-icons";
import { evaluateUpdate } from "@/lib/version-check";
import { APP_VERSION } from "@/version";
import { txManifestExpectedGenesisHash } from "@/tx-manifest/network";
import { browser } from "@/lib/ext";
// Static imports — dynamic import() is disallowed in the MV3 service worker
// global scope per the HTML spec (Chrome blocks it at runtime).
import { SideSwapClient } from "@/sideswap/client";
import {
  executeInstantSwap,
  previewSwapQuote,
  SwapError,
  SwapLowBalanceError,
} from "@/sideswap/orchestrator";
import { LOW_BALANCE_PREFIX, SWAP_MAX_FEE_SATS } from "@/sideswap/constants";
import type {
  AddressDTO,
  ApprovalRequest,
  AssetInfo,
  ChainServerHealth,
  CreatedWallet,
  DappNetwork,
  DerivedWallet,
  DescriptorInfo,
  EngineRequest,
  EnginePortReply,
  PrepareSendResult,
  PriceHistory,
  ProviderPsetAnalysisDTO,
  ProviderPsetAnalysisResultDTO,
  ProviderPsetApprovalReviewDTO,
  ProviderPsetSignInputDTO,
  ProviderPsetSignResultDTO,
  ProviderUtxoDTO,
  PublicWalletDescriptorDTO,
  ProviderAccount,
  ProviderBalance,
  ProviderRequest,
  ProviderStatus,
  SwapResultDTO,
  SwapQuotePreview,
  SendResult,
  SendReview,
  SyncResult,
  UiRequest,
  TxManifestApprovalReviewDTO,
  TxManifestAssetMeta,
  WalletRequest,
  WalletIdentity,
  WalletTxDTO,
  WalletUtxoDTO,
} from "@/engine/protocol";
import {
  LIQUID_BROWSER_PROVIDER_METHODS,
  LIQUID_BROWSER_PROVIDER_VERSION,
  LIQUID_CONNECTION_CHANGED_EVENT,
  type LiquidConnection,
  type LiquidConnectParams,
} from "@/provider/liquid-browser-provider";
import { parseLiquidProviderRequest } from "@/provider/liquid-browser-provider-validation";
import {
  LIQUID_DESCRIPTOR_FORMATS,
  LIQUID_DESCRIPTOR_TYPES,
  LIQUID_WALLET_DESCRIPTOR_CHANGED_EVENT,
  LIQUID_WALLET_RPC_METHODS,
  type LiquidGetUTXOsResult,
  type LiquidGetWalletDescriptorResult,
  type LiquidExecuteTxManifestParams,
  type LiquidExecuteTxManifestResult,
  type LiquidSignPsetResult,
} from "@/provider/liquid-rpc";
import {
  LIQUID_RPC_ERROR_CODES,
  LIQUID_RPC_ERROR_REASONS,
  LiquidRpcError,
  serializeLiquidRpcError,
} from "@/provider/liquid-rpc-errors";
import { finalizeAndBroadcastProviderPset } from "@/provider/liquid-provider-pset-broadcast";
import { withAuthorizedProviderTxManifestExecution } from "@/provider/liquid-provider-tx-manifest-authorization";
import {
  SIMPLICITY_LENDING_V3_ACCEPT_OFFER,
  SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT,
} from "@/tx-manifest/builtins/simplicity-lending-v3";
import { taggedCanonicalJsonHash } from "@/tx-manifest/bundle";
import type {
  AcceptOfferRequirementPlan,
  ClaimLenderVaultRequirementPlan,
  CreateFactoryRequirementPlan,
  CreateOfferRequirementPlan,
  CancelOfferRequirementPlan,
  ClaimPrincipalRequirementPlan,
  LiquidateOfferRequirementPlan,
  RepayLoanRequirementPlan,
  TxManifestRequirementPlan,
} from "@/tx-manifest/requirements";
import type {
  HostedPreparedAcceptOfferExecution,
  HostedPreparedClaimLenderVaultExecution,
  HostedPreparedNewLendingExecution,
} from "@/tx-manifest/wallet-host";
import type { TxManifestTransactionOutputInspection } from "@/tx-manifest/runtime";
import {
  resolveAcceptOfferChainSnapshot,
  resolveClaimLenderVaultChainSnapshot,
  resolveNewLendingActionChainSnapshot,
} from "@/tx-manifest/esplora";
import {
  migrateStoredTxManifestRecords,
  TxManifestIdempotency,
  txManifestIdempotencyKey,
  type TxManifestCheckpointRecord,
  type TxManifestExecutionGeneration,
  type TxManifestExecutionRecord,
} from "@/tx-manifest/idempotency";
import {
  isKnownTxManifestBroadcastError,
  isPermanentTxManifestBroadcastError,
  lookupTxManifestTransaction,
  parseTxManifestCheckpointPayload,
  txManifestCheckpointContext,
  type TxManifestCheckpointPayload,
} from "@/tx-manifest/broadcast-checkpoint";

// This extension's own origin. Privileged wallet/* and apogee/* messages are
// only honored when they come from one of our own pages (side panel, approval
// prompt, Jade tab) — see the onMessage router. A content script injected into a
// web page carries the page's origin, so this cleanly excludes web pages.
// Derived from getURL rather than hardcoded, so it always matches the running
// extension's own origin.
const EXT_ORIGIN = new URL(browser.runtime.getURL("/")).origin;

// Install/update teardown of the stale offscreen document. Tracked as a promise so
// `ensureOffscreen` can await it: fire-and-forget raced the side panel's startup
// sync — `ensureOffscreen` saw the OLD document as alive and returned early, then
// this teardown closed it out from under the in-flight message, surfacing as
// "engine error" on the first load after an install or update.
let teardown: Promise<void> | null = null;
browser.runtime.onInstalled.addListener(() => {
  console.log("[apogee] installed");
  // On reload/update, drop any persisted offscreen document so the next engine
  // call rebuilds it from the new code. Without this, a surviving offscreen keeps
  // running stale engine logic after a reload (a known MV3 quirk).
  teardown = closeOffscreen().finally(() => {
    teardown = null;
  });
});

// Open the side panel when the toolbar icon is clicked.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("[apogee] setPanelBehavior", err));

// ---- idle auto-lock -------------------------------------------------------

const AUTOLOCK_ALARM = "apogee-autolock";
const AUTOLOCK_KEY = "apogee:autolock";
const DEFAULT_AUTOLOCK_MINUTES = 15;

async function autoLockMinutes(): Promise<number> {
  const v = (await browser.storage.local.get(AUTOLOCK_KEY))[AUTOLOCK_KEY];
  return typeof v === "number" ? v : DEFAULT_AUTOLOCK_MINUTES;
}

// Last time the idle window was reset (unlock / genuine user activity). The alarm
// is coarse and can fire early, so on fire we re-check elapsed against this and
// re-arm for the remainder instead of trusting the alarm's timing.
let lastActivityAt = 0;

/** Clear + (re)create the alarm for the given delay (minutes). No-op while the
 *  wallet is locked or when the delay is non-positive ("never"). */
async function armAutoLock(delayMinutes: number): Promise<void> {
  await browser.alarms.clear(AUTOLOCK_ALARM);
  if (delayMinutes > 0 && !keystore.isLocked()) {
    await browser.alarms.create(AUTOLOCK_ALARM, { delayInMinutes: delayMinutes });
  }
}

/** Reset the idle window to now and arm the alarm for the full timeout. Called
 *  only after a genuine user action (see AUTOLOCK_DEFERRING + wallet/touch) so
 *  the side panel's periodic balance poll can't keep an unattended wallet open. */
async function rescheduleAutoLock(): Promise<void> {
  const minutes = await autoLockMinutes();
  if (minutes <= 0) {
    await browser.alarms.clear(AUTOLOCK_ALARM);
    return;
  }
  lastActivityAt = Date.now();
  await armAutoLock(minutes);
}

// ---- auto-lock "never" step-up ----------------------------------------------
//
// With auto-lock "never", the unlocked session (and its storage.session key
// cache) lives until the browser exits — closing the panel restricts nothing. So
// each NEW panel session must re-verify the password before the wallet UI is
// shown. The panel mints a random id at document load; this record remembers the
// last one seen and whether it still owes a step-up. Kept in storage.session
// (not SW memory) so an SW eviction doesn't re-prompt the same open panel, and
// with the same lifetime as the unlocked session it guards: gone at browser exit.
const PANEL_STEPUP_KEY = "apogee:panelStepUp";
// session id → still owes a step-up. A MAP, not a single slot: the side panel is
// per-window, so two open windows are two documents with two session ids, and a
// single record would have them overwrite each other and ping-pong between
// step-up prompts forever. Bounded so long-lived sessions can't accumulate.
const PANEL_STEPUP_MAX = 16;
async function panelStepUpState(): Promise<Record<string, boolean>> {
  const v = (await browser.storage.session.get(PANEL_STEPUP_KEY))[PANEL_STEPUP_KEY];
  return v && typeof v === "object" ? (v as Record<string, boolean>) : {};
}
async function savePanelStepUp(map: Record<string, boolean>): Promise<void> {
  // Prune to the most recent MAX entries (object key order = insertion order).
  const entries = Object.entries(map);
  const bounded = Object.fromEntries(entries.slice(-PANEL_STEPUP_MAX));
  await browser.storage.session.set({ [PANEL_STEPUP_KEY]: bounded });
}
async function setPanelStepUp(session: string, pending: boolean): Promise<void> {
  const map = await panelStepUpState();
  delete map[session]; // re-insert so the entry moves to the back (LRU order)
  map[session] = pending;
  await savePanelStepUp(map);
}

// Pin storage.session to trusted contexts — the default, and the only level this
// design tolerates: extension pages and the SW only, never content scripts or
// web pages, which is what keeps the session key cache unreadable outside the
// extension. Stated explicitly so widening it later is a deliberate, visible
// edit. Firefox has no setAccessLevel; its storage.session is extension-only by
// construction.
if (typeof browser.storage.session?.setAccessLevel === "function") {
  // Loud on failure: a silently widened access level is exactly what the
  // comment above says this must never become.
  browser.storage.session
    .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    .catch((err: unknown) => console.error("[apogee] storage.session.setAccessLevel failed", err));
}

// wallet/* messages that count as genuine user activity and so defer the idle
// auto-lock. Passive/polled reads (getState, sync, getTransactions, getBalance,
// getRate, getAsset, qr, getConnectedSites, getAutoLock) are intentionally
// excluded — otherwise the side panel's 20s balance poll would re-arm the alarm
// forever and an unattended wallet would never idle-lock while the panel is open.
// Allowlist, so any type not listed fails secure (does not defer the lock).
const AUTOLOCK_DEFERRING = new Set<UiRequest["type"]>([
  "wallet/unlock",
  "wallet/create",
  "wallet/restore",
  "wallet/addHardwareWallet",
  "wallet/addWatchOnlyWallet",
  "wallet/prepareSend",
  "wallet/send",
  "wallet/swap",
  "wallet/swapQuote",
  "wallet/revealMnemonic",
  "wallet/verifyPassword",
  "wallet/stepUp",
  "wallet/setAutoLock",
  "wallet/setChainServer",
  "wallet/getAddress",
  "wallet/disconnectSite",
  "wallet/openGuide",
  "wallet/checkUpdate",
  "wallet/touch",
]);

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== AUTOLOCK_ALARM) return;
  const minutes = await autoLockMinutes();
  // The alarm is coarse and may fire early — only lock once the idle window has
  // truly elapsed since the last activity; otherwise re-arm for the remainder.
  const remainingMs = minutes * 60_000 - (Date.now() - lastActivityAt);
  if (remainingMs > 0) {
    await armAutoLock(remainingMs / 60_000);
    return;
  }
  clearQrSecret(); // don't let a parked phrase survive an idle lock
  void keystore.lock().then(() => {
    // Drop the side panel to the lock screen (ignored if none is open).
    browser.runtime.sendMessage({ type: "apogee/locked" }).catch(() => {});
  });
});

// The guide tab we opened, so re-clicking Help focuses it instead of opening a
// second copy. Lost on service-worker eviction, which just means the next click
// opens a fresh tab — acceptable, and cheaper than holding the `tabs` permission.
const GUIDE_URL = "src/guide/guide.html";
// Latest published release. Public endpoint, no auth — the repo is public, and an
// unauthenticated caller gets 60 requests/hour per IP, far above what a manual
// click can reach.
const UPDATE_FEED_URL = "https://api.github.com/repos/Resolvr-io/apogee/releases/latest";
let guideTabId: number | null = null;

// ---- scanned seed phrase: one-shot hand-off ---------------------------------
//
// A seed phrase scanned by the QR window is parked HERE rather than broadcast.
// `runtime.sendMessage` with no target fans out to every extension context, so a
// broadcast phrase would be readable by any page that happens to be listening —
// today only our own, but a seed shouldn't depend on that. The panel claims it
// exactly once with `apogee/qr-secret-claim`.
//
// Deliberately module-level (in memory) and never persisted: writing it to
// storage.session/local would leave the phrase recoverable from disk or survive a
// crash, which is precisely what we're avoiding.
//
// Expires quickly. If the panel never claims it (window closed, user walked away)
// the phrase must not sit in SW memory indefinitely. The read-and-clear semantics
// (single-use, time-boxed) live in `lib/qr-secret.ts` so they're unit-testable —
// this module registers listeners at import and can't load under Node.
// See docs/seed-qr-import.md for the full threat model.
let qrSecret: ParkedSecret | null = null;

/** Wipe the parked phrase. Called after a claim, on expiry, and on lock/reset. */
function clearQrSecret(): void {
  qrSecret = null;
}

// ---- chain-server override ---------------------------------------------------

// Per-network Esplora override ("Chain server" in Settings > Advanced). Empty/
// absent = automatic (waterfalls + fallbacks). Validated by the checkEsplora
// engine op before persisting, threaded into every scan and broadcast.
const CHAINSERVER_KEY = "apogee:chainserver";

async function chainServer(network: LiquidNetwork): Promise<string | undefined> {
  // Debug builds: the Settings > Debug toggle pins the authenticated enterprise
  // endpoint through this same override channel (see lib/debug.ts). Checked
  // first so it outranks the visible Chain server picker while enabled.
  if (DEBUG_ENTERPRISE_BUILD) {
    const dbg = (await browser.storage.local.get(DEBUG_ENTERPRISE_KEY))[DEBUG_ENTERPRISE_KEY];
    if (dbg === true) return ENTERPRISE_ROOTS[network] ?? undefined;
  }
  const v = (await browser.storage.local.get(CHAINSERVER_KEY))[CHAINSERVER_KEY];
  const url = v && typeof v === "object" ? (v as Record<string, unknown>)[network] : undefined;
  return typeof url === "string" && url !== "" ? url : undefined;
}

// ---- offscreen engine lifecycle --------------------------------------------

const OFFSCREEN_URL = "src/offscreen/offscreen.html";
let creating: Promise<void> | null = null;

// Bounded wait for the offscreen port to come up (see runEngine). Generous enough
// to cover module evaluation on a cold, throttled profile plus one reconnect
// cadence tick (see offscreen.ts), short enough that a genuinely dead document
// surfaces an error instead of hanging the UI: 8 × 150ms ≈ 1.2s worst case. wasm
// loads lazily inside `handle`, so this waits only on the channel, not on lwk.
const ENGINE_READY_RETRIES = 8;
const ENGINE_READY_RETRY_MS = 150;

async function ensureOffscreen(): Promise<void> {
  // Let an install/update teardown finish first, so we don't observe the doomed
  // document as "existing" and hand a message to something about to close.
  if (teardown) await teardown.catch(() => {});
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [browser.runtime.getURL(OFFSCREEN_URL)],
  });
  if (existing.length > 0) return;
  // Guard against concurrent createDocument calls (it throws if one exists).
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: "Run the lwk_wasm Liquid wallet engine (wasm + Esplora).",
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

/** Drop the offscreen document if one exists, so it's rebuilt fresh next call. */
async function closeOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [browser.runtime.getURL(OFFSCREEN_URL)],
  });
  if (existing.length > 0) await chrome.offscreen.closeDocument().catch(() => {});
}

// ---- SW ↔ offscreen engine port ---------------------------------------------
//
// Engine requests carry the unlocked mnemonic (sign/derive/restore), so they must
// NEVER ride `runtime.sendMessage`: an untargeted send fans out to every
// extension context — side panel, prompt, Jade signing tab — so any stray
// listener or page XSS would receive signing material on every send. The offscreen
// document instead opens a dedicated runtime.connect port to this worker, and
// `runEngine` posts id-matched request/reply frames over it. Only the two
// connected ends ever see a frame. (The request the SW itself sources is already
// point-to-point; this closes the wire in the other direction too — restore,
// below, keeps the panel→SW leg off the broadcast channel the same way.)

const ENGINE_PORT_NAME = "apogee-engine";
// Channel for UI-originated secret-bearing messages (restore mnemonic, scanned
// seed phrase). Not a wallet/* catch-all — only the two types that must never be
// broadcast are accepted on it.
const SECRET_PORT_NAME = "apogee-secret";
// One engine-port connection: the port plus ITS in-flight requests. In-flight
// state is per-connection, not module-global — a superseded port's disconnect
// (delivered asynchronously, possibly after a newer offscreen document already
// reconnected) must settle only that port's own requests, never the live
// connection's.
interface EngineConn {
  port: chrome.runtime.Port;
  inFlight: Map<number, (reply: EnginePortReply) => void>;
}
let engineConn: EngineConn | null = null;
let enginePortSeq = 0;
const enginePortWaiters: (() => void)[] = [];

/** Thrown when the port vanished between waitForEnginePort and the post. */
class EnginePortGoneError extends Error {}

/** Post one request on the engine port and await its id-matched reply. If the
 *  port dies before the reply, the disconnect handler settles with an error —
 *  the request may or may not have run, so the caller treats that as a hard
 *  failure, never a retry. */
function postEngine(req: EngineRequest): Promise<EnginePortReply> {
  const conn = engineConn;
  if (!conn) throw new EnginePortGoneError("engine port is not connected");
  const id = ++enginePortSeq;
  return new Promise<EnginePortReply>((resolve, reject) => {
    conn.inFlight.set(id, resolve);
    try {
      conn.port.postMessage({ id, req });
    } catch (e) {
      conn.inFlight.delete(id);
      reject(e);
    }
  });
}

/** Wait briefly for the offscreen document to connect its port. */
function waitForEnginePort(ms: number): Promise<EngineConn | null> {
  if (engineConn) return Promise.resolve(engineConn);
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      const i = enginePortWaiters.indexOf(wake);
      if (i >= 0) enginePortWaiters.splice(i, 1);
      resolve(engineConn);
    }, ms);
    const wake = () => {
      clearTimeout(t);
      const i = enginePortWaiters.indexOf(wake);
      if (i >= 0) enginePortWaiters.splice(i, 1);
      resolve(engineConn);
    };
    enginePortWaiters.push(wake);
  });
}

/** Send a request to the offscreen engine and unwrap its reply. */
// Serialize engine calls. lwk_wasm objects (Wollet/Signer) can't be used
// re-entrantly: two overlapping fullScan/applyUpdate calls on the same cached
// Wollet panic with "recursive use of an object … unsafe aliasing in rust".
// With a second caller now in play (the dapp provider alongside the side panel),
// a chain ensures only one engine op runs at a time.
let engineQueue: Promise<unknown> = Promise.resolve();

// One engine round-trip. The wasm engine lives in the offscreen document, driven
// over the engine port — the MV3 service worker is ephemeral and CSP-restricted,
// so it can't host wasm itself.
async function runEngine<T>(req: EngineRequest): Promise<T> {
  await ensureOffscreen();
  // The document exists before offscreen.ts has evaluated and connected its port —
  // and after an SW eviction the old port is gone until the document's reconnect
  // timer fires. Retry on "no port yet" only; a reply carrying `ok: false` is a
  // real engine failure and is NOT retried — re-running a genuine error would just
  // double the work and hide the cause.
  for (let attempt = 0; ; attempt++) {
    const port = await waitForEnginePort(ENGINE_READY_RETRY_MS);
    if (port) {
      try {
        const reply = await postEngine(req);
        if (!reply?.ok) throw new Error(reply?.error ?? "engine error");
        return reply.value as T;
      } catch (e) {
        // The port vanished between the wait and the post. Nothing was sent,
        // so the request definitively did not run — unlike a mid-flight
        // disconnect, retrying here is safe (and better than surfacing an
        // internal error for a race the next attempt resolves).
        if (e instanceof EnginePortGoneError) continue;
        throw e;
      }
    }
    if (attempt >= ENGINE_READY_RETRIES) {
      throw new Error("The wallet engine did not start. Reopen Apogee to try again.");
    }
    await ensureOffscreen(); // recreate if the document died rather than lagged
  }
}

/** One engine round-trip, outside the serial queue. Only for ops that touch no
 *  Wollet (getRate, qr) — those can't hit the re-entrancy panic, and keeping
 *  them out of the queue means a slow price source can't stall a sync (or
 *  anything queued behind one). */
async function engineDirect<T>(req: EngineRequest): Promise<T> {
  return runEngine<T>(req);
}

async function engine<T>(req: EngineRequest): Promise<T> {
  const run = engineQueue.then(() => runEngine<T>(req));
  // Keep the chain alive even if this call rejects, so one failure doesn't wedge
  // the queue.
  engineQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Queue an engine request behind a final service-worker-side gate. The gate
 * runs only once the request reaches the head of the serialized engine queue,
 * so a provider authorization check cannot go stale while an unrelated scan is
 * still ahead of an irreversible broadcast. */
async function engineAfterGate<T>(
  req: EngineRequest,
  gate: () => Promise<void>,
): Promise<T> {
  const run = engineQueue.then(async () => {
    await gate();
    return runEngine<T>(req);
  });
  engineQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---- wallet operations (keystore + engine) ---------------------------------

/** Resolve a wallet record (defaults to the active wallet). */
/** Re-throw a swap failure across the SW→UI boundary.
 *
 *  Only `err.message` survives that hop (the router serializes with `errMsg`),
 *  so a `SwapLowBalanceError`'s `available` field would be lost. Fold it into the
 *  message behind `LOW_BALANCE_PREFIX` (see sideswap/constants.ts), which the side
 *  panel parses back out — that's what lets the UI say how much the dealer CAN
 *  fill instead of a bare "not enough balance". The marker is emitted ONLY here,
 *  so the panel's anchored parse can't be spoofed by dealer-supplied text. */
function rethrowSwapError(e: unknown): never {
  if (e instanceof SwapLowBalanceError) {
    // Marker-prefixed and nothing else, so the panel's anchored parse can trust
    // it. A dealer's own text always arrives as `dealer error: <error_msg>`, so
    // it can never occupy position 0 and fake a LowBalance refusal.
    throw new SwapError(`${LOW_BALANCE_PREFIX}${e.available.toString()}`);
  }
  if (e instanceof SwapError) throw e;
  throw e instanceof Error ? e : new Error(String(e));
}

async function walletInfo(walletId?: string) {
  const id = walletId || (await keystore.getActiveWalletId());
  if (!id) throw new Error("no active wallet");
  const info = (await keystore.getState()).wallets.find((w) => w.id === id);
  if (!info) throw new Error("unknown wallet");
  return info;
}

async function handleUi(msg: UiRequest): Promise<unknown> {
  await keystore.ensureLoaded(); // recover unlocked state after SW eviction
  switch (msg.type) {
    case "wallet/getState": {
      const s = await keystore.getState();
      // Auto-lock "never": a panel session the SW hasn't seen must re-verify the
      // password before it gets the wallet UI (the unlocked session otherwise
      // lives until the browser exits). See panelStepUpState for the lifetime.
      if (!msg.panelSession) return s;
      const known = (await panelStepUpState())[msg.panelSession];
      if (known !== undefined) {
        return { ...s, needsStepUp: known && s.initialized && !s.locked };
      }
      const pending = s.initialized && !s.locked && (await autoLockMinutes()) === 0;
      await setPanelStepUp(msg.panelSession, pending);
      return { ...s, needsStepUp: pending };
    }

    case "wallet/initializeKeystore": {
      const r = await keystore.initialize(msg.password);
      // The user just SET the password — no step-up owed by any panel for this
      // fresh vault (covers reset → re-onboard without a redundant prompt).
      await browser.storage.session.remove(PANEL_STEPUP_KEY);
      return r;
    }

    case "wallet/unlock": {
      const r = await keystore.unlock(msg.password);
      // The user just proved the password — no step-up owed for this panel.
      if (msg.panelSession) await setPanelStepUp(msg.panelSession, false);
      else await browser.storage.session.remove(PANEL_STEPUP_KEY);
      return r;
    }

    case "wallet/stepUp": {
      // Same password oracle as unlock/verifyPassword, so it shares the throttle.
      const ok = await keystore.verifyPassword(msg.password);
      if (ok && msg.panelSession) await setPanelStepUp(msg.panelSession, false);
      return ok;
    }

    case "wallet/lock":
      // A parked scanned phrase must not outlive the session that scanned it.
      clearQrSecret();
      await browser.storage.session.remove(PANEL_STEPUP_KEY);
      return keystore.lock();

    case "wallet/reset": {
      // Stop old-wallet checkpoints and broadcasts before the first async gap.
      // Persisted records are deleted after the vault wipe below.
      txManifestIdempotency.invalidate();
      clearQrSecret();
      // The step-up record guards the vault being destroyed — don't let it
      // (or a pending prompt) survive into the next one.
      await browser.storage.session.remove(PANEL_STEPUP_KEY);
      // Revoke connected dapp sessions on a wipe, so any connected app
      // disconnects (its next call gets NOT_CONNECTED) instead of going stale.
      await removeAllConnectedSites();
      // Fail any parked approvals too, so a reset doesn't leave one approvable.
      rejectPendingApprovals(undefined, "Apogee was reset.");
      // Tear down the offscreen engine so its cached (per-descriptor) wollets
      // don't survive the wipe into the next wallet created or restored — a stale
      // cache would otherwise show a just-deleted wallet's balance/addresses.
      await closeOffscreen();
      // Drop persisted scan state too — the IndexedDB the offscreen rehydrates
      // from (offscreen is already closed above, so the delete never blocks).
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(SCAN_STATE_DB);
        req.onsuccess = req.onerror = () => resolve();
        req.onblocked = () => {
          // Shouldn't happen (the offscreen is closed above and opens per-op),
          // but a blocked delete would leave orphaned scan state behind — log
          // it so a reset that didn't fully clear is visible.
          console.warn("[apogee] scan-state delete blocked during reset");
          resolve();
        };
      });
      // Cached asset icons name the assets the wiped wallet displayed — clear
      // them so the reset doesn't leave that fingerprint in storage. Failure-
      // tolerant and NOT awaited: the icon cache is the least important thing
      // in this handler, and a storage error in front of keystore.reset() would
      // leave the vault intact on a device the user asked to wipe.
      clearAssetIconCache().catch((err) => {
        console.warn("[apogee] asset-icon cache clear failed during reset", err);
      });
      await keystore.reset();
      await txManifestIdempotency.clear();
      return;
    }

    case "wallet/verifyPassword":
      return keystore.verifyPassword(msg.password);

    case "wallet/getUnlockThrottle":
      // Passive read for the unlock screen's countdown — deliberately NOT in
      // AUTOLOCK_DEFERRING.
      return keystore.getUnlockThrottle();

    case "wallet/create": {
      if (msg.password && !(await keystore.isInitialized())) {
        await keystore.initialize(msg.password);
      }
      const mnemonic = await engine<string>({ kind: "generateMnemonic", words: 12 });
      const derived = await engine<DerivedWallet>({
        kind: "deriveWallet",
        mnemonic,
        network: msg.network,
      });
      const wallet = await keystore.addWallet({
        mnemonic,
        descriptor: derived.descriptor,
        fingerprint: derived.fingerprint,
        label: msg.label,
        network: msg.network,
      });
      const result: CreatedWallet = { wallet, mnemonic };
      return result;
    }

    case "wallet/restore": {
      const mnemonic = msg.mnemonic.trim();
      // Validate the BIP-39 phrase (deriveWallet throws on a bad one) BEFORE
      // touching the keystore, so a typo can't leave a wallet-less keystore.
      const derived = await engine<DerivedWallet>({
        kind: "deriveWallet",
        mnemonic,
        network: msg.network,
      });
      // Phrase is valid — only now is it safe to destroy the old vault (the
      // forgot-password recovery path) and re-create it under the new password.
      // Snapshot the vault first so a failure mid-recreate rolls back the wipe.
      const backup = msg.replace ? await keystore.snapshotLocal() : null;
      // A validated replacement is now entering its destructive phase. Stop
      // old-wallet work immediately, while retaining its durable records until
      // replacement succeeds (the catch below may still restore the old vault).
      if (msg.replace) txManifestIdempotency.invalidate();
      try {
        if (msg.replace) {
          // Same session cleanup as wallet/reset: the restored vault is a new
          // wallet, so connected sites must not silently carry over to it, and
          // any parked approval (holding a snapshot of the old wallet) must not
          // stay approvable.
          await removeAllConnectedSites();
          rejectPendingApprovals(undefined, "Apogee was reset.");
          await keystore.reset();
        }
        if (msg.password && !(await keystore.isInitialized())) {
          await keystore.initialize(msg.password);
        }
        const wallet = await keystore.addWallet({
          mnemonic,
          descriptor: derived.descriptor,
          fingerprint: derived.fingerprint,
          label: msg.label,
          network: msg.network,
        });
        if (msg.replace) await txManifestIdempotency.clear();
        return wallet;
      } catch (e) {
        // Roll back the wipe. lock() FIRST: initialize() may have set an in-memory
        // derivedKey + session under the NEW password, and restoring the OLD store
        // alone would leave the SW "unlocked" under the wrong key (an inconsistent
        // state that ensureLoaded won't self-heal while derivedKey is set). Clearing
        // first lands the rollback on a locked wallet — the snapshotLocal invariant.
        if (backup) {
          await keystore.lock();
          await keystore.restoreLocal(backup);
        }
        throw e;
      }
    }

    case "wallet/sync": {
      const info = await walletInfo(msg.walletId);
      return engine<SyncResult>({
        kind: "sync",
        descriptor: info.descriptor,
        network: info.network,
        esploraUrl: await chainServer(info.network),
      });
    }

    case "wallet/getAddress": {
      const info = await walletInfo(msg.walletId);
      return engine<AddressDTO>({
        kind: "getAddress",
        descriptor: info.descriptor,
        network: info.network,
        index: msg.index,
      });
    }

    case "wallet/getBalance": {
      const info = await walletInfo(msg.walletId);
      return engine<Record<string, number>>({
        kind: "getBalance",
        descriptor: info.descriptor,
        network: info.network,
      });
    }

    case "wallet/getTransactions": {
      const info = await walletInfo(msg.walletId);
      return engine<WalletTxDTO[]>({
        kind: "getTransactions",
        descriptor: info.descriptor,
        network: info.network,
      });
    }

    case "wallet/getUtxos": {
      const info = await walletInfo(msg.walletId);
      return engine<WalletUtxoDTO[]>({
        kind: "getWalletUtxos",
        descriptor: info.descriptor,
        network: info.network,
      });
    }

    case "wallet/revealMnemonic": {
      // Step-up auth: verifyPassword re-derives + checks the password, but the
      // returned seed comes from the unlocked cache (getMnemonic), not a fresh
      // decrypt keyed to this attempt — the wallet is already unlocked here.
      if (!(await keystore.verifyPassword(msg.password))) throw new Error("Incorrect password");
      return keystore.getMnemonic(msg.walletId);
    }

    case "wallet/getRate":
      return engineDirect<number>({ kind: "getRate", currency: msg.currency });

    case "wallet/getPrice24hAgo":
      return engineDirect<number>({ kind: "getPrice24hAgo", currency: msg.currency });

    // engineDirect, like getRate: touches no Wollet, so it can't hit the
    // re-entrancy panic, and keeping it off the serial queue means a slow price
    // host can't stall a sync behind it.
    case "wallet/getPriceHistory":
      return engineDirect<PriceHistory>({
        kind: "getPriceHistory",
        currency: msg.currency,
        range: msg.range,
      });

    // Open the guide, reusing the tab we already opened rather than stacking
    // duplicates. Handled HERE, not in the panel: `tabs.query({url})` silently
    // returns [] without the "tabs" permission (the url field is redacted, so the
    // filter matches nothing), and declaring `tabs` — read access to every tab's
    // URL — is far too broad a grant for this. Remembering the id we created needs
    // no permission at all.
    case "wallet/openGuide": {
      const url = browser.runtime.getURL(GUIDE_URL);
      if (guideTabId != null) {
        try {
          // Throws if the tab is gone (onRemoved usually clears it first, but the
          // user may have closed it while the SW was evicted).
          await browser.tabs.update(guideTabId, { active: true });
          const t = await browser.tabs.get(guideTabId);
          if (t.windowId != null) await browser.windows.update(t.windowId, { focused: true });
          return;
        } catch {
          guideTabId = null;
        }
      }
      const created = await browser.tabs.create({ url });
      guideTabId = created.id ?? null;
      return;
    }

    // One request to the repo's latest-release endpoint, on an explicit click.
    // The release tag is what every store package is cut from, so it answers
    // "has a newer version been published" for both browsers from one source —
    // neither store exposes a usable version API. Aborted after 8s so a hung
    // request can't leave the UI waiting indefinitely.
    case "wallet/checkUpdate": {
      let res: Response;
      try {
        res = await fetch(UPDATE_FEED_URL, {
          headers: { Accept: "application/vnd.github+json" },
          signal: AbortSignal.timeout(8_000),
        });
      } catch {
        throw new Error("Couldn't reach the update server.");
      }
      if (!res.ok) throw new Error("Couldn't check for updates right now.");
      const body = (await res.json()) as { tag_name?: unknown };
      const result = evaluateUpdate(
        typeof body.tag_name === "string" ? body.tag_name : "",
        APP_VERSION,
      );
      // An unreadable tag must not be compared — better to say we couldn't check
      // than to claim an update (or claim none) from a version we can't parse.
      if (!result) throw new Error("Couldn't read the latest version.");
      return result;
    }

    case "wallet/qr":
      return engine<string>({ kind: "qr", text: msg.text });

    case "wallet/getAsset":
      return engine<AssetInfo>({ kind: "getAsset", assetId: msg.assetId, network: msg.network });

    case "wallet/getChainServer": {
      return (await chainServer(msg.network)) ?? "";
    }

    case "wallet/probeChainServer": {
      return engineDirect<ChainServerHealth>({
        kind: "probeChainServer",
        network: msg.network,
        esploraUrl: await chainServer(msg.network),
      });
    }

    case "wallet/setChainServer": {
      const url = msg.url.trim().replace(/\/+$/, "");
      // Validate a non-empty URL in the engine (reachable + right network)
      // before persisting; "" clears back to automatic.
      if (url) await engineDirect<boolean>({ kind: "checkEsplora", url, network: msg.network });
      const v = (await browser.storage.local.get(CHAINSERVER_KEY))[CHAINSERVER_KEY];
      const map = v && typeof v === "object" ? { ...(v as Record<string, string>) } : {};
      if (url) map[msg.network] = url;
      else delete map[msg.network];
      await browser.storage.local.set({ [CHAINSERVER_KEY]: map });
      return;
    }

    case "wallet/getAutoLock":
      return autoLockMinutes();

    case "wallet/setAutoLock": {
      await browser.storage.local.set({ [AUTOLOCK_KEY]: msg.minutes });
      // Moving off "never" ends the step-up regime — a pending prompt is moot
      // for every panel session, not just this one.
      if (msg.minutes > 0) await browser.storage.session.remove(PANEL_STEPUP_KEY);
      return;
    }

    case "wallet/touch":
      // No-op here; the AUTOLOCK_DEFERRING branch in the router re-arms the alarm.
      return;

    case "wallet/getConnectedSites":
      return getConnectedSites();

    case "wallet/disconnectSite":
      await removeConnectedSite(msg.origin);
      return;

    case "wallet/prepareSend": {
      const info = await walletInfo(msg.walletId);
      return engine<PrepareSendResult>({
        kind: "prepareSend",
        descriptor: info.descriptor,
        network: info.network,
        address: msg.address,
        sats: msg.sats,
        drain: msg.drain,
        asset: msg.asset,
      });
    }

    case "wallet/send": {
      const info = await walletInfo(msg.walletId);
      // Watch-only wallets hold no key and no signer — nothing can sign here.
      if (info.signer === "watch") {
        throw new Error("Watch-only wallets can't sign or send.");
      }
      // A Jade signs on the device in a tab; the jade-signed handler finalizes,
      // broadcasts, and fires balance-changed once the signature returns.
      if (info.signer === "jade") {
        return signWithJade(
          msg.pset,
          info.descriptor,
          info.network,
          info.fingerprint,
          msg.review ?? {
            address: "",
            recipientAmount: "0",
            feeAmount: "0",
            drain: false,
            toSelf: false,
          },
        );
      }
      // A never-auto-locking wallet stays unlocked indefinitely, so step up auth.
      if ((await autoLockMinutes()) === 0) {
        if (!msg.password || !(await keystore.verifyPassword(msg.password))) {
          throw new Error("Enter your password to send.");
        }
      }
      // A local wallet signs in the offscreen engine with the unlocked mnemonic.
      const sent = await engine<SendResult>({
        kind: "signBroadcast",
        mnemonic: await keystore.getMnemonic(info.id),
        descriptor: info.descriptor,
        network: info.network,
        pset: msg.pset,
        esploraUrl: await chainServer(info.network),
      });
      // Nudge the side panel to poll the balance to settlement instead of
      // waiting for the periodic auto-sync.
      browser.runtime.sendMessage({ type: "apogee/balance-changed" }).catch(() => {});
      return sent;
    }

    case "wallet/swap": {
      const info = await walletInfo(msg.walletId);
      if (info.signer === "watch") {
        throw new Error("Watch-only wallets can't sign or swap.");
      }
      // A never-auto-locking wallet stays unlocked indefinitely, so step up auth
      // before signing — same gate as `wallet/send`. Swap moves funds (it signs
      // a transaction), so it must not bypass the password re-confirm that send
      // requires. See src/sideswap/constants.ts for the fee ceiling.
      if ((await autoLockMinutes()) === 0) {
        if (!msg.password || !(await keystore.verifyPassword(msg.password))) {
          throw new Error("Enter your password to swap.");
        }
      }
      const mnemonic = await keystore.getMnemonic(info.id);
      // The SideSwap client lives only for this swap call — connect, execute,
      // disconnect. A WebSocket in the service worker is fine (MV3 background).
      const client = new SideSwapClient(info.network);
      await client.connect();
      try {
        const result = await executeInstantSwap(
          {
            sendAssetId: msg.sendAssetId,
            recvAssetId: msg.recvAssetId,
            sendAmount: msg.sendAmount,
            recvAmount: msg.recvAmount,
            maxFee: BigInt(SWAP_MAX_FEE_SATS),
            reviewedSendAmount: msg.reviewedSendAmount != null ? BigInt(msg.reviewedSendAmount) : undefined,
            reviewedRecvAmount: msg.reviewedRecvAmount != null ? BigInt(msg.reviewedRecvAmount) : undefined,
          },
          {
            client,
            engineCall: engine,
            descriptor: info.descriptor,
            network: info.network,
            mnemonic,
          },
        );
        browser.runtime.sendMessage({ type: "apogee/balance-changed" }).catch(() => {});
        const dto: SwapResultDTO = {
          txid: result.txid,
          sent: result.sent.toString(),
          received: result.received.toString(),
          fee: result.fee.toString(),
        };
        return dto;
      } catch (e) {
        rethrowSwapError(e);
      } finally {
        client.disconnect();
      }
    }

    case "wallet/swapQuote": {
      const info = await walletInfo(msg.walletId);
      if (info.signer === "watch") {
        throw new Error("Watch-only wallets can't swap.");
      }
      const client = new SideSwapClient(info.network);
      await client.connect();
      try {
        const preview = await previewSwapQuote(
          {
            sendAssetId: msg.sendAssetId,
            recvAssetId: msg.recvAssetId,
            sendAmount: msg.sendAmount,
            recvAmount: msg.recvAmount,
          },
          {
            client,
            engineCall: engine,
            descriptor: info.descriptor,
            network: info.network,
          },
        );
        return {
          sendAmount: preview.sendAmount.toString(),
          recvAmount: preview.recvAmount.toString(),
          expiresAt: preview.expiresAt,
          fixedFee: preview.fixedFee.toString(),
          serverFee: preview.serverFee.toString(),
        } satisfies SwapQuotePreview;
      } catch (e) {
        rethrowSwapError(e);
      } finally {
        client.disconnect();
      }
    }

    case "wallet/addHardwareWallet": {
      if (msg.password && !(await keystore.isInitialized())) {
        await keystore.initialize(msg.password);
      }
      return keystore.addHardwareWallet({
        signer: msg.signer,
        descriptor: msg.descriptor,
        fingerprint: msg.fingerprint,
        label: msg.label,
        network: msg.network,
      });
    }

    case "wallet/addWatchOnlyWallet": {
      if (msg.password && !(await keystore.isInitialized())) {
        await keystore.initialize(msg.password);
      }
      const descriptor = msg.descriptor.trim();
      // Validate the descriptor and derive its fingerprint in the engine.
      const info = await engine<DescriptorInfo>({ kind: "descriptorInfo", descriptor });
      // Guard against a network mismatch — importing a mainnet descriptor as a
      // testnet/regtest wallet (or vice versa) would silently watch the wrong
      // chain. lwk's isMainnet() only separates mainnet from non-mainnet, so
      // testnet and regtest are intentionally interchangeable here — the user
      // picks which non-mainnet chain, and confusing the two only mis-targets a
      // test server (never mainnet, where funds live).
      if (info.mainnet !== (msg.network === "liquid")) {
        throw new Error(
          `This descriptor is for ${info.mainnet ? "mainnet (Liquid)" : "testnet/regtest"}. Pick the matching network.`,
        );
      }
      // Persisted like a hardware wallet: watch-only descriptor + signer, no seed.
      return keystore.addHardwareWallet({
        signer: "watch",
        descriptor,
        fingerprint: info.fingerprint,
        label: msg.label,
        network: msg.network,
      });
    }
  }
}

// ---- dapp providers ---------------------------------------------------------

/** Internal network → the standard names a connected dapp expects. */
function toDappNetwork(n: LiquidNetwork): DappNetwork {
  return n === "liquid" ? "mainnet" : n === "liquidtestnet" ? "testnet" : "regtest";
}

// The old release stored only an origin allowlist. Keep that key for a lazy,
// session-only migration, but all new approvals use a connection pinned to a
// wallet, chain, and exact standard-method grant.
const SITES_KEY = "apogee_connected_sites";
const CONNECTIONS_KEY = "apogee_provider_connections_v1";
let connectionWriteQueue: Promise<void> = Promise.resolve();
const connectionRevisions = new Map<string, number>();
let connectionGeneration = 0;

interface StoredProviderConnection extends LiquidConnection {
  walletId: string;
  legacy: boolean;
}

type StoredProviderConnections = Record<string, StoredProviderConnection>;

function connectionRevision(origin: string): number {
  return connectionRevisions.get(origin) ?? 0;
}

function queueConnectionWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = connectionWriteQueue.then(operation);
  connectionWriteQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

const SUPPORTED_PROFILE_METHODS = new Set<string>([
  LIQUID_WALLET_RPC_METHODS.GET_TX_MANIFEST_SUPPORT,
  LIQUID_WALLET_RPC_METHODS.EXECUTE_TX_MANIFEST,
  LIQUID_WALLET_RPC_METHODS.GET_BALANCE,
  LIQUID_WALLET_RPC_METHODS.GET_UTXOS,
  LIQUID_WALLET_RPC_METHODS.GET_WALLET_DESCRIPTOR,
  LIQUID_WALLET_RPC_METHODS.SEND_TRANSFER,
  LIQUID_WALLET_RPC_METHODS.SIGN_PSET,
]);
const SUPPORTED_PROFILE_EVENTS = new Set<string>([LIQUID_WALLET_DESCRIPTOR_CHANGED_EVENT]);
const PROVIDER_CAPABILITIES = Object.freeze({
  browserProviderVersion: LIQUID_BROWSER_PROVIDER_VERSION,
  methods: Object.freeze([
    ...Object.values(LIQUID_BROWSER_PROVIDER_METHODS),
    ...SUPPORTED_PROFILE_METHODS,
  ]),
  events: Object.freeze([LIQUID_CONNECTION_CHANGED_EVENT, ...SUPPORTED_PROFILE_EVENTS]),
});

const TX_MANIFEST_RESULTS_KEY = "apogee_tx_manifest_results_v1";

const txManifestIdempotency = new TxManifestIdempotency({
  async load(): Promise<TxManifestExecutionRecord[]> {
    const value = (await browser.storage.local.get(TX_MANIFEST_RESULTS_KEY))[
      TX_MANIFEST_RESULTS_KEY
    ];
    return migrateStoredTxManifestRecords(value);
  },
  async save(records: TxManifestExecutionRecord[]): Promise<void> {
    await browser.storage.local.set({ [TX_MANIFEST_RESULTS_KEY]: records });
  },
});

async function getProviderConnections(): Promise<StoredProviderConnections> {
  const value = (await browser.storage.session.get(CONNECTIONS_KEY))[CONNECTIONS_KEY];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as StoredProviderConnections)
    : {};
}

function publicConnection(connection: StoredProviderConnection): LiquidConnection {
  return {
    accountIdentifier: connection.accountIdentifier,
    chainId: connection.chainId,
    policyAssetId: connection.policyAssetId,
    permissions: {
      methods: [...connection.permissions.methods],
      events: [...connection.permissions.events],
    },
  };
}

async function getConnectedSites(): Promise<string[]> {
  const stored = await browser.storage.session.get([SITES_KEY, CONNECTIONS_KEY]);
  const legacy = Array.isArray(stored[SITES_KEY]) ? (stored[SITES_KEY] as string[]) : [];
  const connections =
    stored[CONNECTIONS_KEY] && typeof stored[CONNECTIONS_KEY] === "object"
      ? Object.keys(stored[CONNECTIONS_KEY] as StoredProviderConnections)
      : [];
  return [...new Set([...legacy, ...connections])];
}

function broadcastSitesChanged(): void {
  browser.runtime.sendMessage({ type: "apogee/sites-changed" }).catch(() => {});
}

async function notifyConnectionChanged(
  origin: string,
  connection: StoredProviderConnection | null,
): Promise<void> {
  const tabs = await browser.tabs.query({});
  await Promise.allSettled(
    tabs.flatMap((tab) =>
      tab.id === undefined
        ? []
        : [
            browser.tabs.sendMessage(tab.id, {
              type: "apogee/provider-event",
              origin,
              event: LIQUID_CONNECTION_CHANGED_EVENT,
              payload: connection ? publicConnection(connection) : null,
            }),
          ],
    ),
  );
}

async function notifyWalletDescriptorChanged(
  origin: string,
  connection: StoredProviderConnection,
): Promise<void> {
  if (
    keystore.isLocked() ||
    !connection.permissions.methods.includes(LIQUID_WALLET_RPC_METHODS.GET_WALLET_DESCRIPTOR) ||
    !connection.permissions.events.includes(LIQUID_WALLET_DESCRIPTOR_CHANGED_EVENT)
  ) {
    return;
  }

  const revision = connectionRevision(origin);
  try {
    const info = await walletInfo(connection.walletId);
    const result = await buildPublicWalletDescriptorResult(connection, info.descriptor);
    const current =
      revision === connectionRevision(origin) ? (await getProviderConnections())[origin] : undefined;
    if (
      keystore.isLocked() ||
      !current ||
      current.walletId !== connection.walletId ||
      !current.permissions.methods.includes(LIQUID_WALLET_RPC_METHODS.GET_WALLET_DESCRIPTOR) ||
      !current.permissions.events.includes(LIQUID_WALLET_DESCRIPTOR_CHANGED_EVENT)
    ) {
      return;
    }

    const tabs = await browser.tabs.query({});
    await Promise.allSettled(
      tabs.flatMap((tab) =>
        tab.id === undefined
          ? []
          : [
              browser.tabs.sendMessage(tab.id, {
                type: "apogee/provider-event",
                origin,
                event: LIQUID_WALLET_DESCRIPTOR_CHANGED_EVENT,
                payload: result,
              }),
            ],
      ),
    );
  } catch {
    // Event delivery is best-effort. A descriptor that cannot pass the public
    // projection boundary must not break an otherwise valid connection.
    console.debug("[apogee] descriptor-change event skipped: public projection unavailable");
  }
}

async function setProviderConnection(
  origin: string,
  connection: StoredProviderConnection,
  expectedRevision = connectionRevision(origin),
  expectedGeneration = connectionGeneration,
): Promise<boolean> {
  return queueConnectionWrite(async () => {
    if (
      connectionRevision(origin) !== expectedRevision ||
      connectionGeneration !== expectedGeneration
    ) {
      return false;
    }
    const connections = await getProviderConnections();
    const previous = connections[origin];
    connections[origin] = connection;
    const storedSites = (await browser.storage.session.get(SITES_KEY))[SITES_KEY];
    const legacySites = Array.isArray(storedSites) ? (storedSites as string[]) : [];
    await browser.storage.session.set({
      [CONNECTIONS_KEY]: connections,
      [SITES_KEY]: legacySites.filter((site) => site !== origin),
    });
    connectionRevisions.set(origin, expectedRevision + 1);
    broadcastSitesChanged();
    await notifyConnectionChanged(origin, connection);
    const descriptorIdentityChanged =
      !previous ||
      previous.accountIdentifier !== connection.accountIdentifier ||
      previous.policyAssetId !== connection.policyAssetId;
    if (descriptorIdentityChanged) await notifyWalletDescriptorChanged(origin, connection);
    return true;
  });
}

async function removeConnectedSite(origin: string | undefined): Promise<void> {
  if (!origin) return;
  connectionRevisions.set(origin, connectionRevision(origin) + 1);
  // Fail any parked approval for this origin so a revoked site can't still be
  // approved — its dapp promise rejects immediately.
  rejectPendingApprovals(origin, "This site was disconnected.");
  await queueConnectionWrite(async () => {
    const stored = await browser.storage.session.get([SITES_KEY, CONNECTIONS_KEY]);
    const sites = Array.isArray(stored[SITES_KEY]) ? (stored[SITES_KEY] as string[]) : [];
    const connections =
      stored[CONNECTIONS_KEY] && typeof stored[CONNECTIONS_KEY] === "object"
        ? ({ ...(stored[CONNECTIONS_KEY] as StoredProviderConnections) } as StoredProviderConnections)
        : {};
    const existed = sites.includes(origin) || connections[origin] !== undefined;
    delete connections[origin];
    if (existed) {
      await browser.storage.session.set({
        [SITES_KEY]: sites.filter((site) => site !== origin),
        [CONNECTIONS_KEY]: connections,
      });
      broadcastSitesChanged();
      await notifyConnectionChanged(origin, null);
    }
  });
}

async function removeAllConnectedSites(): Promise<void> {
  const origins = await getConnectedSites();
  connectionGeneration += 1;
  for (const origin of origins) {
    connectionRevisions.set(origin, connectionRevision(origin) + 1);
  }
  await queueConnectionWrite(async () => {
    await browser.storage.session.remove([SITES_KEY, CONNECTIONS_KEY]);
    broadcastSitesChanged();
    await Promise.all(origins.map((origin) => notifyConnectionChanged(origin, null)));
  });
}

async function buildConnection(
  walletId: string,
  methods: readonly string[],
  events: readonly string[],
  legacy: boolean,
): Promise<StoredProviderConnection> {
  const info = await walletInfo(walletId);
  const identity = await engine<WalletIdentity>({
    kind: "walletIdentity",
    descriptor: info.descriptor,
    network: info.network,
  });
  return {
    walletId: info.id,
    legacy,
    chainId: identity.chainId,
    accountIdentifier: `${identity.chainId}:${identity.dwid}`,
    policyAssetId: identity.policyAssetId,
    permissions: { methods: [...methods], events: [...events] },
  };
}

async function buildPublicWalletDescriptorResult(
  connection: StoredProviderConnection,
  descriptor: string,
): Promise<LiquidGetWalletDescriptorResult> {
  const projected = await engine<PublicWalletDescriptorDTO>({
    kind: "getPublicWalletDescriptor",
    descriptor,
  });
  return {
    accountIdentifier: connection.accountIdentifier,
    chainId: connection.chainId,
    policyAssetId: connection.policyAssetId,
    descriptors: [
      {
        descriptorType: LIQUID_DESCRIPTOR_TYPES.PUBLIC_WALLET_DESCRIPTOR,
        format: LIQUID_DESCRIPTOR_FORMATS.BIP380_BIP389_MULTIPATH,
        branchLayout: "multipath",
        descriptor: projected.descriptor,
        branches: [
          { branch: "external", change: 0, addressIndex: "*" },
          { branch: "internal", change: 1, addressIndex: "*" },
        ],
        standardsUsed: projected.standardsUsed,
        canDeriveScriptPubKeys: true,
        canDeriveConfidentialAddresses: false,
        canUnblindOutputs: false,
      },
    ],
  };
}

async function legacyAccount(connection: StoredProviderConnection): Promise<ProviderAccount> {
  const info = await walletInfo(connection.walletId);
  return {
    network: toDappNetwork(info.network),
    masterFingerprint: info.fingerprint,
    signerKind: info.signer,
  };
}

async function migrateLegacyConnection(
  origin: string | undefined,
): Promise<StoredProviderConnection | null> {
  if (!origin) return null;
  const existing = (await getProviderConnections())[origin];
  if (existing) return existing;
  const sites = (await browser.storage.session.get(SITES_KEY))[SITES_KEY];
  if (!Array.isArray(sites) || !(sites as string[]).includes(origin)) return null;
  const revision = connectionRevision(origin);
  const generation = connectionGeneration;
  const info = await walletInfo();
  const connection = await buildConnection(info.id, [LIQUID_WALLET_RPC_METHODS.GET_BALANCE], [], true);
  if (await setProviderConnection(origin, connection, revision, generation)) return connection;
  return (await getProviderConnections())[origin] ?? null;
}

async function requireLegacyConnection(
  origin: string | undefined,
): Promise<StoredProviderConnection> {
  const connection = await migrateLegacyConnection(origin);
  if (!connection?.legacy) throw new Error("NOT_CONNECTED");
  return connection;
}

function providerError(
  code: (typeof LIQUID_RPC_ERROR_CODES)[keyof typeof LIQUID_RPC_ERROR_CODES],
  message: string,
  reason: (typeof LIQUID_RPC_ERROR_REASONS)[keyof typeof LIQUID_RPC_ERROR_REASONS],
  data?: unknown,
): LiquidRpcError {
  return new LiquidRpcError(code, message, reason, data);
}

async function selectConnectionWallet(chains?: readonly string[]): Promise<StoredProviderConnection> {
  const state = await keystore.getState();
  if (!state.initialized || state.wallets.length === 0) {
    throw providerError(
      LIQUID_RPC_ERROR_CODES.CHAIN_UNAVAILABLE,
      "No Liquid wallet is available in Apogee.",
      LIQUID_RPC_ERROR_REASONS.CHAIN_UNAVAILABLE,
    );
  }
  const active = state.wallets.find((wallet) => wallet.id === state.activeWalletId);
  const candidates = active
    ? [active, ...state.wallets.filter((wallet) => wallet.id !== active.id)]
    : state.wallets;
  for (const candidate of candidates) {
    const connection = await buildConnection(candidate.id, [], [], false);
    if (!chains || chains.includes(connection.chainId)) return connection;
  }
  throw providerError(
    LIQUID_RPC_ERROR_CODES.CHAIN_UNAVAILABLE,
    "None of the requested chains is available in Apogee.",
    LIQUID_RPC_ERROR_REASONS.CHAIN_UNAVAILABLE,
  );
}

async function requestStandardConnection(
  origin: string,
  params: LiquidConnectParams,
): Promise<LiquidConnection> {
  const requestedMethods = params.methods.filter((method) => SUPPORTED_PROFILE_METHODS.has(method));
  if (requestedMethods.length === 0) {
    throw providerError(
      LIQUID_RPC_ERROR_CODES.UNSUPPORTED_CAPABILITY,
      "None of the requested Liquid RPC methods is supported by Apogee.",
      LIQUID_RPC_ERROR_REASONS.UNSUPPORTED_CAPABILITY,
    );
  }
  const requestedEvents = (params.events ?? []).filter((event) => SUPPORTED_PROFILE_EVENTS.has(event));
  let existing = await migrateLegacyConnection(origin);
  if (existing && params.chains && !params.chains.includes(existing.chainId)) existing = null;

  const selected = existing ?? (await selectConnectionWallet(params.chains));
  const methods = [...new Set([...selected.permissions.methods, ...requestedMethods])];
  const events = [...new Set([...selected.permissions.events, ...requestedEvents])];
  if (
    events.includes(LIQUID_WALLET_DESCRIPTOR_CHANGED_EVENT) &&
    !methods.includes(LIQUID_WALLET_RPC_METHODS.GET_WALLET_DESCRIPTOR)
  ) {
    throw providerError(
      LIQUID_RPC_ERROR_CODES.UNSUPPORTED_CAPABILITY,
      `${LIQUID_WALLET_DESCRIPTOR_CHANGED_EVENT} requires getWalletDescriptor permission.`,
      LIQUID_RPC_ERROR_REASONS.UNSUPPORTED_CAPABILITY,
      {
        event: LIQUID_WALLET_DESCRIPTOR_CHANGED_EVENT,
        requiredMethod: LIQUID_WALLET_RPC_METHODS.GET_WALLET_DESCRIPTOR,
      },
    );
  }
  const alreadyGranted =
    existing !== null &&
    requestedMethods.every((method) => existing.permissions.methods.includes(method)) &&
    requestedEvents.every((event) => existing.permissions.events.includes(event));
  if (existing && alreadyGranted) return publicConnection(existing);

  const connection: StoredProviderConnection = {
    ...selected,
    legacy: selected.legacy,
    permissions: { methods, events },
  };
  const account = await legacyAccount(connection);
  const id = `appr-${approvalSeq++}-${Date.now()}`;
  const request: ApprovalRequest = {
    kind: "connect",
    id,
    origin,
    network: account.network,
    fingerprint: account.masterFingerprint,
    signerKind: account.signerKind,
    locked: keystore.isLocked(),
    methods,
    events,
    legacy: false,
  };
  return await new Promise<LiquidConnection>((resolve, reject) => {
    parkApproval(id, {
      kind: "connect",
      request,
      origin,
      connection,
      result: publicConnection(connection),
      revision: connectionRevision(origin),
      generation: connectionGeneration,
      resolve: resolve as (result: unknown) => void,
      reject,
    });
    void routeApproval(request);
  });
}

async function handleStandardProvider(requestValue: unknown, origin: string | undefined) {
  if (!origin) {
    throw providerError(
      LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
      "The calling origin could not be authenticated.",
      LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
    );
  }
  const rawMethod =
    requestValue && typeof requestValue === "object"
      ? (requestValue as { method?: unknown }).method
      : undefined;
  if (
    typeof rawMethod === "string" &&
    Object.values(LIQUID_WALLET_RPC_METHODS).includes(rawMethod as never) &&
    !SUPPORTED_PROFILE_METHODS.has(rawMethod)
  ) {
    throw providerError(
      LIQUID_RPC_ERROR_CODES.UNSUPPORTED_CAPABILITY,
      `Apogee does not support ${rawMethod}.`,
      LIQUID_RPC_ERROR_REASONS.UNSUPPORTED_CAPABILITY,
      { method: rawMethod },
    );
  }
  const request = parseLiquidProviderRequest(requestValue);
  switch (request.method) {
    case "wallet_getCapabilities":
      return PROVIDER_CAPABILITIES;
    case "wallet_getConnection": {
      const connection = await migrateLegacyConnection(origin);
      return connection ? publicConnection(connection) : null;
    }
    case "wallet_disconnect":
      await removeConnectedSite(origin);
      return null;
    case "wallet_connect":
      return requestStandardConnection(origin, request.params);
    case "experimental_getTxManifestSupport":
      return engine({
        kind: "getTxManifestSupport",
        bundleHash: request.params.bundleHash,
      });
    case "experimental_executeTxManifest":
      return executeProviderTxManifest(origin, request.params);
    case "getWalletDescriptor": {
      const connection = await migrateLegacyConnection(origin);
      if (!connection || !connection.permissions.methods.includes(request.method)) {
        throw providerError(
          LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
          "This origin is not authorized to read the connected wallet descriptor.",
          LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
        );
      }
      if (keystore.isLocked()) {
        throw providerError(
          LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
          "Unlock Apogee to read this wallet descriptor.",
          LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
          { cause: "locked" },
        );
      }

      const descriptorType =
        request.params?.descriptorType ?? LIQUID_DESCRIPTOR_TYPES.PUBLIC_WALLET_DESCRIPTOR;
      if (descriptorType !== LIQUID_DESCRIPTOR_TYPES.PUBLIC_WALLET_DESCRIPTOR) {
        throw providerError(
          LIQUID_RPC_ERROR_CODES.UNSUPPORTED_CAPABILITY,
          "Apogee does not expose public confidential descriptors.",
          LIQUID_RPC_ERROR_REASONS.UNSUPPORTED_CAPABILITY,
          { descriptorType },
        );
      }
      const supportedFormat = LIQUID_DESCRIPTOR_FORMATS.BIP380_BIP389_MULTIPATH;
      if (
        request.params?.descriptorFormat &&
        !request.params.descriptorFormat.some(({ format }) => format === supportedFormat)
      ) {
        throw providerError(
          LIQUID_RPC_ERROR_CODES.UNSUPPORTED_CAPABILITY,
          "Apogee cannot return any of the requested descriptor formats.",
          LIQUID_RPC_ERROR_REASONS.UNSUPPORTED_DESCRIPTOR_FORMAT,
          {
            requestedFormats: request.params.descriptorFormat.map(({ format }) => format),
            supportedFormats: [supportedFormat],
          },
        );
      }

      const revision = connectionRevision(origin);
      const generation = connectionGeneration;
      const info = await walletInfo(connection.walletId).catch(async () => {
        await removeConnectedSite(origin);
        throw providerError(
          LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
          "The connected wallet is no longer available.",
          LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
        );
      });
      let result: LiquidGetWalletDescriptorResult;
      try {
        result = await buildPublicWalletDescriptorResult(connection, info.descriptor);
      } catch {
        // Do not forward parser errors: an upstream error could quote the
        // private CT descriptor it was asked to parse.
        throw providerError(
          LIQUID_RPC_ERROR_CODES.UNSUPPORTED_CAPABILITY,
          "This wallet descriptor cannot be safely represented in a supported public format.",
          LIQUID_RPC_ERROR_REASONS.UNSUPPORTED_DESCRIPTOR_FORMAT,
          { supportedFormats: [supportedFormat] },
        );
      }

      const current =
        generation === connectionGeneration && revision === connectionRevision(origin)
          ? (await getProviderConnections())[origin]
          : undefined;
      if (
        keystore.isLocked() ||
        !current ||
        current.walletId !== connection.walletId ||
        !current.permissions.methods.includes(request.method)
      ) {
        throw providerError(
          LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
          "This origin is no longer authorized to read the connected wallet descriptor.",
          LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
        );
      }
      return result;
    }
    case "getBalance": {
      const connection = await migrateLegacyConnection(origin);
      if (!connection || !connection.permissions.methods.includes(request.method)) {
        throw providerError(
          LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
          "This origin is not authorized to read the connected wallet balance.",
          LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
        );
      }
      if (keystore.isLocked()) {
        throw providerError(
          LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
          "Unlock Apogee to read this wallet balance.",
          LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
          { cause: "locked" },
        );
      }
      const assetId = request.params?.assetId ?? connection.policyAssetId;
      if (!assetId.startsWith(`${connection.chainId}/elip144:`)) {
        throw providerError(
          LIQUID_RPC_ERROR_CODES.INVALID_PARAMS,
          "The requested asset belongs to a different chain.",
          LIQUID_RPC_ERROR_REASONS.INVALID_PARAMS,
          { path: "params.assetId" },
        );
      }
      const info = await walletInfo(connection.walletId).catch(async () => {
        await removeConnectedSite(origin);
        throw providerError(
          LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
          "The connected wallet is no longer available.",
          LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
        );
      });
      const sync = await engine<SyncResult>({
        kind: "sync",
        descriptor: info.descriptor,
        network: info.network,
        esploraUrl: await chainServer(info.network),
      });
      const assetHex = assetId.slice(assetId.lastIndexOf(":") + 1);
      return {
        accountIdentifier: connection.accountIdentifier,
        assetId,
        balance: sync.balanceStrings?.[assetHex] ?? String(sync.balance[assetHex] ?? 0),
        chainId: connection.chainId,
        policyAssetId: connection.policyAssetId,
      };
    }
    case "getUTXOs": {
      const connection = await migrateLegacyConnection(origin);
      if (!connection || !connection.permissions.methods.includes(request.method)) {
        throw providerError(
          LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
          "This origin is not authorized to inspect the connected wallet's UTXOs.",
          LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
        );
      }
      if (keystore.isLocked()) {
        throw providerError(
          LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
          "Unlock Apogee to inspect this wallet's UTXOs.",
          LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
          { cause: "locked" },
        );
      }

      const revision = connectionRevision(origin);
      const generation = connectionGeneration;
      const assetId = request.params?.assetId ?? connection.policyAssetId;
      if (!assetId.startsWith(`${connection.chainId}/elip144:`)) {
        throw providerError(
          LIQUID_RPC_ERROR_CODES.INVALID_PARAMS,
          "The requested asset belongs to a different chain.",
          LIQUID_RPC_ERROR_REASONS.INVALID_PARAMS,
          { path: "params.assetId" },
        );
      }

      const info = await walletInfo(connection.walletId).catch(async () => {
        await removeConnectedSite(origin);
        throw providerError(
          LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
          "The connected wallet is no longer available.",
          LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
        );
      });
      await engine<SyncResult>({
        kind: "sync",
        descriptor: info.descriptor,
        network: info.network,
        esploraUrl: await chainServer(info.network),
      });
      const assetHex = assetId.slice(assetId.lastIndexOf(":") + 1);
      const publicUtxos = await engine<ProviderUtxoDTO[]>({
        kind: "getProviderUtxos",
        descriptor: info.descriptor,
        network: info.network,
        asset: assetHex,
      });

      // A sync can take long enough for the user to revoke the site or lock the
      // wallet. Do not release account state under a stale authorization snapshot.
      const current =
        generation === connectionGeneration && revision === connectionRevision(origin)
          ? (await getProviderConnections())[origin]
          : undefined;
      if (
        keystore.isLocked() ||
        !current ||
        current.walletId !== connection.walletId ||
        !current.permissions.methods.includes(request.method)
      ) {
        throw providerError(
          LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
          "This origin is no longer authorized to inspect the connected wallet's UTXOs.",
          LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
        );
      }

      const result: LiquidGetUTXOsResult = {
        accountIdentifier: connection.accountIdentifier,
        assetId,
        chainId: connection.chainId,
        policyAssetId: connection.policyAssetId,
        utxos: publicUtxos.map((utxo) => ({
          address: utxo.address,
          amount: utxo.amount,
          assetId: `${connection.chainId}/elip144:${utxo.asset}`,
          confidential: utxo.confidential,
          scriptPubKey: utxo.scriptPubKey,
          spendable: info.signer !== "watch",
          txid: utxo.txid,
          txOut: utxo.txOut,
          vout: utxo.vout,
        })),
      };
      return result;
    }
    case "sendTransfer": {
      const connection = await migrateLegacyConnection(origin);
      if (!connection || !connection.permissions.methods.includes(request.method)) {
        throw providerError(
          LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
          "This origin is not authorized to request transfers from the connected wallet.",
          LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
        );
      }
      const revision = connectionRevision(origin);
      const generation = connectionGeneration;
      if (request.params.account && request.params.account !== connection.accountIdentifier) {
        throw providerError(
          LIQUID_RPC_ERROR_CODES.INVALID_PARAMS,
          "The requested account does not match this origin's connected account.",
          LIQUID_RPC_ERROR_REASONS.INVALID_PARAMS,
          { path: "params.account" },
        );
      }
      if (request.params.memo !== undefined) {
        // LWK's transaction builder cannot add a zero-value arbitrary script
        // output. The profile makes memo support optional, so reject explicitly
        // instead of silently omitting page-supplied bytes from the transaction.
        throw providerError(
          LIQUID_RPC_ERROR_CODES.UNSUPPORTED_CAPABILITY,
          "Apogee does not currently support sendTransfer memos.",
          LIQUID_RPC_ERROR_REASONS.UNSUPPORTED_CAPABILITY,
          { method: request.method, capability: "memo", path: "params.memo" },
        );
      }

      const amount = BigInt(request.params.amount);
      if (amount <= 0n || amount > (1n << 64n) - 1n) {
        throw providerError(
          LIQUID_RPC_ERROR_CODES.INVALID_PARAMS,
          "The transfer amount must be between 1 and 18446744073709551615 base units.",
          LIQUID_RPC_ERROR_REASONS.INVALID_PARAMS,
          { path: "params.amount" },
        );
      }
      const assetId = request.params.assetId ?? connection.policyAssetId;
      if (!assetId.startsWith(`${connection.chainId}/elip144:`)) {
        throw providerError(
          LIQUID_RPC_ERROR_CODES.INVALID_PARAMS,
          "The transfer asset belongs to a different chain.",
          LIQUID_RPC_ERROR_REASONS.INVALID_PARAMS,
          { path: "params.assetId" },
        );
      }
      const info = await walletInfo(connection.walletId).catch(async () => {
        await removeConnectedSite(origin);
        throw providerError(
          LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
          "The connected wallet is no longer available.",
          LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
        );
      });
      if (info.signer === "watch") {
        throw providerError(
          LIQUID_RPC_ERROR_CODES.UNSUPPORTED_CAPABILITY,
          "The connected wallet is watch-only and cannot send transfers.",
          LIQUID_RPC_ERROR_REASONS.UNSUPPORTED_CAPABILITY,
          { method: request.method, cause: "watch_only" },
        );
      }

      const assetHex = assetId.slice(assetId.lastIndexOf(":") + 1);
      let prepared: PrepareSendResult;
      try {
        prepared = await engine<PrepareSendResult>({
          kind: "prepareSend",
          descriptor: info.descriptor,
          network: info.network,
          address: request.params.recipientAddress,
          sats: request.params.amount,
          asset: assetHex,
        });
      } catch (error) {
        throw standardTransferPreparationError(error);
      }

      const metadata =
        assetId === connection.policyAssetId
          ? null
          : await engine<AssetInfo>({
              kind: "getAsset",
              assetId: assetHex,
              network: info.network,
            }).catch(() => null);
      const review: SendReview = {
        address: request.params.recipientAddress,
        recipientAmount: prepared.recipientAmount,
        feeAmount: prepared.feeAmount,
        drain: false,
        toSelf: prepared.toSelf,
        accountIdentifier: connection.accountIdentifier,
        ...(assetId === connection.policyAssetId
          ? {}
          : {
              assetId,
              assetTicker: metadata?.ticker ?? null,
              assetPrecision: metadata?.precision ?? null,
            }),
      };
      if (revision !== connectionRevision(origin) || generation !== connectionGeneration) {
        throw providerError(
          LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
          "This site's wallet connection changed while Apogee prepared the transfer.",
          LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
        );
      }
      const id = `appr-${approvalSeq++}-${Date.now()}`;
      const approval: ApprovalRequest = {
        kind: "send",
        id,
        origin,
        review,
        network: toDappNetwork(info.network),
        locked: info.signer === "jade" ? false : keystore.isLocked(),
        signerKind: info.signer,
      };
      return await new Promise<SendResult>((resolve, reject) => {
        parkApproval(id, {
          kind: "send",
          request: approval,
          origin,
          walletId: info.id,
          descriptor: info.descriptor,
          network: info.network,
          pset: prepared.pset,
          permissionMethod: request.method,
          revision,
          generation,
          resolve: resolve as (result: unknown) => void,
          reject,
        });
        void routeApproval(approval);
      });
    }
    case "signPset": {
      const connection = await migrateLegacyConnection(origin);
      if (!connection || !connection.permissions.methods.includes(request.method)) {
        throw providerError(
          LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
          "This origin is not authorized to request PSET signatures from the connected wallet.",
          LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
        );
      }
      const revision = connectionRevision(origin);
      const generation = connectionGeneration;
      const info = await walletInfo(connection.walletId).catch(async () => {
        await removeConnectedSite(origin);
        throw providerError(
          LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
          "The connected wallet is no longer available.",
          LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
        );
      });
      if (info.signer === "watch") {
        throw providerError(
          LIQUID_RPC_ERROR_CODES.UNSUPPORTED_CAPABILITY,
          "The connected wallet is watch-only and cannot sign PSETs.",
          LIQUID_RPC_ERROR_REASONS.UNSUPPORTED_CAPABILITY,
          { method: request.method, cause: "watch_only" },
        );
      }

      const signInputs: ProviderPsetSignInputDTO[] = request.params.signInputs.map((input) => ({
        index: input.index,
        address: input.address,
        ...(input.sighashTypes ? { sighashTypes: [...input.sighashTypes] } : {}),
      }));
      let analyzed: ProviderPsetAnalysisResultDTO;
      try {
        await engine<SyncResult>({
          kind: "sync",
          descriptor: info.descriptor,
          network: info.network,
          esploraUrl: await chainServer(info.network),
        });
        analyzed = await engine<ProviderPsetAnalysisResultDTO>({
          kind: "analyzeProviderPset",
          descriptor: info.descriptor,
          network: info.network,
          pset: request.params.pset,
          signInputs,
        });
      } catch (error) {
        console.debug("[apogee] signPset analysis failed:", errMsg(error));
        throw providerError(
          LIQUID_RPC_ERROR_CODES.INTERNAL_ERROR,
          "Apogee could not inspect this PSET against current wallet state.",
          LIQUID_RPC_ERROR_REASONS.INTERNAL_ERROR,
        );
      }
      if (!analyzed.ok) throw providerPsetAnalysisError(analyzed);

      const current =
        generation === connectionGeneration && revision === connectionRevision(origin)
          ? (await getProviderConnections())[origin]
          : undefined;
      if (
        !current ||
        current.walletId !== connection.walletId ||
        !current.permissions.methods.includes(request.method)
      ) {
        throw providerError(
          LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
          "This site's wallet connection changed while Apogee inspected the PSET.",
          LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
        );
      }

      const review: ProviderPsetApprovalReviewDTO = {
        ...analyzed.analysis,
        accountIdentifier: connection.accountIdentifier,
      };
      const id = `appr-${approvalSeq++}-${Date.now()}`;
      const approval: ApprovalRequest = {
        kind: "signPset",
        id,
        origin,
        review,
        network: toDappNetwork(info.network),
        locked: info.signer === "jade" ? false : keystore.isLocked(),
        signerKind: info.signer,
        broadcast: request.params.broadcast === true,
      };
      return await new Promise<LiquidSignPsetResult>((resolve, reject) => {
        parkApproval(id, {
          kind: "signPset",
          request: approval,
          origin,
          walletId: info.id,
          descriptor: info.descriptor,
          network: info.network,
          pset: request.params.pset,
          signInputs,
          expectedAnalysis: analyzed.analysis,
          broadcast: request.params.broadcast === true,
          permissionMethod: request.method,
          revision,
          generation,
          resolve: resolve as (result: unknown) => void,
          reject,
        });
        void routeApproval(approval);
      });
    }
    default:
      throw providerError(
        LIQUID_RPC_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        `Apogee does not support ${request.method}.`,
        LIQUID_RPC_ERROR_REASONS.UNSUPPORTED_CAPABILITY,
        { method: request.method },
      );
  }
}

type PreparedProviderTxManifest =
  | {
      kind: "acceptOffer";
      plan: AcceptOfferRequirementPlan;
      prepared: HostedPreparedAcceptOfferExecution;
      genesisHash: string;
    }
  | {
      kind: "claimLenderVault";
      plan: ClaimLenderVaultRequirementPlan;
      prepared: HostedPreparedClaimLenderVaultExecution;
      genesisHash: string;
    }
  | {
      kind: "newLendingAction";
      plan:
        | CreateFactoryRequirementPlan
        | CreateOfferRequirementPlan
        | ClaimPrincipalRequirementPlan
        | CancelOfferRequirementPlan
        | RepayLoanRequirementPlan
        | LiquidateOfferRequirementPlan;
      prepared: HostedPreparedNewLendingExecution;
      genesisHash: string;
    };

type ReviewedTxManifestFee = {
  /** Actual transaction fee displayed to and approved by the user. */
  actualFee: string;
  /** Lower bound used to reproduce the reviewed deterministic input selection. */
  selectionFee: string;
};

function buildTxManifestResult(
  invocation: LiquidExecuteTxManifestParams,
  txid: string,
): LiquidExecuteTxManifestResult {
  return {
    requestId: invocation.requestId,
    chainId: invocation.chainId,
    accountIdentifier: invocation.accountIdentifier,
    bundleHash: invocation.manifest.bundleHash,
    action: invocation.action,
    status: "broadcast",
    txid,
  };
}

async function executeProviderTxManifest(
  origin: string,
  invocation: LiquidExecuteTxManifestParams,
): Promise<LiquidExecuteTxManifestResult> {
  try {
    return await withAuthorizedProviderTxManifestExecution(origin, invocation, {
      loadConnection: migrateLegacyConnection,
      loadWallet: walletInfo,
      disconnect: removeConnectedSite,
      continueExecution: async (connection, info) => {
        const revision = connectionRevision(origin);
        const generation = connectionGeneration;
        const invocationDigest = await taggedCanonicalJsonHash(
          "apogee/tx-manifest-invocation/v1",
          invocation,
        );
        const key = txManifestIdempotencyKey({
          origin,
          accountIdentifier: invocation.accountIdentifier,
          chainId: invocation.chainId,
          requestId: invocation.requestId,
        });
        return txManifestIdempotency.execute(
          key,
          invocationDigest,
          async (idempotencyGeneration) => {
            const plan = await engine<TxManifestRequirementPlan>({
              kind: "resolveTxManifestRequirements",
              invocation,
            });
            const preparedContext = await prepareProviderTxManifest(
              origin,
              connection,
              info,
              revision,
              generation,
              plan,
            );
            const review = await txManifestApprovalReview(preparedContext, info.network);
            const id = `appr-${approvalSeq++}-${Date.now()}`;
            const approval: ApprovalRequest = {
              kind: "executeTxManifest",
              id,
              origin,
              review,
              network: toDappNetwork(info.network),
              locked: keystore.isLocked(),
              signerKind: info.signer,
            };
            return new Promise<LiquidExecuteTxManifestResult>((resolve, reject) => {
              parkApproval(id, {
                kind: "executeTxManifest",
                request: approval,
                origin,
                walletId: info.id,
                descriptor: info.descriptor,
                network: info.network,
                invocation,
                plan,
                expectedPlanDigest: preparedContext.prepared.planDigest,
                reviewedFee: {
                  actualFee: preparedContext.prepared.review.fee,
                  selectionFee: preparedContext.prepared.feeSelectionTarget,
                },
                executionKey: key,
                invocationDigest,
                idempotencyGeneration,
                permissionMethod: LIQUID_WALLET_RPC_METHODS.EXECUTE_TX_MANIFEST,
                revision,
                generation,
                resolve: resolve as (result: unknown) => void,
                reject,
              });
              void routeApproval(approval);
            });
          },
          (txid) => buildTxManifestResult(invocation, txid),
          (checkpoint, idempotencyGeneration) =>
            resumeProviderTxManifest(
              origin,
              invocation,
              info,
              revision,
              generation,
              checkpoint,
              idempotencyGeneration,
            ),
        );
      },
    });
  } catch (error) {
    if (error instanceof LiquidRpcError) throw error;
    throw txManifestExecutionError(error);
  }
}

async function resumeProviderTxManifest(
  origin: string,
  invocation: LiquidExecuteTxManifestParams,
  info: Awaited<ReturnType<typeof walletInfo>>,
  revision: number,
  generation: number,
  checkpoint: TxManifestCheckpointRecord,
  idempotencyGeneration: TxManifestExecutionGeneration,
): Promise<LiquidExecuteTxManifestResult> {
  if (checkpoint.walletId !== info.id || checkpoint.network !== info.network) {
    throw new Error("The TX Manifest checkpoint does not belong to the connected wallet.");
  }
  if (keystore.isLocked()) {
    throw providerError(
      LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
      "Unlock Apogee to resume this previously approved TX Manifest transaction.",
      LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
      { cause: "locked" },
    );
  }
  const payload = parseTxManifestCheckpointPayload(
    await keystore.openTxManifestCheckpoint(
      checkpoint.walletId,
      txManifestCheckpointContext(checkpoint),
      checkpoint.sealedPayload,
    ),
  );
  if (
    payload.result.requestId !== invocation.requestId ||
    payload.result.chainId !== invocation.chainId ||
    payload.result.accountIdentifier !== invocation.accountIdentifier ||
    payload.result.bundleHash !== invocation.manifest.bundleHash ||
    payload.result.action !== invocation.action ||
    payload.result.txid !== payload.txid ||
    payload.review.requestId !== invocation.requestId ||
    payload.review.accountIdentifier !== invocation.accountIdentifier ||
    payload.review.bundleHash !== invocation.manifest.bundleHash ||
    payload.review.action !== invocation.action
  ) {
    throw new Error("The TX Manifest checkpoint does not match this invocation.");
  }

  const status = await lookupTxManifestTransaction(
    checkpoint.network,
    payload.txid,
    await chainServer(checkpoint.network),
  );
  if (status === "found") return payload.result;

  const id = `appr-${approvalSeq++}-${Date.now()}`;
  const approval: ApprovalRequest = {
    kind: "executeTxManifest",
    id,
    origin,
    review: payload.review,
    network: toDappNetwork(info.network),
    locked: false,
    signerKind: info.signer,
    recovery: true,
  };
  return new Promise<LiquidExecuteTxManifestResult>((resolve, reject) => {
    parkApproval(id, {
      kind: "executeTxManifest",
      request: approval,
      origin,
      walletId: info.id,
      descriptor: info.descriptor,
      network: info.network,
      invocation,
      executionKey: checkpoint.key,
      invocationDigest: checkpoint.invocationDigest,
      idempotencyGeneration,
      recovery: payload,
      permissionMethod: LIQUID_WALLET_RPC_METHODS.EXECUTE_TX_MANIFEST,
      revision,
      generation,
      resolve: resolve as (result: unknown) => void,
      reject,
    });
    void routeApproval(approval);
  });
}

async function txManifestBroadcastWasAccepted(
  network: LiquidNetwork,
  txid: string,
  esploraUrl: string | undefined,
  error: unknown,
): Promise<boolean> {
  if (isKnownTxManifestBroadcastError(error)) return true;
  return (await lookupTxManifestTransaction(network, txid, esploraUrl)) === "found";
}

async function prepareProviderTxManifest(
  origin: string,
  connection: StoredProviderConnection,
  info: Awaited<ReturnType<typeof walletInfo>>,
  revision: number,
  generation: number,
  plan: TxManifestRequirementPlan,
  reviewedFee?: ReviewedTxManifestFee,
): Promise<PreparedProviderTxManifest> {
  await engine<SyncResult>({
    kind: "sync",
    descriptor: info.descriptor,
    network: info.network,
    esploraUrl: await chainServer(info.network),
  });
  const policyAssetId = connection.policyAssetId.slice(connection.policyAssetId.lastIndexOf(":") + 1);
  const inspectOutput = (transactionHex: string, vout: number) =>
    engine<TxManifestTransactionOutputInspection>({
      kind: "inspectTxManifestTransactionOutput",
      transactionHex,
      vout,
    });
  const configuredServer = await chainServer(info.network);
  const execution = plan.action === SIMPLICITY_LENDING_V3_ACCEPT_OFFER
    ? await prepareProviderAcceptOffer(
          plan,
          info.descriptor,
          info.network,
          policyAssetId,
          inspectOutput,
          configuredServer,
          reviewedFee,
        )
    : plan.action === SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT
      ? await prepareProviderClaimLenderVault(
          plan,
          info.descriptor,
          info.network,
          policyAssetId,
          inspectOutput,
          configuredServer,
          reviewedFee,
        )
      : await prepareProviderNewLendingAction(
          origin,
          plan,
          info.descriptor,
          info.network,
          policyAssetId,
          inspectOutput,
          configuredServer,
          reviewedFee,
        );
  await requireProviderPsetAuthorization(
    {
      origin,
      walletId: info.id,
      descriptor: info.descriptor,
      network: info.network,
      permissionMethod: LIQUID_WALLET_RPC_METHODS.EXECUTE_TX_MANIFEST,
      revision,
      generation,
    },
    "This site was disconnected while Apogee prepared the TX Manifest.",
    false,
  );
  return execution;
}

async function prepareProviderAcceptOffer(
  plan: AcceptOfferRequirementPlan,
  descriptor: string,
  network: LiquidNetwork,
  policyAssetId: string,
  inspectOutput: (transactionHex: string, vout: number) => Promise<TxManifestTransactionOutputInspection>,
  configuredServer: string | undefined,
  reviewedFee?: ReviewedTxManifestFee,
): Promise<Extract<PreparedProviderTxManifest, { kind: "acceptOffer" }>> {
  const resolved = await resolveAcceptOfferChainSnapshot(
    plan,
    policyAssetId,
    inspectOutput,
    configuredServer,
    txManifestExpectedGenesisHash(network),
  );
  const snapshot = withReviewedTxManifestFee(resolved.snapshot, reviewedFee);
  const prepared = await engine<HostedPreparedAcceptOfferExecution>({
    kind: "prepareLendingV3AcceptOfferWithWallet",
    descriptor,
    network,
    plan,
    chainSnapshot: snapshot,
  });
  return { kind: "acceptOffer", plan, prepared, genesisHash: resolved.snapshot.genesisHash };
}

async function prepareProviderClaimLenderVault(
  plan: ClaimLenderVaultRequirementPlan,
  descriptor: string,
  network: LiquidNetwork,
  policyAssetId: string,
  inspectOutput: (transactionHex: string, vout: number) => Promise<TxManifestTransactionOutputInspection>,
  configuredServer: string | undefined,
  reviewedFee?: ReviewedTxManifestFee,
): Promise<Extract<PreparedProviderTxManifest, { kind: "claimLenderVault" }>> {
  const resolved = await resolveClaimLenderVaultChainSnapshot(
    plan,
    policyAssetId,
    inspectOutput,
    configuredServer,
    txManifestExpectedGenesisHash(network),
  );
  const snapshot = withReviewedTxManifestFee(resolved.snapshot, reviewedFee);
  const prepared = await engine<HostedPreparedClaimLenderVaultExecution>({
    kind: "prepareLendingV3ClaimLenderVaultWithWallet",
    descriptor,
    network,
    plan,
    chainSnapshot: snapshot,
  });
  return { kind: "claimLenderVault", plan, prepared, genesisHash: resolved.snapshot.genesisHash };
}

async function prepareProviderNewLendingAction(
  origin: string,
  plan:
    | CreateFactoryRequirementPlan
    | CreateOfferRequirementPlan
    | ClaimPrincipalRequirementPlan
    | CancelOfferRequirementPlan
    | RepayLoanRequirementPlan
    | LiquidateOfferRequirementPlan,
  descriptor: string,
  network: LiquidNetwork,
  policyAssetId: string,
  inspectOutput: (transactionHex: string, vout: number) => Promise<TxManifestTransactionOutputInspection>,
  configuredServer: string | undefined,
  reviewedFee?: ReviewedTxManifestFee,
): Promise<Extract<PreparedProviderTxManifest, { kind: "newLendingAction" }>> {
  const resolved = await resolveNewLendingActionChainSnapshot(
    plan,
    policyAssetId,
    inspectOutput,
    configuredServer,
    txManifestExpectedGenesisHash(network),
  );
  const snapshot = withReviewedTxManifestFee(resolved.snapshot, reviewedFee);
  const prepared = await engine<HostedPreparedNewLendingExecution>({
    kind: "prepareLendingV3NewActionWithWallet",
    descriptor,
    network,
    assetContractDomain: new URL(origin).hostname.toLowerCase(),
    plan,
    chainSnapshot: snapshot,
  });
  return {
    kind: "newLendingAction",
    plan,
    prepared,
    genesisHash: resolved.snapshot.genesisHash,
  };
}

function withReviewedTxManifestFee<
  T extends { feePolicy: { exactFee?: string; exactSelectionFee?: string } },
>(
  snapshot: T,
  reviewedFee: ReviewedTxManifestFee | undefined,
): T {
  if (reviewedFee === undefined) return snapshot;
  return {
    ...snapshot,
    feePolicy: {
      ...snapshot.feePolicy,
      exactFee: reviewedFee.actualFee,
      exactSelectionFee: reviewedFee.selectionFee,
    },
  };
}

/** Collect every distinct asset id mentioned in a prepared manifest context. */
function manifestAssetIds(context: PreparedProviderTxManifest): string[] {
  const ids = new Set<string>();
  const push = (id: string | undefined) => {
    if (id) ids.add(id);
  };
  push(context.prepared.review.feeAssetId);
  if (context.kind === "acceptOffer") {
    push(context.plan.instance.LENDER_NFT_ASSET_ID);
  }
  const intent = context.plan.intent as unknown as Record<string, unknown>;
  for (const key of [
    "principalAssetId",
    "collateralAssetId",
    "factoryAssetId",
    "borrowerNftAssetId",
    "lenderNftAssetId",
  ]) {
    if (typeof intent[key] === "string") push(intent[key]);
  }
  const review = context.prepared.review as unknown as Record<string, unknown>;
  for (const key of ["factoryAssetId", "borrowerNftAssetId", "lenderNftAssetId"]) {
    if (typeof review[key] === "string") push(review[key]);
  }
  return [...ids];
}

/**
 * Resolve display metadata like the wallet screens do: built-in assets first,
 * then the configured registry, with a shortened-id fallback. Metadata is
 * presentation-only, so a lookup failure must never block contract approval.
 */
async function resolveManifestAssets(
  context: PreparedProviderTxManifest,
  network: LiquidNetwork,
): Promise<Record<string, TxManifestAssetMeta>> {
  const assets: Record<string, TxManifestAssetMeta> = {};
  await Promise.all(
    manifestAssetIds(context).map(async (assetId) => {
      const known = KNOWN_ASSETS[assetId];
      if (known) {
        assets[assetId] = {
          label: known.label,
          ticker: known.label,
          precision: known.precision,
          source: "builtin",
        };
        return;
      }
      try {
        const info = await engine<AssetInfo>({ kind: "getAsset", assetId, network });
        assets[assetId] = {
          label: info.ticker ?? info.name ?? shortenHex(assetId, 6, 6),
          ticker: info.ticker,
          precision: info.precision,
          source: "registry",
        };
      } catch {
        assets[assetId] = {
          label: shortenHex(assetId, 6, 6),
          ticker: null,
          precision: null,
          source: "fallback",
        };
      }
    }),
  );
  return assets;
}

async function txManifestApprovalReview(
  context: PreparedProviderTxManifest,
  network: LiquidNetwork,
): Promise<TxManifestApprovalReviewDTO> {
  const assets = await resolveManifestAssets(context, network);
  const common = {
    protocolLabel: context.plan.intent.protocolLabel,
    actionLabel: context.plan.intent.actionLabel,
    requestId: context.plan.requestId,
    accountIdentifier: context.plan.accountIdentifier,
    bundleHash: context.plan.bundleHash,
    action: context.plan.action,
    feeAssetId: context.prepared.review.feeAssetId,
    fee: context.prepared.review.fee,
    feeChange: context.prepared.review.feeChange,
    assets,
  };
  if (context.kind === "acceptOffer") {
    return {
      ...common,
      kind: "acceptOffer",
      lenderNftAssetId: context.plan.instance.LENDER_NFT_ASSET_ID,
      principalAssetId: context.plan.intent.principalAssetId,
      principalAmount: context.plan.intent.principalAmount,
      collateralAssetId: context.plan.intent.collateralAssetId,
      collateralAmount: context.plan.intent.collateralAmount,
      interestRateBasisPoints: context.plan.intent.interestRateBasisPoints,
      totalDebt: context.plan.intent.totalDebt,
      expirationHeight: context.plan.intent.expirationHeight,
      principalChange: context.prepared.review.principalChange,
    };
  }
  if (context.kind === "claimLenderVault") return {
    ...common,
    kind: "claimLenderVault",
    principalAssetId: context.plan.intent.principalAssetId,
    principalAmount: context.plan.intent.principalAmount,
    grossDebt: context.plan.intent.grossDebt,
    interestAmount: context.plan.intent.interestAmount,
    protocolFeeAmount: context.plan.intent.protocolFeeAmount,
    lenderNftAssetId: context.plan.intent.lenderNftAssetId,
  };
  const prepared = context.prepared;
  if (prepared.kind === "createFactory") {
    return {
      ...common,
      kind: "createFactory",
      factoryAssetId: prepared.review.factoryAssetId,
      fundingAmount: prepared.review.fundingAmount,
    };
  }
  if (prepared.kind === "createOffer") {
    return {
      ...common,
      kind: "createOffer",
      factoryAssetId: prepared.review.factoryAssetId,
      borrowerNftAssetId: prepared.review.borrowerNftAssetId,
      lenderNftAssetId: prepared.review.lenderNftAssetId,
      principalAssetId: prepared.review.principalAssetId,
      principalAmount: prepared.review.principalAmount,
      collateralAssetId: prepared.review.collateralAssetId,
      collateralAmount: prepared.review.collateralAmount,
      interestRateBasisPoints: prepared.review.interestRateBasisPoints,
      totalDebt: prepared.review.totalDebt,
      expirationHeight: prepared.review.expirationHeight,
      collateralChange: prepared.review.collateralChange,
    };
  }
  return {
    ...common,
    kind: prepared.kind,
    principalAssetId: prepared.review.principalAssetId,
    principalAmount: prepared.review.principalAmount,
    collateralAssetId: prepared.review.collateralAssetId,
    collateralAmount: prepared.review.collateralAmount,
    borrowerNftAssetId: prepared.review.borrowerNftAssetId,
    lenderNftAssetId: prepared.review.lenderNftAssetId,
    expirationHeight: prepared.review.expirationHeight,
    ...(prepared.review.totalDebt === undefined ? {} : { totalDebt: prepared.review.totalDebt }),
    ...(prepared.review.interestAmount === undefined ? {} : { interestAmount: prepared.review.interestAmount }),
    ...(prepared.review.protocolFeeAmount === undefined ? {} : { protocolFeeAmount: prepared.review.protocolFeeAmount }),
    ...(prepared.review.lenderVaultAmount === undefined ? {} : { lenderVaultAmount: prepared.review.lenderVaultAmount }),
    principalChange: prepared.review.principalChange,
  };
}

function txManifestExecutionError(error: unknown): LiquidRpcError {
  const message = error instanceof Error ? error.message : String(error);
  console.debug("[apogee] TX Manifest execution failed:", message);
  if (/already used for different request data/i.test(message)) {
    return providerError(
      LIQUID_RPC_ERROR_CODES.INVALID_PARAMS,
      message,
      LIQUID_RPC_ERROR_REASONS.INVALID_PARAMS,
      { path: "params.requestId" },
    );
  }
  if (/saved TX Manifest transaction is no longer valid/i.test(message)) {
    return providerError(
      LIQUID_RPC_ERROR_CODES.INTERNAL_ERROR,
      "This saved TX Manifest transaction is no longer valid. Submit the action again with a new requestId.",
      LIQUID_RPC_ERROR_REASONS.INTERNAL_ERROR,
      { method: LIQUID_WALLET_RPC_METHODS.EXECUTE_TX_MANIFEST, cause: "checkpoint_invalid" },
    );
  }
  if (/reviewed fee|execution plan changed after approval/i.test(message)) {
    return providerError(
      LIQUID_RPC_ERROR_CODES.INTERNAL_ERROR,
      "Network fees or wallet state changed. Review the TX Manifest request again.",
      LIQUID_RPC_ERROR_REASONS.INTERNAL_ERROR,
      { method: LIQUID_WALLET_RPC_METHODS.EXECUTE_TX_MANIFEST, cause: "review_changed" },
    );
  }
  if (/unknown|unsupported|not enabled|bundle|argument|providedInputs|fee cap/i.test(message)) {
    return providerError(
      LIQUID_RPC_ERROR_CODES.UNSUPPORTED_CAPABILITY,
      "This TX Manifest bundle, action, or constraint is not supported by Apogee.",
      LIQUID_RPC_ERROR_REASONS.UNSUPPORTED_CAPABILITY,
      { method: LIQUID_WALLET_RPC_METHODS.EXECUTE_TX_MANIFEST },
    );
  }
  if (/no single principal|no distinct L-BTC|not an unspent coin owned|insufficient|too fragmented/i.test(message)) {
    return providerError(
      LIQUID_RPC_ERROR_CODES.INTERNAL_ERROR,
      "The connected wallet has insufficient suitable funds for this manifest action and fee.",
      LIQUID_RPC_ERROR_REASONS.INTERNAL_ERROR,
      { method: LIQUID_WALLET_RPC_METHODS.EXECUTE_TX_MANIFEST, cause: "insufficient_funds" },
    );
  }
  if (/broadcast|\b5\d\d\b|gateway/i.test(message)) {
    return providerError(
      LIQUID_RPC_ERROR_CODES.CHAIN_UNAVAILABLE,
      "Apogee could not confirm submission of the saved transaction. Retry the same requestId to recover safely.",
      LIQUID_RPC_ERROR_REASONS.CHAIN_UNAVAILABLE,
      {
        method: LIQUID_WALLET_RPC_METHODS.EXECUTE_TX_MANIFEST,
        cause: "broadcast_unconfirmed",
      },
    );
  }
  if (/chain server|fetch|network|confirmed|already spent|outpoint/i.test(message)) {
    return providerError(
      LIQUID_RPC_ERROR_CODES.CHAIN_UNAVAILABLE,
      "Apogee could not verify the requested covenant inputs against current chain state.",
      LIQUID_RPC_ERROR_REASONS.CHAIN_UNAVAILABLE,
      { method: LIQUID_WALLET_RPC_METHODS.EXECUTE_TX_MANIFEST },
    );
  }
  return providerError(
    LIQUID_RPC_ERROR_CODES.INTERNAL_ERROR,
    "Apogee could not safely execute this TX Manifest request.",
    LIQUID_RPC_ERROR_REASONS.INTERNAL_ERROR,
    { method: LIQUID_WALLET_RPC_METHODS.EXECUTE_TX_MANIFEST },
  );
}

function providerPsetAnalysisError(
  result: Extract<ProviderPsetAnalysisResultDTO, { ok: false }>,
): LiquidRpcError {
  if (result.reason === "analysis_failed") {
    return providerError(
      LIQUID_RPC_ERROR_CODES.INTERNAL_ERROR,
      "Apogee could not inspect this PSET safely.",
      LIQUID_RPC_ERROR_REASONS.INTERNAL_ERROR,
      { method: LIQUID_WALLET_RPC_METHODS.SIGN_PSET, cause: result.reason },
    );
  }
  const unsupported = new Set([
    "non_policy_fee",
    "private_or_unsupported_script",
    "unreviewable_output",
    "unsupported_issuance",
    "unsupported_sighash",
  ]);
  const data = {
    method: LIQUID_WALLET_RPC_METHODS.SIGN_PSET,
    cause: result.reason,
    ...(result.inputIndex === undefined ? {} : { inputIndex: result.inputIndex }),
  };
  return unsupported.has(result.reason)
    ? providerError(
        LIQUID_RPC_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        "This PSET uses a transaction feature Apogee cannot safely sign.",
        LIQUID_RPC_ERROR_REASONS.UNSUPPORTED_CAPABILITY,
        data,
      )
    : providerError(
        LIQUID_RPC_ERROR_CODES.INVALID_PARAMS,
        "This PSET does not match the connected wallet or the requested signing inputs.",
        LIQUID_RPC_ERROR_REASONS.INVALID_PARAMS,
        data,
      );
}

function providerPsetSigningError(
  result: Extract<ProviderPsetSignResultDTO, { ok: false }>,
): LiquidRpcError {
  const reason = result.reason;
  if (reason === "review_changed") {
    return providerError(
      LIQUID_RPC_ERROR_CODES.INTERNAL_ERROR,
      "The wallet or PSET review changed before signing. Review the request again.",
      LIQUID_RPC_ERROR_REASONS.INTERNAL_ERROR,
      { method: LIQUID_WALLET_RPC_METHODS.SIGN_PSET, cause: reason },
    );
  }
  if (reason === "signing_failed") {
    return providerError(
      LIQUID_RPC_ERROR_CODES.INTERNAL_ERROR,
      "Apogee could not sign this PSET.",
      LIQUID_RPC_ERROR_REASONS.INTERNAL_ERROR,
      { method: LIQUID_WALLET_RPC_METHODS.SIGN_PSET, cause: reason },
    );
  }
  return providerPsetAnalysisError({
    ok: false,
    reason,
    ...(result.inputIndex === undefined ? {} : { inputIndex: result.inputIndex }),
  });
}

function standardTransferPreparationError(error: unknown): LiquidRpcError {
  const message = error instanceof Error ? error.message : String(error);
  if (/insufficient|not enough|need lbtc/i.test(message)) {
    return providerError(
      LIQUID_RPC_ERROR_CODES.INTERNAL_ERROR,
      "The connected wallet has insufficient funds for this transfer and its network fee.",
      LIQUID_RPC_ERROR_REASONS.INTERNAL_ERROR,
      { cause: "insufficient_funds" },
    );
  }
  if (/unconfidential address/i.test(message)) {
    return providerError(
      LIQUID_RPC_ERROR_CODES.INVALID_PARAMS,
      "Apogee requires a confidential recipient address.",
      LIQUID_RPC_ERROR_REASONS.INVALID_PARAMS,
      { path: "params.recipientAddress" },
    );
  }
  if (/address|network/i.test(message)) {
    return providerError(
      LIQUID_RPC_ERROR_CODES.INVALID_PARAMS,
      "The recipient address is invalid or belongs to a different network.",
      LIQUID_RPC_ERROR_REASONS.INVALID_PARAMS,
      { path: "params.recipientAddress" },
    );
  }
  console.debug("[apogee] sendTransfer preparation failed:", message);
  return providerError(
    LIQUID_RPC_ERROR_CODES.INTERNAL_ERROR,
    "Apogee could not prepare this transfer.",
    LIQUID_RPC_ERROR_REASONS.INTERNAL_ERROR,
  );
}

/**
 * Requests from a connected web page (relayed by the content bridge). The page
 * only ever gets watch-only material; signing/secrets stay in the keystore.
 * `origin` is the page's origin (sender.origin) — trusted, set by Chrome.
 * Standard connections pin an account, chain, and exact grant; the legacy
 * façade adapts to the same record while preserving its response shapes.
 */
async function handleProvider(msg: ProviderRequest, origin: string | undefined): Promise<unknown> {
  await keystore.ensureLoaded();
  switch (msg.type) {
    case "provider/rpc":
      return handleStandardProvider(msg.request, origin);

    case "provider/connect": {
      const state = await keystore.getState();
      if (!state.initialized || state.wallets.length === 0) {
        throw new Error("No wallet in Apogee yet. Open Apogee to create or restore one, then connect.");
      }
      const existing = await migrateLegacyConnection(origin);
      if (existing?.legacy) return legacyAccount(existing);
      const info = existing
        ? await walletInfo(existing.walletId)
        : (state.wallets.find((wallet) => wallet.id === state.activeWalletId) ?? state.wallets[0]);
      // Page-safe account only. The descriptor (SLIP-77 blinding key + xpub) must
      // never cross the content bridge into the page — see ProviderAccount.
      const account: ProviderAccount = {
        network: toDappNetwork(info.network),
        masterFingerprint: info.fingerprint,
        signerKind: info.signer,
      };
      const base = existing ?? (await buildConnection(info.id, [], [], false));
      const connection: StoredProviderConnection = {
        ...base,
        legacy: true,
        permissions: {
          methods: [...new Set([...base.permissions.methods, LIQUID_WALLET_RPC_METHODS.GET_BALANCE])],
          events: [...base.permissions.events],
        },
      };
      const id = `appr-${approvalSeq++}-${Date.now()}`;
      const request: ApprovalRequest = {
        kind: "connect",
        id,
        origin: origin ?? "an unknown site",
        network: account.network,
        fingerprint: account.masterFingerprint,
        signerKind: account.signerKind,
        locked: keystore.isLocked(),
        methods: [...connection.permissions.methods],
        events: [...connection.permissions.events],
        legacy: true,
      };
      return await new Promise<ProviderAccount>((resolve, reject) => {
        parkApproval(id, {
          kind: "connect",
          request,
          origin,
          connection,
          result: account,
          revision: origin ? connectionRevision(origin) : 0,
          generation: connectionGeneration,
          resolve: resolve as (r: unknown) => void,
          reject,
        });
        void routeApproval(request);
      });
    }

    case "provider/disconnect": {
      await removeConnectedSite(origin);
      return;
    }

    case "provider/getAccount": {
      const connection = await migrateLegacyConnection(origin);
      return connection?.legacy ? legacyAccount(connection) : null;
    }

    case "provider/getNewAddress": {
      const connection = await requireLegacyConnection(origin);
      const info = await walletInfo(connection.walletId);
      return engine<AddressDTO>({
        kind: "getAddress",
        descriptor: info.descriptor,
        network: info.network,
      });
    }

    case "provider/getStatus": {
      await requireLegacyConnection(origin);
      const state = await keystore.getState();
      const status: ProviderStatus = { locked: state.locked };
      return status;
    }

    case "provider/getBalance": {
      const connection = await requireLegacyConnection(origin);
      // A locked wallet doesn't serve a balance — the dapp shows a locked state
      // and re-asks once unlocked (it polls getStatus). This also avoids handing
      // a balance to a page without the user having unlocked.
      const state = await keystore.getState();
      if (state.locked) {
        const locked: ProviderBalance = { locked: true, lbtcSats: null, assets: {} };
        return locked;
      }
      const info = await walletInfo(connection.walletId);
      // Fresh chain sync so a connected dapp sees the current balance.
      const result = await engine<SyncResult>({
        kind: "sync",
        descriptor: info.descriptor,
        network: info.network,
        esploraUrl: await chainServer(info.network),
      });
      // Surface the full per-asset map too (LBTC + tokens); the dapp filters
      // LBTC out and resolves token metadata via provider/getAssetInfo.
      const balance: ProviderBalance = {
        locked: false,
        lbtcSats: result.lbtcSats,
        assets: result.balance,
      };
      return balance;
    }

    case "provider/getAssetInfo": {
      const connection = await requireLegacyConnection(origin);
      // Best-effort registry metadata (name/ticker/precision) for a token the
      // dapp saw in the balance map, on the connected wallet's network.
      const info = await walletInfo(connection.walletId);
      return engine<AssetInfo>({
        kind: "getAsset",
        assetId: msg.assetId,
        network: info.network,
      });
    }

    case "provider/send": {
      const connection = await requireLegacyConnection(origin);
      // `drain` ignores `sats` (the built PSET moves the whole balance). For a
      // fixed send `sats` feeds the TxBuilder, so require a sane positive integer —
      // a dapp can pass anything, and BigInt() would otherwise throw a raw error.
      if (!msg.drain && (!Number.isSafeInteger(msg.sats) || msg.sats <= 0)) {
        throw new Error("Invalid send amount.");
      }
      const info = await walletInfo(connection.walletId);
      // Watch-only wallets can't sign — refuse before building a PSET or raising
      // an approval, so the dapp gets an immediate error and the user never sees
      // an approvable prompt for a wallet that can't spend.
      if (info.signer === "watch") {
        throw new Error("Watch-only wallets can't sign or send.");
      }
      // Build the spend now (watch-only — works even while locked) so the approval
      // shows the real fee. Signing waits until the user approves: a local wallet
      // signs in the offscreen engine, a Jade signs on-device in a tab.
      const prepared = await engine<PrepareSendResult>({
        kind: "prepareSend",
        descriptor: info.descriptor,
        network: info.network,
        address: msg.address,
        sats: msg.sats,
        drain: msg.drain,
      });
      const id = `appr-${approvalSeq++}-${Date.now()}`;
      const request: ApprovalRequest = {
        kind: "send",
        id,
        origin: origin ?? "an unknown site",
        review: {
          address: msg.address,
          recipientAmount: prepared.recipientAmount,
          feeAmount: prepared.feeAmount,
          drain: Boolean(msg.drain),
          toSelf: prepared.toSelf,
        },
        network: toDappNetwork(info.network),
        // A Jade signs on-device, so there's no unlock-to-sign for it.
        locked: info.signer === "jade" ? false : keystore.isLocked(),
        signerKind: info.signer,
      };
      // Resolve once the user approves (sign + broadcast) or rejects.
      return await new Promise<SendResult>((resolve, reject) => {
        parkApproval(id, {
          kind: "send",
          request,
          origin,
          walletId: info.id,
          descriptor: info.descriptor,
          network: info.network,
          pset: prepared.pset,
          revision: origin ? connectionRevision(origin) : 0,
          generation: connectionGeneration,
          resolve: resolve as (r: unknown) => void,
          reject,
        });
        void routeApproval(request);
      });
    }
  }
}

// ---- dapp spend approvals (legacy window.liquid send) ----------------------
//
// A dapp spend or sign request waits here for the user to approve it in Apogee
// — as an overlay inside the side panel if it's open, otherwise in a standalone
// popup window. Sends always sign + broadcast; signPset either returns a signed
// PSET or, when the reviewed request explicitly opts in, finalizes and broadcasts
// it too. The map is in-memory: the open dapp message port keeps the SW alive for
// the (brief) approval. TX Manifest execution additionally persists exact signed
// bytes before broadcast, so an identical retry can recover after worker loss.

type PendingApproval =
  | {
      kind: "connect";
      request: Extract<ApprovalRequest, { kind: "connect" }>;
      origin: string | undefined;
      connection: StoredProviderConnection;
      result: unknown;
      revision: number;
      generation: number;
      resolve: (result: unknown) => void;
      reject: (err: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
      windowId?: number; // popup window hosting this approval, if any
    }
  | {
      kind: "send";
      request: Extract<ApprovalRequest, { kind: "send" }>;
      origin: string | undefined;
      walletId: string;
      descriptor: string;
      network: LiquidNetwork;
      pset: string;
      /** Present for standard RPC sends; legacy sends require a legacy connection. */
      permissionMethod?: string;
      revision: number;
      generation: number;
      resolve: (result: unknown) => void;
      reject: (err: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
      windowId?: number;
    }
  | {
      kind: "signPset";
      request: Extract<ApprovalRequest, { kind: "signPset" }>;
      origin: string;
      walletId: string;
      descriptor: string;
      network: LiquidNetwork;
      pset: string;
      signInputs: ProviderPsetSignInputDTO[];
      expectedAnalysis: ProviderPsetAnalysisDTO;
      broadcast: boolean;
      permissionMethod: string;
      revision: number;
      generation: number;
      resolve: (result: unknown) => void;
      reject: (err: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
      windowId?: number;
    }
  | ({
      kind: "executeTxManifest";
      request: Extract<ApprovalRequest, { kind: "executeTxManifest" }>;
      origin: string;
      walletId: string;
      descriptor: string;
      network: LiquidNetwork;
      invocation: LiquidExecuteTxManifestParams;
      executionKey: string;
      invocationDigest: `sha256:${string}`;
      idempotencyGeneration: TxManifestExecutionGeneration;
      permissionMethod: string;
      revision: number;
      generation: number;
      resolve: (result: unknown) => void;
      reject: (err: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
      windowId?: number;
    } & (
      | {
          recovery?: undefined;
          plan: TxManifestRequirementPlan;
          expectedPlanDigest: `sha256:${string}`;
          reviewedFee: ReviewedTxManifestFee;
        }
      | {
          recovery: TxManifestCheckpointPayload;
        }
    ));

interface ProviderPsetAuthorizationContext {
  origin: string;
  walletId: string;
  descriptor: string;
  network: LiquidNetwork;
  permissionMethod: string;
  revision: number;
  generation: number;
}

async function requireProviderPsetAuthorization(
  context: ProviderPsetAuthorizationContext,
  disconnectedMessage: string,
  requireUnlocked: boolean,
): Promise<void> {
  const current =
    context.generation === connectionGeneration &&
    context.revision === connectionRevision(context.origin)
      ? (await getProviderConnections())[context.origin]
      : undefined;
  if (
    !current ||
    current.walletId !== context.walletId ||
    !current.permissions.methods.includes(context.permissionMethod)
  ) {
    throw providerError(
      LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
      disconnectedMessage,
      LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
    );
  }
  if (requireUnlocked && keystore.isLocked()) {
    throw providerError(
      LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
      "Apogee locked before it could broadcast the signed transaction.",
      LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
      { cause: "locked" },
    );
  }
}

async function broadcastSignedProviderPset(
  context: ProviderPsetAuthorizationContext,
  signedPset: string,
  requireUnlocked: boolean,
  beforeBroadcast?: () => Promise<void> | void,
): Promise<string> {
  let esploraUrl: string | undefined;
  const txid = await finalizeAndBroadcastProviderPset(signedPset, {
    finalize: (pset) =>
      engine<string>({
        kind: "finalizePset",
        descriptor: context.descriptor,
        network: context.network,
        pset,
      }),
    authorize: async () => {
      // Resolve the effective server, then perform an early check so a revoked
      // request does not wait unnecessarily for the engine queue.
      esploraUrl = await chainServer(context.network);
      await requireProviderPsetAuthorization(
        context,
        "This site was disconnected before Apogee could broadcast the transaction.",
        requireUnlocked,
      );
    },
    broadcast: async (pset) => {
      const sent = await engineAfterGate<SendResult>(
        {
          kind: "broadcastPset",
          network: context.network,
          pset,
          esploraUrl,
        },
        async () => {
          await requireProviderPsetAuthorization(
            context,
            "This site was disconnected before Apogee could broadcast the transaction.",
            requireUnlocked,
          );
          await beforeBroadcast?.();
        },
      );
      return sent.txid;
    },
  });
  browser.runtime.sendMessage({ type: "apogee/balance-changed" }).catch(() => {});
  return txid;
}

const pendingApprovals = new Map<string, PendingApproval>();
let approvalSeq = 0;

// How long an approval may sit undecided. The page provider's own timeout is
// deliberately LONGER (see liquid-provider.ts), so this expiry always fires
// first — an approval can never be granted after the dapp already gave up,
// which would sign + broadcast a transaction the dapp thinks failed.
// (setTimeout dies with the SW, but so does the in-memory map it guards.)
const APPROVAL_TTL_MS = 240_000; // 4 minutes

function rejectedApprovalError(pending: PendingApproval): Error {
  if (pending.kind === "connect") {
    return providerError(
      LIQUID_RPC_ERROR_CODES.USER_REJECTED,
      "You rejected the connection.",
      LIQUID_RPC_ERROR_REASONS.USER_REJECTED,
    );
  }
  if (pending.kind === "signPset") {
    return providerError(
      LIQUID_RPC_ERROR_CODES.USER_REJECTED,
      "You rejected the PSET signing request.",
      LIQUID_RPC_ERROR_REASONS.USER_REJECTED,
    );
  }
  if (pending.kind === "executeTxManifest") {
    return providerError(
      LIQUID_RPC_ERROR_CODES.USER_REJECTED,
      "You rejected the TX Manifest execution request.",
      LIQUID_RPC_ERROR_REASONS.USER_REJECTED,
    );
  }
  return pending.permissionMethod
    ? providerError(
        LIQUID_RPC_ERROR_CODES.USER_REJECTED,
        "You rejected the transfer.",
        LIQUID_RPC_ERROR_REASONS.USER_REJECTED,
      )
    : new Error("You rejected the transaction.");
}

/** Park an approval and start its expiry clock. */
function parkApproval(id: string, entry: PendingApproval): void {
  pendingApprovals.set(id, entry);
  entry.timer = setTimeout(() => {
    if (!pendingApprovals.delete(id)) return; // already decided
    entry.reject(
      providerError(
        LIQUID_RPC_ERROR_CODES.INTERNAL_ERROR,
        "This approval request timed out.",
        LIQUID_RPC_ERROR_REASONS.INTERNAL_ERROR,
      ),
    );
    // Clear whichever surface is showing it: the side-panel overlay dismisses
    // itself on this broadcast; a popup window is closed outright (its
    // onRemoved handler finds the map entry gone and no-ops).
    browser.runtime.sendMessage({ type: "apogee/approval-expired", id }).catch(() => {});
    if (entry.windowId !== undefined) browser.windows.remove(entry.windowId).catch(() => {});
  }, APPROVAL_TTL_MS);
}

/** Reject + drop pending approvals for `origin` (or all, when origin is
 *  undefined), so a revoked or reset site's parked request fails immediately
 *  instead of sitting approvable. Both approval variants carry `origin`. */
function rejectPendingApprovals(origin: string | undefined, reason: string): void {
  for (const [id, p] of pendingApprovals) {
    if (origin === undefined || p.origin === origin) {
      pendingApprovals.delete(id);
      clearTimeout(p.timer);
      p.reject(
        p.kind === "connect" || p.permissionMethod
          ? providerError(
              LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
              reason,
              LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
            )
          : new Error(reason),
      );
      browser.runtime.sendMessage({ type: "apogee/approval-expired", id }).catch(() => {});
      if (p.windowId !== undefined) browser.windows.remove(p.windowId).catch(() => {});
    }
  }
  for (const [id, p] of pendingJadeSigns) {
    if (p.kind === "signPset" && (origin === undefined || p.origin === origin)) {
      takeJadeSign(id);
      p.reject(
        providerError(
          LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
          reason,
          LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
        ),
      );
    }
  }
}

/** Show the approval in the side panel (overlay) when open, else a popup window. */
async function routeApproval(request: ApprovalRequest): Promise<void> {
  // If the side panel is open, show the approval as an overlay there; otherwise
  // fall through to a popup window.
  const panels = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.SIDE_PANEL],
  });
  if (panels.length > 0) {
    browser.runtime.sendMessage({ type: "apogee/approval-request", request }).catch(() => {});
    return;
  }
  const win = await browser.windows.create({
    url: browser.runtime.getURL(`src/prompt/prompt.html?id=${encodeURIComponent(request.id)}`),
    type: "popup",
    width: 380,
    height: 620,
  });
  // Closing the popup without deciding fails the request, so the dapp won't hang.
  const winId = win?.id;
  if (winId === undefined) return;
  // Remember the window so the TTL expiry can close it.
  const parked = pendingApprovals.get(request.id);
  if (parked) parked.windowId = winId;
  const onClosed = (closedId: number) => {
    if (closedId !== winId) return;
    browser.windows.onRemoved.removeListener(onClosed);
    const p = pendingApprovals.get(request.id);
    if (p) {
      pendingApprovals.delete(request.id);
      clearTimeout(p.timer);
      p.reject(rejectedApprovalError(p));
    }
  };
  browser.windows.onRemoved.addListener(onClosed);
}

/** Apply the user's decision: reject, connect, or perform the approved signing action. */
async function handleApprovalDecision(
  id: string,
  approved: boolean,
  password?: string,
): Promise<
  | SendResult
  | LiquidSignPsetResult
  | LiquidExecuteTxManifestResult
  | { ok: true }
  | { rejected: true }
> {
  const pending = pendingApprovals.get(id);
  if (!pending) throw new Error("This approval expired. Try again from the app.");
  pendingApprovals.delete(id);
  clearTimeout(pending.timer);
  if (!approved) {
    pending.reject(rejectedApprovalError(pending));
    return { rejected: true };
  }
  if (pending.kind === "connect") {
    // A locked wallet must not authorize a new site (guards the stale-overlay /
    // popup-after-lock case; the side panel also clears the overlay on lock).
    if (keystore.isLocked()) {
      const err = providerError(
        LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
        "Unlock Apogee to connect this site.",
        LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
        { cause: "locked" },
      );
      pending.reject(err);
      throw err;
    }
    if (!pending.origin) {
      const err = providerError(
        LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
        "The calling origin could not be authenticated.",
        LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
      );
      pending.reject(err);
      throw err;
    }
    // Record the exact, pinned connection before resolving or announcing it.
    const connected = await setProviderConnection(
      pending.origin,
      pending.connection,
      pending.revision,
      pending.generation,
    );
    if (!connected) {
      const err = providerError(
        LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
        "This site was disconnected while the approval was open.",
        LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
      );
      pending.reject(err);
      throw err;
    }
    pending.resolve(pending.result);
    return { ok: true };
  }
  // Re-validate the session at decision time: the site may have been revoked
  // while this approval sat open. removeConnectedSite/reset also proactively
  // rejects pending approvals; this closes the approve-vs-revoke race.
  const revisionMatches =
    pending.generation === connectionGeneration &&
    (pending.origin === undefined || pending.revision === connectionRevision(pending.origin));
  const connection = !revisionMatches
    ? null
    : pending.permissionMethod && pending.origin
      ? (await getProviderConnections())[pending.origin] ?? null
      : await requireLegacyConnection(pending.origin).catch(() => null);
  const authorized =
    connection &&
    connection.walletId === pending.walletId &&
    (!pending.permissionMethod || connection.permissions.methods.includes(pending.permissionMethod));
  if (!authorized) {
    const err = pending.permissionMethod
      ? providerError(
          LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
          pending.kind === "signPset"
            ? "This site is no longer authorized to request PSET signatures."
            : pending.kind === "executeTxManifest"
              ? "This site is no longer authorized to execute this TX Manifest."
              : "This site is no longer authorized to send this transfer.",
          LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
        )
      : new Error("This site is no longer connected.");
    pending.reject(err);
    throw err;
  }
  const info = await walletInfo(pending.walletId);
  // Watch-only wallets can't sign — refuse the action outright.
  if (info.signer === "watch") {
    const err = pending.permissionMethod
      ? providerError(
          LIQUID_RPC_ERROR_CODES.UNSUPPORTED_CAPABILITY,
          pending.kind === "signPset"
            ? "The connected wallet is watch-only and cannot sign PSETs."
            : pending.kind === "executeTxManifest"
              ? "The connected wallet is watch-only and cannot execute TX Manifests."
              : "The connected wallet is watch-only and cannot send transfers.",
          LIQUID_RPC_ERROR_REASONS.UNSUPPORTED_CAPABILITY,
          { method: pending.permissionMethod, cause: "watch_only" },
        )
      : new Error("Watch-only wallets can't sign or send.");
    pending.reject(err);
    throw err;
  }

  if (pending.kind === "executeTxManifest") {
    if (info.signer !== "local") {
      const err = providerError(
        LIQUID_RPC_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        "This TX Manifest action currently requires an Apogee software wallet.",
        LIQUID_RPC_ERROR_REASONS.UNSUPPORTED_CAPABILITY,
        { method: pending.permissionMethod, cause: info.signer },
      );
      pending.reject(err);
      throw err;
    }
    if (keystore.isLocked()) {
      const err = providerError(
        LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
        "Unlock Apogee to approve this TX Manifest execution.",
        LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
        { cause: "locked" },
      );
      pending.reject(err);
      throw err;
    }
    if (
      (await autoLockMinutes()) === 0 &&
      (!password || !(await keystore.verifyPassword(password)))
    ) {
      const err = providerError(
        LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
        "Enter your password to approve this TX Manifest execution.",
        LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
        { cause: "step_up_required" },
      );
      pending.reject(err);
      throw err;
    }
    try {
      if (pending.recovery) {
        await requireProviderPsetAuthorization(
          pending,
          "This site was disconnected before Apogee could resume the manifest transaction.",
          true,
        );
        const esploraUrl = await chainServer(pending.network);
        const status = await lookupTxManifestTransaction(
          pending.network,
          pending.recovery.txid,
          esploraUrl,
        );
        if (status !== "found") {
          let sent: SendResult;
          try {
            sent = await engineAfterGate<SendResult>(
              {
                kind: "broadcastTransaction",
                network: pending.network,
                transactionHex: pending.recovery.transactionHex,
                esploraUrl,
              },
              async () => {
                await requireProviderPsetAuthorization(
                  pending,
                  "This site was disconnected before Apogee could resume the manifest transaction.",
                  true,
                );
                txManifestIdempotency.assertActive(pending.idempotencyGeneration);
              },
            );
          } catch (error) {
            if (
              await txManifestBroadcastWasAccepted(
                pending.network,
                pending.recovery.txid,
                esploraUrl,
                error,
              )
            ) {
              sent = { txid: pending.recovery.txid };
            } else {
              if (isPermanentTxManifestBroadcastError(error)) {
                const details = error instanceof Error ? error.message : String(error);
                await txManifestIdempotency.failCheckpoint(
                  pending.executionKey,
                  pending.invocationDigest,
                  details,
                  pending.idempotencyGeneration,
                );
                throw new Error(
                  `This saved TX Manifest transaction is no longer valid. Submit the action again with a new requestId. ${details}`,
                );
              }
              throw error;
            }
          }
          if (sent.txid !== pending.recovery.txid) {
            throw new Error("The chain server returned a different transaction id after broadcast.");
          }
        }
        pending.resolve(pending.recovery.result);
        browser.runtime.sendMessage({ type: "apogee/balance-changed" }).catch(() => {});
        return pending.recovery.result;
      }

      const refreshed = await prepareProviderTxManifest(
        pending.origin,
        connection,
        info,
        pending.revision,
        pending.generation,
        pending.plan,
        pending.reviewedFee,
      );
      if (refreshed.prepared.planDigest !== pending.expectedPlanDigest) {
        throw new Error("The wallet or chain execution plan changed after approval.");
      }
      if (keystore.isLocked()) {
        throw providerError(
          LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
          "Apogee locked while it was revalidating this TX Manifest execution.",
          LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
          { cause: "locked" },
        );
      }
      const signedPset = await engine<string>({
        kind: "signTxManifestPset",
        mnemonic: await keystore.getMnemonic(pending.walletId),
        descriptor: pending.descriptor,
        network: pending.network,
        pset: refreshed.prepared.pset,
      });
      const finalizedPset = await engine<string>({
        kind: "finalizePset",
        descriptor: pending.descriptor,
        network: pending.network,
        pset: signedPset,
      });
      const extracted = await engine<{ transactionHex: string; txid: string }>({
        kind: "extractPsetTransaction",
        pset: finalizedPset,
      });
      if (refreshed.kind === "acceptOffer") {
        await engine<true>({
          kind: "dryRunLendingV3AcceptOffer",
          transactionHex: extracted.transactionHex,
          parentTransactions: refreshed.prepared.parentTransactions,
          genesisHash: refreshed.genesisHash,
          covenants: refreshed.prepared.covenants,
        });
      } else if (refreshed.kind === "claimLenderVault") {
        await engine<true>({
          kind: "dryRunLendingV3ClaimLenderVault",
          transactionHex: extracted.transactionHex,
          parentTransactions: refreshed.prepared.parentTransactions,
          genesisHash: refreshed.genesisHash,
          vault: refreshed.prepared.vault,
        });
      } else {
        for (const covenant of refreshed.prepared.covenantExecutions) {
          await engine<true>({
            kind: "dryRunTxManifestCovenant",
            spec: {
              ...covenant,
              transaction_hex: extracted.transactionHex,
              parent_transactions: refreshed.prepared.parentTransactions,
            },
          });
        }
      }
      const result = buildTxManifestResult(pending.invocation, extracted.txid);
      await requireProviderPsetAuthorization(
        pending,
        "This site was disconnected before Apogee could broadcast the manifest transaction.",
        true,
      );
      const esploraUrl = await chainServer(pending.network);
      const checkpointMetadata = {
        key: pending.executionKey,
        invocationDigest: pending.invocationDigest,
        walletId: pending.walletId,
        network: pending.network,
      };
      const checkpointPayload: TxManifestCheckpointPayload = {
        version: 1,
        transactionHex: extracted.transactionHex,
        txid: extracted.txid,
        result,
        review: pending.request.review,
      };
      const sealedPayload = await keystore.sealTxManifestCheckpoint(
        pending.walletId,
        txManifestCheckpointContext(checkpointMetadata),
        JSON.stringify(checkpointPayload),
      );
      // The durable boundary: no chain-server submission is attempted unless
      // these exact signed bytes can be recovered after service-worker loss.
      await txManifestIdempotency.checkpoint(
        { ...checkpointMetadata, sealedPayload },
        pending.idempotencyGeneration,
      );
      let sent: SendResult;
      try {
        sent = await engineAfterGate<SendResult>(
          {
            kind: "broadcastTransaction",
            network: pending.network,
            transactionHex: extracted.transactionHex,
            esploraUrl,
          },
          async () => {
            await requireProviderPsetAuthorization(
              pending,
              "This site was disconnected before Apogee could broadcast the manifest transaction.",
              true,
            );
            txManifestIdempotency.assertActive(pending.idempotencyGeneration);
          },
        );
      } catch (error) {
        if (
          await txManifestBroadcastWasAccepted(
            pending.network,
            extracted.txid,
            esploraUrl,
            error,
          )
        ) {
          sent = { txid: extracted.txid };
        } else {
          if (isPermanentTxManifestBroadcastError(error)) {
            const details = error instanceof Error ? error.message : String(error);
            await txManifestIdempotency.failCheckpoint(
              pending.executionKey,
              pending.invocationDigest,
              details,
              pending.idempotencyGeneration,
            );
            throw new Error(
              `This saved TX Manifest transaction is no longer valid. Submit the action again with a new requestId. ${details}`,
            );
          }
          throw error;
        }
      }
      if (sent.txid !== extracted.txid) {
        throw new Error("The chain server returned a different transaction id after broadcast.");
      }
      pending.resolve(result);
      browser.runtime.sendMessage({ type: "apogee/balance-changed" }).catch(() => {});
      return result;
    } catch (error) {
      const err = error instanceof LiquidRpcError ? error : txManifestExecutionError(error);
      pending.reject(err);
      throw err;
    }
  }

  if (pending.kind === "signPset") {
    if (info.signer !== "jade" && keystore.isLocked()) {
      const err = providerError(
        LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
        "Unlock Apogee to approve this PSET signature.",
        LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
        { cause: "locked" },
      );
      pending.reject(err);
      throw err;
    }
    if (
      info.signer !== "jade" &&
      (await autoLockMinutes()) === 0 &&
      (!password || !(await keystore.verifyPassword(password)))
    ) {
      const err = providerError(
        LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
        "Enter your password to approve this PSET signature.",
        LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
        { cause: "step_up_required" },
      );
      pending.reject(err);
      throw err;
    }

    try {
      // Refresh current UTXOs after the user has reviewed the request. Local
      // signing re-runs the analyzer and signs the same parsed PSET atomically;
      // Jade gets an equivalent review binding across its device round-trip.
      await engine<SyncResult>({
        kind: "sync",
        descriptor: pending.descriptor,
        network: pending.network,
        esploraUrl: await chainServer(pending.network),
      });
      await requireProviderPsetAuthorization(
        pending,
        "This site was disconnected while Apogee refreshed the PSET.",
        false,
      );

      let result: LiquidSignPsetResult;
      if (info.signer === "jade") {
        const analyzed = await engine<ProviderPsetAnalysisResultDTO>({
          kind: "analyzeProviderPset",
          descriptor: pending.descriptor,
          network: pending.network,
          pset: pending.pset,
          signInputs: pending.signInputs,
        });
        if (!analyzed.ok) throw providerPsetAnalysisError(analyzed);
        if (!providerPsetReviewsMatch(pending.expectedAnalysis, analyzed.analysis)) {
          throw providerPsetSigningError({ ok: false, reason: "review_changed" });
        }
        result = await signProviderPsetWithJade(
          pending,
          info.fingerprint,
          analyzed.pset,
        );
      } else {
        const signed = await engine<ProviderPsetSignResultDTO>({
          kind: "signProviderPset",
          mnemonic: await keystore.getMnemonic(pending.walletId),
          descriptor: pending.descriptor,
          network: pending.network,
          pset: pending.pset,
          signInputs: pending.signInputs,
          expectedAnalysis: pending.expectedAnalysis,
        });
        if (!signed.ok) throw providerPsetSigningError(signed);
        result = { pset: signed.pset };
      }
      if (pending.broadcast) {
        if (info.signer === "jade") {
          if (!result.txid) {
            throw providerError(
              LIQUID_RPC_ERROR_CODES.INTERNAL_ERROR,
              "Jade completed the signature but not the approved broadcast.",
              LIQUID_RPC_ERROR_REASONS.INTERNAL_ERROR,
            );
          }
        } else {
          const txid = await broadcastSignedProviderPset(pending, result.pset, true);
          result = { pset: result.pset, txid };
        }
      } else {
        await requireProviderPsetAuthorization(
          pending,
          "This site was disconnected before Apogee could return the signature.",
          false,
        );
      }
      pending.resolve(result);
      return result;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      pending.reject(err);
      throw err;
    }
  }

  // A Jade wallet signs sends on the device — no seed here, and no
  // unlock-to-sign (the device is the gate). The existing send-only Jade path
  // finalizes and broadcasts after the signature returns.
  if (info.signer === "jade") {
    const summary: SendReview = pending.request.review;
    try {
      const result = await signWithJade(
        pending.pset,
        pending.descriptor,
        pending.network,
        info.fingerprint,
        summary,
      );
      pending.resolve(result);
      return result;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      pending.reject(err);
      throw err;
    }
  }
  if (keystore.isLocked()) {
    const err = pending.permissionMethod
      ? providerError(
          LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
          "Unlock Apogee to approve this transfer.",
          LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
          { cause: "locked" },
        )
      : new Error("Unlock Apogee to approve this transaction.");
    pending.reject(err);
    throw err;
  }
  // A never-auto-locking wallet stays unlocked indefinitely, so step up auth on
  // sends (Jade signs on-device, handled above).
  if ((await autoLockMinutes()) === 0) {
    if (!password || !(await keystore.verifyPassword(password))) {
      const err = pending.permissionMethod
        ? providerError(
            LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
            "Enter your password to approve this transfer.",
            LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
            { cause: "step_up_required" },
          )
        : new Error("Enter your password to approve this send.");
      pending.reject(err);
      throw err;
    }
  }
  try {
    const mnemonic = await keystore.getMnemonic(pending.walletId);
    const result = await engine<SendResult>({
      kind: "signBroadcast",
      mnemonic,
      descriptor: pending.descriptor,
      network: pending.network,
      pset: pending.pset,
      esploraUrl: await chainServer(pending.network),
    });
    pending.resolve(result);
    // Tell open surfaces (the side panel) to re-sync now instead of waiting for
    // the periodic poll, so the balance updates right after a dapp send.
    browser.runtime.sendMessage({ type: "apogee/balance-changed" }).catch(() => {});
    return result;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    pending.reject(err);
    throw err;
  }
}

// ---- Jade on-device signing (E3) -------------------------------------------
//
// A Jade wallet keeps no seed in Apogee — it signs on the device. Web Serial is
// only available in a top-level tab, so the SW opens a Jade signing tab and
// hands it the PSET. A send is finalized + broadcast after return; signPset is
// validated against its approved effects and either returned or, when the
// approval explicitly opted in, finalized and broadcast before it is returned.

interface PendingJadeSign {
  kind: "send" | "signPset";
  pset: string; // the PSET to sign; the tab fetches it via apogee/jade-sign-get
  descriptor: string; // watch-only descriptor — validates/finalizes the signed PSET
  network: LiquidNetwork;
  fingerprint: string; // expected wallet fingerprint — the tab verifies the device matches
  summary: SendReview | ProviderPsetApprovalReviewDTO;
  resolve: (value: string | LiquidSignPsetResult) => void;
  reject: (err: Error) => void;
  broadcast?: boolean;
  signInputs?: ProviderPsetSignInputDTO[];
  expectedAnalysis?: ProviderPsetAnalysisDTO;
  origin?: string;
  walletId?: string;
  permissionMethod?: string;
  revision?: number;
  generation?: number;
  completing?: boolean;
  tabId?: number;
  timer?: ReturnType<typeof setTimeout>;
}
type CompletePendingJadeProviderSign = PendingJadeSign & {
  kind: "signPset";
  broadcast: boolean;
  signInputs: ProviderPsetSignInputDTO[];
  expectedAnalysis: ProviderPsetAnalysisDTO;
  origin: string;
  walletId: string;
  permissionMethod: string;
  revision: number;
  generation: number;
};

function assertCompleteJadeProviderSign(
  pending: PendingJadeSign,
): asserts pending is CompletePendingJadeProviderSign {
  if (
    pending.kind !== "signPset" ||
    typeof pending.broadcast !== "boolean" ||
    !pending.origin ||
    !pending.walletId ||
    !pending.permissionMethod ||
    pending.revision === undefined ||
    pending.generation === undefined ||
    !pending.signInputs ||
    !pending.expectedAnalysis
  ) {
    throw providerError(
      LIQUID_RPC_ERROR_CODES.INTERNAL_ERROR,
      "The Jade signing authorization is incomplete.",
      LIQUID_RPC_ERROR_REASONS.INTERNAL_ERROR,
    );
  }
}
const pendingJadeSigns = new Map<string, PendingJadeSign>();
let jadeSignSeq = 0;

// A signing tab left idle (device never connected, tab forgotten) must expire.
// For a dapp send this prevents a late broadcast after the caller gave up; for
// signPset it prevents returning a signature after authorization changed. The
// provider timeout is longer than approval + device time (see liquid-provider.ts).
const JADE_SIGN_TTL_MS = 360_000; // 6 minutes

/** Drop a pending Jade sign and clear its expiry clock. */
function takeJadeSign(id: string): PendingJadeSign | undefined {
  const p = pendingJadeSigns.get(id);
  if (!p) return undefined;
  pendingJadeSigns.delete(id);
  clearTimeout(p.timer);
  return p;
}

/** Open a Jade signing tab for a send and await the broadcast txid. The tab
 *  signs on-device and posts the signature back; the handler then finalizes +
 *  broadcasts it. Rejects if the user closes the tab or the device fails. */
async function signWithJade(
  pset: string,
  descriptor: string,
  network: LiquidNetwork,
  fingerprint: string,
  summary: SendReview,
): Promise<SendResult> {
  const id = `jsign-${jadeSignSeq++}-${Date.now()}`;
  const txid = await new Promise<string>((resolve, reject) => {
    const pending: PendingJadeSign = {
      kind: "send",
      pset,
      descriptor,
      network,
      fingerprint,
      summary,
      resolve: (value) => resolve(String(value)),
      reject,
    };
    pendingJadeSigns.set(id, pending);
    pending.timer = setTimeout(() => {
      const p = takeJadeSign(id);
      // The tab (if still open) errors on its next message; don't yank it away.
      p?.reject(new Error("Jade signing timed out. Try the send again."));
    }, JADE_SIGN_TTL_MS);
    browser.tabs
      .create({
        url: browser.runtime.getURL(
          `src/jade/jade.html?sign=${encodeURIComponent(id)}&network=${encodeURIComponent(network)}`,
        ),
      })
      .then((tab) => {
        pending.tabId = tab.id;
      })
      .catch((e) => {
        takeJadeSign(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
  });
  return { txid };
}

async function signProviderPsetWithJade(
  approval: Extract<PendingApproval, { kind: "signPset" }>,
  fingerprint: string,
  enrichedPset: string,
): Promise<LiquidSignPsetResult> {
  const id = `jsign-${jadeSignSeq++}-${Date.now()}`;
  return await new Promise<LiquidSignPsetResult>((resolve, reject) => {
    const pending: PendingJadeSign = {
      kind: "signPset",
      // analyzeProviderPset calls LWK addDetails() before returning this copy.
      // Jade needs those trusted prevout and derivation fields to recognize and
      // sign wallet inputs when the dapp supplied a minimal PSET.
      pset: enrichedPset,
      descriptor: approval.descriptor,
      network: approval.network,
      fingerprint,
      summary: approval.request.review,
      signInputs: approval.signInputs.map((input) => ({
        ...input,
        ...(input.sighashTypes ? { sighashTypes: [...input.sighashTypes] } : {}),
      })),
      expectedAnalysis: approval.expectedAnalysis,
      broadcast: approval.broadcast,
      origin: approval.origin,
      walletId: approval.walletId,
      permissionMethod: approval.permissionMethod,
      revision: approval.revision,
      generation: approval.generation,
      resolve: (value) => resolve(value as LiquidSignPsetResult),
      reject,
    };
    pendingJadeSigns.set(id, pending);
    pending.timer = setTimeout(() => {
      const p = takeJadeSign(id);
      p?.reject(new Error("Jade signing timed out. Ask the app to request the signature again."));
    }, JADE_SIGN_TTL_MS);
    browser.tabs
      .create({
        url: browser.runtime.getURL(
          `src/jade/jade.html?sign=${encodeURIComponent(id)}&network=${encodeURIComponent(approval.network)}`,
        ),
      })
      .then((tab) => {
        pending.tabId = tab.id;
      })
      .catch((e) => {
        takeJadeSign(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
  });
}

async function validateJadeProviderSignature(
  pending: PendingJadeSign,
  signedPset: string,
): Promise<void> {
  assertCompleteJadeProviderSign(pending);
  await requireProviderPsetAuthorization(
    pending,
    "This site is no longer authorized to receive the Jade signature.",
    false,
  );
  await engine<SyncResult>({
    kind: "sync",
    descriptor: pending.descriptor,
    network: pending.network,
    esploraUrl: await chainServer(pending.network),
  });
  const analyzed = await engine<ProviderPsetAnalysisResultDTO>({
    kind: "analyzeProviderPset",
    descriptor: pending.descriptor,
    network: pending.network,
    pset: signedPset,
    signInputs: pending.signInputs,
  });
  if (!analyzed.ok) throw providerPsetAnalysisError(analyzed);
  if (!providerPsetReviewsMatch(pending.expectedAnalysis, analyzed.analysis)) {
    throw providerPsetSigningError({ ok: false, reason: "review_changed" });
  }
  await requireProviderPsetAuthorization(
    pending,
    "This site is no longer authorized to receive the Jade signature.",
    false,
  );
}

// Closing the signing tab before it returns a signature cancels the send.
browser.tabs.onRemoved.addListener((tabId) => {
  if (tabId === guideTabId) guideTabId = null;
  for (const [id, p] of pendingJadeSigns) {
    if (p.tabId === tabId) {
      takeJadeSign(id);
      p.reject(new Error("Jade signing was cancelled."));
    }
  }
});

// Point-to-point ports (runtime.connect). Unlike an untargeted sendMessage —
// which fans out to every extension context — a port delivers frames only to
// the two connected ends, which is what any secret-bearing traffic requires.
browser.runtime.onConnect.addListener((port) => {
  // Offscreen document → engine channel. A co-installed extension can connect to
  // us by id, so check the sender before accepting engine frames — the engine
  // signs and broadcasts whatever a request carries (mirrors the message router's
  // origin gate and the pre-port sender check this replaces).
  if (port.name === ENGINE_PORT_NAME) {
    if (port.sender?.id !== browser.runtime.id || port.sender?.origin !== EXT_ORIGIN) {
      port.disconnect();
      return;
    }
    const conn: EngineConn = { port, inFlight: new Map() };
    // Two live ports shouldn't be representable, but if the offscreen document
    // reconnected before the old document's disconnect landed, close the old
    // one explicitly rather than leaking it — its late disconnect now settles
    // only its own (by then empty) in-flight map.
    if (engineConn) engineConn.port.disconnect();
    engineConn = conn;
    port.onMessage.addListener((msg: unknown) => {
      const reply = msg as EnginePortReply;
      const settle = conn.inFlight.get(reply.id);
      if (settle) {
        conn.inFlight.delete(reply.id);
        settle(reply);
      }
    });
    port.onDisconnect.addListener(() => {
      if (engineConn === conn) engineConn = null;
      // Settle THIS connection's in-flight requests as a hard failure — the
      // request may have run, so re-sending it (e.g. a broadcast) is never
      // safe. A superseded connection's map is empty or already settled.
      for (const [, settle] of conn.inFlight) {
        settle({ id: -1, ok: false, error: "The wallet engine stopped. Reopen Apogee to try again." });
      }
      conn.inFlight.clear();
      for (const wake of enginePortWaiters.splice(0)) wake();
    });
    for (const wake of enginePortWaiters.splice(0)) wake();
    return;
  }
  // Secret-bearing UI traffic — `wallet/restore` (plaintext mnemonic) and
  // `apogee/qr-secret` (scanned seed phrase) — both of which must not fan out on
  // the broadcast channel. Anything else on this port is closed unanswered.
  if (port.name === SECRET_PORT_NAME) {
    if (port.sender?.origin !== EXT_ORIGIN || port.sender?.id !== browser.runtime.id) {
      port.disconnect();
      return;
    }
    port.onMessage.addListener((msg: unknown) => {
      const req = msg as UiRequest | { type: "apogee/qr-secret"; value?: unknown };
      if (req?.type === "apogee/qr-secret") {
        // Same parking semantics the broadcast handler used: module-level memory,
        // one claim, time-boxed (see lib/qr-secret.ts).
        if (typeof req.value === "string" && req.value.length > 0) {
          qrSecret = { value: req.value, at: Date.now() };
        }
        port.postMessage({ ok: true });
        return;
      }
      if (req?.type !== "wallet/restore") {
        port.disconnect();
        return;
      }
      handleUi(req)
        .then((value) => {
          port.postMessage({ ok: true, value });
          // Mirror the broadcast router: restore is genuine user activity, so it
          // re-arms the idle auto-lock.
          void rescheduleAutoLock();
        })
        .catch((err: unknown) => {
          port.postMessage({ ok: false, error: errMsg(err) });
        });
    });
    return;
  }
  port.disconnect(); // unknown channel — don't leave it open
});

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (typeof msg?.type !== "string") return false;
  // Trust boundary: wallet/* and apogee/* are extension-internal — they come from
  // our own surfaces (side panel, approval prompt, Jade signing tab) and must
  // never be honored from a content script / web page. provider/* is the only
  // web-facing surface and is authenticated by sender.origin in handleProvider.
  // Key on ORIGIN, not sender.tab: the Jade tab is an extension page opened as a
  // tab, so it legitimately has sender.tab set while sharing our origin.
  const fromExtension = sender.origin === EXT_ORIGIN && sender.id === browser.runtime.id;
  if (!fromExtension && (msg.type.startsWith("wallet/") || msg.type.startsWith("apogee/"))) {
    return false; // drop silently — don't confirm the probe to an untrusted page
  }
  // Approval popup / side-panel overlay fetching + deciding a pending spend.
  if (msg.type === "apogee/get-approval") {
    const p = pendingApprovals.get(msg.id);
    sendResponse(p ? { ok: true, value: p.request } : { ok: false, error: "This approval expired." });
    return false;
  }
  if (msg.type === "apogee/approval-decision") {
    handleApprovalDecision(msg.id, Boolean(msg.approved), msg.password)
      .then((value) => sendResponse({ ok: true, value }))
      .catch((err: unknown) => sendResponse({ ok: false, error: errMsg(err) }));
    return true;
  }
  // Jade signing tab: fetch the PSET + review summary to display.
  if (msg.type === "apogee/jade-sign-get") {
    const p = pendingJadeSigns.get(msg.id);
    sendResponse(
      p
        ? {
            ok: true,
            mode: p.kind,
            pset: p.pset,
            fingerprint: p.fingerprint,
            summary: p.summary,
            broadcast: p.kind === "signPset" ? p.broadcast === true : true,
          }
        : { ok: false, error: "This signing request expired. Try the send again from Apogee." },
    );
    return false;
  }
  // The tab returns the on-device signature. Provider signPset requests are
  // revalidated and either returned or broadcast according to the approved
  // request; sends are always finalized and broadcast below.
  if (msg.type === "apogee/jade-signed") {
    const p = pendingJadeSigns.get(msg.id);
    if (!p) {
      sendResponse({ ok: false, error: "This signing request expired." });
      return false;
    }
    if (p.kind === "signPset") {
      if (p.completing) {
        sendResponse({ ok: false, error: "This Jade signature is already being checked." });
        return false;
      }
      p.completing = true;
      const signedPset = String(msg.pset);
      validateJadeProviderSignature(p, signedPset)
        .then(async () => {
          assertCompleteJadeProviderSign(p);
          let result: LiquidSignPsetResult;
          if (p.broadcast) {
            const txid = await broadcastSignedProviderPset(p, signedPset, false, () => {
              if (takeJadeSign(msg.id) !== p) {
                throw providerError(
                  LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
                  "This signing request was revoked before Jade could broadcast it.",
                  LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
                );
              }
            });
            result = { pset: signedPset, txid };
          } else {
            if (takeJadeSign(msg.id) !== p) {
              throw providerError(
                LIQUID_RPC_ERROR_CODES.UNAUTHORIZED,
                "This signing request was revoked before Jade finished.",
                LIQUID_RPC_ERROR_REASONS.UNAUTHORIZED,
              );
            }
            result = { pset: signedPset };
          }
          p.resolve(result);
          sendResponse({ ok: true, signed: true, txid: result.txid });
        })
        .catch((e) => {
          takeJadeSign(msg.id);
          const err = e instanceof Error ? e : new Error(String(e));
          p.reject(err);
          sendResponse({ ok: false, error: err.message });
        });
      return true;
    }
    takeJadeSign(msg.id);
    chainServer(p.network)
      .then((esploraUrl) =>
        engine<SendResult>({
          kind: "finalizeBroadcast",
          descriptor: p.descriptor,
          network: p.network,
          pset: String(msg.pset),
          esploraUrl,
        }),
      )
      .then((res) => {
        p.resolve(res.txid);
        browser.runtime.sendMessage({ type: "apogee/balance-changed" }).catch(() => {});
        sendResponse({ ok: true, txid: res.txid });
      })
      .catch((e) => {
        const err = e instanceof Error ? e : new Error(String(e));
        p.reject(err);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // async sendResponse (finalize + broadcast)
  }
  if (msg.type === "apogee/jade-sign-failed") {
    const p = takeJadeSign(msg.id);
    if (p) {
      p.reject(new Error(typeof msg.error === "string" && msg.error ? msg.error : "Jade signing failed."));
    }
    sendResponse({ ok: true });
    return false;
  }
  // The scanner's seed-phrase hand-off (`apogee/qr-secret`) deliberately does
  // NOT have a broadcast case anymore: the phrase arrives on the dedicated
  // apogee-secret port (see onConnect), so it never fans out to other contexts.
  if (msg.type === "apogee/qr-secret-claim") {
    // Single-use AND time-boxed: read it out, then immediately clear regardless of
    // whether it was still fresh, so a stale value can never be claimed twice.
    const { value, next } = claimSecret(qrSecret, Date.now());
    qrSecret = next;
    sendResponse({ ok: true, value });
    return true;
  }

  if (msg.type.startsWith("wallet/")) {
    // Port-only at runtime, not just at the type level: `wallet/restore`
    // carries a plaintext mnemonic, and handleUi still knows how to service
    // it (the secret port calls the same handler). Refuse it here so the
    // broadcast channel can never carry one — mirrors the removed
    // `apogee/qr-secret` broadcast case above.
    if (msg.type === "wallet/restore") {
      sendResponse({ ok: false, error: "restore is not available on this channel" });
      return false;
    }
    const req = msg as WalletRequest;
    handleUi(req)
      .then((value) => {
        sendResponse({ ok: true, value });
        // Only genuine user actions defer the idle lock — not passive polling
        // (see AUTOLOCK_DEFERRING). Explicit lock/reset clears the alarm instead.
        if (req.type === "wallet/lock" || req.type === "wallet/reset") {
          void browser.alarms.clear(AUTOLOCK_ALARM);
        } else if (AUTOLOCK_DEFERRING.has(req.type)) {
          void rescheduleAutoLock();
        }
      })
      .catch((err: unknown) => sendResponse({ ok: false, error: errMsg(err) }));
    return true; // async sendResponse
  }
  if (msg.type.startsWith("provider/")) {
    const request = msg as ProviderRequest;
    handleProvider(request, sender.origin)
      .then((value) => sendResponse({ ok: true, value }))
      .catch((err: unknown) =>
        sendResponse({
          ok: false,
          error:
            request.type === "provider/rpc"
              ? serializeLiquidRpcError(err)
              : providerErrMsg(err),
        }),
      );
    return true; // async sendResponse
  }
  return false;
});

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Errors returned to a connected dapp page are sanitized: only our own intentional,
// user-facing messages pass through; anything else (raw lwk_wasm / engine internals)
// is genericized so wallet internals don't leak to an untrusted origin. The raw
// message is logged for debugging. The wallet/* and approval-decision paths keep
// errMsg — they serve extension-internal surfaces.
const PROVIDER_SAFE_ERRORS = new Set([
  "NOT_CONNECTED",
  "No wallet in Apogee yet. Open Apogee to create or restore one, then connect.",
  "Invalid send amount.",
  "You rejected the connection.",
  "You rejected the transaction.",
  "Unlock Apogee to approve this transaction.",
  "Unlock Apogee to connect this site.",
  "This site is no longer connected.",
  "This site was disconnected.",
  "Apogee was reset.",
  "Jade signing was cancelled.",
  "Jade signing timed out. Try the send again.",
  "This approval request timed out.",
]);

function providerErrMsg(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  if (PROVIDER_SAFE_ERRORS.has(m)) return m;
  console.debug("[apogee] provider error (genericized):", m);
  return "Apogee request failed.";
}
