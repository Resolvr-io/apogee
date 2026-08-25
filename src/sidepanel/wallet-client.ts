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
  RestoreWalletRequest,
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
import { bytesToBase64 } from "@/keystore/crypto";
import type { PasskeyInfo } from "@/keystore/keystore";
import { browser } from "@/lib/ext";
import type { UpdateCheck } from "@/lib/version-check";

/** Random id minted per panel-document load. Lets the service worker tell
 *  "same panel session" from "panel closed and reopened" — the trigger for the
 *  auto-lock-"never" password step-up. */
const PANEL_SESSION = crypto.randomUUID();

async function call<T>(msg: WalletRequest): Promise<T> {
  const reply = (await browser.runtime.sendMessage(msg)) as Reply<T> | undefined;
  if (!reply) throw new Error("no response from background");
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

/** Point-to-point request over a dedicated runtime.connect port. An untargeted
 *  `sendMessage` fans out to every extension context, so any message carrying a
 *  plaintext seed phrase must travel this way instead — only the service worker
 *  ever receives it. */
async function portCall<T>(msg: RestoreWalletRequest): Promise<T> {
  const port = browser.runtime.connect({ name: "apogee-secret" });
  const reply = await new Promise<Reply<T> | null>((resolve) => {
    const done = (r: Reply<T> | null) => {
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      resolve(r);
    };
    const onMessage = (m: unknown) => done(m as Reply<T>);
    const onDisconnect = () => done(null);
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    port.postMessage(msg);
  });
  port.disconnect();
  if (!reply) throw new Error("no response from background");
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

export const wallet = {
  getState: () => call<KeystoreState>({ type: "wallet/getState", panelSession: PANEL_SESSION }),
  unlock: (password: string) => call<void>({ type: "wallet/unlock", panelSession: PANEL_SESSION, password }),
  lock: () => call<void>({ type: "wallet/lock" }),
  reset: () => call<void>({ type: "wallet/reset" }),
  verifyPassword: (password: string) => call<boolean>({ type: "wallet/verifyPassword", password }),
  /** Passkey surface (docs/passkey-unlock.md). The raw PRF bytes are encoded
   *  here, at the client boundary — a Uint8Array in a runtime message arrives
   *  as a plain object and would silently derive the wrong key. */
  listPasskeys: () => call<PasskeyInfo[]>({ type: "wallet/listPasskeys" }),
  passkeyChallenge: () =>
    call<{ credentialIds: string[]; prfSalt: string } | null>({ type: "wallet/passkeyChallenge" }),
  enrollPasskey: (
    prf: Uint8Array<ArrayBuffer>,
    credentialId: string,
    kind: "device" | "cross-device" | "security-key",
  ) =>
    call<PasskeyInfo>({
      type: "wallet/enrollPasskey",
      prf: bytesToBase64(prf),
      credentialId,
      kind,
    }),
  unlockWithPasskey: (prf: Uint8Array<ArrayBuffer>) =>
    call<void>({ type: "wallet/unlockWithPasskey", panelSession: PANEL_SESSION, prf: bytesToBase64(prf) }),
  removePasskey: (id: string) => call<void>({ type: "wallet/removePasskey", id }),
  /** Re-verify the password on panel reopen while auto-lock is "never". */
  stepUp: (password: string) =>
    call<boolean>({ type: "wallet/stepUp", panelSession: PANEL_SESSION, password }),
  getUnlockThrottle: () => call<UnlockThrottle>({ type: "wallet/getUnlockThrottle" }),
  create: (password: string, label: string, network: LiquidNetwork) =>
    call<CreatedWallet>({ type: "wallet/create", password, label, network }),
  /** Restore from a seed phrase. Sent over a dedicated port, never broadcast —
   *  the request carries the plaintext mnemonic. */
  restore: (
    password: string,
    mnemonic: string,
    label: string,
    network: LiquidNetwork,
    replace?: boolean,
  ) => portCall<WalletInfo>({ type: "wallet/restore", password, mnemonic, label, network, replace }),
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
