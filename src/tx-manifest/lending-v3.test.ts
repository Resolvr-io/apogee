import { describe, expect, it } from "vitest";
import {
  compileLendingV3AcceptOfferCovenants,
  type LendingV3Instance,
} from "./lending-v3";
import type {
  TxManifestCovenantCommitments,
  TxManifestCovenantCompileSpec,
} from "./runtime";

const INSTANCE: LendingV3Instance = {
  COLLATERAL_ASSET_ID: "144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49",
  PRINCIPAL_ASSET_ID: "38fca2d939696061a8f76d4e6b5eecd54e3b4221c846f24a6b279e79952850a5",
  BORROWER_NFT_ASSET_ID: "8734a76badb98fd22150ec9a537684dd3824c30d80b2bcc1f4b0ff635fa8d97c",
  LENDER_NFT_ASSET_ID: "99396282d5ef54a51a1d9ceebd20710b6eb9a47055b275db4e8d1a7334c14502",
  PROTOCOL_FEE_KEEPER_ASSET_ID:
    "38fca2d939696061a8f76d4e6b5eecd54e3b4221c846f24a6b279e79952850a5",
  COLLATERAL_AMOUNT: "1000",
  PRINCIPAL_AMOUNT: "100",
  PRINCIPAL_INTEREST_RATE: "10000",
  LOAN_EXPIRATION_TIME: "2604140",
};

describe("lending-v3 covenant compilation plan", () => {
  it("builds the nested AcceptOffer commitments in dependency order", async () => {
    const calls: TxManifestCovenantCompileSpec[] = [];
    const compile = async (
      spec: TxManifestCovenantCompileSpec,
    ): Promise<TxManifestCovenantCommitments> => {
      calls.push(structuredClone(spec));
      const hash = calls.length.toString(16).padStart(64, "0");
      return {
        cmr: hash,
        tapleaf_hash: hash,
        merkle_root: hash,
        script_pub_key: `5120${hash}`,
        script_hash: hash,
        address: `address-${calls.length}`,
      };
    };

    const result = await compileLendingV3AcceptOfferCovenants(INSTANCE, compile);
    expect(calls).toHaveLength(8);
    expect(result.currentDebt).toBe("200");
    expect(calls[1].arguments.FINALIZED_VAULT_COV_HASH.value).toBe(`0x${"1".padStart(64, "0")}`);
    expect(calls[3].arguments.FINALIZED_VAULT_COV_HASH.value).toBe(`0x${"3".padStart(64, "0")}`);
    expect(calls[5].arguments.PRINCIPAL_OUTPUT_SCRIPT_HASH.value).toBe(
      `0x${"5".padStart(64, "0")}`,
    );
    expect(calls[5].arguments.COLLATERAL_ASSET_ID.value).toBe(
      "0x499a818545f6bae39fc03b637f2a4e1e64e590cac1bc3a6f6d71aa4443654c14",
    );
    expect(calls[5].extra_leaf_payloads).toEqual([
      "00".repeat(32),
      `${"00".repeat(24)}00000000000000c8`,
    ]);
    expect(calls[6].extra_leaf_payloads[0]).toBe(`${"00".repeat(31)}01`);
    expect(calls[7].arguments.SCRIPT_HASH.value).toBe(`0x${"6".padStart(64, "0")}`);
  });

  it("rejects malformed instance fields before compiling", async () => {
    const malformed = { ...INSTANCE, PRINCIPAL_AMOUNT: "01" };
    await expect(
      compileLendingV3AcceptOfferCovenants(malformed, async () => {
        throw new Error("must not compile");
      }),
    ).rejects.toThrow(/PRINCIPAL_AMOUNT/);
  });
});
