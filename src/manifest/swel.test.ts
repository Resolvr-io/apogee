import { describe, it, expect } from "vitest";
import { evalFormula, evalU64, evalBool, recordEnv, MAX_U64, SwelError } from "./swel";

const empty = recordEnv({});

describe("SWEL arithmetic", () => {
  it("evaluates basic integer arithmetic", () => {
    expect(evalU64("1 + 2", empty)).toBe(3n);
    expect(evalU64("10 - 4", empty)).toBe(6n);
    expect(evalU64("6 * 7", empty)).toBe(42n);
    expect(evalU64("20 / 3", empty)).toBe(6n); // truncates
    expect(evalU64("20 % 3", empty)).toBe(2n);
  });

  it("respects precedence and parentheses", () => {
    expect(evalU64("2 + 3 * 4", empty)).toBe(14n);
    expect(evalU64("(2 + 3) * 4", empty)).toBe(20n);
    expect(evalU64("100 / 10 / 2", empty)).toBe(5n); // left-assoc: (100/10)/2
  });

  it("division does NOT re-associate — the lending_v3 rounding trap", () => {
    // (1000 * 100 / 10000) * 1000 / 10000 evaluated left-to-right.
    // Folding the divisions would round differently at other magnitudes; this is
    // the exact shape of lending_v3's RepayLoan TOTAL_PROTOCOL_FEE formula.
    // 1000*100 = 100000; /10000 = 10; *1000 = 10000; /10000 = 1.
    expect(evalU64("1000 * 100 / 10000 * 1000 / 10000", empty)).toBe(1n);
  });
});

describe("SWEL u64 bounds", () => {
  it("errors on underflow (unsigned)", () => {
    expect(() => evalU64("3 - 5", empty)).toThrow(SwelError);
    expect(() => evalU64("0 - 1", empty)).toThrow(/underflow/);
  });

  it("errors on overflow", () => {
    expect(evalU64(`${MAX_U64}`, empty)).toBe(MAX_U64);
    expect(() => evalU64(`${MAX_U64} + 1`, empty)).toThrow(/overflow/);
    expect(() => evalU64(`${MAX_U64} * 2`, empty)).toThrow(/overflow/);
  });

  it("errors on division and modulo by zero", () => {
    expect(() => evalU64("1 / 0", empty)).toThrow(/division by zero/);
    expect(() => evalU64("1 % 0", empty)).toThrow(/modulo by zero/);
  });

  it("rejects decimals", () => {
    expect(() => evalFormula("1.5", empty)).toThrow(/decimal/);
  });
});

describe("SWEL comparisons and booleans", () => {
  it("compares integers", () => {
    expect(evalBool("5 > 3", empty)).toBe(true);
    expect(evalBool("5 < 3", empty)).toBe(false);
    expect(evalBool("5 >= 5", empty)).toBe(true);
    expect(evalBool("5 <= 4", empty)).toBe(false);
    expect(evalBool("5 == 5", empty)).toBe(true);
    expect(evalBool("5 != 5", empty)).toBe(false);
  });

  it("evaluates boolean logic", () => {
    expect(evalBool("5 > 3 && 2 < 4", empty)).toBe(true);
    expect(evalBool("5 > 3 || 2 > 4", empty)).toBe(true);
    expect(evalBool("!(5 > 3)", empty)).toBe(false);
  });

  it("does NOT short-circuit — a dead-branch error still throws", () => {
    // Right side of && divides by zero. Full-eval means it errors even though
    // the left is false; this keeps the hand path aligned with a lowered one.
    expect(() => evalBool("false_ref && (1 / 0 == 0)", recordEnv({ false_ref: false }))).toThrow(
      /division by zero/,
    );
  });

  it("keeps bool distinct from int — no coercion", () => {
    expect(() => evalU64("5 + (3 > 2)", empty)).toThrow(/expected a number/);
    expect(() => evalBool("5 && 3", empty)).toThrow(/expected a bool/);
    expect(() => evalFormula("5 == (3 > 2)", empty)).toThrow(/type mismatch/);
  });
});

describe("SWEL references", () => {
  it("resolves bare dotted references", () => {
    const env = recordEnv({
      "instance.PRINCIPAL_AMOUNT": 1000n,
      "instance.INTEREST_RATE": 100n,
      "will_in.amount_sat": 100000n,
      fee: 195n,
    });
    expect(evalU64("instance.PRINCIPAL_AMOUNT", env)).toBe(1000n);
    expect(evalU64("will_in.amount_sat - fee", env)).toBe(99805n); // last_will Refresh
    expect(evalBool("instance.PRINCIPAL_AMOUNT > 0", env)).toBe(true);
  });

  it("reproduces lending_v3 RepayLoan formulas", () => {
    const env = recordEnv({
      "instance.PRINCIPAL_AMOUNT": 1000n,
      "instance.PRINCIPAL_INTEREST_RATE": 100n,
      "instance.CURRENT_DEBT": 1010n,
    });
    // TOTAL_PROTOCOL_FEE
    expect(
      evalU64(
        "instance.PRINCIPAL_AMOUNT * instance.PRINCIPAL_INTEREST_RATE / 10000 * 1000 / 10000",
        env,
      ),
    ).toBe(1n);
    // LENDER_VAULT_AMOUNT = CURRENT_DEBT - TOTAL_PROTOCOL_FEE
    expect(
      evalU64(
        "instance.CURRENT_DEBT - instance.PRINCIPAL_AMOUNT * instance.PRINCIPAL_INTEREST_RATE / 10000 * 1000 / 10000",
        env,
      ),
    ).toBe(1009n);
  });

  it("errors on an unknown reference", () => {
    expect(() => evalU64("instance.NOPE", empty)).toThrow(/unknown reference/);
  });

  it("compares asset-id bytes by hex", () => {
    const env = recordEnv({
      "a.asset": { hex: "aabb" },
      "b.asset": { hex: "aabb" },
      "c.asset": { hex: "ccdd" },
    });
    expect(evalBool("a.asset == b.asset", env)).toBe(true);
    expect(evalBool("a.asset == c.asset", env)).toBe(false);
    expect(evalBool("a.asset != c.asset", env)).toBe(true);
  });
});

describe("SWEL functions", () => {
  it("evaluates index_of via the environment", () => {
    const env = recordEnv({}, (id) => (id === "will_out" ? 0n : 1n));
    expect(evalU64("index_of(will_out)", env)).toBe(0n);
    expect(evalU64("index_of(fee_out)", env)).toBe(1n);
  });

  it("errors on index_of when unavailable", () => {
    expect(() => evalU64("index_of(x)", empty)).toThrow(/not available/);
  });

  it("concat is not implemented yet", () => {
    expect(() => evalFormula("concat(a, b)", empty)).toThrow(/not implemented/);
  });
});

describe("SWEL parse errors", () => {
  it("rejects malformed input", () => {
    expect(() => evalFormula("1 +", empty)).toThrow(SwelError);
    expect(() => evalFormula("(1 + 2", empty)).toThrow(/expected \)/);
    expect(() => evalFormula("1 2", empty)).toThrow(/trailing/);
    expect(() => evalFormula("@", empty)).toThrow(/unexpected character/);
  });
});
