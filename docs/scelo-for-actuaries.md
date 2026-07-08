# Scelo: An Offline, Audit-Traceable Actuarial Workbench with AI Co-Pilots and a Multi-Agent Deliberation Engine

*A comprehensive technical description for actuarial-science academics and researchers.*

---

## Abstract

**Scelo** is a desktop workbench for actuaries built by **Intelligent Actuaries (Pty) Ltd**. Its organising thesis is a single, one-directional, auditable pipeline — *soft data → tools → hard data* — in which raw, uncommitted inputs are transformed by a library of statistical and actuarial models into board-pack-ready numbers, with every step recorded and re-derivable. Three properties distinguish it for a research audience: (i) it runs **fully offline** once installed, bundling its own Python and R runtimes and the reference actuarial stack, so computation on confidential policyholder data never leaves the machine; (ii) the pipeline is **one-way and traceable** — "the tools layer is where the audit trail lives," and any analysis can be exported as a runnable Python, R, or C++ script; and (iii) it couples conventional actuarial computation to an **AI layer** — per-stage co-pilots that *execute* deterministic data operations rather than merely describe them, plus a separable "swarm" server that performs stochastic **nanoeconomics survival simulation (WMTR)**, a **256-agent expert-deliberation council**, and a **1,000-agent behavioural population micro-simulation**, all grounded in cited actuarial standards and literature.

This document surveys the whole system and, throughout, frames each capability in terms of how a practising or academic actuary would use it and what methodological benefit it confers.

---

## 1. Positioning and design thesis

Scelo describes itself plainly: *"A desktop workbench for actuaries who want AI-assisted analysis without sending client data to a cloud."* It takes a modeller "from raw data to board-pack-ready results in one place, with a bundled Python and R runtime, the actuarial stack (lifelib, chainladder, climada, and more), and AI co-pilots scoped to each stage of the work."

Four stated pillars organise the product:

1. **Offline + private.** The bundled Python/R runtime and a local LLM (Ollama) mean client data need never leave the machine; hosted AI providers are strictly opt-in.
2. **A pipeline, not a pile of scripts.** *Soft data → tools → hard data* is a guided flow in which each stage carries its own scoped AI assistant.
3. **Two surfaces in one app.** A guided pipeline for structured analysis, and a full VS Code-style workspace (Monaco editor, integrated terminal, git, language servers) for open-ended modelling.
4. **Reproducible.** Every action can be exported as a runnable Python, R, or C++ script from a recorded activity log.

The intellectual core is the **one-way, auditable pipeline**: *"soft never writes to hard directly, hard never reads from soft. The tools layer is the only path between them."* This is not merely an interface convention; it is a governance stance. The transformation layer is the locus of the audit trail, and hard data is defined as output that is *"defensible, reproducible, traceable."* For an actuary, this reproduces in software the discipline of the actuarial control cycle: a clean separation between the evidence base, the model, and the reported figure, with a documented path between them.

A conceptual analogy from the project's own documentation fixes the vocabulary: *temperature is soft, a thermometer is the tool, 24 °C is hard.* Soft data is *"what you cannot easily see or decide on — raw inputs, fuzzy signals, uncommitted material";* hard data is *"board-pack-ready numbers."*

> **Terminology note.** This document uses Scelo's own documented language — *offline and private*, *auditable / traceable / defensible*, *board-pack-ready* — rather than looser marketing shorthand. The bundled interpreters are **Python and R** (with C++ and natural-language "prompt" as additional *export* targets); Scelo does not bundle or invoke Julia.

---

## 2. The paradigm: soft data → tools → hard data

The pipeline is realised as three "workstations," bound by a single shared application state (`SceloProvider` / `SceloContext`). That state owns the dataset, active filters, derived columns, selected models, per-model run results, and a typed activity log. Critically, **derived columns, model runs, and the event log are auto-cleared whenever the dataset changes**, so stale results can never leak across uploads — a small but important guarantee for auditability.

| Stage | Role | Actuarial analogue |
|---|---|---|
| **Soft Data** | Ingest, profile, clean, and shape a CSV/Parquet; engineer and impute columns | Data audit, exposure preparation, triangle assembly |
| **Tools** | Route the prepared data to model families and run them | Model selection and fitting under the control cycle |
| **Hard Data** | Assemble result nodes into a board pack with diagnostics and narrative | Reporting, reserve/capital sign-off, disclosure |

The two "surfaces" — the guided pipeline and the full IDE workspace — share **one renderer codebase**. There is no separate IDE front-end; the same React application either runs in a browser (evaluation) or is wrapped in an Electron shell with bundled interpreters (the desktop IDE). This is what lets a reviewer inspect the identical analytical surface in either environment.

---

## 3. The Soft Data stage: data preparation as an auditable, reproducible act

Data quality is where reserving triangles and mortality exposures are silently poisoned, and Scelo treats preparation as a first-class, reproducible activity rather than an undocumented preamble.

### 3.1 Profiling

On ingest, `summariseDataset()` computes a per-column `ColumnMeta`: inferred type (number / string / date), count, missing, unique, the five-number summary (min / Q1 / median / Q3 / max), mean, **Tukey fences**, and flagged outliers or top-value counts. This is the descriptive-statistics and missingness triage that must precede any fit.

### 3.2 Chat-driven cleaning that *executes*

Each stage carries an AI assistant, but — and this is the design point — the assistant's suggestions are executed by deterministic engines, and the **deterministic before/after summary is the source of truth; the model's prose is interpretive context only.** The assistant emits one of five fenced markdown blocks that the renderer intercepts and runs against the live dataset:

| Block | Effect |
|---|---|
| `derive` | Add a **new** column from a formula (`{"name":"paid_rounded","formula":"round(paid)"}`), idempotent on the name |
| `transform` | Replace an **existing** column in place, idempotent on a `(column::formula)` fingerprint |
| `clean` | Run the deterministic cleaning engine (`{"ops":"safe"}`, `"all"`, or an explicit op list) |
| `recode` | Exact categorical value rewrite (`{"column":"marital","from":"Seperated","to":"Separated"}`) |
| `viz` | Render an inline chart/stat-table from a JSON spec |

Every applied block renders a `buildChangeSummary`: cells changed, percent changed, cells newly nulled, the shift in the mean (Δ), the change in range, and up to four sampled `old → new` pairs. If a requested operation does not apply, the engine renders an honest "nothing to apply" card rather than implying work that did not happen — closing the gap between an LLM *claiming* a cleaning step and the step actually occurring.

The **cleaning engine** (`analyseCleaning` → `applyCleaning`) offers fifteen independently toggleable operations, with the safe subset pre-selected and destructive operations opt-in:

- *Safe (cell/column-level):* trim, collapse whitespace, fix mojibake/BOM/zero-width artefacts, normalise missing tokens (`N/A`, `?`, `-`, `TBD` → null), parse numeric strings (stripping `$`, commas, `%`, parentheses, currency codes when ≥ 80 % are numeric), parse dates to ISO-8601 (≥ 80 % date-shaped), standardise booleans, replace repeated numeric sentinels (e.g. `-999`/`9999` lying > 5·IQR outside the range), and null future years.
- *Destructive (opt-in):* drop duplicate rows, drop > 95 %-empty columns, drop constant columns, merge case-only categorical duplicates, snake_case headers.

Sentinel and duplicate detection is **sampled above 200 k rows** for sub-second interaction, while the actual apply always runs at full fidelity. A large alias table maps how LLMs phrase requests ("dedupe", "fix nulls", "snake case the headers", "mojibake") onto canonical operations.

**Why it matters.** The sentinel handling (a `-999` masquerading as an age), the currency/date canonicalisation, and the case-merge of categorical buckets are precisely the corruptions that distort a development triangle or an exposure table — and here they are performed by a deterministic, inspectable engine and recorded for export, not buried in ad-hoc scripts.

### 3.3 The formula DSL: a sandboxed language for feature engineering and imputation

Derived and transformed columns are computed by a restricted expression compiler (`formulaEvaluator.ts`): tokeniser → aggregate-substitution pass → identifier whitelist → codegen to a guarded function. Nothing reaches `fetch` or `window`; an unknown column raises an *explainable* error (`unknown column 'paud'`) rather than a runtime exception. The supported vocabulary is deliberately actuarial-calculation-shaped:

- **Arithmetic / comparison / logic:** `+ - * / % **`, `== != > >= < <=`, `&& ||`.
- **Math:** `log log10 log2 exp sqrt abs min max floor ceil round pow sign sin cos tan`.
- **Logic:** `if(cond, a, b)`, `coalesce(a, b, …)`, `isnull(x)`.
- **Strings:** `lower upper trim len replace concat str`.
- **Dates (timezone-free calendar arithmetic):** `to_iso_date to_us_date to_eu_date to_long_date year month day weekday`, with a bespoke Y-M-D type that never constructs a date from an ambiguous string (fixing the classic "31/12 → 30/12" UTC-drift bug) and disambiguates D/M/Y vs M/D/Y.
- **Column aggregates (folded to compile-time literals over the rows):** `mean median mode colmin colmax colsum colcount stdev`.

The aggregate functions are, explicitly, *the basis for imputation*: `if(value == -999, mean(value), value)` replaces a sentinel age with the column mean; `coalesce(value, median(value))` fills nulls; `min(max(x, loFence), hiFence)` winsorises at Tukey fences; `log(value + 1)` normalises skew before a linear fit.

### 3.4 Column-scoped assistants with methodological guardrails

Every column receives its **own** scoped assistant whose system prompt (`buildColumnStageContext`) embeds the column's summary statistics and a per-type cleaning *playbook* grounded in the Wickham/pandas canon — an eleven-step order for strings/categoricals, a seven-step order for numerics (sentinel nulling, range enforcement for "negative ages, ages > 120", winsorisation only for errors not fat-tail signal, Box–Cox/Yeo–Johnson for skew), and a five-step order for datetimes (DD/MM vs MM/DD "classic silent corruption", Excel's 1900-02-29 ghost day). The prompt injects **train/test discipline** ("impute on TRAIN ONLY"; "vocabulary is FIT ON TRAIN — unseen categories hit a deterministic 'other' bucket") and a degenerate-IQR guard (when Q1 = Q3, offer a percentile cap rather than flattening the column).

**Why it matters.** The leakage-avoidance and the outlier-vs-signal judgement baked into these prompts are exactly the distinctions that separate a defensible actuarial dataset from a naïvely "cleaned" one — and they are surfaced at the point of decision.

---

## 4. The Tools stage: model selection and the two-engine reasonability check

The Tools workstation is a node canvas with the dataset at the hub and selected models orbiting it; cross-model workflow edges (e.g. `glm-frequency → glm-severity → combine`) draw automatically. Model selection is either LLM-driven (from a described intent) or heuristic.

The methodologically important design choice lives beneath every quantitative model: **two independent implementations of each method** — a pure-TypeScript in-browser port for live exploration, and a **bridge** to the canonical Python/R library for board-grade numbers. The stated rationale is auditor-grade: *"the same number out of two independent implementations is the cheapest possible reasonability check."*

Each bridge follows an identical fail-soft contract: if not running inside the desktop IDE, or if the required runtime/package is absent, it returns `null` and the renderer transparently falls back to the TypeScript port. The ten bridges delegate to the reference libraries an actuary would expect:

| Bridge | Runtime | Canonical library / method |
|---|---|---|
| `chainladderPython` | Python | `chainladder` — Chainladder, MackChainladder, BornhuetterFerguson, BootstrapODPSample |
| `lifelibBasicTermPython` | Python | `lifelib` `BasicTerm_M` |
| `ifrs17CsmPython` | Python | `lifelib` `ifrs17sim` CSM roll-forward |
| `leeCarterPython` | Python | numpy SVD Lee–Carter |
| `glmPython` | Python | `statsmodels` GLM |
| `climadaPython` | Python | `CLIMADA` (LitPop exposures, IBTrACS hazard, impact) |
| `lifecontingenciesR` | R | `lifecontingencies` — `axn`, `Axn`, `nEx` |
| `whoMortalityPython` | Python | WHO GHO life tables |
| `chemblPython` / `nfipPython` | Python | ChEMBL drug data / NFIP flood claims |

Reproducibility is engineered in: fixed random seeds (`BootstrapODPSample(n_sims=500, random_state=42)`), pinned interpreter and package versions, and templates anchored to regression targets (the RAA-triangle IBNR of 52,135).

---

## 5. The Hard Data stage: from result nodes to a board pack

Hard Data is a hub-and-spoke graph flowing *inward* to a central "board pack." Each completed model becomes a result node carrying a headline metric (ultimate / IBNR / annual average loss / SCR), secondary figures, a small chart, KaTeX-rendered theory and assumptions, and diagnostics (age-to-age factors, development-to-ultimate factors, p5/p95 intervals). When all models complete, the assistant assembles a one-page board-pack narrative, and `scriptExporter` regenerates the *entire pipeline* — every cleaning apply, derived column, and model run recorded in the activity log — as an equivalent Python, R, or C++ script, or a natural-language prompt. `ExportScreen` bundles dataset + scripts + report.

**Why it matters.** This is the reproducibility guarantee made concrete: a board figure produced in Scelo can be re-derived *outside* Scelo from an emitted script — the disclosure a peer reviewer or model-validation function requires.

---

## 6. The actuarial method library

Scelo spans the actuarial control cycle. Below, each family is described with the actual estimators it implements.

### 6.1 Reserving

- **Chain-Ladder.** `buildTriangle` detects origin/development/paid columns and builds a cumulative triangle; `ataFactors` computes **volume-weighted age-to-age factors** together with **Mack's per-period σ̂ estimator** ($\hat\sigma_k^2 = \sum_i c_{i,k}\,(f_{i,k}-\hat f_k)^2/(n_k-1)$); `buildCdf` forms development-to-ultimate factors; the headline is **IBNR = ultimate − paid-to-date**.
- **Mack (1993).** Attaches a closed-form reserve **standard error** and coefficient of variation to the chain-ladder point estimate; the Python bridge uses `cl.MackChainladder`, returning per-origin ultimates, `ibnr_.sum()`, `total_mack_std_err_` (with the correct caveat that independent SEs do not add linearly), and CV.
- **Bornhuetter–Ferguson.** Blends chain-ladder with an *a priori* expected loss ratio (using the latest cumulative diagonal as an exposure proxy in the Python path).
- **ODP bootstrap.** `cl.BootstrapODPSample(n_sims=500)` → chain-ladder each resample → a full IBNR predictive distribution (p5/p50/p95), for reserve uncertainty beyond a point estimate.

### 6.2 Mortality and longevity

- **Lee–Carter.** The Python bridge performs the canonical decomposition — numpy **SVD** of $\log q_{x,t}$ → $\alpha(x)+\beta(x)\,\kappa(t)$ (first singular component) — then fits **SARIMAX(0,1,0)** (random walk with drift) to $\kappa(t)$ for 95 % projection intervals.
- **Cairns–Blake–Dowd.** The two-factor old-age model ($\kappa^{(1)},\kappa^{(2)}$ trends).
- **Life contingencies.** The R bridge builds an `actuarialtable` from $(x, q_x)$ and returns canonical EPVs via `lifecontingencies` (`axn`, `Axn`, `nEx`); the in-browser port computes $\ddot a_x = \sum_t v^t\,{}_tp_x$ at a stated rate.
- **WHO life tables.** Country-specific $e_0$, $e_{65}$, and $q_x$-by-age from the WHO Global Health Observatory.

### 6.3 Pricing

- **GLM frequency/severity.** The `statsmodels` bridge fits a **Poisson GLM with `offset(log(exposure))`** for claim frequency and a **Gamma GLM with a log link** for severity, returning the coefficient table (estimate, std-error, z, p), AIC, Pearson χ², and deviance.

### 6.4 Capital, IFRS 17, and the life-office stack

Eight `lifelib`-rooted models — BasicTerm, CashValue, **IFRS 17 CSM roll-forward**, **Solvency II life SCR**, nested-stochastic/TVOG, **Smith–Wilson** curve extrapolation (UFR), model-point clustering, and economic scenario curves — each ship with an in-browser port, a deterministic runner, a **runnable Jupyter notebook export**, and a Python/R bridge to the reference implementation.

### 6.5 Catastrophe and climate

- **CLIMADA.** LitPop exposures + IBTrACS tropical-cyclone hazard → **annual average loss (AAL)** and return-period losses (RP10/100/250).
- **Climate reanalysis stack.** A registry of ERA5 / ERA5-Land / MERRA-2 / JRA-3Q sources with role (primary / cross-check), resolution, coverage, and licence; a peril→source pipeline (heatwave, flood, drought, wind) and an ensemble fan-chart builder. This is the one domain wired end-to-end from soft data to hard data.

### 6.6 A note on shipped state

The tooling *targets* the full `lifelib` + `chainladder` + `CLIMADA` + `statsmodels` + `rpy2` (Python) and `ChainLadder` + `lifecontingencies` + `forecast` + `actuar` (R) stack. The checked-in pre-release runtime stages a verified subset; runtime probes detect any gap and fall back to the in-browser ports by design. An honest reading is therefore: *the full stack is the design target; the shipped runtime is a verified subset with graceful degradation.* Scelo's own living specification (`SKILL.md`) maintains an explicit "what is intentionally not built yet" section — the provenance disclosure a reviewer needs to distinguish a canonical-library result from an illustrative port.

---

## 7. The AI layer

Scelo's assistants are **local-first by default**. The default provider is a local **Ollama** model (`qwen2.5:7b-instruct`) — no key, no spend, no network. Opt-in hosted providers are Anthropic (Claude), OpenAI, Google Gemini, OpenRouter, and any OpenAI-compatible endpoint. A distinctive option is **Claude Code**: rather than an API key, Scelo shells out to a locally-installed, already-signed-in `claude` CLI, reusing the user's subscription — frontier reasoning with no separate spend and no key to store.

On the desktop, **there is no vendor backend intermediating prompts**: the main process calls the provider's HTTP API directly (or invokes local Ollama / the Claude CLI), and provider keys are encrypted at rest in the OS keychain (macOS Keychain, Windows DPAPI, Linux libsecret), never exposed to the renderer. The confidential-data path and the LLM path are thereby decoupled: models and data stay local; the LLM call is an isolated, user-controlled request.

**Why it matters.** For regulated actuarial work, the ability to keep both the *data* and the *AI* on-premise — a local LLM plus in-process computation — is often a hard requirement, not a preference.

---

## 8. The swarm: computational deliberation and population simulation

The most research-relevant subsystem is the separable **swarm** server — *"a multi-agent nanoeconomics engine embedded in Scelo"* that powers the "Convene Council" and "Society Pulse" surfaces. It is a decision-*support* cockpit: *"the agents report; the actuary decides."* A free-text scenario flows through a stochastic survival simulation, a large expert-deliberation council, and a behavioural population micro-simulation, closing with a counterfactual intervention loop.

### 8.1 The WMTR nanoeconomics survival model

WMTR — mnemonically *Wealth = Material × Time × Relational* — is a fully stochastic survival simulation ported faithfully from the open `nanoeconomics-simulation` core. "Wealth" is a composite **survival capital**, not money alone.

**Wealth is Cobb–Douglas** in three capitals, with exponents renormalised to sum to one:

$$W = M^{\alpha_M}\,T^{\alpha_T}\,R^{\alpha_R},\qquad \alpha_M+\alpha_T+\alpha_R=1,\quad (\text{defaults } 0.4,0.3,0.3).$$

- **M (material capital)** evolves as production-driven growth net of maintenance: $M_{t+1}=M_t+0.04\,p_{\text{prod}}M_t-0.01\,M_t$.
- **T (effective time)** discounts leisure: $T_{\text{eff}}=p_{\text{prod}}+0.3\,p_{\text{leisure}}$.
- **R (relational capital)** is a weighted blend of family, religion, and a **spatial cohesion** term — a normalised logistic "bell" peaking near 250 sq ft per resident (citing Jacobs 1961, Alexander 1977), encoding a density optimum in which both overcrowding and sprawl erode community. Family and religion have self-reinforcing dynamics; religion buffers "meaning-crisis" shocks.

The actuarially central element is the **survival kernel** — a proportional-hazards specification in which the hazard is modulated by wealth relative to baseline:

$$h(t)=h_0\,\exp\!\big(-\beta_w\log(W/W_0)\big)=h_0\,(W/W_0)^{-\beta_w},\qquad h_0=0.02,\ \beta_w=2.0,$$

with cumulative hazard accumulating over time and survival $S(t)=e^{-\int h}$. Falling wealth super-linearly raises mortality — a genuine survival-analysis structure directly cognate to ruin theory.

**Shocks** drive the stochastics: an annual count $\sim\text{Poisson}(\lambda)$ ($\lambda\in\{0.1,0.25,0.45\}$ for mild/moderate/severe), severity $\sim\mathcal N(\mu,\sigma)$ clipped to $(0.01,0.9)$, and a **topology mix** (idiosyncratic / local / regional / global) that shifts toward correlated, global shocks as severity rises. Shocks strike weighted targets (material, time, family, religion, meaning-crisis, combined), with a half-year cooldown.

Each Monte-Carlo path is classified **grew / stabilized / declined / collapsed** against explicit thresholds (e.g. *collapsed* = W below 30 % of $W_0$ for five consecutive years). The **single-community engine** (default 200 paths over a 30-year horizon, seeded RNG) returns mean and P10/P25/P75/P90 fans of $W$, a mean survival curve, per-component means, and the outcome distribution — a stochastic survival/ruin object with tail percentiles.

The **society-network engine** layers systemic effects over N communities drawn from four cultural archetypes, placed on a plane and connected by a k-nearest-neighbour graph:

- **Trade via a gravity model:** flow $=\kappa\,W_iW_j/(d^2+\varepsilon)$ — richer, closer communities trade more.
- **Relational contagion:** each community is pulled toward its neighbours' mean $R$ — cultural diffusion.
- **Migration:** when wealth falls below 60 % of baseline, capital transfers to the richest living neighbour, with friction loss.
- Per-year frames emit total/mean wealth, the **Gini coefficient**, migration flux, and interim outcome counts — an inequality-and-contagion time series.

A scenario becomes a trajectory through `deriveConfigFromScenario`, a keyword-heuristic mapper (severity words → shock environment; "rural" vs "urban" → different $\alpha$ and spatial priors; horizon cues), seeded by an FNV-1a hash of the scenario so that **identical scenarios reproduce identical evidence**. The result is formatted as a Markdown "Simulator Evidence" block injected verbatim into every council agent's prompt.

**Why it matters.** WMTR is a compact, fully stochastic multi-capital survival model — percentile fans and a cumulative-hazard survival curve, extended with behavioural/relational state and correlated (topological) shocks, and with a society layer that produces systemic-risk contagion and inequality dynamics. It is a laboratory for scenario analysis in which the "asset" being reserved against is community survival capital, and its formal apparatus (proportional hazard, ruin classification, correlated shocks, Gini) maps directly onto reserving-under-uncertainty, ESG/climate stress, and systemic-risk research.

### 8.2 The Council: 256-agent structured deliberation

The council instantiates expert elicitation at scale. `buildAllPersonas` forms the full cross-product **8 professions × 16 MBTI types × 2 genders = 256 agents** (a stratified subset — 12/24/48/96/192 — can be run for lower cost). The professions are **Finance, Investor, Accountant, Actuary, Psychologist, ConspiracyTheorist, Lawyer, and SocialMediaInfluencer**; each carries a domain brief — the Actuary's is *"longevity, solvency, reserving, stochastic mortality/morbidity, tail risk under regulatory capital regimes."* Every agent is framed not to *decide* but to **interrogate the WMTR forecast**, with the stance vocabulary redefined: *support = trust the forecast, oppose = distrust it, abstain = insufficient evidence.*

Deliberation runs in three rounds:

1. **Round 1** — an independent view ending in `CONFIDENCE: <0–100>`.
2. **Round 2** — each agent sees a deterministic **peer digest** (a seeded sample of same-profession and other-profession peers), updates or holds, and names the specific mis-calibrated WMTR parameter.
3. **Round 3** — a strict-JSON final vote `{stance, confidence, key_risk, recommended_intervention?}` at reduced temperature for determinism.

Synthesis computes the plurality stance and a **consensus score**, extracts top risks and the dissenting-agent set, and clusters the agents' `recommended_intervention`s by `(param, direction, magnitude)` to yield an actionable signal (e.g. "the council recommends increasing $\alpha_R$"). A **shared-reasoning edge graph** scores each agent pair as $w\cdot[\text{same stance}]+(1-w)\cdot\text{Jaccard}(\text{round-2 tokens})$, encoding *convergence via overlapping reasoning*, not mere agreement — a map of the deliberation's argumentative structure. The adversarial ConspiracyTheorist persona is an explicit **red team** enforcing base-rate discipline.

**Why it matters.** This is a computational Delphi/expert-elicitation method with structured dissent and cognitive/professional diversity as an explicit hedge against groupthink. For actuarial research it operationalises *behavioural professional judgement over a quantitative forecast* — a live concern under IFRS 17 and Solvency II model-validation regimes, where documented, challengeable expert critique of model assumptions is a governance requirement.

### 8.3 The Society: behavioural population micro-simulation

The society layer supplies the *response* that pure tables cannot. Two population models coexist:

- **Sentiment society.** Up to **1,000** synthetic agents (age, income/education/employment mixes, culture) each return `{reaction, sentiment ∈ {enthusiastic … hostile}, intensity}`; k-means++ over a seven-dimensional feature vector surfaces latent demographic **clusters** and their divergent sentiment — a behavioural-economics segmentation.
- **South-Africa-grounded epidemiological population.** The actuarially richest layer builds agents from **cited priors**: a StatsSA age×sex pyramid; comorbidity prevalences (hypertension, type-2 diabetes, HIV on/off ART per THEMBISA, TB per WHO, obesity per SADHS, CKD, CVD, cancer, pregnancy) as age/sex Bernoulli draws; income/education/employment mixes (QLFS/LMDS); insurance coverage by income band; and a blended baseline $q_x$ (StatsSA + GBD, with a male multiplier). Each agent returns a strict JSON envelope of **behaviour** (treatment uptake, isolation days, spending shift), **health** (infection/severity/mortality probabilities, hospitalisation), and **economics** (workdays lost, out-of-pocket ZAR, insurer claim ZAR). `aggregateMacro` scales these to country level (≈ 62.3 M), yielding aggregate workdays lost, **GDP drag**, **excess mortality** (expected-count roll-up), insurer claims, and hospital admissions/cost, with distributional cuts by age band and comorbidity, and every prior inline-cited with a last-checked date.

**Why it matters.** This is a micro-simulation for mortality/morbidity and health economics — a synthetic population matching published rates by construction, with an LLM behavioural-response layer, bridging mortality/morbidity modelling, behavioural economics, and insurer-claims/reserving projection for pandemic-style or policy scenarios, with audit-ready provenance.

### 8.4 Justification and the IAAI Canon: citation-grounded, notation-checked reasoning

When agents are asked to defend a vote, each must emit a strict-JSON `Justification` of `{framework, citations[], formulas[], body}`, grounded two ways:

- **Profession toolkits** pin each profession to its real canonical literature — the Actuary's cites *Bowers,* *Klugman–Panjer–Willmot (Loss Models),* *Dickson–Hardy–Waters,* and *Hull,* alongside the standards **IFRS 17, Solvency II, and SAM (the South African Solvency Assessment and Management regime).**
- **The IAAI Canon** — the institution's own corpus of scholarly works (title/year/abstract/takeaway), importable via BibTeX or JSON — is injected into every prompt, and scenario-matched canon works must be cited; if the canon is empty, agents are instructed to say so, with *no fabricated citations.*

The Actuary persona is held to a **formula-output contract**: formulas must be in International Actuarial Notation via a fixed KaTeX macro set (annuity/endowment/reserve symbols, commutation functions $D_x, N_x, C_x, M_x$). A **render guard** validates each emitted formula, re-prompts once when an undefined command appears, and flags any survivor rather than silently dropping it. Justifications are cached by a vote hash and toolkit version.

**Why it matters.** This enforces traceable, citation-grounded reasoning defended against named standards and canonical texts, with correct actuarial notation — a working model of *auditable AI judgement* aligned with actuarial standards of documentation and model-validation defensibility.

### 8.5 Interventions and counterfactual re-simulation

An intervention is `{param, direction, magnitude, rationale}` over the 14 WMTR parameters; `applyIntervention` nudges the parameter by a small (0.07) or large (0.20) step. Crucially, the council **generates** interventions endogenously, and applying one can spawn a **linked follow-up run**: baseline forecast → council critique → parameter intervention → re-forecast → re-critique. This is closed-loop counterfactual scenario analysis — the structure of sensitivity, stress, and reverse-stress testing that reserving-under-uncertainty and ORSA-style capital work demand.

### 8.6 Jurisdiction as a first-class input

Legal jurisdiction (`ZA / US / UK / EU`, default ZA) propagates into the Lawyer persona and the justification toolkits, which enumerate the real statute sets per regime (e.g. ZA: Companies Act 71/2008, FAIS, FICA, FSR Act, POPIA, King IV; EU: MiFID II, MAR, GDPR, CSRD) and the prudential frameworks (IFRS 17, Solvency II, SAM). The same scenario can therefore be evaluated under SAM vs Solvency II vs US frameworks — supporting comparative regulatory-capital and disclosure research.

### 8.7 Local-first orchestration

An `LLMRouter` routes three tiers — *council, society, chat* — each preferring a loaded local Ollama model under `auto`, falling back to a cloud provider only when a key is present. Two concurrency semaphores (cloud cap 8, Ollama cap 32) throttle the 256-agent × 3-round fan-out, and a content-addressed cache keyed by `(provider, model, messages, temperature, maxTokens)` makes hundreds of calls tractable. Sensitive scenario deliberation and population simulation can therefore run **entirely on-premise**.

### 8.8 Visualisation

The swarm surfaces render the deliberation and population as interactive network graphs — *Council Reactions* (agents grouped by profession, nodes sized by weighted degree, edges the shared-reasoning links) and *Society Pulse* (agents grouped by demographic cluster, coloured by sentiment) — with soft-hull region grouping, cross-linked highlighting between the graph, a decision **Sankey** (profession → stance → confidence), and the legends, so that a click or hover on any surface propagates through all of them. A separate 3-D visualisation plugin (SceloAtlas) targets the Unreal Engine for immersive presentation.

---

## 9. The Scelo IDE: offline execution and the security model

The desktop application is an **Electron 33** shell around the shared renderer, registering a custom `scelo://` single-page-application protocol (so React's router works identically in a browser and on disk, with path-traversal guards). It bundles a version-pinned, relocatable **CPython** and **R 4.4.x** runtime (from `python-build-standalone` and a per-OS R staging pipeline), together with the actuarial package set, recorded in a checksummed `manifest.json`.

The native surface (`main.ts`) provides:

- **Buffered and streaming execution** of the bundled Python/R, and a real **pseudo-terminal** (node-pty) giving `ipython`, the R REPL, and curses tools; the terminal's `PATH` is augmented so the bundled interpreters take precedence.
- **Search** via bundled ripgrep; **workspace-scoped filesystem** access with every path re-anchored under the active workspace root (a compromised renderer cannot read `/etc/passwd`); **git** via the system binary; **test discovery** (`pytest --collect-only`, `testthat`); and long-lived **language servers** (pyright, R `languageserver`) with lint-on-save.
- **Reference-dataset downloads** with HTTP range-resume and sha-256 verification — IBTrACS, WHO life tables, NFIP claims, ChEMBL.
- **Auto-update** (packaged builds only) with a selectable stable/beta channel.

The **web edition** (`apps/web-online`) is a ~115-line Bun static server hosting the identical renderer with no interpreters, no terminal, and no keychain — a zero-install evaluation on-ramp in which every bridge returns `null` and the TypeScript ports run.

Five starter **templates** ship as concrete, runnable pipelines: `reserving` (Mack 1993 on the RAA triangle, R `ChainLadder` cross-checked against Python `chainladder` to a pinned IBNR = 52,135, assembled into a one-page audit report via a Makefile), `life-pricing` (Python biometric assumptions → R actuarial math across a CSV contract), `climate-risk` (IBTrACS → CLIMADA loss curve → ggplot return-period map), `soa-exams` (working SOA P/FM/FAM/SRM problems with the keyless Claude Code provider, tied out against a unit-tested pure-stdlib toolkit), and `scelo-brain` (a minimal reference implementation of the soft→tools→hard contract).

**Why it matters.** Bundled interpreters + workspace-scoped filesystem + OS-keychain secrets mean model runs on policyholder data never touch a network; pinned runtimes + checksummed manifests + fixed seeds + regression-anchored templates mean a rebuild produces the same artefact — auditable and defensible. A modelling actuary gets a professional editing surface (PTY terminal, LSP diagnostics, git, search) without any DevOps setup, and the same surface is reachable zero-install in a browser for evaluation.

---

## 10. How an actuary uses Scelo: the control cycle, end to end

A representative workflow, in Scelo's own stages:

1. **Soft data.** Load a claims or exposure extract; profile it; let the column-scoped assistants execute deterministic cleaning (sentinel nulling, date canonicalisation, case-merge), and impute with the formula DSL under explicit train/test discipline — every step recorded.
2. **Tools.** Route to the relevant family — a development triangle to chain-ladder / Mack / BF / ODP bootstrap; a mortality dataset to Lee–Carter / CBD / life contingencies; a frequency/severity dataset to Poisson/Gamma GLMs; a life book to the `lifelib` SCR / IFRS 17 models; a hazard footprint to CLIMADA — with the canonical library computing the board figure and the in-browser port cross-checking it.
3. **Hard data.** Read the result nodes and diagnostics, assemble the board pack, and export the whole pipeline as a runnable Python/R script for the working papers.
4. **Deliberate (optional).** Convene the council on a forecast to obtain a calibrated consensus, a structured dissent map, and clustered parameter interventions; run the society to obtain a behavioural/claims response and a cited macro roll-up; apply an intervention and re-simulate the counterfactual chain.

This traverses the full control cycle — data audit, model fitting, reporting, and a governance/critique loop — inside one offline application with an exportable audit trail.

---

## 11. Benefits for actuarial academics and researchers

- **Reproducibility as a first-class property.** Pinned runtimes, checksummed manifests, seeded stochastics, a recorded activity log, and one-click export to a runnable script mean an analysis is re-derivable outside the tool — the standard a journal or a validation function should demand.
- **A two-engine reasonability check by construction.** Every quantitative method exists as both a canonical-library computation and an independent port; agreement is the cheapest available validation, and disagreement is surfaced rather than hidden.
- **A research platform for model-risk governance.** The council is a runnable instrument for studying structured expert critique, dissent, and consensus over a quantitative model — a computational Delphi with tunable diversity and an adversarial red team, relevant to IFRS 17 / Solvency II model-validation scholarship.
- **A novel stochastic survival laboratory (WMTR).** A compact, fully specified multi-capital survival model with correlated shocks, contagion, migration, and inequality dynamics — open to reparameterisation and directly analogous to ruin theory and systemic-risk analysis — with the actuarial semantics of M/T/R relabelled per domain (reserve inflation, longevity, covenant risk, climate exposure).
- **Audit-ready synthetic populations.** The South-Africa-grounded epidemiological micro-simulation, with every demographic and comorbidity prior inline-cited, is a reusable substrate for mortality/morbidity and health-economics research and for teaching the coupling of biometric tables to behavioural response.
- **Citation-grounded, notation-correct AI reasoning.** Justifications defended against named standards and a bibliographic canon, with International Actuarial Notation validated by a render guard, are a working prototype of auditable machine judgement for the discipline.
- **A privacy-preserving substrate for confidential data.** Because both computation and (optionally) the LLM run locally, empirical work on real policyholder or claims data can proceed without a cloud round-trip — often the difference between a study being feasible and not.
- **A teaching instrument.** The `soa-exams`, `reserving`, `life-pricing`, and `climate-risk` templates are self-contained, runnable, cross-checked pipelines suitable for coursework, and the KaTeX theory panels expose the assumptions and formulae behind each estimate.

---

## 12. Honest limitations and status

Scelo is in **pre-1.0, active development**. Its own specification is candid about scope: some heavier methods are deterministic mocks pending the canonical bridge; the shipped runtime stages a verified *subset* of the target stack (with graceful degradation to the ports); there is no server-side persistence; the pipeline is presently single-dataset; installers are not yet code-signed (first-launch OS warnings apply); and there is no automated test suite for the renderer. For scholarly use, these should be read alongside the reproducibility guarantees — the tool is explicit about which numbers are canonical-library-backed and which are illustrative, which is precisely the disclosure a reviewer requires.

---

## 13. Architecture at a glance

- **One renderer** (`apps/web`, React + Vite): the soft→tools→hard workstations, the IDE workspace shell, the AI panels, and the swarm surfaces.
- **Two shells:** the Electron desktop **IDE** (`apps/scelo-ide`, bundled interpreters, native surface, OS-keychain secrets, direct-to-provider LLM) and the Bun static **web** edition (`apps/web-online`, zero-install, no interpreters).
- **Ten language bridges** delegating to canonical Python/R libraries, each with an in-browser TypeScript port.
- **A separable swarm server** (Bun + TypeScript) providing WMTR simulation, the council, the society, justification/canon, and the intervention loop, orchestrated local-first over Ollama with a content-addressed cache.

---

## 14. Availability, platforms, and licensing

Scelo runs on Linux (AppImage / deb / Snap), macOS (dmg, Intel and Apple Silicon), and Windows (NSIS); the core app runs fully offline after a first download of ~1–2 GB of bundled runtime. The default AI provider is local (Ollama); hosted providers and the swarm are opt-in.

It is released under the **Scelo IDE Source-Available License v1.1**. Using Scelo itself — installing, modifying, forking, distributing — is free for any purpose, including commercial. A royalty attaches only to a *Licensed Product* built with Scelo: the first ZAR 1,000,000 of lifetime gross revenue per product is royalty-free, with a flat 3 % on the excess thereafter. Of particular relevance to research: applying the published **Nanoeconomics methodology to poverty-eradication work** grants free use **with no revenue cap**, conditional on a public annual report. There is no separate academic tier because pure research use of the tool is already free. *(This summary is not legal advice; consult the licence text.)*

---

*Scelo is a project of Intelligent Actuaries — "public methodology, private mandate." It does not replace actuarial judgement; it makes the path from soft data to a defensible number visible, reproducible, and — where the swarm is convened — deliberately, structurally contested. The agents report; the actuary decides.*
