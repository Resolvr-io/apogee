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
  SIMPLICITY_ROULETTE_V1_ACTIONS,
  SIMPLICITY_ROULETTE_V1_BUNDLE,
  SIMPLICITY_ROULETTE_V1_CANCEL,
  SIMPLICITY_ROULETTE_V1_CLAIM_PAYOUT,
  SIMPLICITY_ROULETTE_V1_FORFEIT,
  SIMPLICITY_ROULETTE_V1_OPEN,
  SIMPLICITY_ROULETTE_V1_SETTLE,
  SIMPLICITY_ROULETTE_V1_TAKE,
} from "./builtins/simplicity-roulette-v1";
import {
  TX_MANIFEST_PINNED_REVISIONS,
  normalizeTxManifestBundle,
  txManifestBundleHash,
  type TxManifestBundle,
} from "./bundle";
import { SIMPLICITY_LENDING_V3_REGTEST_CHAIN } from "./network";
import {
  TX_MANIFEST_ACTION_HINT_V1,
  txManifestActionHintScript,
} from "./action-hint";

export type TxManifestBundleHash = `sha256:${string}`;

export const SIMPLICITY_LENDING_V3_BUNDLE_HASH =
  "sha256:debdae89777fdd21fec2d763efe028876f267ff214aca9ddf9b3735d7657be15" as const;

export const SIMPLICITY_ROULETTE_V1_BUNDLE_HASH =
  "sha256:26f77f6f984ebcdccfb96a626285858fb7bdcb0bfa290ba59f6cee57573c4830" as const;

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
      postconditionVerifier: "simplicity-lending-v3" | "simplicity-roulette-v1";
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
    bundleHash: SIMPLICITY_ROULETTE_V1_BUNDLE_HASH,
    protocol: "simplicity-roulette",
    version: "v1",
    chainIds: __TX_MANIFEST_REGTEST__
      ? [SIMPLICITY_LENDING_V3_TESTNET_CHAIN, SIMPLICITY_LENDING_V3_REGTEST_CHAIN]
      : [SIMPLICITY_LENDING_V3_TESTNET_CHAIN],
    actions: SIMPLICITY_ROULETTE_V1_ACTIONS,
    compilerRevision: TX_MANIFEST_PINNED_REVISIONS.simplicityHl,
    extensions: ["apogee/roulette-metadata-v1"],
    history: {
      actionHint: {
        codec: TX_MANIFEST_ACTION_HINT_V1,
        placement: "dedicated-before-fee",
        postconditionVerifier: "simplicity-roulette-v1",
      },
    },
    review: {
      protocolLabel: "Simplicity Roulette",
      actionLabels: {
        [SIMPLICITY_ROULETTE_V1_OPEN]: "Open roulette bet",
        [SIMPLICITY_ROULETTE_V1_TAKE]: "Take roulette bet",
        [SIMPLICITY_ROULETTE_V1_SETTLE]: "Settle roulette spin",
        [SIMPLICITY_ROULETTE_V1_CANCEL]: "Cancel untaken bet",
        [SIMPLICITY_ROULETTE_V1_FORFEIT]: "Forfeit unrevealed bet",
        [SIMPLICITY_ROULETTE_V1_CLAIM_PAYOUT]: "Secure roulette payout",
      } as Readonly<Record<string, string>>,
    },
    bundle: SIMPLICITY_ROULETTE_V1_BUNDLE,
  },
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
      } as Readonly<Record<string, string>>,
    },
    bundle: SIMPLICITY_LENDING_V3_BUNDLE,
  },
] satisfies TrustedTxManifest[]);

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
