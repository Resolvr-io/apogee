// SideSwap instant-swap orchestration. Chains the dealer-quoted flow:
//
//   getUtxos (filtered to send-asset) → startQuotes → wait → getQuote →
//   signSwapPset (atomic verify + sign + finalize) → takerSign
//
// Three safety properties hold it together:
//
//   1. **Atomic verify+sign.** One engine call, so an unverified PSET can never
//      slip in between the two steps.
//   2. **Send-asset-only UTXOs.** `getUtxos` returns the whole wallet with
//      blinding factors; filtering to the send asset keeps SideSwap from
//      unblinding unrelated holdings.
//   3. **Independent maxFee.** The caller MUST derive the cap from its own
//      estimate (feerate × vsize, or a sane ceiling), never from the dealer.

import type { SideSwapClient, SideSwapUtxo, SideSwapQuoteSuccess, SideSwapAssetType, SideSwapTradeDir } from "./client";
import type { EngineRequest, UtxoDTO, VerifyDealerPsetTermsDTO, SignSwapPsetWireResult } from "@/engine/protocol";
import type { LiquidNetwork } from "@/keystore/keystore";
import { policyAssetId } from "@/lib/asset-registry";

// ---- public types --------------------------------------------------------

/** Independent fee cap + swap parameters. The caller is responsible for
 *  ensuring `maxFee` is NOT derived from dealer data.
 *
 *  Two quoting modes:
 *  - **Sell-exact** (`sendAmount` set): "I want to sell exactly X base units."
 *    The dealer determines how much quote asset you receive.
 *  - **Receive-exact** (`recvAmount` set): "I want to receive exactly Y quote
 *    units." The dealer determines how much base asset you must send. This is
 *    what SideSwap's own app uses — the user types $1 USDT and receives $1. */
export interface SwapParams {
  sendAssetId: string;
  recvAssetId: string;
  /** Sell-exact: base units of the send asset to sell. Mutually exclusive
   *  with `recvAmount` — exactly one must be set. */
  sendAmount?: number;
  /** Receive-exact: base units of the receive asset the user wants. The dealer
   *  calculates the required send amount. */
  recvAmount?: number;
  /** Required cap on the send-asset (L-BTC) network fee, in base units.
   *  MUST be an independent estimate — see module docs. */
  maxFee: bigint;
  /** Minimum acceptable receive amount, in base units. Applied as slippage
   *  protection: the verification gate rejects any PSET that delivers less.
   *  If omitted, defaults to the user-reviewed amount minus 3% tolerance. */
  minRecvAmount?: bigint;
  /** User-reviewed send amount from the preview quote (base units). In
   *  receive-exact mode the dealer determines the send amount, so this
   *  independent cap — from the amount the user saw and approved — prevents
   *  a malicious dealer from inflating the charge at execution time. */
  reviewedSendAmount?: bigint;
  /** User-reviewed receive amount from the preview quote (base units). In
   *  sell-exact mode, this binds the slippage floor to what the user actually
   *  approved rather than re-deriving it from the execution-time dealer quote. */
  reviewedRecvAmount?: bigint;
}

/** Dependencies the service worker injects. */
export interface SwapDeps {
  client: SideSwapClient;
  /** Engine round-trip (sends an EngineRequest to the offscreen document). */
  engineCall: <T>(req: EngineRequest) => Promise<T>;
  descriptor: string;
  network: LiquidNetwork;
  mnemonic: string;
}

export interface SwapResult {
  txid: string;
  sent: bigint;
  received: bigint;
  fee: bigint;
}

export class SwapError extends Error {}

/** Dealer couldn't fill the requested size. Carries the dealer's own numbers so
 *  the UI can tell the user how much IS fillable instead of a bare "not enough" —
 *  `available` is the dealer's fillable amount in the `asset_type` side's units. */
export class SwapLowBalanceError extends SwapError {
  constructor(
    message: string,
    readonly available: bigint,
  ) {
    super(message);
  }
}

export interface SwapQuotePreviewResult {
  sendAmount: bigint;
  recvAmount: bigint;
  /** Epoch ms when this quote expires (from the dealer's `ttl`, in ms). The UI
   *  counts down to it and re-quotes rather than submitting a dead quote_id. */
  expiresAt: number;
  /** The dealer's own fee components, in sats (they're L-BTC-denominated). Shown
   *  in the review breakdown so the cost of a swap is disclosed rather than
   *  buried in the rate — on a small swap these dominate. */
  fixedFee: bigint;
  serverFee: bigint;
}

// ---- result of the atomic signSwapPset engine call -----------------------
//
// Request shape: { kind: "signSwapPset"; mnemonic; descriptor; network; pset;
// terms: VerifyDealerPsetTermsDTO }. Result: `SignSwapPsetWireResult` from
// protocol.ts.

// ---- UTXO filtering ------------------------------------------------------

/** Filter wallet UTXOs to the send-asset only and map to SideSwap wire format.
 *  Apogee wallets are P2WPKH — no redeem script, so `redeem_script` is null. */
export function filterSendAssetUtxos(utxos: UtxoDTO[], sendAssetId: string): SideSwapUtxo[] {
  return utxos
    .filter((u) => u.asset === sendAssetId)
    .map((u) => ({
      txid: u.txid,
      vout: u.vout,
      asset: u.asset,
      asset_bf: u.assetBf,
      value: Number(u.value),
      value_bf: u.valueBf,
      redeem_script: null,
    }));
}

// ---- SideSwap pair orientation -------------------------------------------

/** Build a correctly-oriented SideSwap asset pair and trade direction.
 *
 *  SideSwap requires `base` to always be the policy asset (LBTC). The `quote`
 *  is the other asset.
 *
 *  `trade_dir` is relative to `asset_type` (NOT to the LBTC direction):
 *  - "Sell" = "I am selling the `asset_type` asset" (sell-exact mode)
 *  - "Buy"  = "I am buying the `asset_type` asset" (receive-exact mode)
 *
 *  `asset_type` indicates which side the `amount` in `start_quotes` refers to.
 *  In sell-exact mode it's the send side; in receive-exact mode it's the
 *  receive side. The value is "Base" when that side is LBTC, "Quote" otherwise. */
export function orientPair(
  sendAssetId: string,
  recvAssetId: string,
  network: LiquidNetwork,
  receiveExact: boolean = false,
): {
  asset_pair: { base: string; quote: string };
  trade_dir: SideSwapTradeDir;
  asset_type: SideSwapAssetType;
} {
  const policy = policyAssetId(network);
  const sellingLbtc = sendAssetId === policy;

  // base is always LBTC, quote is the other asset.
  const asset_pair = sellingLbtc
    ? { base: sendAssetId, quote: recvAssetId }
    : { base: recvAssetId, quote: sendAssetId };
  // trade_dir is relative to asset_type: "Sell" = selling the asset_type
  // asset, "Buy" = buying it. In sell-exact mode the user is always selling;
  // in receive-exact mode, always buying.
  const trade_dir: SideSwapTradeDir = receiveExact ? "Buy" : "Sell";

  // asset_type tells SideSwap which side the `amount` field refers to.
  // In sell-exact mode, the amount is the send side.
  // In receive-exact mode, the amount is the receive side.
  let asset_type: SideSwapAssetType;
  if (receiveExact) {
    // Amount is the receive side. Is the receive asset base (LBTC) or quote?
    asset_type = recvAssetId === policy ? "Base" : "Quote";
  } else {
    // Amount is the send side. Is the send asset base (LBTC) or quote?
    asset_type = sendAssetId === policy ? "Base" : "Quote";
  }

  return { asset_pair, trade_dir, asset_type };
}

// ---- orchestration -------------------------------------------------------

/** Execute a dealer-quoted instant swap end-to-end.
 *
 *  Throws `SwapError` on any failure (dealer rejection, verification gate,
 *  signing error, settlement failure). The SideSwap client must already be
 *  connected. */
export async function executeInstantSwap(
  params: SwapParams,
  deps: SwapDeps,
): Promise<SwapResult> {
  const { client, engineCall, descriptor, network, mnemonic } = deps;
  const { sendAssetId, recvAssetId, maxFee } = params;

  // Determine quoting mode: receive-exact or sell-exact.
  const receiveExact = params.recvAmount != null;
  if (!receiveExact && params.sendAmount == null) {
    throw new SwapError("either sendAmount or recvAmount must be specified");
  }

  // Fail-closed: in receive-exact mode the dealer determines the send amount,
  // so the user-reviewed send cap is the only independent upper bound. If the
  // preview quote was never obtained (e.g. dealer was down), reject rather
  // than falling back to uncapped dealer-derived amounts.
  if (receiveExact && params.reviewedSendAmount == null) {
    throw new SwapError(
      "receive-exact swap requires a reviewed send amount from the preview quote"
    );
  }

  // 1. Get UTXOs and filter to send-asset only (prerequisite 2).
  const allUtxos = await engineCall<UtxoDTO[]>({
    kind: "getUtxos",
    descriptor,
    network,
  });

  const swapUtxos = filterSendAssetUtxos(allUtxos, sendAssetId);
  if (swapUtxos.length === 0) {
    throw new SwapError(`no UTXOs found for send asset ${sendAssetId}`);
  }

  // 2. Get receive and change addresses. The engine's getAddress returns the
  //    next unused address but does not advance wallet state, so two calls
  //    with no index return the same address. Pass an explicit index for change.
  const receiveResult = await engineCall<{ address: string; index: number }>({
    kind: "getAddress",
    descriptor,
    network,
  });
  const changeResult = await engineCall<{ address: string }>({
    kind: "getAddress",
    descriptor,
    network,
    index: receiveResult.index + 1,
  });

  // 3. Start quotes with filtered UTXOs. orientPair ensures the asset pair
  //    has LBTC as base (SideSwap convention) and sets trade_dir/asset_type
  //    based on the swap direction and quoting mode.
  const { asset_pair, trade_dir, asset_type } = orientPair(
    sendAssetId, recvAssetId, network, receiveExact,
  );
  const startResult = await client.startQuotes({
    asset_pair,
    asset_type,
    amount: receiveExact ? params.recvAmount! : params.sendAmount!,
    trade_dir,
    utxos: swapUtxos,
    receive_address: receiveResult.address,
    change_address: changeResult.address,
  });

  // 4. Wait for the first viable quote notification. waitForQuote only
  //    resolves on Success — it rejects on Error/LowBalance, so no
  //    non-Success branch is needed here.
  const success = await waitForQuote(client, startResult.quote_sub_id);

  // 5. Get the dealer-built unsigned PSET.
  const quoteResult = await client.getQuote(success.quote_id);

  // 6. Atomic verify + sign + finalize in one engine call, with the caller's
  //    independent maxFee cap.
  //
  //    base_amount/quote_amount always refer to the pair's base (LBTC) and quote.
  //    Map to send/recv by which asset the user is sending.
  const sendIsBase = sendAssetId === policyAssetId(network);
  // `base_amount`/`quote_amount` EXCLUDE the dealer's fee, which is always
  // L-BTC-denominated, while the gate measures NET policy-asset outflow, which
  // includes it. So on an L-BTC send the quoted figure must be made fee-inclusive
  // before it becomes `sendAmount`, or check 2 rejects the real outflow.
  //
  // Measured on mainnet: 1556 base + 83 dealer + 60 network = 1699 sent against a
  // fee-exclusive bound of 1617. Every receive-exact L-BTC swap would be refused
  // as "the rate moved unfavorably".
  const dealerFee =
    BigInt(Math.round(success.fixed_fee)) + BigInt(Math.round(success.server_fee));
  const quotedSendAmt =
    BigInt(Math.round(sendIsBase ? success.base_amount : success.quote_amount)) +
    (sendIsBase ? dealerFee : 0n);
  const quotedRecvAmt = BigInt(Math.round(
    sendIsBase ? success.quote_amount : success.base_amount,
  ));
  // Use the original sendAmount (what the user offered) for sell-exact, or
  // the dealer's quoted send amount for receive-exact (user didn't specify).
  //
  // Sell-exact keeps the user's own figure: the dealer takes its fee out of what
  // was offered rather than charging on top, so the outflow is bounded by
  // `sendAmount + fee` already.
  const effectiveSendAmount = receiveExact
    ? quotedSendAmt
    : BigInt(params.sendAmount!);

  // The user-reviewed amounts from the preview quote are the authoritative
  // bounds — what the user saw before tapping Confirm. The execution-time quote
  // may differ, and these caps catch that drift.
  //
  // minRecvAmount prefers the reviewed estimate minus 3% over the execution-time
  // quote. In receive-exact mode the user typed the amount, so use it directly.
  const defaultMinRecv = receiveExact
    ? BigInt(params.recvAmount!)
    : params.reviewedRecvAmount != null
      ? params.reviewedRecvAmount * 97n / 100n
      : quotedRecvAmt * 97n / 100n;
  const minRecv = params.minRecvAmount ?? defaultMinRecv;

  // maxSendAmount: in receive-exact mode, the dealer chooses how much to
  // charge. Cap it at the user-reviewed send estimate + 5% so a re-quoted
  // rate can't drain more than the user approved. In sell-exact mode the
  // user specified the exact send amount — no extra cap needed.
  let maxSendAmount: string | undefined;
  if (receiveExact && params.reviewedSendAmount != null) {
    const cap = params.reviewedSendAmount * 105n / 100n;
    maxSendAmount = cap.toString();
  }

  const terms: VerifyDealerPsetTermsDTO = {
    sendAssetId,
    sendAmount: effectiveSendAmount.toString(),
    recvAssetId,
    minRecvAmount: minRecv.toString(),
    maxFee: maxFee.toString(),
    maxSendAmount,
  };

  const signResult = await engineCall<SignSwapPsetWireResult>({
    kind: "signSwapPset",
    mnemonic,
    descriptor,
    network,
    pset: quoteResult.pset,
    terms,
  });

  if (!signResult.ok) {
    throw new SwapError(`verification gate rejected the PSET: ${signResult.reason}`);
  }

  // 7. Submit the finalized PSET — SideSwap adds dealer sigs and broadcasts.
  const settleResult = await client.takerSign(success.quote_id, signResult.pset);

  return {
    txid: settleResult.txid,
    sent: BigInt(signResult.sent),
    received: BigInt(signResult.received),
    fee: BigInt(signResult.fee),
  };
}

/** Fetch a dealer quote preview — steps 1-4 only (UTXOs → startQuotes →
 *  waitForQuote). No PSET fetch, no signing, no broadcast. Returns the
 *  estimated receive amount from the dealer's live quote. */
export async function previewSwapQuote(
  params: Omit<SwapParams, "maxFee" | "minRecvAmount">,
  deps: Pick<SwapDeps, "client" | "engineCall" | "descriptor" | "network">,
): Promise<SwapQuotePreviewResult> {
  const { client, engineCall, descriptor, network } = deps;
  const { sendAssetId, recvAssetId } = params;
  const receiveExact = params.recvAmount != null;

  // 1. Get UTXOs and filter to send-asset only.
  const allUtxos = await engineCall<UtxoDTO[]>({
    kind: "getUtxos",
    descriptor,
    network,
  });

  const swapUtxos = filterSendAssetUtxos(allUtxos, sendAssetId);
  if (swapUtxos.length === 0) {
    throw new SwapError(`no UTXOs found for send asset ${sendAssetId}`);
  }

  // 2. Get receive and change addresses.
  const receiveResult = await engineCall<{ address: string; index: number }>({
    kind: "getAddress",
    descriptor,
    network,
  });
  const changeResult = await engineCall<{ address: string }>({
    kind: "getAddress",
    descriptor,
    network,
    index: receiveResult.index + 1,
  });

  // 3. Start quotes — same pair orientation as executeInstantSwap.
  const { asset_pair, trade_dir, asset_type } = orientPair(
    sendAssetId, recvAssetId, network, receiveExact,
  );
  const startResult = await client.startQuotes({
    asset_pair,
    asset_type,
    amount: receiveExact ? params.recvAmount! : params.sendAmount!,
    trade_dir,
    utxos: swapUtxos,
    receive_address: receiveResult.address,
    change_address: changeResult.address,
  });

  // 4. Wait for the first quote.
  const success = await waitForQuote(client, startResult.quote_sub_id);

  // Map base_amount/quote_amount to send/recv based on which asset the
  // user is sending: base (LBTC) or quote (e.g. USDt).
  const sendIsBase = sendAssetId === policyAssetId(network);
  const dealerFee = BigInt(Math.round(success.fixed_fee)) + BigInt(Math.round(success.server_fee));
  // `base_amount` EXCLUDES the dealer's L-BTC-denominated fee. Measured on a real
  // $1 receive-exact quote: 1556 + 83 = 1639, matching SideSwap's own 1638-sat ask.
  // So the fee-exclusive figure is NOT what the wallet pays.
  //
  // Returning it fee-inclusive fixes three things: "You pay" stops understating
  // the charge; `reviewedSendAmount` (and the receive-exact `maxSendAmount` cap)
  // is measured on the same basis as the outflow the gate checks, so an 83-sat fee
  // no longer eats the entire 5% headroom and rejects a swap that never drifted;
  // and the cost percentage stops dividing by a fee-exclusive base.
  //
  // Only when SENDING L-BTC — adding an L-BTC fee to a USDt `sendAmount` would mix
  // assets. On a USDt send the dealer covers it and it surfaces as a reduced
  // receive, bounded by `minRecvAmount`.
  const sendAmount =
    BigInt(Math.round(sendIsBase ? success.base_amount : success.quote_amount)) +
    (sendIsBase ? dealerFee : 0n);
  return {
    sendAmount,
    recvAmount: BigInt(Math.round(sendIsBase ? success.quote_amount : success.base_amount)),
    // Absolute expiry, so the UI doesn't have to track when the quote arrived.
    // The dealer's ttl is in ms and is what bounds `taker_sign` acceptance.
    expiresAt: Date.now() + success.ttl,
    fixedFee: BigInt(Math.round(success.fixed_fee)),
    serverFee: BigInt(Math.round(success.server_fee)),
  };
}

// ---- helpers -------------------------------------------------------------

/** Await the first `Success` quote for a given `quote_sub_id`. Rejects on
 *  `Error` or `LowBalance` status, or after a 20 s timeout. Returns the
 *  Success payload directly so callers don't need to narrow the union. */
function waitForQuote(
  client: SideSwapClient,
  quoteSubId: number,
): Promise<SideSwapQuoteSuccess> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new SwapError("timed out waiting for dealer quote")),
      20_000,
    );

    client.onQuote((q) => {
      if (q.quote_sub_id !== quoteSubId) return;
      clearTimeout(timer);

      if ("Success" in q.status) {
        resolve(q.status.Success);
      } else if ("Error" in q.status) {
        reject(new SwapError(`dealer error: ${q.status.Error.error_msg}`));
      } else {
        // LowBalance — the dealer can't fill this size. Keep its `available`
        // figure so the UI can say how much IS fillable rather than a bare
        // "not enough balance", which leaves the user guessing whether to retry
        // smaller. Float → BigInt via round: wire amounts are JS numbers.
        const low = q.status.LowBalance;
        reject(
          new SwapLowBalanceError(
            "dealer returned LowBalance",
            BigInt(Math.round(low.available)),
          ),
        );
      }
    });
  });
}
