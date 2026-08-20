export const SIMPLICITY_ROULETTE_V1_OPEN = "roulette_vault.Open" as const;
export const SIMPLICITY_ROULETTE_V1_TAKE = "roulette_vault.Take" as const;
export const SIMPLICITY_ROULETTE_V1_SETTLE = "roulette_vault.Settle" as const;
export const SIMPLICITY_ROULETTE_V1_CANCEL = "roulette_vault.Cancel" as const;
export const SIMPLICITY_ROULETTE_V1_FORFEIT = "roulette_vault.Forfeit" as const;
export const SIMPLICITY_ROULETTE_V1_CLAIM_PAYOUT = "roulette_vault.ClaimPayout" as const;

export const SIMPLICITY_ROULETTE_V1_ACTIONS = [
  SIMPLICITY_ROULETTE_V1_OPEN,
  SIMPLICITY_ROULETTE_V1_TAKE,
  SIMPLICITY_ROULETTE_V1_SETTLE,
  SIMPLICITY_ROULETTE_V1_CANCEL,
  SIMPLICITY_ROULETTE_V1_FORFEIT,
  SIMPLICITY_ROULETTE_V1_CLAIM_PAYOUT,
] as const;

export type SimplicityRouletteV1Action = typeof SIMPLICITY_ROULETTE_V1_ACTIONS[number];

export function isSimplicityRouletteV1Action(action: string): action is SimplicityRouletteV1Action {
  return (SIMPLICITY_ROULETTE_V1_ACTIONS as readonly string[]).includes(action);
}
