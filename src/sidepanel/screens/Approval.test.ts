import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, ProviderPsetRecipientReviewDTO } from "@/engine/protocol";

vi.mock("@/lib/ext", () => ({
  browser: { runtime: { sendMessage: vi.fn() } },
}));

vi.mock("@/sidepanel/wallet-client", () => ({
  errMessage: (error: unknown) => String(error),
  unlockErrMessage: (error: unknown) => String(error),
  wallet: { getAutoLock: vi.fn(() => Promise.resolve(15)) },
}));

import { ApprovalOverlay } from "./Approval";

const POLICY_ASSET = "11".repeat(32);

describe("ApprovalOverlay", () => {
  it("keeps a long PSET review in a vertically scrollable side-panel overlay", () => {
    const recipients: ProviderPsetRecipientReviewDTO[] = Array.from(
      { length: 12 },
      (_, index) => ({
        address: `tlq1qrecipient${index}`,
        assetId: POLICY_ASSET,
        amount: String(1_000 + index),
        confidential: true,
      }),
    );
    const request: Extract<ApprovalRequest, { kind: "signPset" }> = {
      kind: "signPset",
      id: "approval-test",
      origin: "https://example.test",
      network: "testnet",
      locked: false,
      signerKind: "jade",
      broadcast: false,
      review: {
        accountIdentifier: `bip122:${"22".repeat(16)}:test-wallet`,
        uniqueId: "33".repeat(32),
        walletStatus: "1",
        inputCount: 1,
        outputCount: recipients.length + 1,
        policyAssetId: POLICY_ASSET,
        inputs: [
          {
            index: 0,
            txid: "44".repeat(32),
            vout: 0,
            address: "tlq1qwalletinput",
            assetId: POLICY_ASSET,
            amount: "13000",
            scriptPubKey: `0014${"55".repeat(20)}`,
            confidential: true,
            sighashType: 1,
          },
        ],
        recipients,
        balanceChanges: { [POLICY_ASSET]: "-13000" },
        fees: { [POLICY_ASSET]: "1000" },
        hasConfidentialInputs: true,
        hasConfidentialOutputs: true,
      },
    };

    const markup = renderToStaticMarkup(
      createElement(ApprovalOverlay, { request, onClose: vi.fn() }),
    );

    expect(markup).toContain('data-testid="approval-overlay"');
    expect(markup).toContain("overflow-y-auto");
    expect(markup).toContain("min-h-full");
    expect(markup).toContain("my-auto");
    expect(markup).toContain(recipients[0].address);
    expect(markup).toContain(recipients.at(-1)?.address);
    expect(markup).toContain("sign—not broadcast");
    expect(markup).toContain("Sign only");
    expect(markup).toContain("Approve &amp; sign on Jade");
    expect(markup).toContain("Reject");
  });

  it("makes broadcast intent explicit throughout a PSET approval", () => {
    const request: Extract<ApprovalRequest, { kind: "signPset" }> = {
      kind: "signPset",
      id: "broadcast-approval-test",
      origin: "https://example.test",
      network: "testnet",
      locked: false,
      signerKind: "local",
      broadcast: true,
      review: {
        accountIdentifier: `bip122:${"22".repeat(16)}:test-wallet`,
        uniqueId: "33".repeat(32),
        walletStatus: "1",
        inputCount: 1,
        outputCount: 1,
        policyAssetId: POLICY_ASSET,
        inputs: [
          {
            index: 0,
            txid: "44".repeat(32),
            vout: 0,
            address: "tlq1qwalletinput",
            assetId: POLICY_ASSET,
            amount: "13000",
            scriptPubKey: `0014${"55".repeat(20)}`,
            confidential: true,
            sighashType: 1,
          },
        ],
        recipients: [],
        balanceChanges: { [POLICY_ASSET]: "-1000" },
        fees: { [POLICY_ASSET]: "1000" },
        hasConfidentialInputs: true,
        hasConfidentialOutputs: true,
      },
    };

    const markup = renderToStaticMarkup(
      createElement(ApprovalOverlay, { request, onClose: vi.fn() }),
    );

    expect(markup).toContain("Sign &amp; broadcast PSET");
    expect(markup).toContain("sign and broadcast this transaction");
    expect(markup).toContain("Sign and broadcast");
    expect(markup).toContain("Approve, sign &amp; broadcast");
    expect(markup).not.toContain("sign—not broadcast");
  });
});
