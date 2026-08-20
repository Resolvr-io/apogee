import { describe, expect, it } from "vitest";
import {
  SIMPLICITY_ROULETTE_V1_OPEN,
  SIMPLICITY_ROULETTE_V1_TAKE,
} from "./builtins/simplicity-roulette-v1/actions";
import { resolveRouletteRequirements } from "./roulette-requirements";
import type { TxManifestInvocation } from "./requirements";

const HASH = `sha256:${"11".repeat(32)}` as const;
const common = {
  planVersion: "apogee-tx-manifest-requirements/v1" as const,
  requestId: "roulette-round-1",
  chainId: "bip122:a771da8e52ee6ad581ed1e9a99825e5b",
  accountIdentifier: "bip122:a771da8e52ee6ad581ed1e9a99825e5b:wallet",
  bundleHash: HASH,
  constraints: {},
};

function arguments_(): Record<string, unknown> {
  return {
    ROUND_ID: "22".repeat(32),
    ASSET_ID: "33".repeat(32),
    SECRET_COMMITMENT: "44".repeat(32),
    BET_KIND: 0,
    BET_SELECTION: 17,
    STAKE: "100000",
    BOND: "25000",
    OPEN_EXPIRY: 144,
    MIN_REVEAL_AGE: 2,
    REVEAL_EXPIRY: 20,
  };
}

function invocation(action: string, args = arguments_()): TxManifestInvocation {
  return {
    protocolVersion: "0.1",
    requestId: common.requestId,
    chainId: common.chainId,
    accountIdentifier: common.accountIdentifier,
    manifest: { bundleHash: HASH },
    action,
    arguments: args,
  };
}

describe("roulette requirements", () => {
  it("keeps Open independent of an address the dapp cannot request", async () => {
    const plan = await resolveRouletteRequirements(invocation(SIMPLICITY_ROULETTE_V1_OPEN), common);
    expect(plan).toMatchObject({
      action: SIMPLICITY_ROULETTE_V1_OPEN,
      terms: { playerPayoutScript: null, stake: "100000", bond: "25000" },
    });
    expect(plan.walletInputs[0]).toMatchObject({ id: "round_funding_in", minAmount: "125000" });
  });

  it("lets Take auto-select its P2WPKH authorization input", async () => {
    const request = invocation(SIMPLICITY_ROULETTE_V1_TAKE, {
      ...arguments_(),
      PLAYER_PAYOUT_SCRIPT: `0014${"55".repeat(20)}`,
      HOUSE_NONCE: "66".repeat(32),
      HOUSE_COLLATERAL: "3500000",
    });
    request.providedInputs = { open_in: { txid: "77".repeat(32), vout: 0 } };
    const plan = await resolveRouletteRequirements(request, common);
    expect(plan.action).toBe(SIMPLICITY_ROULETTE_V1_TAKE);
    expect(plan.walletInputs[0]).toMatchObject({ id: "house_collateral_in", requiredIndex: 1, minAmount: "3500000" });
    expect("housePayoutScript" in plan).toBe(false);
  });

  it("rejects undercollateralized straight bets and extra inputs", async () => {
    const request = invocation(SIMPLICITY_ROULETTE_V1_TAKE, {
      ...arguments_(),
      PLAYER_PAYOUT_SCRIPT: `0014${"55".repeat(20)}`,
      HOUSE_NONCE: "66".repeat(32),
      HOUSE_COLLATERAL: "3499999",
    });
    request.providedInputs = { open_in: { txid: "77".repeat(32), vout: 0 } };
    await expect(resolveRouletteRequirements(request, common)).rejects.toThrow("at least 3500000");
  });
});
