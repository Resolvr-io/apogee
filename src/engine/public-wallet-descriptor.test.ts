import { describe, expect, it } from "vitest";
import { handle } from "./engine-core";
import type { DerivedWallet, DescriptorInfo, PublicWalletDescriptorDTO } from "./protocol";
import { publicWalletDescriptor, withDescriptorChecksum } from "./public-wallet-descriptor";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("public wallet descriptor projection", () => {
  it("matches the BIP-380 checksum reference vector", () => {
    expect(withDescriptorChecksum("raw(deadbeef)")).toBe("raw(deadbeef)#89f8spxm");
  });

  it("removes SLIP-77 view material from an LWK descriptor", async () => {
    const wallet = (await handle({
      kind: "deriveWallet",
      mnemonic: TEST_MNEMONIC,
      network: "liquidtestnet",
    })) as DerivedWallet;
    const result = (await handle({
      kind: "getPublicWalletDescriptor",
      descriptor: wallet.descriptor,
    })) as PublicWalletDescriptorDTO;

    expect(result.descriptor).toMatch(/^elwpkh\(.+\/<0;1>\/\*\)#\w{8}$/);
    expect(result.descriptor).not.toContain("ct(");
    expect(result.descriptor).not.toContain("slip77(");
    expect(result.descriptor).not.toContain("9c8e4f05c7711a98c838be228bcb84924d4570ca53f35fa1c793e58841d47023");
    expect(result.standardsUsed).toEqual([
      "bip-0032",
      "bip-0044",
      "slip-0044",
      "bip-0084",
      "bip-0380",
      "bip-0389",
    ]);
  });

  it("fails closed for other blinding policies, non-multipath descriptors, and private spend keys", () => {
    expect(() =>
      publicWalletDescriptor("ct(elip151,elwpkh(02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa))#12345678"),
    ).toThrow(/blinding policy/i);
    expect(() =>
      publicWalletDescriptor("ct(slip77(aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa),elwpkh(02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa))#12345678"),
    ).toThrow(/multipath/i);
    expect(() =>
      publicWalletDescriptor("ct(slip77(aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa),elwpkh(tprv8ZgxMBicQKsPdexample/<0;1>/*))#12345678"),
    ).toThrow(/private spend/i);
  });
});

// descriptorInfo is what the watch-only import validates a pasted descriptor
// with, and #160: what it returns is now what gets PERSISTED. lwk accepts
// spellings it silently normalizes, so storing the paste left the record and
// lwk's own canonical form diverging — and made the dedupe in addHardwareWallet
// compare typing habits rather than wallets.
describe("descriptorInfo canonicalization", () => {
  const CANONICAL =
    "ct(slip77(9c8e4f05c7711a98c838be228bcb84924d4570ca53f35fa1c793e58841d47023),elwpkh([73c5da0a/84'/1'/0']tpubDC8msFGeGuwnKG9Upg7DM2b4DaRqg3CUZa5g8v2SRQ6K4NSkxUgd7HsL2XVWbVm39yBA4LAxysQAm397zwQSQoQgewGiYZqrA9DsP4zbQ1M/<0;1>/*))#2e4n992d";

  it("normalizes the h spelling and adds the missing checksum", async () => {
    // The reachable non-canonical input: `84h` rather than `84'`, no checksum.
    const pasted = CANONICAL.replace(/'/g, "h").replace(/#.*$/, "");
    expect(pasted).not.toBe(CANONICAL);

    const info = (await handle({ kind: "descriptorInfo", descriptor: pasted })) as DescriptorInfo;
    expect(info.canonical).toBe(CANONICAL);
    expect(info.fingerprint).toBe("73c5da0a");
    expect(info.mainnet).toBe(false);
  });

  it("leaves an already-canonical descriptor untouched, so a re-import dedupes", async () => {
    const info = (await handle({ kind: "descriptorInfo", descriptor: CANONICAL })) as DescriptorInfo;
    expect(info.canonical).toBe(CANONICAL);
  });

  it("reads the fingerprint off the canonical form, not the paste", async () => {
    // Uppercase in the paste; both the fingerprint and the stored descriptor
    // have to come from one serialization or they can disagree.
    const pasted = CANONICAL.replace("[73c5da0a/", "[73C5DA0A/").replace(/#.*$/, "");
    const info = (await handle({ kind: "descriptorInfo", descriptor: pasted })) as DescriptorInfo;
    expect(info.fingerprint).toBe("73c5da0a");
    expect(info.canonical).toContain(info.fingerprint);
  });
});
