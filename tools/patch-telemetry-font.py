#!/usr/bin/env python3
"""Build the Apogee Telemetry fonts from Routed Gothic.

Routed Gothic (SIL OFL 1.1, Darren Embry, https://webonastick.com/fonts/routed-gothic/)
ships two defects that matter to the wallet's telemetry numerals:

- yen (U+00A5) is a composite of 'Y' + 'equal' with two problems: its STORED
  bounding box is far smaller than the union of its components (x 96-560
  y 48-688 vs the true x 48-608 y 0-736), and macOS Chrome clips composite
  glyphs to the stored box — the sign rendered with its arms, top, and stem
  tip cut off. And the design itself overlays the full equals sign centered
  on the math axis, riding the top bar up onto the Y's arms, which reads
  distorted. Fix: rebuild as the Y outline plus two proper yen bars
  straddling the stem below the junction (the Y's junction spans y 368-463).
- euro (U+20AC) does not exist. Fix: compose it from the font's own 'C' plus
  two stadium-shaped bars (round caps, the face's stroke thickness) at
  standard euro positions, protruding left of the C in the usual way.

The OFL reserves the name "Routed Gothic" for the original, so the patched
family is renamed "Apogee Telemetry" (see the license file kept alongside the
fonts). Everything else in the font is untouched.

Usage:
    python3 patch-telemetry-font.py <in.ttf> <out.ttf> <family name>

e.g.
    python3 patch-telemetry-font.py RoutedGothic.ttf ApogeeTelemetry.ttf "Apogee Telemetry"
    python3 patch-telemetry-font.py RoutedGothicWide.ttf ApogeeTelemetryWide.ttf "Apogee Telemetry Wide"

Requires fontTools (pip install fonttools).
"""

import sys

from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont


def draw_stadium(pen, x0, x1, cy, r):
    """A horizontal bar from x0..x1 (centerline ends) with semicircular caps,
    matching the face's routed round-terminal strokes. Wound CLOCKWISE (y-up)
    to match the font's outer contours — TrueType fills by non-zero winding,
    so an opposite-wound bar would knock a hole out of the C where they
    cross instead of overlapping solidly."""
    pen.moveTo((x0, cy + r))
    pen.lineTo((x1, cy + r))
    # right cap: two quadratic quarter-arcs through (x1 + r, cy)
    pen.qCurveTo((x1 + r, cy + r), (x1 + r, cy - r), (x1, cy - r))
    pen.lineTo((x0, cy - r))
    # left cap
    pen.qCurveTo((x0 - r, cy - r), (x0 - r, cy + r), (x0, cy + r))
    pen.closePath()


def main(src, dst, family):
    font = TTFont(src)
    glyf = font["glyf"]
    hmtx = font["hmtx"]

    # Bar thickness matches the equal sign's bars (the face's own bar stroke);
    # x coordinates scale by the width variant's proportion (1.0 regular,
    # 1.25 wide — both the C and Y advances carry the same ratio).
    eq = glyf["equal"]
    coords, endpts, _flags = eq.getCoordinates(glyf)
    ys = [y for _, y in coords[: endpts[0] + 1]]
    bar_r = (max(ys) - min(ys)) // 2
    c_adv, _ = hmtx["C"]
    scale = c_adv / 684  # regular C advance; wide scales x by 855/684

    glyph_set = font.getGlyphSet()

    # --- yen: the Y + two proper yen bars ------------------------------------
    # Bars 120 apart (same rhythm as the euro's), both below the Y's junction,
    # crossing the stem and floating symmetrically past it.
    rpen = DecomposingRecordingPen(glyph_set)
    glyph_set["Y"].draw(rpen)
    pen = TTGlyphPen(None)
    rpen.replay(pen)
    for cy in (190, 310):
        draw_stadium(pen, round(184 * scale), round(472 * scale), cy, bar_r)
    glyf["yen"] = pen.glyph()
    glyf["yen"].recalcBounds(glyf)
    adv, _ = hmtx["yen"]
    hmtx["yen"] = (adv, glyf["yen"].xMin)

    # --- euro: the font's C + two euro bars ----------------------------------
    # Standard euro: bars straddle the C's optical middle, protruding left.
    pen = TTGlyphPen(glyf)
    glyf["C"].draw(pen, glyf)
    for cy in (314, 434):
        x0 = round(48 * scale) + bar_r  # ink starts left of the C (c_left ~ 72*scale)
        x1 = round(430 * scale)
        draw_stadium(pen, x0, x1, cy, bar_r)
    glyf["euro"] = pen.glyph()
    glyf["euro"].recalcBounds(glyf)

    order = font.getGlyphOrder()
    if "euro" not in order:
        font.setGlyphOrder(order + ["euro"])
    hmtx["euro"] = (c_adv, glyf["euro"].xMin)
    for table in font["cmap"].tables:
        if table.isUnicode():
            table.cmap[0x20AC] = "euro"
    if "post" in font:
        font["post"].extraNames = []  # regenerated from glyph order on save

    # --- rename family per OFL reserved-name rule ---------------------------
    name = font["name"]
    ps = family.replace(" ", "")
    for rec in name.names:
        if rec.nameID in (1, 16):
            rec.string = family
        elif rec.nameID == 4:
            rec.string = family
        elif rec.nameID == 6:
            rec.string = ps
        elif rec.nameID == 3:
            rec.string = f"{family}: derived from Routed Gothic (OFL)"

    font.save(dst)
    print(f"{src} -> {dst} ({family}): yen decomposed, euro added, family renamed")


if __name__ == "__main__":
    main(*sys.argv[1:4])
