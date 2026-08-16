# SWARM COUNCIL — Instructions

## Table of contents

1. [First-time setup](#first-time-setup)
2. [Provider configuration](#provider-configuration)
3. [Running your first scenario](#running-your-first-scenario)
4. [Layout overview](#layout-overview)
5. [The four tabs](#the-four-tabs)
6. [Graph interactions](#graph-interactions)
7. [Decision sidebar](#decision-sidebar)
8. [Conversation panel](#conversation-panel)
9. [Society parameters](#society-parameters)
10. [IAAI Canon](#iaai-canon)
11. [Mobile](#mobile)
12. [Keyboard shortcuts](#keyboard-shortcuts)
13. [API reference](#api-reference)
14. [Tuning for performance](#tuning-for-performance)
15. [Troubleshooting](#troubleshooting)

---

## First-time setup

```bash
git clone git@github.com:alidenewade/swarm-council.git
cd swarm-council
bun install
```

Two processes run side by side. Open two terminals (or use `tmux`/`screen`):

```bash
# terminal 1 — API
bun src/server/index.ts

# terminal 2 — UI (dev mode with HMR)
bun run dev:client
```

The first server boot does three things:

1. Opens `data/swarm.db` (creates it with `WAL` journaling and the required schema).
2. Probes Ollama at `http://localhost:11434/api/tags` and auto-selects the largest instruction-tuned model available.
3. Initialises the IAAI Canon: if the SQLite `canon` table is empty, attempts a Scholar fetch; on failure, writes an empty stub at `data/iaai-works.json`.

Look at the boot output:

```
[swarm-council] api on http://localhost:3000
[swarm-council] ollama models: 4 (selected: qwen2.5:7b-instruct-q4_K_M)
[swarm-council] canon: scholar (20 works)      # or: existing (N) / stub (0)
```

Open `http://localhost:5180` in a browser. The header status cluster should show `api ok · ollama: <model>` and a canon count.

## Provider configuration

Click **settings** (top-right) or press `Cmd+,` / `Ctrl+,`.

### Cloud API keys

Four password fields:

| provider | key prefix | default model | override |
|----------|-----------|---------------|----------|
| Anthropic Claude | `sk-ant-...` | `claude-sonnet-4-6` | any Claude model id |
| OpenAI | `sk-...` | `gpt-4o-mini` | any chat-completions model |
| Google Gemini | `AIza...` | `gemini-2.0-flash` | any Gemini model |
| Hugging Face | `hf_...` | `meta-llama/Llama-3.1-8B-Instruct` | any router-served model |

Keys are saved to **browser localStorage** and POSTed to the local server, which holds them in process memory only. They are **never written to disk** and **never logged**. Inspect the network tab if you want to verify.

The server redacts any string matching `sk-...` or `Bearer ...` from upstream error responses before sending them back, so a 401 from OpenAI doesn't leak the partial key in the error.

### Claude Code

No key: the server shells out to the **Claude Code CLI already installed and signed in on this machine** (`claude -p`, headless), so runs draw on your Claude plan rather than a metered API. Detected at boot — `claude` on `PATH` or in the usual install spots (`~/.local/bin`, `~/.claude/local`, Homebrew, npm/bun globals; on Windows also `%APPDATA%\npm`) — and again from the **re-detect** button. The section shows the version and path it found, or why it didn't (an npm `.cmd` shim it can't launch, a broken install). Detection proves the install, not the login: press **test claude code** once — a signed-out CLI answers with an explicit "not signed in" message.

- **model override** — blank inherits the CLI's own default (whatever `/model` is set to); or an alias such as `opus`, `sonnet`, `haiku`, or a full model id.
- Each call is a fresh CLI process (~350 MB, ~2–4 s), run at most `SWARM_CLAUDE_CODE_CONCURRENCY` at a time (default 4). Runs neutral: no MCP servers (`--strict-mcp-config`), no built-in tools, no session files, no project CLAUDE.md — a council persona wants none of that.
- Override the binary with `SWARM_CLAUDE_BIN=/path/to/claude` (the IDE's `SCELO_CLAUDE_BIN` is honoured too).
- A full 192-agent council is ~600 calls. On a Pro plan that can exhaust the 5-hour window mid-run (agents then report errors); pin **council** to ollama, or use a smaller subset.

### Ollama

Local-only, no auth. The selector shows every model `ollama list` returns; "auto" picks per the preference order. Use the **refresh** button after pulling a new model with `ollama pull <name>`.

### Provider preference per tier

Three tiers, three dropdowns:

- **council** — used for the 192-agent deliberation. Auto = first available cloud key, else Claude Code, else Ollama.
- **society** — used for the 1000-agent population. Auto = Ollama (cheap and fast locally), else first cloud key, else Claude Code.
- **chat** — used for the chatbot. Auto = first available cloud key, else Claude Code, else Ollama.

Claude Code sits between the keys and Ollama on purpose: it is metered like the cloud (your plan), but merely having the CLI installed is not the deliberate act that pasting a key is, so a connected key still wins. You can force a specific provider per tier (e.g. council on Claude Code, society on Ollama, chat on Gemini).

### Test buttons

Sends a tiny "hello world" prompt through the router on the selected tier, shows provider/model/elapsed-ms. Useful sanity check after adding a key. **test claude code** pins the provider instead of routing by tier, so it exercises the CLI even when a cloud key would otherwise take every tier — and doubles as the sign-in check.

### Clear cache

The router caches every `sha256(provider + model + messages + opts)` → response in SQLite. Re-running the same scenario returns instantly from cache. **Clear cache** wipes the table. Individual fresh runs can also bypass cache without wiping (see below).

## Running your first scenario

1. Type or paste a scenario into the **centred scenario card** on the canvas. The textarea auto-grows as you type up to a ceiling, then scrolls. The chips below the card are pre-loaded example scenarios — click one to load it.
2. Open the **left sidebar** (panel-left icon top-left, or expand from the collapsed rail) and pick a council **subset**: `12` (fast smoke test, 2 agents per profession) → `24` → `48` → `96` → `full 192`. Subsets stratify across all 6 professions.
3. (Optional) adjust the **society size** slider in the Society parameter accordion (default 200).
4. (Optional) check **bypass cache** in Run controls if you want a fresh sample instead of cached responses.
5. Press the **Run Swarm** button on the scenario card, the **Re-run analysis** button at the bottom of the left sidebar, or `Cmd+Enter` / `Ctrl+Enter` from anywhere outside the conversation panel.

What happens:

- The server kicks off the run asynchronously and returns a `runId` immediately.
- The client opens an `EventSource` on `/api/run/:id/stream` and starts showing progress bars in the sidebar (one per round + one for society).
- The thin accent-coloured progress bar at the top of the canvas tracks overall completion (council weighted 60 %, society 40 %).
- Council round 1 → independent views in parallel.
- Round 2 → each agent sees a stratified digest of round-1 peers (4 same-profession + 4 cross-profession).
- Round 3 → each agent emits a strict JSON vote `{ stance, confidence, key_risk }`.
- Society agents fire in parallel, each producing `{ reaction, sentiment, intensity }`.
- On `done`, the client fetches the full run and renders the council graph.

Typical timings on a 5090 / RTX-class GPU with local qwen2.5:7b:

| subset | council | society=200 | total |
|--------|---------|-------------|-------|
| 12     | ~12 s   | ~30 s       | ~45 s |
| 48     | ~30 s   | ~30 s       | ~65 s |
| 192    | ~150 s  | ~30 s       | ~180 s |

Cloud providers (Claude/OpenAI) are typically faster end-to-end despite the network because they parallelise better than a single local GPU. They are also far more accurate at the JSON-vote stage.

## Layout overview

The desktop shell is a five-column grid. From left to right:

| column        | purpose                                                                 |
|---------------|-------------------------------------------------------------------------|
| **left rail** | 44 px-wide always-visible column. Hosts the panel toggle and (when the sidebar is collapsed) one icon per sidebar section. Clicking an icon pops out a flyout next to the rail. |
| **sidebar**   | Settings accordion: Subset · Run controls · Society parameter · Income / Education / Employment mix · Culture · Providers. Sticky **Run analysis** / **Re-run analysis** button pinned at the bottom. Width is drag-resizable; collapse to the rail to hand back canvas space. |
| **canvas**    | The active tab — Council, Society, Synthesis or IAAI Canon. The view-tab strip sits in the top header. |
| **decision sidebar** | Right panel #1. Inspector for whatever is selected: an agent (node click), a profession (legend pin), a society cluster or sentiment (legend pin), or a Sankey segment (click-lock). Collapsible to a vertical handle. |
| **conversation panel** | Right panel #2. Chat with the swarm about this run, or switch to **refine** mode to edit the scenario and re-run. Collapsible to a vertical handle. |

Each of the three panels (sidebar, decision, conversation) has its own
**resize handle** (drag the divider) and persists its width and
open/closed state to `localStorage` so layout choices survive reloads.

### Re-running

The bottom-of-sidebar **Re-run analysis** button takes whatever is in
the scenario card AND every current sidebar setting (subset, society
size, mixes, culture, providers) and starts a new run. The refine input
in the conversation panel is the same idea but lets you also edit the
scenario inline before re-running.

### Narrow viewports

When the canvas gets squeezed (e.g. both right panels open at once) a
CSS container query at 880 px flips the council and society stacks from
side-by-side to stacked: graph above, Sankey below. The legend hops to
the top-right of the canvas so it doesn't ride down with the centred
group. Below a 820 px viewport the layout switches to the mobile shell
(see [Mobile](#mobile)).

## The four tabs

### Council

The Council tab renders two visualisations side-by-side (stacked on
narrow canvases): the **force-directed graph** on the left/top and the
**decision Sankey** on the right/bottom.

**Force-directed graph.** ECharts node-link layout of the 192 (or
subset) agents. Each node:

- **Fill colour** — profession (8 colours in the top-right legend; click a legend chip to pin → the decision sidebar opens on that profession; click again to unpin).
- **Border colour** — final stance: green = support, red = oppose, grey = abstain.
- **Size** — final-vote confidence (0-100 mapped to 6-20 px).

Edges connect agents whose round-2 reasoning is similar (Jaccard on
stopword-filtered tokens, weighted by stance match). Each agent keeps
its top 4 edges above a 0.18 threshold. After the force layout cools,
every node is pinned at its converged position (`fixed: true`) so the
graph stays still — no ambient drift.

**Click a node** → the decision sidebar shows the **Agent Inspector**
with the full persona, all three rounds of reasoning, and the final
vote. Hit `Esc` to close.

**Decision Sankey.** Three-stage flow: profession → stance → confidence
band. Hovering a segment dims everything else and **dims the
corresponding nodes in the force-graph too** (cross-chart hover sync).
**Clicking a Sankey segment locks** the highlight and pops the
**Sankey Segment Inspector** into the decision sidebar with stats and
exemplar agents.

### Society

Same side-by-side layout as Council: a sparser **force graph** plus a
**society Sankey** (cluster → sentiment → intensity band).

Force-graph nodes:

- **Fill colour** — sentiment, on a gradient from enthusiastic (green) → supportive (light green) → neutral (white) → skeptical (amber) → hostile (red). Sentiment key overlay top-left.
- **Size** — intensity (0-100).
- **Category** — k-means cluster (k=6). Legend top-right shows each cluster's modal description (`age ≈ 37 · upper-mid · secondary · urban · employed`).

Hover for the agent's actual reaction text plus their demographic tag.

**Legend pins.** Click a cluster chip (`c0`…`c5`) or a sentiment swatch
to pin it. The decision sidebar opens with the **Society Inspector** —
size, sentiment mix, sample members for clusters; count, intensity
distribution, sample reactions for sentiments. Click again to unpin.

**Sankey** behaviour is identical to the Council Sankey: cross-chart
hover sync and click-to-lock for the segment inspector.

### Synthesis

The "structured input for the professor" view, not a decision:

- Stance stack-bar with percentages.
- Consensus score, dissenter count, agent count.
- **By profession** table — votes broken out per profession. Watch for asymmetry (e.g. Actuaries strongly opposed, Investors split).
- **Top risks (clustered)** — key_risk strings normalised on lowercased first-6-tokens, with highest-confidence original phrasing kept for display.
- **Dissenting agents** — clickable rows sorted by confidence. Click to open the inspector on that dissenter.

### IAAI Canon

Browse and edit the canon. See the dedicated section below.

## Graph interactions

Both Council and Society tabs use the same interaction grammar.

### Force-graph

- **Hover a node** — preview highlight: that node + its neighbours stay
  full-opacity, everyone else dims. The Sankey segment(s) the agent
  belongs to dim in lockstep (cross-chart sync).
- **Click a node** — opens the decision sidebar with the Agent
  Inspector (Council) or Society agent details. Selection persists.
- **Click an empty area** of the graph — clears the hover; the click-
  locked selection (Sankey segment) is preserved.
- **Hover the container exit edge** — clears ephemeral hover, but
  click-locked highlights and Sankey-originated highlights survive.

### Legend

- **Hover** a profession / cluster / sentiment chip — same dim effect
  as hovering matching nodes.
- **Click** to pin → the decision sidebar opens on that group. Clicking
  the same chip again unpins. Only one pin per legend at a time.

### Sankey

- **Hover a segment** — bold dim across the Sankey AND the matching
  agents in the force graph dim in.
- **Click a segment to lock** — the click-lock survives mouse exit;
  the **Sankey Segment Inspector** loads in the decision sidebar with
  the segment's stats and a sample of its members. Click empty space
  in the Sankey, or close the inspector, to release.

### Click priorities

When more than one selection mode is active at once, the decision
sidebar picks the most specific:

1. **Sankey click-lock** (most specific — wins on Council / Society tabs)
2. **Agent click** (selected node)
3. **Profession / cluster / sentiment pin** (legend)
4. Empty state copy

## Decision sidebar

Right panel #1. Everything you select feeds into one of four inspector
views:

| trigger | view |
|---------|------|
| Click an agent node | **Agent Inspector** — persona, all three rounds of reasoning, final vote, optional jurisdictional justification block |
| Pin a profession (Council legend) | **Group Inspector** — collective stance, members, group justification |
| Pin a cluster or sentiment (Society legend) | **Society Inspector** — size, sentiment mix, intensity, sample reactions |
| Click-lock a Sankey segment | **Segment Inspector** — segment stats + exemplar agents |

The header includes a collapse button (panel-left icon) that hides the
panel; the canvas reclaims the space immediately. A vertical handle
appears on the right edge — click it to bring the panel back.

On the **Synthesis** tab, the agent-click and profession-pin paths
remain; clicking a dissenter row in the synthesis table opens the same
Agent Inspector. On the **Canon** tab, the decision sidebar shows a
canon-flavoured empty state.

## Conversation panel

Right panel #2. Two modes share one input area, toggled by the pill at
the top of the panel:

### Chat mode (default)

The conversation chatbot has the **entire run state** injected into its
system prompt:

- Scenario + the condensed IAAI Canon
- Council synthesis (stance percentages, consensus score, clustered top risks)
- Full council agent table (`id | profession/mbti/gender | stance | confidence | risk`)
- Top-5 dissenters' round-2 reasoning verbatim
- Society sentiment mix, per-cluster sentiment, sample reactions

Rules baked into the system prompt:

- Answer only from the data provided.
- Cite agents by id (e.g. `c-actuary-intj-f`).
- Be terse.
- Do not invent agents, quotes, or numbers.
- The swarm does not decide — it reports so the professor can.

Tokens stream in real time from Ollama; cloud providers emit one chunk
through the same SSE shape.

Assistant messages are rendered with a lightweight Markdown renderer
(ATX headers, bullets, blockquotes, inline `code` / *italic* /
**bold**, fenced code blocks). The renderer escapes HTML so model
output can't inject markup.

Multi-turn history is preserved within a chat session; switching to a
different run clears history.

**Sample prompts** appear as pills when history is empty:

- *why did the actuaries dissent?*
- *compare the council majority to the society majority*
- *which agents would change their vote if leverage were 1.2x?*
- *give justifications for the investors and actuaries*

Click a pill to send. Otherwise: `Enter` to send, `Shift+Enter` for
newline, `⌘ Enter` / `Ctrl+Enter` also sends. The **Stop** button
aborts an in-flight stream.

### Refine mode

The textarea binds directly to the current scenario. **`Enter` inserts
a newline** (scenarios are often multi-line); only **`⌘ Enter` /
`Ctrl+Enter`** submits. Submitting:

1. Replaces the canonical scenario with the textarea value.
2. Re-runs the swarm with every current sidebar setting (subset,
   society size, providers, mixes, etc.).

While a run is in progress the button reads **running…** and is
disabled. The chat side of the panel keeps working — you can ask
questions about the previous run while the next one streams.

### Sizing

The input auto-grows as you type up to 200 px, after which content
scrolls inside the textarea. No manual resize grip. The panel itself
is drag-resizable on desktop and has a collapse button in the header.

## Society parameters

All sliders feed into a seeded sampler (mulberry32) so the same parameters produce the same agents across runs.

| parameter | range | meaning |
|-----------|-------|---------|
| size | 50 – 1000 | how many society agents to sample |
| age mean | 18 – 70 | Gaussian centre |
| age spread | 4 – 30 | Gaussian half-spread (clamped 16-85) |
| urban ratio | 0 – 1 | share urban; the remainder splits 50/50 between periurban and rural |
| risk tolerance | 0 – 1 | population centre; per-agent values jitter ±0.2 |
| financial literacy | 0 – 1 | same jitter rule |
| culture | text | injected into each agent's persona literally |
| income mix | 5 sliders | low / lower-mid / mid / upper-mid / high — relative weights |
| education mix | 4 sliders | primary / secondary / tertiary / postgrad — weights |
| employment mix | 6 sliders | employed / self-employed / informal / unemployed / student / retired — weights |

Mixes do **not** need to sum to 1. They are relative weights; the server normalises at sample time. A single slider at 1.0 with others at 0 means that bucket is sampled exclusively.

## IAAI Canon

The canon is the list of Prof IAAI's published works that gets injected into every council agent's system prompt under the heading `## IAAI Canon — apply where relevant`. Agents are explicitly told: *if the canon is empty or irrelevant, say so — do not fabricate.*

### Where canon lives

- **SQLite** `canon` table in `data/swarm.db` (source of truth, persisted across restarts).
- **`data/iaai-works.json`** — empty stub written on first boot when Scholar fetch fails. Not the source of truth; just informational.

### Three ways to populate

**1. Scholar auto-fetch (server startup).** If the canon is empty when the server boots, it tries `https://scholar.google.com/citations?user=LNmZYWgAAAAJ&hl=en` with a realistic user agent. Scholar often blocks scrapers, but it sometimes succeeds and returns ~20 real publications. The parser pulls titles + years from the `gsc_a_tr` table rows.

**2. Manual paste (Canon tab).** Add rows directly with title / year / url / takeaway / abstract. Takeaway is the most important field — it's what the model reads and applies. Hit **save**.

**3. Import (Canon tab → import block).** Two formats:

- **JSON** — either a bare array or `{ "works": [...] }`. Each work needs at least `title`; optional `year`, `abstract`, `url`, `takeaway`.
- **BibTeX** — standard entry blocks. The parser extracts `title`, `year`, `abstract`, `url`, `doi` (DOI is resolved to `https://doi.org/...` if no explicit URL).

Pick **append** (add to existing) or **replace** (wipe and reload). Click **upload file** to load from disk; **sample** to load an example you can edit.

### Writing good takeaways

A takeaway should be one sentence in present tense that the model can apply to a scenario:

- Good: *"Beyond a 5-year lock-up, concentration risk dominates currency risk for ZAR-denominated mandates."*
- Bad: *"This paper studies the role of concentration risk in long-duration investments."* (descriptive, not applicable)

When a canon entry is loaded, council agents cite it by title in their round-1 / round-2 reasoning if it bears on the scenario.

## Mobile

Below an 820 px viewport the layout collapses to a single-column shell.

- **Topbar** is two rows: brand + help / settings actions on row 1; a
  horizontally-scrollable tab strip (council · society · synthesis ·
  iaai canon) on row 2. The api / ollama / canon telemetry text is
  hidden — the settings vault holds it.
- **Left rail and resize handles are hidden.**
- **Canvas** owns the screen; the council and society stacks use the
  same container-query layout (graph above, Sankey below) as a narrow
  desktop canvas.
- **Bottom nav** (56 px + safe-area inset) has three pill buttons:
  - **☰ Settings** — slides the sidebar in from the left.
  - **⊕ Decision** — slides the decision panel up as a 70 vh bottom sheet.
  - **💬 Chat** — slides the conversation panel up as an 82 vh bottom sheet.
- **One panel at a time.** Tapping a nav button closes the other two
  panels first. Tapping the active nav button or the dimmed backdrop
  closes the open panel.
- **Auto-open behaviour.** Selecting an agent (node tap), pinning a
  profession / cluster / sentiment, or click-locking a Sankey segment
  closes any other panel and opens the decision sheet.

The conversation panel keeps its **chat / refine** toggle in the
mobile sheet. Refine still requires `⌘ Enter` / `Ctrl+Enter` to submit
because `Enter` inserts a newline.

Browser support for the underlying CSS (container queries, custom
properties, `env(safe-area-inset-bottom)`) requires Chrome 105+,
Firefox 110+, Safari 16+.

## Keyboard shortcuts

| keys | action |
|------|--------|
| `Cmd+Enter` / `Ctrl+Enter` | run swarm (from anywhere except the scenario card and conversation refine input) |
| `Cmd+,` / `Ctrl+,` | toggle API key vault / providers modal |
| `Cmd+/` / `Ctrl+/` | show / hide keyboard help |
| `Esc` | close help → vault → clear selected agent → close mobile panel |

Inside the conversation panel:

| mode | keys | action |
|------|------|--------|
| chat | `Enter` | send |
| chat | `Shift+Enter` | newline |
| chat | `⌘ Enter` / `Ctrl+Enter` | send |
| refine | `Enter` | newline (scenarios are multi-line) |
| refine | `⌘ Enter` / `Ctrl+Enter` | re-run with edited scenario |

## API reference

All endpoints live under `/api`. The Vite dev server proxies them to the Bun server.

### `GET /api/health`

`{ ok: boolean, time: number }`. SQLite handshake.

### `GET /api/providers`

```jsonc
{
  "configured": { "anthropic": false, "openai": false, "gemini": false, "hf": false },
  "ollamaModels": ["..."],
  "ollamaSelected": "qwen2.5:7b-instruct-q4_K_M",
  "prefs": { "councilProvider": "auto", "societyProvider": "auto", "chatProvider": "auto", "models": {} }
}
```

### `POST /api/providers`

Body: `{ keys?: {anthropic|openai|gemini|hf: string|null}, prefs?: Partial<ProviderPrefs>, refreshOllama?: boolean }`. Returns the same shape as GET. Set a key to `null` to unset.

### `POST /api/test`

Body: `{ tier?: "council"|"society"|"chat", provider?: <explicit>, prompt: string, system?: string, fresh?: boolean }`. Returns `{ provider, model, response, elapsedMs, cached }`.

### `DELETE /api/cache`

Returns `{ cleared: number }`.

### `POST /api/run`

Body: `{ scenario, subset?, societySize?, societyParams?, providerPrefs?, fresh?, canon? }`. Returns `{ runId, status }` immediately. The run executes async.

### `GET /api/run/:id`

Full run object with council results, council edges, society results, society edges, society summary, top-level summary.

### `GET /api/run/:id/agents/:agentId`

Single council agent's full record (3 rounds + final vote).

### `GET /api/run/:id/stream`

Server-Sent Events. Each event is `{ type: ... }`:

| type | shape |
|------|-------|
| `status` | `{ status: "running"|"complete"|"failed" }` |
| `round_start` | `{ round: 1|2|3, total: number }` |
| `agent_done` | `{ round, agentId, done, total }` |
| `round_done` | `{ round, total, elapsedMs }` |
| `society_start` | `{ total }` |
| `society_progress` | `{ done, total }` (throttled) |
| `society_done` | `{ total, elapsedMs }` |
| `done` | `{ runId, summary }` |
| `error` | `{ message, agentId?, round? }` |

Late subscribers get replayed history before live events.

### `POST /api/chat`

SSE. Body: `{ runId, message, history?, fresh? }`. Events: `{type:"chunk", text}`, `{type:"done", provider, model}`, `{type:"error", message}`.

### `GET /api/canon`

`{ works: CanonWork[] }`.

### `POST /api/canon`

Body: `{ works: CanonWork[] }`. Replaces. Returns `{ count, works }`.

### `POST /api/canon/import`

Body: `{ format: "json"|"bib", text: string, mode?: "replace"|"append" }`. Returns `{ imported, count, works }`.

## Tuning for performance

### Local Ollama

- Pick a model in the 4B–8B parameter range. `qwen2.5:7b-instruct-q4_K_M`, `llama3.1:8b`, `gemma3:7b` all work well. 20B+ models are accurate but slow at the 192-agent council size.
- Concurrency cap is 32 simultaneous Ollama calls (set in `LLMRouter`). Ollama internally batches per `OLLAMA_NUM_PARALLEL`; the default of 4 is sometimes raised to 8 for more parallelism. Set `OLLAMA_NUM_PARALLEL=8` in the Ollama daemon environment.
- Subset = 24 is a good development default. Full 192 is for the final pass.
- Society size = 200 is enough for a useful sentiment estimate. 1000 only adds resolution.

### Cloud providers

- Concurrency cap is 8 simultaneous cloud calls.
- Cache is keyed on the exact prompt + model + opts. If you tweak the scenario, only changed prompts re-run; unchanged ones return from cache.
- Council on Claude or GPT-4o is dramatically more accurate at the JSON-vote stage than 7B local models.
- Society on Ollama, council on cloud, chat on cloud is a sensible default mix.

### Cache

- Located in `data/swarm.db`, table `cache`. Each row keeps prompt hash + provider + model + response + created_at.
- Cleared with the **Clear cache** button in Settings or `DELETE /api/cache`.
- Per-run "bypass cache" checkbox forces a fresh sample for that run only.

## Troubleshooting

### "no provider available"

The server has no Ollama and no cloud keys. The sidebar and canvas will both show a banner. Either start Ollama:

```bash
ollama serve &
ollama pull qwen2.5:7b-instruct-q4_K_M
```

or open Settings (`Cmd+,`) and paste a cloud key.

### Council runs slowly

Either the model is too large for your GPU, or `OLLAMA_NUM_PARALLEL` is set low. Try a smaller model or set the env var higher and restart Ollama.

### Round-3 JSON parse failures

The parser is robust (code-fence stripping, brace extraction, regex fallback, abstain default). Failures show up as `(parse failed)` in the agent's key risk. Cause is usually the model adding prose around the JSON. A larger model fixes this immediately.

### Society agents misread the scenario

The default society persona prompt tells agents they are "not a financial expert; react as an ordinary person." Sometimes a local 7B will collapse "a pension fund is considering" into "I am considering" and react as if their personal savings were at stake. This is an LLM artifact, not a structural bug. The reactions are still useful as a sentiment signal.

### Scholar fetch fails

Expected most of the time — Google blocks scrapers. The server writes an empty stub to `data/iaai-works.json` and continues. Use the manual paste or BibTeX import in the Canon tab.

### Port already in use

```bash
lsof -i:3000 -t | xargs -r kill        # API
lsof -i:5180 -t | xargs -r kill        # UI
```

### Cache poisoning a tuning loop

If you iteratively tweak persona prompts but keep getting old council results, clear the cache: Settings → **Clear cache**, then check **bypass cache** on your next run.

### Reset everything

```bash
rm data/swarm.db data/swarm.db-wal data/swarm.db-shm
```

The schema is re-created on next boot.
