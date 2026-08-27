// Message protocol that ties the three MV3 surfaces together:
//
//   side panel / prompt  --(WalletRequest)-->  service worker
//   service worker       --(EngineRequest)-->  offscreen engine
//
// The service worker owns the keystore (seed-of-record) and brokers every
// engine call; the offscreen document owns lwk_wasm and never sees the
// keystore. Requests are plain JSON (structured-clone over chrome.runtime).

import type { LiquidNetwork, WalletInfo, WalletSigner } from "@/keystore/keystore";
import type { PasskeyKind } from "@/keystore/slots";
import type { TxManifestBundleHash } from "@/tx-manifest/registry";
import type { TxManifestHistoryAnnotation } from "@/tx-manifest/history";
import type {
  AcceptOfferRequirementPlan,
  ClaimLenderVaultRequirementPlan,
  CreateFactoryRequirementPlan,
  CreateOfferRequirementPlan,
  CancelOfferRequirementPlan,
  ClaimPrincipalRequirementPlan,
  LiquidateOfferRequirementPlan,
  RepayLoanRequirementPlan,
  TxManifestInvocation,
} from "@/tx-manifest/requirements";
import type { AcceptOfferChainWalletSnapshot } from "@/tx-manifest/prepare-accept-offer";
import type { ClaimLenderVaultChainWalletSnapshot } from "@/tx-manifest/prepare-claim-lender-vault";
import type {
  AcceptOfferVerifiedChainSnapshot,
  ClaimLenderVaultVerifiedChainSnapshot,
  HostedPreparedAcceptOfferExecution,
  HostedPreparedClaimLenderVaultExecution,
  NewLendingVerifiedChainSnapshot,
} from "@/tx-manifest/wallet-host";
import type {
  TxManifestCovenantCompileSpec,
  TxManifestCovenantDryRunSpec,
  TxManifestCovenantFinalizeSpec,
  TxManifestPsetBuildSpec,
} from "@/tx-manifest/runtime";

// ---- service worker → offscreen engine -------------------------------------

/** IndexedDB database holding persisted scan state (see offscreen.ts). Shared
 *  so the service worker's wallet/reset deletes the same database the
 *  offscreen writes — a drifted string literal would silently stop clearing. */
export const SCAN_STATE_DB = "apogee-scan-state";

/** A request executed inside the offscreen document against lwk_wasm. */
export type EngineRequest =
  | { kind: "getTxManifestSupport"; bundleHash: TxManifestBundleHash }
  | { kind: "resolveTxManifestRequirements"; invocation: TxManifestInvocation }
  | { kind: "compileTxManifestCovenant"; spec: TxManifestCovenantCompileSpec }
  | { kind: "inspectTxManifestTransactionOutput"; transactionHex: string; vout: number }
  | {
      kind: "inspectTxManifestAddress";
      address: string;
      network: TxManifestCovenantCompileSpec["network"];
    }
  | { kind: "dryRunTxManifestCovenant"; spec: TxManifestCovenantDryRunSpec }
  | { kind: "buildTxManifestPset"; spec: TxManifestPsetBuildSpec }
  | { kind: "finalizeTxManifestCovenant"; spec: TxManifestCovenantFinalizeSpec }
  | {
      kind: "prepareLendingV3AcceptOffer";
      plan: AcceptOfferRequirementPlan;
      snapshot: AcceptOfferChainWalletSnapshot;
    }
  | {
      kind: "prepareLendingV3AcceptOfferWithWallet";
      descriptor: string;
      network: LiquidNetwork;
      plan: AcceptOfferRequirementPlan;
      chainSnapshot: AcceptOfferVerifiedChainSnapshot;
    }
  | {
      kind: "dryRunLendingV3AcceptOffer";
      transactionHex: string;
      parentTransactions: string[];
      genesisHash: string;
      covenants: HostedPreparedAcceptOfferExecution["covenants"];
    }
  | {
      kind: "prepareLendingV3ClaimLenderVault";
      plan: ClaimLenderVaultRequirementPlan;
      snapshot: ClaimLenderVaultChainWalletSnapshot;
    }
  | {
      kind: "prepareLendingV3ClaimLenderVaultWithWallet";
      descriptor: string;
      network: LiquidNetwork;
      plan: ClaimLenderVaultRequirementPlan;
      chainSnapshot: ClaimLenderVaultVerifiedChainSnapshot;
    }
  | {
      kind: "dryRunLendingV3ClaimLenderVault";
      transactionHex: string;
      parentTransactions: string[];
      genesisHash: string;
      vault: HostedPreparedClaimLenderVaultExecution["vault"];
    }
  | {
      kind: "prepareLendingV3NewActionWithWallet";
      descriptor: string;
      network: LiquidNetwork;
      assetContractDomain: string;
      plan:
        | CreateFactoryRequirementPlan
        | CreateOfferRequirementPlan
        | ClaimPrincipalRequirementPlan
        | CancelOfferRequirementPlan
        | RepayLoanRequirementPlan
        | LiquidateOfferRequirementPlan;
      chainSnapshot: NewLendingVerifiedChainSnapshot;
    }
  | { kind: "generateMnemonic"; words?: 12 | 24 }
  | { kind: "deriveWallet"; mnemonic: string; network: LiquidNetwork }
  | { kind: "sync"; descriptor: string; network: LiquidNetwork; esploraUrl?: string }
  | { kind: "getAddress"; descriptor: string; network: LiquidNetwork; index?: number }
  | { kind: "getBalance"; descriptor: string; network: LiquidNetwork }
  | { kind: "getTransactions"; descriptor: string; network: LiquidNetwork }
  | { kind: "signPset"; mnemonic: string; network: LiquidNetwork; pset: string }
  | {
      kind: "signTxManifestPset";
      mnemonic: string;
      descriptor: string;
      network: LiquidNetwork;
      pset: string;
    }
  | { kind: "getRate"; currency: string } // BTC price in `currency` (median of sources)
  // Hourly BTC price history for the price chart, newest-last, in `currency`.
  // `range` selects the window; see `PriceRange` and `engine-core.ts` getPriceHistory.
  | { kind: "getPriceHistory"; currency: string; range: PriceRange }
  // BTC price 24h ago in `currency` — a single point (~148 bytes), for the rate
  // bar's delta. Deliberately separate from getPriceHistory, whose full series is
  // ~147 KB and only worth fetching when the chart is expanded.
  | { kind: "getPrice24hAgo"; currency: string }
  | { kind: "qr"; text: string } // monochrome QR bitmap as a data-URI
  | { kind: "getAsset"; assetId: string; network: LiquidNetwork } // registry metadata
  // Validate a pasted watch-only descriptor and read its fingerprint + network
  // (constructing the WolletDescriptor throws on a malformed descriptor).
  | { kind: "descriptorInfo"; descriptor: string }
  // ELIP-0144/0152 identity metadata for a browser-provider connection.
  | { kind: "walletIdentity"; descriptor: string; network: LiquidNetwork }
  // Privacy-safe ELIP descriptor projection. LWK validates and canonicalizes
  // the CT descriptor before the private SLIP-77 wrapper is removed.
  | { kind: "getPublicWalletDescriptor"; descriptor: string }
  // Read-only preflight for the future ELIP signPset RPC. The caller must sync
  // the Wollet first; this operation never sees a seed and never signs.
  | {
      kind: "analyzeProviderPset";
      descriptor: string;
      network: LiquidNetwork;
      pset: string;
      signInputs: ProviderPsetSignInputDTO[];
    }
  // Atomic approval binding for the public ELIP signPset path. The same parsed
  // PSET is re-analyzed against current wallet state and passed to the signer
  // only when its review still matches what the user approved.
  | {
      kind: "signProviderPset";
      mnemonic: string;
      descriptor: string;
      network: LiquidNetwork;
      pset: string;
      signInputs: ProviderPsetSignInputDTO[];
      expectedAnalysis: ProviderPsetAnalysisDTO;
    }
  // Complete an already-signed provider PSET without submitting it. Keeping
  // this separate from broadcast lets the service worker re-check the origin's
  // authorization after finalization and immediately before the irreversible
  // network action.
  | { kind: "finalizePset"; descriptor: string; network: LiquidNetwork; pset: string }
  | { kind: "extractPsetTransaction"; pset: string }
  // Submit an already-finalized PSET. All transaction cryptography and
  // extraction remain inside LWK; this request only selects the chain server.
  | { kind: "broadcastPset"; network: LiquidNetwork; pset: string; esploraUrl?: string }
  // Recovery submits the exact signed transaction saved before the original
  // network attempt. No plan rebuilding or signing occurs on this path.
  | {
      kind: "broadcastTransaction";
      network: LiquidNetwork;
      transactionHex: string;
      esploraUrl?: string;
    }
  // `drain` (send max): for LBTC, drain the wallet (fee deducted from the
  // amount); for a token (`asset` set), send the full token balance (the fee is
  // paid in LBTC, so no deduction). `sats` is in the asset's base units.
  | {
      kind: "prepareSend";
      descriptor: string;
      network: LiquidNetwork;
      address: string;
      /** Base-unit amount. Decimal strings preserve ELIP RPC values above 2^53. */
      sats: number | string;
      drain?: boolean;
      asset?: string; // asset id hex; absent → LBTC (policy asset)
    }
  | { kind: "signBroadcast"; mnemonic: string; descriptor: string; network: LiquidNetwork; pset: string; esploraUrl?: string }
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
  // UI-safe coin list: address and confidentiality, but no blinding factors.
  | { kind: "getWalletUtxos"; descriptor: string; network: LiquidNetwork }
  // Privacy-safe ELIP browser-provider projection. Unlike `getUtxos`, this
  // request never returns blinding factors; it includes the raw previous TxOut
  // so a dapp can construct a PSET without receiving wallet view material.
  | {
      kind: "getProviderUtxos";
      descriptor: string;
      network: LiquidNetwork;
      asset: string;
    }
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
  /** Independent upper bound on the send-asset principal. Critical in
   *  receive-exact mode where the dealer determines the send amount. Derived
   *  from the user-reviewed estimate, not the execution-time quote. */
  maxSendAmount?: string;
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

/** Public ELIP UTXO data safe to cross into a web page. Asset and amount are
 * wallet-unblinded values, but no factor, nonce secret, or view key is exposed. */
export interface ProviderUtxoDTO {
  txid: string;
  vout: number;
  asset: string; // hex asset id
  amount: string; // base-10 base-unit amount
  address: string;
  scriptPubKey: string; // lowercase consensus-script hex
  txOut: string; // lowercase Elements TxOut consensus serialization, no witness
  confidential: boolean;
}

/** UI-safe coin view: address and confidentiality, but no blinding factors. */
export interface WalletUtxoDTO {
  txid: string;
  vout: number;
  address: string;
  asset: string; // hex asset id
  amount: string; // base-10 base-unit amount
  confidential: boolean;
}

/** Input authorization requested by the ELIP signPset caller. */
export interface ProviderPsetSignInputDTO {
  index: number;
  address: string;
  sighashTypes?: number[];
}

export interface ProviderPsetInputReviewDTO {
  index: number;
  txid: string;
  vout: number;
  address: string;
  assetId: string;
  amount: string;
  scriptPubKey: string;
  confidential: boolean;
  sighashType: number;
}

export interface ProviderPsetRecipientReviewDTO {
  address: string;
  assetId: string;
  amount: string;
  confidential: boolean;
}

/** Secret-free review material produced before a PSET can reach a signer. */
export interface ProviderPsetAnalysisDTO {
  uniqueId: string;
  walletStatus: string;
  inputCount: number;
  outputCount: number;
  policyAssetId: string;
  inputs: ProviderPsetInputReviewDTO[];
  recipients: ProviderPsetRecipientReviewDTO[];
  balanceChanges: Record<string, string>;
  fees: Record<string, string>;
  hasConfidentialInputs: boolean;
  hasConfidentialOutputs: boolean;
}

export interface ProviderPsetApprovalReviewDTO extends ProviderPsetAnalysisDTO {
  accountIdentifier: string;
}

/** Resolved display metadata for a single asset id in a manifest review. */
export interface TxManifestAssetMeta {
  /** Known label, registry ticker/name, or shortened-hex fallback. */
  label: string;
  ticker: string | null;
  precision: number | null;
  /** Provenance of presentation-only metadata; never an asset identity proof. */
  source?: "builtin" | "registry" | "fallback";
}

interface TxManifestApprovalReviewBaseDTO {
  protocolLabel: string;
  actionLabel: string;
  requestId: string;
  accountIdentifier: string;
  bundleHash: string;
  action: string;
  feeAssetId: string;
  fee: string;
  feeChange: string;
  /**
   * Resolved metadata for every distinct asset id in this review. Optional so
   * durable recovery checkpoints written by older builds remain renderable.
   */
  assets?: Record<string, TxManifestAssetMeta>;
}

export type TxManifestApprovalReviewDTO =
  | (TxManifestApprovalReviewBaseDTO & {
      kind: "createFactory";
      factoryAssetId: string;
      fundingAmount: string;
    })
  | (TxManifestApprovalReviewBaseDTO & {
      kind: "createOffer";
      factoryAssetId: string;
      borrowerNftAssetId: string;
      lenderNftAssetId: string;
      principalAssetId: string;
      principalAmount: string;
      collateralAssetId: string;
      collateralAmount: string;
      interestRateBasisPoints: string;
      totalDebt: string;
      expirationHeight: number;
      collateralChange: string;
    })
  | (TxManifestApprovalReviewBaseDTO & {
      kind: "acceptOffer";
      /** Optional so pre-field durable checkpoints remain renderable. */
      lenderNftAssetId?: string;
      principalAssetId: string;
      principalAmount: string;
      collateralAssetId: string;
      collateralAmount: string;
      interestRateBasisPoints: string;
      totalDebt: string;
      expirationHeight: number;
      principalChange: string;
    })
  | (TxManifestApprovalReviewBaseDTO & {
      kind: "claimLenderVault";
      principalAssetId: string;
      principalAmount: string;
      grossDebt: string;
      interestAmount: string;
      protocolFeeAmount: string;
      lenderNftAssetId: string;
    })
  | (TxManifestApprovalReviewBaseDTO & {
      kind: "claimPrincipal" | "cancelOffer" | "repayLoan" | "liquidateOffer";
      principalAssetId: string;
      principalAmount: string;
      collateralAssetId: string;
      collateralAmount: string;
      borrowerNftAssetId: string;
      lenderNftAssetId: string;
      expirationHeight: number;
      totalDebt?: string;
      interestAmount?: string;
      protocolFeeAmount?: string;
      lenderVaultAmount?: string;
      principalChange: string;
    });

export type ProviderPsetAnalysisFailureReason =
  | "analysis_failed"
  | "duplicate_input"
  | "input_address_mismatch"
  | "input_not_current_utxo"
  | "input_prevout_mismatch"
  | "invalid_address"
  | "invalid_request"
  | "malformed_pset"
  | "non_policy_fee"
  | "private_or_unsupported_script"
  | "pset_balance_mismatch"
  | "pset_value_mismatch"
  | "sighash_not_allowed"
  | "unreviewable_output"
  | "unrequested_wallet_input"
  | "unsupported_sighash"
  | "unsupported_issuance";

export type ProviderPsetAnalysisResultDTO =
  | {
      ok: true;
      analysis: ProviderPsetAnalysisDTO;
      /**
       * The same PSET after LWK added trusted wallet prevout and derivation
       * details. Hardware signers must receive this serialization rather than
       * the caller's potentially sparse input.
       */
      pset: string;
    }
  | { ok: false; reason: ProviderPsetAnalysisFailureReason; inputIndex?: number };

export type ProviderPsetSignResultDTO =
  | { ok: true; pset: string; analysis: ProviderPsetAnalysisDTO }
  | {
      ok: false;
      reason: ProviderPsetAnalysisFailureReason | "review_changed" | "signing_failed";
      inputIndex?: number;
    };

/** Result of `descriptorInfo`: the master fingerprint embedded in a watch-only
 *  descriptor, and whether it targets mainnet (used to sanity-check the network). */
export interface DescriptorInfo {
  fingerprint: string;
  mainnet: boolean;
}

export interface WalletIdentity {
  dwid: string;
  chainId: string;
  policyAssetId: string;
}

/** Windows the price chart can show. The upstream series is hourly, so the short
 *  ranges are the sparse ones: 24h is ~25 points, 1y is ~8,760. */
export type PriceRange = "24h" | "7d" | "30d" | "1y" | "all";

/** Hourly BTC price history for one range, oldest-first — the shape the chart
 *  draws. `points` are already converted to the requested currency. */
export interface PriceHistory {
  currency: string;
  range: PriceRange;
  /** Close price per point, oldest-first. At least 2 entries, or the engine throws
   *  (a single point can't be drawn and a flat pair can't be scaled). */
  points: number[];
  /** Unix seconds for each entry in `points`, same length and order. Required
   *  because the upstream series is NOT evenly spaced — weekly before 2013, daily
   *  until late 2023, hourly after — so the chart must position by time. Plotting by
   *  array index crushes 2010-2023 into the leftmost few percent of the width. */
  times: number[];
  /** Unix seconds of the first and last point, so the UI can label the window
   *  without recomputing it from the range. */
  fromTime: number;
  toTime: number;
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

/** Envelope for one engine round-trip on the SW↔offscreen port. */
export interface EnginePortMessage {
  id: number;
  req: EngineRequest;
}

/** Reply to an EnginePortMessage, matched by id. */
export interface EnginePortReply {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** Watch-only material derived from a mnemonic (handed to the keystore). */
export interface DerivedWallet {
  descriptor: string; // standard BIP84 ct(slip77(..),elwpkh([fp/84h/<coin>h/0h]xpub/<0;1>/*))
  fingerprint: string;
}

export interface PublicWalletDescriptorDTO {
  descriptor: string;
  standardsUsed: string[];
}

export interface AddressDTO {
  index: number;
  address: string;
}

/** Result of a full Esplora scan: LBTC sats plus the full per-asset map. */
export interface SyncResult {
  lbtcSats: number;
  balance: Record<string, number>; // assetIdHex → sats
  /** Exact base-10 values for RPC consumers that must not round large issued-asset amounts. */
  balanceStrings?: Record<string, string>;
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
  txManifest?: TxManifestHistoryAnnotation;
}

// ---- side panel / prompt → service worker ----------------------------------

export type WalletRequest =
  // panelSession: random id minted per panel-document load. Lets the SW tell
  // "same panel session" from "panel closed and reopened" for the auto-lock-
  // "never" step-up. Absent from non-panel callers.
  | { type: "wallet/getState"; panelSession?: string }
  | { type: "wallet/initializeKeystore"; password: string }
  | { type: "wallet/unlock"; panelSession?: string; password: string }
  | { type: "wallet/lock" }
  | { type: "wallet/reset" }
  | { type: "wallet/verifyPassword"; password: string }
  // Auto-lock "never" step-up: re-verify the password from a reopened panel.
  // Shares the unlock throttle with unlock/verifyPassword (same password oracle).
  | { type: "wallet/stepUp"; panelSession?: string; password: string }
  // Unlock-attempt throttle state (fails / cooldown / hard lock) for the UI.
  | { type: "wallet/getUnlockThrottle" }
  // Passkey unlock (docs/passkey-unlock.md). The PRF bytes travel BASE64: a
  // Uint8Array in a runtime message arrives as a plain object and would
  // silently derive the wrong key — the router decodes and length-checks.
  | { type: "wallet/listPasskeys" }
  | { type: "wallet/passkeyChallenge" } // enrolled credentials + vault PRF salt, or null
  | {
      type: "wallet/enrollPasskey";
      prf: string;
      credentialId: string;
      kind: PasskeyKind;
      /** The authenticator's transport hints from the create() that just ran.
       *  Recorded so a later ceremony can name this credential the way the
       *  browser needs to reach it — `hybrid` is what makes Chrome offer the
       *  phone instead of only looking locally. Optional: some authenticators
       *  report none, and none is a valid answer. */
      transports?: string[];
      // The salt the ceremony evaluated. For the vault's FIRST passkey there
      // is nothing stored to hand the ceremony, so the panel mints it and the
      // SW adopts it; once a passkey exists the stored salt is authoritative
      // and a mismatch is refused (the slot would look enrolled and open for
      // nobody).
      prfSalt: string;
    }
  | { type: "wallet/unlockWithPasskey"; panelSession?: string; prf: string }
  | { type: "wallet/removePasskey"; id: string }
  // password (first run) initializes the keystore as part of the same call.
  | { type: "wallet/create"; password?: string; label: string; network: LiquidNetwork }
  // NOTE: `wallet/restore` is deliberately NOT here — its plaintext mnemonic
  // must never ride the broadcast runtime.sendMessage channel. It travels on a
  // dedicated runtime.connect port (see RestoreWalletRequest below).
  | { type: "wallet/sync"; walletId?: string }
  | { type: "wallet/getAddress"; walletId?: string; index?: number }
  | { type: "wallet/getBalance"; walletId?: string }
  | { type: "wallet/getTransactions"; walletId?: string }
  | { type: "wallet/getUtxos"; walletId?: string }
  | { type: "wallet/revealMnemonic"; walletId: string; password: string }
  | { type: "wallet/getRate"; currency: string }
  | { type: "wallet/getPriceHistory"; currency: string; range: PriceRange }
  | { type: "wallet/getPrice24hAgo"; currency: string }
  // Open the guide page, focusing the already-open tab if there is one. Lives in
  // the SW because it remembers the tab id it created — `tabs.query({url})` needs
  // the broad "tabs" permission, which this doesn't warrant.
  | { type: "wallet/openGuide" }
  // Read the newest published release and compare it to this build. Runs only on
  // an explicit user click (Settings → Check for updates), never on open or a
  // timer. In the SW because the fetch needs the api.github.com host permission.
  | { type: "wallet/checkUpdate" }
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
  // Dapp provider connections: list/revoke sites connected to the wallet.
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
    }
  // Instant swap via SideSwap dealer. Specify EITHER `sendAmount` (sell exact)
  // OR `recvAmount` (receive exact). When `recvAmount` is set, the dealer
  // calculates the required send amount so the user receives exactly that much.
  | {
      type: "wallet/swap";
      walletId?: string;
      sendAssetId: string;
      recvAssetId: string;
      sendAmount?: number; // base units of the send asset (sell-exact mode)
      recvAmount?: number; // base units of the receive asset (receive-exact mode)
      /** User-reviewed send amount from the preview quote (base-10 string).
       *  Caps the send principal in receive-exact mode. */
      reviewedSendAmount?: string;
      /** User-reviewed receive amount from the preview quote (base-10 string).
       *  Binds the slippage floor in sell-exact mode. */
      reviewedRecvAmount?: string;
      /** Step-up password for never-auto-lock wallets — mirrors `wallet/send`.
       *  Required when auto-lock is "never" (the wallet stays unlocked, so a
       *  fund-moving op re-confirms the password). Ignored otherwise. */
      password?: string;
    }
  // Quote preview for a swap: connects to SideSwap, runs startQuotes, and
  // returns the expected receive amount — no signing, no broadcast.
  | {
      type: "wallet/swapQuote";
      walletId?: string;
      sendAssetId: string;
      recvAssetId: string;
      sendAmount?: number; // base units of the send asset (sell-exact mode)
      recvAmount?: number; // base units of the receive asset (receive-exact mode)
    };

/** `wallet/restore` over the dedicated point-to-point port. Same shape the
 *  broadcast variant had — it just never fans out to other extension contexts.
 *  `replace` (forgot-password recovery): wipe the existing unlockable-no-more
 *  vault first, but only after the phrase validates, so a typo can't destroy it. */
export interface RestoreWalletRequest {
  type: "wallet/restore";
  password?: string;
  mnemonic: string;
  label: string;
  network: LiquidNetwork;
  replace?: boolean;
}

/** Everything the SW's UI router accepts: broadcast wallet/* messages plus the
 *  port-only restore request. */
export type UiRequest = WalletRequest | RestoreWalletRequest;

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
  /** Exact base-10 values for browser RPC callers; the numeric fields are legacy UI compatibility. */
  feeAmount: string;
  recipientAmount: string;
  assetId: string; // which asset moves — the policy asset hex for LBTC sends
  // The destination belongs to this wallet, so the funds come straight back and
  // the fee is the whole cost. Say so on review screens: otherwise a self-send
  // reads as an ordinary spend whose amount vanishes from the wallet.
  toSelf: boolean;
}

export interface SendResult {
  txid: string;
}

/** Result of an instant swap (SideSwap). Amounts are base-10 strings for
 *  BigInt-safe transport across chrome.runtime. */
export interface SwapResultDTO {
  txid: string;
  sent: string; // base-10, base units of the send asset
  received: string; // base-10, base units of the receive asset
  fee: string; // base-10, LBTC sats
}

/** Preview of a swap quote — no signing or broadcast. Amounts are the dealer's
 *  live quote estimates; the actual amounts may differ at execution (the
 *  verification gate protects against unfavorable changes). */
export interface SwapQuotePreview {
  sendAmount: string; // base-10, base units of the send asset (from dealer's base_amount)
  recvAmount: string; // base-10, base units of the receive asset (from dealer's quote_amount)
  /** Epoch ms when the dealer's quote expires (derived from its `ttl`). The UI
   *  counts down to this and re-quotes instead of submitting a dead quote_id,
   *  which would fail only after burning a password step-up round trip. */
  expiresAt: number;
  /** The dealer's fee components as base-10 sats strings (L-BTC-denominated).
   *  Surfaced so the review screen can disclose the full cost of a swap: these
   *  are flat, so on a small swap they dominate (a $1 swap loses ~9% to the
   *  dealer fee plus the network fee, vs ~0.1% on a $100 swap). */
  fixedFee: string;
  serverFee: string;
}

/** Human-readable spend details for the Jade signing tab's review summary. */
export interface SendReview {
  address: string;
  recipientAmount: string; // base units of the sent asset (sats for LBTC)
  feeAmount: string; // LBTC sats
  drain: boolean;
  // Destination is one of this wallet's own addresses — the amount returns, so
  // the fee is the only cost. Display-only, like the rest of this summary.
  // Required so every construction site states it rather than defaulting to
  // "not a self-send" by omission.
  toSelf: boolean;
  // Present for token sends (display-only — the PSET is the signed truth, and
  // the Jade device shows asset ids on-screen independently).
  assetId?: string;
  assetTicker?: string | null;
  assetPrecision?: number | null;
  /** Present for standard browser-provider transfers so the selected account is reviewable. */
  accountIdentifier?: string;
}

// ---- page provider (dapp) → content bridge → service worker ----------------
//
// A web page talks to the MAIN-world provider façade,
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
  | { type: "provider/rpc"; request: unknown }
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
      methods: string[]; // exact standard-method grant after approval
      events: string[]; // exact standard-event grant after approval
      legacy: boolean; // request came through the backwards-compatible window.liquid API
    }
  | {
      kind: "send";
      id: string;
      origin: string; // requesting dapp origin
      review: SendReview;
      network: DappNetwork;
      locked: boolean; // wallet was locked at request time → the UI must unlock first
      signerKind: WalletSigner; // "local" | "jade" — jade signs on-device in a tab
    }
  | {
      kind: "signPset";
      id: string;
      origin: string;
      review: ProviderPsetApprovalReviewDTO;
      network: DappNetwork;
      locked: boolean;
      signerKind: WalletSigner;
      /** True only when approval also authorizes irreversible network submission. */
      broadcast: boolean;
    }
  | {
      kind: "executeTxManifest";
      id: string;
      origin: string;
      review: TxManifestApprovalReviewDTO;
      network: DappNetwork;
      locked: boolean;
      signerKind: WalletSigner;
      /** The exact previously-approved transaction is being resumed. */
      recovery?: boolean;
    };

/** Uniform reply envelope for both channels. */
export type Reply<T = unknown> = { ok: true; value: T } | { ok: false; error: string };
