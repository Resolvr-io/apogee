import type { PreparedRouletteExecution } from "./prepare-roulette";
import type { TxManifestOutpoint } from "./requirements";
import {
  selectManifestWalletInputs,
  type AcceptOfferWalletCandidate,
  type HostedTxManifestFeeSelection,
} from "./wallet-host";

export type HostedPreparedRouletteExecution = PreparedRouletteExecution & {
  parentTransactions: string[];
} & HostedTxManifestFeeSelection;

/**
 * Select wallet coins only after proving that every selected outpoint remains
 * unspent at the same Esplora root used to resolve the roulette state. LWK can
 * briefly retain a spent manifest-created change output after an incremental
 * scan; retrying selection without those stale entries keeps review and signing
 * on current chain state.
 */
export async function selectUnspentRouletteWalletInputs(
  candidates: readonly AcceptOfferWalletCandidate[],
  esploraUrl: string,
  assetId: string,
  minimumAmount: string,
  excluded: readonly TxManifestOutpoint[] = [],
  label = "wallet inputs",
  minimumChange = "0",
  fetcher: typeof fetch = fetch,
): Promise<AcceptOfferWalletCandidate[]> {
  let available = [...candidates];
  const root = esploraUrl.replace(/\/+$/, "");
  for (;;) {
    const selected = selectManifestWalletInputs(
      available,
      assetId,
      minimumAmount,
      excluded,
      label,
      minimumChange,
    );
    const spent = new Set<string>();
    await Promise.all(selected.map(async (candidate) => {
      const response = await fetcher(
        `${root}/tx/${candidate.txid}/outspend/${candidate.vout}`,
        { method: "GET", cache: "no-store", signal: AbortSignal.timeout(15_000) },
      );
      if (!response.ok) {
        throw new Error(`Could not verify roulette wallet input ${candidate.txid}:${candidate.vout} (${response.status}).`);
      }
      const payload = await response.json() as { spent?: unknown };
      if (typeof payload.spent !== "boolean") {
        throw new Error(`Chain server returned invalid outspend data for ${candidate.txid}:${candidate.vout}.`);
      }
      if (payload.spent) spent.add(outpointKey(candidate));
    }));
    if (spent.size === 0) return selected;
    available = available.filter((candidate) => !spent.has(outpointKey(candidate)));
  }
}

function outpointKey(outpoint: TxManifestOutpoint): string {
  return `${outpoint.txid}:${outpoint.vout}`;
}
