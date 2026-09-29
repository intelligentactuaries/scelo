// In-browser gradient-boosted trees + exact TreeSHAP — the engine behind the
// Hard Data pricing pair (GBM · SHAP explainability).
//
// These two cards used to be mocks: the GBM headline was
// `min(0.92, 0.7 + rows / 4000)` (an "AUC" that no model produced) and SHAP
// either handed the first three categorical columns hard-coded weights
// (0.42 / 0.27 / 0.18) or refused outright on an all-numeric dataset. Both
// are now computed:
//
//   • the booster is second-order (Newton) gradient boosting over histogram-
//     binned features — the LightGBM / XGBoost recipe, grown depth-wise:
//     leaf value −G/(H+λ), split gain G_L²/(H_L+λ) + G_R²/(H_R+λ) − G²/(H+λ),
//     row subsampling, shrinkage. Squared-error, logistic and Poisson losses.
//   • it is scored on a deterministic HOLDOUT the trees never saw, so the
//     headline (AUC / R² / deviance explained) is an honest out-of-sample
//     number, and a decile lift table shows it.
//   • SHAP values are exact path-dependent TreeSHAP (Lundberg, Erion & Lee
//     2018, Algorithm 2; ported from the reference `shap` C++ recursion) —
//     local accuracy holds to rounding error, and the tests check the
//     recursion against brute-force Shapley values.
//
// Pure and dependency-free (no React, no dataset-shape heuristics): the
// caller picks the target and the feature columns; this module only fits,
// scores and explains. Deterministic for a given seed.

import type { Row } from "@scelo/core";

export type GbmTargetKind = "binary" | "count" | "continuous";

export type GbmFeature = { name: string; kind: "numeric" | "categorical" };

export type GbmParams = {
  nTrees: number;
  learningRate: number;
  maxDepth: number;
  /** Minimum training rows per leaf; derived from the training size when omitted. */
  minLeaf?: number;
  /** L2 penalty on leaf values (λ). */
  lambda: number;
  /** Row fraction each tree is grown on (stochastic gradient boosting). */
  subsample: number;
  /** Histogram bins per numeric feature (bin 0 is reserved for missing). */
  maxBins: number;
  seed: number;
  /** Rows kept for the fit (even-stride sample beyond this). */
  rowCap: number;
  /** Holdout rows explained by TreeSHAP. */
  shapRows: number;
};

export const GBM_DEFAULTS: GbmParams = {
  nTrees: 100,
  learningRate: 0.1,
  maxDepth: 3,
  lambda: 1,
  subsample: 0.8,
  maxBins: 32,
  seed: 7,
  rowCap: 10_000,
  shapRows: 500,
};

/** Fewer usable rows than this and a holdout metric means nothing. */
export const GBM_MIN_ROWS = 50;

const MAX_CATEGORICAL_LEVELS = 250;

/** One tree as flat node arrays. Internal nodes send a row LEFT when its bin
 *  is ≤ threshold; missing values sit in bin 0, so they always go left.
 *  `cover` is the number of training rows that reached the node — the
 *  weights path-dependent TreeSHAP averages over. */
export type GbmTree = {
  feature: Int32Array; // −1 on leaves
  threshold: Int32Array;
  left: Int32Array;
  right: Int32Array;
  value: Float64Array; // leaf output (already shrunk by the learning rate)
  cover: Float64Array;
};

export type GbmMetrics = {
  /** Headline metric: AUC (binary), R² (continuous) or deviance explained (count). */
  primaryName: "AUC" | "R²" | "deviance explained";
  primary: number;
  rmse: number;
  /** Binary only: mean log-loss on the holdout. */
  logLoss?: number;
  /** Mean of the target on the holdout (base rate for binary targets). */
  holdoutMean: number;
};

export type ShapSummary = {
  /** Features ordered by mean |SHAP|, largest first. */
  features: string[];
  meanAbs: number[];
  /** meanAbs as a share of the total (sums to 1). */
  share: number[];
  /** Numeric features: does a higher value push the prediction up, down, or
   *  both ways? null for categorical features (levels have no direction). */
  direction: Array<"up" | "down" | "mixed" | null>;
  rowsExplained: number;
  /** E[f(x)] on the margin scale — the value every explanation starts from. */
  baseValue: number;
  /** Largest |base + Σφ − f(x)| over the explained rows (local accuracy check). */
  maxAdditivityError: number;
  /** "log-odds", "log mean" or the target's own units. */
  scale: string;
};

export type GbmFit = {
  target: string;
  kind: GbmTargetKind;
  features: GbmFeature[];
  params: GbmParams & { minLeaf: number };
  baseScore: number;
  trees: GbmTree[];
  nTrain: number;
  nHoldout: number;
  /** Usable rows (valid target) before any row cap. */
  rowsUsable: number;
  sampled: boolean;
  metrics: GbmMetrics;
  /** Holdout rows grouped by predicted decile: mean actual vs mean predicted. */
  lift: { groups: string[]; actual: number[]; predicted: number[] };
  shap: ShapSummary;
};

// ── helpers ─────────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(a: number[], rand: () => number): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
}

function sigmoid(x: number): number {
  return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
}

// LightGBM's poisson_max_delta_step: the Hessian is evaluated at score + 0.7,
// which damps the Newton step where counts are sparse (H ≈ μ is tiny there
// and −G/H would otherwise shoot off).
const POISSON_MAX_DELTA_STEP = 0.7;

/** Response-scale prediction from a margin. */
function linkInverse(kind: GbmTargetKind, margin: number): number {
  if (kind === "binary") return sigmoid(margin);
  if (kind === "count") return Math.exp(Math.min(margin, 50));
  return margin;
}

/** Area under the ROC curve (Mann–Whitney U, average ranks for ties). */
export function aucScore(y: ArrayLike<number>, score: ArrayLike<number>): number | null {
  const n = y.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => score[a] - score[b]);
  let pos = 0;
  for (let i = 0; i < n; i++) if (y[i] === 1) pos++;
  const neg = n - pos;
  if (pos === 0 || neg === 0) return null;
  let rankSumPos = 0;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && score[idx[j + 1]] === score[idx[i]]) j++;
    const avgRank = (i + j) / 2 + 1; // ranks are 1-based
    for (let k = i; k <= j; k++) if (y[idx[k]] === 1) rankSumPos += avgRank;
    i = j + 1;
  }
  return (rankSumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

function poissonDeviance(y: ArrayLike<number>, mu: ArrayLike<number>): number {
  let d = 0;
  for (let i = 0; i < y.length; i++) {
    const m = Math.max(mu[i], 1e-12);
    d += (y[i] > 0 ? y[i] * Math.log(y[i] / m) : 0) - (y[i] - m);
  }
  return 2 * d;
}

// ── binning ─────────────────────────────────────────────────────────────────
//
// Numeric: bin 0 = missing, then one bin per distinct value when there are
// ≤ maxBins of them (exact splits), else quantile cut points. A value v lands
// in bin 1 + #{cuts < v}, so "bin ≤ t" (t ≥ 1) ⇔ "v ≤ cuts[t − 1]".
// Categorical: bin 0 = missing / unseen level, then levels ordered by their
// training-set target mean — the ordered-target-statistic trick that lets a
// threshold split find a good level partition (Fisher 1958 for squared loss).

type Binner =
  | { kind: "numeric"; cuts: number[] }
  | { kind: "categorical"; levelBin: Map<string, number> };

function numericValue(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function categoricalValue(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return String(v);
}

function makeNumericBinner(values: number[], maxBins: number): Binner | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const unique: number[] = [];
  for (const v of sorted)
    if (unique.length === 0 || v !== unique[unique.length - 1]) unique.push(v);
  if (unique.length < 2) return null; // constant on the training rows — no split possible
  const cuts: number[] = [];
  if (unique.length <= maxBins) {
    for (let i = 0; i + 1 < unique.length; i++) cuts.push((unique[i] + unique[i + 1]) / 2);
  } else {
    const top = unique[unique.length - 1];
    for (let k = 1; k < maxBins; k++) {
      const c = sorted[Math.floor((k / maxBins) * (sorted.length - 1))];
      if (c < top && (cuts.length === 0 || c > cuts[cuts.length - 1])) cuts.push(c);
    }
    if (cuts.length === 0) return null;
  }
  return { kind: "numeric", cuts };
}

function binNumeric(cuts: number[], v: number | null): number {
  if (v === null) return 0;
  // 1 + #{cuts < v} by binary search.
  let lo = 0;
  let hi = cuts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cuts[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

function binCount(b: Binner): number {
  return b.kind === "numeric" ? b.cuts.length + 2 : b.levelBin.size + 1;
}

function binOf(b: Binner, raw: unknown): number {
  if (b.kind === "numeric") return binNumeric(b.cuts, numericValue(raw));
  const lvl = categoricalValue(raw);
  return lvl === null ? 0 : (b.levelBin.get(lvl) ?? 0);
}

// ── tree growth ─────────────────────────────────────────────────────────────

type GrowCtx = {
  bins: Uint8Array[]; // [feature][trainRow]
  nBins: number[];
  g: Float64Array;
  h: Float64Array;
  lambda: number;
  minLeaf: number;
  maxDepth: number;
  lr: number;
  // scratch histograms, sized to the widest feature
  gH: Float64Array;
  hH: Float64Array;
  cH: Int32Array;
};

function growTree(rows: Int32Array, ctx: GrowCtx): GbmTree {
  const feature: number[] = [];
  const threshold: number[] = [];
  const left: number[] = [];
  const right: number[] = [];
  const value: number[] = [];
  const cover: number[] = [];

  const build = (idx: Int32Array, depth: number): number => {
    let G = 0;
    let H = 0;
    for (let k = 0; k < idx.length; k++) {
      G += ctx.g[idx[k]];
      H += ctx.h[idx[k]];
    }
    const node = feature.length;
    feature.push(-1);
    threshold.push(0);
    left.push(-1);
    right.push(-1);
    value.push(0);
    cover.push(idx.length);
    const makeLeaf = () => {
      value[node] = (-G / (H + ctx.lambda)) * ctx.lr;
      return node;
    };
    if (depth >= ctx.maxDepth || idx.length < 2 * ctx.minLeaf) return makeLeaf();

    const parentScore = (G * G) / (H + ctx.lambda);
    let bestGain = 1e-12;
    let bestF = -1;
    let bestT = -1;
    for (let f = 0; f < ctx.bins.length; f++) {
      const B = ctx.nBins[f];
      const col = ctx.bins[f];
      const { gH, hH, cH } = ctx;
      gH.fill(0, 0, B);
      hH.fill(0, 0, B);
      cH.fill(0, 0, B);
      for (let k = 0; k < idx.length; k++) {
        const r = idx[k];
        const b = col[r];
        gH[b] += ctx.g[r];
        hH[b] += ctx.h[r];
        cH[b]++;
      }
      let GL = 0;
      let HL = 0;
      let CL = 0;
      for (let t = 0; t < B - 1; t++) {
        GL += gH[t];
        HL += hH[t];
        CL += cH[t];
        if (CL < ctx.minLeaf) continue;
        if (idx.length - CL < ctx.minLeaf) break;
        const GR = G - GL;
        const HR = H - HL;
        const gain = (GL * GL) / (HL + ctx.lambda) + (GR * GR) / (HR + ctx.lambda) - parentScore;
        if (gain > bestGain) {
          bestGain = gain;
          bestF = f;
          bestT = t;
        }
      }
    }
    if (bestF < 0) return makeLeaf();

    const col = ctx.bins[bestF];
    let nLeft = 0;
    for (let k = 0; k < idx.length; k++) if (col[idx[k]] <= bestT) nLeft++;
    const li = new Int32Array(nLeft);
    const ri = new Int32Array(idx.length - nLeft);
    let a = 0;
    let c = 0;
    for (let k = 0; k < idx.length; k++) {
      const r = idx[k];
      if (col[r] <= bestT) li[a++] = r;
      else ri[c++] = r;
    }
    feature[node] = bestF;
    threshold[node] = bestT;
    left[node] = build(li, depth + 1);
    right[node] = build(ri, depth + 1);
    return node;
  };

  build(rows, 0);
  return {
    feature: Int32Array.from(feature),
    threshold: Int32Array.from(threshold),
    left: Int32Array.from(left),
    right: Int32Array.from(right),
    value: Float64Array.from(value),
    cover: Float64Array.from(cover),
  };
}

/** Leaf output for one row; `binAt(f)` is the row's bin on feature f. */
export function predictTree(tree: GbmTree, binAt: (f: number) => number): number {
  let n = 0;
  while (tree.feature[n] >= 0) {
    n = binAt(tree.feature[n]) <= tree.threshold[n] ? tree.left[n] : tree.right[n];
  }
  return tree.value[n];
}

/** predictTree for row `i` of a column-major bin matrix — the boosting loop's
 *  hot path, kept closure-free. */
function predictRow(tree: GbmTree, bins: Uint8Array[], i: number): number {
  let n = 0;
  while (tree.feature[n] >= 0) {
    n = bins[tree.feature[n]][i] <= tree.threshold[n] ? tree.left[n] : tree.right[n];
  }
  return tree.value[n];
}

/** E[tree(x)] under the training distribution: cover-weighted mean leaf value. */
export function treeExpectedValue(tree: GbmTree): number {
  const root = tree.cover[0];
  if (!(root > 0)) return 0;
  let s = 0;
  for (let n = 0; n < tree.feature.length; n++) {
    if (tree.feature[n] < 0) s += (tree.cover[n] / root) * tree.value[n];
  }
  return s;
}

// ── TreeSHAP ────────────────────────────────────────────────────────────────
//
// Exact path-dependent SHAP for one tree in O(L·D²). A straight port of
// `tree_shap_recursive` / `extend_path` / `unwind_path` / `unwound_path_sum`
// from the reference implementation (shap/cext/tree_shap.h), single output,
// no interaction conditioning. The "unique path" tracks, for every feature
// split on so far, the fraction of zero-paths (feature unknown: follow the
// training cover) and one-paths (feature known: follow x) that flow through,
// plus the permutation weights; each leaf then pays every path feature its
// Shapley share of the leaf value.

type PathBuf = { f: Int32Array; z: Float64Array; o: Float64Array; w: Float64Array };

function extendPath(p: PathBuf, depth: number, z: number, o: number, f: number): void {
  p.f[depth] = f;
  p.z[depth] = z;
  p.o[depth] = o;
  p.w[depth] = depth === 0 ? 1 : 0;
  for (let i = depth - 1; i >= 0; i--) {
    p.w[i + 1] += (o * p.w[i] * (i + 1)) / (depth + 1);
    p.w[i] = (z * p.w[i] * (depth - i)) / (depth + 1);
  }
}

function unwindPath(p: PathBuf, depth: number, pathIndex: number): void {
  const o = p.o[pathIndex];
  const z = p.z[pathIndex];
  let next = p.w[depth];
  for (let i = depth - 1; i >= 0; i--) {
    if (o !== 0) {
      const tmp = p.w[i];
      p.w[i] = (next * (depth + 1)) / ((i + 1) * o);
      next = tmp - (p.w[i] * z * (depth - i)) / (depth + 1);
    } else {
      p.w[i] = (p.w[i] * (depth + 1)) / (z * (depth - i));
    }
  }
  for (let i = pathIndex; i < depth; i++) {
    p.f[i] = p.f[i + 1];
    p.z[i] = p.z[i + 1];
    p.o[i] = p.o[i + 1];
  }
}

function unwoundPathSum(p: PathBuf, depth: number, pathIndex: number): number {
  const o = p.o[pathIndex];
  const z = p.z[pathIndex];
  let next = p.w[depth];
  let total = 0;
  if (o !== 0) {
    for (let i = depth - 1; i >= 0; i--) {
      const tmp = next / ((i + 1) * o);
      total += tmp;
      next = p.w[i] - tmp * z * (depth - i);
    }
  } else {
    for (let i = depth - 1; i >= 0; i--) total += p.w[i] / (z * (depth - i));
  }
  return total * (depth + 1);
}

/** Allocate one path buffer per tree level (reused across rows and trees). */
export function makeShapScratch(maxDepth: number): PathBuf[] {
  const len = maxDepth + 2;
  return Array.from({ length: maxDepth + 2 }, () => ({
    f: new Int32Array(len),
    z: new Float64Array(len),
    o: new Float64Array(len),
    w: new Float64Array(len),
  }));
}

/**
 * Add one tree's exact SHAP values for a row into `phi` (indexed by feature).
 * `binAt(f)` is the row's bin on feature f; `scratch` comes from
 * makeShapScratch(maxDepth ≥ the tree's depth).
 */
export function treeShap(
  tree: GbmTree,
  binAt: (f: number) => number,
  phi: Float64Array,
  scratch: PathBuf[],
): void {
  const recurse = (
    node: number,
    uniqueDepth: number,
    level: number,
    pz: number,
    po: number,
    pf: number,
  ): void => {
    const p = scratch[level];
    if (level > 0) {
      // Inherit the parent's path (its valid entries are 0 … uniqueDepth−1).
      const q = scratch[level - 1];
      for (let i = 0; i < uniqueDepth; i++) {
        p.f[i] = q.f[i];
        p.z[i] = q.z[i];
        p.o[i] = q.o[i];
        p.w[i] = q.w[i];
      }
    }
    extendPath(p, uniqueDepth, pz, po, pf);

    const split = tree.feature[node];
    if (split < 0) {
      const v = tree.value[node];
      for (let i = 1; i <= uniqueDepth; i++) {
        const w = unwoundPathSum(p, uniqueDepth, i);
        phi[p.f[i]] += w * (p.o[i] - p.z[i]) * v;
      }
      return;
    }

    const goesLeft = binAt(split) <= tree.threshold[node];
    const hot = goesLeft ? tree.left[node] : tree.right[node];
    const cold = goesLeft ? tree.right[node] : tree.left[node];
    const w = tree.cover[node];
    const hotZ = w > 0 ? tree.cover[hot] / w : 0;
    const coldZ = w > 0 ? tree.cover[cold] / w : 0;
    let inZ = 1;
    let inO = 1;
    let depth = uniqueDepth;
    // Already split on this feature higher up? Undo that extension so the
    // feature appears once on the path, carrying the combined fractions.
    let k = 0;
    for (; k <= depth; k++) if (p.f[k] === split) break;
    if (k !== depth + 1) {
      inZ = p.z[k];
      inO = p.o[k];
      unwindPath(p, depth, k);
      depth -= 1;
    }
    recurse(hot, depth + 1, level + 1, hotZ * inZ, inO, split);
    recurse(cold, depth + 1, level + 1, coldZ * inZ, 0, split);
  };
  recurse(0, 0, 0, 1, 1, -1);
}

// ── fit ─────────────────────────────────────────────────────────────────────

function evenStride<T>(items: T[], cap: number): { items: T[]; sampled: boolean } {
  if (items.length <= cap) return { items, sampled: false };
  const stride = items.length / cap;
  const out: T[] = new Array(cap);
  for (let i = 0; i < cap; i++) out[i] = items[Math.floor(i * stride)];
  return { items: out, sampled: true };
}

/**
 * Fit, score and explain a gradient-boosted tree ensemble.
 *
 * Rows whose target is missing (or outside the loss's support: not 0/1 for a
 * binary target, negative for a count) are dropped. 20% of the rest form a
 * seeded holdout — stratified for binary targets — that the trees never see;
 * every reported metric, the lift table and the SHAP summary come from it.
 *
 * Throws with a plain-English reason when the data cannot support a fit.
 */
export function fitGbm(
  rows: Row[],
  target: { column: string; kind: GbmTargetKind },
  features: GbmFeature[],
  overrides: Partial<GbmParams> = {},
): GbmFit {
  const params = { ...GBM_DEFAULTS, ...overrides };
  const { kind } = target;
  const col = target.column;
  const inputs = features.filter((f) => f.name !== col);
  if (inputs.length === 0) throw new Error(`no feature columns to predict \`${col}\` from`);

  const usable: Row[] = [];
  for (const r of rows) {
    const y = numericValue(r[col]);
    if (y === null) continue;
    if (kind === "binary" && y !== 0 && y !== 1) continue;
    if (kind === "count" && y < 0) continue;
    usable.push(r);
  }
  if (usable.length < GBM_MIN_ROWS) {
    throw new Error(
      `only ${usable.length} rows have a usable \`${col}\` value — need at least ${GBM_MIN_ROWS} for a holdout-scored fit`,
    );
  }
  const { items: data, sampled } = evenStride(usable, params.rowCap);
  const n = data.length;
  const yAll = Float64Array.from(data, (r) => r[col] as number);

  // ── seeded holdout split (stratified for binary targets) ───────────────
  const rand = mulberry32(params.seed);
  const holdoutMask = new Uint8Array(n);
  const strata: number[][] = kind === "binary" ? [[], []] : [[]];
  for (let i = 0; i < n; i++) strata[kind === "binary" ? yAll[i] : 0].push(i);
  if (kind === "binary" && (strata[0].length < 5 || strata[1].length < 5)) {
    throw new Error(
      `\`${col}\` has ${strata[1].length} ones and ${strata[0].length} zeros — need at least 5 of each to fit and score a classifier`,
    );
  }
  for (const s of strata) {
    shuffleInPlace(s, rand);
    const take = Math.max(1, Math.round(s.length * 0.2));
    for (let i = 0; i < take; i++) holdoutMask[s[i]] = 1;
  }
  const trainIdx: number[] = [];
  const holdIdx: number[] = [];
  for (let i = 0; i < n; i++) (holdoutMask[i] ? holdIdx : trainIdx).push(i);
  const nTrain = trainIdx.length;
  const nHold = holdIdx.length;
  const yTrain = Float64Array.from(trainIdx, (i) => yAll[i]);
  const yHold = Float64Array.from(holdIdx, (i) => yAll[i]);

  let trainMean = 0;
  for (const v of yTrain) trainMean += v;
  trainMean /= nTrain;
  let trainVar = 0;
  for (const v of yTrain) trainVar += (v - trainMean) ** 2;
  if (trainVar <= 1e-24) throw new Error(`\`${col}\` has no variation in the training rows`);

  // ── binning (cut points / level order from training rows only) ─────────
  const kept: GbmFeature[] = [];
  const binners: Binner[] = [];
  for (const f of inputs) {
    if (f.kind === "numeric") {
      const vals: number[] = [];
      for (const i of trainIdx) {
        const v = numericValue(data[i][f.name]);
        if (v !== null) vals.push(v);
      }
      const b = makeNumericBinner(vals, params.maxBins);
      if (b) {
        kept.push(f);
        binners.push(b);
      }
    } else {
      const stats = new Map<string, { sum: number; n: number }>();
      for (const i of trainIdx) {
        const lvl = categoricalValue(data[i][f.name]);
        if (lvl === null) continue;
        const s = stats.get(lvl) ?? { sum: 0, n: 0 };
        s.sum += yAll[i];
        s.n += 1;
        stats.set(lvl, s);
      }
      // Bins are bytes; a factor with hundreds of levels is an identifier,
      // not a rating factor, and has no business in a depth-3 tree anyway.
      if (stats.size < 2 || stats.size > MAX_CATEGORICAL_LEVELS) continue;
      const ordered = [...stats.entries()].sort(
        (a, b) => a[1].sum / a[1].n - b[1].sum / b[1].n || a[0].localeCompare(b[0]),
      );
      kept.push(f);
      binners.push({
        kind: "categorical",
        levelBin: new Map(ordered.map(([lvl], k) => [lvl, k + 1])),
      });
    }
  }
  if (kept.length === 0) {
    throw new Error(`none of the feature columns vary across the training rows of \`${col}\``);
  }
  const nF = kept.length;
  const binRows = (idx: number[]) =>
    binners.map((b, f) => Uint8Array.from(idx, (i) => binOf(b, data[i][kept[f].name])));
  const trainBins = binRows(trainIdx);
  const holdBins = binRows(holdIdx);
  const nBins = binners.map(binCount);

  // ── boosting ───────────────────────────────────────────────────────────
  const minLeaf = params.minLeaf ?? Math.max(5, Math.min(100, Math.floor(nTrain / 100)));
  // Start every row at the training mean on the margin scale.
  const p0 = Math.min(Math.max(trainMean, 1e-6), 1 - 1e-6);
  const baseScore =
    kind === "binary"
      ? Math.log(p0 / (1 - p0))
      : kind === "count"
        ? Math.log(Math.max(trainMean, 1e-6))
        : trainMean;
  const F = new Float64Array(nTrain).fill(baseScore);
  const FH = new Float64Array(nHold).fill(baseScore);
  const g = new Float64Array(nTrain);
  const h = new Float64Array(nTrain);
  const widest = Math.max(...nBins);
  const ctx: GrowCtx = {
    bins: trainBins,
    nBins,
    g,
    h,
    lambda: params.lambda,
    minLeaf,
    maxDepth: params.maxDepth,
    lr: params.learningRate,
    gH: new Float64Array(widest),
    hH: new Float64Array(widest),
    cH: new Int32Array(widest),
  };
  const all = Array.from({ length: nTrain }, (_, i) => i);
  const perTree = Math.max(2 * minLeaf, Math.round(params.subsample * nTrain));
  const trees: GbmTree[] = [];
  for (let t = 0; t < params.nTrees; t++) {
    for (let i = 0; i < nTrain; i++) {
      if (kind === "binary") {
        const p = sigmoid(F[i]);
        g[i] = p - yTrain[i];
        h[i] = Math.max(p * (1 - p), 1e-6);
      } else if (kind === "count") {
        g[i] = Math.exp(Math.min(F[i], 50)) - yTrain[i];
        h[i] = Math.exp(Math.min(F[i] + POISSON_MAX_DELTA_STEP, 50));
      } else {
        g[i] = F[i] - yTrain[i];
        h[i] = 1;
      }
    }
    shuffleInPlace(all, rand);
    const sub = Int32Array.from(all.slice(0, Math.min(perTree, nTrain)));
    const tree = growTree(sub, ctx);
    trees.push(tree);
    for (let i = 0; i < nTrain; i++) F[i] += predictRow(tree, trainBins, i);
    for (let i = 0; i < nHold; i++) FH[i] += predictRow(tree, holdBins, i);
  }

  // ── holdout metrics ────────────────────────────────────────────────────
  const pred = Float64Array.from(FH, (m) => linkInverse(kind, m));
  let holdMean = 0;
  for (const v of yHold) holdMean += v;
  holdMean /= nHold;
  let sse = 0;
  let sst = 0;
  for (let i = 0; i < nHold; i++) {
    sse += (yHold[i] - pred[i]) ** 2;
    sst += (yHold[i] - holdMean) ** 2;
  }
  const rmse = Math.sqrt(sse / nHold);
  let metrics: GbmMetrics;
  if (kind === "binary") {
    const auc = aucScore(yHold, pred);
    if (auc === null) throw new Error(`the holdout for \`${col}\` holds a single class`);
    let ll = 0;
    for (let i = 0; i < nHold; i++) {
      const p = Math.min(Math.max(pred[i], 1e-12), 1 - 1e-12);
      ll -= yHold[i] * Math.log(p) + (1 - yHold[i]) * Math.log(1 - p);
    }
    metrics = {
      primaryName: "AUC",
      primary: auc,
      rmse,
      logLoss: ll / nHold,
      holdoutMean: holdMean,
    };
  } else if (kind === "count") {
    const dModel = poissonDeviance(yHold, pred);
    const dNull = poissonDeviance(yHold, new Float64Array(nHold).fill(Math.max(trainMean, 1e-12)));
    const primary = dNull > 0 ? 1 - dModel / dNull : 0;
    metrics = { primaryName: "deviance explained", primary, rmse, holdoutMean: holdMean };
  } else {
    if (sst <= 1e-24) throw new Error(`\`${col}\` is constant on the holdout rows`);
    metrics = { primaryName: "R²", primary: 1 - sse / sst, rmse, holdoutMean: holdMean };
  }

  // ── lift: holdout rows by predicted decile ─────────────────────────────
  const nGroups = Math.max(2, Math.min(10, Math.floor(nHold / 5)));
  const order = Array.from({ length: nHold }, (_, i) => i).sort((a, b) => pred[a] - pred[b]);
  const lift = { groups: [] as string[], actual: [] as number[], predicted: [] as number[] };
  for (let q = 0; q < nGroups; q++) {
    const lo = Math.floor((q * nHold) / nGroups);
    const hi = Math.floor(((q + 1) * nHold) / nGroups);
    if (hi <= lo) continue;
    let sa = 0;
    let sp = 0;
    for (let k = lo; k < hi; k++) {
      sa += yHold[order[k]];
      sp += pred[order[k]];
    }
    lift.groups.push(nGroups === 10 ? `D${q + 1}` : `G${q + 1}`);
    lift.actual.push(sa / (hi - lo));
    lift.predicted.push(sp / (hi - lo));
  }

  // ── TreeSHAP over (a stride of) the holdout ────────────────────────────
  const explain = evenStride(
    Array.from({ length: nHold }, (_, i) => i),
    params.shapRows,
  ).items;
  const scratch = makeShapScratch(params.maxDepth);
  const phi = new Float64Array(nF);
  const sumAbs = new Float64Array(nF);
  // Running sums for corr(bin, φ) per feature — the direction read-out.
  const sx = new Float64Array(nF);
  const sy = new Float64Array(nF);
  const sxx = new Float64Array(nF);
  const syy = new Float64Array(nF);
  const sxy = new Float64Array(nF);
  let baseValue = baseScore;
  for (const tree of trees) baseValue += treeExpectedValue(tree);
  let maxErr = 0;
  for (const i of explain) {
    phi.fill(0);
    const binAt = (f: number) => holdBins[f][i];
    for (const tree of trees) treeShap(tree, binAt, phi, scratch);
    let total = baseValue;
    for (let f = 0; f < nF; f++) {
      total += phi[f];
      sumAbs[f] += Math.abs(phi[f]);
      const x = holdBins[f][i];
      sx[f] += x;
      sy[f] += phi[f];
      sxx[f] += x * x;
      syy[f] += phi[f] * phi[f];
      sxy[f] += x * phi[f];
    }
    maxErr = Math.max(maxErr, Math.abs(total - FH[i]));
  }
  const m = explain.length;
  const meanAbs = Array.from(sumAbs, (s) => s / m);
  const totalAbs = meanAbs.reduce((a, b) => a + b, 0);
  const direction = kept.map((f, j): ShapSummary["direction"][number] => {
    if (f.kind !== "numeric") return null;
    const cov = sxy[j] / m - (sx[j] / m) * (sy[j] / m);
    const vx = sxx[j] / m - (sx[j] / m) ** 2;
    const vy = syy[j] / m - (sy[j] / m) ** 2;
    if (vx <= 1e-12 || vy <= 1e-24) return "mixed";
    const r = cov / Math.sqrt(vx * vy);
    return r > 0.2 ? "up" : r < -0.2 ? "down" : "mixed";
  });
  const rank = kept.map((_, j) => j).sort((a, b) => meanAbs[b] - meanAbs[a]);
  const shap: ShapSummary = {
    features: rank.map((j) => kept[j].name),
    meanAbs: rank.map((j) => meanAbs[j]),
    share: rank.map((j) => (totalAbs > 0 ? meanAbs[j] / totalAbs : 0)),
    direction: rank.map((j) => direction[j]),
    rowsExplained: m,
    baseValue,
    maxAdditivityError: maxErr,
    scale: kind === "binary" ? "log-odds" : kind === "count" ? "log mean" : `${col} units`,
  };

  return {
    target: col,
    kind,
    features: kept,
    params: { ...params, minLeaf },
    baseScore,
    trees,
    nTrain,
    nHoldout: nHold,
    rowsUsable: usable.length,
    sampled,
    metrics,
    lift,
    shap,
  };
}
