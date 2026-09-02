import { describe, expect, it } from "vitest";
import { SIMPLICITY_LENDING_V3_BUNDLE } from "./builtins/simplicity-lending-v3";
import { txManifestBundleHash } from "./bundle";
import {
  SIMPLICITY_LENDING_V3_BUNDLE_HASH,
  TRUSTED_TX_MANIFESTS,
  getTxManifestSupport,
  resolveTrustedTxManifest,
  trustedTxManifestActionHintScript,
} from "./registry";
import { SIMPLICITY_LENDING_V3_REGTEST_CHAIN } from "./network";

describe("trusted TX Manifest registry", () => {
  it("pins the exact current lending-v3 bundle", async () => {
    expect(await txManifestBundleHash(SIMPLICITY_LENDING_V3_BUNDLE)).toBe(
      SIMPLICITY_LENDING_V3_BUNDLE_HASH,
    );
    await expect(sourceHash("lending.simf")).resolves.toBe(
      "a9b4ade7d131f963a0da014b45f08cc49094194cd76490a30495e3dc93749b8a",
    );
  });

  it("reports only explicitly enabled actions", async () => {
    await expect(getTxManifestSupport(SIMPLICITY_LENDING_V3_BUNDLE_HASH)).resolves.toMatchObject({
      supported: true,
      status: "builtin",
      compatibility: "executable",
      trust: "builtin",
      requiresBundle: false,
      warningRequired: false,
      supportedActions: [
        "issuance_factory.CreateFactory",
        "lending_contract.CreateOffer",
        "lending_contract.AcceptOffer",
        "lending_contract.ClaimPrincipal",
        "lending_contract.RepayLoan",
        "lending_contract.CancelOffer",
        "lending_contract.LiquidateOffer",
        "lending_contract.ClaimLenderVault",
      ],
    });
  });

  it("explicitly opts the trusted lending bundle into canonical history hints", async () => {
    expect(TRUSTED_TX_MANIFESTS[0].history.actionHint).toEqual({
      codec: "txmf-v1",
      placement: "dedicated-before-fee",
      postconditionVerifier: "simplicity-lending-v3",
    });
    await expect(
      trustedTxManifestActionHintScript(
        SIMPLICITY_LENDING_V3_BUNDLE_HASH,
        "lending_contract.RepayLoan",
      ),
    ).resolves.toMatch(/^6a35[0-9a-f]{106}$/);
  });

  it("does not trust the regtest chain in normal builds", () => {
    expect(TRUSTED_TX_MANIFESTS[0].chainIds).not.toContain(
      SIMPLICITY_LENDING_V3_REGTEST_CHAIN,
    );
  });

  it("rejects an unknown hash and a mismatched supplied bundle", async () => {
    const unknown = `sha256:${"11".repeat(32)}` as const;
    await expect(getTxManifestSupport(unknown)).resolves.toEqual({
      supported: false,
      bundleHash: unknown,
      status: "unknown",
      compatibility: "inspect-only",
      trust: null,
      requiresBundle: true,
      warningRequired: true,
    });
    const edited = structuredClone(SIMPLICITY_LENDING_V3_BUNDLE);
    edited.manifest.description = "modified";
    await expect(resolveTrustedTxManifest(SIMPLICITY_LENDING_V3_BUNDLE_HASH, edited)).rejects.toThrow(
      /does not match/,
    );
  });
});

async function sourceHash(path: keyof typeof SIMPLICITY_LENDING_V3_BUNDLE.sources): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(SIMPLICITY_LENDING_V3_BUNDLE.sources[path]),
    ),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
