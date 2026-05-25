# apps/web — React + Vite + Bun

Optional dashboard. Mirrors what the TUI shows. Built and run with Bun.

## Conventions

- **All charts go through `<EChart spec={...} />`** — never import `echarts-for-react` directly elsewhere. The IA theme is registered globally in `lib/echarts/theme.ts`.
- **All graphs go through `<FlowGraph spec={...} />`** — same rule for `reactflow`.
- **Themes**: dark and light, both supported. Default follows the OS via `prefers-color-scheme`; users can override to system / light / dark via the sidebar settings popover. Persisted in `localStorage["ia.theme"]`. All component colours flow through CSS variables in `styles/theme.css` and the `rgb(var(--rgb-x) / <alpha-value>)` token form in `tailwind.config.ts` — so existing `bg-bg`, `text-fg`, `border-border` classes adapt automatically. Theme-aware integrations (ECharts, React Flow, xterm) subscribe to the resolved theme via `useTheme()` from `lib/theme.ts`.
- **No `localStorage`** in components — use the API or `sessionStorage` via the session layer. The conversations store and the theme manager are the only sanctioned exceptions.
- **Biome** formats and lints. The lint config refuses imports of `recharts`/`chart.js`/`plotly`/`d3`/`victory`.

## Layout

- `src/components/EChart.tsx` — the only chart component
- `src/components/FlowGraph.tsx` — the only graph component
- `src/components/Terminal/` — xterm.js terminal that mirrors the TUI session
- `src/components/CommandPalette.tsx` — Cmd/Ctrl+K
- `src/lib/api.ts` — typed FastAPI client
- `src/lib/echarts/theme.ts` — `ia-dark` theme registration
- `src/lib/reactflow/nodeTypes.ts` — custom node renderers
- `src/components/Scelo/` — the Scelo workstation (see below)

## Scelo — soft → tools → hard workstation

Scelo is the data-→model-→board-pack walkthrough at `/dashboards/scelo`. The macro view shows three nodes; clicking the expand icon on any one drops into a full-screen workstation. It deliberately bypasses the global `<EChart>` / `<FlowGraph>` wrappers because it owns its own theming, map-registry, viz-spec parser, and per-stage memory — wrapping every chart in the shared `<EChart>` would defeat all of that. The rule of "use `<EChart>` everywhere else" still stands; Scelo is the documented exception.

### Routes & files

- `Scelo.tsx` (route) → `SceloFlow.tsx` (macro view, project bar, mode toggle) → `Soft`/`Tools`/`HardDataWorkstation.tsx` (drill-ins).
- `sceloContext.tsx` — Scelo-wide React state: dataset, filters, model picks, runs, plus `mode: "project" | "explore"` and `project: { id, name, createdAt }`. Project metadata persists to `localStorage["scelo:project-state"]`.
- `useNodeChat.ts` — per-chat hook (streams from `streamOrchestrator`). Optional `memoryKey` arg hydrates and persists messages to `localStorage["scelo:chat:<key>"]` — only set when project mode is on. Every Scelo chatbar composes its key as `<project.id>:<chatId>`; chat ids are stable per surface (`soft-stage`, `tools-stage`, `tools-hub`, `tools-model:<id>`, `hard-stage`, `macro-soft|tools|hard`, `hard-detail:<modelId>`).
- `cleaning.ts` — analyse + apply pipeline for the Soft Data cleaning banner. Sampled analysis above 200k rows (caps the budget at ~100k visited rows); ops: trim, missing-token normalisation (~40 spellings), numeric parsing with accounting parens / percent / currency codes, boolean standardisation, duplicate dedupe, drop-empty-cols, drop-constant-cols, lowercase-categoricals. Cell-level ops fused into a single per-row pass on apply.
- `chatViz.tsx` — fenced ` ```viz ` block renderer used by the Soft Data chat. JSON spec, parser is tolerant of `type`/`kind` drift (aliases: `matrix`→`corr`, `crosstab`→`heatmap`, `geo`→`map`, …). Supported chart kinds: `bar`, `line`, `pie`, `scatter` (with Pearson `r` overlay), `heatmap` (categorical crosstab), `corr` (numeric Pearson matrix), `map`. Plus `table` (grouped or raw). Pie / scatter / heatmap / corr / map render in a square aspect container.
- `geoRegistry.ts` — global geography registry. Backed by `sane-topojson` (Plotly's Natural-Earth-derived bundle) for `world` (177 countries) and `US` (51 states + DC), plus a bundled `zaProvinces.geo.json` cut of Natural Earth 1:50m admin1 for `ZA` (9 provinces). `detectMap(values)` samples up to 200 column values, scores against the three resolvers (US states → ZA provinces → world countries), and returns the best fit + a canonicaliser. Extend by adding another atlas dependency + `echarts.registerMap` call.
- `SceloChatMarkdown.tsx` — wraps the shared `MarkdownBlock` with a custom `code` renderer that intercepts ` ```viz ` fences and renders `<ChatViz>` instead. Used by every Scelo assistant message bubble.
- `modelTheory.ts` — markdown-with-KaTeX blurbs (one per model) consumed by the Hard Data per-model detail dashboard. Math delimiters are `$...$` (inline) and `$$...$$` (display) — **not** `\[…\]` (remark-math doesn't understand it). Dollar signs that should appear in math content next to TS template-literal interpolation syntax (`${`) must be escaped (`\${...\$`).

### Conventions specific to Scelo

- **Stack-safe numerics.** `Math.min(...arr)` / `Math.max(...arr)` blow the call stack at ~100k elements. Use the exported `minMax(values)` from `SoftDataWorkstation.tsx` for column-level aggregates.
- **Themed ECharts.** Components that render via `<ReactECharts>` directly read the active theme via `useTheme()` and pass real hex strings into the option (axis labels, grid lines, tooltip bg). Canvas renderer doesn't resolve `rgb(var(--rgb-…))` strings; SVG does, but inconsistency between the two is a foot-gun — always materialise hex.
- **Heatmap-style label contrast.** Per-cell label colours are picked by WCAG luminance via `contrastText(hex)` so saturated cells get white text and neutral cells get dark. See the corr matrix in `chatViz.tsx`.
- **Print pipeline.** The Hard Data board-pack report lives inside a `[data-print-region]` div with `data-print-card` / `data-print-skip` markers. The `@media print` block in `styles/theme.css` hides everything else, forces light theme + `print-color-adjust: exact`, and lays the region out at A4 with 18mm margins. ECharts charts in the report use `renderer: "svg"` so they print as vectors.
- **Memory key namespace.** All Scelo chat memory keys MUST start with the active `project.id` and a `:`. The context's `chatMemoryPrefix` accessor returns the prefix or `null` (explore mode) — never build the key locally; always concatenate `${chatMemoryPrefix}:<chatId>`.
