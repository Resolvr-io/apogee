import { describe, expect, it } from "vitest";
import { handle } from "./engine-core";
import type { WalletIdentity } from "./protocol";

const ELIP_152_LIQUID_DESCRIPTOR =
  "ct(3e129856c574c66d94023ac98b7f69aca9774d10aee4dc087f0c52a498687189," +
  "elwpkh([73c5da0a/84h/1776h/0h]xpub6CRFzUgHFDaiDAQFNX7VeV9JNPDRabq6NYSpzVZ8zW8ANUCiDdenkb1gBoEZuXNZb3wPc1SVcDXgD2ww5UBtTb8s8ArAbTkoRQ8qn34KgcY/0/*))";

describe("walletIdentity", () => {
  it("derives the ELIP-0144 account components using the ELIP-0152 vector", async () => {
    const identity = (await handle({
      kind: "walletIdentity",
      descriptor: ELIP_152_LIQUID_DESCRIPTOR,
      network: "liquid",
    })) as WalletIdentity;

    expect(identity).toEqual({
      dwid: "b781-7bc7-db64-c3de-3937-7eb7-c9ab-f799",
      chainId: "bip122:1466275836220db2944ca059a3a10ef6",
      policyAssetId:
        "bip122:1466275836220db2944ca059a3a10ef6/elip144:6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d",
    });
  });
});
