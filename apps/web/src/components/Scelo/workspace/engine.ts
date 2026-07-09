// The workspace engine: extract and validate a model's global workspace.
//
// Given a dataset, one or more report channels (the readout), and the numeric
// drivers, this fits a differentiable surrogate per channel, eigendecomposes the
// gradient covariance to recover the decision-relevant subspace, contrasts it
// with PCA, and (optionally) validates the directions by swap and selectivity.
// The output is a WorkspaceReport, the small nameable object stashed into
// RunResult.detail.workspace and rendered across the four surfaces.

import type { Dataset, Row } from "../SoftDataWorkstation";
import { activeSubspace, reductionCurve, sampleX, varianceFractionOf } from "./activeSubspace";
import { selectivityTable, swapConsistency } from "./causal";
import type { Vec } from "./linalg";
import { nameDirection } from "./names";
import { type SurrogateOpts, fitSurrogate } from "./surrogate";
import type { Direction, DriverLoading, WorkspaceReport } from "./types";

const ID_LIKE = /^(id|.*_id|uuid|.*key|index|row_?id)$/i;
const DEFAULT_MAX_DRIVERS = 24;

/** Numeric columns of a dataset (mostly-finite, non-id-like, non-constant),
 *  excluding any in `exclude`. */
export function numericColumns(dataset: Dataset, exclude: string[] = []): string[] {
  const rows = dataset.rows;
  const scan = Math.min(rows.length, 5000);
  const skip = new Set(exclude);
  const out: string[] = [];
  for (const col of dataset.columns) {
    if (skip.has(col) || ID_LIKE.test(col)) continue;
    let nonNull = 0;
    let numeric = 0;
    let first: number | null = null;
    let constant = true;
    for (let i = 0; i < scan; i++) {
      const v = rows[i]?.[col];
      if (v === null || v === undefined || v === "") continue;
      nonNull++;
      if (typeof v === "number" && Number.isFinite(v)) {
        numeric++;
        if (first === null) first = v;
        else if (v !== first) constant = false;
      }
    }
    if (nonNull > 0 && numeric >= nonNull * 0.8 && !constant) out.push(col);
  }
  return out;
}

function columnVariance(rows: Row[], col: string): number {
  let n = 0;
  let m = 0;
  let m2 = 0;
  for (const row of rows) {
    const v = row[col];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    n++;
    const d = v - m;
    m += d / n;
    m2 += d * (v - m);
  }
  return n > 1 ? m2 / (n - 1) : 0;
}

/** Choose drivers: numeric columns (excluding the readout outputs), capped to
 *  the highest-variance `maxDrivers` so the eigensolver stays small. */
export function selectDrivers(
  dataset: Dataset,
  exclude: string[],
  maxDrivers = DEFAULT_MAX_DRIVERS,
): string[] {
  const cols = numericColumns(dataset, exclude);
  if (cols.length <= maxDrivers) return cols;
  return cols
    .map((c) => ({ c, v: columnVariance(dataset.rows, c) }))
    .sort((a, b) => b.v - a.v)
    .slice(0, maxDrivers)
    .map((x) => x.c);
}

export type Readout = string | { name: string; fn: (row: Row) => number };

export type WorkspaceOpts = {
  /** Report channel(s) the workspace is decision-relevant for. The first is
   *  the primary (flexible) readout. */
  readouts: Readout[];
  /** Driver columns; auto-selected when omitted. */
  drivers?: string[];
  /** A directly-readable level for the selectivity dissociation. Defaults to
   *  the highest-variance driver. */
  reflexiveReadout?: string;
  /** Run swap + selectivity validation (default true). */
  validate?: boolean;
  maxDrivers?: number;
  surrogate?: SurrogateOpts;
  seed?: number;
};

function readoutName(r: Readout): string {
  return typeof r === "string" ? r : r.name;
}
function readoutFn(r: Readout): string | ((row: Row) => number) {
  return typeof r === "string" ? r : r.fn;
}

function loadingsOf(vec: Vec, drivers: string[]): DriverLoading[] {
  return vec
    .map((weight, j) => ({ col: drivers[j], weight }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
}

/**
 * Compute a model's global workspace relative to the given readout. Extracts the
 * active subspace, contrasts it with PCA, and (unless `validate` is false)
 * certifies the directions by swap consistency and the selectivity double
 * dissociation.
 */
export function computeWorkspace(dataset: Dataset, opts: WorkspaceOpts): WorkspaceReport {
  const readoutNames = opts.readouts.map(readoutName);
  const drivers = opts.drivers ?? selectDrivers(dataset, readoutNames, opts.maxDrivers);
  const d = drivers.length;

  // A surrogate per report channel; C = E[sum_c grad f_c grad f_c^T].
  const surrogates = opts.readouts.map((r) =>
    fitSurrogate(dataset.rows, drivers, readoutFn(r), { seed: opts.seed, ...opts.surrogate }),
  );
  const primary = surrogates[0];
  const Zs = sampleX(primary, dataset.rows);
  const as = activeSubspace(surrogates, Zs);

  const totalSens = as.eigen.values.reduce((s, v) => s + Math.max(v, 0), 0) || 1;
  const tau = 1e-3 * (as.eigen.values[0] ?? 0);
  const rank = Math.max(1, as.eigen.values.filter((v) => v > tau).length);
  const reportCount = Math.min(6, d);

  const directions: Direction[] = [];
  for (let k = 0; k < reportCount; k++) {
    const vec = as.eigen.vectors[k];
    const loadings = loadingsOf(vec, drivers);
    directions.push({
      index: k,
      eigenvalue: as.eigen.values[k],
      sensitivityShare: Math.max(as.eigen.values[k], 0) / totalSens,
      varianceShare: varianceFractionOf([vec], as.Sigma),
      loadings,
      name: nameDirection(loadings),
    });
  }

  const topVecs = as.eigen.vectors.slice(0, rank);
  const kMax = Math.min(8, d);
  const report: WorkspaceReport = {
    readout: readoutNames.join(", "),
    drivers,
    directions,
    participationRatio: as.participationRatio,
    rank,
    varianceFraction: varianceFractionOf(topVecs, as.Sigma),
    reduction: reductionCurve(primary, Zs, as.eigen.vectors, as.pcaEigen.vectors, kMax),
    sensitivitySpectrum: as.eigen.values.slice(0, 10),
    varianceSpectrum: as.pcaEigen.values.slice(0, 10),
    surrogateR2: primary.r2,
    n: Zs.length,
    source: "browser",
    generatedAt: Date.now(),
  };

  if (opts.validate !== false) {
    // Swap consistency across the top workspace directions.
    const swapDirs = as.eigen.vectors.slice(0, Math.min(3, rank));
    const deltas = [-3, -2, -1.5, -1, -0.5, 0.5, 1, 1.5, 2, 3];
    report.swap = swapConsistency(primary, Zs, swapDirs, deltas, 1);

    // Selectivity: flexible (primary) vs a reflexive level. The reflexive
    // readout is a directly-readable driver; its workspace is that coordinate.
    const reflexive = opts.reflexiveReadout ?? highestVarianceDriver(dataset, drivers);
    if (reflexive) {
      const reflexiveSurrogate = fitSurrogate(dataset.rows, drivers, reflexive, {
        seed: opts.seed,
        features: 0, // a level is directly readable: a linear surrogate suffices
      });
      const reflexiveAS = activeSubspace([reflexiveSurrogate], Zs);
      const flexibleSub = as.eigen.vectors.slice(0, Math.min(3, rank));
      const reflexiveSub = reflexiveAS.eigen.vectors.slice(0, 1);
      const controlSub = controlSubspace(as, flexibleSub.length);
      report.selectivity = selectivityTable(
        primary,
        reflexiveSurrogate,
        Zs,
        flexibleSub,
        reflexiveSub,
        controlSub,
      );
    }
  }

  return report;
}

/** A matched control subspace: high input variance, low decision sensitivity. */
function controlSubspace(as: ReturnType<typeof activeSubspace>, dim: number): Vec[] {
  // Rank PCA directions by sensitivity w^T C w (ascending) among the top-half
  // by variance, and take the least-sensitive `dim`.
  const pca = as.pcaEigen.vectors;
  const half = Math.max(dim, Math.floor(pca.length / 2));
  const scored = pca.slice(0, half).map((w) => {
    let s = 0;
    for (let i = 0; i < w.length; i++) {
      let row = 0;
      for (let j = 0; j < w.length; j++) row += as.C[i][j] * w[j];
      s += w[i] * row;
    }
    return { w, s };
  });
  scored.sort((a, b) => a.s - b.s);
  return scored.slice(0, dim).map((x) => x.w);
}

function highestVarianceDriver(dataset: Dataset, drivers: string[]): string | null {
  let best: string | null = null;
  let bestV = -1;
  for (const c of drivers) {
    const v = columnVariance(dataset.rows, c);
    if (v > bestV) {
      bestV = v;
      best = c;
    }
  }
  return best;
}

/** Per-column decision relevance for the Soft-stage preview: each driver's
 *  sensitivity share vs its input-variance share, for a chosen target. Returns
 *  a map from column name to { relevance, variance } in [0, 1]. */
export function columnRelevance(
  dataset: Dataset,
  target: string,
  opts: { maxDrivers?: number; seed?: number } = {},
): Record<string, { relevance: number; variance: number }> {
  const drivers = selectDrivers(dataset, [target], opts.maxDrivers ?? 40);
  if (drivers.length === 0) return {};
  const surrogate = fitSurrogate(dataset.rows, drivers, target, { seed: opts.seed });
  const Zs = sampleX(surrogate, dataset.rows);
  const as = activeSubspace([surrogate], Zs);
  // Sensitivity of coordinate j = C[j][j] (mean squared d readout / d z_j).
  const sens = drivers.map((_, j) => Math.max(as.C[j]?.[j] ?? 0, 0));
  const sensSum = sens.reduce((s, v) => s + v, 0) || 1;
  const vars = drivers.map((_, j) => Math.max(as.Sigma[j]?.[j] ?? 0, 0));
  const varSum = vars.reduce((s, v) => s + v, 0) || 1;
  const out: Record<string, { relevance: number; variance: number }> = {};
  drivers.forEach((c, j) => {
    out[c] = { relevance: sens[j] / sensSum, variance: vars[j] / varSum };
  });
  return out;
}
