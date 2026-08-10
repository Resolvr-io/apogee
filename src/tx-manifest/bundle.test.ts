import { describe, expect, it } from "vitest";
import {
  TX_MANIFEST_BUNDLE_SCHEMA,
  TX_MANIFEST_PINNED_REVISIONS,
  canonicalJson,
  inspectTxManifestBundle,
  normalizeTxManifestBundle,
  txManifestBundleHash,
  type TxManifestBundle,
} from "./bundle";

function bundle(): TxManifestBundle {
  return {
    schema: TX_MANIFEST_BUNDLE_SCHEMA,
    manifestSpec: {
      id: "elip-205-draft",
      revision: TX_MANIFEST_PINNED_REVISIONS.elipDraft,
    },
    compiler: {
      id: "simplicityhl",
      revision: TX_MANIFEST_PINNED_REVISIONS.simplicityHl,
      debugSymbols: true,
    },
    extensions: [],
    manifest: {
      protocol: "p2pk-simplicity",
      manifest_version: "0.1.0",
      actions: {
        Receive: {},
        Pay: {
          outputs: [
            {
              destination: {
                utxo_type: "p2pk",
              },
            },
          ],
        },
      },
      utxo_types: {
        p2pk: {
          script: {
            type: "simplicity",
            source: "./p2pk.simf",
          },
        },
      },
    },
    sources: {
      "p2pk.simf": "fn main() { assert!(true); }\n",
    },
  };
}

describe("TX Manifest bundle identity", () => {
  it("matches the bundle-v1 hash vector", async () => {
    await expect(txManifestBundleHash(bundle())).resolves.toBe(
      "sha256:190dc9b16b76e4f94d04000ccc46d3cf17836c46d6c10cf3f343c821cc654f48",
    );
  });

  it("is stable across object-key and manifest formatting differences", async () => {
    const first = bundle();
    const reordered = JSON.parse(canonicalJson(first)) as TxManifestBundle;
    reordered.sources = { "./p2pk.simf": reordered.sources["p2pk.simf"] };

    await expect(txManifestBundleHash(first)).resolves.toBe(
      await txManifestBundleHash(reordered),
    );
  });

  it("commits source text, compiler settings, and all manifest fields", async () => {
    const original = bundle();
    const sourceEdit = bundle();
    sourceEdit.sources["p2pk.simf"] += "// comment\n";
    const compilerEdit = bundle();
    compilerEdit.compiler.debugSymbols = false;
    const proseEdit = bundle();
    proseEdit.manifest.description = "Signer-visible or not, bundle v1 commits this.";

    const hash = await txManifestBundleHash(original);
    expect(await txManifestBundleHash(sourceEdit)).not.toBe(hash);
    expect(await txManifestBundleHash(compilerEdit)).not.toBe(hash);
    expect(await txManifestBundleHash(proseEdit)).not.toBe(hash);
  });

  it("reports the protocol actions and source paths", () => {
    expect(inspectTxManifestBundle(bundle())).toEqual({
      manifestVersion: "0.1.0",
      protocol: "p2pk-simplicity",
      actions: ["Pay", "Receive"],
      sourcePaths: ["p2pk.simf"],
    });
  });

  it("rejects missing sources and unsafe path aliases", () => {
    const missing = bundle();
    missing.sources = { "other.simf": "fn main() {}" };
    expect(() => normalizeTxManifestBundle(missing)).toThrow(/missing bundle source p2pk\.simf/);

    const traversal = bundle();
    traversal.sources = { "../p2pk.simf": "fn main() {}" };
    expect(() => normalizeTxManifestBundle(traversal)).toThrow(/not canonical/);
  });

  it("rejects source imports until a closed-bundle resolver exists", () => {
    const imported = bundle();
    imported.sources["p2pk.simf"] = 'import "ambient.simf";\nfn main() {}\n';
    expect(() => normalizeTxManifestBundle(imported)).toThrow(/declares an import/);
  });

  it("rejects floats and unsafe JSON integers", () => {
    expect(() => canonicalJson({ amount: 1.5 })).toThrow(/safe integers/);
    expect(() => canonicalJson({ amount: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/safe integers/);
  });
});
