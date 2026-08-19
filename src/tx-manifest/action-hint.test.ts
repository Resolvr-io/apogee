import { describe, expect, it } from "vitest";
import { SIMPLICITY_LENDING_V3_CREATE_OFFER } from "./builtins/simplicity-lending-v3";
import {
  decodeTxManifestActionHint,
  encodeTxManifestActionHint,
  txManifestActionHintMatches,
  txManifestActionHintScript,
  txManifestActionHintsFromScript,
} from "./action-hint";
import { SIMPLICITY_LENDING_V3_BUNDLE_HASH } from "./registry";

describe("TX Manifest action hints", () => {
  it("encodes the exact bundle and a deterministic 128-bit action tag", async () => {
    const encoded = await encodeTxManifestActionHint(
      SIMPLICITY_LENDING_V3_BUNDLE_HASH,
      SIMPLICITY_LENDING_V3_CREATE_OFFER,
    );

    expect(encoded).toHaveLength(53 * 2);
    expect(encoded).toMatch(
      /^54584d4601debdae89777fdd21fec2d763efe028876f267ff214aca9ddf9b3735d7657be15[0-9a-f]{32}$/,
    );
    expect(encoded.slice(-32)).toBe("e30a67bba16e438de203e99c0e482fac");
    expect(decodeTxManifestActionHint(encoded)).toMatchObject({
      version: 1,
      bundleHash: SIMPLICITY_LENDING_V3_BUNDLE_HASH,
    });
  });

  it("finds the marker in any OP_RETURN push position", async () => {
    const marker = await encodeTxManifestActionHint(
      SIMPLICITY_LENDING_V3_BUNDLE_HASH,
      SIMPLICITY_LENDING_V3_CREATE_OFFER,
    );
    const script = `6a046275726e35${marker}`;

    const [hint] = txManifestActionHintsFromScript(script);
    expect(hint).toBeDefined();
    await expect(
      txManifestActionHintMatches(hint!, SIMPLICITY_LENDING_V3_CREATE_OFFER),
    ).resolves.toBe(true);
  });

  it("builds a standard 53-byte single-push marker and ignores malformed scripts", async () => {
    await expect(
      txManifestActionHintScript(
        SIMPLICITY_LENDING_V3_BUNDLE_HASH,
        SIMPLICITY_LENDING_V3_CREATE_OFFER,
      ),
    ).resolves.toMatch(/^6a35[0-9a-f]{106}$/);
    expect(txManifestActionHintsFromScript("0014deadbeef")).toEqual([]);
    expect(txManifestActionHintsFromScript("6a35deadbeef")).toEqual([]);
    expect(decodeTxManifestActionHint("54584d4602")).toBeNull();
  });
});
