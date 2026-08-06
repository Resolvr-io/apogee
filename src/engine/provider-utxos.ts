import type { ProviderUtxoDTO } from "@/engine/protocol";
import { extractElementsTxOut } from "./elements-txout";

interface StringValue {
  toString(): string;
}

interface PublicTx {
  txid(): StringValue;
  tx(): { toBytes(): Uint8Array };
}

interface PublicUtxo {
  outpoint(): { txid(): StringValue; vout(): number };
  unblinded(): {
    asset(): StringValue;
    value(): StringValue;
    isExplicit(): boolean;
  };
  address(): StringValue;
  scriptPubkey(): { bytes(): Uint8Array };
}

interface PublicUtxoWollet {
  transactions(): PublicTx[];
  utxos(): PublicUtxo[];
}

/**
 * Project an LWK Wollet into the deliberately narrow ELIP UTXO result.
 *
 * The structural input lists only methods this projection may touch. In
 * particular, the output does not carry the asset/value blinding-factor methods
 * available on LWK's unblinded secret object or the internal SideSwap DTO.
 */
export function collectProviderUtxos(
  wollet: PublicUtxoWollet,
  selectedAsset: string,
): ProviderUtxoDTO[] {
  const transactions = new Map(
    wollet.transactions().map((walletTx) => [
      walletTx.txid().toString(),
      walletTx.tx().toBytes(),
    ]),
  );

  return wollet.utxos().flatMap((utxo): ProviderUtxoDTO[] => {
    const unblinded = utxo.unblinded();
    const asset = unblinded.asset().toString();
    if (asset !== selectedAsset) return [];

    const outpoint = utxo.outpoint();
    const txid = outpoint.txid().toString();
    const transaction = transactions.get(txid);
    if (!transaction) throw new Error(`wallet transaction unavailable for UTXO ${txid}`);

    return [
      {
        txid,
        vout: outpoint.vout(),
        asset,
        amount: unblinded.value().toString(),
        address: utxo.address().toString(),
        scriptPubKey: bytesToHex(utxo.scriptPubkey().bytes()),
        txOut: bytesToHex(extractElementsTxOut(transaction, outpoint.vout())),
        confidential: !unblinded.isExplicit(),
      },
    ];
  });
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
