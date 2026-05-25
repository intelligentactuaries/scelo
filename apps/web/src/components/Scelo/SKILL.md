---
name: scelo
description: |
  Scelo is the model / AI "brain" layer of Intelligent Actuaries. Lives at
  /dashboards/scelo and is organised as a macro view + three drill-in
  workstations (/soft, /tools, /hard). This skill captures the data
  philosophy, file map, shared state, AI integration points, climate-
  actuarial pipeline, and the conventions to keep when extending it.
status: in-development — not yet ready for deployment or publication.
        Updates to Scelo features MUST be accompanied by updates to this
        file. Treat it as a living spec.
---

# Scelo · the brain of Intelligent Actuaries

> Soft data → tools → hard data.
> Soft data is what we cannot see or cannot easily decide on (raw uploads,
> unstructured input). Tools are the statistical & actuarial models that
> convert it. Hard data is the processed, decision-grade output.
> Analogy: temperature is soft, a thermometer is the tool, 24 °C is hard.

Scelo is *not* a generic dashboard. It is an opinionated pipeline that
walks an actuary from raw input to a board-pack-ready output through three
explicit stages, with an AI co-pilot scoped to each stage.

---

## 1. Layout

```
/dashboards/scelo                  ← macro view (React Flow, 3 cards)
/dashboards/scelo/soft             ← Soft Data workstation
/dashboards/scelo/tools            ← Tools workstation
/dashboards/scelo/hard             ← Hard Data workstation
```

Routing is owned by `apps/web/src/routes/Scelo.tsx`. The whole tree is wrapped
in a single `<SceloProvider>` so dataset, filters, model picks, and run
results survive sub-route navigation. Leaving `/dashboards/scelo` entirely
resets state (deliberate — Scelo sessions are bounded by the route).

---

## 2. The macro view

Three custom React Flow nodes (`SceloNode`) wired left → right with one-way
edges. Tools is the only node connected on both sides. Each card shows:

- Stage label (soft / tools / hard) tinted with the stage accent.
- A one-line title and subtitle.
- A live status hint pulled from `useScelo()` (rows loaded, models live,
  runs computed). Reads as `—` until that stage has produced something.
- A compact per-stage `NodeChat` with its own `stageContext` system prompt
  (see §6) and a memory key tied to the project (see §7).
- An "open →" affordance — Enter / Space / click drills into the
  workstation.

Above the canvas sits a `ProjectBar` that switches between two modes:

- **explore** (default) — quick exploration, no chat memory.
- **project** — give the session a name, get a stable `project.id` that
  every chat across Scelo uses as a memory-key prefix.

Both modes hydrate from `localStorage` so reload lands the user in the
same mode they left.

Files: `SceloFlow.tsx`, `SceloNode.tsx`, `routes/Scelo.tsx`, `sceloContext.tsx`.

---

## 3. Soft Data workstation (`SoftDataWorkstation.tsx`)

VS Code Data-Wrangler-style three-column layout:

| pane | content |
| --- | --- |
| left | columns list (click to focus) |
| centre | paginated row grid + filter chips + cleaning banner |
| right | `SmartColumnDashboard` + column summary |
| far right | `StageChatPanel` (soft · chat) |

### Empty state

A blank canvas with two centred buttons: **import csv/parquet** and **load
sample**. Both open modals (`ImportFileModal`, `SampleLibraryModal`) — no
auto-load on mount. The import modal supports drag-drop.

### Simulate / augment from scenario

Soft Data's toolbar carries a **▷ simulate** affordance that opens
`SimulateScenarioModal`. Two modes:

- **generate** — call the swarms server's `POST /api/simulate` with a
  scenario + optional drug list. Returns ~120-1000 per-agent rows
  (SA-anchored population: StatsSA pyramid, SADHS / THEMBISA / NICD
  comorbidity priors) PLUS macro aggregates (workdays lost, GDP drag,
  excess mortality, insurer claims). The rows are loaded straight into
  Scelo as a new dataset. Reference drug data fetched live from
  PubChem REST / OpenFDA FAERS / ChEMBL — cached in the swarm's
  cache table by sha256(query), 7d TTL.
- **augment** — when a dataset is already loaded, call
  `POST /api/simulate/augment` with the caller's rows. The server
  simulates a SAMPLE of representative agents (default 120), buckets
  outcomes by `age × sex × hasComorbidity`, then applies the median
  outcome per bucket to each input row. Result: `sim_*` columns
  appended in place. Keeps cost bounded for 10k-row datasets.

See SimulateScenarioModal.tsx + the swarms-side `/api/simulate*`
endpoints. The simulator also exists as a standalone SIMULATION tab
in the swarms app at :3010.

### Sample library

`SAMPLE_OPTIONS` in `SoftDataWorkstation.tsx`. Three samples:

- **claims** (accent: `accent-2`) — 64-row synthetic claims triangle
  (origin × dev × paid).
- **climate** (accent: `warn`) — 30-day Pretoria 2024-01 series with
  ERA5 / MERRA-2 / JRA-3Q temperature + precipitation columns. Built
  from `CLIMATE_SAMPLE` in `climateSampleData.ts`.
- **dirty** (accent: `error`) — 53-row "messy intake" demo that
  exercises every cleaning op in one sample. `$/comma/parens` currency
  strings, `%`-suffixed numbers, `-999 / 9999` sentinel ages, mixed
  Y/N/yes/no/1/0 booleans, mixed date formats, case-only region
  duplicates, a constant `country` column, two near-empty columns,
  headers with spaces, mojibake (UTF-8 ↔ Latin-1), BOM / NBSP /
  zero-width characters, missing markers, and three exact duplicate
  rows. Loading it lights the cleaning banner up with every op so a
  reviewer can apply them in one click. Built in `dirtySampleData.ts`.

### Column types

Computed once per dataset via `summariseDataset()` — produces a `ColumnMeta`
per column with type (number / string / date), count, missing, unique, and
basic descriptive stats. Reused by Tools and Hard Data (they import the
type from this file — see "Why is `Dataset` exported from Soft?" in §9).

### Cleaning

`cleaning.ts` — `analyseCleaning()` returns a `CleaningPlan` of ops.
Surfaced as a banner with a "review → apply" interaction. Each op is
independently toggleable. The op set tracks the traditional column-by-
column cleaning playbook (structural, string, numeric, datetime,
boolean, missing, outlier, row-level):

| op key | safe? | scope |
| --- | --- | --- |
| `trim` | safe | cell — leading / trailing whitespace |
| `collapse-whitespace` | safe | cell — internal runs of whitespace folded to a single space |
| `fix-encoding` | safe | cell — mojibake (UTF-8 ↔ Latin-1 misdecode) + strip BOM / NBSP / zero-width / soft hyphen |
| `missing-tokens` | safe | cell — N/A / ? / - / "" / TBD / etc → null |
| `parse-numeric` | safe | column — ≥80% numeric strings, cast (strips $, commas, %, parens, currency codes) |
| `parse-dates` | safe | column — ≥80% date-shaped strings, canonicalise to ISO 8601 |
| `standardise-booleans` | safe | column — yes/no/Y/N/on/off → true/false |
| `replace-numeric-sentinels` | safe | column — repeated -999 / 9999 etc that sit > 5·IQR outside the column range |
| `drop-duplicates` | destructive | row — exact match across all columns |
| `drop-empty-cols` | destructive | column — >95% missing |
| `drop-constant-cols` | destructive | column — exactly one distinct value |
| `lowercase-categoricals` | destructive | column — merges case-only duplicate buckets |
| `rename-snake-case` | destructive | header — spaces / dots / CamelCase → snake_case (clears derived columns and filters on apply) |

`safe` ops are pre-selected; destructive ops are opt-in. `apply` runs
ops in a fused single per-row pass for performance: `fix-encoding →
trim → collapse-whitespace → missing-tokens → standardise-booleans →
parse-dates → parse-numeric → lowercase-categoricals`, then row dedupe,
column drops, then header rename last so all prior ops still see the
original names. Sentinel detection and large-dataset duplicate
detection are sampled (stride over a 100k-row budget) above 200k rows
so the analyser stays sub-second; apply always runs at full fidelity.

The Soft-Data stage chatbot (`SOFT_STAGE_FRAME`) and the per-column
chatbot (`buildColumnStageContext` in `columnChatHints.ts`) both embed
the full cleaning playbook as **silent background knowledge**, not for
recitation. Each prompt leads with an "ANSWER SHAPE" rule: lead with
the action, no preamble, no playbook recitation unless asked. When the
user names a direct verb (round, lowercase, drop, log, etc.), the bot
emits one banner-op name or one chat-action block and stops. The full
playbook only surfaces when the user asks an open-ended question.

### Chat-action blocks (`chatDerive.tsx`)

The chatbots execute against the dataset via two fenced markdown
blocks the markdown renderer (`SceloChatMarkdown`) intercepts:

| block | shape | effect |
| --- | --- | --- |
| ```derive``` | `{"name":"paid_rounded","formula":"round(paid)"}` | Adds a NEW column. Idempotent on the column name. |
| ```transform``` | `{"column":"paid","formula":"round(paid)"}` | Replaces values of an EXISTING column in place. Idempotent on a `(column + formula)` fingerprint stored in `SceloContext.transformLog`. |

Both render a card showing what was applied plus a deterministic
summary (cells changed, mean shift, range delta, sample of old → new
pairs). The deterministic summary is the source of truth; the LLM's
one-line trailing sentence is interpretive context only.

Per-column chatbots are scoped to one column, so in-place verbs map to
`transform`. Stage chatbot keeps `derive` because its scope is the
whole dataset.

`formulaEvaluator.ts` is tolerant of LLM JS-isms: `Math.round(\`paid\`)`
is silently rewritten to `round(paid)` so output drift between models
does not break execution.

### Derived columns

`formulaEvaluator.ts` — restricted JS expression with column references
and numeric helpers. The formula source is stored in
`SceloContext.derivedColumns` so it can be re-exported by `scriptExporter`.

### Smart dashboards

`SmartColumnDashboard.tsx` — for the focused column, the AI picks 3
dashboards (each containing ≥1 chart). Falls back to a deterministic
local pick when the orchestrator is unavailable. Regenerate is a hard
shuffle, not a re-call — the panel never repeats the same trio twice.

---

## 4. Tools workstation (`ToolsWorkstation.tsx`)

Hub-and-spoke React Flow canvas. The dataset hub sits centre; selected
models orbit around it; cross-model workflow edges connect siblings inside
a domain.

### Model catalog (`modelCatalog.ts`)

Fixed list. Family ∈ `reserving | mortality | pricing | climate | capital |
pensions | life | forecast | general`. Each entry has `id`, `name`,
`family`, `description`, `applicableTo` tags. The AI picker is constrained
to ids in this list — invented ids are dropped.

The `forecast` family is the **WMTR / Nanoeconomics survival capability**
([github.com/intelligentactuaries/nanoeconomics-simulation](https://github.com/intelligentactuaries/nanoeconomics-simulation)).
Two catalog entries:
`wmtr-projection` (single Monte Carlo survival run) and
`wmtr-sensitivity` (sweep shock dial across mild / moderate / severe).
The engine lives in `forecast/wmtr.ts` (lifted from `swarms/src/shared/`).
Domain-agnostic by design — `forecast/domainLabels.ts` carries per-family
M / T / R / shock labels so the same math projects a community, a life
book, a pension scheme, a reserve position, etc.

**Cross-cutting "meta-actions" on Hard Data result cards**: any result
whose family has a domain mapping (`hasForecastDomain`) gets two CTAs
in the result detail panel:

- **▷ Forecast forward** — synthesizes a WMTR config from the result +
  the source dataset via `forecastConfigFor(result, scenario, family)`,
  runs `runForecast`, and renders an inline panel with M/T/R labelled
  for the source domain, survival / W-W₀ stats, and the outcome
  distribution. Pure client-side compute, sub-100ms.
- **◯ Convene council** — calls the canonical swarm app at
  `http://localhost:3010` via `forecast/councilClient.ts`. N agents
  (12 / 24 / 48 / 96 / 192) interrogate the result; the synthesis comes
  back as trust / distrust / uncertain percentages + a dominant
  intervention cluster. Default subset is 12 to keep per-result clicks
  cheap. There is no second council implementation in Scelo — it's a
  thin cross-app API client. A "open in swarm ↗" link follows the
  resulting runId into the canonical deliberation UI.

The `life` family is **lifelib-rooted**
([github.com/lifelib-dev/lifelib](https://github.com/lifelib-dev/lifelib)).
Eight catalog entries map 1:1 to lifelib libraries: `basicterm-projection`
(basiclife · BasicTerm_M), `cashvalue-savings` (savings · CashValue_ME),
`ifrs17-csm` (ifrs17sim), `solvency2-life` (solvency2), `nested-stochastic`
(nestedlife), `smithwilson-curve` (smithwilson), `cluster-modelpoints`
(cluster), `economic-curves` (economic / economic_curves). Each entry's
`applicableTo` carries lifelib model-point column names (`age_at_entry`,
`sum_assured`, `policy_term`, `duration_mth`, `premium_pp`, `account_value`)
so the heuristic picker routes to `life` the moment those columns appear.

#### Lifelib integration depth

Three layers, deepest first:

1. **In-browser TS port** (`lifelibBasicTerm.ts`) — `runBasicTermProjection`
   is a faithful port of lifelib's `basiclife/BasicTerm_M`. Walks the MP
   file month-by-month: `pols_if` decremented by Makeham `qx` (monthly
   conversion) and constant lapse, `claims = pols_death · sum_assured`,
   `net_cf = premiums - claims - expenses` discounted at 3% pa. Stratified-
   sampled to 2000 MPs for sub-100ms response; the full population is
   scaled back up at aggregation.
2. **Deterministic runners for the other 7 life models**
   (`modelRunner.ts`). Each consumes the parsed MP file via
   `summariseMP(dataset)` and produces a credible `RunResult` shape (CSM
   release, life SCR sub-modules, TVOG tail, Smith-Wilson zero curve,
   cluster K). Math is intentionally back-of-envelope — the real
   computation happens in the notebook export.
3. **Notebook export** (`lifelibNotebookExport.ts`,
   `LifelibNotebookCta` in `HardDataWorkstation.tsx`). On any life-family
   result card, an "Export · lifelib notebook" button generates a runnable
   `.ipynb` with `%pip install lifelib`, the user's MP file embedded as
   inline CSV → DataFrame, and the canonical `lifelib.create(...)` call for
   the chosen model. Bridges the in-browser proof to the production tool.
4. **Scelo IDE Python / R bridges** (`bridges/*`). When running inside
   the Scelo IDE desktop shell (`window.scelo` exposed by
   `apps/scelo-ide`'s Electron preload), `runModelAsync` delegates select
   tools to the bundled runtimes:

   - `basicterm-projection` → `bridges/lifelibBasicTermPython.ts` (real
     lifelib `basiclife/BasicTerm_M`).
   - `chain-ladder` / `mack` / `bornhuetter-ferguson` / `bootstrap` →
     `bridges/chainladderPython.ts` (canonical `chainladder.Mack` /
     `BornhuetterFerguson` / `BootstrapODPSample`).
   - `climada` → `bridges/climadaPython.ts` (CLIMADA-shaped synthetic
     hazard for AAL + RP10/100/250; full IBTrACS download is opt-in via
     the notebook-export path).
   - `lifecontingencies` → `bridges/lifecontingenciesR.ts` (canonical
     R `lifecontingencies` package — `axn`, `Axn`, `nEx`).
   - `lee-carter` → `bridges/leeCarterPython.ts` (numpy SVD on log-qx +
     statsmodels SARIMAX(0,1,0) on κ(t); replaces the linear-decay stub
     with 95 % CI projections).
   - `ifrs17-csm` → `bridges/ifrs17CsmPython.ts` (lifelib `ifrs17sim`,
     with an inlined BBA rollforward fallback when ifrs17sim isn't
     shipped alongside basiclife in this lifelib install).
   - `glm-frequency` / `glm-severity` → `bridges/glmPython.ts`
     (statsmodels Poisson GLM with optional log-exposure offset for
     frequency; Gamma log-link for severity; returns coefficient table +
     AIC + Pearson χ²).
   - `nfip-flood-losses` → `bridges/nfipPython.ts` (consumes the user's
     downloaded `FimaNfipClaims.csv` from `/settings/data` via the
     dataset registry; chunked pandas read produces state × decade loss
     totals + p95 severity for the climate flood Tool back-test).
   - `who-life-table` → `bridges/whoMortalityPython.ts` (consumes the
     WHO Global Health Observatory life-table CSV; returns
     country-specific e0 + e65 + qx-by-age. Replaces the
     registration-only SADHS placeholder with a freely-available source).
   - ChEMBL drug lookup → `bridges/chemblPython.ts` (no Scelo Tool wired
     yet; the swarm simulator's drug-fact lookups go through this when
     the user has downloaded the ChEMBL SQLite via `/settings/data`).

   All bridges pipe dataset JSON over stdin and parse JSON on stdout.
   They return `null` when not in the IDE or when the bundled runtime
   call fails, and `runModelAsync` falls back to the in-browser TS port.
   Pattern is generic: copy `bridges/*Python.ts` (or `*R.ts`) and add a
   branch in `runModelAsync` to wire a new tool.

## Scelo IDE workspace surface

`/workspace` (only meaningful inside the Scelo IDE desktop shell) is a
three-pane layout: file browser (left) → Monaco editor (centre) → xterm
terminal (bottom). It's the literal-IDE surface that sits alongside the
specialised Scelo dashboards. Wires:

- `apps/web/src/components/workspace/FileBrowser.tsx` — lazy tree of the
  active workspace dir (chosen via `window.scelo.workspace.pick()`).
- `apps/web/src/components/workspace/EditorPanel.tsx` — Monaco editor,
  fed by `window.scelo.fs.read/write`. ⌘/Ctrl-S to save. Language
  inferred from the file extension.
- `apps/web/src/components/workspace/TerminalPanel.tsx` — xterm.js
  bound to an OS shell (bash / zsh / cmd) via the streaming
  `window.scelo.exec.*` IPC. PATH is augmented to put the bundled
  Python and R ahead of system binaries, so `python -c 'import lifelib'`
  just works.

The streaming IPC (`scelo:exec:start`/`chunk`/`end`/`write`/`cancel`) is
also available to any Scelo tool that wants to surface long-running
output incrementally — replaces the buffered `runPython` / `runR` for
runs over a few seconds.

## AI providers (chat & orchestrator routing)

Scelo's chat and orchestrator default to **Ollama** running locally
(`qwen2.5:7b-instruct-q4_K_M`). The user can bring their own API key for
hosted models via `/settings/ai`. Catalog:

- **Ollama** (default, local) — no key, no spend.
- **Anthropic** (Claude) — `claude-sonnet-4-6` default, override per request.
- **OpenAI** (GPT / Codex) — `gpt-4o-mini` default.
- **Google Gemini** — `gemini-2.0-flash-exp` default.
- **OpenAI-compatible** — base-URL configurable for LM Studio, vLLM,
  Together AI, Groq, Fireworks, Perplexity, llama.cpp server, etc.

Key storage: inside Scelo IDE keys are encrypted at rest via Electron
`safeStorage` (Keychain on macOS, DPAPI on Windows, libsecret on Linux).
In a regular browser they fall back to localStorage with a visible
warning. The active provider id + headers are attached to every
`streamOrchestrator` call from `apps/web/src/lib/api.ts`; the backend
(`apps/api/ia_api/routers/orchestrator.py`) reads `X-IA-Provider` and
builds a per-request `Orchestrator` instance using `make_provider()` from
`packages/ia-agents/ia_agents/providers/__init__.py`. Default remains
Ollama if no header is sent.

A new sample dataset `lifelib-mp` (in `SoftDataWorkstation.tsx`
`SAMPLE_OPTIONS`) ships 100 synthetic model points shaped like lifelib's
`basic_term_sample.xlsx` (`policy_id`, `age_at_entry`, `sex`, `sum_assured`,
`policy_term`, `duration_mth`, `premium_pp`). Loading it routes the picker
straight to `life` without any LLM call.

### AI picker (`modelPicker.ts`)

Two paths:

- **LLM path** — `fetchModelPicks()` streams the orchestrator with a
  prompt that includes the column shape and a `FAMILY ROUTING` block.
  Output is JSON only. Strict family validation; ids cross-checked
  against the catalog.
- **Heuristic fallback** — `heuristicPick()` reads a `DataSignature`
  (column-name regex hits + type counts) and routes by hard-coded rules:
  triangle → reserving, age×time → mortality, weather/reanalysis →
  climate, etc. Fires when the LLM call fails or the response can't be
  parsed.

The climate signal is intentionally strong: any column matching reanalysis
suffixes (era5 / merra2 / jra3q / ncep / cfsr / nora) or weather-flavoured
prefixes (t2m / tp / wind / etc.) routes to `climate` even without a
geographic column. Reasoning: the user is doing climate-actuarial work,
exposure can be added later.

### Canvas behaviour

- **N handles per side per node.** `MultiHandles` renders `slotCount`
  target+source pairs evenly down the left edge and the right edge of
  every node. Slot 0 on each side is reserved for the hub feed; cross-model
  workflow edges start at slot 1.
- **Two-way connections.** Handles live on left + right only (no top /
  bottom). Users can drag from any handle to any handle.
- **Handle fill state.** A handle dot is **hollow** when nothing is wired
  to it (canvas-bg fill, family-coloured ring) and **solid** when any edge
  — workflow default or user-drawn — lands on either co-located handle at
  that slot.
- **Family-coloured edges.** Hub spokes are tinted by destination
  (matches the model node colour); workflow edges and user-drawn edges
  are tinted by source. Colors come from `FAMILY_COLOR_DARK` /
  `FAMILY_COLOR_LIGHT` in `modelCatalog.ts`.
- **Removable edges.** Every edge uses `type: "removable"` and is rendered
  by `RemovableEdge.tsx`. Hovering reveals a × at the midpoint with a
  solid `bg-bg` backing disc that masks the animated dashed stroke
  underneath. Backspace / Delete also works.
- **Edge labels** also get the `bg-bg` masking treatment so the dashed
  animation never strobes through the text. `labelStyle.fill` is mapped to
  CSS `color` (React Flow's `labelBgStyle` is SVG-only and does nothing on
  HTML labels).

### Node controls (`ToolNode`)

- **× remove** — drops the model from the canvas (round disc, solid
  `bg-bg`, ring in `border-border`).
- **↻ swap** — inline picker grouped by family; the new model takes the
  old model's canvas position.
- **toggle switch** — enable / disable. **Tinted with the node's family
  colour** (orange for climate, blue for mortality, etc.) so the switch
  reads as part of the node, not a generic primary control.

### Workflows table

`WORKFLOWS` in `ToolsWorkstation.tsx` declares domain-specific edge
sequences (e.g. `glm-frequency → glm-severity → × combine`) so that when a
matching set of models is on the canvas, the wires draw themselves with
sensible labels (`feeds`, `combine`, etc.).

---

## 5. Hard Data workstation (`HardDataWorkstation.tsx`)

Hub-and-spoke React Flow graph that flows **inward** into a central
"Board Pack" hub. Each selected model from Tools gets a result node:

- Headline metric (e.g. ultimate, IBNR, AAL).
- Secondary numbers.
- An optional tiny chart (line / bar / boxplot).
- An AI narrative line.

### Model runner (`modelRunner.ts`)

Deterministic client-side computation. For each catalog model the runner
returns a `RunResult`. Heavy methods (Mack, Lee-Carter, CLIMADA) have
Python-side equivalents available via the orchestrator; the client-side
runner keeps a numerically-credible mock so the UI never blocks on a
backend round-trip during development.

### Climate data panel (`ClimateDataPanel.tsx`)

Mounted in the result-detail modal whenever the focused model is in the
climate family (`isClimateFamilyModel(id)`). Shows:

- 4 `SourceCard`s — one each for ERA5, ERA5-Land, MERRA-2, JRA-3Q —
  with role, resolution, coverage, access channels, variables, use cases,
  caveats. Data from `climateDataSources.ts`.
- A pipeline callout (which reanalysis is primary, which is cross-check).
- 2 ensemble charts — t2m and pr — built from `CLIMATE_SAMPLE` rows via
  `ensembleStats(values)`.

### Board pack narrative

When all picked models have completed, an AI prompt assembles a one-page
narrative from `RunResult` summaries. Persists in
`SceloContext.runs[<board-pack-id>]`.

---

## 6. Per-stage AI chat

Three concentric layers:

1. `useNodeChat(stageContext, { memoryKey })` — the underlying hook. Wraps
   `streamOrchestrator()`, manages the message list, exposes `send` /
   `stop` / `isStreaming`. `memoryKey` (when provided) persists the
   conversation in `localStorage`.
2. **Stage context strings** — `SceloNode.STAGE_CHAT` for the macro nodes;
   each workstation builds its own `buildXxxStageContext()` for the
   right-side chat panel. Every context starts with:
   ```
   CRITICAL: DO NOT CALL ANY TOOL. DO NOT dispatch
   documentation.predict, reserving.predict, or any specialist.
   This is a pure chat reply.
   ```
   This is load-bearing — without it the orchestrator tries to dispatch
   to specialists and the chat replies degrade.
3. **Memory key shape** — `${chatMemoryPrefix}:${chatId}` where
   `chatMemoryPrefix` is the active project id (null in explore mode) and
   `chatId` is a per-surface slug: `macro-soft`, `macro-tools`,
   `macro-hard`, `soft-stage`, `tools-stage`, `hard-stage`, `tools-hub`,
   per-column ids, etc. Stable chat threads survive route flips.

### StageChatPanel

`StageChatPanel.tsx` is the persistent right-side chat for the three
workstations. Wider than other panels (defaultWidth=384), wrapped in
`ResizablePanel`, badge driven (`SOFT · CHAT`, `TOOLS · CHAT`,
`HARD · CHAT`).

---

## 7. Operating modes

| mode | chat memory | use |
| --- | --- | --- |
| explore | off (no memoryKey passed) | poking around, demos |
| project | on, keyed by `project.id` | real work — chats persist |

`SceloContext.startProject(name)` / `endProject()` toggle. The project
state hydrates from `localStorage:scelo:project-state`.

---

## 8. Shared state (`sceloContext.tsx`)

`SceloProvider` owns:

- `dataset`, `filters`, `derivedColumns`
- `selectedModels`, `domain`, `pickSummary`
- `runs` (keyed by model id)
- `events` (activity log) + `logEvent` / `clearEvents`
- `mode`, `project`, `chatMemoryPrefix`

Rules:

- `derivedColumns` and `runs` are cleared automatically when the dataset
  changes — stale results never leak across uploads.
- `events` clears on dataset change too — activity log only makes sense
  for a single dataset session.
- Filters survive sub-route navigation but reset with the dataset.

---

## 9. Cross-cutting components

| file | purpose |
| --- | --- |
| `ResizablePanel.tsx` | drag-to-resize + collapse chevron; in-memory state |
| `StageChatPanel.tsx` | persistent right-side chat (all 3 workstations) |
| `ChatInputPill.tsx` | the chat textarea + send/stop pill |
| `SceloChatMarkdown.tsx` | renders chat replies; embeds `viz` blocks |
| `chatViz.tsx` | parses `viz` fences in chat into ECharts |
| `activityLog.ts` | typed `ActivityEvent` history feeding script exporters |
| `scriptExporter.ts` | Python / R / C++ / prompt scripts from the log |
| `ExportScreen.tsx` | the export modal — bundles dataset + scripts + report |
| `RemovableEdge.tsx` | hover-revealed × disconnect for React Flow edges |
| `cleaning.ts` | cleaning plan analysis + apply pipeline |
| `formulaEvaluator.ts` | safe formula compiler for derived columns |
| `geoRegistry.ts` | ZA province registry + geojson loader |
| `zaProvinces.geo.json` | choropleth source |
| `modelTheory.ts` | per-model markdown explainer used in the detail modal |
| `modelRunner.ts` | client-side mock + dispatcher for model computations |

> Why is `Dataset` / `ColumnMeta` exported from `SoftDataWorkstation`?
> Soft Data owns the canonical type definition because it owns the
> ingestion path. Other workstations import the type from there to avoid
> circular module ownership of the shape.

---

## 10. Climate-actuarial pipeline

This is the only domain-specific pipeline currently wired all the way
through soft → tools → hard. It exists because climate / cat work is the
most acutely under-served in the broader actuarial tooling space.

- **Reanalysis registry** — `climateDataSources.ts` lists ERA5 (ECMWF /
  Copernicus, 0.25°, 1940 →), ERA5-Land (0.1°, 1950 →), MERRA-2 (NASA,
  0.5° × 0.625°, 1980 →), JRA-3Q (JMA, 0.375°, 1947 →). Each entry holds
  producer, role (primary / cross-check), spatial / temporal resolution,
  coverage window, licence, access channels (CDS, GES DISC, JMA portal,
  ARCO Zarr mirrors), variables, use cases, caveats.
- **Pipeline mapping** — `CLIMATE_PIPELINE` maps perils (heatwave, flood,
  drought, wind) to `{ primary, crossCheck }` source ids so the panel can
  pre-fill the right reanalyses per use case.
- **Sample data** — `climateSampleData.ts`. 30-day Pretoria Jan-2024 with
  three temperature columns (`t2m_era5`, `t2m_merra2`, `t2m_jra3q`) and
  three precipitation columns (`pr_era5`, `pr_merra2`, `pr_jra3q`).
  `ensembleStats(values)` returns mean / min / max so the chart can plot
  a fan + the three contributors.
- **AI routing** — the picker prompt's `FAMILY ROUTING` block + the
  heuristic's reanalysis regex. Climate-shaped data lands on
  `climada` + `parametric-design` + `descriptive`.
- **Detail panel** — `ClimateDataPanel.tsx` (already covered in §5).
- **Model theory** — `modelTheory.ts` entries for `climada` and
  `parametric-climate` reference the reanalysis ensemble explicitly so the
  detail-modal explainer stays honest about which sources are feeding the
  numbers.

---

## 11. Conventions

### Theme tokens

All colours go through Tailwind theme tokens, never raw hex (except family
colours and reanalysis-sourced ECharts series). Common tokens:

```
bg / bg-1 / bg-2     fg / fg-mute / fg-dim / fg-mute
primary / accent-2 / accent-3 / warn / error / border
```

The React Flow canvas itself uses `bg-bg` for the page colour. Any
floating control (× buttons, edge labels) that lands on top of an
animated edge must have a fully-opaque `bg-bg` backing so the dashed
stroke does not strobe through it. Putting opacity on a child element,
not the backing, preserves the subtle-by-default look.

The palette tracks `intelligentactuaries/website` (the public-facing
site): warm cream / warm charcoal, forest-green `primary` reserved for
*shipped state*, clay-orange `warn` reserved for *in-progress state*.
When introducing UI inside Scelo, prefer those semantics — don't repaint
in green for emphasis, use ink + a tinted border instead.

### Chrome vocabulary

For any *new* page/section header inside Scelo, prefer the shared chrome
helpers (defined in `apps/web/src/styles/theme.css`):

- `.eyebrow` — small mono-uppercase label above titles. Replaces the
  inline `font-mono text-[10px] uppercase tracking-[0.18em] text-fg-dim`
  combo.
- `.display` — editorial serif (Fraunces). Use for h1/h2 above
  dense data; keep body labels in Inter via the body default.
- `.btn-primary` / `.btn-ghost` — pill buttons. Ghost carries a warm
  clay-tinted border that warms further on hover.
- `.underline-grow` — minimal link affordance; underline thickens on
  hover.
- `.glass-card` — liquid-glass surface used by React Flow nodes
  (`SceloNode`, `ToolNode`). Translucent fill + `backdrop-filter: blur`
  + hairline border (tracks `--rgb-border` — same edge the cards had
  pre-glass, so React-Flow edges still land cleanly on a visible border)
  + soft drop shadow + a specular sheen pseudo-element in the top-left.
  Apply to *node-like* surfaces only — full-bleed panels and dense data
  grids should stay opaque (the blur is wasted there and obscures
  readability). Family-coloured borders on `ToolNode` are set via inline
  `style.borderColor`, which wins over the class hairline.
- `.glass-btn` — pill-shaped clickable variant of the glass treatment.
  Same translucent fill + blur + sheen as `.glass-card`, but tuned for
  button size: lighter shadow, hover deepens the fill, active press
  drops by 0.5 px. Combine with `.btn` for default pill padding, or use
  alone if you control padding/sizing yourself.

The macro view header (`routes/Scelo.tsx`) is a reference example.
Existing dense workstation toolbars deliberately stay in the original
utility chrome — don't lift them wholesale; only new surfaces should
adopt these helpers.

### Family palette

Source of truth: `FAMILY_COLOR_DARK` / `FAMILY_COLOR_LIGHT` in
`modelCatalog.ts`. Always look these up via `useTheme().resolved` rather
than hard-coding. Node borders, edges, family chips, and the enable
toggle all draw from the same map.

### Stage accents

Macro nodes use:

| stage | accent class |
| --- | --- |
| soft | `text-accent-2` (cool blue) |
| tools | `text-primary` (green) |
| hard | `text-accent-3` (purple) |

### Lint / format

Biome (`bun x biome check --write` / `bun x tsc --noEmit`). Both must
pass before committing. Imports are organised alphabetically — biome
will fix this for you.

### Editing convention

- Edit existing files; do not create new ones unless the surface is
  genuinely new (e.g. `ClimateDataPanel.tsx` was new because it's a
  distinct concern).
- Don't add backwards-compat shims for in-progress code.
- One short inline comment is fine for *why*; never paragraph-length
  prose explaining *what*.

---

## 12. What's intentionally not built yet

Tracked here so the next contributor (or future Claude session) knows
where the ground is unstable. Update this list as items land.

- **No backend persistence** — datasets, runs, and activity logs live in
  memory + localStorage only. A "save to server" path is open work.
- **`modelRunner.ts` is a deterministic mock** for most heavy methods.
  Wiring the Python / R / Julia bridges through the orchestrator is the
  next slab.
- **Hard Data ↔ Tools loopback** — clicking a hard-data result should
  let the user jump back into Tools with that model focused. Today the
  navigation is one-way.
- **Multi-dataset projects** — `SceloProvider` holds a single dataset.
  Projects with several datasets (e.g. a portfolio split by line of
  business) need a wider `SceloContext.datasets: Dataset[]`.
- **More samples** — only `claims` and `climate` ship. A mortality
  sample, a pricing sample, and a pensions sample are obvious gaps.
- **Drill-down per sub-flow** — the original macro-view design called
  for a second-level flow inside each node. Today the workstations are
  the drill-down; a per-node mini-flow would let the user explore "what
  happens inside a Mack run" graphically. Not yet started.
- **Real climate data fetch** — ERA5 / ERA5-Land / MERRA-2 / JRA-3Q
  ingest from CDS / GES DISC / JMA is *not yet wired*. The sample is
  hand-crafted to look credible; do not present it as a live read. A
  proper data fetcher (probably via the orchestrator's Python side, then
  cached) is the next climate-stack milestone.
- **No tests** — there's no test surface for Scelo yet. When tests do
  land, they should target `modelPicker.heuristicPick`, `cleaning`,
  `formulaEvaluator`, and `modelRunner` first since those are pure.

---

## 13. How to extend Scelo (a checklist)

### Adding a new model

1. Append a `CatalogModel` to `MODEL_CATALOG` in `modelCatalog.ts` with
   `id`, `name`, `family`, `description`, `applicableTo` tags.
2. If it lives in an existing family, no colour work. If it's a new
   family, add the family literal to `ModelFamily`, add palette entries
   to both `FAMILY_COLOR_DARK` and `FAMILY_COLOR_LIGHT`, and add a
   `FAMILY ROUTING` line to `buildPickerPrompt`.
3. Add a runner branch in `modelRunner.ts`. Start with a deterministic
   mock; wire the real compute later.
4. Add a `modelTheory.ts` entry — short markdown that explains the
   assumptions, the failure modes, and the canonical reference.
5. Add a `WORKFLOWS` entry in `ToolsWorkstation.tsx` if the new model
   belongs to a multi-step domain pipeline.
6. Update §4's family list above and the "Adding a new family" steps if
   this is a new family.

### Adding a new sample

1. Add the synthetic data builder to its own file (e.g.
   `pensionSampleData.ts`) — keep the data array small (≤ 100 rows) so
   the bundle stays light.
2. Register it in `SAMPLE_OPTIONS` in `SoftDataWorkstation.tsx` with a
   `kind`, label, row-count summary, and a `build()` function that
   returns a `Dataset`.
3. If the sample needs special model routing, extend the
   `dataSignature()` regex pack and the picker prompt's family routing.
4. If the sample needs a dedicated detail panel (like
   `ClimateDataPanel`), add it under `HardDataWorkstation`'s
   `ModelDetailModal` switch.

### Adding a new stage

Don't, lightly. The soft → tools → hard axis is the product. If a new
stage is genuinely needed:

1. Extend the `SceloStage` union in `SceloNode.tsx`.
2. Add the node to `NODES` in `SceloFlow.tsx` with a new column position
   and an edge from the previous stage.
3. Add a `STAGE_CHAT` entry — including the `CRITICAL: DO NOT CALL ANY
   TOOL` prefix.
4. Add a new workstation component and route it in `routes/Scelo.tsx`.
5. Update `useStageStatus` to read its progress signal from
   `SceloContext`.
6. Update this SKILL.md.

### Updating the climate stack

Anything that changes the reanalysis registry, the sample, the pipeline
mapping, or the model routing should also update §10 here.

---

## 14. Files at a glance

```
apps/web/src/
  routes/
    Scelo.tsx                       ← route + provider mount
  components/Scelo/
    SKILL.md                        ← this file
    SceloFlow.tsx                   ← macro view canvas + ProjectBar
    SceloNode.tsx                   ← macro card + in-card chat
    sceloContext.tsx                ← shared state provider
    SoftDataWorkstation.tsx         ← /soft
    ToolsWorkstation.tsx            ← /tools
    HardDataWorkstation.tsx         ← /hard
    StageChatPanel.tsx              ← persistent right-side chat
    ResizablePanel.tsx              ← drag-resize + collapse
    RemovableEdge.tsx               ← × disconnect for edges
    SceloChatMarkdown.tsx           ← chat reply renderer
    ChatInputPill.tsx               ← chat input
    chatViz.tsx                     ← inline viz blocks in chat
    useNodeChat.ts                  ← chat hook (memoryKey, send, stop)
    modelCatalog.ts                 ← MODEL_CATALOG + family palette
    modelPicker.ts                  ← AI picker + heuristic fallback
    modelRunner.ts                  ← client-side runs (mocks + bridges)
    modelTheory.ts                  ← per-model markdown explainers
    cleaning.ts                     ← cleaning plan
    chatDerive.tsx                  ← `derive` + `transform` chat-action blocks
    formulaEvaluator.ts             ← derived columns (LLM-tolerant)
    columnChatHints.ts              ← per-column placeholder + context
    dirtySampleData.ts              ← "messy intake" demo sample
    SmartColumnDashboard.tsx        ← AI-picked 3 dashboards per column
    ClimateDataPanel.tsx            ← climate-family detail panel
    climateDataSources.ts           ← ERA5 / MERRA-2 / JRA-3Q registry
    climateSampleData.ts            ← Pretoria Jan-2024 sample
    geoRegistry.ts                  ← ZA province registry
    zaProvinces.geo.json            ← choropleth geometry
    activityLog.ts                  ← typed event history
    scriptExporter.ts               ← Python / R / C++ / prompt scripts
    exportDataset.ts                ← dataset → CSV / Parquet
    ExportScreen.tsx                ← export modal
    PlaceholderWorkstation.tsx      ← stub for stages not yet built
```

---

## 15. Update protocol

This file is the single source of truth for the Scelo skill.

- **When you change Scelo behaviour, update this file in the same commit.**
- Use section numbers as anchors; renumber only when adding / removing
  whole sections.
- The "What's intentionally not built yet" list (§12) should shrink as
  features land — when a deferred item ships, move it into the relevant
  section instead of deleting it.
- Until Scelo is feature-complete and ready for publication, keep the
  `status` line in the frontmatter as `in-development`. Flip it to
  `stable` only after a release decision.
