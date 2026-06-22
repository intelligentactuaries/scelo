#!/usr/bin/env python3
"""
Scelo brand-mark generator.

Produces a version-stamped wordmark  ( e.g.  S 0.1 )  as:
  - a self-contained SVG  (glyphs are OUTLINED paths -> no font needed to view it)
  - a PNG  (rasterised from that exact SVG, so they can never drift apart)

The single source of truth for every visual decision is TOKENS below
(and the mirror copy in tokens.json). Change the version, run the script,
get a pixel-consistent asset every time.

Usage
-----
    python generate_logo.py --version 0.2
    python generate_logo.py --version 0.2 --letter S --png-size 1323
    python generate_logo.py --version 1.0 --out-dir dist

Requires:  fonttools, cairosvg   (pip install fonttools cairosvg)
Font:      assets/SNPro-Regular.ttf  (Google Fonts "SN Pro" v1.005, weight 400)
"""

import argparse, json, os
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------------------
# DESIGN TOKENS  — the only numbers that define the look. Edit here, not below.
# ---------------------------------------------------------------------------
TOKENS = {
    "font_file":        "assets/SNPro-Regular.ttf",  # Google Fonts SN Pro, 400
    "font_name":        "SN Pro",
    "font_weight":      400,
    "letter":           "S",          # brand glyph (Scelo)
    "bg":               "#191919",    # canvas background
    "fg":               "#FFFFFF",    # glyph fill
    "canvas":           1000,         # SVG viewBox is canvas x canvas (square)
    "lockup_width_frac": 0.60,        # width of the whole "S0.1" relative to canvas
    "subscript_scale":  0.30,         # subscript size relative to the main letter
    "subscript_drop":   0.10,         # subscript baseline drop, in main-em units
    "subscript_gap":    0.02,         # space between letter and subscript, main-em units
    "png_size":         1323,         # default raster size in px
}


def _load_font(token_font_file):
    font = TTFont(os.path.join(HERE, token_font_file))
    return font, font.getGlyphSet(), font.getBestCmap(), font["head"].unitsPerEm


def _glyph(ch, gs, cmap):
    """Return (svg_path_d, advance_width, bounds) for a character in font units."""
    g = gs[cmap[ord(ch)]]
    pen = SVGPathPen(gs); g.draw(pen)
    bp = BoundsPen(gs); g.draw(bp)
    return pen.getCommands(), g.width, bp.bounds  # bounds may be None (e.g. space)


def build_svg(version, tokens=TOKENS):
    t = dict(TOKENS); t.update(tokens or {})
    font, gs, cmap, upm = _load_font(t["font_file"])
    letter = t["letter"]

    M   = 1.0                      # main scale (arbitrary; global scale fixes final size)
    Ms  = M * t["subscript_scale"] # subscript scale
    DROP = t["subscript_drop"] * upm * M
    GAP  = t["subscript_gap"]  * upm * M

    placed = []   # (path_d, scale, tx, ty, bounds)
    def place(ch, s, tx, ty):
        d, adv, b = _glyph(ch, gs, cmap)
        placed.append((d, s, tx, ty, b))
        return adv

    # main letter, baseline at origin
    pen_x = 0.0
    adv = place(letter, M, pen_x, 0.0)
    pen_x += M * adv + GAP

    # subscript = the version string, dropped below the baseline
    for ch in str(version):
        adv = place(ch, Ms, pen_x, DROP)
        pen_x += Ms * adv

    # union ink bbox in screen coords (y grows down, baseline flip is -s)
    xs, ys = [], []
    for d, s, tx, ty, b in placed:
        if not b:  # space-like glyph
            continue
        x0, y0, x1, y1 = b
        xs += [tx + s * x0, tx + s * x1]
        ys += [ty - s * y1, ty - s * y0]
    bx0, bx1, by0, by1 = min(xs), max(xs), min(ys), max(ys)
    bw, bh = bx1 - bx0, by1 - by0
    bcx, bcy = (bx0 + bx1) / 2, (by0 + by1) / 2

    C = t["canvas"]
    G = (t["lockup_width_frac"] * C) / bw          # global scale to hit target width
    ox = C / 2 - G * bcx                            # centre horizontally
    oy = C / 2 - G * bcy                            # centre vertically

    groups = []
    for d, s, tx, ty, _ in placed:
        # font units (y-up) -> screen (y-down):  matrix(s,0,0,-s, tx, ty)
        groups.append(f'    <g transform="matrix({s},0,0,{-s},{tx},{ty})">'
                      f'<path d="{d}"/></g>')

    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{C}" height="{C}" viewBox="0 0 {C} {C}">
  <!-- Scelo mark | {letter}{version} | font: {t["font_name"]} {t["font_weight"]} (outlined) -->
  <rect width="{C}" height="{C}" fill="{t["bg"]}"/>
  <g transform="translate({ox},{oy}) scale({G})" fill="{t["fg"]}">
{chr(10).join(groups)}
  </g>
</svg>
'''
    return svg


def main():
    ap = argparse.ArgumentParser(description="Generate the Scelo version wordmark.")
    ap.add_argument("--version", required=True, help='e.g. "0.2"')
    ap.add_argument("--letter", default=None, help="override brand glyph (default S)")
    ap.add_argument("--png-size", type=int, default=None, help="raster px (default 1323)")
    ap.add_argument("--out-dir", default=HERE, help="output directory")
    args = ap.parse_args()

    overrides = {}
    if args.letter:    overrides["letter"] = args.letter
    if args.png_size:  overrides["png_size"] = args.png_size

    svg = build_svg(args.version, overrides)
    os.makedirs(args.out_dir, exist_ok=True)
    tag = f'{(args.letter or TOKENS["letter"])}{args.version}'.replace(".", "_")
    svg_path = os.path.join(args.out_dir, f"scelo_{tag}.svg")
    png_path = os.path.join(args.out_dir, f"scelo_{tag}.png")

    with open(svg_path, "w") as fh:
        fh.write(svg)

    import cairosvg
    px = overrides.get("png_size", TOKENS["png_size"])
    cairosvg.svg2png(bytestring=svg.encode(), write_to=png_path,
                     output_width=px, output_height=px)

    print(f"wrote {svg_path}")
    print(f"wrote {png_path}  ({px}x{px})")


if __name__ == "__main__":
    main()
