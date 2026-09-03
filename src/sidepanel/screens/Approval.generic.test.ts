import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@/engine/protocol";

vi.mock("@/lib/ext", () => ({
  browser: { runtime: { sendMessage: vi.fn() } },
}));

vi.mock("@/sidepanel/wallet-client", () => ({
  errMessage: (error: unknown) => String(error),
  unlockErrMessage: (error: unknown) => String(error),
  wallet: { getAutoLock: vi.fn(() => Promise.resolve(15)) },
}));

import { ApprovalOverlay } from "./Approval";

const FEE_ASSET = "11".repeat(32);
const STATE_ASSET = "22".repeat(32);
const PAYOUT_ASSET = "33".repeat(32);
const STATE_TXID = "44".repeat(32);
const WALLET_TXID = "55".repeat(32);
const STATE_SCRIPT = `5120${"66".repeat(32)}`;
const WALLET_SCRIPT = `0014${"77".repeat(20)}`;
const PAYOUT_SCRIPT = `0014${"88".repeat(20)}`;

function request(): Extract<ApprovalRequest, { kind: "executeTxManifest" }> {
  return {
    kind: "executeTxManifest",
    id: "generic-approval-test",
    origin: "https://unverified.example.test",
    network: "testnet",
    locked: false,
    signerKind: "local",
    signingMode: "wallet",
    review: {
      kind: "generic",
      reviewVersion: "apogee-generic-transaction-review/v1",
      unverified: true,
      protocolLabel: "Publisher protocol claim",
      actionLabel: "Publisher action claim",
      publisherDescription: "Publisher says this transaction wins a prize.",
      requestId: "generic-request-1",
      accountIdentifier: `bip122:${"99".repeat(16)}:wallet`,
      bundleHash: `sha256:${"aa".repeat(32)}`,
      action: "unknown_contract.UnknownAction",
      feeAssetId: FEE_ASSET,
      fee: "10",
      feeChange: "0",
      inputs: [
        {
          index: 0,
          roleId: "state",
          source: "provided",
          authorization: "covenant",
          walletOwned: false,
          txid: STATE_TXID,
          vout: 4,
          assetId: STATE_ASSET,
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
          walletOwned: true,
          txid: WALLET_TXID,
          vout: 7,
          assetId: FEE_ASSET,
          amount: "40",
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
          assetId: PAYOUT_ASSET,
          amount: "100",
          scriptPubKey: PAYOUT_SCRIPT,
          confidential: false,
          walletOwned: false,
        },
        {
          index: 1,
          role: "fee",
          assetId: FEE_ASSET,
          amount: "10",
          scriptPubKey: "",
          confidential: false,
          walletOwned: false,
        },
        {
          index: 2,
          role: "change",
          assetId: FEE_ASSET,
          amount: "30",
          scriptPubKey: WALLET_SCRIPT,
          confidential: true,
          walletOwned: true,
        },
      ],
      feeOutputIndex: 1,
      locktime: 500,
      rbf: true,
      signingMode: "wallet",
      walletBalanceChanges: { [FEE_ASSET]: "-10" },
    },
  };
}

describe("generic declarative ApprovalOverlay", () => {
  it("puts the unverified warning first and renders every exact transaction fact", () => {
    const markup = renderToStaticMarkup(
      createElement(ApprovalOverlay, { request: request(), onClose: vi.fn() }),
    );
    const text = markup.replace(/<[^>]+>/g, "");

    expect(markup).toContain('data-testid="generic-manifest-warning"');
    expect(markup).toContain('role="alert"');
    expect(text).toContain("Unverified contract action");
    expect(text).toContain("does not recognize this contract");
    expect(text.indexOf("Unverified contract action")).toBeLessThan(
      text.indexOf("Publisher protocol claim"),
    );

    expect(text).toContain("unknown_contract.UnknownAction");
    expect(text).toContain("Fee output index");
    expect(text).toContain("Locktime500");
    expect(text).toContain("Replace-by-feeyes");
    expect(text).toContain("Signing modewallet · signatures required");

    for (const value of [
      `${STATE_TXID}:4`,
      `${WALLET_TXID}:7`,
      STATE_ASSET,
      PAYOUT_ASSET,
      FEE_ASSET,
      STATE_SCRIPT,
      WALLET_SCRIPT,
      PAYOUT_SCRIPT,
      "110 base units",
      "40 base units",
      "100 base units",
      "10 base units",
      "30 base units",
      "2 · 0x00000002",
      "4294967293 · 0xfffffffd",
      "yes · blinded",
      "no · explicit",
      "this wallet",
      "not this wallet",
      "(empty · Elements fee output)",
    ]) {
      expect(text).toContain(value);
    }

    const output0 = text.indexOf("Output 0");
    const output1 = text.indexOf("Output 1");
    const output2 = text.indexOf("Output 2");
    expect(output0).toBeGreaterThan(-1);
    expect(output0).toBeLessThan(output1);
    expect(output1).toBeLessThan(output2);
    expect(text).toContain("Publisher-provided details · unverified");
    expect(text).toContain("Publisher says this transaction wins a prize.");
  });
});
