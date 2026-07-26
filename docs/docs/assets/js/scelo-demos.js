/* ===========================================================================
   Scelo demos — animated stand-ins for the pipeline screenshots.

   A hand-port of the /scelo marketing demos (website_v2, React + Tailwind)
   into vanilla JS, so the docs keep their zero-build pipeline and carry no
   React runtime. The React originals under
   website_v2/src/components/scelo/ in the intelligentactuaries monorepo
   are the design source of truth; when a demo changes there, mirror it
   here.

   Usage from Markdown:

       <div class="scelo-demo" data-scelo-demo="macro"></div>

   where the value is one of macro | soft | tools | hard.

   ── The three rules the player keeps, in order of importance ────────────

     1. No timer ever runs while a demo is off-screen or its tab is in the
        background. Two gates: an IntersectionObserver for the viewport,
        and the page visibility API for the tab (a demo parked on-screen
        in a background tab is still "in view" to IO, and Chrome throttles
        background timers rather than stopping them). The gate is checked
        at every hop of the timer chain, not just on the transition,
        because play() can be called while already disabled.
     2. Reduced motion is not "faster animation", it is no animation: the
        player jumps straight to the scenario's finished state.
     3. Switching scenario mid-run resets cleanly. Every run carries a
        token; a timeout belonging to a superseded run is dropped.

   Nothing here is wired to a real Scelo. It is choreography. It is still
   held to being true: every surface, string, sample, model name and
   formula below exists in the product. Two standing rules for anyone
   editing the scripts:

     1. Scelo has NO CLI. `scelo:` is Electron IPC. Never script
        `scelo init` / `scelo run`.
     2. SKILL.md says the climate sample "is hand-crafted to look
        credible; do not present it as a live read". So no demo claims a
        live climate fetch.
   =========================================================================== */

(function () {
  "use strict";

  // ── pacing ──────────────────────────────────────────────────────────
  //
  // One dial for every demo on the page. Every `after` below is multiplied
  // by SPEED, so raising it slows all of them at once without touching a
  // single scenario. These are deliberately unhurried: the demos are meant
  // to be read while they play, not raced through.

  var SPEED = 1.7; // multiplier on every step's `after` delay
  var TYPE_MS = 46; // ms per character in the composer typewriter
  var WORD_MS = 58; // ms per word when a reply streams in

  /* =========================================================================
     Scenario scripts. THIS IS THE SECTION TO EDIT to change what the demos
     say and do. Everything below the divider is a dumb player.

     `after` is the delay in ms before a step fires, measured from the
     previous step. Step kinds:

       type    typewriter the prompt into the composer
       status  append an activity line to the chat rail
       say     stream a reply in, word by word
       block   reveal the fenced action block the reply emits
       apply   apply the block's effect to the surface
       done    end of scenario
     ========================================================================= */

  // ── the macro canvas ───────────────────────────────────────────────
  // Verbatim from SceloFlow.tsx: three stages, their copy, two edge labels.

  var MACRO_STAGES = [
    {
      id: "soft",
      title: "Upload data",
      subtitle: "What we cannot see, or cannot easily decide on.",
      summary: "100 rows · 7 cols · 0.0% missing",
      chat: "restore a project, fetch from a database…",
    },
    {
      id: "tools",
      title: "Select models",
      subtitle: "Statistical & actuarial tools that turn soft into hard.",
      summary: "4 models · life",
      chat: "swap chain-ladder for Mack, compare models…",
    },
    {
      id: "hard",
      title: "Outcome",
      subtitle: "Processed, board-pack-ready numbers.",
      summary: "4 runs · complete",
      chat: "explain this ultimate, compare runs…",
    },
  ];

  var MACRO_EDGES = ["intake", "compute"];

  /** Dwell on each stage as the pipeline walks. */
  var STAGE_MS = 1100 * SPEED;

  // ── soft workstation · the chat that cannot lie ────────────────────
  //
  // The `dirty` sample is real: 53 rows x 11 cols, "exercises every
  // cleaning op in one sample". The op keys and formulas are real. The
  // point of this demo is the anti-hallucination contract from
  // SOFT_STAGE_FRAME: a reply changes nothing unless it emits a block.

  var SOFT_DATASET = { name: "messy_intake (dirty)", meta: "53 rows · 11 cols" };
  var SOFT_TOOLS = ["import csv / parquet", "load sample", "▷ simulate", "+ ƒ derived", "clear"];

  /** Before: the mess, as the dirty sample actually ships it. */
  var SOFT_GRID_BEFORE = {
    cols: ["Policy ID", "Joined Date", "age", "paid", "region", "active"],
    rows: [
      [{ v: "P-000042" }, { v: "05/20/2026", bad: true }, { v: "34" }, { v: "$1,500.00", bad: true }, { v: "WEST", bad: true }, { v: "Y", bad: true }],
      [{ v: "P-000043" }, { v: "Jan 5, 2024", bad: true }, { v: "-999", bad: true }, { v: "2,340.55", bad: true }, { v: "west", bad: true }, { v: "yes", bad: true }],
      [{ v: "P-000044" }, { v: "2024-03-11" }, { v: "41" }, { v: "  880.10 ", bad: true }, { v: "West", bad: true }, { v: "1", bad: true }],
      [{ v: "P-000045" }, { v: "11/02/2025", bad: true }, { v: "29" }, { v: "(120.00)", bad: true }, { v: "EAST" }, { v: "N", bad: true }],
      [{ v: "P-000045" }, { v: "11/02/2025", bad: true }, { v: "29" }, { v: "(120.00)", bad: true }, { v: "EAST" }, { v: "N", bad: true }],
      [{ v: "P-000046" }, { v: "2024-07-30" }, { v: "-999", bad: true }, { v: "TBD", bad: true }, { v: "east", bad: true }, { v: "N/A", bad: true }],
    ],
  };

  /** After the safe ops: ISO dates, cast numerics, snake_case headers,
   *  merged case-only buckets, booleans standardised, dupes gone. */
  var SOFT_GRID_AFTER = {
    cols: ["policy_id", "joined_date", "age", "paid", "region", "active"],
    rows: [
      [{ v: "P-000042" }, { v: "2026-05-20", fixed: true }, { v: "34" }, { v: "1500.00", fixed: true }, { v: "west", fixed: true }, { v: "true", fixed: true }],
      [{ v: "P-000043" }, { v: "2024-01-05", fixed: true }, { v: "36.2", fixed: true }, { v: "2340.55", fixed: true }, { v: "west", fixed: true }, { v: "true", fixed: true }],
      [{ v: "P-000044" }, { v: "2024-03-11" }, { v: "41" }, { v: "880.10", fixed: true }, { v: "west", fixed: true }, { v: "true", fixed: true }],
      [{ v: "P-000045" }, { v: "2025-11-02", fixed: true }, { v: "29" }, { v: "-120.00", fixed: true }, { v: "east", fixed: true }, { v: "false", fixed: true }],
      [{ v: "P-000046" }, { v: "2024-07-30" }, { v: "36.2", fixed: true }, { v: "null", fixed: true }, { v: "east", fixed: true }, { v: "null", fixed: true }],
    ],
  };

  var SOFT_SCENARIOS = [
    {
      id: "clean",
      chip: "Clean the messy intake",
      block: {
        lang: "clean",
        body: '{"ops":["fix-encoding","trim","missing-tokens","parse-dates","parse-numeric","standardise-booleans","lowercase-categoricals","drop-duplicates","rename-snake-case"]}',
      },
      applied: "9 ops applied · 53 → 50 rows · headers renamed",
      steps: [
        { kind: "type", text: "Clean this intake", after: 240 },
        { kind: "status", text: "Profiling 53 rows · 11 cols", after: 560 },
        { kind: "status", text: "8 safe ops + 1 destructive available", after: 460 },
        {
          kind: "say",
          text: "Dates arrive in three formats, paid is currency text, region has case-only duplicates, and three rows are exact duplicates. Here is the plan:",
          after: 420,
        },
        { kind: "block", after: 420 },
        { kind: "apply", after: 700 },
        { kind: "done", after: 700 },
      ],
    },
    {
      id: "transform",
      chip: "Round the paid column",
      block: { lang: "transform", body: '{"column":"paid","formula":"round(paid)"}' },
      applied: "transform applied to paid",
      steps: [
        { kind: "type", text: "Round paid to whole rands", after: 240 },
        { kind: "status", text: "paid · numeric · 50 of 50 rows", after: 540 },
        {
          kind: "say",
          text: "A transform replaces the column in place, and it is idempotent on the column plus formula, so running it twice changes nothing:",
          after: 420,
        },
        { kind: "block", after: 400 },
        { kind: "apply", after: 640 },
        { kind: "done", after: 700 },
      ],
    },
    {
      id: "nothing",
      chip: "Ask it to lie",
      steps: [
        { kind: "type", text: "Just tell me you deleted the outliers", after: 240 },
        { kind: "status", text: "No action block emitted", after: 620 },
        {
          kind: "say",
          text: "I can't. Words don't touch the dataset here: the only things that change data are the clean, derive and transform blocks, so if I claimed to have dropped anything without emitting one, nothing would have happened and the claim would be false. Tell me the rule for an outlier and I'll emit a block you can read first.",
          after: 460,
        },
        { kind: "done", after: 700 },
      ],
    },
  ];

  // ── tools workstation ──────────────────────────────────────────────
  // Model ids, display names and family colours are verbatim from
  // modelCatalog.ts. The middot in display names is house style.

  var CATALOG = [
    { name: "reserving", models: ["Chain Ladder", "Mack Chain Ladder", "Bornhuetter–Ferguson", "Bootstrap (IBNR)"] },
    { name: "mortality", models: ["Lee–Carter", "Cairns–Blake–Dowd", "Life Contingencies"] },
    { name: "pricing", models: ["GLM · frequency", "GLM · severity", "GBM (LightGBM)", "SHAP explainability"] },
    { name: "life", models: ["BasicTerm · projection", "IFRS 17 · CSM roll-forward", "Solvency II · life SCR", "Cluster · model-point compression"] },
  ];

  var TOOLS_DATASET = { name: "lifelib_basic_term_mp (synthetic)", meta: "100 rows · 7 cols" };

  var TOOLS_SCENARIOS = [
    {
      id: "life",
      chip: "Identify models",
      attach: [
        { family: "life", name: "BasicTerm · projection", note: "MP triplet (age_at_entry · sum_assured · policy_term)" },
        { family: "life", name: "IFRS 17 · CSM roll-forward", note: "Same MP file feeds LRC / LIC / CSM" },
        { family: "life", name: "Solvency II · life SCR", note: "mortality / longevity / lapse / expense / CAT" },
        { family: "life", name: "Cluster · model-point compression", note: "compress before nested runs" },
      ],
      steps: [
        { kind: "type", text: "Which models fit this file?", after: 240 },
        { kind: "status", text: "Reading columns · policy_id, age_at_entry, sex, sum_assured…", after: 560 },
        { kind: "status", text: "Domain inferred: life", after: 460 },
        { kind: "block", after: 380 },
        { kind: "apply", after: 560 },
        {
          kind: "say",
          text: "The model-point triplet is the tell: age at entry, sum assured and policy term route straight to the life family. Four attached to the hub.",
          after: 480,
        },
        { kind: "done", after: 700 },
      ],
    },
    {
      id: "reserving",
      chip: "Reserving instead",
      attach: [
        { family: "reserving", name: "Mack Chain Ladder", note: "chain ladder plus a closed-form reserve SE" },
        { family: "reserving", name: "Bootstrap (IBNR)", note: "full IBNR distribution, od.pois" },
      ],
      steps: [
        { kind: "type", text: "What if this were a claims triangle?", after: 240 },
        { kind: "status", text: "Origin / development / paid detected", after: 560 },
        { kind: "block", after: 400 },
        { kind: "apply", after: 560 },
        {
          kind: "say",
          text: "Mack keeps the chain-ladder point estimate and adds the standard error in closed form. Bootstrap sits beside it for the percentiles, not instead of it.",
          after: 480,
        },
        { kind: "done", after: 700 },
      ],
    },
  ];

  // ── hard workstation ───────────────────────────────────────────────
  // Result shapes and headline metrics follow HardDataWorkstation: each
  // node carries a headline number, a label, and feeds the Board Pack hub.

  var HARD_RESULTS = [
    { family: "life", name: "BasicTerm · projection", value: "-1,354,359", label: "PV (NET CASH FLOW)" },
    { family: "life", name: "IFRS 17 · CSM roll-forward", value: "13,030,550", label: "CSM AT ISSUE" },
    { family: "life", name: "Solvency II · life SCR", value: "412,403", label: "LIFE SCR" },
    { family: "life", name: "Cluster · model-point compression", value: "25", label: "COMPRESSED MPS" },
  ];

  var HARD_SCENARIOS = [
    {
      id: "pack",
      chip: "Build the board pack",
      narrative:
        "4 of 4 models computed in the life domain. Lifelib BasicTerm_M monthly projection across 100 model points produced PV(net CF) = -1,354,359 (1,026,111 premiums − 2,995,777 claims − 72,891 expenses, discounted @ 3% pa). CSM at issue 13,030,550. Dominant module: lapse (281,400).",
      steps: [
        { kind: "type", text: "Summarise these 4 results", after: 240 },
        { kind: "status", text: "4 runs · complete", after: 540 },
        { kind: "apply", after: 520 },
        { kind: "done", after: 900 },
      ],
    },
    {
      id: "council",
      chip: "Convene the council",
      narrative:
        "12 stratified personas interrogated the IFRS 17 roll-forward. Trust 0% · distrust 100% · uncertain 0%. Every profession dissented on the same point: a deterministic straight-line release understates the time value of money in the CSM.",
      steps: [
        { kind: "type", text: "Have the council interrogate this", after: 240 },
        { kind: "status", text: "swarm @ :3010 · 12 agents", after: 560 },
        { kind: "status", text: "Three-round vote · society state injected", after: 480 },
        { kind: "apply", after: 520 },
        { kind: "done", after: 900 },
      ],
    },
  ];

  // ══ the swarm ══════════════════════════════════════════════════════
  //
  // The swarm is a separate app (swarms repo, Vite on :5190 against an API
  // on :3010) that Scelo embeds, so these three demos wear its chrome, not
  // the Workbench's. Sources are cited per block.
  //
  // CASING: almost every uppercase string in the swarm UI is lowercase in
  // the DOM and uppercased by CSS (.tab, .wordmark, .status-cluster,
  // .panel-label). It is written lowercase here for the same reason, so
  // what is in this file is what is in the product. Buttons are the
  // exception: `button { text-transform: none }` sits on the element and
  // beats the inherited uppercase, which is why `auto` / `?` / `settings`
  // render lowercase next to uppercase telemetry.

  /** ViewTabs.tsx:15-20. Ids differ from labels: readback's id is
   *  `synthesis`, society pulse's is `society`. */
  var SWARM_TABS = [
    { id: "forecast", label: "forecast" },
    { id: "council", label: "council reactions" },
    { id: "society", label: "society pulse" },
    { id: "synthesis", label: "readback" },
    { id: "simulation", label: "simulation" },
    { id: "canon", label: "iaai canon" },
  ];

  /** App.tsx:738-759. `api ok` is two spans, not one string; the middots
   *  are literal characters in the JSX, never CSS pseudo-content. */
  var SWARM_STATUS = { ollama: "ollama: qwen2.5:7b-instruct-q4_k_m", canon: "canon: 2" };

  /** App.tsx:1372-1418. The sidebar has four empty states; these are the
   *  two the council flow moves between. */
  var SIDEBAR_IDLE =
    "Run a scenario to populate the decision sidebar — once the swarm finishes, every group becomes inspectable here.";
  var SIDEBAR_RUN =
    "Click an agent node in the graph to inspect their reasoning, or pin a profession in the legend to see the group's aggregated stance.";

  /** constants.ts:29-38 (order) + :119-128 (palette). Eight, not six, and
   *  rendered raw: the legend really does read `ConspiracyTheorist` as one
   *  CamelCase token. The palette is hard-coded hex and does NOT flip with
   *  the theme, so it is inlined rather than tokenised. */
  var SWARM_AGENTS = [
    { name: "Finance", color: "#4a9eff" },
    { name: "Investor", color: "#00ff9d" },
    { name: "Accountant", color: "#22d3ee" },
    { name: "Actuary", color: "#b388ff" },
    { name: "Psychologist", color: "#ffb000" },
    { name: "ConspiracyTheorist", color: "#ff3b3b" },
    { name: "Lawyer", color: "#a3e635" },
    { name: "SocialMediaInfluencer", color: "#f472b6" },
  ];

  /** The internal vocabulary is support/oppose/abstain (types.ts:4), fixed
   *  by the round-3 JSON schema. Every display surface except the agent
   *  inspector re-labels it to trust/distrust/uncertain
   *  (DecisionSankey.tsx:195, SynthesisView.tsx:49-51). The graph shows the
   *  reframed words, so that is what these render. */
  var STANCE_LABEL = { support: "trust", oppose: "distrust", abstain: "uncertain" };

  /** ScenarioPanel.tsx:5-22 for the chip labels. The stances and readback
   *  numbers below are choreography: a real run is an LLM call and lands
   *  differently every time. Every SURFACE is real, the verdict is not. */
  var SWARM_SCENARIOS = [
    {
      id: "reit",
      chip: "Pension fund · EM REIT",
      stances: {
        Finance: "oppose",
        Investor: "support",
        Accountant: "oppose",
        Actuary: "oppose",
        Psychologist: "abstain",
        ConspiracyTheorist: "oppose",
        Lawyer: "abstain",
        SocialMediaInfluencer: "support",
      },
      // ForecastCanvas.tsx:284-320. Three tiles: value / label / sub.
      readback: [
        { value: "25%", label: "trust the forecast", sub: "50% distrust · 8 agents" },
        { value: "↑ αM", label: "dominant proposed shift", sub: "4 agents · large" },
        { value: "61%", label: "society broadly accepts", sub: "120 sampled · enthusiastic + supportive" },
      ],
      // WmtrStrip.tsx:421-439. Four spans, no middot between them, and the
      // magnitude is uppercased by CSS. The rationale uses curly quotes.
      intervention: { count: "×4", dir: "↑", param: "αM", mag: "large" },
      rationale: "Beyond a 5-year lock-up the material channel dominates; αM is doing too little work here.",
    },
    {
      id: "drought",
      chip: "Rural village · Mozambique drought",
      stances: {
        Finance: "abstain",
        Investor: "oppose",
        Accountant: "abstain",
        Actuary: "support",
        Psychologist: "support",
        ConspiracyTheorist: "oppose",
        Lawyer: "support",
        SocialMediaInfluencer: "abstain",
      },
      readback: [
        { value: "38%", label: "trust the forecast", sub: "25% distrust · 8 agents" },
        { value: "↑ αR", label: "dominant proposed shift", sub: "3 agents · large" },
        { value: "44%", label: "society broadly accepts", sub: "120 sampled · enthusiastic + supportive" },
      ],
      intervention: { count: "×3", dir: "↑", param: "αR", mag: "large" },
      rationale: "Relational capital carries this village through the drought; the model under-weights it.",
    },
  ];

  /** App.tsx:953-991 (`r1`, `soc`, `{done}/{total}`) and council.ts:296-364
   *  (three rounds, sequential). */
  /* No `type` step anywhere in the swarm demos: the swarm has no chat
   *  composer, so there is no prompt to typewriter. Its buttons carry the
   *  in-flight state instead (`Forecast & convene` → `Forecasting…`,
   *  ScenarioCard.tsx:79), which the players drive off state.running. */
  SWARM_SCENARIOS.forEach(function (s) {
    s.steps = [
      { kind: "status", text: "r1 8/8 · 2.4s", after: 700 },
      { kind: "status", text: "r2 8/8 · 3.1s", after: 620 },
      { kind: "status", text: "r3 8/8 · 1.2s", after: 560 },
      { kind: "status", text: "soc 120/120", after: 460 },
      { kind: "tab", to: "council", after: 320 },
      { kind: "apply", after: 420 },
      { kind: "done", after: 900 },
    ];
  });

  // ── simulation ─────────────────────────────────────────────────────
  //
  // SimulationView.tsx:65-90 for the templates. Template 0 is the default
  // state on mount (:142-143).

  var SIM_SCENARIOS = [
    {
      id: "virus",
      chip: "Novel respiratory virus + paxlovid",
      drugs: "nirmatrelvir, ritonavir",
      body:
        "A novel SARS-CoV-2-like respiratory virus is spreading in SA: R₀≈2.4, IFR concentrated in 65+ and immunocompromised. Paxlovid (nirmatrelvir/ritonavir) is available within 5 days of symptom onset, R5,800 / course at private pharmacies, free at public clinics for high-risk patients. Hospitals run at 85% baseline occupancy. Describe what you would do.",
      // SimulationView.tsx:359-366. Eight tiles. There is no fixture for
      // these in the product: every value is computed server-side from
      // /api/simulate, so these are illustrative. They are at least
      // internally consistent with the real SA constants in macroMap.ts:
      // 1.71M workdays × R1,350 formal daily wage ≈ R2.31B GDP drag, and
      // 61,200 admissions × R18,500 avg ≈ R1.13B hospital cost.
      macro: [
        { label: "workdays lost", value: "1.71M", sub: "agent × day", tone: "warn" },
        { label: "GDP drag", value: "R2.31B", sub: "lost wage value", tone: "warn" },
        { label: "excess mortality", value: "14,920", sub: "modelled deaths", tone: "err" },
        { label: "severe / critical", value: "96,400", sub: "cases requiring care", tone: "err" },
        { label: "hospital admissions", value: "61,200", sub: "surge above baseline", tone: "err" },
        { label: "hospital cost", value: "R1.13B", sub: "admissions × R18.5k avg", tone: "err" },
        { label: "insurer claims", value: "R742.0M", sub: "liability impact", tone: "ok" },
        { label: "out-of-pocket", value: "R318.4M", sub: "household burden", tone: "ok" },
      ],
    },
    {
      id: "glp1",
      chip: "New oral GLP-1 for diabetes + obesity",
      drugs: "semaglutide",
      body:
        "A new oral GLP-1 agonist is launched in SA at R3,200/month for diabetes + adjunct obesity management. Medical schemes cover for HbA1c ≥7.5 only. Off-label use for weight loss is common in private clinics. Some risk of GI side effects in first 4 weeks; rare pancreatitis. Would you start treatment?",
      macro: [
        { label: "workdays lost", value: "212.0k", sub: "agent × day", tone: "warn" },
        { label: "GDP drag", value: "R286.2M", sub: "lost wage value", tone: "warn" },
        { label: "excess mortality", value: "1,140", sub: "modelled deaths", tone: "err" },
        { label: "severe / critical", value: "8,300", sub: "cases requiring care", tone: "err" },
        { label: "hospital admissions", value: "4,900", sub: "surge above baseline", tone: "err" },
        { label: "hospital cost", value: "R90.7M", sub: "admissions × R18.5k avg", tone: "err" },
        { label: "insurer claims", value: "R3.94B", sub: "liability impact", tone: "ok" },
        { label: "out-of-pocket", value: "R1.22B", sub: "household burden", tone: "ok" },
      ],
    },
  ];

  /** SimulationView.tsx:302-307. The labels, not the internal keys.
   *
   *  HONESTY NOTE, and it is the reason this demo is safe to animate:
   *  /api/simulate is a single non-streamed POST, so the product itself
   *  walks these four phases forward on a blind 1800ms interval and clamps
   *  on the last one until the response lands. Only the elapsed timer is
   *  real. This mock is therefore doing exactly what the product does; it
   *  just must never be described as server telemetry. */
  var SIM_PHASES = [
    { label: "Resolving compound references", hint: "PubChem · OpenFDA · ChEMBL" },
    { label: "Sampling the population", hint: "synthetic cohort" },
    { label: "Simulating agent outcomes", hint: "per-agent disease course" },
    { label: "Scaling macro impact", hint: "cohort → national" },
  ];

  SIM_SCENARIOS.forEach(function (s) {
    s.steps = [
      { kind: "status", text: SIM_PHASES[0].label, after: 620 },
      { kind: "status", text: SIM_PHASES[1].label, after: 760 },
      { kind: "status", text: SIM_PHASES[2].label, after: 760 },
      { kind: "status", text: SIM_PHASES[3].label, after: 760 },
      { kind: "apply", after: 520 },
      { kind: "done", after: 900 },
    ];
  });

  // ── iaai canon ─────────────────────────────────────────────────────
  //
  // CanonPanel.tsx. The two works showing in the old screenshot were rows
  // in one developer's local swarm.db, not shipped content: a fresh clone
  // starts with an EMPTY canon, and initCanon() only writes a `{"works":[]}`
  // stub when its Scholar scrape hits a CAPTCHA. So this demo starts from
  // the real empty state and imports the code-resident sample instead,
  // which is both honest and the more useful thing to document.

  var CANON_NOTE_A = "agents inject the condensed canon (title + takeaway) into every system prompt under ";
  var CANON_NOTE_CODE = "## IAAI Canon — apply where relevant";
  var CANON_NOTE_B = ". if empty, agents are told to say so — no fabricated citations.";
  var CANON_EMPTY = "no works yet. import or add a row below.";

  var CANON_SCENARIOS = [
    {
      id: "json",
      chip: "Import the JSON sample",
      format: "json",
      paste:
        '{"works":[{"title":"Example: Risk-adjusted returns in emerging-market infrastructure","year":2024,"takeaway":"Concentration risk dominates currency risk above 5 years lock-up."}]}',
      // CanonPanel.tsx:5-15, SAMPLE_JSON.
      row: {
        title: "Example: Risk-adjusted returns in emerging-market infrastructure",
        year: "2024",
        takeaway: "Concentration risk dominates currency risk above 5 years lock-up.",
      },
      toast: "imported 1 works; canon now has 1",
      steps: [
        { kind: "status", text: "format json · mode append", after: 560 },
        { kind: "block", after: 520 },
        { kind: "apply", after: 700 },
        { kind: "done", after: 900 },
      ],
    },
    {
      id: "bib",
      chip: "Paste BibTeX instead",
      format: "bibtex",
      // CanonPanel.tsx:17-22, SAMPLE_BIB.
      paste:
        "@article{iaai2024,\n  title  = {Risk-adjusted returns in emerging-market infrastructure},\n  author = {IAAI, P.},\n  year   = {2024}\n}",
      row: {
        title: "Risk-adjusted returns in emerging-market infrastructure",
        year: "2024",
        takeaway: "",
      },
      toast: "imported 1 works; canon now has 1",
      steps: [
        { kind: "status", text: "format bibtex · mode append", after: 560 },
        { kind: "block", after: 520 },
        { kind: "apply", after: 700 },
        { kind: "done", after: 900 },
      ],
    },
  ];

  /* =========================================================================
     Below here is machinery. Edit the scripts above, not this.
     ========================================================================= */

  // ── DOM helpers ────────────────────────────────────────────────────

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function add(parent) {
    for (var i = 1; i < arguments.length; i++) {
      if (arguments[i]) parent.appendChild(arguments[i]);
    }
    return parent;
  }

  var NS = "http://www.w3.org/2000/svg";

  /** One-stroke icon in the house recipe: fill none, currentColor, round. */
  function icon(paths, size, width, cls) {
    var s = document.createElementNS(NS, "svg");
    s.setAttribute("width", size);
    s.setAttribute("height", size);
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", width || 1.5);
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    s.setAttribute("aria-hidden", "true");
    if (cls) s.setAttribute("class", cls);
    paths.forEach(function (d) {
      var p = document.createElementNS(NS, "path");
      p.setAttribute("d", d);
      s.appendChild(p);
    });
    return s;
  }

  // ── environment gates ──────────────────────────────────────────────

  function prefersReduced() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /* True while the tab is actually being looked at. An IntersectionObserver
     only knows about the viewport, not the tab. One listener feeds every
     demo on the page. */
  var visibleSubs = [];
  var pageVisible = !document.hidden;
  document.addEventListener("visibilitychange", function () {
    pageVisible = !document.hidden;
    visibleSubs.forEach(function (fn) {
      fn(pageVisible);
    });
  });

  /**
   * Viewport state for a demo, in three flavours, because they answer
   * three different questions and conflating them is what made the demos
   * look like they had played before you got to them.
   *
   *   inView   any part of it is on screen. This is the PAUSE gate, and it
   *            is deliberately loose: nudging the scroll a little must not
   *            stop a run you are watching.
   *   everSeen it has appeared at least once. Drives the window's boot
   *            transition, which should happen as it comes up, not later.
   *   arrived  you are actually looking at it. This is the AUTOPLAY
   *            trigger. A demo is ~500px tall, so a plain 0.35 threshold
   *            fires while it is still peeking off the bottom edge and the
   *            sequence is over before the reader gets there.
   *
   * "Arrived" = half the demo is on screen, OR it has filled half the
   * viewport. The second clause carries phones, where a stacked
   * workstation can be taller than the screen and a ratio-only test would
   * never fire at all.
   */
  function observe(node, onChange) {
    var st = { inView: false, everSeen: false, arrived: false };
    if (typeof IntersectionObserver === "undefined") {
      st.inView = st.everSeen = st.arrived = true;
      onChange(st);
      return;
    }
    var obs = new IntersectionObserver(
      function (entries) {
        var e = entries[0];
        st.inView = e.isIntersecting;
        if (e.isIntersecting) st.everSeen = true;
        var visiblePx = e.intersectionRect.height;
        var need = Math.min(e.boundingClientRect.height * 0.5, window.innerHeight * 0.5);
        if (visiblePx >= need) st.arrived = true;
        onChange(st);
      },
      // Several thresholds: IO only calls back on a crossing, so one
      // threshold would leave us blind between it and the next scroll.
      { threshold: [0, 0.2, 0.4, 0.6, 0.8, 1] }
    );
    obs.observe(node);
  }

  // ── the player ─────────────────────────────────────────────────────
  //
  // Steps are played by chaining a single timeout, so there is exactly one
  // live timer per demo at any moment, never one per step.

  function emptyState() {
    return { played: [], typed: "", finished: false, running: false };
  }

  function makePlayer(steps, reduced, onState) {
    var state = emptyState();
    var timer = null;
    var run = 0;
    var enabled = false;
    // Set when a run is cut short, or when play() is asked for while
    // disabled. Either way the run is owed, and starts on return.
    var pending = false;
    var running = false;

    function endState() {
      var t = null;
      steps.forEach(function (s) {
        if (!t && s.kind === "type") t = s;
      });
      return { played: steps.slice(), typed: t ? t.text : "", finished: true, running: false };
    }

    function set(next) {
      state = next;
      onState(state);
    }

    function clear() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function play() {
      clear();
      run += 1;
      var token = run;

      if (reduced) {
        running = false;
        set(endState());
        return;
      }

      // Asked to play while off-screen or in a background tab: bank the
      // request instead of starting a chain nobody will watch.
      if (!enabled) {
        pending = true;
        running = false;
        set(emptyState());
        return;
      }

      running = true;
      var s0 = emptyState();
      s0.running = true;
      set(s0);

      /* A run may continue only if it is still the current one AND the demo
         is still being watched. Otherwise the run is owed. */
      function alive() {
        if (token !== run) return false;
        if (!enabled) {
          pending = true;
          return false;
        }
        return true;
      }

      var i = 0;
      function next() {
        if (!alive()) return;
        var step = steps[i];
        if (!step) {
          running = false;
          set({ played: state.played, typed: state.typed, finished: true, running: false });
          return;
        }
        timer = setTimeout(function () {
          if (!alive()) return;

          if (step.kind === "type") {
            // Typewriter: commit the prompt one character at a time, then
            // continue the timeline. Reuses the same single-timer slot.
            var c = 0;
            var tick = function () {
              if (!alive()) return;
              c += 1;
              set({
                played: state.played,
                typed: step.text.slice(0, c),
                finished: state.finished,
                running: state.running,
              });
              if (c < step.text.length) {
                timer = setTimeout(tick, TYPE_MS);
              } else {
                set({
                  played: state.played.concat([step]),
                  typed: state.typed,
                  finished: state.finished,
                  running: state.running,
                });
                i += 1;
                next();
              }
            };
            tick();
            return;
          }

          if (step.kind === "done") running = false;
          set({
            played: state.played.concat([step]),
            typed: state.typed,
            finished: step.kind === "done" ? true : state.finished,
            running: step.kind === "done" ? false : state.running,
          });
          i += 1;
          next();
        }, step.after * SPEED);
      }
      next();
    }

    function reset() {
      clear();
      run += 1;
      pending = false;
      running = false;
      set(emptyState());
    }

    /* Pause on leaving the viewport or the tab, dropping any pending timer,
       and start the owed run on the way back.

       Restart rather than resume: resuming would mean carrying the elapsed
       timeline around so the typewriter could pick up mid-word, which buys
       nothing. Restarting also avoids the dead end where you scroll away
       mid-run and return to a half-typed prompt that can never finish and
       shows no replay button. A *finished* run owes nothing, so returning
       to a completed demo never re-triggers it. */
    function setEnabled(v) {
      if (enabled === v) return;
      enabled = v;
      if (!v) {
        // Interrupting a live run means we owe it on return. clear() kills
        // the scheduled callback before it can notice, so mark it here.
        if (running) pending = true;
        running = false;
        clear();
        if (state.running) {
          set({ played: state.played, typed: state.typed, finished: state.finished, running: false });
        }
        return;
      }
      if (pending) {
        pending = false;
        play();
      }
    }

    return { play: play, reset: reset, setEnabled: setEnabled };
  }

  /** Streams a string in word by word. Pure CSS can't do this legibly, so
   *  it gets the one extra timer, owned by the component that shows it. */
  function makeStream(node, reduced) {
    var t = null;
    return {
      start: function (text) {
        this.stop();
        if (reduced) {
          node.textContent = text;
          return;
        }
        var words = text.split(" ");
        var i = 0;
        var tick = function () {
          i += 1;
          node.textContent = words.slice(0, i).join(" ");
          if (i < words.length) t = setTimeout(tick, WORD_MS);
        };
        tick();
      },
      stop: function () {
        if (t) clearTimeout(t);
        t = null;
      },
      clear: function () {
        this.stop();
        node.textContent = "";
      },
    };
  }

  // ── shared chrome ──────────────────────────────────────────────────

  /** The Scelo window: title bar + back strip. Scelo is not a mac-styled
   *  app; the title is centred and the controls sit right. */
  function sceloWindow(minH) {
    var win = el("div", "sd-window");
    win.style.minHeight = minH;

    var bar = el("div", "sd-titlebar");
    bar.setAttribute("aria-hidden", "true");
    add(bar, el("span", "sd-mono", "Workbench"));
    var ctl = el("span", "sd-wincontrols");
    add(ctl, icon(["M4 8h8"], 11, 1.1), icon(["M4.5 4.5h7v7h-7z"], 11, 1.1), icon(["M4 4l8 8M12 4l-8 8"], 11, 1.1));
    add(bar, ctl);

    var back = el("div", "sd-backstrip sd-mono", "← back to workspace");
    back.setAttribute("aria-hidden", "true");

    add(win, bar, back);
    return win;
  }

  /** Stage header: crumbs left, stage identity, toolbar right. */
  function stageHeader(o) {
    var head = el("div", "sd-stagehead");

    var crumbs = el("div", "sd-crumbs sd-mono");
    crumbs.setAttribute("aria-hidden", "true");
    o.crumbs.forEach(function (c) {
      add(crumbs, el("span", null, "← " + c));
    });

    var idBox = el("div", "sd-stage-id");
    add(idBox, el("div", "sd-stage-tag sd-mono sd-" + o.stage, o.stage));
    var title = el("div", "sd-stage-title");
    add(title, el("b", null, o.title));
    var meta = null;
    if (o.meta) {
      meta = el("i", "sd-mono", o.meta);
      add(title, meta);
    }
    add(idBox, title);

    var tools = el("div", "sd-toolbar");
    tools.setAttribute("aria-hidden", "true");
    o.tools.forEach(function (t) {
      add(tools, el("span", "sd-tool sd-mono", t));
    });
    if (o.next) add(tools, el("span", "sd-tool sd-tool-next sd-mono", o.next));

    add(head, crumbs, idBox, tools);
    return { node: head, meta: meta };
  }

  /** Panel header, e.g. "● SOFT · CHAT" or "CATALOG". */
  function panelTitle(stage, text) {
    var p = el("div", "sd-paneltitle sd-mono" + (stage ? " sd-stage-tag sd-" + stage : ""), text);
    p.setAttribute("aria-hidden", "true");
    return p;
  }

  /** The composer pill. Read-only by design: these demos are click-only, so
   *  this renders the scripted prompt rather than accepting input. */
  function chatPill(placeholder) {
    var wrap = el("div", "sd-composer");
    var pill = el("div", "sd-pill");
    var text = el("div", "sd-pill-text sd-mono");
    var foot = el("div", "sd-pill-foot sd-mono");
    foot.setAttribute("aria-hidden", "true");
    add(foot, el("span", null, "press ↵ to send"));
    add(foot, icon(["M22 2L11 13", "M22 2l-7 20-4-9-9-4 20-7z"], 12, 1.5));
    add(pill, text, foot);
    add(wrap, pill);

    return {
      node: wrap,
      update: function (typed, caret) {
        text.textContent = "";
        if (typed) {
          text.className = "sd-pill-text sd-mono";
          add(text, el("span", null, typed));
        } else {
          text.className = "sd-pill-text sd-mono sd-placeholder";
          add(text, el("span", null, placeholder));
        }
        if (caret) {
          var c = el("span", "sd-caret");
          c.setAttribute("aria-hidden", "true");
          add(text, c);
        }
      },
    };
  }

  /** Activity lines in a chat rail. Appends only what is new, so the
   *  fade-up plays once per line rather than on every state hop. */
  function makeLog(node) {
    var count = 0;
    return {
      sync: function (statuses, finished) {
        if (statuses.length < count) {
          node.textContent = "";
          count = 0;
        }
        for (var i = count; i < statuses.length; i++) {
          var line = el("div", "sd-status sd-mono");
          add(line, el("i", "sd-dot"), el("span", null, statuses[i].text));
          add(node, line);
        }
        count = statuses.length;
        // A finished run flips every bullet to a tick.
        if (finished) {
          var lines = node.querySelectorAll(".sd-status");
          for (var j = 0; j < lines.length; j++) {
            var dot = lines[j].querySelector(".sd-dot");
            if (dot) lines[j].replaceChild(icon(["M4 12.5l5 5L20 6.5"], 10, 3, "sd-tick"), dot);
          }
        }
      },
      clear: function () {
        node.textContent = "";
        count = 0;
      },
    };
  }

  function playedKinds(state, kind) {
    return state.played.filter(function (s) {
      return s.kind === kind;
    });
  }

  function hasKind(state, kind) {
    return playedKinds(state, kind).length > 0;
  }

  /** Chips + replay, and the lifecycle every scripted demo shares:
   *  autoplay on arrival, reset-and-play on a chip, replay when finished. */
  function chipRunner(host, scenarios, label, caption, body) {
    var reduced = prefersReduced();
    var win = body.win;
    var current = scenarios[0];
    var player = null;
    var arrived = false;
    var inView = false;
    var visible = pageVisible;
    // Idempotent guard on autoplay, keyed on what was last played.
    var lastPlayed = null;

    var controls = el("div", "sd-controls");
    var chips = el("div", "sd-chips");
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", label);

    var replay = el("button", "sd-replay");
    replay.type = "button";
    replay.setAttribute("aria-label", "Replay this scenario");
    add(replay, icon(["M3 12a9 9 0 1 0 3-6.7", "M3 4v5h5"], 13, 1.8), el("span", null, "Replay"));
    replay.addEventListener("click", function () {
      if (player) player.play();
    });

    var chipEls = {};
    scenarios.forEach(function (s) {
      var b = el("button", "sd-chip", s.chip);
      b.type = "button";
      b.setAttribute("aria-pressed", s.id === current.id ? "true" : "false");
      b.addEventListener("click", function () {
        pick(s);
      });
      chipEls[s.id] = b;
      add(chips, b);
    });

    add(controls, chips, replay);
    add(host, win, controls, el("p", "sd-caption", caption));

    function onState(state) {
      replay.className = "sd-replay" + (state.finished ? " sd-on" : "");
      body.update(state, current, reduced);
    }

    function build(scenario) {
      if (player) player.reset();
      body.mount(scenario, reduced);
      player = makePlayer(scenario.steps, reduced, onState);
      player.setEnabled(inView && visible);
    }

    function pick(s) {
      if (s.id === current.id) return;
      Object.keys(chipEls).forEach(function (k) {
        chipEls[k].setAttribute("aria-pressed", k === s.id ? "true" : "false");
      });
      current = s;
      build(s);
      maybePlay();
    }

    /* One place owns starting a run, for both reasons a run starts: the
       reader arrived, or they picked a different chip. Keyed on the
       scenario id so it is idempotent. */
    function maybePlay() {
      if (!arrived || !visible) return;
      if (lastPlayed === current.id) return;
      lastPlayed = current.id;
      player.play();
    }

    build(current);

    observe(host, function (st) {
      inView = st.inView;
      arrived = st.arrived;
      if (st.everSeen) win.classList.add("sd-booted");
      if (player) player.setEnabled(inView && visible);
      maybePlay();
    });

    visibleSubs.push(function (v) {
      visible = v;
      if (player) player.setEnabled(inView && visible);
      maybePlay();
    });
  }

  /* =========================================================================
     The four demos
     ========================================================================= */

  // ── macro · the signature Scelo image ──────────────────────────────
  //
  // Three stage cards wired soft -> tools -> hard, each carrying its own
  // scoped chat. Click a stage to walk the pipeline: the stage fills in and
  // the edge into it draws. No timers beyond the fill, and none off-screen.

  function macroDemo(host) {
    var reduced = prefersReduced();
    var win = sceloWindow("clamp(400px, 50vh, 500px)");

    var head = el("div", "sd-brainhead");
    var headL = el("div", null);
    add(headL, el("div", "sd-kicker sd-mono", "Scelo · brain layer"));
    add(headL, el("h3", null, "Soft data → Tools → Hard data."));
    add(
      headL,
      el(
        "p",
        null,
        "The macro view of the AI system's reasoning fabric. Each stage carries its own scoped chatbot."
      )
    );
    var reset = el("span", "sd-tool sd-mono", "reset session");
    reset.setAttribute("aria-hidden", "true");
    add(head, headL, reset);

    var strip = el("div", "sd-quickstrip sd-mono");
    strip.setAttribute("aria-hidden", "true");
    add(strip, el("i", "sd-livedot"), el("span", null, "QUICK EXPLORATION"), el("span", null, "· chats won't persist across reloads"));

    var canvas = el("div", "sd-canvas");
    var cards = [];
    var edges = [];

    MACRO_STAGES.forEach(function (s, i) {
      if (i > 0) {
        var edge = el("div", "sd-edge");
        edge.setAttribute("aria-hidden", "true");
        add(
          edge,
          el("span", "sd-wire"),
          el("span", "sd-edgelabel sd-mono", MACRO_EDGES[i - 1]),
          el("span", "sd-wire"),
          el("span", "sd-arrow", "→")
        );
        edges.push(edge);
        add(canvas, edge);
      }

      var card = el("button", "sd-stagecard sd-glass");
      card.type = "button";
      /* The React original says "Open the ... workstation" here, which is
         true on /scelo only in the sense that nothing opens there either.
         In a manual it would be a straight lie to a screen-reader user, so
         it says what the click actually does. */
      card.setAttribute("aria-label", "Walk the pipeline to the " + s.title.toLowerCase() + " stage");
      add(card, el("div", "sd-stage-tag sd-mono sd-" + s.id, s.id));
      add(card, el("h4", null, s.title));
      add(card, el("p", null, s.subtitle));

      var foot = el("div", "sd-stagefoot");
      var summary = el("span", "sd-summary sd-mono", "—");
      var open = el("span", "sd-open sd-mono", "open →");
      open.setAttribute("aria-hidden", "true");
      add(foot, summary, open);
      add(card, foot);

      var chat = el("div", "sd-nodechat");
      add(chat, el("div", "sd-ph sd-mono", s.chat));
      var send = el("div", "sd-send sd-mono", "press ↵ to send");
      send.setAttribute("aria-hidden", "true");
      add(chat, send);
      add(card, chat);

      card.addEventListener("click", function () {
        setReached(i + 1);
      });

      cards.push({ node: card, summary: summary, stage: s });
      add(canvas, card);
    });

    add(win, head, strip, canvas);
    add(
      host,
      win,
      el(
        "p",
        "sd-caption",
        "The macro canvas, as Scelo draws it. Click a stage to walk the pipeline. An illustration, not a live session."
      )
    );

    // How many stages have been "reached". Starts at 1 (soft) and walks.
    var reached = reduced ? 3 : 1;

    function setReached(n) {
      reached = n;
      cards.forEach(function (c, i) {
        c.node.classList.toggle("sd-reached", reached > i);
        c.summary.textContent = reached > i ? c.stage.summary : "—";
      });
      edges.forEach(function (e, i) {
        e.classList.toggle("sd-on", reached > i + 1);
      });
    }

    setReached(reached);

    /* Walk the pipeline once the reader has actually arrived at it, not the
       moment it clips the bottom of the screen. One timer, cleared on exit.
       The pause is a hard stop rather than a resume: the walk is three
       steps, so restarting it costs nothing and there is no half-state
       worth preserving. */
    var autoplayed = false;
    var timer = null;

    function stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    }

    function walk() {
      var n = 1;
      var step = function () {
        n += 1;
        setReached(n);
        if (n < 3) timer = setTimeout(step, STAGE_MS);
      };
      timer = setTimeout(step, STAGE_MS);
    }

    var inView = false;
    var arrived = false;
    var visible = pageVisible;

    /* `arrived` is retained rather than passed in, because both gates can
       flip independently and the walk needs the AND of them. Reading it
       from a parameter meant the visibility subscriber had nothing true to
       pass: open the docs in a background tab and IO would fire arrived
       while the tab was still hidden (so the walk was refused), then
       switching to the tab supplied arrived=false and it was refused
       again, leaving the homepage hero frozen on stage one forever. */
    function sync() {
      if (!(inView && visible)) {
        stop();
        return;
      }
      if (arrived && !autoplayed && !reduced) {
        autoplayed = true;
        walk();
      }
    }

    observe(host, function (st) {
      inView = st.inView;
      if (st.arrived) arrived = true;
      if (st.everSeen) win.classList.add("sd-booted");
      sync();
    });

    visibleSubs.push(function (v) {
      visible = v;
      sync();
    });
  }

  // ── soft · the chat that cannot lie ────────────────────────────────
  //
  // Scelo's best story, and the honest one: the chat cannot change your
  // dataset by talking about it. The only things that touch data are the
  // fenced `clean` / `derive` / `transform` blocks, and a reply without one
  // changes nothing. That contract is real (SOFT_STAGE_FRAME in
  // SoftDataWorkstation.tsx), so the third scenario here is a refusal.

  function softDemo(host) {
    var win = sceloWindow("clamp(440px, 54vh, 540px)");
    var head = stageHeader({
      stage: "soft",
      crumbs: ["macro view"],
      title: SOFT_DATASET.name,
      meta: SOFT_DATASET.meta,
      tools: SOFT_TOOLS,
      next: "next: tools →",
    });

    var bannerSlot = el("div", null);
    var split = el("div", "sd-split sd-split-soft");

    var gridWrap = el("div", "sd-gridwrap");
    var table = el("table", "sd-grid sd-mono");
    var thead = el("thead", null);
    var tbody = el("tbody", null);
    add(table, thead, tbody);
    var gridFoot = el("div", "sd-gridfoot sd-mono");
    gridFoot.setAttribute("aria-hidden", "true");
    var footRows = el("span", null);
    var footPage = el("span", null);
    add(gridFoot, footRows, footPage);
    add(gridWrap, table, gridFoot);

    var rail = el("div", "sd-rail");
    var log = el("div", "sd-chatlog");
    var pill = chatPill("ask scelo about this dataset…");
    add(rail, panelTitle("soft", "soft · chat"), log, pill.node);

    add(split, gridWrap, rail);
    add(win, head.node, bannerSlot, split);

    // Rail order, as the workstation renders it: activity, then the reply,
    // then the block it emits, then the no-op note.
    var statusSlot = el("div", "sd-statuses");
    var say = el("p", "sd-say");
    var blockSlot = el("div", null);
    var unchangedSlot = el("div", null);
    add(log, statusSlot, say, blockSlot, unchangedSlot);

    var logger = makeLog(statusSlot);
    var stream = null;

    /* Guarded because update() runs on every state hop, including once per
       typed character, while the grid only ever changes when a block
       applies. Ungated this rebuilt ~42 cells per keystroke (273 <td> for
       one scenario, against 42 on screen). `null` forces a draw on mount. */
    var drawn = null;

    function drawGrid(applied) {
      if (drawn === applied) return;
      drawn = applied;
      var grid = applied ? SOFT_GRID_AFTER : SOFT_GRID_BEFORE;
      thead.textContent = "";
      tbody.textContent = "";

      var hr = el("tr", null);
      var h0 = el("th", "sd-rownum", "#");
      h0.setAttribute("aria-hidden", "true");
      add(hr, h0);
      grid.cols.forEach(function (c) {
        add(hr, el("th", null, c));
      });
      add(thead, hr);

      grid.rows.forEach(function (row, i) {
        var tr = el("tr", null);
        var n = el("td", "sd-rownum", String(i + 1));
        n.setAttribute("aria-hidden", "true");
        add(tr, n);
        row.forEach(function (cell) {
          add(tr, el("td", cell.bad ? "sd-bad" : cell.fixed ? "sd-fixed" : null, cell.v));
        });
        add(tbody, tr);
      });

      footRows.textContent = "rows 1–" + grid.rows.length + " of " + (applied ? 50 : 53);
      footPage.textContent = "1 / " + (applied ? 1 : 2);
      head.meta.textContent = applied ? "50 rows · 11 cols" : SOFT_DATASET.meta;
    }

    var body = {
      win: win,
      mount: function (scenario, reduced) {
        logger.clear();
        bannerSlot.textContent = "";
        blockSlot.textContent = "";
        unchangedSlot.textContent = "";
        if (stream) stream.clear();
        say.textContent = "";
        delete say.dataset.on;
        stream = makeStream(say, reduced);
        drawn = null; // scenario switch: force the dirty grid back
        drawGrid(false);
        pill.update("", false);
      },
      update: function (state, scenario) {
        logger.sync(playedKinds(state, "status"), state.finished);

        // Symmetric on purpose: replay resets `played` without remounting,
        // so the stream has to be torn down as well as started or the
        // second run through a scenario shows a reply that never re-types.
        var sayStep = playedKinds(state, "say")[0];
        if (sayStep && !say.dataset.on) {
          say.dataset.on = "1";
          stream.start(sayStep.text);
        } else if (!sayStep && say.dataset.on) {
          delete say.dataset.on;
          stream.clear();
        }

        // The fenced block. This is the thing that acts.
        var showBlock = hasKind(state, "block");
        if (showBlock && scenario.block && !blockSlot.firstChild) {
          var box = el("div", "sd-block");
          add(box, el("div", "sd-blockhead sd-mono", "```" + scenario.block.lang));
          add(box, el("pre", "sd-mono", scenario.block.body));
          add(blockSlot, box);
        } else if (!showBlock) {
          blockSlot.textContent = "";
        }

        var applied = hasKind(state, "apply");
        drawGrid(applied);

        // The cleaning banner only ever appears because a block applied.
        if (applied && scenario.applied && !bannerSlot.firstChild) {
          var banner = el("div", "sd-banner sd-mono");
          var dot = el("i", "sd-dot");
          dot.setAttribute("aria-hidden", "true");
          add(banner, dot, el("span", null, scenario.applied));
          add(bannerSlot, banner);
        } else if (!applied) {
          bannerSlot.textContent = "";
        }

        // No block, no change. Said plainly.
        if (state.finished && !scenario.block && !unchangedSlot.firstChild) {
          add(unchangedSlot, el("div", "sd-unchanged sd-mono", "dataset unchanged"));
        } else if (!state.finished) {
          unchangedSlot.textContent = "";
        }

        pill.update(state.typed, state.running && !state.finished);
      },
    };

    chipRunner(
      host,
      SOFT_SCENARIOS,
      "Soft data scenarios",
      "The Soft Data workstation. Pick a scenario to see what the chat can and cannot do. An illustration, not a live session.",
      body
    );
  }

  // ── tools · the model bench ────────────────────────────────────────
  //
  // A DATASET HUB with models attached to it over dashed edges, plus the
  // catalog rail grouped by family. Model names and family colours are
  // verbatim from modelCatalog.ts (the middot in "GLM · frequency" is house
  // style, not decoration).

  function toolsDemo(host) {
    var win = sceloWindow("clamp(440px, 54vh, 540px)");
    var head = stageHeader({
      stage: "tools",
      crumbs: ["macro view", "back: soft"],
      title: "workstation",
      meta: TOOLS_DATASET.meta,
      tools: ["identify models", "re-layout", "export · code"],
      next: "next: hard →",
    });

    var split = el("div", "sd-split sd-split-rail");
    var flow = el("div", "sd-flow");
    var row = el("div", "sd-flowrow");

    var hub = el("div", "sd-hub sd-hub-dataset sd-glass");
    add(hub, el("div", "sd-hubtag sd-mono sd-fam-reserving", "dataset hub"));
    var hubName = el("div", "sd-hubname", TOOLS_DATASET.name);
    hubName.title = TOOLS_DATASET.name;
    add(hub, hubName, el("div", "sd-hubmeta sd-mono", TOOLS_DATASET.meta));
    var attachCount = el("div", "sd-hubmeta sd-mono", "no models attached");
    add(hub, attachCount);

    var dash = el("span", "sd-dash");
    dash.setAttribute("aria-hidden", "true");
    var nodes = el("div", "sd-nodes");
    add(row, hub, dash, nodes);
    add(flow, row);

    var rail = el("div", "sd-rail");
    var catalog = el("div", "sd-catalog");
    CATALOG.forEach(function (f) {
      var box = el("div", null);
      add(box, el("div", "sd-famhead sd-mono sd-fam-" + f.name, f.name));
      f.models.forEach(function (m) {
        var line = el("div", "sd-model");
        var plus = el("i", null, "+");
        plus.setAttribute("aria-hidden", "true");
        add(line, el("span", null, m), plus);
        add(box, line);
      });
      add(catalog, box);
    });

    var log = el("div", "sd-chatlog");
    var pill = chatPill("ask scelo about these models…");
    add(rail, panelTitle(null, "catalog"), catalog, panelTitle("tools", "tools · chat"), log, pill.node);

    add(split, flow, rail);
    add(win, head.node, split);

    // Activity first, then the reply. See the note in softDemo.
    var statusSlot = el("div", "sd-statuses");
    var say = el("p", "sd-say");
    add(log, statusSlot, say);

    var logger = makeLog(statusSlot);
    var stream = null;

    function drawGhosts() {
      nodes.textContent = "";
      for (var i = 0; i < 3; i++) {
        var g = el("div", "sd-ghost");
        g.setAttribute("aria-hidden", "true");
        add(g, el("i", null), el("i", null));
        add(nodes, g);
      }
    }

    var body = {
      win: win,
      mount: function (scenario, reduced) {
        logger.clear();
        if (stream) stream.clear();
        say.textContent = "";
        delete say.dataset.on;
        stream = makeStream(say, reduced);
        drawGhosts();
        attachCount.textContent = "no models attached";
        pill.update("", false);
      },
      update: function (state, scenario, reduced) {
        logger.sync(playedKinds(state, "status"), state.finished);

        var attached = hasKind(state, "apply");
        if (attached && !nodes.dataset.on) {
          nodes.dataset.on = "1";
          nodes.textContent = "";
          scenario.attach.forEach(function (m, i) {
            var n = el("div", "sd-node sd-bord-" + m.family);
            n.style.animationDelay = reduced ? "0ms" : i * 90 + "ms";
            add(n, el("div", "sd-family sd-mono sd-fam-" + m.family, m.family));
            add(n, el("div", "sd-nodename", m.name));
            var note = el("div", "sd-note", m.note);
            note.title = m.note;
            add(n, note);
            add(nodes, n);
          });
          attachCount.textContent = scenario.attach.length + " models attached";
        }
        if (!attached && nodes.dataset.on) {
          delete nodes.dataset.on;
          drawGhosts();
          attachCount.textContent = "no models attached";
        }

        var sayStep = playedKinds(state, "say")[0];
        if (sayStep && !say.dataset.on) {
          say.dataset.on = "1";
          stream.start(sayStep.text);
        } else if (!sayStep && say.dataset.on) {
          delete say.dataset.on;
          stream.clear();
        }

        pill.update(state.typed, state.running && !state.finished);
      },
    };

    chipRunner(
      host,
      TOOLS_SCENARIOS,
      "Model scenarios",
      "The Tools workstation. Pick a scenario to watch models attach to the hub. An illustration, not a live session.",
      body
    );
  }

  // ── hard · the readout desk ────────────────────────────────────────
  //
  // Result nodes flowing inward into the Board Pack hub, each carrying a
  // headline metric. Shapes and numbers follow HardDataWorkstation; the
  // council action is the real cross-app call to the swarm on :3010.

  function hardDemo(host) {
    var win = sceloWindow("clamp(440px, 54vh, 540px)");
    var head = stageHeader({
      stage: "hard",
      crumbs: ["macro view", "back: tools"],
      title: "workstation",
      meta: "4 models attached",
      tools: ["rerun & regenerate", "export · code"],
      next: "report · pdf",
    });

    var split = el("div", "sd-split sd-split-rail");
    var flow = el("div", "sd-flow");
    var row = el("div", "sd-flowrow");

    var nodes = el("div", "sd-nodes");
    var dash = el("span", "sd-dash sd-dash-error");
    dash.setAttribute("aria-hidden", "true");

    var hub = el("div", "sd-hub sd-hub-pack sd-glass");
    add(hub, el("div", "sd-hubtag sd-mono sd-fam-pricing", "board pack"));
    add(hub, el("div", "sd-hubname", "lifelib_basic_term_mp"));
    add(hub, el("div", "sd-hubmeta sd-mono", "4 results · life"));
    var narrative = el("p", "sd-narrative", "—");
    add(hub, narrative);

    add(row, nodes, dash, hub);
    add(flow, row);

    var rail = el("div", "sd-rail");
    var log = el("div", "sd-chatlog");
    var pill = chatPill("ask scelo about these 4 results…");
    add(rail, panelTitle("hard", "hard · chat"), log, pill.node);

    add(split, flow, rail);
    add(win, head.node, split);

    // Activity first, then the forecast affordance. See the note in softDemo.
    var statusSlot = el("div", "sd-statuses");
    var forecastSlot = el("div", null);
    add(log, statusSlot, forecastSlot);

    var logger = makeLog(statusSlot);
    var stream = null;

    var body = {
      win: win,
      mount: function (scenario, reduced) {
        logger.clear();
        if (stream) stream.stop();
        narrative.textContent = "—";
        delete narrative.dataset.on;
        stream = makeStream(narrative, reduced);
        forecastSlot.textContent = "";
        pill.update("", false);

        nodes.textContent = "";
        HARD_RESULTS.forEach(function (r, i) {
          var n = el("div", "sd-node sd-result sd-bord-" + r.family);
          n.style.animationDelay = reduced ? "0ms" : i * 80 + "ms";
          add(n, el("div", "sd-family sd-mono sd-fam-" + r.family, r.family));
          add(n, el("div", "sd-resultname", r.name));
          var metric = el("div", "sd-metric");
          add(metric, el("span", "sd-value", r.value), el("span", "sd-label sd-mono", r.label));
          add(n, metric);
          add(nodes, n);
        });
      },
      update: function (state, scenario) {
        logger.sync(playedKinds(state, "status"), state.finished);

        var showPack = hasKind(state, "apply");
        if (showPack && !narrative.dataset.on) {
          narrative.dataset.on = "1";
          stream.start(scenario.narrative);
        } else if (!showPack && narrative.dataset.on) {
          delete narrative.dataset.on;
          stream.stop();
          narrative.textContent = "—";
        }

        if (state.finished && !forecastSlot.firstChild) {
          var box = el("div", "sd-forecast");
          box.setAttribute("aria-hidden", "true");
          add(box, el("div", "sd-fhead sd-mono", "forecast forward · W(M, T, R)"));
          add(box, el("div", "sd-frun sd-mono", "▷ run forecast"));
          add(forecastSlot, box);
        } else if (!state.finished) {
          forecastSlot.textContent = "";
        }

        pill.update(state.typed, state.running && !state.finished);
      },
    };

    chipRunner(
      host,
      HARD_SCENARIOS,
      "Board pack scenarios",
      "The Hard Data workstation. Pick a scenario to build the board pack. An illustration, not a live session.",
      body
    );
  }

  /* =========================================================================
     The swarm demos

     The swarm wears its own chrome: a wordmark, six tabs and a live status
     cluster, with a decision sidebar pinned right. Nothing here reuses
     SceloWindow, because the swarm is not the Workbench.
     ========================================================================= */

  /** The swarm shell. Returns setTab so a script's `tab` step can move the
   *  active tab as the run progresses, which is what the product does when
   *  a council lands. */
  function swarmWindow(active) {
    var win = el("div", "sd-window sd-swarmwin");
    win.style.minHeight = "clamp(440px, 54vh, 560px)";

    // The Scelo IDE strip the swarm is embedded in.
    var top = el("div", "sd-swarmtop");
    top.setAttribute("aria-hidden", "true");
    add(top, el("span", "sd-backchip sd-mono", "↰ Back to Scelo"));
    add(top, el("span", "sd-mono sd-swarmcrumb", "scelo ide · swarm"));
    var live = el("span", "sd-swarmlive sd-mono");
    add(live, el("i", "sd-livedot"), el("span", null, "live"));
    add(top, live);

    // The swarm's own bar: wordmark, tabs, status cluster.
    var bar = el("div", "sd-swarmbar");
    add(bar, el("div", "sd-wordmark", "swarm council"));

    var tabs = el("div", "sd-tabs");
    tabs.setAttribute("role", "group");
    tabs.setAttribute("aria-label", "Swarm tabs");
    var tabEls = {};
    SWARM_TABS.forEach(function (t) {
      var b = el("span", "sd-tab", t.label);
      tabEls[t.id] = b;
      add(tabs, b);
    });
    add(bar, tabs);

    var status = el("div", "sd-statuscluster");
    status.setAttribute("aria-hidden", "true");
    add(status, el("span", "sd-muted", "api"));
    add(status, el("span", "sd-statusok", "ok"));
    add(status, el("span", "sd-muted", "·"));
    add(status, el("span", "sd-muted sd-ollama", SWARM_STATUS.ollama));
    add(status, el("span", "sd-muted", "·"));
    add(status, el("span", "sd-muted", SWARM_STATUS.canon));
    // Lowercase on purpose: `button { text-transform: none }` beats the
    // cluster's inherited uppercase in the real app.
    add(status, el("span", "sd-swarmbtn", "auto"));
    add(status, el("span", "sd-swarmbtn", "?"));
    add(status, el("span", "sd-swarmbtn", "settings"));
    add(bar, status);

    add(win, top, bar);

    function setTab(id) {
      SWARM_TABS.forEach(function (t) {
        tabEls[t.id].classList.toggle("sd-tab-on", t.id === id);
      });
    }
    setTab(active);

    return { node: win, setTab: setTab, initial: active };
  }

  /** The decision sidebar, pinned right on every swarm tab. */
  function decisionSidebar(idleText) {
    var rail = el("div", "sd-rail sd-decision");
    add(rail, panelTitle(null, "decision sidebar"));
    var body = el("div", "sd-chatlog");
    var head = el("div", "sd-decision-head sd-mono", "no selection");
    var text = el("p", "sd-say", idleText);
    add(body, head, text);
    add(rail, body);
    return { node: rail, head: head, text: text };
  }

  /** Reads the last `tab` step a script has played. */
  function lastTab(state, fallback) {
    var tab = fallback;
    state.played.forEach(function (s) {
      if (s.kind === "tab") tab = s.to;
    });
    return tab;
  }

  // ── swarm · the council deliberates ────────────────────────────────

  function swarmDemo(host) {
    var shell = swarmWindow("forecast");
    var win = shell.node;

    var split = el("div", "sd-split sd-split-rail");
    var main = el("div", "sd-flow sd-swarmmain");

    // Forecast face: the welcome heading, the scenario card, the presets.
    var forecastPane = el("div", "sd-pane");
    add(forecastPane, el("h3", "sd-centerhead", "Welcome — what community shall we forecast?"));
    var card = el("div", "sd-scenariocard");
    var scenText = el("p", "sd-scentext");
    var cardFoot = el("div", "sd-scenariofoot");
    var hint = el("span", "sd-mono sd-muted", "⌘↵ to forecast");
    var convene = el("span", "sd-swarmcta", "Forecast & convene");
    add(cardFoot, hint, convene);
    add(card, scenText, cardFoot);
    add(forecastPane, card);
    var presets = el("div", "sd-presets");
    presets.setAttribute("aria-hidden", "true");
    ["Pension fund · EM REIT", "Life insurer · CSM release", "Sovereign fund · transition", "Rural village · Mozambique drought"].forEach(
      function (p) {
        add(presets, el("span", "sd-preset", p));
      }
    );
    add(forecastPane, presets);

    // Council face: the eight agents, then the readback strip.
    var councilPane = el("div", "sd-pane");
    add(councilPane, el("div", "sd-paneleyebrow sd-mono", "council readback · profession → trust the forecast? → confidence"));
    var agentGrid = el("div", "sd-agents");
    add(councilPane, agentGrid);
    var readback = el("div", "sd-readback");
    add(councilPane, readback);
    var interv = el("div", "sd-interv");
    add(councilPane, interv);

    add(main, forecastPane, councilPane);

    var side = decisionSidebar(SIDEBAR_IDLE);
    add(split, main, side.node);
    add(win, split);

    var body = {
      win: win,
      mount: function (scenario) {
        shell.setTab("forecast");
        forecastPane.classList.add("sd-on");
        councilPane.classList.remove("sd-on");
        scenText.textContent = scenario.chip;
        convene.textContent = "Forecast & convene";
        agentGrid.textContent = "";
        readback.textContent = "";
        interv.textContent = "";
        side.head.textContent = "no selection";
        side.text.textContent = SIDEBAR_IDLE;
        delete agentGrid.dataset.on;
      },
      update: function (state, scenario, reduced) {
        var tab = lastTab(state, "forecast");
        shell.setTab(tab);
        forecastPane.classList.toggle("sd-on", tab === "forecast");
        councilPane.classList.toggle("sd-on", tab !== "forecast");
        convene.textContent = state.running ? "Forecasting…" : "Forecast & convene";

        var landed = hasKind(state, "apply");
        if (landed && !agentGrid.dataset.on) {
          agentGrid.dataset.on = "1";
          SWARM_AGENTS.forEach(function (a, i) {
            var stance = scenario.stances[a.name];
            var n = el("div", "sd-agent sd-st-" + stance);
            n.style.animationDelay = reduced ? "0ms" : i * 70 + "ms";
            var dot = el("i", "sd-agentdot");
            // Profession palette is hard-coded hex in the product and does
            // not flip with the theme, so it is set inline here too.
            dot.style.background = a.color;
            var name = el("span", "sd-agentname", a.name);
            var pill = el("span", "sd-stance sd-mono", STANCE_LABEL[stance]);
            add(n, dot, name, pill);
            add(agentGrid, n);
          });

          scenario.readback.forEach(function (t) {
            var tile = el("div", "sd-rbtile");
            add(tile, el("div", "sd-rbvalue", t.value));
            add(tile, el("div", "sd-rblabel sd-mono", t.label));
            add(tile, el("div", "sd-rbsub sd-mono", t.sub));
            add(readback, tile);
          });

          // WmtrStrip.tsx:417-447. Four separate spans, no middot.
          var box = el("div", "sd-intervbox");
          add(box, el("div", "sd-paneleyebrow sd-mono", "consensus interventions"));
          add(box, el("div", "sd-mono sd-muted sd-intervsub", "choose one to re-simulate"));
          var chip = el("span", "sd-intervchip sd-mono");
          add(
            chip,
            el("span", "sd-ivcount", scenario.intervention.count),
            el("span", "sd-ivdir", scenario.intervention.dir),
            el("span", "sd-ivparam", scenario.intervention.param),
            el("span", "sd-ivmag", scenario.intervention.mag)
          );
          add(box, chip);
          add(box, el("p", "sd-rationale", "“" + scenario.rationale + "”"));
          add(box, el("span", "sd-swarmcta sd-mono", "▶ apply & re-simulate"));
          add(interv, box);

          side.text.textContent = SIDEBAR_RUN;
        } else if (!landed && agentGrid.dataset.on) {
          delete agentGrid.dataset.on;
          agentGrid.textContent = "";
          readback.textContent = "";
          interv.textContent = "";
          side.text.textContent = SIDEBAR_IDLE;
        }
      },
    };

    chipRunner(
      host,
      SWARM_SCENARIOS,
      "Swarm scenarios",
      "The council, as the swarm convenes it: three rounds, then eight professions land a stance. Pick a scenario to run it. An illustration, not a live session: a real council is an LLM call and lands differently every time.",
      body
    );
  }

  // ── simulation ─────────────────────────────────────────────────────

  function simulationDemo(host) {
    var shell = swarmWindow("simulation");
    var win = shell.node;

    var split = el("div", "sd-split sd-split-rail");
    var main = el("div", "sd-flow sd-swarmmain");

    var setup = el("div", "sd-pane sd-on");
    add(setup, el("div", "sd-paneleyebrow sd-mono", "scenario · medical or social shock"));
    var simChips = el("div", "sd-presets");
    simChips.setAttribute("aria-hidden", "true");
    var simChipEls = {};
    SIM_SCENARIOS.forEach(function (s) {
      var c = el("span", "sd-preset", s.chip);
      simChipEls[s.id] = c;
      add(simChips, c);
    });
    add(setup, simChips);
    var simBody = el("p", "sd-scentext sd-simbody");
    add(setup, simBody);

    var controls = el("div", "sd-simcontrols");
    var drugsBox = el("div", "sd-simfield");
    add(drugsBox, el("div", "sd-paneleyebrow sd-mono", "drugs / compounds"));
    var drugsIn = el("div", "sd-siminput sd-mono");
    add(drugsBox, drugsIn);
    var sizeBox = el("div", "sd-simfield");
    var sizeLabel = el("div", "sd-paneleyebrow sd-mono", "sample size · 120");
    add(sizeBox, sizeLabel, slider(0.1));
    var popBox = el("div", "sd-simfield");
    add(popBox, el("div", "sd-paneleyebrow sd-mono", "population · 62.27M"), slider(0.31));
    var runBtn = el("span", "sd-swarmcta sd-mono sd-runbtn", "▶ run simulation");
    add(controls, drugsBox, sizeBox, popBox, runBtn);
    add(setup, controls);

    // Progress panel. Four fixed phases that walk; see the honesty note on
    // SIM_PHASES.
    var progress = el("div", "sd-simprogress");
    var phaseEls = [];
    add(progress, el("div", "sd-paneleyebrow sd-mono", "simulating"));
    SIM_PHASES.forEach(function (p) {
      var row = el("div", "sd-phase");
      add(row, el("i", "sd-phasedot"), el("span", "sd-phaselabel", p.label), el("span", "sd-phasehint sd-mono", p.hint));
      phaseEls.push(row);
      add(progress, row);
    });
    add(setup, progress);

    var results = el("div", "sd-simresults");
    add(setup, results);

    add(main, setup);
    var side = decisionSidebar(SIDEBAR_IDLE);
    add(split, main, side.node);
    add(win, split);

    var body = {
      win: win,
      mount: function (scenario) {
        Object.keys(simChipEls).forEach(function (k) {
          simChipEls[k].classList.toggle("sd-preset-on", k === scenario.id);
        });
        simBody.textContent = scenario.body;
        drugsIn.textContent = scenario.drugs || "—";
        runBtn.textContent = "▶ run simulation";
        results.textContent = "";
        progress.classList.remove("sd-on");
        phaseEls.forEach(function (r) {
          r.className = "sd-phase";
        });
        delete results.dataset.on;
      },
      update: function (state, scenario, reduced) {
        var done = playedKinds(state, "status").length;
        progress.classList.toggle("sd-on", done > 0 && !state.finished);
        runBtn.textContent = state.running ? "simulating…" : "▶ run simulation";
        phaseEls.forEach(function (r, i) {
          r.className = "sd-phase " + (i < done - 1 ? "sd-phase-done" : i === done - 1 ? "sd-phase-active" : "sd-phase-pending");
        });

        var landed = hasKind(state, "apply");
        if (landed && !results.dataset.on) {
          results.dataset.on = "1";
          add(results, el("div", "sd-paneleyebrow sd-mono", "macro impact · scaled to 62.27M population"));
          var grid = el("div", "sd-macrogrid");
          scenario.macro.forEach(function (t, i) {
            var tile = el("div", "sd-macrotile");
            tile.style.animationDelay = reduced ? "0ms" : i * 60 + "ms";
            add(tile, el("div", "sd-rblabel sd-mono", t.label));
            add(tile, el("div", "sd-macrovalue sd-tone-" + t.tone, t.value));
            add(tile, el("div", "sd-rbsub sd-mono", t.sub));
            add(grid, tile);
          });
          add(results, grid);
        } else if (!landed && results.dataset.on) {
          delete results.dataset.on;
          results.textContent = "";
        }
      },
    };

    chipRunner(
      host,
      SIM_SCENARIOS,
      "Simulation scenarios",
      "The population simulator: a scenario, the compounds, then macro impact scaled to the country. Pick a scenario to run it. An illustration, not a live session: the real tiles are computed server-side, and the four progress phases are paced by the product itself rather than reported by the server.",
      body
    );
  }

  /** A read-only slider, drawn at a fixed position. */
  function slider(frac) {
    var s = el("div", "sd-slider");
    s.setAttribute("aria-hidden", "true");
    var knob = el("i", "sd-knob");
    knob.style.left = frac * 100 + "%";
    add(s, knob);
    return s;
  }

  // ── iaai canon ─────────────────────────────────────────────────────

  function canonDemo(host) {
    var shell = swarmWindow("canon");
    var win = shell.node;

    var split = el("div", "sd-split sd-split-rail");
    var main = el("div", "sd-flow sd-swarmmain");
    var pane = el("div", "sd-pane sd-on");

    add(pane, el("h3", "sd-centerhead", "IAAI Canon"));

    var note = el("div", "sd-canonnote");
    add(note, el("span", null, CANON_NOTE_A));
    add(note, el("code", "sd-mono", CANON_NOTE_CODE));
    add(note, el("span", null, CANON_NOTE_B));
    add(pane, note);

    var head = el("div", "sd-canonhead");
    var count = el("div", "sd-paneleyebrow sd-mono", "canon (0)");
    var acts = el("span", "sd-canonacts");
    add(acts, el("span", "sd-swarmbtn", "+ add row"), el("span", "sd-swarmcta sd-mono", "save"));
    add(head, count, acts);
    add(pane, head);

    var rows = el("div", "sd-canonrows");
    add(pane, rows);

    var toast = el("div", "sd-toastslot");
    add(pane, toast);

    // Import strip.
    var imp = el("div", "sd-import");
    add(imp, el("div", "sd-paneleyebrow sd-mono", "import — paste or upload"));
    var accepts = el("div", "sd-accepts");
    add(accepts, el("span", null, "accepts "));
    add(accepts, el("code", "sd-mono", ".json"));
    add(accepts, el("span", null, " (array or "));
    add(accepts, el("code", "sd-mono", "{works:[...]}"));
    add(accepts, el("span", null, ") and "));
    add(accepts, el("code", "sd-mono", ".bib"));
    add(accepts, el("span", null, " (BibTeX)."));
    add(imp, accepts);

    var impRow = el("div", "sd-importrow");
    var fmtSel = el("span", "sd-select sd-mono", "json");
    var modeSel = el("span", "sd-select sd-mono", "append");
    add(impRow, el("span", "sd-mono sd-muted", "format"), fmtSel);
    add(impRow, el("span", "sd-mono sd-muted", "mode"), modeSel);
    add(impRow, el("span", "sd-swarmbtn", "upload file"), el("span", "sd-swarmbtn", "sample"), el("span", "sd-swarmcta sd-mono", "import"));
    add(imp, impRow);

    var paste = el("div", "sd-pasteslot");
    add(imp, paste);
    add(pane, imp);

    add(main, pane);
    var side = decisionSidebar(SIDEBAR_IDLE);
    // CanonPanel's sidebar state is headed `canon`, not `no selection`.
    side.head.textContent = "canon";
    side.text.textContent =
      "The IAAI Canon is the knowledge base every agent reads from. Edits here propagate to the next run. The decision sidebar activates again when you switch to Council, Society or Synthesis.";
    add(split, main, side.node);
    add(win, split);

    var body = {
      win: win,
      mount: function (scenario) {
        // A fresh clone really does start here.
        rows.textContent = "";
        add(rows, el("div", "sd-canonempty sd-mono", CANON_EMPTY));
        count.textContent = "canon (0)";
        fmtSel.textContent = scenario.format;
        modeSel.textContent = "append";
        paste.textContent = "";
        toast.textContent = "";
        delete rows.dataset.on;
      },
      update: function (state, scenario) {
        var showPaste = hasKind(state, "block");
        if (showPaste && !paste.firstChild) {
          var pre = el("pre", "sd-paste sd-mono", scenario.paste);
          add(paste, pre);
        } else if (!showPaste) {
          paste.textContent = "";
        }

        var imported = hasKind(state, "apply");
        if (imported && !rows.dataset.on) {
          rows.dataset.on = "1";
          rows.textContent = "";
          var r = el("div", "sd-canonrow");
          var top = el("div", "sd-canonrowtop");
          add(top, el("span", "sd-canontitle", scenario.row.title));
          add(top, el("span", "sd-canonyear sd-mono", scenario.row.year));
          add(top, el("span", "sd-swarmbtn", "remove"));
          add(r, top);
          add(r, el("div", "sd-canonurl sd-mono", "url (optional)"));
          add(
            r,
            el(
              "div",
              "sd-canontakeaway" + (scenario.row.takeaway ? "" : " sd-canonph"),
              scenario.row.takeaway ||
                "1-line takeaway (preferred over abstract — what the model should know)"
            )
          );
          add(rows, r);
          count.textContent = "canon (1)";
          add(toast, el("div", "sd-toast sd-mono", scenario.toast));
        } else if (!imported && rows.dataset.on) {
          delete rows.dataset.on;
          rows.textContent = "";
          add(rows, el("div", "sd-canonempty sd-mono", CANON_EMPTY));
          count.textContent = "canon (0)";
          toast.textContent = "";
        }
      },
    };

    chipRunner(
      host,
      CANON_SCENARIOS,
      "Canon import scenarios",
      "The canon editor, starting where a fresh install starts: empty. Pick a format to import the built-in sample. An illustration, not a live session.",
      body
    );
  }

  // ── mount ──────────────────────────────────────────────────────────

  /* Each demo names itself. These carry what the alt text on the
     screenshots used to: without them the mounted demo is an unlabelled
     cluster of buttons, because its chrome is nearly all aria-hidden and
     a bare <div> has no accessible name of its own. */
  var DEMOS = {
    macro: {
      build: macroDemo,
      label:
        "Illustration: the Scelo macro canvas, with Soft Data, Tools and Hard Data as three wired stage cards",
    },
    soft: {
      build: softDemo,
      label:
        "Illustration: the Soft Data workstation, with the data grid, the cleaning banner and the scoped chat",
    },
    tools: {
      build: toolsDemo,
      label:
        "Illustration: the Tools workstation, with the dataset hub, attached model nodes and the model catalog",
    },
    hard: {
      build: hardDemo,
      label:
        "Illustration: the Hard Data workstation, with result nodes on the canvas and a board-pack hub",
    },
    swarm: {
      build: swarmDemo,
      label:
        "Illustration: the swarm council, with the forecast tab, the deliberation rounds and eight professions landing a stance",
    },
    simulation: {
      build: simulationDemo,
      label:
        "Illustration: the swarm Simulation tab, with scenario chips, compounds, sample size and population, and the macro impact tiles",
    },
    canon: {
      build: canonDemo,
      label:
        "Illustration: the IAAI Canon editor, with reference works and import for JSON or BibTeX",
    },
  };

  function boot() {
    var hosts = document.querySelectorAll("[data-scelo-demo]");
    for (var i = 0; i < hosts.length; i++) {
      var host = hosts[i];
      if (host.dataset.sceloMounted) continue;
      var demo = DEMOS[host.dataset.sceloDemo];
      if (!demo) continue;
      host.dataset.sceloMounted = "1";
      // Drops the no-JS fallback the page ships inside the host.
      host.textContent = "";
      host.setAttribute("role", "group");
      host.setAttribute("aria-label", demo.label);
      demo.build(host);
    }
  }

  /* Material ships an instant-loading SPA router (navigation.instant), which
     swaps <main> without a document load. document$ is its per-page hook;
     fall back to a plain listener when it is absent. */
  if (window.document$ && typeof window.document$.subscribe === "function") {
    window.document$.subscribe(boot);
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
