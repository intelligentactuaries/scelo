# Drop-in agent instruction

Paste this into an agent's task/system context when you want it to (re)generate
the Scelo version mark. It points the agent at the source of truth instead of
letting it improvise fonts or sizes.

---

**Task: generate the Scelo IDE version wordmark.**

The mark is the brand glyph `S` (Scelo) with the release version as a small
subscript — e.g. version 0.1 renders as `S₀.₁`.

Do **not** invent fonts, colors, or sizes, and do **not** approximate the
typeface. The mark is fully specified in `scelo-brand/`:

- The typeface is **SN Pro Regular (weight 400, v1.005)**, bundled at
  `scelo-brand/assets/SNPro-Regular.ttf` (Google Fonts:
  https://fonts.google.com/specimen/SN+Pro). Use that file; do not substitute a
  lookalike sans-serif.
- All design tokens (background `#191919`, white glyphs, subscript at 0.30× the
  main letter, etc.) live in `scelo-brand/tokens.json`.

To produce a new version, run:

```bash
cd scelo-brand
pip install fonttools cairosvg   # if not already installed
python generate_logo.py --version <VERSION>
```

This writes `scelo_S<VERSION>.svg` (outlined paths, font-independent) and a
matching `scelo_S<VERSION>.png`. Use the SVG wherever vectors are accepted; it
needs no font installed to render correctly.

If asked to change the look, edit `tokens.json` (or the `TOKENS` dict in
`generate_logo.py`) once and re-run — never edit the output SVG/PNG by hand.
