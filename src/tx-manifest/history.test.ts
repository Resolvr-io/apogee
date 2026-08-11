import { describe, expect, it } from "vitest";
import {
  SIMPLICITY_LENDING_V3_ACCEPT_OFFER,
  SIMPLICITY_LENDING_V3_CANCEL_OFFER,
  SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT,
  SIMPLICITY_LENDING_V3_CLAIM_PRINCIPAL,
  SIMPLICITY_LENDING_V3_CREATE_FACTORY,
  SIMPLICITY_LENDING_V3_CREATE_OFFER,
  SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER,
  SIMPLICITY_LENDING_V3_REPAY_LOAN,
} from "./builtins/simplicity-lending-v3";
import { txManifestActionHintScript } from "./action-hint";
import { txManifestHistoryAnnotation } from "./history";
import { SIMPLICITY_LENDING_V3_BUNDLE_HASH } from "./registry";

const PAY = `0014${"11".repeat(20)}`;
const BURN = "6a046275726e";
const FACTORY_METADATA = `6a0ddd1e7f8902${"00".repeat(8)}`;
const OFFER_METADATA = `6a32a9b4ade7${"22".repeat(46)}`;

const CASES = [
  {
    action: SIMPLICITY_LENDING_V3_CREATE_FACTORY,
    label: "Enable borrowing",
    inputs: 1,
    scripts: [PAY, PAY, FACTORY_METADATA],
  },
  {
    action: SIMPLICITY_LENDING_V3_CREATE_OFFER,
    label: "Create borrow offer",
    inputs: 3,
    scripts: [PAY, PAY, PAY, PAY, OFFER_METADATA, PAY],
  },
  {
    action: SIMPLICITY_LENDING_V3_ACCEPT_OFFER,
    label: "Fund loan offer",
    inputs: 4,
    scripts: [PAY, PAY, PAY],
  },
  {
    action: SIMPLICITY_LENDING_V3_CLAIM_PRINCIPAL,
    label: "Claim borrowed funds",
    inputs: 3,
    scripts: [PAY, PAY],
  },
  {
    action: SIMPLICITY_LENDING_V3_REPAY_LOAN,
    label: "Repay loan in full",
    inputs: 4,
    scripts: [BURN, PAY, PAY, PAY],
  },
  {
    action: SIMPLICITY_LENDING_V3_CANCEL_OFFER,
    label: "Cancel borrow offer",
    inputs: 4,
    scripts: [BURN, BURN, PAY],
  },
  {
    action: SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER,
    label: "Liquidate expired loan",
    inputs: 3,
    scripts: [BURN, PAY],
  },
  {
    action: SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT,
    label: "Collect loan repayment",
    inputs: 3,
    scripts: [BURN, PAY],
  },
] as const;

describe("TX Manifest history recovery", () => {
  it.each(CASES)("verifies $action from its canonical marker and action shape", async ({
    action,
    label,
    inputs,
    scripts,
  }) => {
    const marker = await txManifestActionHintScript(SIMPLICITY_LENDING_V3_BUNDLE_HASH, action);
    const annotation = await txManifestHistoryAnnotation(
      transaction(inputs, [...scripts, marker, ""]),
      true,
    );
    expect(annotation).toEqual({
      status: "verified",
      bundleHash: SIMPLICITY_LENDING_V3_BUNDLE_HASH,
      protocol: "simplicity-lending",
      version: "v3",
      protocolLabel: "Simplicity Lending",
      action,
      actionLabel: label,
    });
  });

  it.each(CASES)("accepts supplemental wallet inputs for $action", async ({
    action,
    inputs,
    scripts,
  }) => {
    const marker = await txManifestActionHintScript(SIMPLICITY_LENDING_V3_BUNDLE_HASH, action);
    await expect(
      txManifestHistoryAnnotation(transaction(inputs + 2, [...scripts, marker, ""]), true),
    ).resolves.toMatchObject({ status: "verified", action });
  });

  it("rejects a marker whose wallet-input count exceeds the construction policy", async () => {
    const marker = await txManifestActionHintScript(
      SIMPLICITY_LENDING_V3_BUNDLE_HASH,
      SIMPLICITY_LENDING_V3_CREATE_FACTORY,
    );
    await expect(
      txManifestHistoryAnnotation(transaction(13, [PAY, PAY, FACTORY_METADATA, marker, ""]), true),
    ).resolves.toMatchObject({ status: "unverified", reason: "shape-mismatch" });
  });

  it("does not trust a recognized marker without a wallet-owned signed input", async () => {
    const marker = await txManifestActionHintScript(
      SIMPLICITY_LENDING_V3_BUNDLE_HASH,
      SIMPLICITY_LENDING_V3_ACCEPT_OFFER,
    );
    await expect(
      txManifestHistoryAnnotation(transaction(4, [PAY, PAY, PAY, marker, ""]), false),
    ).resolves.toMatchObject({ status: "unverified", reason: "not-wallet-authenticated" });
  });

  it("rejects a spoofed action shape and reports unknown bundles without trusting them", async () => {
    const marker = await txManifestActionHintScript(
      SIMPLICITY_LENDING_V3_BUNDLE_HASH,
      SIMPLICITY_LENDING_V3_CANCEL_OFFER,
    );
    await expect(
      txManifestHistoryAnnotation(transaction(4, [PAY, PAY, PAY, marker, ""]), true),
    ).resolves.toMatchObject({ status: "unverified", reason: "shape-mismatch" });

    const unknown = `sha256:${"99".repeat(32)}` as const;
    const unknownMarker = await txManifestActionHintScript(unknown, "example.Action");
    await expect(
      txManifestHistoryAnnotation(transaction(1, [unknownMarker, ""]), true),
    ).resolves.toEqual({ status: "unsupported", bundleHash: unknown });
  });

  it("rejects ambiguous transactions containing more than one marker", async () => {
    const first = await txManifestActionHintScript(
      SIMPLICITY_LENDING_V3_BUNDLE_HASH,
      SIMPLICITY_LENDING_V3_ACCEPT_OFFER,
    );
    const second = await txManifestActionHintScript(
      SIMPLICITY_LENDING_V3_BUNDLE_HASH,
      SIMPLICITY_LENDING_V3_CANCEL_OFFER,
    );
    await expect(
      txManifestHistoryAnnotation(transaction(4, [PAY, PAY, PAY, first, second, ""]), true),
    ).resolves.toMatchObject({ status: "unverified", reason: "ambiguous" });
  });
});

function transaction(inputCount: number, scripts: string[]): Uint8Array {
  const inputs = Array.from(
    { length: inputCount },
    (_, index) => `${index.toString(16).padStart(2, "0")}${"00".repeat(31)}0000000000ffffffff`,
  ).join("");
  const outputs = scripts.map((script) =>
    `01${"44".repeat(32)}01000000000000000000${compactSize(script.length / 2)}${script}`,
  ).join("");
  return bytes(`0200000000${compactSize(inputCount)}${inputs}${compactSize(scripts.length)}${outputs}00000000`);
}

function compactSize(value: number): string {
  if (value >= 0xfd) throw new Error("test helper only supports small vectors");
  return value.toString(16).padStart(2, "0");
}

function bytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
}
