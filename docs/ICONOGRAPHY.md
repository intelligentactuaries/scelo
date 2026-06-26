---
name: website-iconography
description: |
  The visual recipe every icon and decorative mark on the public site
  (website_v2) follows. Single living spec, colocated with Nav.tsx
  where the canonical examples live. Match this style for ANY new
  icon you add to the website. Brand-mark exceptions are called out
  explicitly below.
status: living spec — update in the same commit as any iconography
        change so the spec and the canonical examples never drift.
---

# Website iconography style

> One visual recipe. Single-stroke, monochrome, geometric. No fills,
> no shadows, no gradients, no rasters. Reads as a research-house, not
> a startup landing page.

The aesthetic was set by the nav-panel marks (Nov 2026, Nav.tsx) and
should be matched by every icon added to the public website thereafter.
Brand glyphs (GitHub, Hugging Face, Zenodo, …) are the only exception
and follow their own brand SVG paths — they still use `currentColor`
so they tint with the parent's text colour.

---

## 1. The recipe

Every chrome / decorative mark must be:

- **Inline React SVG**, not an `<img src="*.svg">` reference.
  Inline lets the icon inherit `currentColor` and react to theme.
- **64 × 64 viewBox**, rendered at `width={96} height={96}` inside a
  bordered tile, or at `width={size} height={size}` bare in body
  content (default `size={18}` for social-row glyphs, see Socials.tsx).
- **`fill="none"`** on the root `<svg>`. Filled shapes inside are
  reserved for the rare emphasis dot, terminal marker, or play
  triangle — see §3 below.
- **`stroke="currentColor"`** — never a literal hex. The mark
  inherits its colour from the parent's text colour, which keeps it
  in sync with whatever theme is active (light / dark / auto) and
  whatever `text-fg-*` token the parent uses.
- **`strokeWidth={1.5}`** as the default. Bump to `{1.8}-{2}` only
  for *one* element inside a mark you want to draw the eye to (a
  title rule, a leading sparkline, a checkmark). Don't have more
  than one heavy stroke per mark.
- **`strokeLinecap="round"` + `strokeLinejoin="round"`** on every
  mark, no exceptions. The rounded terminals + joins are what give
  the set its quiet, hand-drafted feel; sharp caps look industrial.

The shared SVG-prop literal in `Nav.tsx` is the source of truth:

```tsx
const SVG_PROPS = {
  width: 96,
  height: 96,
  viewBox: "0 0 64 64",
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
```

Reuse it. Don't redefine the recipe per icon.

---

## 2. Composition rules

- **One concept per mark.** A manuscript is a manuscript; don't try
  to also imply "data" by adding a chart inside. Pick one of the two
  and let the title carry the rest.
- **Geometric over figurative.** When in doubt, abstract harder.
  A target reads as "alignment / audit / precision" without needing
  arrows or eyes. A sparkline reads as "instrument" without needing
  a beaker.
- **Balanced negative space.** With a 64-unit viewBox, keep the
  shape inside roughly the 8-56 box. Use the outer 8 px as breathing
  room — it's what stops the mark feeling crammed inside the
  bordered tile.
- **2-6 distinct strokes** is the right density. Fewer than 2 reads
  as an OS icon; more than 6 starts to look like a diagram and loses
  the quiet feel.
- **Symmetry is fine, perfection is not.** Most of the set is
  loosely symmetrical (target, fence, network). Don't snap every
  element to integer pixels — that's what makes line art feel
  mechanical.
- **No text inside icons.** No labels, no abbreviations, no formula
  fragments. The summary panel on the right of the nav (and captions
  in body content) carry the words; the mark carries the shape.

---

## 3. Exceptions that earn their fill

A solid fill is allowed in three specific roles, each at most once
per mark:

1. **A terminal dot on a line** — e.g. the end of a sparkline or
   curve, signalling a current value (Lab default, Wmtr).
2. **A node in a network** — small filled circles, larger filled
   centre node for hubs (Nanoeconomics).
3. **A directional symbol** — the play triangle on the lab
   DataCenter mark.

Pattern, when used:

```tsx
<circle cx="…" cy="…" r="1.8" fill="currentColor" stroke="none" />
```

Note `stroke="none"` on the filled shape so the outer `stroke="currentColor"`
on the `<svg>` doesn't double-stroke it.

---

## 4. Tile chrome

When a mark sits on a chrome surface (nav panel, card header), wrap it
in a square bordered tile:

```tsx
<div
  aria-hidden
  className="aspect-square w-[160px] flex items-center justify-center
             border border-border bg-bg-1/60 text-fg-mute overflow-hidden"
>
  <Mark />
</div>
```

- `text-fg-mute` is the default ink colour for marks on tiles. The
  mark inherits this via `currentColor`, picking up the same warm
  charcoal in light mode and warm bone in dark mode that the rest of
  the IA chrome uses.
- `bg-bg-1/60` (slightly translucent) sits well over both light and
  dark page backgrounds without needing a media query.
- `border border-border` is the same hairline used everywhere else.
- `overflow-hidden` lets crossfade transforms scale inside without
  bleeding past the tile.

Bare placement (e.g. social rows, inline within a paragraph) skips
the tile and just renders the SVG, again inheriting `currentColor`
from the parent's text class.

---

## 5. Animation between marks

When the parent component swaps marks based on hover state (the nav
panel is the canonical case), wrap the mark in a `framer-motion`
crossfade:

```tsx
<AnimatePresence mode="wait" initial={false}>
  <motion.div
    key={itemTo ?? groupId}
    initial={{ opacity: 0, scale: 0.96 }}
    animate={{ opacity: 1, scale: 1 }}
    exit={{ opacity: 0, scale: 0.96 }}
    transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
    className="flex items-center justify-center"
  >
    <Mark />
  </motion.div>
</AnimatePresence>
```

Same easing curve as the rest of the nav-panel motion. Don't introduce
bespoke easings per icon.

---

## 6. The current canonical set

All twelve marks live as inline React components in `Nav.tsx`.
The lookup function `markFor(to, groupId)` maps a sub-page URL or
group id to its mark; new sub-pages register here.

| Group       | Default mark      | Sub-page marks                                                                                                                              |
|-------------|-------------------|---------------------------------------------------------------------------------------------------------------------------------------------|
| Research    | `ResearchMark`    | `DataCenterPaperMark`, `NanoeconomicsMark`                                                                                                  |
| Lab         | `LabMark`         | `DataCenterLabMark`, `WmtrMark`, `SoftDataMark`                                                                                             |
| Media       | `MediaMark`       | —                                                                                                                                           |
| Commitments | `CommitmentsMark` | `IntegrityMark`, `GovernanceMark`, `AuditMark`, `DisclosureMark`                                                                            |

What each one is supposed to *evoke* — useful when iterating or
designing siblings:

- **ResearchMark** — manuscript page. Stacked horizontal rules
  inside a rectangular frame, with one short rule signalling a
  title block.
- **LabMark** — instrument readout. Axes + faint horizontal
  gridlines + a single ascending sparkline + terminal dot.
- **CommitmentsMark** — alignment / centring. Three concentric
  circles plus a crosshair.
- **DataCenterPaperMark** — paper containing a server rack.
  Outer page outline, title rule, two small racks with rack-unit
  hatching.
- **NanoeconomicsMark** — community network. Four perimeter nodes
  connected through a central hub.
- **DataCenterLabMark** — active demo. Two server racks with a
  play triangle on top.
- **MediaMark** — video player. Filled play triangle inside a
  ring. Reads as "press play" without needing a screen rectangle.
- **WmtrMark** — survival S-curve descending across axes, with
  terminal dots at both ends.
- **SoftDataMark** — data table with one column lit (soft fill).
- **IntegrityMark** — checkmark inside a ring.
- **GovernanceMark** — perimeter fence. Two horizontal rails,
  three vertical posts with small caps.
- **AuditMark** — chain. Two interlocking rings.
- **DisclosureMark** — padlock with keyhole.

---

## 7. Adding a new mark

1. **Decide the concept.** One sentence: what does this mark evoke?
   If you can't write that sentence in twelve words or fewer, the
   mark is trying to do too much.
2. **Sketch in SVG** using the recipe in §1. Build it in 64-unit
   coordinates so it composes with the existing set.
3. **Add the component to `Nav.tsx`** (or to a sibling component
   file if the mark isn't nav-related). Keep them in the same file
   so the recipe stays visible alongside the examples.
4. **Wire it into `markFor`** if it's a nav sub-page mark; for any
   other surface, just import it where needed.
5. **Eyeball the set together.** Open the nav, hover each item,
   and check that the new mark *feels* like a member of the family.
   Density, stroke weight, fills — all should sit within the range
   established by the existing twelve.
6. **Update this file's §6 table** in the same commit so the spec
   never drifts from the code.

---

## 8. What NOT to do

- **No raster icons** (PNG, JPG, WebP) for chrome marks. PNG logos
  for hero / illustration surfaces are fine; chrome iconography must
  stay vector + currentColor.
- **No multi-fill SVGs.** A mark is either monochrome (the recipe
  above) or it's a brand glyph — pick a lane.
- **No drop shadows, glows, blurs, or filter effects** on chrome
  marks. The bordered tile is the entire chrome.
- **No imported icon-set libraries** (lucide-react, heroicons,
  tabler-icons, react-icons). Mixing those with the bespoke set
  immediately breaks consistency. If you genuinely need a glyph
  that doesn't exist, draw it from scratch using the recipe.
- **No literal colour values.** Always `currentColor`. The
  exception is brand glyphs in `Socials.tsx`, and even those use
  `currentColor` for the *fill* — the brand-specific paths sit
  underneath.
- **No animated stroke-dashoffset / draw-on effects** on chrome
  marks. The whole-mark crossfade in §5 is the only animation
  pattern. Stroke-draw effects belong to splash / hero motion only.

---

## 9. Update protocol

This file is the single source of truth for the website's icon style.

- **When you add, replace, or restyle a mark, update this file in
  the same commit.** Bump §6 if a new mark joins the canonical set.
- **When the recipe itself changes** (stroke weight, tile chrome,
  motion easing), update §1 / §4 / §5 and audit the existing twelve
  marks against the new rule.
- The user has asked for permanence on this style. Don't quietly
  drift away from it across PRs — the visual unity *is* the
  research-house signal.

---

## 10. Applying the recipe to the docs site (MkDocs)

The documentation site (`docs/`, MkDocs Material) reuses this language
for its schematic diagrams — replacing ASCII/box-drawing art with
**inline SVG** that follows §1. The adaptations for diagram scale:

- Diagrams are wrapped in `<figure class="ia-diagram">` and use a
  wider viewBox than 64×64 (they are schematics, not 64-unit marks).
- Everything is still `fill="none"`, `stroke="currentColor"`,
  `stroke-width="1.5"`, round caps/joins, monochrome.
- The wrapper sets `color: var(--md-default-fg-color--light)` so the
  diagram reads a touch lighter than body text (the docs equivalent
  of `text-fg-mute`).
- **Labels are allowed** in diagrams (the "no text inside icons" rule
  is for 64-unit marks). Use `<text fill="currentColor" stroke="none">`,
  small, letter-spaced for uppercase tags.
- Fills stay within §3: small terminal/node dots and a single
  directional chevron/arrow per connector — no other fills.
- Diagram CSS lives in `docs/docs/stylesheets/extra.css` under the
  `.ia-diagram` selector.
