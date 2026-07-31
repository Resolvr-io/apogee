// Tests for TelemetryNumber's figure/ticker split.
//
// This rule decides which characters render in the telemetry face and which fall
// back to the row's own font, and it fails silently: a misclassification is a
// typography change, not an error, so nothing surfaces until someone looks at a
// screenshot. It has already been rewritten once, and that rewrite regressed
// multi-word labels — which no case had covered. Hence a table.

import { describe, expect, it } from "vitest";
import { splitFigureAndTicker } from "./ui";

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
