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
const PRINCIPAL_ASSET = "55".repeat(32);
const COLLATERAL_ASSET = "66".repeat(32);
const LENDER_NFT_ASSET = "77".repeat(32);

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

  function sendRequest(
    review: Partial<Extract<ApprovalRequest, { kind: "send" }>["review"]>,
  ): ApprovalRequest {
    return {
      kind: "send",
      id: "send-approval-test",
      origin: "https://example.test",
      network: "testnet",
      locked: false,
      signerKind: "local",
      review: {
        address: "tlq1qrecipient",
        recipientAmount: "1000",
        feeAmount: "100",
        drain: false,
        toSelf: false,
        ...review,
      },
    };
  }

  it("badges a token send's registry ticker without asserting it for LBTC", () => {
    const token = renderToStaticMarkup(
      createElement(ApprovalOverlay, {
        request: sendRequest({
          assetId: POLICY_ASSET,
          assetTicker: "USDT",
          assetPrecision: 8,
        }),
        onClose: vi.fn(),
      }),
    );
    expect(token).toContain("registry · USDT");

    // LBTC is identified by its ticker row alone — a "registry" badge there
    // would claim a provenance the send never had.
    const lbtc = renderToStaticMarkup(
      createElement(ApprovalOverlay, { request: sendRequest({}), onClose: vi.fn() }),
    );
    expect(lbtc).not.toContain("registry");
  });

  it("keeps the registry marker visible when a long ticker is clamped", () => {
    // The marker leads and the ticker is clamped (Approval Row truncates), so a
    // hostile long label can't clip the "registry" provenance hint off-screen.
    const longTicker = "SUPER".repeat(12); // 60 chars, clamp cuts at 24
    const markup = renderToStaticMarkup(
      createElement(ApprovalOverlay, {
        request: sendRequest({ assetId: POLICY_ASSET, assetTicker: longTicker }),
        onClose: vi.fn(),
      }),
    );
    expect(markup).toContain("registry · SUPER");
    // The Label row carries the clamped 24-char form, not the full ticker.
    expect(markup).toContain(`registry · ${longTicker.slice(0, 24)}`);
  });

  it("explains requested contract permissions in human terms", () => {
    const request: Extract<ApprovalRequest, { kind: "connect" }> = {
      kind: "connect",
      id: "connect-approval-test",
      origin: "https://lending.example.test",
      network: "testnet",
      fingerprint: "aabbccdd",
      signerKind: "local",
      locked: false,
      methods: [
        "experimental_getTxManifestSupport",
        "experimental_executeTxManifest",
        "getBalance",
      ],
      events: ["bip122_walletDescriptorChanged"],
      legacy: false,
    };
    const markup = renderToStaticMarkup(
      createElement(ApprovalOverlay, { request, onClose: vi.fn() }),
    );

    expect(markup).toContain("Check contract support");
    expect(markup).toContain("Execute contracts");
    expect(markup).toContain("Read balances");
    expect(markup).toContain("Watch address changes");
    expect(markup).toContain("public wallet descriptor changes");
    expect(markup).toContain("Each action is built, verified, and shown for approval");
  });

  it("shows trusted lending intent and makes manifest broadcast explicit", () => {
    const request: Extract<ApprovalRequest, { kind: "executeTxManifest" }> = {
      kind: "executeTxManifest",
      id: "manifest-approval-test",
      origin: "https://lending.example.test",
      network: "testnet",
      locked: false,
      signerKind: "local",
      signingMode: "wallet",
      review: {
        kind: "acceptOffer",
        protocolLabel: "Simplicity Lending",
        actionLabel: "Fund loan offer",
        requestId: "accept-offer-3",
        accountIdentifier: `bip122:${"22".repeat(16)}:${"33".repeat(16)}`,
        bundleHash: `sha256:${"44".repeat(32)}`,
        action: "lending_contract.AcceptOffer",
        lenderNftAssetId: LENDER_NFT_ASSET,
        principalAssetId: PRINCIPAL_ASSET,
        principalAmount: "100000000",
        collateralAssetId: COLLATERAL_ASSET,
        collateralAmount: "250000000",
        interestRateBasisPoints: "500",
        totalDebt: "105000000",
        expirationHeight: 500000,
        feeAssetId: POLICY_ASSET,
        fee: "1000",
        principalChange: "2500",
        feeChange: "9000",
        assets: {
          [POLICY_ASSET]: { label: "LBTC", ticker: "LBTC", precision: 8, source: "builtin" },
          [PRINCIPAL_ASSET]: { label: "TEST-USDT", ticker: "TEST-USDT", precision: 8, source: "registry" },
          [COLLATERAL_ASSET]: { label: "Collateral", ticker: "COL", precision: 8, source: "registry" },
          [LENDER_NFT_ASSET]: { label: "Lender NFT", ticker: null, precision: null, source: "fallback" },
        },
      },
    };
    const markup = renderToStaticMarkup(
      createElement(ApprovalOverlay, { request, onClose: vi.fn() }),
    );
    const text = markup.replace(/<[^>]+>/g, "");
    expect(markup).toContain("Execute contract action");
    expect(markup).toContain("Simplicity Lending");
    expect(markup).toContain("Fund loan offer");
    expect(markup).toContain("approve to sign and broadcast");
    expect(markup).toContain("Approve &amp; execute");
    expect(markup).toContain("Network fee");
    expect(markup).toContain("Principal");
    expect(markup).toContain("registry · TEST-USDT");
    expect(markup).toContain("registry · Collateral");
    expect(markup).not.toContain("registry · LBTC");
    expect(text).toContain(PRINCIPAL_ASSET);
    expect(text).toContain(COLLATERAL_ASSET);
    expect(text).toContain(LENDER_NFT_ASSET);
    expect(text).toContain("Lender NFT received");
    expect(markup).toContain("100,000,000 base units");
    expect(markup).toContain("1,000 sats");
    expect(text).toContain("1.00");
    expect(text).toContain("2.50");
  });

  it("explains that recovery broadcasts exact saved bytes without signing again", () => {
    const request: Extract<ApprovalRequest, { kind: "executeTxManifest" }> = {
      kind: "executeTxManifest",
      id: "manifest-recovery-test",
      origin: "https://lending.example.test",
      network: "testnet",
      locked: false,
      signerKind: "local",
      signingMode: "wallet",
      recovery: true,
      review: {
        kind: "acceptOffer",
        protocolLabel: "Simplicity Lending",
        actionLabel: "Fund loan offer",
        requestId: "accept-offer-3",
        accountIdentifier: `bip122:${"22".repeat(16)}:${"33".repeat(16)}`,
        bundleHash: `sha256:${"44".repeat(32)}`,
        action: "lending_contract.AcceptOffer",
        principalAssetId: PRINCIPAL_ASSET,
        principalAmount: "100000000",
        collateralAssetId: COLLATERAL_ASSET,
        collateralAmount: "250000000",
        interestRateBasisPoints: "500",
        totalDebt: "105000000",
        expirationHeight: 500000,
        feeAssetId: POLICY_ASSET,
        fee: "1000",
        principalChange: "2500",
        feeChange: "9000",
      },
    };

    const markup = renderToStaticMarkup(
      createElement(ApprovalOverlay, { request, onClose: vi.fn() }),
    );

    expect(markup).toContain("Resume contract transaction");
    expect(markup).toContain("exact signed transaction");
    expect(markup).toContain("revalidates current state");
    expect(markup).toContain("does not replace or re-sign");
    expect(markup).toContain("Resume broadcast");
    expect(markup).not.toContain("Approval signs and broadcasts it");
  });

  it("shows the lender's net collection, protocol fee, and NFT burn", () => {
    const request: Extract<ApprovalRequest, { kind: "executeTxManifest" }> = {
      kind: "executeTxManifest",
      id: "claim-manifest-approval-test",
      origin: "https://lending.example.test",
      network: "testnet",
      locked: false,
      signerKind: "local",
      signingMode: "wallet",
      review: {
        kind: "claimLenderVault",
        protocolLabel: "Simplicity Lending",
        actionLabel: "Collect loan repayment",
        requestId: "claim-offer-3",
        accountIdentifier: `bip122:${"22".repeat(16)}:${"33".repeat(16)}`,
        bundleHash: `sha256:${"44".repeat(32)}`,
        action: "lending_contract.ClaimLenderVault",
        principalAssetId: PRINCIPAL_ASSET,
        principalAmount: "104500000",
        grossDebt: "105000000",
        interestAmount: "5000000",
        protocolFeeAmount: "500000",
        lenderNftAssetId: COLLATERAL_ASSET,
        feeAssetId: POLICY_ASSET,
        fee: "1000",
        feeChange: "9000",
        assets: { [POLICY_ASSET]: { label: "LBTC", ticker: "LBTC", precision: 8 } },
      },
    };
    const markup = renderToStaticMarkup(
      createElement(ApprovalOverlay, { request, onClose: vi.fn() }),
    );
    expect(markup).toContain("Collect loan repayment");
    expect(markup).toContain("Repayment collected");
    expect(markup).toContain("Net to wallet");
    expect(markup).toContain("Protocol fee");
    expect(markup).toContain("Lender NFT burned");
  });

  it("keeps signature-free manifest approval keyless for locked watch-only wallets", () => {
    const request: Extract<ApprovalRequest, { kind: "executeTxManifest" }> = {
      kind: "executeTxManifest",
      id: "keyless-manifest-approval-test",
      origin: "https://contracts.example.test",
      network: "testnet",
      locked: true,
      signerKind: "watch",
      signingMode: "none",
      review: {
        kind: "createFactory",
        protocolLabel: "Contract",
        actionLabel: "Advance state",
        requestId: "keyless-action-1",
        accountIdentifier: `bip122:${"22".repeat(16)}:${"33".repeat(16)}`,
        bundleHash: `sha256:${"44".repeat(32)}`,
        action: "contract.Advance",
        factoryAssetId: COLLATERAL_ASSET,
        fundingAmount: "1",
        feeAssetId: POLICY_ASSET,
        fee: "1000",
        feeChange: "0",
      },
    };

    const markup = renderToStaticMarkup(
      createElement(ApprovalOverlay, { request, onClose: vi.fn() }),
    );

    expect(markup).toContain("approve to verify and broadcast");
    expect(markup).toContain("Approve &amp; broadcast");
    expect(markup).not.toContain("Unlock to approve");
    expect(markup).not.toContain("sign on your Jade");
  });

  it("describes signature-free recovery without claiming the bytes were signed", () => {
    const request: Extract<ApprovalRequest, { kind: "executeTxManifest" }> = {
      kind: "executeTxManifest",
      id: "keyless-manifest-recovery-test",
      origin: "https://contracts.example.test",
      network: "testnet",
      locked: false,
      signerKind: "jade",
      signingMode: "none",
      recovery: true,
      review: {
        kind: "createFactory",
        protocolLabel: "Contract",
        actionLabel: "Advance state",
        requestId: "keyless-action-1",
        accountIdentifier: `bip122:${"22".repeat(16)}:${"33".repeat(16)}`,
        bundleHash: `sha256:${"44".repeat(32)}`,
        action: "contract.Advance",
        factoryAssetId: COLLATERAL_ASSET,
        fundingAmount: "1",
        feeAssetId: POLICY_ASSET,
        fee: "1000",
        feeChange: "0",
      },
    };

    const markup = renderToStaticMarkup(
      createElement(ApprovalOverlay, { request, onClose: vi.fn() }),
    );

    expect(markup).toContain("exact finalized transaction");
    expect(markup).toContain("revalidates current state");
    expect(markup).toContain("without accessing signing keys");
    expect(markup).not.toContain("exact signed transaction");
    expect(markup).not.toContain("sign on your Jade");
  });
});
