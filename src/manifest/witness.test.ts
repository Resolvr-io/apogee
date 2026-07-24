import { describe, it, expect } from "vitest";
import { buildValue, buildWitnessValues, WitnessError, type WitnessLwk } from "./witness";

/**
 * A recording stub for the lwk value constructors. The parser logic — which type
 * gets built for the opposite Either branch, which value constructor is called
 * with what — is what these tests pin. The real encoding is smoke-tested against
 * pkg_node at the bottom.
 */
function stubLwk(): { lwk: WitnessLwk; added: Array<{ name: string; value: unknown }> } {
  const added: Array<{ name: string; value: unknown }> = [];
  const SimplicityType = {
    u1: () => ({ t: "u1" }),
    u8: () => ({ t: "u8" }),
    u16: () => ({ t: "u16" }),
    u32: () => ({ t: "u32" }),
    u64: () => ({ t: "u64" }),
    u128: () => ({ t: "u128" }),
    u256: () => ({ t: "u256" }),
    boolean: () => ({ t: "bool" }),
    either: (l: unknown, r: unknown) => ({ t: "either", l, r }),
    option: (i: unknown) => ({ t: "option", i }),
  };
  const SimplicityTypedValue = {
    fromU8: (v: number) => ({ vt: "u8", val: v }),
    fromU16: (v: number) => ({ vt: "u16", val: v }),
    fromU32: (v: number) => ({ vt: "u32", val: v }),
    fromU64: (v: bigint) => ({ vt: "u64", val: v }),
    fromBoolean: (v: boolean) => ({ vt: "bool", val: v }),
    left: (val: unknown, rt: unknown) => ({ vt: "left", val, rt }),
    right: (lt: unknown, val: unknown) => ({ vt: "right", lt, val }),
    none: (it: unknown) => ({ vt: "none", it }),
    some: (val: unknown) => ({ vt: "some", val }),
    parse: (s: string, ty: unknown) => ({ vt: "parse", s, ty }),
  };
  function SimplicityWitnessValues(this: unknown) {
    const self = {
      addValue(name: string, value: unknown) {
        added.push({ name, value });
        return self;
      },
    };
    return self;
  }
  const lwk = { SimplicityType, SimplicityTypedValue, SimplicityWitnessValues } as unknown as WitnessLwk;
  return { lwk, added };
}

describe("witness value builder — parser", () => {
  it("builds Tessera's PATH = Left(0) over Either<u32, u32>", () => {
    const { lwk } = stubLwk();
    // Left(0): the value is a u32(0) on the LEFT, and .left needs the RIGHT type.
    expect(buildValue(lwk, "Either<u32, u32>", "Left(0)")).toEqual({
      vt: "left",
      val: { vt: "u32", val: 0 },
      rt: { t: "u32" },
    });
  });

  it("builds a Right branch, supplying the LEFT type", () => {
    const { lwk } = stubLwk();
    expect(buildValue(lwk, "Either<u32, u64>", "Right(5)")).toEqual({
      vt: "right",
      lt: { t: "u32" },
      val: { vt: "u64", val: 5n },
    });
  });

  it("handles Option Some/None", () => {
    const { lwk } = stubLwk();
    expect(buildValue(lwk, "Option<u64>", "None")).toEqual({ vt: "none", it: { t: "u64" } });
    expect(buildValue(lwk, "Option<u64>", "Some(7)")).toEqual({ vt: "some", val: { vt: "u64", val: 7n } });
  });

  it("accepts decimal and 0x-hex integers", () => {
    const { lwk } = stubLwk();
    expect(buildValue(lwk, "u32", "255")).toEqual({ vt: "u32", val: 255 });
    expect(buildValue(lwk, "u32", "0xff")).toEqual({ vt: "u32", val: 255 });
  });

  it("builds bool", () => {
    const { lwk } = stubLwk();
    expect(buildValue(lwk, "bool", "true")).toEqual({ vt: "bool", val: true });
  });

  it("rejects an out-of-range integer", () => {
    const { lwk } = stubLwk();
    expect(() => buildValue(lwk, "u8", "256")).toThrow(WitnessError);
  });

  it("rejects a value that doesn't match its Either type", () => {
    const { lwk } = stubLwk();
    expect(() => buildValue(lwk, "Either<u32, u32>", "Nope(0)")).toThrow(/Left\(\.\.\)\/Right/);
  });

  it("rejects an unsupported type (e.g. a signature blob)", () => {
    const { lwk } = stubLwk();
    expect(() => buildValue(lwk, "Signature", "0xdead")).toThrow(WitnessError);
  });

  it("adds witnesses in declaration order", () => {
    const { lwk, added } = stubLwk();
    buildWitnessValues(lwk, [
      { name: "PATH", simplicityType: "Either<u32, u32>", value: "Left(0)" },
      { name: "AUX", simplicityType: "u64", value: "9" },
    ]);
    expect(added.map((a) => a.name)).toEqual(["PATH", "AUX"]);
  });
});

describe("witness value builder — against real lwk", () => {
  const PKG_NODE = "file:///E:/projects/lwk/lwk_wasm/pkg_node/lwk_wasm.js";
  async function loadLwk(): Promise<WitnessLwk | null> {
    try {
      return (await import(/* @vite-ignore */ PKG_NODE)) as unknown as WitnessLwk;
    } catch {
      return null;
    }
  }

  it("constructs the real PATH witness without throwing", async () => {
    const lwk = await loadLwk();
    if (!lwk) return;
    // Smoke: the exact type/value Tessera's Settle declares must build against the
    // same lwk the engine finalizes with. A bad type string throws here rather
    // than at finalize time on testnet.
    const wv = buildWitnessValues(lwk, [
      { name: "PATH", simplicityType: "Either<u32, u32>", value: "Left(0)" },
    ]);
    expect(wv).toBeTruthy();
  });
});
