import manifest from "./manifest.json";
import assetAuth from "./sources/asset_auth.simf?raw";
import assetAuthVault from "./sources/asset_auth_vault.simf?raw";
import issuanceFactory from "./sources/issuance_factory.simf?raw";
import lending from "./sources/lending.simf?raw";
import scriptAuth from "./sources/script_auth.simf?raw";
import {
  TX_MANIFEST_BUNDLE_SCHEMA,
  TX_MANIFEST_PINNED_REVISIONS,
  type TxManifestBundle,
} from "../../bundle";

/**
 * Current lending-v3 sources pinned to the deployed simplicity-lending revision.
 * Only AcceptOffer is trusted in Apogee's first vertical slice; the complete
 * manifest is bundled so later actions can be enabled without changing the
 * bundle's interpretation underfoot.
 */
export const SIMPLICITY_LENDING_V3_BUNDLE = Object.freeze({
  schema: TX_MANIFEST_BUNDLE_SCHEMA,
  manifestSpec: {
    id: "elip-205-draft",
    revision: TX_MANIFEST_PINNED_REVISIONS.referenceSpec,
  },
  compiler: {
    id: "simplicityhl",
    revision: TX_MANIFEST_PINNED_REVISIONS.simplicityHl,
    debugSymbols: true,
  },
  extensions: [],
  manifest,
  sources: {
    "asset_auth.simf": pinnedUpstreamSource(assetAuth, "asset_auth.simf"),
    "asset_auth_vault.simf": pinnedUpstreamSource(assetAuthVault, "asset_auth_vault.simf"),
    "issuance_factory.simf": pinnedUpstreamSource(issuanceFactory, "issuance_factory.simf"),
    "lending.simf": pinnedUpstreamSource(lending, "lending.simf"),
    "script_auth.simf": pinnedUpstreamSource(scriptAuth, "script_auth.simf"),
  },
} satisfies TxManifestBundle);

export const SIMPLICITY_LENDING_V3_ACCEPT_OFFER =
  "lending_contract.AcceptOffer" as const;

export const SIMPLICITY_LENDING_V3_TESTNET_CHAIN =
  "bip122:a771da8e52ee6ad581ed1e9a99825e5b" as const;

// apply_patch-managed text files end with LF, while this pinned upstream revision
// stores each .simf without a trailing newline. Restore the exact upstream bytes
// before hashing or compiling the built-in bundle.
function pinnedUpstreamSource(source: string, path: string): string {
  if (!source.endsWith("\n") || source.endsWith("\n\n")) {
    throw new Error(`Unexpected checkout bytes for built-in source ${path}.`);
  }
  return source.slice(0, -1);
}
