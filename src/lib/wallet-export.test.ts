// Wallet export, driven against a REAL lwk-derived descriptor rather than a
// hand-written fixture. The parsing in wallet-export.ts keys on lwk's exact
// canonical spelling — hardened components as `'`, the key origin in brackets,
// the BIP-389 `<0;1>/*` multipath tail — so a fixture invented from memory would
// pass while the shipped code silently produced an export with no derivation
// path. Deriving live means an lwk format change fails here instead of in a
// user's backup.
//
// The load-bearing assertion in this file is the negative one: the PUBLIC
// descriptor must never contain the master blinding key. That is the difference
// between handing someone an address list and handing them permanent visibility
// into every amount the wallet will ever hold.

import { describe, expect, it } from "vitest";
import { handle } from "@/engine/engine-core";
import type { DerivedWallet } from "@/engine/protocol";
import type { WalletInfo } from "@/keystore/keystore";
import {
  walletExportFields,
  walletExportFilename,
  walletExportText,
  walletsExportFilename,
  walletsExportJson,
} from "./wallet-export";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

async function realWallet(
  overrides: Partial<WalletInfo> = {},
): Promise<{ info: WalletInfo; blindingKey: string }> {
  const derived = (await handle({
    kind: "deriveWallet",
    mnemonic: TEST_MNEMONIC,
    network: "liquidtestnet",
  })) as DerivedWallet;
  const blindingKey = /slip77\(([0-9a-f]{64})\)/.exec(derived.descriptor)![1];
  return {
    info: {
      id: "w1",
      label: "My Wallet",
      network: "liquidtestnet",
      signer: "local",
      descriptor: derived.descriptor,
      fingerprint: derived.fingerprint,
      createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
      ...overrides,
    },
    blindingKey,
  };
}

describe("wallet export fields", () => {
  it("pulls every derived field out of a real lwk descriptor", async () => {
    const { info, blindingKey } = await realWallet();
    const fields = walletExportFields(info);

    // The payload that matters is passed through untouched.
    expect(fields.ctDescriptor).toBe(info.descriptor);
    expect(fields.masterBlindingKey).toBe(blindingKey);
    // lwk spells hardened with an apostrophe; parsing only `h` would drop this.
    expect(fields.derivationPath).toBe("m/84'/1'/0'");
    expect(fields.keyOrigin).toBe(`[${info.fingerprint}/84'/1'/0']`);
    expect(fields.extendedPublicKey).toMatch(/^tpub[A-Za-z0-9]+$/);
    expect(fields.scriptType).toBe("wpkh");
    expect(fields.signerLabel).toBe("Seed stored in Apogee");
    expect(fields.createdAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("projects a public descriptor that cannot see amounts", async () => {
    const { info, blindingKey } = await realWallet();
    const fields = walletExportFields(info);

    expect(fields.publicDescriptor).toMatch(/^elwpkh\(.+\/<0;1>\/\*\)#\w{8}$/);
    // THE assertion. Everything else in this file is convenience.
    expect(fields.publicDescriptor).not.toContain(blindingKey);
    expect(fields.publicDescriptor).not.toContain("slip77");
    expect(fields.publicDescriptor).not.toContain("ct(");
    expect(fields.standardsUsed).toContain("bip-0084");
    expect(fields.publicDescriptorUnavailable).toBeUndefined();
  });

  it("labels each signer kind, so an export says where the keys live", async () => {
    for (const [signer, expected] of [
      ["local", "Seed stored in Apogee"],
      ["jade", "Blockstream Jade hardware signer"],
      ["watch", "Watch-only (imported descriptor)"],
    ] as const) {
      const { info } = await realWallet({ signer });
      expect(walletExportFields(info).signerLabel).toBe(expected);
    }
  });

  it("still exports the descriptor when no public form can be projected", () => {
    // ELIP-151 and friends can be view-capable even with the blinding policy
    // removed, so publicWalletDescriptor fails closed. An export must NOT fail
    // with it: the user still owns this descriptor and may be trying to recover.
    const info: WalletInfo = {
      id: "w2",
      label: "Imported",
      network: "liquid",
      signer: "watch",
      descriptor: "ct(elip151,elwpkh([73c5da0a/84'/1'/0']xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8/<0;1>/*))",
      fingerprint: "73c5da0a",
      createdAt: 0,
    };
    const fields = walletExportFields(info);

    expect(fields.ctDescriptor).toBe(info.descriptor);
    expect(fields.publicDescriptor).toBeUndefined();
    expect(fields.publicDescriptorUnavailable).toMatch(/blinding policy/i);
    // The blinding policy is not SLIP-77, so there is no SLIP-77 key to name.
    expect(fields.masterBlindingKey).toBeUndefined();
    // Derived niceties still work — they do not depend on the projection.
    expect(fields.derivationPath).toBe("m/84'/1'/0'");
  });

  it("survives a descriptor it cannot parse at all", () => {
    const info: WalletInfo = {
      id: "w3",
      label: "Odd",
      network: "liquid",
      signer: "watch",
      descriptor: "not-a-descriptor",
      fingerprint: "00000000",
      createdAt: 0,
    };
    const fields = walletExportFields(info);
    // Fail open, deliberately: the raw descriptor is the recovery payload.
    expect(fields.ctDescriptor).toBe("not-a-descriptor");
    expect(fields.derivationPath).toBeUndefined();
  });
});

describe("wallet export text", () => {
  it("keeps the two descriptor forms visibly distinct", async () => {
    const { info, blindingKey } = await realWallet();
    const text = walletExportText(walletExportFields(info));

    // A reader must be able to tell which line is safe to hand over. The
    // warning rides on the section header, not in a separate paragraph they
    // might not scroll to.
    expect(text).toMatch(/# Watch-only descriptor \(SEES AMOUNTS/);
    expect(text).toMatch(/# Public descriptor \(no amounts; still reveals every address\)/);
    expect(text).toContain(blindingKey);
    expect(text).toContain("Label: My Wallet");
    expect(text).toContain("Keys: Seed stored in Apogee");
    expect(text).toContain("Derivation: m/84'/1'/0'");

    // The blinding key appears only above the public section, never inside it.
    const publicSection = text.slice(text.indexOf("# Public descriptor"));
    expect(publicSection).not.toContain(blindingKey);
  });

  it("says why, when there is no public form to show", () => {
    const text = walletExportText(
      walletExportFields({
        id: "w4",
        label: "Imported",
        network: "liquid",
        signer: "watch",
        descriptor: "ct(elip151,elwpkh([73c5da0a/84'/1'/0']xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8/<0;1>/*))",
        fingerprint: "73c5da0a",
        createdAt: 0,
      }),
    );
    expect(text).toMatch(/# Public descriptor unavailable: .*blinding policy/i);
  });
});

describe("wallet export json", () => {
  it("carries every wallet and states what the payload grants", async () => {
    const { info } = await realWallet();
    const second = { ...info, id: "w2", label: "Jade", signer: "jade" as const };
    const parsed = JSON.parse(walletsExportJson([info, second])) as {
      format: string;
      version: number;
      warning: string;
      wallets: { label: string; signerLabel: string }[];
    };

    expect(parsed.format).toBe("apogee.wallet-export");
    expect(parsed.version).toBe(1);
    // Anyone reading this file back needs to know what it is before they
    // forward it somewhere.
    expect(parsed.warning).toMatch(/master blinding key/i);
    expect(parsed.warning).toMatch(/cannot sign or spend/i);
    expect(parsed.wallets.map((w) => w.label)).toEqual(["My Wallet", "Jade"]);
    expect(parsed.wallets[1].signerLabel).toBe("Blockstream Jade hardware signer");
  });
});

describe("export filenames", () => {
  it("slugs the label and names the network and fingerprint", async () => {
    const { info } = await realWallet({ label: "Daniel's  Main Wallet!! " });
    expect(walletExportFilename(info, "txt")).toBe(
      `apogee-daniel-s-main-wallet-liquidtestnet-${info.fingerprint}.txt`,
    );
  });

  it("falls back to a usable name when the label slugs to nothing", async () => {
    const { info } = await realWallet({ label: "!!!" });
    expect(walletExportFilename(info, "json")).toBe(
      `apogee-wallet-liquidtestnet-${info.fingerprint}.json`,
    );
  });

  it("dates the all-wallets file", () => {
    expect(walletsExportFilename()).toMatch(/^apogee-wallets-\d{4}-\d{2}-\d{2}\.json$/);
  });
});
