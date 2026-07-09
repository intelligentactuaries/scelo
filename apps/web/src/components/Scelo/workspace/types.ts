// The Workspace layer — shared types.
//
// This module turns a Scelo model into a "verbalizable global workspace":
// the small, nameable, decision-relevant set of directions a model is poised
// to report along, validated by causal intervention. The maths is the
// active-subspace / Jacobian-lens correspondence of
//   Denewade, "A Global Workspace for Actuarial Models" (2026)
// which itself carries across
//   Gurnee et al., "Verbalizable Representations Form a Global Workspace in
//   Language Models" (transformer-circuits.pub/2026/workspace).
//
// Everything here is a plain data shape (no React, no DOM) so the engine can
// run in the browser preview, inside the desktop IDE, and under `bun test`.

/** A signed loading of one named driver onto a workspace direction. */
export type DriverLoading = { col: string; weight: number };

/** One workspace direction: an eigenvector of the gradient-covariance C_f,
 *  expressed as signed loadings on named drivers plus a short name. */
export type Direction = {
  /** Rank within the workspace (0 = most decision-relevant). */
  index: number;
  /** Sensitivity eigenvalue lambda_i of C_f = E[J_f^T J_f]. */
  eigenvalue: number;
  /** Share of the workspace's total sensitivity carried by this direction. */
  sensitivityShare: number;
  /** Input-variance share this direction occupies (the "< 10% of variance"
   *  signature: a direction can be everything for the decision and almost
   *  nothing for the variance). */
  varianceShare: number;
  /** Signed loadings on named drivers, sorted by descending magnitude. */
  loadings: DriverLoading[];
  /** Short monotone name from the top loadings, e.g. "trend up, cohort up". */
  name: string;
};

/** One point of the workspace-vs-PCA reduction curve: how much of the
 *  readout's variation the top-k active vs top-k PCA subspace rebuilds. */
export type ReductionPoint = { k: number; active: number; pca: number };

/** One realised-vs-predicted swap measurement (Theorem: swap consistency). */
export type SwapPoint = {
  direction: number;
  delta: number;
  realized: number;
  predicted: number;
};

/** Swap-consistency validation of the workspace directions. */
export type SwapResult = {
  points: SwapPoint[];
  /** Coefficient of determination between realised and predicted swaps for
   *  in-band |delta| (first-order regime). High = validated causal effect. */
  r2InBand: number;
  /** The |delta| threshold separating in-band from tail swaps. */
  inBand: number;
  /** Estimated leading curvature term (Hessian direction) that makes the
   *  first-order prediction droop in the tail, where capital is decided. */
  tailCurvature: number;
};

/** One row of the selectivity / double-dissociation table: capability
 *  retained after ablating each subspace. */
export type SelectivityRow = {
  /** "flexible" (a multi-hop / composed readout) or "reflexive" (a directly
   *  readable level). */
  readout: "flexible" | "reflexive";
  /** Retention after ablating the flexible workspace subspace. */
  workspace: number;
  /** Retention after ablating the reflexive level subspace. */
  level: number;
  /** Retention after ablating a matched high-variance decision-irrelevant
   *  control (rules out that ablation per se does the damage). */
  nuisance: number;
};

/** The protected-direction fairness audit (indirect-discrimination readout). */
export type FairnessReadout = {
  protectedCol: string;
  legitimateCols: string[];
  /** Share of the prediction's non-legitimate variation aligned with the
   *  protected direction, before mitigation. */
  alignmentBefore: number;
  alignmentAfter: number;
  /** Standardised group price gap on the protected attribute. */
  disparityBefore: number;
  disparityAfter: number;
  /** Fit to the legitimate (fair) target before / after residualisation. */
  fitBefore: number;
  fitAfter: number;
};

/** The workspace of a model, relative to a chosen readout. This object is
 *  stashed into `RunResult.detail.workspace` and rendered across surfaces. */
export type WorkspaceReport = {
  /** The report channel(s) this workspace is decision-relevant *for*. Always
   *  named: the workspace never claims relevance in the abstract. */
  readout: string;
  /** Driver columns the workspace is built over. */
  drivers: string[];
  /** Top nameable directions (the workspace itself). */
  directions: Direction[];
  /** Effective dimension: participation ratio (sum lambda)^2 / sum lambda^2. */
  participationRatio: number;
  /** Effective rank r*: number of eigenvalues above the sensitivity floor. */
  rank: number;
  /** Total input-variance share the workspace occupies (Prop: variance-frac). */
  varianceFraction: number;
  /** Workspace-vs-PCA reduction curve (decision-relevant vs max-variance). */
  reduction: ReductionPoint[];
  /** Leading sensitivity eigenvalues of C_f (the workspace spectrum). */
  sensitivitySpectrum: number[];
  /** Leading input-variance eigenvalues (the PCA spectrum, for contrast). */
  varianceSpectrum: number[];
  /** Causal swap validation (present once validated). */
  swap?: SwapResult;
  /** Selectivity double-dissociation (present once validated). */
  selectivity?: SelectivityRow[];
  /** Optional fairness readout (pricing / indirect-discrimination audits). */
  fairness?: FairnessReadout;
  /** Fit of the differentiable surrogate to the readout (0..1). */
  surrogateR2: number;
  /** Rows used to estimate the workspace. */
  n: number;
  /** Whether the numbers came from the browser engine or the Python bridge. */
  source: "browser" | "python-bridge";
  generatedAt: number;
};

/** An interpretable-by-design workspace bottleneck: sparse, non-negative
 *  broadcast of a few decision-relevant codes to many report heads. The
 *  linear special case is exactly Lee-Carter (r = 1) and NMF. */
export type BottleneckFit = {
  /** Names of the r codes (from their driver loadings). */
  codeNames: string[];
  /** Driver loadings of each code (codes x drivers). */
  codeLoadings: DriverLoading[][];
  /** Non-negative broadcast matrix B: heads x codes. */
  broadcast: number[][];
  /** Report-head names. */
  heads: string[];
  /** Effective dimension of the codes. */
  participationRatio: number;
  /** Fraction of broadcast entries at ~zero (sparsity of B). */
  sparsity: number;
  /** Causal-alignment R^2: does swapping code j move the heads by B[:,j]? */
  causalAlignment: number;
  /** Reconstruction R^2 of the heads from B * codes. */
  reconstructionR2: number;
  n: number;
};

/** A single fact broadcast to the IDE-wide Workspace panel: a nameable,
 *  causally-validated item currently "in play" across the pipeline. */
export type WorkspaceFact = {
  id: string;
  /** Short human label, e.g. "annuity workspace: trend up, cohort up (R2 0.98)". */
  label: string;
  /** Which surface broadcast it. */
  surface: "soft" | "tools" | "hard" | "swarm";
  /** Whether it survived a causal intervention (swap / ablation). */
  validated: boolean;
  /** Optional longer detail for a tooltip / expand. */
  detail?: string;
  createdAt: number;
};
