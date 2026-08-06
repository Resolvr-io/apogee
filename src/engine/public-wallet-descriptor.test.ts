import { describe, expect, it } from "vitest";
import { handle } from "./engine-core";
import type { DerivedWallet, PublicWalletDescriptorDTO } from "./protocol";
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
