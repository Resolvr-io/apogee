import {
  SIMPLICITY_LENDING_V3_ACCEPT_OFFER,
  SIMPLICITY_LENDING_V3_BUNDLE,
  SIMPLICITY_LENDING_V3_CANCEL_OFFER,
  SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT,
  SIMPLICITY_LENDING_V3_CLAIM_PRINCIPAL,
  SIMPLICITY_LENDING_V3_CREATE_FACTORY,
  SIMPLICITY_LENDING_V3_CREATE_OFFER,
  SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER,
  SIMPLICITY_LENDING_V3_REPAY_LOAN,
  SIMPLICITY_LENDING_V3_TESTNET_CHAIN,
} from "./builtins/simplicity-lending-v3";
import {
  TX_MANIFEST_PINNED_REVISIONS,
  normalizeTxManifestBundle,
  txManifestBundleHash,
  type TxManifestBundle,
} from "./bundle";

export type TxManifestBundleHash = `sha256:${string}`;

export const SIMPLICITY_LENDING_V3_BUNDLE_HASH =
  "sha256:debdae89777fdd21fec2d763efe028876f267ff214aca9ddf9b3735d7657be15" as const;

export type TrustedTxManifest = {
  bundleHash: TxManifestBundleHash;
  protocol: string;
  version: string;
  chainIds: readonly string[];
  actions: readonly string[];
  compilerRevision: string;
  extensions: readonly string[];
  review: {
    protocolLabel: string;
    actionLabels: Readonly<Record<string, string>>;
  };
  bundle: TxManifestBundle;
};

export const TRUSTED_TX_MANIFESTS: readonly TrustedTxManifest[] = Object.freeze([
  {
    bundleHash: SIMPLICITY_LENDING_V3_BUNDLE_HASH,
    protocol: "simplicity-lending",
    version: "v3",
    chainIds: [SIMPLICITY_LENDING_V3_TESTNET_CHAIN],
    actions: [
      SIMPLICITY_LENDING_V3_CREATE_FACTORY,
      SIMPLICITY_LENDING_V3_CREATE_OFFER,
      SIMPLICITY_LENDING_V3_ACCEPT_OFFER,
      SIMPLICITY_LENDING_V3_CLAIM_PRINCIPAL,
      SIMPLICITY_LENDING_V3_REPAY_LOAN,
      SIMPLICITY_LENDING_V3_CANCEL_OFFER,
      SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER,
      SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT,
    ],
    compilerRevision: TX_MANIFEST_PINNED_REVISIONS.simplicityHl,
    extensions: [],
    review: {
      protocolLabel: "Simplicity Lending",
      actionLabels: {
        [SIMPLICITY_LENDING_V3_CREATE_FACTORY]: "Enable borrowing",
        [SIMPLICITY_LENDING_V3_CREATE_OFFER]: "Create borrow offer",
        [SIMPLICITY_LENDING_V3_ACCEPT_OFFER]: "Fund loan offer",
        [SIMPLICITY_LENDING_V3_CLAIM_PRINCIPAL]: "Claim borrowed funds",
        [SIMPLICITY_LENDING_V3_REPAY_LOAN]: "Repay loan in full",
        [SIMPLICITY_LENDING_V3_CANCEL_OFFER]: "Cancel borrow offer",
        [SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER]: "Liquidate expired loan",
        [SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT]: "Collect loan repayment",
      },
    },
    bundle: SIMPLICITY_LENDING_V3_BUNDLE,
  },
]);

export type TxManifestSupportResult = {
  supported: boolean;
  bundleHash: TxManifestBundleHash;
  status: "builtin" | "unknown" | "blocked";
  protocol?: { name: string; version: string };
  manifestSpecVersion?: string;
  supportedActions?: string[];
};

export async function getTxManifestSupport(
  bundleHash: TxManifestBundleHash,
): Promise<TxManifestSupportResult> {
  const trusted = TRUSTED_TX_MANIFESTS.find((entry) => entry.bundleHash === bundleHash);
  if (!trusted) return { supported: false, bundleHash, status: "unknown" };
  await assertTrustedBundleIntegrity(trusted);
  return {
    supported: true,
    bundleHash,
    status: "builtin",
    protocol: { name: trusted.protocol, version: trusted.version },
    manifestSpecVersion: trusted.bundle.manifest.manifest_version as string,
    supportedActions: [...trusted.actions],
  };
}

export async function resolveTrustedTxManifest(
  bundleHash: TxManifestBundleHash,
  suppliedBundle?: unknown,
): Promise<TrustedTxManifest> {
  const trusted = TRUSTED_TX_MANIFESTS.find((entry) => entry.bundleHash === bundleHash);
  if (!trusted) throw new Error("Unknown or unsupported TX Manifest bundle.");
  await assertTrustedBundleIntegrity(trusted);
  if (suppliedBundle !== undefined) {
    const suppliedHash = await txManifestBundleHash(normalizeTxManifestBundle(suppliedBundle));
    if (suppliedHash !== bundleHash) {
      throw new Error("The supplied TX Manifest bundle does not match its requested hash.");
    }
  }
  return trusted;
}

async function assertTrustedBundleIntegrity(trusted: TrustedTxManifest): Promise<void> {
  const actual = await txManifestBundleHash(trusted.bundle);
  if (actual !== trusted.bundleHash) {
    throw new Error(`Built-in TX Manifest integrity failure: expected ${trusted.bundleHash}, got ${actual}.`);
  }
  if (trusted.bundle.compiler.revision !== trusted.compilerRevision) {
    throw new Error("Built-in TX Manifest compiler revision does not match its registry entry.");
  }
}
