# Scelo IDE — version wordmark

A single brand glyph (`S` for Scelo) with the release version set as a small
subscript: `S₀.₁`, `S₀.₂`, `S₁.₀`, and so on. This folder is the **source of
truth** — never hand-draw the mark or eyeball the font; always regenerate.

## TL;DR for a new version

```bash
python generate_logo.py --version 0.2
# -> scelo_S0_2.svg   (vector, self-contained)
# -> scelo_S0_2.png   (1323×1323, rasterised from that exact SVG)
```

## Why this is reproducible (and agent-proof)

1. **Font is pinned and bundled.** `assets/SNPro-Regular.ttf` is Google Fonts
   **SN Pro v1.005, weight 400 (Regular)** — the file from
   <https://fonts.google.com/specimen/SN+Pro>. No "closest match," no system
   font roulette.
2. **Glyphs are outlined into the SVG.** The generator converts each letter to
   vector `<path>` data, so the SVG renders identically on any machine with
   **no font installed**. An agent or renderer literally cannot "miss the font."
3. **Every visual decision is a named token.** Colors, sizes, subscript ratio,
   spacing, and centering all live in `tokens.json` (mirrored in `TOKENS` at the
   top of `generate_logo.py`). Change a token → re-run → consistent everywhere.
4. **PNG is derived from the SVG**, not generated separately, so the two can
   never drift apart.

## Design tokens (do not deviate)

| Token | Value | Meaning |
|---|---|---|
| Font | SN Pro Regular (400), v1.005 | the only typeface used |
| Background | `#191919` | square canvas fill |
| Foreground | `#FFFFFF` | glyph fill |
| Canvas | 1000 × 1000 (SVG viewBox), 1323 px PNG | square |
| Lockup width | 0.60 of canvas | how wide `S0.1` sits |
| Subscript scale | 0.30 × main letter | version size vs. the `S` |
| Subscript drop | 0.10 em | how far the version sits below the baseline |
| Subscript gap | 0.02 em | space between `S` and version |
| Centering | ink bounding-box, both axes | mark is optically centered |

## Files

```
scelo-brand/
├── generate_logo.py        # the generator (run this)
├── tokens.json             # machine-readable design tokens
├── BRAND_SPEC.md           # this file
├── AGENT_PROMPT.md         # drop-in instructions for an LLM agent
├── assets/
│   ├── SNPro-Regular.ttf   # pinned font (Google Fonts SN Pro 400)
│   └── SNPro-LICENSE.txt   # OFL license
└── scelo_S0_1.{svg,png}    # example output for v0.1
```

## Requirements

```bash
pip install fonttools cairosvg
```

`cairosvg` is only needed for the PNG. The SVG is produced with `fonttools`
alone and is fully standalone.

## Options

```bash
python generate_logo.py --version 1.0 --png-size 2048      # bigger raster
python generate_logo.py --version 0.3 --out-dir dist        # custom folder
python generate_logo.py --version 2.0 --letter S            # explicit glyph
```

To rebrand (different background, lighter/heavier weight, different subscript
size), edit `tokens.json` / `TOKENS` once — the whole version family follows.
SN Pro ships ExtraLight(200)→Black(900); swap `assets/SNPro-Regular.ttf` for
another weight file and update `font.weight` if you want a different cut.
