// SWEL — the txmanifest formula language (Spec §9), evaluated by hand.
//
// A small expression language for output/input amounts, witness/validation exprs,
// and constructor field formulas. The design note (tx_manifest_spec
// meta/memory/swel-formula-language-direction.md) pins semantics so a hand
// evaluator and a SimplicityHL-lowered one stay bit-identical:
//
//   - one numeric type: u64, unsigned, no negatives
//   - overflow / underflow  → error   (matches SimplicityHL panic-on-carry)
//   - division / modulo by zero → error
//   - integer division truncates toward zero (unsigned, so floor)
//   - bool is distinct from int: no coercion either way
//   - && / || are FULL-eval, not short-circuit
//   - division does NOT re-associate: a/b/c == (a/b)/c, evaluated left to right,
//     because folding two flooring divisions changes the result (lending_v3's
//     RepayLoan comment is explicit about this)
//
// References are bare (no `$`): instance.NAME, params.NAME, input_id.amount_sat,
// input_id.asset, input_id.present, output_id.amount_sat, fee. Functions:
// index_of(id), concat(...) — concat is bytes-only (OP_RETURN) and deferred.
//
// Values are u64, bool, or bytes. Only u64 does arithmetic; bytes exist so asset
// refs and concat parse, but they're not needed until lending_v3.

export const MAX_U64 = 2n ** 64n - 1n;

export type SwelValue =
  | { kind: "u64"; value: bigint }
  | { kind: "bool"; value: boolean }
  | { kind: "bytes"; hex: string };

export class SwelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwelError";
  }
}

/**
 * Resolves references and functions the evaluator can't compute itself.
 * The environment owns typing: it returns each reference already typed, so
 * `instance.INHERIT_BLOCKS` comes back u64 and `input_id.asset` comes back bytes.
 */
export interface SwelEnv {
  /** Resolve a dotted reference (e.g. "instance.NAME", "fee", "will_in.amount_sat"). */
  lookup(ref: string): SwelValue;
  /** index_of(id) → transaction index of a named input/output. */
  indexOf?(id: string): bigint;
}

// ---- tokenizer -------------------------------------------------------------

type Tok =
  | { t: "num"; v: bigint }
  | { t: "ref"; v: string } // dotted identifier: instance.NAME, will_in.amount_sat
  | { t: "op"; v: string }
  | { t: "lparen" }
  | { t: "rparen" }
  | { t: "comma" }
  | { t: "eof" };

const MULTI_OPS = ["==", "!=", "<=", ">=", "&&", "||"];
const SINGLE_OPS = new Set(["+", "-", "*", "/", "%", "<", ">", "!"]);

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
  const isIdentPart = (c: string) => /[A-Za-z0-9_.]/.test(c);

  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < src.length && src[j] >= "0" && src[j] <= "9") j++;
      // A dot immediately after digits would be a decimal — SWEL is integer-only.
      if (src[j] === ".") throw new SwelError(`decimals are not allowed: "${src.slice(i, j + 2)}"`);
      toks.push({ t: "num", v: BigInt(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i;
      while (j < src.length && isIdentPart(src[j])) j++;
      toks.push({ t: "ref", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === "(") {
      toks.push({ t: "lparen" });
      i++;
      continue;
    }
    if (c === ")") {
      toks.push({ t: "rparen" });
      i++;
      continue;
    }
    if (c === ",") {
      toks.push({ t: "comma" });
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (MULTI_OPS.includes(two)) {
      toks.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if (SINGLE_OPS.has(c)) {
      toks.push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new SwelError(`unexpected character "${c}" at position ${i}`);
  }
  toks.push({ t: "eof" });
  return toks;
}

// ---- Pratt parser → AST ----------------------------------------------------

type Node =
  | { n: "num"; v: bigint }
  | { n: "ref"; v: string }
  | { n: "call"; name: string; args: Node[] }
  | { n: "unary"; op: string; e: Node }
  | { n: "binary"; op: string; l: Node; r: Node };

// Higher binds tighter. Comparisons are non-associative in effect (they return
// bool, and bool can't feed another comparison), but we give them one level.
const BINDING: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 3,
  "<=": 3,
  ">": 3,
  ">=": 3,
  "+": 4,
  "-": 4,
  "*": 5,
  "/": 5,
  "%": 5,
};

class Parser {
  private pos = 0;
  constructor(private toks: Tok[]) {}

  private peek(): Tok {
    return this.toks[this.pos];
  }
  private next(): Tok {
    return this.toks[this.pos++];
  }

  parse(): Node {
    const node = this.expr(0);
    if (this.peek().t !== "eof") throw new SwelError("unexpected trailing tokens in formula");
    return node;
  }

  private expr(minBp: number): Node {
    let left = this.prefix();
    for (;;) {
      const tok = this.peek();
      if (tok.t !== "op") break;
      const bp = BINDING[tok.v];
      if (bp === undefined || bp < minBp) break;
      this.next();
      // Left-associative: right side must bind strictly tighter to continue.
      const right = this.expr(bp + 1);
      left = { n: "binary", op: tok.v, l: left, r: right };
    }
    return left;
  }

  private prefix(): Node {
    const tok = this.next();
    if (tok.t === "num") return { n: "num", v: tok.v };
    if (tok.t === "op" && tok.v === "!") return { n: "unary", op: "!", e: this.expr(6) };
    if (tok.t === "lparen") {
      const e = this.expr(0);
      if (this.next().t !== "rparen") throw new SwelError("expected )");
      return e;
    }
    if (tok.t === "ref") {
      if (this.peek().t === "lparen") {
        this.next(); // consume (
        const args: Node[] = [];
        if (this.peek().t !== "rparen") {
          for (;;) {
            args.push(this.expr(0));
            const sep = this.next();
            if (sep.t === "rparen") break;
            if (sep.t !== "comma") throw new SwelError("expected , or ) in function call");
          }
        } else {
          this.next(); // consume )
        }
        return { n: "call", name: tok.v, args };
      }
      return { n: "ref", v: tok.v };
    }
    throw new SwelError(`unexpected token in formula: ${JSON.stringify(tok)}`);
  }
}

// ---- evaluator -------------------------------------------------------------

function asU64(v: SwelValue, ctx: string): bigint {
  if (v.kind !== "u64") throw new SwelError(`${ctx}: expected a number, got ${v.kind}`);
  return v.value;
}
function asBool(v: SwelValue, ctx: string): boolean {
  if (v.kind !== "bool") throw new SwelError(`${ctx}: expected a bool, got ${v.kind}`);
  return v.value;
}
function checkU64(n: bigint, op: string): bigint {
  if (n < 0n) throw new SwelError(`${op}: underflow (result is negative; u64 is unsigned)`);
  if (n > MAX_U64) throw new SwelError(`${op}: overflow (result exceeds u64)`);
  return n;
}

function evalNode(node: Node, env: SwelEnv): SwelValue {
  switch (node.n) {
    case "num":
      return { kind: "u64", value: checkU64(node.v, "literal") };
    case "ref":
      return env.lookup(node.v);
    case "call": {
      if (node.name === "index_of") {
        if (!env.indexOf) throw new SwelError("index_of is not available in this context");
        if (node.args.length !== 1 || node.args[0].n !== "ref") {
          throw new SwelError("index_of expects a single input/output id");
        }
        return { kind: "u64", value: checkU64(env.indexOf(node.args[0].v), "index_of") };
      }
      if (node.name === "concat") {
        // Bytes-only, OP_RETURN — lending_v3 territory, not needed for the PoC.
        throw new SwelError("concat is not implemented yet");
      }
      throw new SwelError(`unknown function: ${node.name}`);
    }
    case "unary": {
      // Only `!` — SWEL has no unary minus (no negatives).
      return { kind: "bool", value: !asBool(evalNode(node.e, env), "!") };
    }
    case "binary":
      return evalBinary(node, env);
  }
}

function evalBinary(node: Node & { n: "binary" }, env: SwelEnv): SwelValue {
  const { op } = node;
  // Full-eval both sides: no short-circuit, so a divide-by-zero on the dead
  // branch of an && still errors, keeping the hand path and a lowered path aligned.
  const l = evalNode(node.l, env);
  const r = evalNode(node.r, env);

  switch (op) {
    case "+":
      return { kind: "u64", value: checkU64(asU64(l, "+") + asU64(r, "+"), "+") };
    case "-":
      return { kind: "u64", value: checkU64(asU64(l, "-") - asU64(r, "-"), "-") };
    case "*":
      return { kind: "u64", value: checkU64(asU64(l, "*") * asU64(r, "*"), "*") };
    case "/": {
      const d = asU64(r, "/");
      if (d === 0n) throw new SwelError("division by zero");
      return { kind: "u64", value: asU64(l, "/") / d }; // truncates; always in range
    }
    case "%": {
      const d = asU64(r, "%");
      if (d === 0n) throw new SwelError("modulo by zero");
      return { kind: "u64", value: asU64(l, "%") % d };
    }
    case "==":
    case "!=": {
      // Equality is same-type only — comparing u64 to bool is an authoring error.
      if (l.kind !== r.kind) throw new SwelError(`${op}: type mismatch (${l.kind} vs ${r.kind})`);
      const eq = l.kind === "bytes" && r.kind === "bytes" ? l.hex === r.hex : valuesEqual(l, r);
      return { kind: "bool", value: op === "==" ? eq : !eq };
    }
    case "<":
      return { kind: "bool", value: asU64(l, "<") < asU64(r, "<") };
    case "<=":
      return { kind: "bool", value: asU64(l, "<=") <= asU64(r, "<=") };
    case ">":
      return { kind: "bool", value: asU64(l, ">") > asU64(r, ">") };
    case ">=":
      return { kind: "bool", value: asU64(l, ">=") >= asU64(r, ">=") };
    case "&&":
      return { kind: "bool", value: asBool(l, "&&") && asBool(r, "&&") };
    case "||":
      return { kind: "bool", value: asBool(l, "||") || asBool(r, "||") };
    default:
      throw new SwelError(`unknown operator: ${op}`);
  }
}

function valuesEqual(l: SwelValue, r: SwelValue): boolean {
  if (l.kind === "u64" && r.kind === "u64") return l.value === r.value;
  if (l.kind === "bool" && r.kind === "bool") return l.value === r.value;
  return false;
}

// ---- public API ------------------------------------------------------------

/** Parse + evaluate a formula against an environment. Throws SwelError on any fault. */
export function evalFormula(src: string, env: SwelEnv): SwelValue {
  const ast = new Parser(tokenize(src)).parse();
  return evalNode(ast, env);
}

/** Convenience: evaluate and require a u64 result. */
export function evalU64(src: string, env: SwelEnv): bigint {
  const v = evalFormula(src, env);
  if (v.kind !== "u64") throw new SwelError(`expected a number result, got ${v.kind}`);
  return v.value;
}

/** Convenience: evaluate and require a bool result. */
export function evalBool(src: string, env: SwelEnv): boolean {
  const v = evalFormula(src, env);
  if (v.kind !== "bool") throw new SwelError(`expected a bool result, got ${v.kind}`);
  return v.value;
}

/** Build a plain-record environment. Values may be bigint (u64), boolean, or {hex}. */
export function recordEnv(
  vars: Record<string, bigint | boolean | { hex: string }>,
  indexOf?: (id: string) => bigint,
): SwelEnv {
  return {
    lookup(ref) {
      if (!(ref in vars)) throw new SwelError(`unknown reference: ${ref}`);
      const v = vars[ref];
      if (typeof v === "bigint") return { kind: "u64", value: v };
      if (typeof v === "boolean") return { kind: "bool", value: v };
      return { kind: "bytes", hex: v.hex };
    },
    indexOf,
  };
}
