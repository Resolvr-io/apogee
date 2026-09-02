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
import {
  parseDeclarativeTxManifest,
  type DeclarativeManifest,
} from "./declarative";
import { SIMPLICITY_LENDING_V3_REGTEST_CHAIN } from "./network";
import {
  TX_MANIFEST_ACTION_HINT_V1,
  txManifestActionHintScript,
} from "./action-hint";

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
  history: {
    actionHint: {
      codec: typeof TX_MANIFEST_ACTION_HINT_V1;
      placement: "dedicated-before-fee";
      postconditionVerifier: "simplicity-lending-v3";
    } | null;
  };
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
    chainIds: __TX_MANIFEST_REGTEST__
      ? [SIMPLICITY_LENDING_V3_TESTNET_CHAIN, SIMPLICITY_LENDING_V3_REGTEST_CHAIN]
      : [SIMPLICITY_LENDING_V3_TESTNET_CHAIN],
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
    history: {
      actionHint: {
        codec: TX_MANIFEST_ACTION_HINT_V1,
        placement: "dedicated-before-fee",
        postconditionVerifier: "simplicity-lending-v3",
      },
    },
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
  status: "builtin" | "generic" | "unknown" | "blocked";
  compatibility: "executable" | "inspect-only" | "incompatible";
  trust: "builtin" | "unverified" | null;
  requiresBundle: boolean;
  warningRequired: boolean;
  protocol?: { name: string; version: string };
  manifestSpecVersion?: string;
  supportedActions?: string[];
  reason?: string;
};

export async function getTxManifestSupport(
  bundleHash: TxManifestBundleHash,
  suppliedBundle?: unknown,
): Promise<TxManifestSupportResult> {
  const trusted = TRUSTED_TX_MANIFESTS.find((entry) => entry.bundleHash === bundleHash);
  if (trusted) {
    try {
      await assertTrustedBundleIntegrity(trusted);
      if (suppliedBundle !== undefined) {
        await requireSuppliedBundleHash(bundleHash, suppliedBundle);
      }
      return {
        supported: true,
        bundleHash,
        status: "builtin",
        compatibility: "executable",
        trust: "builtin",
        requiresBundle: false,
        warningRequired: false,
        protocol: { name: trusted.protocol, version: trusted.version },
        manifestSpecVersion: trusted.bundle.manifest.manifest_version as string,
        supportedActions: [...trusted.actions],
      };
    } catch (error) {
      return blockedSupport(bundleHash, error);
    }
  }
  if (suppliedBundle === undefined) {
    return {
      supported: false,
      bundleHash,
      status: "unknown",
      compatibility: "inspect-only",
      trust: null,
      requiresBundle: true,
      warningRequired: true,
    };
  }
  try {
    const generic = await resolveDeclarativeTxManifest(bundleHash, suppliedBundle);
    return {
      supported: true,
      bundleHash,
      status: "generic",
      compatibility: "executable",
      trust: "unverified",
      requiresBundle: false,
      warningRequired: true,
      protocol: {
        name: String(generic.bundle.manifest.protocol),
        version: String(generic.bundle.manifest.manifest_version),
      },
      manifestSpecVersion: String(generic.bundle.manifest.manifest_version),
      supportedActions: Object.keys(generic.declarative.actions).sort(),
    };
  } catch (error) {
    return blockedSupport(bundleHash, error);
  }
}

export type ResolvedDeclarativeTxManifest = {
  bundleHash: TxManifestBundleHash;
  bundle: TxManifestBundle;
  declarative: DeclarativeManifest;
};

/**
 * Resolve an untrusted bundle by capabilities, never by protocol name or hash.
 * Callers must retain the full normalized bundle because its bytes are the
 * execution authority and are revalidated for every invocation.
 */
export async function resolveDeclarativeTxManifest(
  bundleHash: TxManifestBundleHash,
  suppliedBundle: unknown,
): Promise<ResolvedDeclarativeTxManifest> {
  const bundle = normalizeTxManifestBundle(suppliedBundle);
  const actual = await txManifestBundleHash(bundle);
  if (actual !== bundleHash) {
    throw new Error("The supplied TX Manifest bundle does not match its requested hash.");
  }
  if (bundle.manifestSpec.revision !== TX_MANIFEST_PINNED_REVISIONS.referenceSpec) {
    throw new Error("The declarative bundle uses an unsupported TX Manifest specification revision.");
  }
  if (bundle.compiler.revision !== TX_MANIFEST_PINNED_REVISIONS.simplicityHl) {
    throw new Error("The declarative bundle uses an unsupported SimplicityHL compiler revision.");
  }
  return {
    bundleHash,
    bundle,
    declarative: parseDeclarativeTxManifest(bundle),
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

/** Build a wallet-added hint only when the trusted registry explicitly opts in. */
export async function trustedTxManifestActionHintScript(
  bundleHash: TxManifestBundleHash,
  action: string,
): Promise<string> {
  const trusted = await resolveTrustedTxManifest(bundleHash);
  if (trusted.history.actionHint?.codec !== TX_MANIFEST_ACTION_HINT_V1) {
    throw new Error("This trusted TX Manifest does not enable on-chain action hints.");
  }
  if (!trusted.actions.includes(action)) {
    throw new Error("This TX Manifest action is not enabled by Apogee.");
  }
  return txManifestActionHintScript(bundleHash, action);
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

async function requireSuppliedBundleHash(
  expected: TxManifestBundleHash,
  suppliedBundle: unknown,
): Promise<void> {
  const actual = await txManifestBundleHash(normalizeTxManifestBundle(suppliedBundle));
  if (actual !== expected) {
    throw new Error("The supplied TX Manifest bundle does not match its requested hash.");
  }
}

function blockedSupport(
  bundleHash: TxManifestBundleHash,
  error: unknown,
): TxManifestSupportResult {
  return {
    supported: false,
    bundleHash,
    status: "blocked",
    compatibility: "incompatible",
    trust: "unverified",
    requiresBundle: false,
    warningRequired: true,
    reason: error instanceof Error ? error.message : "The supplied bundle is incompatible.",
  };
}
