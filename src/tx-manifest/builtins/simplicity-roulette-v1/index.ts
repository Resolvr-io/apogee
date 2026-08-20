import manifest from "./manifest.json";
import roulette from "./sources/roulette_v1.simf?raw";
import {
  TX_MANIFEST_BUNDLE_SCHEMA,
  TX_MANIFEST_PINNED_REVISIONS,
  type TxManifestBundle,
} from "../../bundle";

export * from "./actions";

export const SIMPLICITY_ROULETTE_V1_CMR =
  "190ac19a69f2e8dc2cc24824e54c895c1d989ba75b7a01fe2a0f04ecb68fde91" as const;
export const SIMPLICITY_ROULETTE_V1_TAPLEAF_HASH =
  "045e24549456fcd655cd3ddf577e9a336a62c2bd262dedaf4bb21c5e93eb2a98" as const;

/**
 * The canonical repository source starts with `simc "0.7.0";` and a blank line.
 * Apogee's pinned WASM frontend rejects that file-only directive, so this bundle
 * pins the byte-identical body after those two non-semantic lines. Both forms
 * compile to SIMPLICITY_ROULETTE_V1_CMR.
 */
export const SIMPLICITY_ROULETTE_V1_BUNDLE = Object.freeze({
  schema: TX_MANIFEST_BUNDLE_SCHEMA,
  manifestSpec: {
    id: "elip-205-draft",
    revision: TX_MANIFEST_PINNED_REVISIONS.referenceSpec,
  },
  compiler: {
    id: "simplicityhl",
    revision: TX_MANIFEST_PINNED_REVISIONS.simplicityHl,
    debugSymbols: false,
  },
  extensions: ["apogee/roulette-metadata-v1"],
  manifest,
  sources: { "roulette_v1.simf": roulette },
} satisfies TxManifestBundle);
