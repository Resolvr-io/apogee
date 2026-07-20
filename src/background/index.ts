// Service worker — the extension backend. It:
//  - wires the toolbar action to open the side panel,
//  - hosts the keystore (the seed-of-record; see src/keystore),
//  - manages the offscreen engine document's lifecycle, and
//  - routes wallet requests from the side panel / prompt, brokering each one
//    between the keystore (secrets) and the offscreen engine (lwk_wasm).
//
// Auto-lock alarms and provider/prompt orchestration land in later tasks.

import type { LiquidNetwork } from "@/keystore/keystore";
import * as keystore from "@/keystore/keystore";
import { DEBUG_ENTERPRISE_BUILD, DEBUG_ENTERPRISE_KEY, ENTERPRISE_ROOTS } from "@/lib/debug";
import { SCAN_STATE_DB } from "@/engine/protocol";
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
  PrepareSendResult,
  ProviderAccount,
  ProviderBalance,
  ProviderRequest,
  ProviderStatus,
  SendResult,
  SendReview,
  SyncResult,
  WalletRequest,
  WalletTxDTO,
} from "@/engine/protocol";

// This extension's own origin. Privileged wallet/* and apogee/* messages are
// only honored when they come from one of our own pages (side panel, approval
// prompt, Jade tab) — see the onMessage router. A content script injected into a
// web page carries the page's origin, so this cleanly excludes web pages.
const EXT_ORIGIN = `chrome-extension://${chrome.runtime.id}`;

chrome.runtime.onInstalled.addListener(() => {
  console.log("[apogee] installed");
  // On reload/update, drop any persisted offscreen document so the next engine
  // call rebuilds it from the new code. Without this, a surviving offscreen keeps
  // running stale engine logic after a reload (a known MV3 quirk).
  void closeOffscreen();
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
  const v = (await chrome.storage.local.get(AUTOLOCK_KEY))[AUTOLOCK_KEY];
  return typeof v === "number" ? v : DEFAULT_AUTOLOCK_MINUTES;
}

// Last time the idle window was reset (unlock / genuine user activity). The alarm
// is coarse and can fire early, so on fire we re-check elapsed against this and
// re-arm for the remainder instead of trusting the alarm's timing.
let lastActivityAt = 0;

/** Clear + (re)create the alarm for the given delay (minutes). No-op while the
 *  wallet is locked or when the delay is non-positive ("never"). */
async function armAutoLock(delayMinutes: number): Promise<void> {
  await chrome.alarms.clear(AUTOLOCK_ALARM);
  if (delayMinutes > 0 && !keystore.isLocked()) {
    await chrome.alarms.create(AUTOLOCK_ALARM, { delayInMinutes: delayMinutes });
  }
}

/** Reset the idle window to now and arm the alarm for the full timeout. Called
 *  only after a genuine user action (see AUTOLOCK_DEFERRING + wallet/touch) so
 *  the side panel's periodic balance poll can't keep an unattended wallet open. */
async function rescheduleAutoLock(): Promise<void> {
  const minutes = await autoLockMinutes();
  if (minutes <= 0) {
    await chrome.alarms.clear(AUTOLOCK_ALARM);
    return;
  }
  lastActivityAt = Date.now();
  await armAutoLock(minutes);
}

// wallet/* messages that count as genuine user activity and so defer the idle
// auto-lock. Passive/polled reads (getState, sync, getTransactions, getBalance,
// getRate, getAsset, qr, getConnectedSites, getAutoLock) are intentionally
// excluded — otherwise the side panel's 20s balance poll would re-arm the alarm
// forever and an unattended wallet would never idle-lock while the panel is open.
// Allowlist, so any type not listed fails secure (does not defer the lock).
const AUTOLOCK_DEFERRING = new Set<WalletRequest["type"]>([
  "wallet/unlock",
  "wallet/create",
  "wallet/restore",
  "wallet/addHardwareWallet",
  "wallet/addWatchOnlyWallet",
  "wallet/prepareSend",
  "wallet/send",
  "wallet/revealMnemonic",
  "wallet/verifyPassword",
  "wallet/setAutoLock",
  "wallet/setChainServer",
  "wallet/getAddress",
  "wallet/disconnectSite",
  "wallet/touch",
]);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== AUTOLOCK_ALARM) return;
  const minutes = await autoLockMinutes();
  // The alarm is coarse and may fire early — only lock once the idle window has
  // truly elapsed since the last activity; otherwise re-arm for the remainder.
  const remainingMs = minutes * 60_000 - (Date.now() - lastActivityAt);
  if (remainingMs > 0) {
    await armAutoLock(remainingMs / 60_000);
    return;
  }
  void keystore.lock().then(() => {
    // Drop the side panel to the lock screen (ignored if none is open).
    chrome.runtime.sendMessage({ type: "apogee/locked" }).catch(() => {});
  });
});

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
    const dbg = (await chrome.storage.local.get(DEBUG_ENTERPRISE_KEY))[DEBUG_ENTERPRISE_KEY];
    if (dbg === true) return ENTERPRISE_ROOTS[network] ?? undefined;
  }
  const v = (await chrome.storage.local.get(CHAINSERVER_KEY))[CHAINSERVER_KEY];
  const url = v && typeof v === "object" ? (v as Record<string, unknown>)[network] : undefined;
  return typeof url === "string" && url !== "" ? url : undefined;
}

// ---- offscreen engine lifecycle --------------------------------------------

const OFFSCREEN_URL = "src/offscreen/offscreen.html";
let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
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
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (existing.length > 0) await chrome.offscreen.closeDocument().catch(() => {});
}

/** Send a request to the offscreen engine and unwrap its reply. */
// Serialize engine calls. lwk_wasm objects (Wollet/Signer) can't be used
// re-entrantly: two overlapping fullScan/applyUpdate calls on the same cached
// Wollet panic with "recursive use of an object … unsafe aliasing in rust".
// With a second caller now in play (the dapp provider alongside the side panel),
// a chain ensures only one engine op runs at a time.
let engineQueue: Promise<unknown> = Promise.resolve();

/** One engine round-trip, outside the serial queue. Only for ops that touch no
 *  Wollet (getRate, qr) — those can't hit the re-entrancy panic, and keeping
 *  them out of the queue means a slow price source can't stall a sync (or
 *  anything queued behind one). */
async function engineDirect<T>(req: EngineRequest): Promise<T> {
  await ensureOffscreen();
  const reply = await chrome.runtime.sendMessage({ target: "offscreen", req });
  if (!reply?.ok) throw new Error(reply?.error ?? "engine error");
  return reply.value as T;
}

async function engine<T>(req: EngineRequest): Promise<T> {
  const run = engineQueue.then(async () => {
    await ensureOffscreen();
    const reply = await chrome.runtime.sendMessage({ target: "offscreen", req });
    if (!reply?.ok) throw new Error(reply?.error ?? "engine error");
    return reply.value as T;
  });
  // Keep the chain alive even if this call rejects, so one failure doesn't wedge
  // the queue.
  engineQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---- wallet operations (keystore + engine) ---------------------------------

/** Resolve a wallet record (defaults to the active wallet). */
async function walletInfo(walletId?: string) {
  const id = walletId || (await keystore.getActiveWalletId());
  if (!id) throw new Error("no active wallet");
  const info = (await keystore.getState()).wallets.find((w) => w.id === id);
  if (!info) throw new Error("unknown wallet");
  return info;
}

async function handleUi(msg: WalletRequest): Promise<unknown> {
  await keystore.ensureLoaded(); // recover unlocked state after SW eviction
  switch (msg.type) {
    case "wallet/getState":
      return keystore.getState();

    case "wallet/initializeKeystore":
      return keystore.initialize(msg.password);

    case "wallet/unlock":
      return keystore.unlock(msg.password);

    case "wallet/lock":
      return keystore.lock();

    case "wallet/reset": {
      // Revoke connected dapp sessions on a wipe, so any connected app
      // disconnects (its next call gets NOT_CONNECTED) instead of going stale.
      await chrome.storage.session.remove(SITES_KEY);
      broadcastSitesChanged();
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
      return keystore.reset();
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
      try {
        if (msg.replace) {
          // Same session cleanup as wallet/reset: the restored vault is a new
          // wallet, so connected sites must not silently carry over to it, and
          // any parked approval (holding a snapshot of the old wallet) must not
          // stay approvable.
          await chrome.storage.session.remove(SITES_KEY);
          broadcastSitesChanged();
          rejectPendingApprovals(undefined, "Apogee was reset.");
          await keystore.reset();
        }
        if (msg.password && !(await keystore.isInitialized())) {
          await keystore.initialize(msg.password);
        }
        return await keystore.addWallet({
          mnemonic,
          descriptor: derived.descriptor,
          fingerprint: derived.fingerprint,
          label: msg.label,
          network: msg.network,
        });
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

    case "wallet/revealMnemonic": {
      // Step-up auth: verifyPassword re-derives + checks the password, but the
      // returned seed comes from the in-memory unlocked cache (getMnemonic), not a
      // fresh decrypt — the wallet is already unlocked here.
      if (!(await keystore.verifyPassword(msg.password))) throw new Error("Incorrect password");
      return keystore.getMnemonic(msg.walletId);
    }

    case "wallet/getRate":
      return engineDirect<number>({ kind: "getRate", currency: msg.currency });

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
      const v = (await chrome.storage.local.get(CHAINSERVER_KEY))[CHAINSERVER_KEY];
      const map = v && typeof v === "object" ? { ...(v as Record<string, string>) } : {};
      if (url) map[msg.network] = url;
      else delete map[msg.network];
      await chrome.storage.local.set({ [CHAINSERVER_KEY]: map });
      return;
    }

    case "wallet/getAutoLock":
      return autoLockMinutes();

    case "wallet/setAutoLock":
      await chrome.storage.local.set({ [AUTOLOCK_KEY]: msg.minutes });
      return;

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
        return signWithJade(msg.pset, info.descriptor, info.network, info.fingerprint, {
          address: msg.review?.address ?? "",
          recipientSats: msg.review?.recipientSats ?? 0,
          fee: msg.review?.fee ?? 0,
          drain: msg.review?.drain ?? false,
          // Token-send display fields (absent for L-BTC) — the Jade tab renders
          // the asset amount and id; the device itself is the signed truth.
          assetId: msg.review?.assetId,
          assetTicker: msg.review?.assetTicker,
          assetPrecision: msg.review?.assetPrecision,
        });
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
        mnemonic: keystore.getMnemonic(info.id),
        descriptor: info.descriptor,
        network: info.network,
        pset: msg.pset,
        esploraUrl: await chainServer(info.network),
      });
      // Nudge the side panel to poll the balance to settlement instead of
      // waiting for the periodic auto-sync.
      chrome.runtime.sendMessage({ type: "apogee/balance-changed" }).catch(() => {});
      return sent;
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

// ---- dapp provider (window.apogee) requests --------------------------------

/** Internal network → the standard names a connected dapp expects. */
function toDappNetwork(n: LiquidNetwork): DappNetwork {
  return n === "liquid" ? "mainnet" : n === "liquidtestnet" ? "testnet" : "regtest";
}

// Connected dapp origins (window.apogee). Tracked in session storage so the side
// panel can show + revoke them; cleared on browser restart.
const SITES_KEY = "apogee_connected_sites";

async function getConnectedSites(): Promise<string[]> {
  const v = (await chrome.storage.session.get(SITES_KEY))[SITES_KEY];
  return Array.isArray(v) ? (v as string[]) : [];
}

function broadcastSitesChanged(): void {
  chrome.runtime.sendMessage({ type: "apogee/sites-changed" }).catch(() => {});
}

async function addConnectedSite(origin: string | undefined): Promise<void> {
  if (!origin) return;
  const sites = await getConnectedSites();
  if (!sites.includes(origin)) {
    await chrome.storage.session.set({ [SITES_KEY]: [...sites, origin] });
    broadcastSitesChanged();
  }
}

async function removeConnectedSite(origin: string | undefined): Promise<void> {
  if (!origin) return;
  const sites = await getConnectedSites();
  if (sites.includes(origin)) {
    await chrome.storage.session.set({ [SITES_KEY]: sites.filter((s) => s !== origin) });
    broadcastSitesChanged();
  }
  // Fail any parked approval for this origin so a revoked site can't still be
  // approved — its dapp promise rejects immediately.
  rejectPendingApprovals(origin, "This site was disconnected.");
}

/**
 * Requests from a connected web page (relayed by the content bridge). The page
 * only ever gets watch-only material; signing/secrets stay in the keystore.
 * `origin` is the page's origin (sender.origin) — trusted, set by Chrome.
 * Per-site approval prompts (connect/sign) land in a follow-up — for now connect
 * returns the active wallet's watch-only account and records the origin.
 */
async function handleProvider(msg: ProviderRequest, origin: string | undefined): Promise<unknown> {
  await keystore.ensureLoaded();
  // Every call except connect/disconnect requires an approved session for this
  // origin. Revoking a site from the side panel therefore actually cuts it off
  // (the dapp gets NOT_CONNECTED and treats itself as disconnected).
  if (
    msg.type !== "provider/connect" &&
    msg.type !== "provider/disconnect" &&
    msg.type !== "provider/getAccount"
  ) {
    const sites = await getConnectedSites();
    if (!origin || !sites.includes(origin)) throw new Error("NOT_CONNECTED");
  }
  switch (msg.type) {
    case "provider/connect": {
      const state = await keystore.getState();
      if (!state.initialized || state.wallets.length === 0) {
        throw new Error("No wallet in Apogee yet. Open Apogee to create or restore one, then connect.");
      }
      const info = state.wallets.find((w) => w.id === state.activeWalletId) ?? state.wallets[0];
      // Page-safe account only. The descriptor (SLIP-77 blinding key + xpub) must
      // never cross the content bridge into the page — see ProviderAccount.
      const account: ProviderAccount = {
        network: toDappNetwork(info.network),
        masterFingerprint: info.fingerprint,
        signerKind: info.signer,
      };
      // Already approved? Reconnect silently. Otherwise ask the user to approve
      // this site (overlay if the side panel is open, else a popup).
      const sites = await getConnectedSites();
      if (origin && sites.includes(origin)) return account;
      const id = `appr-${approvalSeq++}-${Date.now()}`;
      const request: ApprovalRequest = {
        kind: "connect",
        id,
        origin: origin ?? "an unknown site",
        network: account.network,
        fingerprint: account.masterFingerprint,
        signerKind: account.signerKind,
        locked: keystore.isLocked(),
      };
      return await new Promise<ProviderAccount>((resolve, reject) => {
        parkApproval(id, {
          kind: "connect",
          request,
          origin,
          account,
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
      // Silent: no prompt. Returns the active watch-only account if this origin
      // is already authorized, else null. Network is available even while locked.
      const sites = await getConnectedSites();
      if (!origin || !sites.includes(origin)) return null;
      const state = await keystore.getState();
      if (!state.initialized || state.wallets.length === 0) return null;
      const info = state.wallets.find((w) => w.id === state.activeWalletId) ?? state.wallets[0];
      // Page-safe account only — never include the descriptor (see ProviderAccount).
      const account: ProviderAccount = {
        network: toDappNetwork(info.network),
        masterFingerprint: info.fingerprint,
        signerKind: info.signer,
      };
      return account;
    }

    case "provider/getNewAddress": {
      const info = await walletInfo();
      return engine<AddressDTO>({
        kind: "getAddress",
        descriptor: info.descriptor,
        network: info.network,
      });
    }

    case "provider/getStatus": {
      const state = await keystore.getState();
      const status: ProviderStatus = { locked: state.locked };
      return status;
    }

    case "provider/getBalance": {
      // A locked wallet doesn't serve a balance — the dapp shows a locked state
      // and re-asks once unlocked (it polls getStatus). This also avoids handing
      // a balance to a page without the user having unlocked.
      const state = await keystore.getState();
      if (state.locked) {
        const locked: ProviderBalance = { locked: true, lbtcSats: null, assets: {} };
        return locked;
      }
      const info = await walletInfo();
      // Fresh chain sync so a connected dapp sees the current balance.
      const result = await engine<SyncResult>({
        kind: "sync",
        descriptor: info.descriptor,
        network: info.network,
        esploraUrl: await chainServer(info.network),
      });
      // Surface the full per-asset map too (L-BTC + tokens); the dapp filters
      // L-BTC out and resolves token metadata via provider/getAssetInfo.
      const balance: ProviderBalance = {
        locked: false,
        lbtcSats: result.lbtcSats,
        assets: result.balance,
      };
      return balance;
    }

    case "provider/getAssetInfo": {
      // Best-effort registry metadata (name/ticker/precision) for a token the
      // dapp saw in the balance map, on the connected wallet's network.
      const info = await walletInfo();
      return engine<AssetInfo>({
        kind: "getAsset",
        assetId: msg.assetId,
        network: info.network,
      });
    }

    case "provider/send": {
      // `drain` ignores `sats` (the built PSET moves the whole balance). For a
      // fixed send `sats` feeds the TxBuilder, so require a sane positive integer —
      // a dapp can pass anything, and BigInt() would otherwise throw a raw error.
      if (!msg.drain && (!Number.isSafeInteger(msg.sats) || msg.sats <= 0)) {
        throw new Error("Invalid send amount.");
      }
      const info = await walletInfo();
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
        address: msg.address,
        recipientSats: prepared.recipientSats,
        fee: prepared.fee,
        drain: Boolean(msg.drain),
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
          resolve: resolve as (r: unknown) => void,
          reject,
        });
        void routeApproval(request);
      });
    }
  }
}

// ---- dapp spend approvals (window.apogee send) -----------------------------
//
// A dapp `send` builds the PSET, then waits here for the user to approve it in
// Apogee — as an overlay inside the side panel if it's open, otherwise in a
// standalone popup window. Only after approval do we sign + broadcast. The map
// is in-memory: the open dapp message port keeps the SW alive for the (brief)
// approval; if the SW is evicted the dapp's request times out and can retry.

type PendingApproval =
  | {
      kind: "connect";
      request: ApprovalRequest;
      origin: string | undefined;
      account: ProviderAccount;
      resolve: (result: unknown) => void;
      reject: (err: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
      windowId?: number; // popup window hosting this approval, if any
    }
  | {
      kind: "send";
      request: ApprovalRequest;
      origin: string | undefined;
      walletId: string;
      descriptor: string;
      network: LiquidNetwork;
      pset: string;
      resolve: (result: unknown) => void;
      reject: (err: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
      windowId?: number;
    };

const pendingApprovals = new Map<string, PendingApproval>();
let approvalSeq = 0;

// How long an approval may sit undecided. The page provider's own timeout is
// deliberately LONGER (see liquid-provider.ts), so this expiry always fires
// first — an approval can never be granted after the dapp already gave up,
// which would sign + broadcast a transaction the dapp thinks failed.
// (setTimeout dies with the SW, but so does the in-memory map it guards.)
const APPROVAL_TTL_MS = 240_000; // 4 minutes

/** Park an approval and start its expiry clock. */
function parkApproval(id: string, entry: PendingApproval): void {
  pendingApprovals.set(id, entry);
  entry.timer = setTimeout(() => {
    if (!pendingApprovals.delete(id)) return; // already decided
    entry.reject(new Error("This approval request timed out."));
    // Clear whichever surface is showing it: the side-panel overlay dismisses
    // itself on this broadcast; a popup window is closed outright (its
    // onRemoved handler finds the map entry gone and no-ops).
    chrome.runtime.sendMessage({ type: "apogee/approval-expired", id }).catch(() => {});
    if (entry.windowId !== undefined) chrome.windows.remove(entry.windowId).catch(() => {});
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
      p.reject(new Error(reason));
      chrome.runtime.sendMessage({ type: "apogee/approval-expired", id }).catch(() => {});
      if (p.windowId !== undefined) chrome.windows.remove(p.windowId).catch(() => {});
    }
  }
}

/** Show the approval in the side panel (overlay) when open, else a popup window. */
async function routeApproval(request: ApprovalRequest): Promise<void> {
  const panels = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.SIDE_PANEL],
  });
  if (panels.length > 0) {
    chrome.runtime.sendMessage({ type: "apogee/approval-request", request }).catch(() => {});
    return;
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`src/prompt/prompt.html?id=${encodeURIComponent(request.id)}`),
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
    chrome.windows.onRemoved.removeListener(onClosed);
    const p = pendingApprovals.get(request.id);
    if (p) {
      pendingApprovals.delete(request.id);
      p.reject(
        new Error(
          request.kind === "connect"
            ? "You rejected the connection."
            : "You rejected the transaction.",
        ),
      );
    }
  };
  chrome.windows.onRemoved.addListener(onClosed);
}

/** Apply the user's decision: reject, or unlock-gated sign + broadcast. */
async function handleApprovalDecision(
  id: string,
  approved: boolean,
  password?: string,
): Promise<SendResult | { ok: true } | { rejected: true }> {
  const pending = pendingApprovals.get(id);
  if (!pending) throw new Error("This approval expired. Try again from the app.");
  pendingApprovals.delete(id);
  clearTimeout(pending.timer);
  if (!approved) {
    pending.reject(
      new Error(
        pending.kind === "connect"
          ? "You rejected the connection."
          : "You rejected the transaction.",
      ),
    );
    return { rejected: true };
  }
  if (pending.kind === "connect") {
    // A locked wallet must not authorize a new site (guards the stale-overlay /
    // popup-after-lock case; the side panel also clears the overlay on lock).
    if (keystore.isLocked()) {
      const err = new Error("Unlock Apogee to connect this site.");
      pending.reject(err);
      throw err;
    }
    // Approve the site: record the session and hand back the watch-only account.
    await addConnectedSite(pending.origin);
    pending.resolve(pending.account);
    return { ok: true };
  }
  // Re-validate the session at decision time: the site may have been revoked
  // while this send approval sat open. removeConnectedSite/reset also proactively
  // reject pending approvals; this closes the approve-vs-revoke race.
  const sites = await getConnectedSites();
  if (pending.origin && !sites.includes(pending.origin)) {
    const err = new Error("This site is no longer connected.");
    pending.reject(err);
    throw err;
  }
  // A Jade wallet signs on the device — no seed here, and no unlock-to-sign
  // (the device is the gate). Route the PSET to a Jade signing tab; the
  // jade-signed handler finalizes + broadcasts + fires balance-changed.
  const info = await walletInfo(pending.walletId);
  // Watch-only wallets can't sign — refuse the spend outright.
  if (info.signer === "watch") {
    const err = new Error("Watch-only wallets can't sign or send.");
    pending.reject(err);
    throw err;
  }
  if (info.signer === "jade") {
    // `pending` is always the send variant here, so request.kind is "send"; the
    // else is an unreachable fallback kept only to satisfy the broad request type.
    const summary: SendReview =
      pending.request.kind === "send"
        ? {
            address: pending.request.address,
            recipientSats: pending.request.recipientSats,
            fee: pending.request.fee,
            drain: pending.request.drain,
          }
        : { address: "", recipientSats: 0, fee: 0, drain: false };
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
    const err = new Error("Unlock Apogee to approve this transaction.");
    pending.reject(err);
    throw err;
  }
  // A never-auto-locking wallet stays unlocked indefinitely, so step up auth on
  // sends (Jade signs on-device, handled above).
  if ((await autoLockMinutes()) === 0) {
    if (!password || !(await keystore.verifyPassword(password))) {
      const err = new Error("Enter your password to approve this send.");
      pending.reject(err);
      throw err;
    }
  }
  try {
    const mnemonic = keystore.getMnemonic(pending.walletId);
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
    chrome.runtime.sendMessage({ type: "apogee/balance-changed" }).catch(() => {});
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
// only available in a top-level tab, so the SW opens a Jade signing tab, hands
// it the PSET to sign (the device shows + approves the tx), then finalizes the
// returned (signed) PSET with the watch-only wollet and broadcasts it here.

interface PendingJadeSign {
  pset: string; // the PSET to sign; the tab fetches it via apogee/jade-sign-get
  descriptor: string; // watch-only descriptor — finalizes the signed PSET
  network: LiquidNetwork;
  fingerprint: string; // expected wallet fingerprint — the tab verifies the device matches
  summary: SendReview; // spend details the tab shows on its review screen
  resolve: (txid: string) => void;
  reject: (err: Error) => void;
  tabId?: number;
  timer?: ReturnType<typeof setTimeout>;
}
const pendingJadeSigns = new Map<string, PendingJadeSign>();
let jadeSignSeq = 0;

// A signing tab left idle (device never connected, tab forgotten) must not stay
// broadcastable forever: for a dapp send the page's timeout is bounded, and a
// broadcast after it gave up is exactly the sign-after-timeout bug the approval
// TTL closes. Expiry rejects the waiting send; if the tab signs afterwards, the
// jade-signed handler finds the entry gone and refuses to broadcast (no funds
// move). APPROVAL_TTL_MS + JADE_SIGN_TTL_MS stays comfortably under the page
// provider's send timeout (see liquid-provider.ts).
const JADE_SIGN_TTL_MS = 360_000; // 6 minutes

/** Drop a pending Jade sign and clear its expiry clock. */
function takeJadeSign(id: string): PendingJadeSign | undefined {
  const p = pendingJadeSigns.get(id);
  if (!p) return undefined;
  pendingJadeSigns.delete(id);
  clearTimeout(p.timer);
  return p;
}

/** Open a Jade signing tab for `pset` and await the broadcast txid. The tab
 *  signs on-device and posts the signature back; the jade-signed handler then
 *  finalizes + broadcasts and resolves this with the txid. Rejects if the user
 *  cancels (closes the tab) or it fails on the device. */
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
      pset,
      descriptor,
      network,
      fingerprint,
      summary,
      resolve,
      reject,
    };
    pendingJadeSigns.set(id, pending);
    pending.timer = setTimeout(() => {
      const p = takeJadeSign(id);
      // The tab (if still open) errors on its next message; don't yank it away.
      p?.reject(new Error("Jade signing timed out. Try the send again."));
    }, JADE_SIGN_TTL_MS);
    chrome.tabs
      .create({
        url: chrome.runtime.getURL(
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

// Closing the signing tab before it returns a signature cancels the send.
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [id, p] of pendingJadeSigns) {
    if (p.tabId === tabId) {
      takeJadeSign(id);
      p.reject(new Error("Jade signing was cancelled."));
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === "offscreen") return false; // belongs to the offscreen doc
  if (typeof msg?.type !== "string") return false;
  // Trust boundary: wallet/* and apogee/* are extension-internal — they come from
  // our own surfaces (side panel, approval prompt, Jade signing tab) and must
  // never be honored from a content script / web page. provider/* is the only
  // web-facing surface and is authenticated by sender.origin in handleProvider.
  // Key on ORIGIN, not sender.tab: the Jade tab is an extension page opened as a
  // tab, so it legitimately has sender.tab set while sharing our origin.
  const fromExtension = sender.origin === EXT_ORIGIN && sender.id === chrome.runtime.id;
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
        ? { ok: true, pset: p.pset, fingerprint: p.fingerprint, summary: p.summary }
        : { ok: false, error: "This signing request expired. Try the send again from Apogee." },
    );
    return false;
  }
  // The tab returns the on-device signature: finalize + broadcast here, hand the
  // txid back to the tab (for its done screen) and to the waiting send caller.
  if (msg.type === "apogee/jade-signed") {
    const p = takeJadeSign(msg.id);
    if (!p) {
      sendResponse({ ok: false, error: "This signing request expired." });
      return false;
    }
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
        chrome.runtime.sendMessage({ type: "apogee/balance-changed" }).catch(() => {});
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
  if (msg.type.startsWith("wallet/")) {
    const req = msg as WalletRequest;
    handleUi(req)
      .then((value) => {
        sendResponse({ ok: true, value });
        // Only genuine user actions defer the idle lock — not passive polling
        // (see AUTOLOCK_DEFERRING). Explicit lock/reset clears the alarm instead.
        if (req.type === "wallet/lock" || req.type === "wallet/reset") {
          void chrome.alarms.clear(AUTOLOCK_ALARM);
        } else if (AUTOLOCK_DEFERRING.has(req.type)) {
          void rescheduleAutoLock();
        }
      })
      .catch((err: unknown) => sendResponse({ ok: false, error: errMsg(err) }));
    return true; // async sendResponse
  }
  if (msg.type.startsWith("provider/")) {
    handleProvider(msg as ProviderRequest, sender.origin)
      .then((value) => sendResponse({ ok: true, value }))
      .catch((err: unknown) => sendResponse({ ok: false, error: providerErrMsg(err) }));
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
