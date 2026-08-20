import { describe, expect, it } from "vitest";
import {
  SIMPLICITY_ROULETTE_V1_BUNDLE,
  SIMPLICITY_ROULETTE_V1_CMR,
  SIMPLICITY_ROULETTE_V1_TAPLEAF_HASH,
} from "./builtins/simplicity-roulette-v1";
import { txManifestBundleHash } from "./bundle";
import {
  compileRouletteV1State,
  reverseAssetId,
  rouletteActiveState,
  rouletteOpenState,
  rouletteOutcome,
  roulettePayouts,
  rouletteScriptHash,
  rouletteSecretCommitment,
  rouletteStateWord,
  rouletteTermsHash,
} from "./roulette-v1";
import {
  compile_covenant_json,
  initSync,
} from "./runtime/pkg/apogee_tx_manifest_runtime.js";

const terms = {
  roundId: "11".repeat(32),
  assetId: "22".repeat(32),
  playerPayoutScript: null,
  secretCommitment: "33".repeat(32),
  betKind: 0,
  betSelection: 17,
  stake: "100000",
  bond: "25000",
  openExpiry: 144,
  minRevealAge: 2,
  revealExpiry: 20,
};

describe("roulette v1 covenant codec", () => {
  it("reverses display asset ids only at the Simplicity boundary", () => {
    expect(reverseAssetId(Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, "0")).join("")))
      .toBe(Array.from({ length: 32 }, (_, i) => (31 - i).toString(16).padStart(2, "0")).join(""));
  });

  it("passes one state word and no compile parameters to the pinned source", async () => {
    const state = rouletteOpenState(terms, "44".repeat(32));
    let observed: unknown;
    const result = await compileRouletteV1State(
      SIMPLICITY_ROULETTE_V1_BUNDLE.sources["roulette_v1.simf"],
      state,
      "liquid-testnet",
      async (spec) => {
        observed = spec;
        return { cmr: SIMPLICITY_ROULETTE_V1_CMR, tapleaf_hash: SIMPLICITY_ROULETTE_V1_TAPLEAF_HASH, merkle_root: "", script_pub_key: "", script_hash: "", address: "" };
      },
    );
    expect(result.covenant.cmr).toBe(SIMPLICITY_ROULETTE_V1_CMR);
    expect(observed).toMatchObject({
      arguments: {},
      extra_leaf_payloads: [result.stateWord],
      include_debug_symbols: false,
    });
    expect(result.stateWord).toMatch(/^[0-9a-f]{64}$/);
  });

  it("compiles the canonical vector with the packaged WASM runtime", async () => {
    const nodeProcess = (globalThis as typeof globalThis & {
      process?: { getBuiltinModule?(name: string): unknown };
    }).process;
    const fs = nodeProcess?.getBuiltinModule?.("fs") as {
      readFileSync(path: URL): Uint8Array;
    } | undefined;
    if (!fs) throw new Error("The packaged-runtime vector requires Node.js.");
    initSync({
      module: new Uint8Array(fs.readFileSync(new URL(
        "./runtime/pkg/apogee_tx_manifest_runtime_bg.wasm",
        import.meta.url,
      ))),
    });
    const state = rouletteOpenState({
      ...terms,
      secretCommitment: "cf507d7e0c518cfb4b33a026308d5677e6d982b619f976edbaa452c1665f5577",
    }, "7fe12e4d53b0534ab6ca28b5c19b6d8d4e1b7b8b0b54dfc253354523537b06b8");
    const result = await compileRouletteV1State(
      SIMPLICITY_ROULETTE_V1_BUNDLE.sources["roulette_v1.simf"],
      state,
      "elements-regtest",
      async (spec) => JSON.parse(compile_covenant_json(JSON.stringify(spec))),
    );
    expect(result).toMatchObject({
      stateWord: "315451d79d6191b7947a749c1c687458aed871634d94d6b26e9d2a64eabee770",
      covenant: {
        cmr: SIMPLICITY_ROULETTE_V1_CMR,
        tapleaf_hash: SIMPLICITY_ROULETTE_V1_TAPLEAF_HASH,
        merkle_root: "24a1a4f77ec2ebd4e670f3f0f6632f378b79c2f0fd05bd74bc8a37c493fa4b70",
        script_pub_key: "512087b89a93467ad4e30f429860717acd895b48ad7c3f45e612d91c16994cdff898",
      },
    });
  });

  it("matches the shared contract hashes, state words, outcome, and payout vector", async () => {
    const playerSecret = "55".repeat(32);
    const houseNonce = "66".repeat(32);
    const vectorTerms = {
      ...terms,
      secretCommitment: "cf507d7e0c518cfb4b33a026308d5677e6d982b619f976edbaa452c1665f5577",
    };
    expect(await rouletteTermsHash(vectorTerms)).toBe(
      "24e7612fe88ef48f847f07aa3dc01df9ebec3e484fc96b5706bee9748a39eb82",
    );
    expect(await rouletteSecretCommitment(vectorTerms, playerSecret)).toBe(vectorTerms.secretCommitment);
    const playerHash = await rouletteScriptHash(`0014${"33".repeat(20)}`);
    const houseHash = await rouletteScriptHash(`0014${"44".repeat(20)}`);
    expect(playerHash).toBe("7fe12e4d53b0534ab6ca28b5c19b6d8d4e1b7b8b0b54dfc253354523537b06b8");
    expect(houseHash).toBe("eed5299e54314101bf96cf6629731b49e7725f7f1f21c4766f2802ad4fc72323");
    const open = rouletteOpenState(vectorTerms, playerHash);
    expect(await rouletteStateWord(open)).toBe(
      "315451d79d6191b7947a749c1c687458aed871634d94d6b26e9d2a64eabee770",
    );
    const active = rouletteActiveState(open, houseHash, houseNonce, "3500000");
    expect(await rouletteStateWord(active)).toBe(
      "8a2c9d2bb2a15a2549e22042eecc816a3a389ebfec5d7654bf1723485bc0761e",
    );
    expect(await rouletteOutcome(active, playerSecret)).toBe(7);
    expect(roulettePayouts(active, 7)).toEqual({ playerAmount: "25000", houseAmount: "3600000" });
  });

  it("pins the reviewed CMR and the pragma-stripped compiler input", () => {
    expect(SIMPLICITY_ROULETTE_V1_CMR).toBe(
      "190ac19a69f2e8dc2cc24824e54c895c1d989ba75b7a01fe2a0f04ecb68fde91",
    );
    expect(SIMPLICITY_ROULETTE_V1_BUNDLE.sources["roulette_v1.simf"]).toMatch(/^\/\*/);
    expect(SIMPLICITY_ROULETTE_V1_BUNDLE.sources["roulette_v1.simf"]).not.toContain('simc "0.7.0"');
  });

  it("pins every execution-critical bundle byte", async () => {
    expect(await txManifestBundleHash(SIMPLICITY_ROULETTE_V1_BUNDLE)).toBe(
      "sha256:26f77f6f984ebcdccfb96a626285858fb7bdcb0bfa290ba59f6cee57573c4830",
    );
  });
});
