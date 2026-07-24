import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { ManifestError, planAction, type RunnerInput } from "./runner";
import type { LwkLike } from "./covenant";

// The `last_will` manifest + source, vendored from the tx-manifest spec's
// examples into this repo so the tests run anywhere (no machine-local paths).
const FIXTURES = new URL("./__fixtures__/last_will/", import.meta.url);
const MANIFEST = readFileSync(new URL("txmanifest.json", FIXTURES), "utf8");
// LF-normalized on read: a Windows checkout may store CRLF, and CRLF vs LF
// changes any source digest for the same logical file.
const SIMF = readFileSync(new URL("last_will.simf", FIXTURES), "utf8").replace(/\r\n/g, "\n");

const KEYS = {
  INHERITOR_PUB_KEY: "e1512ae2f5b4ee8c12e9c57ccd0943273c6256f496516d3aefeaa16c32d3c05b",
  HOT_PUB_KEY: "ff3179af3b3602e99c34cefb745ba403cc111e261c51d8a070bb1ebae29faa08",
  COLD_PUB_KEY: "fdaed399604067b329dbe7a54fb46f399ba201ba394220cca4150ed042ee5615",
};

/**
 * A stand-in for lwk that records what it was asked to compile instead of
 * compiling it. The resolution rules (which value ends up bound to which .simf
 * parameter, and with what type) are what this file is testing; the real
 * derivation is checked separately against pkg_node below.
 */
function stubLwk(): { lwk: LwkLike; seen: Array<{ name: string; type: string; value: string }> } {
  const seen: Array<{ name: string; type: string; value: string }> = [];
  const args = {
    addValue(name: string, v: { type: string; value: string }) {
      seen.push({ name, type: v.type, value: v.value });
      return args;
    },
  };
  const lwk = {
    SimplicityArguments: function () {
      return args;
    },
    SimplicityTypedValue: {
      fromU8: (v: number) => ({ type: "u8", value: String(v) }),
      fromU16: (v: number) => ({ type: "u16", value: String(v) }),
      fromU32: (v: number) => ({ type: "u32", value: String(v) }),
      fromU64: (v: bigint) => ({ type: "u64", value: String(v) }),
      fromBoolean: (v: boolean) => ({ type: "bool", value: String(v) }),
      fromU256Hex: (v: string) => ({ type: "u256", value: v }),
    },
    SimplicityProgram: {
      load: () => ({
        createP2trAddress: () => ({ toString: () => "tex1pSTUB" }),
      }),
      loadWithDebugSymbols: () => ({
        createP2trAddress: () => ({ toString: () => "tex1pSTUB-debug" }),
      }),
    },
    XOnlyPublicKey: { fromString: (s: string) => s },
    Network: { mainnet: () => "mainnet", testnet: () => "testnet", regtestDefault: () => "regtest" },
  } as unknown as LwkLike;
  return { lwk, seen };
}

function fundInput(overrides: Partial<RunnerInput> = {}): RunnerInput {
  return {
    manifestText: MANIFEST,
    action: "Fund",
    sources: { "./last_will.simf": SIMF },
    actionParams: { ...KEYS, amount_sat: "100000" },
    network: "liquidtestnet",
    ...overrides,
  };
}

describe("Fund — the constructor", () => {
  it("computes the instance fields, applying declared defaults", () => {
    const { lwk } = stubLwk();
    const plan = planAction(lwk, fundInput());
    expect(plan.instance).toBeDefined();
    expect(plan.instance!.template).toBe("last_will_contract");
    expect(plan.instance!.fields).toEqual({
      ...KEYS,
      // Not supplied by the caller — comes from the param's `default`. Only the
      // wallet knows it, which is exactly why the instance must be returned.
      INHERIT_BLOCKS: "25920",
    });
  });

  it("binds each .simf compile param to the instance field it names, with the template's type", () => {
    const { lwk, seen } = stubLwk();
    planAction(lwk, fundInput());
    const byName = Object.fromEntries(seen.map((s) => [s.name, s]));
    // pubkeys are u256 hex and are NEVER byte-reversed (only liquid.asset_id is).
    expect(byName.INHERITOR_PUB_KEY).toEqual({
      name: "INHERITOR_PUB_KEY",
      type: "u256",
      value: KEYS.INHERITOR_PUB_KEY,
    });
    expect(byName.COLD_PUB_KEY.value).toBe(KEYS.COLD_PUB_KEY);
    // The type comes from the contract template's `fields`, not from the action
    // param — u16, so it must not arrive as a u64.
    expect(byName.INHERIT_BLOCKS).toEqual({ name: "INHERIT_BLOCKS", type: "u16", value: "25920" });
  });

  it("derives the covenant output address rather than trusting a caller", () => {
    const { lwk } = stubLwk();
    const plan = planAction(lwk, fundInput());
    const will = plan.outputs.find((o) => o.id === "will_out")!;
    expect(will.utxoType).toBe("last_will");
    expect(will.address).toBe("tex1pSTUB");
    expect(will.amountSat).toBe(100000n); // from `params.amount_sat`
  });

  it("marks change as wallet-owned and leaves it to the builder", () => {
    const { lwk } = stubLwk();
    const plan = planAction(lwk, fundInput());
    const change = plan.outputs.find((o) => o.id === "change_out")!;
    expect(change.wallet).toBe("change");
    expect(change.optional).toBe(true);
  });
});

describe("Fund — what it refuses", () => {
  it("rejects a missing required parameter instead of inventing one", () => {
    const { lwk } = stubLwk();
    const params = { ...KEYS, amount_sat: "100000" } as Record<string, string>;
    delete params.COLD_PUB_KEY;
    expect(() => planAction(lwk, fundInput({ actionParams: params }))).toThrow(
      /Missing required parameter "COLD_PUB_KEY"/,
    );
  });

  it("rejects a parameter the manifest never declared", () => {
    const { lwk } = stubLwk();
    expect(() =>
      planAction(lwk, fundInput({ actionParams: { ...KEYS, amount_sat: "1", ohNo: "1" } })),
    ).toThrow(/Unknown parameter "ohNo"/);
  });

  it("rejects a malformed pubkey rather than padding it into a different covenant", () => {
    const { lwk } = stubLwk();
    expect(() =>
      planAction(lwk, fundInput({ actionParams: { ...KEYS, COLD_PUB_KEY: "zz", amount_sat: "1" } })),
    ).toThrow(ManifestError);
  });

  it("enforces the declared type width", () => {
    const { lwk } = stubLwk();
    // INHERIT_BLOCKS is u16; 65536 overflows and must not silently truncate.
    expect(() =>
      planAction(lwk, fundInput({ actionParams: { ...KEYS, amount_sat: "1", INHERIT_BLOCKS: "65536" } })),
    ).toThrow(/overflows u16/);
  });

  it("runs the manifest's own arithmetic validations", () => {
    const { lwk } = stubLwk();
    // Fund declares `params.amount_sat > 0` with message "Amount must be greater than zero".
    expect(() => planAction(lwk, fundInput({ actionParams: { ...KEYS, amount_sat: "0" } }))).toThrow(
      /greater than zero/,
    );
  });

  it("requires the program source — a browser has no filesystem to resolve it from", () => {
    const { lwk } = stubLwk();
    expect(() => planAction(lwk, fundInput({ sources: {} }))).toThrow(/Missing program source/);
  });

  it("refuses a covenant spend that needs a signature — keyless spends only", () => {
    const { lwk } = stubLwk();
    // last_will's spend paths each carry a `Signature` witness (HOT_SIG etc.)
    // alongside the simplicityhl SPEND_PATH. Keyless spends (Tessera's Settle) are
    // supported; a keyed one is refused at the witness check, not half-built.
    const instanceText = JSON.stringify({
      template: "last_will_contract",
      fields: { ...KEYS, INHERIT_BLOCKS: "25920" },
    });
    const providedInputs = {
      will_in: { txid: "00".repeat(32), vout: 0, amount_sat: "100000", asset: "00".repeat(32) },
    };
    for (const action of ["Refresh", "ColdBreak", "Inherit"]) {
      expect(() =>
        planAction(lwk, fundInput({ action, actionParams: {}, instanceText, providedInputs })),
      ).toThrow(/keyless spends only/);
    }
  });

  it("refuses an unknown action", () => {
    const { lwk } = stubLwk();
    expect(() => planAction(lwk, fundInput({ action: "Drain", actionParams: {} }))).toThrow(
      /no action called "Drain"/,
    );
  });

  it("refuses a manifest that isn't JSON", () => {
    const { lwk } = stubLwk();
    expect(() => planAction(lwk, fundInput({ manifestText: "{" }))).toThrow(/isn't valid JSON/);
  });
});

/**
 * `last_will.simf` does not compile here — but THE SOURCE IS FINE. Our toolchain
 * is out of date.
 *
 *   simplicity-lang 0.8.0 (via simplicityhl 0.6.0, git master) — what the
 *     reference CLI and the ApogeeDEX indexer use — HAS
 *     `broken_do_not_use_check_lock_distance`.
 *   simplicity-lang 0.7.0 (via simplicityhl 0.4.1, what our lwk fork pins) has
 *     only the older plain `check_lock_distance`.
 *
 * The jet was renamed TO the alarming name upstream, as a deliberate warning
 * label; we are behind it. The fix is to bump simplicityhl in the lwk fork, not
 * to touch the manifest.
 *
 * The rename below is a LOCAL WORKAROUND ONLY, and a lossy one: it compiles a
 * DIFFERENT PROGRAM, so it yields a different CMR and a different covenant
 * address than every other implementation computes. No address is pinned against
 * it for exactly that reason — a pinned value here would be a number only we
 * agree with, which is the byte-for-byte disagreement that surfaces as a covenant
 * rejection after the user has already approved.
 *
 * Once the fork is bumped: delete this, compile the source unmodified, and pin
 * the address with the CLI as the oracle.
 */
const SIMF_COMPILABLE = SIMF.replace(
  "jet::broken_do_not_use_check_lock_distance",
  "jet::check_lock_distance",
);

describe("covenant derivation against real lwk", () => {
  // pkg_node is the Node build of the same fork the extension bundles. If it
  // isn't built, skip rather than fail — the resolution tests above are the ones
  // that must always run.
  // Held in a variable, not a literal: the specifier is an absolute path outside
  // the project, which tsc can't resolve as a module type.
  const PKG_NODE = "file:///E:/projects/lwk/lwk_wasm/pkg_node/lwk_wasm.js";
  async function loadLwk(): Promise<LwkLike | null> {
    try {
      return (await import(/* @vite-ignore */ PKG_NODE)) as unknown as LwkLike;
    } catch {
      return null;
    }
  }

  it("derives a well-formed testnet covenant address", async () => {
    const lwk = await loadLwk();
    if (!lwk) return;
    const plan = planAction(lwk, fundInput({ sources: { "./last_will.simf": SIMF_COMPILABLE } }));
    const will = plan.outputs.find((o) => o.id === "will_out")!;
    // Shape only — deliberately NOT an exact value. Under the stale toolchain
    // this address is one no other implementation would produce (see above), so
    // pinning it would enshrine a disagreement. Exact-value derivation is checked
    // against the reference CLI's oracle vectors, which aren't part of this repo.
    expect(will.address).toMatch(/^tex1p[0-9a-z]{50,}$/);
  });

  it("moves the address when any instance field changes", async () => {
    const lwk = await loadLwk();
    if (!lwk) return;
    // The load-bearing property: the address is a pure function of the instance.
    // Swap one key and the covenant lands somewhere else — that is what makes a
    // lie about an instance field detectable instead of profitable.
    const base = planAction(lwk, fundInput({ sources: { "./last_will.simf": SIMF_COMPILABLE } }));
    const other = planAction(
      lwk,
      fundInput({
        sources: { "./last_will.simf": SIMF_COMPILABLE },
        actionParams: { ...KEYS, COLD_PUB_KEY: KEYS.HOT_PUB_KEY, amount_sat: "100000" },
      }),
    );
    expect(other.outputs.find((o) => o.id === "will_out")!.address).not.toBe(
      base.outputs.find((o) => o.id === "will_out")!.address,
    );
  });

  it("refuses the source as shipped, naming the stale jet", async () => {
    const lwk = await loadLwk();
    if (!lwk) return;
    // Guards the finding above: if a toolchain bump ever restores the old jet
    // name, this test fails and the workaround above can be dropped.
    expect(() => planAction(lwk, fundInput())).toThrow(/check_lock_distance/);
  });
});
