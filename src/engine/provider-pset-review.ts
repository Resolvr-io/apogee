import type { ProviderPsetAnalysisDTO } from "./protocol";

/** Compare the transaction effects the user approved. Wallet status is a
 * freshness snapshot, not part of the approval: an unrelated new block may
 * advance it while the PSET itself and every reviewed effect remain unchanged. */
export function providerPsetReviewsMatch(
  approved: ProviderPsetAnalysisDTO,
  current: ProviderPsetAnalysisDTO,
): boolean {
  const { walletStatus: _approvedStatus, ...approvedEffects } = approved;
  const { walletStatus: _currentStatus, ...currentEffects } = current;
  return JSON.stringify(approvedEffects) === JSON.stringify(currentEffects);
}
