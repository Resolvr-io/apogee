// Message protocol that ties the three MV3 surfaces together:
//
//   side panel / prompt  --(WalletRequest)-->  service worker
//   service worker       --(EngineRequest)-->  offscreen engine
//
// The service worker owns the keystore (seed-of-record) and brokers every
// engine call; the offscreen document owns lwk_wasm and never sees the
// keystore. Requests are plain JSON (structured-clone over chrome.runtime).

import type { LiquidNetwork, WalletInfo, WalletSigner } from "@/keystore/keystore";
import type { CompileParam } from "@/manifest/covenant";
import type { PlannedWitness } from "@/manifest/runner";

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
  // `drain` (send max): for LBTC, drain the wallet (fee deducted from the
  // amount); for a token (`asset` set), send the full token balance (the fee is
  // paid in LBTC, so no deduction). `sats` is in the asset's base units.
  | {
    kind: "prepareSend";
    descriptor: string;
    network: LiquidNetwork;
    address: string;
    sats: number;
    drain?: boolean;
    asset?: string; // asset id hex; absent → LBTC (policy asset)
  }
  | { kind: "signBroadcast"; mnemonic: string; descriptor: string; network: LiquidNetwork; pset: string; esploraUrl?: string }
  // Build (but don't sign) the transaction a txmanifest action describes. The
  // engine derives every covenant address itself from the manifest's `.simf`
  // sources — it never trusts a destination the caller supplied — and reports the
  // net effect from the built PSET's own wallet delta.
  | {
    kind: "prepareManifest";
    descriptor: string;
    network: LiquidNetwork;
    action: string;
    manifest: string; // raw txmanifest.json TEXT (see ManifestRunParams)
    sources: Record<string, string>; // source path → raw .simf text
    instance?: string; // raw instance.json text; absent for constructors
    providedInputs?: Record<string, ProvidedInputDTO>;
    actionParams?: Record<string, string>;
  }
  // Sign + finalize + broadcast a manifest PSET. Separate from `signBroadcast`
  // only because the reply carries the created UTXOs (their txid is not known
  // until broadcast), which the caller needs to spend the contract later.
  | {
    kind: "signBroadcastManifest";
    mnemonic: string;
    descriptor: string;
    network: LiquidNetwork;
    pset: string;
    outputs: ManifestOutputRef[];
    /** Covenant inputs to finalize after the wallet inputs are signed (keyless). */
    covenantSpends: ManifestCovenantSpend[];
  }
  // Finalize an already-signed PSET (e.g. signed on a Jade) + broadcast it. No
  // seed — the watch-only Wollet finalizes and the Esplora client broadcasts.
  | { kind: "finalizeBroadcast"; descriptor: string; network: LiquidNetwork; pset: string; esploraUrl?: string }
  // Probe a user-supplied Esplora server: reachable, and serving the expected
  // network (checked against the chain genesis hash). Throws with a clean
  // message on failure; returns true.
  | { kind: "checkEsplora"; url: string; network: LiquidNetwork }
  // Health probe of the effective chain server. `esploraUrl` is the per-network
  // override (absent = automatic). A pinned URL probes just that endpoint;
  // automatic probes waterfalls (primary) plus the Esplora fallbacks, returning
  // a per-provider breakdown so the badge can show "primary down, on fallback".
  | { kind: "probeChainServer"; network: LiquidNetwork; esploraUrl?: string }
  // Verify a dealer-built PSET (SideSwap `get_quote`) against the accepted
  // quote before signing: fair receive to our address, no extra wallet-input
  // drain, fee within cap. See `engine/verify-dealer-pset.ts`.
  | {
      kind: "verifyDealerPset";
      descriptor: string;
      network: LiquidNetwork;
      pset: string;
      terms: VerifyDealerPsetTermsDTO;
    }
  // List the wallet's unspent outputs with their unblinding data (asset, value,
  // and both blinding factors) — what SideSwap's `start_quotes` needs per UTXO.
  | { kind: "getUtxos"; descriptor: string; network: LiquidNetwork }
  // Verify a dealer-built swap PSET, then sign + finalize it atomically. The
  // verification gate (verifyDealerPset) runs first; if it fails the PSET is
  // never signed. Returns the finalized PSET for SideSwap's `taker_sign`.
  | {
      kind: "signSwapPset";
      descriptor: string;
      mnemonic: string;
      network: LiquidNetwork;
      pset: string;
      terms: VerifyDealerPsetTermsDTO;
    };

/** Wire form of swap terms for `verifyDealerPset`. Amounts are base-10 strings
 *  — BigInt isn't JSON-serializable across the chrome.runtime boundary. */
export interface VerifyDealerPsetTermsDTO {
  sendAssetId: string;
  sendAmount: string;
  recvAssetId: string;
  minRecvAmount: string;
  /** Required cap on the send-asset (L-BTC) network fee — bounds an L-BTC send
   *  and is a harmless no-op for a USDt send. Required so the fee is never left
   *  unbounded. See `verify-dealer-pset.ts`. */
  maxFee: string;
}

/** Wire result of `verifyDealerPset`: ok plus the PSET-derived amounts (as
 *  base-10 strings), or a rejection reason. */
export type VerifyDealerPsetWireResult =
  | { ok: true; sent: string; received: string; fee: string }
  | { ok: false; reason: string };

/** Wire result of `signSwapPset`: the finalized PSET plus verification amounts
 *  on success, or a rejection reason (verification or signing failure). */
export type SignSwapPsetWireResult =
  | { ok: true; pset: string; sent: string; received: string; fee: string }
  | { ok: false; reason: string };

/** A wallet UTXO with its unblinding data. `value` is a base-10 string
 *  (BigInt-safe over JSON); the blinding factors are hex. `redeemScript` is
 *  omitted — Apogee wallets are P2WPKH (no redeem script); the swap flow sets
 *  `redeem_script: null` for SideSwap. */
export interface UtxoDTO {
  txid: string;
  vout: number;
  asset: string; // hex asset id
  assetBf: string; // hex asset blinding factor
  value: string; // base-10
  valueBf: string; // hex value blinding factor
}

/** Result of `descriptorInfo`: the master fingerprint embedded in a watch-only
 *  descriptor, and whether it targets mainnet (used to sanity-check the network). */
export interface DescriptorInfo {
  fingerprint: string;
  mainnet: boolean;
}

/** Chain-server health probe result. `status` is the headline; in automatic
 *  mode `providers` breaks it down per endpoint so the UI can show a primary
 *  outage alongside a working fallback. */
export type ProbeStatus = "up" | "slow" | "down";

export interface ProviderProbe {
  label: string;
  status: ProbeStatus;
  latencyMs: number | null; // null when unreachable
}

export interface ChainServerHealth {
  mode: "automatic" | "pinned";
  status: ProbeStatus; // overall (the primary's, or the pinned server's)
  latencyMs: number | null;
  url?: string; // present when pinned
  providers?: ProviderProbe[]; // per-provider, automatic mode only
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

/** Result of a full Esplora scan: LBTC sats plus the full per-asset map. */
export interface SyncResult {
  lbtcSats: number;
  balance: Record<string, number>; // assetIdHex → sats
  policyAssetHex: string; // which key in `balance` is LBTC (vs. tokens)
}

/** Liquid asset registry metadata (best-effort; fields null when unregistered). */
export interface AssetInfo {
  name: string | null;
  ticker: string | null;
  precision: number | null;
}

export interface WalletTxDTO {
  txid: string;
  balanceChange: number; // LBTC (policy asset) delta, sats
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
  | { type: "wallet/probeChainServer"; network: LiquidNetwork } // health probe for the Advanced status badge
  | { type: "wallet/getAutoLock" } // idle auto-lock timeout in minutes (0 = never)
  | { type: "wallet/setAutoLock"; minutes: number }
  // Heartbeat from genuine side-panel activity (pointer/keyboard) that re-arms
  // the idle lock — unlike the background sync poll, which must not keep it alive.
  | { type: "wallet/touch" }
  // Dapp connections (window.apogee): list/revoke sites connected to the wallet.
  | { type: "wallet/getConnectedSites" }
  | { type: "wallet/disconnectSite"; origin: string }
  | { type: "wallet/prepareSend"; walletId?: string; address: string; sats: number; drain?: boolean; asset?: string }
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
  fee: number; // network fee, always in LBTC sats
  recipientSats: number; // what the recipient actually receives, in BASE UNITS of `assetId`
  assetId: string; // which asset moves — the policy asset hex for LBTC sends
}

export interface SendResult {
  txid: string;
}

/** Human-readable spend details for the Jade signing tab's review summary. */
export interface SendReview {
  address: string;
  recipientSats: number; // base units of the sent asset (sats for LBTC)
  fee: number; // LBTC sats
  drain: boolean;
  // Present for token sends (display-only — the PSET is the signed truth, and
  // the Jade device shows asset ids on-screen independently).
  assetId?: string;
  assetTicker?: string | null;
  assetPrecision?: number | null;
}

// ---- txmanifest ------------------------------------------------------------
//
// A dapp hands Apogee a manifest + an action; Apogee builds the transaction,
// shows what it actually does, and only signs on approval. Everything the dapp
// sends is UNTRUSTED. Two things make that safe:
//
//   1. Covenant destinations are DERIVED (Spec §11) from the manifest's own
//      `.simf` source, never taken from the caller. A lie about an instance
//      field changes the derived address, which then won't match the on-chain
//      UTXO — so lying is detectable rather than profitable.
//   2. The amounts the user approves come from the built PSET's wallet delta,
//      never from caller input — the same rule `prepareSend` already follows.
//
// Manifest/instance/params cross the wire as JSON *text*, not objects: u64 runs
// past 2^53 and `JSON.parse` silently rounds, and hashing the literal bytes we
// were handed is what makes a publisher signature checkable later (no JCS).
// Integers are therefore carried as decimal STRINGS throughout.

/** An externally-supplied UTXO (ELIP-0206 `provided_inputs`). Untrusted. */
export interface ProvidedInputDTO {
  txid: string; // 64 hex, natural byte order
  vout: number;
  amount_sat: string; // decimal string — u64 exceeds Number.MAX_SAFE_INTEGER
  asset: string; // 64 hex
}

/** A transaction output the manifest run creates, identified before broadcast. */
export interface ManifestOutputRef {
  utxo_type: string; // which `utxo_types` entry this output is an instance of
  utxo_id: string; // the manifest output `id` (e.g. "will_out")
  vout: number;
  amount_sat: string;
  asset: string;
  address: string; // the address WE derived, not one we were handed
}

/** A covenant leg the manifest itself declares — the contract input it spends or
 *  the output it checks. UNTRUSTED prose from the author, cross-checked for
 *  derived addresses. Used internally to annotate the full-transaction legs. */
export interface ManifestLeg {
  id: string; // manifest input/output id
  kind: "input" | "output";
  label: string; // author-supplied prose — UNTRUSTED, attribute to the site
  address?: string;
  amountSat: string;
  asset: string;
  /** True when this leg is a covenant address Apogee derived and verified. */
  derived: boolean;
  /** True when the leg belongs to the user's own wallet (change, self-sends). */
  mine: boolean;
}

/** One input or output of the BUILT transaction, for the full detail view. Unlike
 *  ManifestLeg (the covenant's OWN declared legs), this enumerates every leg the
 *  wallet actually assembled — funding inputs, change, the fee — so the reviewer
 *  sees the whole transaction, not just the contract's slice of it.
 *
 *  The wallet blinds its own outputs, so a confidential leg's amount/asset are
 *  genuinely unreadable from the PSET (null here). That's expected, not an error:
 *  the authoritative totals live in `net`; this view is for structure. */
export interface ManifestTxLeg {
  /** Explicit amount in sats, or null when the value is confidential (blinded). */
  amountSat: number | null;
  /** Explicit asset id hex, or null when confidential. */
  asset: string | null;
  /** For an input: the prevout, "txid:vout". For a contract output: the derived
   *  destination address. Absent for the fee and blinded wallet outputs. */
  ref?: string;
  /** What this leg is, for display and trust framing:
   *  - "contract": a covenant leg the manifest declares (verified when derived).
   *  - "wallet":   the user's own confidential input / change / receipt.
   *  - "fee":      the network fee output.
   *  - "external": an explicit non-covenant output (e.g. an OP_RETURN beacon). */
  role: "contract" | "wallet" | "fee" | "external";
  /** True when this is a covenant address Apogee derived and verified. */
  verified: boolean;
  /** Manifest author's prose for a contract leg — UNTRUSTED, attribute to site. */
  label?: string;
}

/**
 * What the user actually approves. `net` is authoritative for the IMMEDIATE move
 * (it comes from the PSET's own wallet delta) and says nothing about the
 * covenant's future behaviour — that's what the derived-address check covers.
 */
export interface ManifestReview {
  protocol: string; // manifest `protocol` — untrusted label
  action: string;
  description: string; // action description — untrusted prose
  /** Author's one-line intent summary (`ui.action`), refs interpolated. */
  intent?: string;
  /** Per-asset net wallet delta, sats. Negative = leaves the wallet. Keyed by
   *  asset id hex; the policy asset (`policyAssetHex`) is L-BTC. */
  net: Record<string, number>;
  /** The network's policy asset id hex — the key in `net` that means L-BTC,
   *  as opposed to an issued token. Lets the UI label amounts correctly. */
  policyAssetHex: string;
  fee: number;
  /** Every input of the built transaction, in PSET order. */
  txInputs: ManifestTxLeg[];
  /** Every output of the built transaction, in PSET order (fee included). */
  txOutputs: ManifestTxLeg[];
  /**
   * Whether the manifest's authenticity was verified. Always "unverified" today
   * — the signature/authority scheme doesn't exist yet. Shipped now so that
   * adding verification later REMOVES a warning rather than adding one to a
   * screen users have already learned to read as "fine".
   */
  trust: "unverified";
}

/**
 * Everything the engine needs to finalize ONE keyless covenant input, after the
 * wallet inputs are signed. Carried from `prepareManifest` through the pending
 * approval to `signBroadcastManifest` — the second call never re-runs the planner,
 * so the program to recompile and the witness to satisfy it must travel with it.
 */
export interface ManifestCovenantSpend {
  /** This covenant input's index in the built PSET (located by its outpoint). */
  inputIndex: number;
  /** The `.simf` source text, recompiled to derive the program + control block. */
  source: string;
  compileParams: CompileParam[];
  debugSymbols: boolean;
  /** Keyless witnesses satisfying the covenant, in declaration order. */
  witnesses: PlannedWitness[];
}

/** Built, reviewable manifest action: the PSET to sign + what it does. */
export interface PrepareManifestResult {
  pset: string;
  review: ManifestReview;
  /** Instance JSON text — present (and mandatory) for a constructor action. */
  instance?: string;
  /** Outputs this action creates; `txid` is filled in after broadcast. */
  outputs: ManifestOutputRef[];
  /** Covenant inputs this action spends, needed to finalize after signing. Empty for Fund. */
  covenantSpends: ManifestCovenantSpend[];
}

/** What a dapp gets back from `liquid_runManifest`. */
export interface RunManifestResult {
  txid: string;
  /**
   * The created contract instance, as JSON text. For a constructor this is
   * MANDATORY: the wallet computed the fields (including any `default`), and
   * without them nothing can ever spend what the constructor created.
   */
  instance?: string;
  /** The created UTXOs, for the caller to feed back as `providedInputs` later. */
  utxos?: Array<ManifestOutputRef & { txid: string }>;
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
  | { type: "provider/send"; address: string; sats: number; drain?: boolean }
  // Run a txmanifest action. Flat, not nested: the content bridge spreads the
  // page's `params` into the message root. Note `sources` (plural) survives that
  // hop while a key named `source` would be silently dropped — see content.ts.
  | {
    type: "provider/runManifest";
    action: string;
    manifest: string; // raw txmanifest.json text
    sources: Record<string, string>; // source path → raw .simf text
    instance?: string; // raw instance.json text; omit for constructors
    providedInputs?: Record<string, ProvidedInputDTO>;
    actionParams?: Record<string, string>; // `actionParams`, not `params` — params.params is horrible
  };

/** Lightweight lock state for a connected dapp (no chain sync). */
export interface ProviderStatus {
  locked: boolean;
}

/**
 * LBTC balance for a connected dapp. A locked wallet does NOT serve a balance:
 * `locked: true` with `lbtcSats: null` lets the dapp show a "locked" state
 * instead of mistaking it for an empty (0-sat) wallet.
 */
export interface ProviderBalance {
  locked: boolean;
  lbtcSats: number | null;
  /**
   * Full per-asset balance map (assetIdHex → base-unit amount), including LBTC.
   * Empty `{}` while locked. The dapp filters out LBTC and resolves each token's
   * name/ticker/precision via `getAssetInfo`.
   */
  assets: Record<string, number>;
}

/**
 * A pending dapp action awaiting the user's approval. Rendered as an overlay in
 * the side panel when it's open, or in the standalone prompt popup when it isn't.
 * `connect` authorizes a site; `send` reviews a built spend (PSET + fee) before
 * signing; `manifest` reviews a built txmanifest action. Only the user's
 * explicit approval proceeds.
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
  }
  | {
    kind: "manifest";
    id: string;
    origin: string; // requesting dapp origin
    review: ManifestReview; // built PSET's net effect + the site's own prose
    network: DappNetwork;
    locked: boolean;
    signerKind: WalletSigner; // always "local": a manifest run refuses a Jade
  };

/** Uniform reply envelope for both channels. */
export type Reply<T = unknown> = { ok: true; value: T } | { ok: false; error: string };
