import type { TxManifestOutpoint } from "./requirements";
import { deriveTxManifestIssuanceAsset } from "./runtime";

export type SimplicityLendingAssetKind = "factory" | "borrower-nft" | "lender-nft";

const NUMS_ISSUER_PUBLIC_KEY =
  "0250929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";
const ZERO_HASH = "00".repeat(32);

const ASSET_KINDS: Readonly<Record<SimplicityLendingAssetKind, {
  nameRole: string;
  tickerPrefix: string;
}>> = {
  factory: { nameRole: "", tickerPrefix: "SLF" },
  "borrower-nft": { nameRole: " borrower-nft", tickerPrefix: "SLB" },
  "lender-nft": { nameRole: " lender-nft", tickerPrefix: "SLL" },
};

/** Match simplicity-lending's ELIP-0100 contract exactly for the requesting origin. */
export async function simplicityLendingAssetContractHash(
  domain: string,
  outpoint: TxManifestOutpoint,
  kind: SimplicityLendingAssetKind,
): Promise<string> {
  const normalizedDomain = domain.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(normalizedDomain) || normalizedDomain.length === 0) {
    throw new Error("The requesting site's asset-contract domain is invalid.");
  }
  if (!normalizedDomain.includes(".")) return ZERO_HASH;
  const assetKind = ASSET_KINDS[kind];
  const contract = JSON.stringify({
    entity: { domain: normalizedDomain },
    issuer_pubkey: NUMS_ISSUER_PUBLIC_KEY,
    name: `simplicity-lending/v1${assetKind.nameRole} ${outpoint.txid}:${outpoint.vout}`,
    precision: 0,
    ticker: `${assetKind.tickerPrefix}${outpoint.txid.slice(0, 4)}`,
    version: 0,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(contract));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function deriveSimplicityLendingAsset(
  domain: string,
  outpoint: TxManifestOutpoint,
  kind: SimplicityLendingAssetKind,
): Promise<{ assetId: string; contractHash: string }> {
  const contractHash = await simplicityLendingAssetContractHash(domain, outpoint, kind);
  return {
    contractHash,
    assetId: await deriveTxManifestIssuanceAsset({
      txid: outpoint.txid,
      vout: outpoint.vout,
      contract_hash: contractHash,
    }),
  };
}
