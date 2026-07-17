// Message protocol that ties the three MV3 surfaces together:
//
//   side panel / prompt  --(WalletRequest)-->  service worker
//   service worker       --(EngineRequest)-->  offscreen engine
//
// The service worker owns the keystore (seed-of-record) and brokers every
// engine call; the offscreen document owns lwk_wasm and never sees the
// keystore. Requests are plain JSON (structured-clone over chrome.runtime).

import type { LiquidNetwork, WalletInfo, WalletSigner } from "@/keystore/keystore";

// ---- service worker → offscreen engine -------------------------------------

/** IndexedDB database holding persisted scan state (see offscreen.ts). Shared
 *  so the service worker's wallet/reset deletes the same database the
 *  offscreen writes — a drifted string literal would silently stop clearing. */
export const SCAN_STATE_DB = "apogee-scan-state";

/** A request executed inside the offscreen document against lwk_wasm. */
export type EngineRequest =
  | { kind: "generateMnemonic"; words?: 12 | 24 }
  | { kind: "deriveWallet"; mnemonic: string; network: LiquidNetwork }
  | { kind: "sync"; descriptor: string; network: LiquidNetwork; esploraUrl?: string }
  | { kind: "getAddress"; descriptor: string; network: LiquidNetwork; index?: number }
  | { kind: "getBalance"; descriptor: string; network: LiquidNetwork }
  | { kind: "getTransactions"; descriptor: string; network: LiquidNetwork }
  | { kind: "signPset"; mnemonic: string; network: LiquidNetwork; pset: string }
  | { kind: "getRate"; currency: string } // BTC price in `currency` (median of sources)
  | { kind: "qr"; text: string } // monochrome QR bitmap as a data-URI
  | { kind: "getAsset"; assetId: string; network: LiquidNetwork } // registry metadata
  // Validate a pasted watch-only descriptor and read its fingerprint + network
  // (constructing the WolletDescriptor throws on a malformed descriptor).
  | { kind: "descriptorInfo"; descriptor: string }
  // `drain` (send max): send all L-BTC to the address, fee deducted from amount.
  | {
      kind: "prepareSend";
      descriptor: string;
      network: LiquidNetwork;
      address: string;
      sats: number;
      drain?: boolean;
    }
  | { kind: "signBroadcast"; mnemonic: string; descriptor: string; network: LiquidNetwork; pset: string; esploraUrl?: string }
  // Finalize an already-signed PSET (e.g. signed on a Jade) + broadcast it. No
  // seed — the watch-only Wollet finalizes and the Esplora client broadcasts.
  | { kind: "finalizeBroadcast"; descriptor: string; network: LiquidNetwork; pset: string; esploraUrl?: string }
  // Probe a user-supplied Esplora server: reachable, and serving the expected
  // network (checked against the chain genesis hash). Throws with a clean
  // message on failure; returns true.
  | { kind: "checkEsplora"; url: string; network: LiquidNetwork };

/** Result of `descriptorInfo`: the master fingerprint embedded in a watch-only
 *  descriptor, and whether it targets mainnet (used to sanity-check the network). */
export interface DescriptorInfo {
  fingerprint: string;
  mainnet: boolean;
}

/** Envelope the SW sends; the offscreen listener filters on `target`. */
export interface EngineEnvelope {
  target: "offscreen";
  req: EngineRequest;
}

/** Watch-only material derived from a mnemonic (handed to the keystore). */
export interface DerivedWallet {
  descriptor: string; // standard BIP84 ct(slip77(..),elwpkh([fp/84h/<coin>h/0h]xpub/<0;1>/*))
  fingerprint: string;
}

export interface AddressDTO {
  index: number;
  address: string;
}

/** Result of a full Esplora scan: L-BTC sats plus the full per-asset map. */
export interface SyncResult {
  lbtcSats: number;
  balance: Record<string, number>; // assetIdHex → sats
  policyAssetHex: string; // which key in `balance` is L-BTC (vs. tokens)
}

/** Liquid asset registry metadata (best-effort; fields null when unregistered). */
export interface AssetInfo {
  name: string | null;
  ticker: string | null;
  precision: number | null;
}

export interface WalletTxDTO {
  txid: string;
  balanceChange: number; // L-BTC (policy asset) delta, sats
  fee: number;
  height: number | null;
  timestamp: number | null;
  assetDeltas: Record<string, number>;
}

// ---- side panel / prompt → service worker ----------------------------------

export type WalletRequest =
  | { type: "wallet/getState" }
  | { type: "wallet/initializeKeystore"; password: string }
  | { type: "wallet/unlock"; password: string }
  | { type: "wallet/lock" }
  | { type: "wallet/reset" }
  | { type: "wallet/verifyPassword"; password: string }
  // Unlock-attempt throttle state (fails / cooldown / hard lock) for the UI.
  | { type: "wallet/getUnlockThrottle" }
  // password (first run) initializes the keystore as part of the same call.
  | { type: "wallet/create"; password?: string; label: string; network: LiquidNetwork }
  // `replace` (forgot-password recovery): wipe the existing unlockable-no-more
  // vault first, but only after the phrase validates, so a typo can't destroy it.
  | {
      type: "wallet/restore";
      password?: string;
      mnemonic: string;
      label: string;
      network: LiquidNetwork;
      replace?: boolean;
    }
  | { type: "wallet/sync"; walletId?: string }
  | { type: "wallet/getAddress"; walletId?: string; index?: number }
  | { type: "wallet/getBalance"; walletId?: string }
  | { type: "wallet/getTransactions"; walletId?: string }
  | { type: "wallet/revealMnemonic"; walletId: string; password: string }
  | { type: "wallet/getRate"; currency: string }
  | { type: "wallet/qr"; text: string }
  | { type: "wallet/getAsset"; assetId: string; network: LiquidNetwork }
  | { type: "wallet/getChainServer"; network: LiquidNetwork } // per-network Esplora override ("" = automatic)
  | { type: "wallet/setChainServer"; network: LiquidNetwork; url: string } // "" clears back to automatic
  | { type: "wallet/getAutoLock" } // idle auto-lock timeout in minutes (0 = never)
  | { type: "wallet/setAutoLock"; minutes: number }
  // Heartbeat from genuine side-panel activity (pointer/keyboard) that re-arms
  // the idle lock — unlike the background sync poll, which must not keep it alive.
  | { type: "wallet/touch" }
  // Dapp connections (window.apogee): list/revoke sites connected to the wallet.
  | { type: "wallet/getConnectedSites" }
  | { type: "wallet/disconnectSite"; origin: string }
  | { type: "wallet/prepareSend"; walletId?: string; address: string; sats: number; drain?: boolean }
  // `review` (optional) carries the human-readable spend details so a Jade send
  // can show a transaction summary in its signing tab; ignored for local signing.
  | { type: "wallet/send"; walletId?: string; pset: string; review?: SendReview; password?: string }
  // Pair a hardware (Jade) wallet: watch-only descriptor read from the device,
  // no seed. `password` initializes the keystore on first run, like create/restore.
  | {
      type: "wallet/addHardwareWallet";
      password?: string;
      signer: WalletSigner;
      descriptor: string;
      fingerprint: string;
      label: string;
      network: LiquidNetwork;
    }
  // Import a watch-only wallet from a pasted descriptor: no seed, no signer.
  // The SW validates the descriptor and derives the fingerprint (via
  // descriptorInfo); `password` initializes the keystore on first run.
  | {
      type: "wallet/addWatchOnlyWallet";
      password?: string;
      descriptor: string;
      label: string;
      network: LiquidNetwork;
    };

/** What `wallet/create` returns: the persisted wallet + the phrase to back up. */
export interface CreatedWallet {
  wallet: WalletInfo;
  mnemonic: string;
}

/** A built, reviewable spend: the PSET to sign + the network fee in sats. */
export interface PrepareSendResult {
  pset: string;
  fee: number;
  recipientSats: number; // what the recipient actually receives
}

export interface SendResult {
  txid: string;
}

/** Human-readable spend details for the Jade signing tab's review summary. */
export interface SendReview {
  address: string;
  recipientSats: number;
  fee: number;
  drain: boolean;
}

// ---- page provider (dapp) → content bridge → service worker ----------------
//
// A web page (a dapp) talks to `window.apogee` (MAIN-world provider),
// which postMessages to the content bridge (ISOLATED world), which relays these
// requests to the service worker. The dapp speaks the standard network names
// (mainnet/testnet/regtest), mapped from the internal LiquidNetwork.

/** Network names as seen by connected dapps (mapped from LiquidNetwork). */
export type DappNetwork = "mainnet" | "testnet" | "regtest";

/**
 * What `connect()` returns to a dapp. Page-safe: only the fields the page
 * provider actually uses. The wallet descriptor is deliberately excluded — it
 * embeds the SLIP-77 master blinding key + account xpub, and this object crosses
 * the content bridge into the untrusted page (where any script can read it), so
 * it must never carry wallet-wide secrets.
 */
export interface ProviderAccount {
  network: DappNetwork;
  masterFingerprint: string;
  signerKind: WalletSigner; // "local" | "jade" — UI hint only
}

export type ProviderRequest =
  | { type: "provider/connect" }
  | { type: "provider/disconnect" }
  // Silent authorization query: the account if this origin is already approved,
  // else null. Never prompts (backs the spec's liquid_accounts / liquid_getNetwork).
  | { type: "provider/getAccount" }
  | { type: "provider/getStatus" }
  | { type: "provider/getNewAddress" }
  | { type: "provider/getBalance" }
  // Best-effort registry metadata for a token the dapp saw in the balance map.
  | { type: "provider/getAssetInfo"; assetId: string }
  // The dapp passes intent (address + amount); Apogee builds the PSET, shows an
  // approval, signs, and broadcasts. A watch-only dapp can't build a PSET itself.
  | { type: "provider/send"; address: string; sats: number; drain?: boolean };

/** Lightweight lock state for a connected dapp (no chain sync). */
export interface ProviderStatus {
  locked: boolean;
}

/**
 * L-BTC balance for a connected dapp. A locked wallet does NOT serve a balance:
 * `locked: true` with `lbtcSats: null` lets the dapp show a "locked" state
 * instead of mistaking it for an empty (0-sat) wallet.
 */
export interface ProviderBalance {
  locked: boolean;
  lbtcSats: number | null;
  /**
   * Full per-asset balance map (assetIdHex → base-unit amount), including L-BTC.
   * Empty `{}` while locked. The dapp filters out L-BTC and resolves each token's
   * name/ticker/precision via `getAssetInfo`.
   */
  assets: Record<string, number>;
}

/**
 * A pending dapp action awaiting the user's approval. Rendered as an overlay in
 * the side panel when it's open, or in the standalone prompt popup when it isn't.
 * `connect` authorizes a site; `send` reviews a built spend (PSET + fee) before
 * signing. Only the user's explicit approval proceeds.
 */
export type ApprovalRequest =
  | {
      kind: "connect";
      id: string;
      origin: string; // requesting dapp origin
      network: DappNetwork;
      fingerprint: string; // wallet fingerprint the site will see
      signerKind: WalletSigner; // "local" | "jade"
      locked: boolean; // wallet locked at request time → the UI must unlock first
    }
  | {
      kind: "send";
      id: string;
      origin: string; // requesting dapp origin
      address: string; // destination
      recipientSats: number; // what the recipient receives
      fee: number; // network fee, sats
      drain: boolean; // "send max"
      network: DappNetwork;
      locked: boolean; // wallet was locked at request time → the UI must unlock first
      signerKind: WalletSigner; // "local" | "jade" — jade signs on-device in a tab
    };

/** Uniform reply envelope for both channels. */
export type Reply<T = unknown> = { ok: true; value: T } | { ok: false; error: string };
