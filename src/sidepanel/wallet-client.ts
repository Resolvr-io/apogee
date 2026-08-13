// Typed client for the side panel: wraps browser.runtime.sendMessage to the
// service worker's wallet/* router and unwraps the Reply<T> envelope, throwing
// the engine/keystore error message on failure.

import type {
  AddressDTO,
  AssetInfo,
  ChainServerHealth,
  CreatedWallet,
  PrepareSendResult,
  PriceHistory,
  PriceRange,
  Reply,
  SendResult,
  SendReview,
  SwapQuotePreview,
  SwapResultDTO,
  SyncResult,
  WalletRequest,
  WalletTxDTO,
  WalletUtxoDTO,
} from "@/engine/protocol";
import type {
  KeystoreState,
  LiquidNetwork,
  UnlockThrottle,
  WalletInfo,
  WalletSigner,
} from "@/keystore/keystore";
import { browser } from "@/lib/ext";
import type { UpdateCheck } from "@/lib/version-check";

async function call<T>(msg: WalletRequest): Promise<T> {
  const reply = (await browser.runtime.sendMessage(msg)) as Reply<T> | undefined;
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
  getUtxos: (walletId?: string) =>
    call<WalletUtxoDTO[]>({ type: "wallet/getUtxos", walletId }),
  revealMnemonic: (walletId: string, password: string) =>
    call<string>({ type: "wallet/revealMnemonic", walletId, password }),
  getRate: (currency: string) => call<number>({ type: "wallet/getRate", currency }),
  /** BTC price 24h ago — one point, for the rate bar's delta. */
  getPrice24hAgo: (currency: string) =>
    call<number>({ type: "wallet/getPrice24hAgo", currency }),
  /** Hourly BTC price history for the chart. Only called when the chart is opened —
   *  the panel never polls this. */
  getPriceHistory: (currency: string, range: PriceRange) =>
    call<PriceHistory>({ type: "wallet/getPriceHistory", currency, range }),
  /** Claim a seed phrase scanned by the QR window. One-shot: the service worker
   *  clears it on read, so a second call always returns null. Returns null when
   *  nothing was scanned or the parked value expired. */
  claimScannedSeed: async (): Promise<string | null> => {
    const reply = (await browser.runtime.sendMessage({ type: "apogee/qr-secret-claim" })) as
      | { ok?: boolean; value?: string | null }
      | undefined;
    return reply?.value ?? null;
  },
  /** Open the guide, focusing an existing tab rather than opening a duplicate. */
  openGuide: () => call<void>({ type: "wallet/openGuide" }),
  /** Newest published release vs. this build. User-initiated only. */
  checkUpdate: () => call<UpdateCheck>({ type: "wallet/checkUpdate" }),
  qr: (text: string) => call<string>({ type: "wallet/qr", text }),
  getAsset: (assetId: string, network: LiquidNetwork) =>
    call<AssetInfo>({ type: "wallet/getAsset", assetId, network }),
  getChainServer: (network: LiquidNetwork) =>
    call<string>({ type: "wallet/getChainServer", network }),
  setChainServer: (network: LiquidNetwork, url: string) =>
    call<void>({ type: "wallet/setChainServer", network, url }),
  probeChainServer: (network: LiquidNetwork) =>
    call<ChainServerHealth>({ type: "wallet/probeChainServer", network }),
  getAutoLock: () => call<number>({ type: "wallet/getAutoLock" }),
  setAutoLock: (minutes: number) => call<void>({ type: "wallet/setAutoLock", minutes }),
  touch: () => call<void>({ type: "wallet/touch" }),
  prepareSend: (address: string, sats: number, drain?: boolean, asset?: string) =>
    call<PrepareSendResult>({ type: "wallet/prepareSend", address, sats, drain, asset }),
  send: (pset: string, review?: SendReview, password?: string) =>
    call<SendResult>({ type: "wallet/send", pset, review, password }),
  swap: (sendAssetId: string, recvAssetId: string, opts: { sendAmount?: number; recvAmount?: number; reviewedSendAmount?: string; reviewedRecvAmount?: string; password?: string }) =>
    call<SwapResultDTO>({ type: "wallet/swap", sendAssetId, recvAssetId, ...opts }),
  swapQuote: (sendAssetId: string, recvAssetId: string, opts: { sendAmount?: number; recvAmount?: number }) =>
    call<SwapQuotePreview>({ type: "wallet/swapQuote", sendAssetId, recvAssetId, ...opts }),
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

// Error translation lives in ./errors (pure — no @/lib/ext, so it's unit-testable
// in plain Node). Re-exported here so existing call sites keep importing from
// "@/sidepanel/wallet-client" unchanged.
export {
  errMessage,
  throttledUntil,
  isUnlockBlocked,
  UNLOCK_BLOCKED_TEXT,
  formatCooldown,
  unlockErrMessage,
  swapErrorKind,
  swapErrorMessage,
  lowBalanceAvailable,
  type SwapErrorKind,
} from "./errors";
