// SideSwap instant-swap orchestration (Track 1, Phase 2).
//
// Chains the full dealer-quoted swap flow:
//
//   getUtxos (filter to send-asset) → startQuotes → wait for quote → getQuote
//   → signSwapPset (atomic verify + sign + finalize) → takerSign
//
// Honors the three wiring prerequisites from the integration plan:
//
//   1. **Atomic verify+sign.** The dealer PSET is verified and signed in a
//      single engine call (`signSwapPset`), so an unverified PSET can never
//      slip in between the two steps.
//   2. **Send-asset-only UTXOs.** `getUtxos` returns the full wallet with
//      blinding factors; we filter to the send-asset UTXOs the dealer needs
//      for coin selection so SideSwap can't unblind unrelated holdings.
//   3. **Independent maxFee.** The caller MUST supply a fee cap derived from
//      an independent estimate (feerate × vsize, or a fixed sane ceiling) —
//      never from the dealer's quote or PSET.

import type { SideSwapClient, SideSwapUtxo, SideSwapQuoteNotification } from "./client";
import type { EngineRequest, UtxoDTO, VerifyDealerPsetTermsDTO, SignSwapPsetWireResult } from "@/engine/protocol";
import type { LiquidNetwork } from "@/keystore/keystore";

// ---- public types --------------------------------------------------------

/** Independent fee cap + swap parameters. The caller is responsible for
 *  ensuring `maxFee` is NOT derived from dealer data. */
export interface SwapParams {
  sendAssetId: string;
  recvAssetId: string;
  sendAmount: number;
  /** Required cap on the send-asset (L-BTC) network fee, in base units.
   *  MUST be an independent estimate — see module docs. */
  maxFee: bigint;
  /** Minimum acceptable receive amount, in base units. Applied as slippage
   *  protection: the verification gate rejects any PSET that delivers less.
   *  If omitted, the accepted quote amount is used (no slippage tolerance). */
  minRecvAmount?: bigint;
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

// ---- result of the atomic signSwapPset engine call -----------------------
//
// The `signSwapPset` engine handler is being implemented on Angel's
// engine-core branch. The request shape:
//
//   { kind: "signSwapPset"; mnemonic; descriptor; network; pset; terms: VerifyDealerPsetTermsDTO }
//
// The result type is `SignSwapPsetWireResult` from protocol.ts.

// ---- UTXO filtering ------------------------------------------------------

/** Filter wallet UTXOs to the send-asset only and map to SideSwap wire format.
 *  Apogee wallets are P2WPKH — no redeem script, so `redeem_script` is null. */
function filterSendAssetUtxos(utxos: UtxoDTO[], sendAssetId: string): SideSwapUtxo[] {
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
  const { sendAssetId, recvAssetId, sendAmount, maxFee } = params;

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

  // 3. Start quotes with filtered UTXOs.
  const assetPair = { base: sendAssetId, quote: recvAssetId };
  const startResult = await client.startQuotes({
    asset_pair: assetPair,
    asset_type: "Base",
    amount: sendAmount,
    trade_dir: "Sell",
    utxos: swapUtxos,
    receive_address: receiveResult.address,
    change_address: changeResult.address,
  });

  // 4. Wait for the first viable quote notification.
  const quote = await waitForQuote(client, startResult.quote_sub_id);

  if (!("Success" in quote.status)) {
    const detail =
      "Error" in quote.status
        ? quote.status.Error.error_msg
        : "LowBalance";
    throw new SwapError(`dealer rejected: ${detail}`);
  }

  const success = quote.status.Success;

  // 5. Get the dealer-built unsigned PSET.
  const quoteResult = await client.getQuote(success.quote_id);

  // 6. Atomic verify + sign + finalize in one engine call (prerequisite 1).
  //    The maxFee cap is the caller's independent estimate (prerequisite 3).
  const minRecv = params.minRecvAmount ?? BigInt(success.quote_amount);
  const terms: VerifyDealerPsetTermsDTO = {
    sendAssetId,
    sendAmount: BigInt(sendAmount).toString(),
    recvAssetId,
    minRecvAmount: minRecv.toString(),
    maxFee: maxFee.toString(),
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

// ---- helpers -------------------------------------------------------------

/** Await the first `Success` quote for a given `quote_sub_id`. Rejects on
 *  `Error` status, or after the SideSwap request timeout (15 s). */
function waitForQuote(
  client: SideSwapClient,
  quoteSubId: number,
): Promise<SideSwapQuoteNotification> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new SwapError("timed out waiting for dealer quote")),
      20_000,
    );

    client.onQuote((q) => {
      if (q.quote_sub_id !== quoteSubId) return;
      clearTimeout(timer);

      if ("Success" in q.status) {
        resolve(q);
      } else if ("Error" in q.status) {
        reject(new SwapError(`dealer error: ${q.status.Error.error_msg}`));
      } else {
        // LowBalance — reject; the wallet doesn't have enough for this quote.
        reject(new SwapError("dealer returned LowBalance"));
      }
    });
  });
}
