import {
  SIMPLICITY_ROULETTE_V1_CANCEL,
  SIMPLICITY_ROULETTE_V1_CLAIM_PAYOUT,
  SIMPLICITY_ROULETTE_V1_FORFEIT,
  SIMPLICITY_ROULETTE_V1_OPEN,
  SIMPLICITY_ROULETTE_V1_SETTLE,
  SIMPLICITY_ROULETTE_V1_TAKE,
  isSimplicityRouletteV1Action,
  type SimplicityRouletteV1Action,
} from "./builtins/simplicity-roulette-v1/actions";
import { taggedCanonicalJsonHash } from "./bundle";
import type { TxManifestInvocation, TxManifestOutpoint } from "./requirements";
import type { TxManifestBundleHash } from "./registry";

type RequirementBase = {
  planVersion: "apogee-tx-manifest-requirements/v1";
  requestId: string;
  chainId: string;
  accountIdentifier: string;
  bundleHash: TxManifestBundleHash;
  constraints: { maxFee?: string; validUntilHeight?: number };
};

export type RouletteTerms = {
  roundId: string;
  assetId: string;
  /** Null only for Open, where Apogee selects a fresh wallet destination. */
  playerPayoutScript: string | null;
  secretCommitment: string;
  betKind: number;
  betSelection: number;
  stake: string;
  bond: string;
  openExpiry: number;
  minRevealAge: number;
  revealExpiry: number;
};

type RoulettePlanBase = RequirementBase & {
  action: SimplicityRouletteV1Action;
  intent: {
    protocolLabel: "Simplicity Roulette";
    actionLabel: string;
    roundId: string;
    assetId?: string;
    stake?: string;
    bond?: string;
    betKind?: number;
    betSelection?: number;
    houseCollateral?: string;
  };
  requirementDigest: `sha256:${string}`;
};

export type RouletteOpenRequirementPlan = RoulettePlanBase & {
  action: typeof SIMPLICITY_ROULETTE_V1_OPEN;
  terms: RouletteTerms;
  walletInputs: readonly [{ id: "round_funding_in"; assetId: string; minAmount: string }, { id: "fee_input"; assetId: "lbtc" }];
};

export type RouletteTakeRequirementPlan = RoulettePlanBase & {
  action: typeof SIMPLICITY_ROULETTE_V1_TAKE;
  terms: RouletteTerms;
  houseNonce: string;
  houseCollateral: string;
  covenantInputs: readonly [{ id: "open_in"; requiredIndex: 0; outpoint: TxManifestOutpoint; assetId: string; amount: string; sourceType: "roulette_open" }];
  walletInputs: readonly [{ id: "house_collateral_in"; requiredIndex: 1; assetId: string; minAmount: string }, { id: "fee_input"; assetId: "lbtc" }];
};

export type RouletteSettleRequirementPlan = RoulettePlanBase & {
  action: typeof SIMPLICITY_ROULETTE_V1_SETTLE;
  terms: RouletteTerms;
  housePayoutScript: string;
  houseNonce: string;
  houseCollateral: string;
  playerSecret: string;
  covenantInputs: readonly [{ id: "active_in"; requiredIndex: 0; outpoint: TxManifestOutpoint; assetId: string; amount: string; sourceType: "roulette_active" }];
  walletInputs: readonly [{ id: "fee_input"; assetId: "lbtc" }];
};

export type RouletteCancelRequirementPlan = RoulettePlanBase & {
  action: typeof SIMPLICITY_ROULETTE_V1_CANCEL;
  terms: RouletteTerms;
  covenantInputs: readonly [{ id: "open_in"; requiredIndex: 0; outpoint: TxManifestOutpoint; assetId: string; amount: string; sourceType: "roulette_open" }];
  walletInputs: readonly [{ id: "fee_input"; assetId: "lbtc" }];
};

export type RouletteForfeitRequirementPlan = RoulettePlanBase & {
  action: typeof SIMPLICITY_ROULETTE_V1_FORFEIT;
  terms: RouletteTerms;
  housePayoutScript: string;
  houseNonce: string;
  houseCollateral: string;
  covenantInputs: readonly [{ id: "active_in"; requiredIndex: 0; outpoint: TxManifestOutpoint; assetId: string; amount: string; sourceType: "roulette_active" }];
  walletInputs: readonly [{ id: "fee_input"; assetId: "lbtc" }];
};

export type RouletteClaimPayoutRequirementPlan = RoulettePlanBase & {
  action: typeof SIMPLICITY_ROULETTE_V1_CLAIM_PAYOUT;
  payoutOutpoint: TxManifestOutpoint;
  walletInputs: readonly [{ id: "payout_in"; requiredIndex: 0; outpoint: TxManifestOutpoint }, { id: "fee_input"; assetId: "lbtc" }];
};

export type RouletteRequirementPlan =
  | RouletteOpenRequirementPlan
  | RouletteTakeRequirementPlan
  | RouletteSettleRequirementPlan
  | RouletteCancelRequirementPlan
  | RouletteForfeitRequirementPlan
  | RouletteClaimPayoutRequirementPlan;

export { isSimplicityRouletteV1Action as isRouletteAction };

/** Resolve only dapp intent. Covenant, chain, and wallet ownership are re-derived later. */
export async function resolveRouletteRequirements(
  invocation: TxManifestInvocation,
  common: RequirementBase,
): Promise<RouletteRequirementPlan> {
  if (!isSimplicityRouletteV1Action(invocation.action)) throw new Error("Unsupported roulette action.");
  if (invocation.action === SIMPLICITY_ROULETTE_V1_CLAIM_PAYOUT) {
    const args = exactArguments(invocation.arguments, ["ROUND_ID"], "ClaimPayout");
    exactProvidedInputs(invocation.providedInputs, ["payout_in"], "ClaimPayout");
    const roundId = hex32(args.ROUND_ID, "ROUND_ID");
    const payoutOutpoint = providedOutpoint(invocation.providedInputs, "payout_in");
    return digest({
      ...common,
      action: SIMPLICITY_ROULETTE_V1_CLAIM_PAYOUT,
      payoutOutpoint,
      intent: { protocolLabel: "Simplicity Roulette", actionLabel: "Secure roulette payout", roundId },
      walletInputs: [
        { id: "payout_in", requiredIndex: 0, outpoint: payoutOutpoint },
        { id: "fee_input", assetId: "lbtc" },
      ] as const,
    });
  }

  const active = invocation.action === SIMPLICITY_ROULETTE_V1_TAKE ||
    invocation.action === SIMPLICITY_ROULETTE_V1_SETTLE ||
    invocation.action === SIMPLICITY_ROULETTE_V1_FORFEIT;
  const settle = invocation.action === SIMPLICITY_ROULETTE_V1_SETTLE;
  const fields = [
    "ROUND_ID", "ASSET_ID", "SECRET_COMMITMENT",
    "BET_KIND", "BET_SELECTION", "STAKE", "BOND", "OPEN_EXPIRY",
    "MIN_REVEAL_AGE", "REVEAL_EXPIRY",
    ...(invocation.action === SIMPLICITY_ROULETTE_V1_OPEN ? [] : ["PLAYER_PAYOUT_SCRIPT"]),
    ...(active ? ["HOUSE_NONCE", "HOUSE_COLLATERAL"] : []),
    ...(invocation.action === SIMPLICITY_ROULETTE_V1_SETTLE || invocation.action === SIMPLICITY_ROULETTE_V1_FORFEIT
      ? ["HOUSE_PAYOUT_SCRIPT"]
      : []),
    ...(settle ? ["PLAYER_SECRET"] : []),
  ];
  const args = exactArguments(invocation.arguments, fields, invocation.action.split(".").at(-1)!);
  const terms = parseTerms(args);
  const amount = checkedAdd(terms.stake, terms.bond, "OPEN amount");
  const actionLabel = {
    [SIMPLICITY_ROULETTE_V1_OPEN]: "Open roulette bet",
    [SIMPLICITY_ROULETTE_V1_TAKE]: "Take roulette bet",
    [SIMPLICITY_ROULETTE_V1_SETTLE]: "Settle roulette spin",
    [SIMPLICITY_ROULETTE_V1_CANCEL]: "Cancel untaken bet",
    [SIMPLICITY_ROULETTE_V1_FORFEIT]: "Forfeit unrevealed bet",
  }[invocation.action];
  const intent = {
    protocolLabel: "Simplicity Roulette" as const,
    actionLabel,
    roundId: terms.roundId,
    assetId: terms.assetId,
    stake: terms.stake,
    bond: terms.bond,
    betKind: terms.betKind,
    betSelection: terms.betSelection,
  };

  if (invocation.action === SIMPLICITY_ROULETTE_V1_OPEN) {
    exactProvidedInputs(invocation.providedInputs, [], "Open");
    return digest({
      ...common, action: SIMPLICITY_ROULETTE_V1_OPEN, terms, intent,
      walletInputs: [
        { id: "round_funding_in", assetId: terms.assetId, minAmount: amount },
        { id: "fee_input", assetId: "lbtc" },
      ] as const,
    });
  }
  if (invocation.action === SIMPLICITY_ROULETTE_V1_CANCEL) {
    exactProvidedInputs(invocation.providedInputs, ["open_in"], "Cancel");
    const open = providedOutpoint(invocation.providedInputs, "open_in");
    return digest({
      ...common, action: SIMPLICITY_ROULETTE_V1_CANCEL, terms, intent,
      covenantInputs: [{ id: "open_in", requiredIndex: 0, outpoint: open, assetId: terms.assetId, amount, sourceType: "roulette_open" }] as const,
      walletInputs: [{ id: "fee_input", assetId: "lbtc" }] as const,
    });
  }

  const houseNonce = hex32(args.HOUSE_NONCE, "HOUSE_NONCE");
  if (/^0+$/.test(houseNonce)) throw new Error("HOUSE_NONCE must not be zero.");
  const houseCollateral = decimalU64(args.HOUSE_COLLATERAL, "HOUSE_COLLATERAL");
  const requiredCollateral = checkedMultiply(terms.stake, payoutOdds(terms.betKind), "required collateral");
  if (BigInt(houseCollateral) < BigInt(requiredCollateral)) {
    throw new Error(`HOUSE_COLLATERAL must be at least ${requiredCollateral}.`);
  }
  const activeAmount = checkedAdd(amount, houseCollateral, "ACTIVE amount");
  const activeIntent = { ...intent, houseCollateral };
  if (invocation.action === SIMPLICITY_ROULETTE_V1_TAKE) {
    exactProvidedInputs(invocation.providedInputs, ["open_in"], "Take");
    const open = providedOutpoint(invocation.providedInputs, "open_in");
    return digest({
      ...common, action: SIMPLICITY_ROULETTE_V1_TAKE, terms, houseNonce, houseCollateral, intent: activeIntent,
      covenantInputs: [{ id: "open_in", requiredIndex: 0, outpoint: open, assetId: terms.assetId, amount, sourceType: "roulette_open" }] as const,
      walletInputs: [
        { id: "house_collateral_in", requiredIndex: 1, assetId: terms.assetId, minAmount: houseCollateral },
        { id: "fee_input", assetId: "lbtc" },
      ] as const,
    });
  }
  const activeIn = providedOutpoint(invocation.providedInputs, "active_in");
  const housePayoutScript = p2wpkh(args.HOUSE_PAYOUT_SCRIPT, "HOUSE_PAYOUT_SCRIPT");
  const covenantInputs = [{ id: "active_in", requiredIndex: 0, outpoint: activeIn, assetId: terms.assetId, amount: activeAmount, sourceType: "roulette_active" }] as const;
  const walletInputs = [{ id: "fee_input", assetId: "lbtc" }] as const;
  if (invocation.action === SIMPLICITY_ROULETTE_V1_SETTLE) {
    exactProvidedInputs(invocation.providedInputs, ["active_in"], "Settle");
    return digest({
      ...common, action: SIMPLICITY_ROULETTE_V1_SETTLE, terms, housePayoutScript, houseNonce, houseCollateral,
      playerSecret: hex32(args.PLAYER_SECRET, "PLAYER_SECRET"), intent: activeIntent, covenantInputs, walletInputs,
    });
  }
  exactProvidedInputs(invocation.providedInputs, ["active_in"], "Forfeit");
  return digest({
    ...common, action: SIMPLICITY_ROULETTE_V1_FORFEIT, terms, housePayoutScript, houseNonce, houseCollateral,
    intent: activeIntent, covenantInputs, walletInputs,
  });
}

function parseTerms(args: Record<string, unknown>): RouletteTerms {
  const betKind = u32(args.BET_KIND, "BET_KIND", 8);
  const selection = u32(args.BET_SELECTION, "BET_SELECTION", 36);
  if (betKind === 0 ? selection > 36 : betKind >= 7 ? selection < 1 || selection > 3 : selection !== 0) {
    throw new Error("BET_SELECTION is invalid for BET_KIND.");
  }
  const minRevealAge = u32(args.MIN_REVEAL_AGE, "MIN_REVEAL_AGE", 0xffff);
  const revealExpiry = u32(args.REVEAL_EXPIRY, "REVEAL_EXPIRY", 0xffff);
  if (minRevealAge < 1 || revealExpiry <= minRevealAge) {
    throw new Error("Reveal delays must satisfy 1 <= MIN_REVEAL_AGE < REVEAL_EXPIRY.");
  }
  return {
    roundId: hex32(args.ROUND_ID, "ROUND_ID"),
    assetId: hex32(args.ASSET_ID, "ASSET_ID"),
    playerPayoutScript: args.PLAYER_PAYOUT_SCRIPT === undefined
      ? null
      : p2wpkh(args.PLAYER_PAYOUT_SCRIPT, "PLAYER_PAYOUT_SCRIPT"),
    secretCommitment: hex32(args.SECRET_COMMITMENT, "SECRET_COMMITMENT"),
    betKind,
    betSelection: selection,
    stake: positiveU64(args.STAKE, "STAKE"),
    bond: decimalU64(args.BOND, "BOND"),
    openExpiry: u32(args.OPEN_EXPIRY, "OPEN_EXPIRY", 0xffff, 1),
    minRevealAge,
    revealExpiry,
  };
}

function exactArguments(value: Record<string, unknown>, fields: readonly string[], action: string): Record<string, unknown> {
  const expected = new Set(fields);
  for (const key of Object.keys(value)) if (!expected.has(key)) throw new Error(`Unknown ${action} argument ${key}.`);
  for (const key of fields) if (!Object.hasOwn(value, key)) throw new Error(`${action} requires argument ${key}.`);
  return value;
}

function exactProvidedInputs(value: TxManifestInvocation["providedInputs"], fields: readonly string[], action: string): void {
  const input = value ?? {};
  const expected = new Set(fields);
  for (const key of Object.keys(input)) if (!expected.has(key)) throw new Error(`Unknown ${action} provided input ${key}.`);
  for (const key of fields) if (!Object.hasOwn(input, key)) throw new Error(`${action} requires provided input ${key}.`);
}

function providedOutpoint(value: TxManifestInvocation["providedInputs"], key: string): TxManifestOutpoint {
  const candidate = value?.[key];
  if (!candidate || Array.isArray(candidate)) throw new Error(`${key} must be one outpoint.`);
  if (!/^[0-9a-f]{64}$/.test(candidate.txid) || !Number.isSafeInteger(candidate.vout) || candidate.vout < 0 || candidate.vout > 0xffff_ffff) {
    throw new Error(`${key} is not a valid outpoint.`);
  }
  return { txid: candidate.txid, vout: candidate.vout };
}

function hex32(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be 32-byte lowercase hex.`);
  return value;
}

function p2wpkh(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0014[0-9a-f]{40}$/.test(value)) throw new Error(`${label} must be a canonical P2WPKH script.`);
  return value;
}

function decimalU64(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`${label} must be a canonical u64 decimal string.`);
  }
  return value;
}

function positiveU64(value: unknown, label: string): string {
  const result = decimalU64(value, label);
  if (result === "0") throw new Error(`${label} must be positive.`);
  return result;
}

function u32(value: unknown, label: string, max: number, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${label} is out of range.`);
  return value as number;
}

function payoutOdds(kind: number): string {
  return kind === 0 ? "35" : kind >= 7 ? "2" : "1";
}

function checkedAdd(left: string, right: string, label: string): string {
  const result = BigInt(left) + BigInt(right);
  if (result > 0xffff_ffff_ffff_ffffn) throw new Error(`${label} overflows u64.`);
  return result.toString();
}

function checkedMultiply(left: string, right: string, label: string): string {
  const result = BigInt(left) * BigInt(right);
  if (result > 0xffff_ffff_ffff_ffffn) throw new Error(`${label} overflows u64.`);
  return result.toString();
}

async function digest<T extends object>(plan: T): Promise<T & { requirementDigest: `sha256:${string}` }> {
  return { ...plan, requirementDigest: await taggedCanonicalJsonHash("apogee/tx-manifest-requirements/v1", plan) };
}
