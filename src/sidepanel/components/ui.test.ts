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
];

describe("splitFigureAndTicker", () => {
  for (const [input, figure, ticker] of CASES) {
    it(`${JSON.stringify(input)} → figure ${JSON.stringify(figure)}, ticker ${JSON.stringify(ticker)}`, () => {
      expect(splitFigureAndTicker(input)).toEqual({ figure, ticker });
    });
  }

  it("never drops or reorders characters", () => {
    for (const [input] of CASES) {
      const { figure, ticker } = splitFigureAndTicker(input);
      // The split may only move the separating whitespace, so rejoining must
      // reproduce the input exactly.
      expect((figure + ticker).replace(/\s+/g, " ")).toBe(input.replace(/\s+/g, " "));
    }
  });

  it("puts a suffixed currency code in the ticker — the known en-US dependency", () => {
    // formatFiat pins en-US so this shape does not occur today. Pinned so that a
    // localization pass sees the consequence rather than discovering it.
    expect(splitFigureAndTicker("1,234.50 CHF")).toEqual({ figure: "1,234.50 ", ticker: "CHF" });
  });
});
