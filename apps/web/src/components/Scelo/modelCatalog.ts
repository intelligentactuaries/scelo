// Fixed catalog of models the Tools workstation can recommend / select.
// The AI picker is constrained to ids from this list; the heuristic
// fallback uses the `applicableTo` tags to match by data signature.

export type ModelFamily =
  | "reserving"
  | "mortality"
  | "pricing"
  | "climate"
  | "capital"
  | "pensions"
  // `life` covers the lifelib-rooted life-insurance projection models:
  // BasicTerm pricing & projection, CashValue / savings, IFRS17 CSM,
  // Solvency II life SCR, nested stochastic, Smith-Wilson curve fit,
  // model-point clustering, economic curves. Distinct from `mortality`
  // (which is the data-fitting layer) and from `capital` (which is the
  // result-aggregation layer) because lifelib lives at the layer in
  // between: a policy-level projection engine.
  | "life"
  // `forecast` is the WMTR Monte Carlo capability: project the modelled
  // entity forward under shocks using the W(M, T, R) Cobb-Douglas survival
  // engine. Domain-agnostic — the same math powers community survival, life
  // book stress, pension covenant resilience, reserve inflation forecasts,
  // etc. The Hard Data card relabels M/T/R per source family.
  | "forecast"
  // `workspace` is the interpretable-by-design bottleneck: a few sparse,
  // non-negative, nameable codes broadcast to many report heads (generalizing
  // Lee-Carter and NMF). Distinct from the post-hoc "validate workspace" action
  // on Hard Data (which is model-agnostic and not a catalog model).
  | "workspace"
  | "general";

export type CatalogModel = {
  id: string;
  name: string;
  family: ModelFamily;
  description: string;
  /** What the dataset must contain for the model to run at all — shown to
   *  the AI picker, whose picks are then checked by modelApplicability. */
  needs?: string;
  // Free-form tags used by the local heuristic to match a column signature.
  // E.g. a dataset with `origin_year`, `dev_period`, `paid` triggers
  // tags `triangle`, `paid`, `reserving`.
  applicableTo: string[];
};

export const MODEL_CATALOG: CatalogModel[] = [
  // ── reserving ─────────────────────────────────────────────────────────────
  {
    id: "chain-ladder",
    name: "Chain Ladder",
    family: "reserving",
    needs: "a claims triangle: origin_year, dev_period, paid",
    description: "Cumulative paid-claims projection via age-to-age factors.",
    applicableTo: ["triangle", "paid", "incurred", "reserving"],
  },
  {
    id: "mack",
    name: "Mack Chain Ladder",
    family: "reserving",
    needs: "a claims triangle: origin_year, dev_period, paid",
    description: "Chain ladder with closed-form variance / reserve uncertainty.",
    applicableTo: ["triangle", "paid", "reserving", "uncertainty"],
  },
  {
    id: "bornhuetter-ferguson",
    name: "Bornhuetter–Ferguson",
    family: "reserving",
    needs: "a claims triangle: origin_year, dev_period, paid",
    description: "Blends chain-ladder with an a-priori expected loss ratio.",
    applicableTo: ["triangle", "paid", "reserving", "sparse", "prior"],
  },
  {
    id: "bootstrap-ibnr",
    name: "Bootstrap (IBNR)",
    family: "reserving",
    needs: "a claims triangle: origin_year, dev_period, paid",
    description: "Resampling residuals for a full IBNR predictive distribution.",
    applicableTo: ["triangle", "paid", "reserving", "uncertainty", "simulation"],
  },
  // ── mortality ─────────────────────────────────────────────────────────────
  {
    id: "lee-carter",
    name: "Lee–Carter",
    family: "mortality",
    needs: "a mortality table: death rates (qx / mx / deaths + exposure) by age AND year, 3+ years",
    description: "Stochastic age-time mortality model with a single time index.",
    applicableTo: ["mortality", "age", "year", "deaths", "exposure"],
  },
  {
    id: "cbd",
    name: "Cairns–Blake–Dowd",
    family: "mortality",
    needs: "a mortality table: death rates (qx / mx / deaths + exposure) by age AND year, 3+ years",
    description: "Two-factor old-age mortality model.",
    applicableTo: ["mortality", "age", "year", "deaths"],
  },
  {
    id: "lifecontingencies",
    name: "Life Contingencies",
    family: "mortality",
    needs: "a life table: age with qx (or mx, or deaths + exposure)",
    description: "Annuity and insurance pricing on a life table.",
    applicableTo: ["mortality", "age", "sex", "pricing", "lifecontingencies"],
  },
  // ── pricing ───────────────────────────────────────────────────────────────
  {
    id: "glm-frequency",
    name: "GLM · frequency",
    family: "pricing",
    needs: "a claim-count column plus categorical rating factors",
    description: "Poisson GLM for claim frequency.",
    applicableTo: ["claims", "frequency", "covariates", "pricing"],
  },
  {
    id: "glm-severity",
    name: "GLM · severity",
    family: "pricing",
    needs: "a claim-amount column plus categorical rating factors",
    description: "Gamma or lognormal GLM for claim severity.",
    applicableTo: ["claims", "severity", "covariates", "pricing"],
  },
  {
    id: "gbm",
    name: "GBM (LightGBM)",
    family: "pricing",
    needs:
      "50+ rows with a numeric target (claim amount, claim count, 0/1 outcome, or the last numeric column)",
    description: "Gradient boosting for nonlinear pricing.",
    applicableTo: ["claims", "covariates", "pricing", "nonlinear"],
  },
  {
    id: "shap",
    name: "SHAP explainability",
    family: "pricing",
    needs: "50+ rows with a numeric target (it explains the GBM)",
    description: "Per-row contribution attribution for any tree / linear model.",
    applicableTo: ["pricing", "explainability", "transparency"],
  },
  // ── climate / cat ─────────────────────────────────────────────────────────
  {
    id: "climada",
    name: "CLIMADA",
    family: "climate",
    needs: "an exposure column: sum insured / TIV / exposure",
    description: "Climate hazard exposure and impact modelling.",
    applicableTo: ["climate", "geographic", "hazard", "exposure"],
  },
  {
    id: "parametric-design",
    name: "Parametric Design",
    family: "climate",
    needs: "a monetary loss column",
    description: "Trigger-based payouts for cat / climate.",
    applicableTo: ["climate", "parametric", "trigger"],
  },
  // ── capital ───────────────────────────────────────────────────────────────
  {
    id: "scr-standard",
    name: "SCR · Standard Formula",
    family: "capital",
    description: "Solvency II / SAM Standard Formula SCR.",
    applicableTo: ["capital", "solvency", "scr"],
  },
  {
    id: "esg",
    name: "Economic Scenario Generator",
    family: "capital",
    description: "Stochastic economic paths for ALM / capital.",
    applicableTo: ["capital", "esg", "simulation"],
  },
  // ── pensions ──────────────────────────────────────────────────────────────
  {
    id: "db-valuation",
    name: "DB / DC Valuation",
    family: "pensions",
    description: "Actuarial liability valuation for pension funds.",
    applicableTo: ["pensions", "liability", "mortality"],
  },
  // ── life · lifelib-rooted (lifelib-dev/lifelib) ───────────────────────────
  // Every entry below maps 1:1 to a lifelib library so the user can pivot
  // from the in-app projection to the canonical Python implementation. The
  // authoritative mapping (library, model, active/legacy status, pinned
  // lifelib version) is LIFELIB_TARGETS in @scelo/core — keep the "Lifelib →"
  // tail of each description in step with it.
  {
    id: "basicterm-projection",
    name: "BasicTerm · projection",
    family: "life",
    needs: "a model-point file: age_at_entry, sum_assured, policy_term",
    description:
      "Monthly term-life projection on a model-point file (pol-in-force, mortality decrement, premium, claim, reserve, profit). Lifelib → basiclife / BasicTerm_ME (BasicTerm_M for a pure new-business file).",
    applicableTo: [
      "life",
      "term",
      "model-points",
      "policy_id",
      "age_at_entry",
      "sex",
      "sum_assured",
      "policy_term",
      "premium",
      "duration_mth",
    ],
  },
  {
    id: "cashvalue-savings",
    name: "CashValue · savings",
    family: "life",
    needs: "a model-point file: age_at_entry, sum_assured, policy_term",
    description:
      "Universal-life / savings projection with account value, lapse, surrender and crediting. Lifelib → savings / CashValue_ME.",
    applicableTo: [
      "life",
      "savings",
      "universal-life",
      "account_value",
      "av",
      "crediting",
      "lapse",
      "model-points",
    ],
  },
  {
    id: "ifrs17-csm",
    name: "IFRS 17 · CSM roll-forward",
    family: "life",
    needs: "a model-point file: age_at_entry, sum_assured, policy_term",
    description:
      "IFRS 17 LRC / LIC / CSM release for a portfolio of insurance contracts. Lifelib → ifrs17sim (legacy since 0.12.0; ifrs17a is the active engine but takes nominal cash flows, not model points).",
    applicableTo: ["life", "ifrs17", "csm", "lrc", "lic", "model-points", "reporting"],
  },
  {
    id: "solvency2-life",
    name: "Solvency II · life SCR",
    family: "life",
    needs: "a model-point file: age_at_entry, sum_assured, policy_term",
    description:
      "Standard formula SCR for the life underwriting module (mortality, longevity, disability, lapse up/down/mass, expense, revision, CAT). Lifelib → annuallife / TradLife_A_EX1 (replaces the deprecated solvency2 project).",
    applicableTo: ["life", "solvency2", "scr", "underwriting", "model-points"],
  },
  {
    id: "nested-stochastic",
    name: "Nested stochastic",
    family: "life",
    needs: "a model-point file: age_at_entry, sum_assured, policy_term",
    description:
      "Outer real-world × inner risk-neutral projection for guarantees and TVOG. Lifelib → nestedlife (legacy since 0.12.0).",
    applicableTo: ["life", "savings", "guarantees", "tvog", "stochastic", "esg"],
  },
  {
    id: "smithwilson-curve",
    name: "Smith-Wilson · curve fit",
    family: "life",
    description: "Risk-free curve extrapolation to the UFR (EIOPA / SAM). Lifelib → smithwilson.",
    applicableTo: ["life", "capital", "yield_curve", "rates", "ufr", "smith-wilson"],
  },
  {
    id: "cluster-modelpoints",
    name: "Cluster · model-point compression",
    family: "life",
    needs: "a model-point file: age_at_entry, sum_assured, policy_term",
    description:
      "Compresses 100k+ policies into <=K representative model points preserving liability sensitivity. Lifelib → cluster.",
    applicableTo: ["life", "model-points", "compression", "cluster", "performance"],
  },
  {
    id: "economic-curves",
    name: "Economic curves",
    family: "life",
    description:
      "Discount / forward / zero curves with bootstrap + interpolation. Lifelib → economic_curves scripts + economic / BasicHullWhite.",
    applicableTo: ["life", "capital", "yield_curve", "rates", "discount"],
  },
  // ── forecast · W(M,T,R) survival under shocks ───────────────────────────
  // Engine ported from `nanoeconomics-simulation` (Cobb-Douglas survival).
  // Domain-agnostic: lets the user project ANY actuarial entity — a life
  // book, a pension scheme, a reserve position, a community — forward
  // under shocks. The result card relabels M/T/R per source family.
  {
    id: "wmtr-projection",
    name: "WMTR · forecast",
    family: "forecast",
    description:
      "Monte Carlo survival projection of M (material) · T (time / capacity) · R (relational / structural) under shocks. Domain-agnostic.",
    applicableTo: [
      "forecast",
      "survival",
      "monte-carlo",
      "wmtr",
      "alpha_m",
      "alpha_t",
      "alpha_r",
      "shock",
      "community",
      "scenario",
    ],
  },
  {
    id: "wmtr-sensitivity",
    name: "WMTR · shock sensitivity",
    family: "forecast",
    description:
      "Sweep shock severity (mild / moderate / severe) across the same WMTR projection and report how the outcome distribution shifts.",
    applicableTo: ["forecast", "sensitivity", "stress-test", "wmtr", "shock"],
  },
  // ── workspace · interpretable-by-design bottleneck ────────────────────────
  {
    id: "workspace-bottleneck",
    name: "Workspace bottleneck",
    family: "workspace",
    needs: "3+ numeric columns",
    description:
      "Compresses many drivers into a few sparse, non-negative, nameable codes and a broadcast matrix B to the report heads. Generalizes Lee-Carter (rank-1) and NMF; validated by causal alignment.",
    applicableTo: [
      "workspace",
      "bottleneck",
      "interpretable",
      "nmf",
      "active-subspace",
      "decision-relevant",
      "dimension-reduction",
    ],
  },
  // ── general ───────────────────────────────────────────────────────────────
  {
    id: "descriptive",
    name: "Descriptive Stats",
    family: "general",
    description: "Summary, quantiles, distributions.",
    applicableTo: ["*"],
  },
];

export const MODEL_BY_ID: Map<string, CatalogModel> = new Map(MODEL_CATALOG.map((m) => [m.id, m]));

export const FAMILY_COLOR_DARK: Record<ModelFamily, string> = {
  reserving: "#00d68f", // primary
  mortality: "#7aa2f7", // accent-2
  pricing: "#bb9af7", // accent-3
  climate: "#ffb454", // warn
  capital: "#ff6b6b", // error
  pensions: "#73daca",
  // `life` is pink/magenta — sits visually between mortality (blue) and
  // pricing (purple), distinct from both, and reads warm-but-serious.
  life: "#f48fb1",
  // `forecast` is a cool teal-cyan — sits visually distant from every
  // existing family (no greens / blues / purples / pinks / orange / red
  // is near it) so projection nodes read as "different kind of artefact".
  forecast: "#5dd6c8",
  // `workspace` is a warm gold — the "small precious object" the validator
  // audits. Distinct from climate's orange (more yellow, less saturated).
  workspace: "#e0b13c",
  general: "#9a9a9a",
};
export const FAMILY_COLOR_LIGHT: Record<ModelFamily, string> = {
  reserving: "#009669",
  mortality: "#3760cc",
  pricing: "#7649c7",
  climate: "#ae6614",
  capital: "#b73a3a",
  pensions: "#0d8e7f",
  life: "#b73a73",
  forecast: "#117a72",
  workspace: "#9a7413",
  general: "#5c5c5a",
};
