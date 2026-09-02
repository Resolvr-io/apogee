import { describe, expect, it } from "vitest";
import type { DeclarativeRequirementPlan } from "./declarative-plan";
import type { PreparedDeclarativeExecution } from "./declarative-prepare";
import { buildDeclarativeApprovalReview } from "./declarative-review";

const ASSET = "11".repeat(32);
const STATE_TXID = "22".repeat(32);
const WALLET_TXID = "33".repeat(32);
const STATE_SCRIPT = `5120${"44".repeat(32)}`;
const WALLET_SCRIPT = `0014${"55".repeat(20)}`;
const PAYOUT_SCRIPT = `0014${"66".repeat(20)}`;

function plan(): DeclarativeRequirementPlan {
  return {
    requestId: "generic-review-1",
    accountIdentifier: `bip122:${"77".repeat(16)}:wallet`,
    bundleHash: `sha256:${"88".repeat(32)}`,
    action: "example_contract.Advance",
    publisher: {
      protocol: "Publisher's protocol claim",
      action: "example_contract.Advance",
      description: "Publisher prose must not replace exact transaction facts.",
    },
    recipe: {
      inputs: [
        {
          kind: "provided",
          id: "state",
          provided_input: "state_in",
          authorization: "covenant",
          expect: {
            asset: { op: "bytes", value: ASSET },
            amount: { op: "uint", value: "110" },
          },
        },
        {
          kind: "wallet",
          id: "funding",
          asset: { op: "bytes", value: ASSET },
          amount: { op: "uint", value: "20" },
          amount_mode: "exact",
        },
      ],
    },
  } as unknown as DeclarativeRequirementPlan;
}

function prepared(): PreparedDeclarativeExecution {
  return {
    pset: "pset",
    planDigest: `sha256:${"99".repeat(32)}`,
    feeSelectionTarget: "10",
    parentTransactions: [],
    covenants: [],
    review: {
      feeAssetId: ASSET,
      fee: "10",
      feeChange: "0",
      feeOutputIndex: 1,
      inputs: [
        {
          index: 0,
          roleId: "state",
          source: "provided",
          authorization: "covenant",
          txid: STATE_TXID,
          vout: 0,
          assetId: ASSET,
          amount: "110",
          scriptPubKey: STATE_SCRIPT,
          confidential: false,
          sequence: 2,
          confirmed: true,
        },
        {
          index: 1,
          roleId: "funding",
          source: "wallet",
          authorization: "wallet",
          txid: WALLET_TXID,
          vout: 3,
          assetId: ASSET,
          amount: "20",
          scriptPubKey: WALLET_SCRIPT,
          confidential: true,
          sequence: 0xffff_fffd,
          confirmed: false,
        },
      ],
      outputs: [
        {
          index: 0,
          role: "script",
          assetId: ASSET,
          amount: "100",
          scriptPubKey: PAYOUT_SCRIPT,
          confidential: false,
          walletOwned: false,
        },
        {
          index: 2,
          role: "change",
          assetId: ASSET,
          amount: "20",
          scriptPubKey: WALLET_SCRIPT,
          confidential: true,
          walletOwned: true,
        },
      ],
      locktime: 500,
      rbf: true,
      signingMode: "wallet",
      walletBalanceChanges: { [ASSET]: "0" },
    },
  };
}

describe("buildDeclarativeApprovalReview", () => {
  it("maps every authoritative transaction fact and inserts the exact fee output", () => {
    const review = buildDeclarativeApprovalReview(plan(), prepared(), {
      [ASSET]: { label: "Display only", ticker: "DSP", precision: 8, source: "registry" },
    });

    expect(review).toMatchObject({
      kind: "generic",
      reviewVersion: "apogee-generic-transaction-review/v1",
      unverified: true,
      action: "example_contract.Advance",
      publisherDescription: "Publisher prose must not replace exact transaction facts.",
      feeAssetId: ASSET,
      fee: "10",
      feeOutputIndex: 1,
      locktime: 500,
      rbf: true,
      signingMode: "wallet",
    });
    expect(review.inputs).toEqual([
      expect.objectContaining({
        index: 0,
        roleId: "state",
        assetId: ASSET,
        amount: "110",
        scriptPubKey: STATE_SCRIPT,
        confidential: false,
        walletOwned: false,
        sequence: 2,
      }),
      expect.objectContaining({
        index: 1,
        roleId: "funding",
        assetId: ASSET,
        amount: "20",
        scriptPubKey: WALLET_SCRIPT,
        confidential: true,
        walletOwned: true,
        sequence: 0xffff_fffd,
      }),
    ]);
    expect(review.outputs).toEqual([
      expect.objectContaining({ index: 0, role: "script", scriptPubKey: PAYOUT_SCRIPT }),
      {
        index: 1,
        role: "fee",
        assetId: ASSET,
        amount: "10",
        scriptPubKey: "",
        confidential: false,
        walletOwned: false,
      },
      expect.objectContaining({
        index: 2,
        role: "change",
        scriptPubKey: WALLET_SCRIPT,
        confidential: true,
        walletOwned: true,
      }),
    ]);
  });

  it("fails closed when non-fee output indices occupy the declared fee slot", () => {
    const candidate = prepared();
    candidate.review.outputs[0] = { ...candidate.review.outputs[0], index: 1 };
    expect(() => buildDeclarativeApprovalReview(plan(), candidate, {})).toThrow(
      "duplicate or occupied index",
    );
  });

  it("fails closed when RBF or signing summaries disagree with exact inputs", () => {
    const badRbf = prepared();
    badRbf.review.rbf = false;
    expect(() => buildDeclarativeApprovalReview(plan(), badRbf, {})).toThrow("RBF summary");

    const badSigningMode = prepared();
    badSigningMode.review.signingMode = "none";
    expect(() => buildDeclarativeApprovalReview(plan(), badSigningMode, {})).toThrow(
      "signing mode changed",
    );
  });
});
