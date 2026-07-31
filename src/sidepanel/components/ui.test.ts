// Tests for TelemetryNumber's two classifiers: the figure/ticker split, and which
// letter runs inside the figure count as a currency prefix.
//
// Both decide which characters render in the telemetry face, and both fail
// silently: a misclassification is a typography change, not an error, so nothing
// surfaces until someone looks at a screenshot. Each has already been rewritten
// once — the split's rewrite regressed multi-word labels, which no case covered.
// Hence tables rather than spot checks.

import { describe, expect, it } from "vitest";
import { figureSegments, splitFigureAndTicker } from "./ui";

/** Compact view of figureSegments: the text of each run marked as prefix. */
function prefixRuns(figure: string): string[] {
  return figureSegments(figure)
    .filter((s) => s.prefix)
    .map((s) => s.text);
}

/** [input, expected figure, expected ticker] */
const CASES: Array<[string, string, string]> = [
  // --- the ordinary shapes: one-word ticker after the figure ---
  ["+20.00 USDt", "+20.00 ", "USDt"],
  ["+1,000 sats", "+1,000 ", "sats"],
  ["0.001 LBTC", "0.001 ", "LBTC"],
  ["1,234 sats", "1,234 ", "sats"],
  ["≈ 143 sats", "≈ 143 ", "sats"],

  // --- multi-word labels. `label` falls back to the registry's `info.name`
  //     ("Tether USD"), and Swap builds "<label> base units" when an asset has no
  //     known precision. Anchoring on the last whitespace split these, leaving
  //     every word but the last inside the telemetry span. ---
  ["1,234 Tether USD", "1,234 ", "Tether USD"],
  ["1,234 USDT base units", "1,234 ", "USDT base units"],

  // --- an unregistered asset's shortened id must stay WHOLE in the figure. The
  //     ellipsis is what disqualifies it, so both a digit-leading and a
  //     letter-leading id are covered. ---
  ["+150.00 1a2b…c3d4", "+150.00 1a2b…c3d4", ""],
  ["+150.00 f00d…beef", "+150.00 f00d…beef", ""],

  // --- currency prefixes belong to the figure, where .telemetry-unit's size and
  //     baseline are tuned against the telemetry $ ---
  ["CHF 1,234.50", "CHF 1,234.50", ""],
  ["A$1,234", "A$1,234", ""],
  ["A$1,234.50", "A$1,234.50", ""],

  // --- no ticker at all ---
  ["50.00", "50.00", ""],
  ["1", "1", ""],

  // --- strings with no digits are not amounts. Swap guards these before they
  //     reach the component, but the rule must not invent a ticker from them. ---
  ["Fetching...", "Fetching...", ""],
  ["—", "—", ""],
  ["", "", ""],

  // --- a trailing number is part of the figure, never a ticker ---
  ["Token 2049", "Token 2049", ""],

  // --- the boundary: a label carrying punctuation falls out of the ticker path
  //     entirely and stays wholly in the figure. Registry names do this routinely
  //     (`info.ticker ?? info.name`), so these are reachable, not hypothetical.
  //     Recorded because it is a limitation of the rule, not because it is right. ---
  ["1,234 USDC.e", "1,234 USDC.e", ""],
  ["1,234 L-BTC", "1,234 L-BTC", ""],
  ["1,234 Tether USD (Wormhole)", "1,234 Tether USD (Wormhole)", ""],

  // --- a trailing space loses the ticker path. Nothing emits this today; pinned
  //     so a stray template-literal space is a test failure, not a silent
  //     typography change. ---
  ["1,234 sats ", "1,234 sats ", ""],
];

describe("splitFigureAndTicker", () => {
  for (const [input, figure, ticker] of CASES) {
    it(`${JSON.stringify(input)} → figure ${JSON.stringify(figure)}, ticker ${JSON.stringify(ticker)}`, () => {
      expect(splitFigureAndTicker(input)).toEqual({ figure, ticker });
    });
  }

  it("never drops or reorders characters, over inputs outside the table", () => {
    // The per-case assertions above already pin figure and ticker exactly, so an
    // invariant over CASES could only catch a self-inconsistent row. Run it over
    // generated shapes instead, where it can actually find something. Compared
    // exactly — no whitespace normalizing — so a lost or duplicated space fails.
    const figures = ["1", "50.00", "+1,234", "-0.00000001", "≈ 143", "A$9", "CHF 1,0"];
    const tails = ["", " sats", " USDt", " LBTC", " Tether USD", " a1b2", " USDC.e", "  sats"];
    for (const f of figures) {
      for (const t of tails) {
        const input = f + t;
        const { figure, ticker } = splitFigureAndTicker(input);
        expect(figure + ticker).toBe(input);
      }
    }
  });

  it("keeps a two-leg string's second figure out of the ticker", () => {
    // Why the Swap success line renders two TelemetryNumbers rather than one over
    // the whole "A → B" string (Swap.tsx). One call splits at the LAST valid tail,
    // so the receive leg's own figures — and the send leg's ticker — end up inside
    // the telemetry span. Pinned so nobody collapses it back into one call.
    expect(splitFigureAndTicker("0.94 USDt → 1,550 sats")).toEqual({
      figure: "0.94 USDt → 1,550 ",
      ticker: "sats",
    });
  });

  it("puts a suffixed currency code in the ticker — the known en-US dependency", () => {
    // formatFiat pins en-US so this shape does not occur today. Pinned so that a
    // localization pass sees the consequence rather than discovering it.
    expect(splitFigureAndTicker("1,234.50 CHF")).toEqual({ figure: "1,234.50 ", ticker: "CHF" });
  });
});

describe("figureSegments", () => {
  it("marks a currency prefix — the one case .telemetry-unit's geometry is for", () => {
    expect(prefixRuns("CHF 1,234.50")).toEqual(["CHF"]);
    expect(prefixRuns("A$1,234")).toEqual(["A"]);
  });

  it("does not mark letters that follow digits", () => {
    // A shortened asset id kept in the figure. Shrinking and raising these would
    // spell one token out in two sizes, so they must render at full size.
    expect(prefixRuns("+150.00 1a2b…c3d4")).toEqual([]);
    expect(prefixRuns("1,234 USDC.e")).toEqual([]);
    expect(prefixRuns("1,234 L-BTC")).toEqual([]);
  });

  it("marks nothing when the figure is all digits", () => {
    expect(prefixRuns("1,234 ")).toEqual([]);
    expect(prefixRuns("50.00")).toEqual([]);
  });

  it("marks a LEADING letter run — which is what three guards elsewhere rely on", () => {
    // None of these reaches TelemetryNumber today, and that is the point: each is
    // held back by a guard whose rationale is this behavior. Amounts lead with
    // digits; Swap keeps placeholders out of the component; the version string is
    // passed as `console`, not `amount`. Pinned so that if this rule ever changes,
    // the guards' reasoning stops being silently load-bearing.
    expect(prefixRuns("Token 2049")).toEqual(["Token"]);
    expect(prefixRuns("Fetching...")).toEqual(["Fetching"]);
    expect(prefixRuns("v0.6.0")).toEqual(["v"]);
  });

  it("reconstructs the figure exactly from its runs", () => {
    for (const figure of ["CHF 1,234.50", "A$1,234", "+150.00 1a2b…c3d4", "1,234 ", "", "v0.6.0"]) {
      expect(figureSegments(figure).map((s) => s.text).join("")).toBe(figure);
    }
  });
});
