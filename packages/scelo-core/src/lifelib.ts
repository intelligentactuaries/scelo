// lifelib.ts — the ONE place Scelo says which lifelib it targets.
//
// lifelib (github.com/lifelib-dev/lifelib) is a library of actuarial
// projection models built on modelx. Scelo's `life` family is rooted in it:
// every life-family catalog entry maps to a lifelib library + model, the
// bundled CPython ships that exact lifelib, the notebook export emits code
// against it, and the Python bridges run it. All of those read THIS file, so
// bumping lifelib is a one-line change here plus the runtime lock
// (apps/scelo-ide/runtime/python-requirements.in) — not a scavenger hunt
// through blurbs, scripts and probes that each remember a different version.
//
// Headless on purpose (no React, no DOM): the IDE renderer, the notebook
// exporter, the swarm's toolkits and Bun tests all import it unchanged.

/** lifelib release Scelo is built and verified against. Must equal the
 *  `lifelib==` pin in apps/scelo-ide/runtime/python-requirements.in. */
export const LIFELIB_VERSION = "0.14.0";
/** modelx release lifelib 0.14.0 was published against. Same rule. */
export const MODELX_VERSION = "0.32.0";
/** Python floor for the pinned pair — the bundled runtime is 3.11. */
export const LIFELIB_PYTHON_MIN = "3.9";

/** Everything the notebook export's install cell needs. */
export const LIFELIB_PIP_REQUIREMENTS: readonly string[] = [
  `lifelib==${LIFELIB_VERSION}`,
  `modelx==${MODELX_VERSION}`,
  "pandas",
  "numpy",
  "openpyxl",
  "matplotlib",
];

// ─── The libraries lifelib 0.14.0 ships ─────────────────────────────────

/**
 * - `active`  — maintained, uses the current cashflow model design.
 * - `legacy`  — still ships and still runs, but lifelib has stopped
 *               developing it (simplelife and its dependants since 0.12.0,
 *               solvency2 since 0.13.0). Scelo keeps targeting a legacy
 *               library only where no active successor covers the same
 *               question yet, and says so on the card.
 * - `draft`   — published as reference material, API not settled (uslib).
 */
export type LifelibLibraryStatus = "active" | "legacy" | "draft";

export interface LifelibLibrary {
  /** lifelib.create() template name — also the folder name it copies out. */
  id: string;
  title: string;
  status: LifelibLibraryStatus;
  /** lifelib release that introduced it (or, for legacy, that deprecated it). */
  since?: string;
  deprecatedIn?: string;
  /** Active library that covers the same ground, if any. */
  successor?: string;
  /** Headline models / entry points inside the library. */
  models: readonly string[];
  note: string;
}

export const LIFELIB_LIBRARIES: readonly LifelibLibrary[] = [
  {
    id: "basiclife",
    title: "basiclife — basic term-life cashflow models",
    status: "active",
    models: [
      "BasicTerm_M",
      "BasicTerm_ME",
      "BasicTerm_S",
      "BasicTerm_SE",
      "BasicTerm_SC",
      "BasicTermASL_ME",
    ],
    note: "Monthly / seriatim term-life projections on a model-point table. _M = new business, _ME = in-force with duration_mth. _SC (0.11.0) is the Cython-compilable variant.",
  },
  {
    id: "savings",
    title: "savings — cash-value / universal-life models",
    status: "active",
    models: [
      "CashValue_ME",
      "CashValue_ME_EX1",
      "CashValue_ME_EX2",
      "CashValue_ME_EX4",
      "CashValue_SE",
    ],
    note: "Account-value roll-forward with crediting, COI, surrender charges; EX1/EX2 add stochastic investment-return scenarios and option valuation.",
  },
  {
    id: "annuallife",
    title: "annuallife — annual traditional-life projection (TradLife_A)",
    status: "active",
    since: "0.12.0",
    models: ["TradLife_A", "TradLife_A_EX1", "TradLife_A_mx30"],
    note: "Per-policy annual projection of traditional whole/term/endowment business with reserves, commissions and expenses. TradLife_A_EX1 (0.13.0) adds Solvency II life-underwriting SCR (mortality, longevity, disability, lapse up/down/mass, expense, revision, CAT) and risk margin — the successor to the deprecated solvency2 project.",
  },
  {
    id: "uslib",
    title: "uslib — U.S. individual life & annuity reference models",
    status: "draft",
    since: "0.14.0",
    models: [
      "term_life",
      "whole_life",
      "universal_life",
      "indexed_ul",
      "variable_ul",
      "guaranteed_ul",
      "immediate_annuity",
      "deferred_income_annuity",
      "fixed_deferred_annuity",
      "fixed_indexed_annuity",
      "registered_index_linked_annuity",
      "variable_annuity",
    ],
    note: "Twelve reference liability cash-flow projection models (products/<name>/) for U.S. individual life and annuity products, each with a product spec, technical notes and a worked example asserted in tests. Undiscounted by design — they publish cash flows and leave discounting / reserving / capital to the consumer. Published as a draft in 0.14.0; Scelo lists it but does not route to it until the API settles.",
  },
  {
    id: "ifrs17a",
    title: "ifrs17a — IFRS 17 calculation model",
    status: "active",
    models: ["ifrs17 (package)", "template.py"],
    note: "IFRS 17 measurement engine (a Python port of the Systemorph IFRS 17 calculation model) driven from nominal-cash-flow, yield-curve, data-node and parameter workbooks (Files/ifrs17-template). Successor to ifrs17sim.",
  },
  {
    id: "smithwilson",
    title: "smithwilson — Smith-Wilson extrapolation",
    status: "active",
    models: ["model (SmithWilson space)"],
    note: "EIOPA Smith-Wilson risk-free curve extrapolation to the UFR. Predates 0.1.1 but is not built on the old cashflow design and remains the reference implementation.",
  },
  {
    id: "cluster",
    title: "cluster — model-point compression",
    status: "active",
    models: ["cluster_model_points.ipynb", "BasicTerm_ME_for_Cluster"],
    note: "k-means over seriatim cash flows / present values to pick representative model points that preserve liability sensitivity.",
  },
  {
    id: "economic",
    title: "economic — Hull-White short-rate model",
    status: "active",
    models: ["BasicHullWhite"],
    note: "Monte-Carlo short-rate paths and discount factors from a one-factor Hull-White model.",
  },
  {
    id: "economic_curves",
    title: "economic_curves — curve algorithms",
    status: "active",
    models: ["smith_wilson", "NelsonSiegelSvensson", "bisection_alpha", "stationary_bootstrap"],
    note: "Standalone scripts (not modelx models) for Smith-Wilson, Nelson-Siegel-Svensson, alpha bisection, stationary bootstrap and related economic-scenario tools.",
  },
  {
    id: "appliedlife",
    title: "appliedlife — comprehensive projection model",
    status: "active",
    models: ["IntegratedLife"],
    note: "Multi-product, multi-space projection model with a run-and-report harness.",
  },
  {
    id: "assets",
    title: "assets — bond portfolio models",
    status: "active",
    models: ["BasicBonds"],
    note: "Basic bond-portfolio cash flows and valuation.",
  },
  {
    id: "ifrs17sim",
    title: "ifrs17sim — IFRS 17 simulation on simplelife (legacy)",
    status: "legacy",
    deprecatedIn: "0.12.0",
    successor: "ifrs17a",
    models: ["OuterProj", "InnerProj"],
    note: "CSM roll-forward simulated on top of simplelife's projection. Deprecated with simplelife in 0.12.0; still ships and still runs.",
  },
  {
    id: "solvency2",
    title: "solvency2 — SII life SCR on simplelife (legacy)",
    status: "legacy",
    deprecatedIn: "0.13.0",
    successor: "annuallife",
    models: ["SCR_life"],
    note: "Standard-formula life underwriting SCR built on simplelife. Deprecated in 0.13.0 in favour of annuallife/TradLife_A_EX1.",
  },
  {
    id: "nestedlife",
    title: "nestedlife — nested projection on simplelife (legacy)",
    status: "legacy",
    deprecatedIn: "0.12.0",
    models: ["OuterProj", "InnerProj"],
    note: "Outer × inner nested projection. Deprecated with simplelife in 0.12.0; no direct active successor — the savings library's CashValue_ME_EX1/EX2 cover stochastic guarantee valuation.",
  },
  {
    id: "simplelife",
    title: "simplelife — original annual projection (legacy)",
    status: "legacy",
    deprecatedIn: "0.12.0",
    successor: "annuallife",
    models: ["Projection"],
    note: "The original lifelib projection model. Deprecated in 0.12.0; annuallife/TradLife_A is its successor.",
  },
  {
    id: "fastlife",
    title: "fastlife — vectorised simplelife (legacy)",
    status: "legacy",
    deprecatedIn: "0.12.0",
    successor: "annuallife",
    models: ["Projection"],
    note: "simplelife projected over all policies at once. Deprecated with simplelife.",
  },
];

export function lifelibLibrary(id: string): LifelibLibrary | null {
  return LIFELIB_LIBRARIES.find((l) => l.id === id) ?? null;
}

// ─── Scelo life-family model → lifelib target ───────────────────────────

export interface LifelibTarget {
  /** lifelib library (create() template name). */
  library: string;
  /** Model folder / entry point inside the library that Scelo runs. */
  model: string;
  /** Status of the library Scelo targets for this model. */
  status: LifelibLibraryStatus;
  /** For legacy targets: what an actuary should move to. */
  successor?: string;
  description: string;
}

/**
 * Catalog id → lifelib target. Every `life`-family model in
 * apps/web/src/components/Scelo/modelCatalog.ts has an entry here; the
 * catalog descriptions, modelTheory blurbs, notebook export and Python
 * bridges all name the library through this table.
 */
export const LIFELIB_TARGETS: Readonly<Record<string, LifelibTarget>> = {
  "basicterm-projection": {
    library: "basiclife",
    model: "BasicTerm_ME",
    status: "active",
    description:
      "Monthly term-life projection on a model-point file. BasicTerm_ME (in-force, honours duration_mth); BasicTerm_M is the new-business special case.",
  },
  "cashvalue-savings": {
    library: "savings",
    model: "CashValue_ME",
    status: "active",
    description:
      "Universal-life / savings projection with account value, crediting, COI, surrender.",
  },
  "ifrs17-csm": {
    library: "ifrs17sim",
    model: "model",
    status: "legacy",
    successor: "ifrs17a",
    description:
      "IFRS 17 CSM roll-forward simulated on the legacy simplelife projection. ifrs17a is the active IFRS 17 measurement model; it takes nominal cash flows rather than a model-point file, so Scelo still runs ifrs17sim for a model-point-shaped input.",
  },
  "solvency2-life": {
    library: "annuallife",
    model: "TradLife_A_EX1",
    status: "active",
    description:
      "Solvency II life-underwriting SCR (mortality, longevity, disability, lapse up/down/mass, expense, revision, CAT, correlated) at valuation time t on a per-policy annual projection. Replaces the deprecated solvency2 project.",
  },
  "nested-stochastic": {
    library: "nestedlife",
    model: "model",
    status: "legacy",
    description:
      "Outer real-world × inner risk-neutral nested projection. Deprecated with simplelife in 0.12.0; kept as the reference nested design.",
  },
  "smithwilson-curve": {
    library: "smithwilson",
    model: "model",
    status: "active",
    description: "EIOPA Smith-Wilson zero-curve extrapolation to the UFR.",
  },
  "cluster-modelpoints": {
    library: "cluster",
    model: "cluster_model_points.ipynb",
    status: "active",
    description: "Model-point compression preserving liability sensitivity.",
  },
  "economic-curves": {
    library: "economic_curves",
    model: "smith_wilson",
    status: "active",
    description:
      "Curve construction / extrapolation scripts; economic/BasicHullWhite for stochastic short rates.",
  },
};

export function isLifelibModel(modelId: string): boolean {
  return modelId in LIFELIB_TARGETS;
}

export function lifelibTargetFor(modelId: string): LifelibTarget | null {
  return LIFELIB_TARGETS[modelId] ?? null;
}

/** "lifelib 0.14.0 · basiclife / BasicTerm_ME" — the provenance string the
 *  result cards and the notebook header print. */
export function lifelibProvenance(modelId: string): string {
  const t = lifelibTargetFor(modelId);
  if (!t) return `lifelib ${LIFELIB_VERSION}`;
  const legacy = t.status === "legacy" ? " (legacy)" : "";
  return `lifelib ${LIFELIB_VERSION} · ${t.library} / ${t.model}${legacy}`;
}
