// Typed client for the side panel: wraps chrome.runtime.sendMessage to the
// service worker's wallet/* router and unwraps the Reply<T> envelope, throwing
// the engine/keystore error message on failure.

import type {
  AddressDTO,
  AssetInfo,
  CreatedWallet,
  PrepareSendResult,
  Reply,
  SendResult,
  SendReview,
  SyncResult,
  WalletRequest,
  WalletTxDTO,
} from "@/engine/protocol";
import type {
  KeystoreState,
  LiquidNetwork,
  UnlockThrottle,
  WalletInfo,
  WalletSigner,
} from "@/keystore/keystore";

async function call<T>(msg: WalletRequest): Promise<T> {
  const reply = (await chrome.runtime.sendMessage(msg)) as Reply<T> | undefined;
  if (!reply) throw new Error("no response from background");
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

export const wallet = {
  getState: () => call<KeystoreState>({ type: "wallet/getState" }),
  unlock: (password: string) => call<void>({ type: "wallet/unlock", password }),
  lock: () => call<void>({ type: "wallet/lock" }),
  reset: () => call<void>({ type: "wallet/reset" }),
  verifyPassword: (password: string) => call<boolean>({ type: "wallet/verifyPassword", password }),
  getUnlockThrottle: () => call<UnlockThrottle>({ type: "wallet/getUnlockThrottle" }),
  create: (password: string, label: string, network: LiquidNetwork) =>
    call<CreatedWallet>({ type: "wallet/create", password, label, network }),
  restore: (
    password: string,
    mnemonic: string,
    label: string,
    network: LiquidNetwork,
    replace?: boolean,
  ) => call<WalletInfo>({ type: "wallet/restore", password, mnemonic, label, network, replace }),
  sync: (walletId?: string) => call<SyncResult>({ type: "wallet/sync", walletId }),
  getAddress: (walletId?: string, index?: number) =>
    call<AddressDTO>({ type: "wallet/getAddress", walletId, index }),
  getTransactions: (walletId?: string) =>
    call<WalletTxDTO[]>({ type: "wallet/getTransactions", walletId }),
  revealMnemonic: (walletId: string, password: string) =>
    call<string>({ type: "wallet/revealMnemonic", walletId, password }),
  getRate: (currency: string) => call<number>({ type: "wallet/getRate", currency }),
  qr: (text: string) => call<string>({ type: "wallet/qr", text }),
  getAsset: (assetId: string, network: LiquidNetwork) =>
    call<AssetInfo>({ type: "wallet/getAsset", assetId, network }),
  getChainServer: (network: LiquidNetwork) =>
    call<string>({ type: "wallet/getChainServer", network }),
  setChainServer: (network: LiquidNetwork, url: string) =>
    call<void>({ type: "wallet/setChainServer", network, url }),
  getAutoLock: () => call<number>({ type: "wallet/getAutoLock" }),
  setAutoLock: (minutes: number) => call<void>({ type: "wallet/setAutoLock", minutes }),
  touch: () => call<void>({ type: "wallet/touch" }),
  prepareSend: (address: string, sats: number, drain?: boolean, asset?: string) =>
    call<PrepareSendResult>({ type: "wallet/prepareSend", address, sats, drain, asset }),
  send: (pset: string, review?: SendReview, password?: string) =>
    call<SendResult>({ type: "wallet/send", pset, review, password }),
  addHardwareWallet: (params: {
    password?: string;
    signer: WalletSigner;
    descriptor: string;
    fingerprint: string;
    label: string;
    network: LiquidNetwork;
  }) => call<WalletInfo>({ type: "wallet/addHardwareWallet", ...params }),
  addWatchOnlyWallet: (params: {
    password?: string;
    descriptor: string;
    label: string;
    network: LiquidNetwork;
  }) => call<WalletInfo>({ type: "wallet/addWatchOnlyWallet", ...params }),
  getConnectedSites: () => call<string[]>({ type: "wallet/getConnectedSites" }),
  disconnectSite: (origin: string) => call<void>({ type: "wallet/disconnectSite", origin }),
};

/** Surface an unknown thrown value as a message string. */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- unlock-throttle error translation ----
//
// The keystore refuses guarded password attempts with machine-readable codes
// (UNLOCK_THROTTLED:<epochMs> / UNLOCK_BLOCKED) so every surface with a password
// field — unlock screen, approval overlay, reveal-seed form — renders the same
// friendly text instead of a raw code.

/** Epoch ms when the next attempt is allowed, if `err` is a cooldown refusal. */
export function throttledUntil(err: unknown): number | null {
  const m = /^UNLOCK_THROTTLED:(\d+)$/.exec(errMessage(err));
  return m ? Number(m[1]) : null;
}

/** True when `err` is the hard lock (only recovery/reset can proceed). */
export function isUnlockBlocked(err: unknown): boolean {
  return errMessage(err) === "UNLOCK_BLOCKED";
}

export const UNLOCK_BLOCKED_TEXT =
  "Too many failed attempts. Restore from your recovery phrase or reset Apogee to continue.";

/** Render "wait" durations as e.g. "45s" or "2m 30s". */
export function formatCooldown(msLeft: number): string {
  const s = Math.max(1, Math.ceil(msLeft / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

/** Friendly text for any password-attempt error (throttle-aware). */
export function unlockErrMessage(err: unknown): string {
  if (isUnlockBlocked(err)) return UNLOCK_BLOCKED_TEXT;
  const until = throttledUntil(err);
  if (until !== null) {
    return `Too many failed attempts. Try again in ${formatCooldown(until - Date.now())}.`;
  }
  return errMessage(err);
}
