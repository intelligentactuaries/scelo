// Deterministic mock executions for each model in the catalog. We compute
// real numbers from the user's dataset where its shape supports it
// (chain-ladder ATA factors, Mack CV, GLM-style frequency by group) and fall
// back to sensible canned values when the dataset doesn't fit the model's
// assumption (e.g. a mortality model running against claims-level data).
//
// Nothing here is a substitute for the real specialist services; the point
// is to make the soft→tools→hard story end-to-end visible without round-
// tripping every cell to the backend.

import { type Dataset, type Row, profileNumericColumns } from "@scelo/core";
import { runForecast, runSensitivity } from "./forecast/runner";
import { DEFAULT_WMTR_SINGLE_PARAMS, type WmtrSingleParams } from "./forecast/wmtr";
import {
  type GbmFeature,
  type GbmFit,
  type GbmTargetKind,
  type ShapSummary,
  fitGbm,
} from "./gbm";
import { hasModelPoints, parseModelPoints, runBasicTermProjection } from "./lifelibBasicTerm";
import { MODEL_BY_ID, type ModelFamily } from "./modelCatalog";
import {
  type LifeValues,
  detectMortalityTable,
  fitCBD,
  fitLeeCarter,
  lifeValues,
  nearestAge,
} from "./mortality";
import { fitBottleneck, numericColumns } from "./workspace";

export type RunStatus = "idle" | "running" | "done" | "error";

export type RunResult = {
  modelId: string;
  family: ModelFamily;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  // primary number that lands on the result card
  headline: { label: string; value: number; unit?: string; precision?: number };
  // 1-3 supporting figures
  secondary: Array<{ label: string; value: string }>;
  // optional time- / category- series for a tiny chart on the card
  series?: { kind: "line" | "bar"; x: string[]; y: number[] };
  // OR (mutually exclusive with `series`) a small table for the card. Some
  // models — Bornhuetter-Ferguson is the textbook case — produce a per-cohort
  // breakdown that reads better as a 2- or 3-column table than as a sparkline.
  // The rule is "at most one visual element per result node", so populate
  // either `series` or `tableSpec`, never both.
  tableSpec?: {
    headers: string[];
    // Cell values stay as raw types; the renderer right-aligns numbers and
    // formats them via `formatNumber`.
    rows: Array<Array<number | string>>;
  };
  // one-line plain-English summary the narrative hub stitches together
  blurb: string;
  // raw computed object — debug / chatbar context
  detail?: Record<string, unknown>;
  error?: string;
  // Provenance of the numbers: the desktop IDE's bundled Python or R bridge
  // (canonical library implementation) or the in-browser TS engine.
  // Optional because persisted runs predate the field — treat absent as
  // "browser".
  source?: "python-bridge" | "r-bridge" | "browser";
  // Set when a bridge was attempted but failed. The in-browser fallback
  // still runs, but the result card must say WHY the canonical path
  // didn't — a bridge failure must never be a silent mock substitution.
  bridgeError?: string;
  /** With status "error": the model does not apply to this dataset (its
   *  inputs are absent — no triangle, no mortality table, too few rows), as
   *  opposed to a run that broke. Shown as a neutral "not applicable", not
   *  counted as an error. */
  notApplicable?: true;
  /** Canvas wiring provenance: upstream models whose results this run
   *  consumed, with a one-line note of what flowed across the wire. */
  wiredFrom?: Array<{ id: string; note: string }>;
};

/** Which quantity a run's headline estimates — the key the Hard Data "do my
 *  models agree?" views (forest plot, spread tile) group by. Display labels
 *  carry the method and provenance ("IBNR · Mack", "BF reserve", "IBNR p50")
 *  even though every reserving method estimates the SAME outstanding reserve;
 *  grouping on the raw label kept BF and bootstrap out of the reserving
 *  forest, and in the IDE — where each bridged label was distinct — the
 *  reserving forest and spread never formed at all. */
export function comparableKey(run: RunResult): string {
  if (run.family === "reserving" && /\b(ibnr|reserve)\b/i.test(run.headline.label)) {
    return "IBNR reserve";
  }
  return run.headline.label;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function numericCol(rows: Row[], name: string): number[] {
  return rows
    .map((r) => r[name])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

function fmt(n: number, max = 2): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 10000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (abs >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: max });
  return n.toPrecision(3);
}

function pct(n: number, digits = 1): string {
  return `${(100 * n).toFixed(digits)}%`;
}

// ── dataset shape detection ──────────────────────────────────────────────────
//
// The pricing/climate runners must not assume a fixed schema (`paid`,
// `line`, `state`…) — real uploads use arbitrary column names. These
// helpers detect the roles generically. Detection scans a bounded slice
// of the rows so a 250k-row import stays cheap; the import layer already
// reservoir-samples large files, so the slice is representative.

const DETECT_SCAN_CAP = 50_000;

// Row identifiers pretending to be covariates: `id`, `policy_id`, `uuid`…
const ID_LIKE_NAME = /^(id|.*_id|uuid|.*key)$/i;

// Count-like frequency targets: past_claims, claims, claim_count, n_claims…
const CLAIM_COUNT_RE = /(^|_)(past_)?claims?(_count)?(_|$)/i;

// Monetary severity columns.
const MONETARY_RE = /(^|_)(paid|claim_amt|claim_amount|severity|loss|incurred)(_|$)/i;

// String-typed columns with a small number of levels — the rating factors a
// GLM can actually use. Excludes id-like columns both by name and by shape
// (unique ≈ row count means it's an identifier, not a factor).
export function detectCategoricalCovariates(dataset: Dataset, maxLevels = 20): string[] {
  const rows = dataset.rows;
  const scan = Math.min(rows.length, DETECT_SCAN_CAP);
  if (scan === 0) return [];
  const found: string[] = [];
  for (const col of dataset.columns) {
    if (ID_LIKE_NAME.test(col)) continue;
    const seen = new Set<string>();
    let nonNull = 0;
    let strings = 0;
    let tooMany = false;
    for (let i = 0; i < scan; i++) {
      const v = rows[i][col];
      if (v === null || v === undefined || v === "") continue;
      nonNull++;
      if (typeof v === "string") strings++;
      seen.add(String(v));
      if (seen.size > maxLevels) {
        tooMany = true;
        break;
      }
    }
    if (tooMany || nonNull === 0) continue;
    if (seen.size < 2) continue;
    if (strings < nonNull * 0.9) continue; // string-typed columns only
    if (seen.size >= nonNull * 0.8) continue; // id-like: unique ≈ rows
    found.push(col);
  }
  return found;
}

// Frequency target: a count-like column name whose values are small
// non-negative integers (past_claims, claim_count, …).
export function detectFrequencyTarget(dataset: Dataset): string | null {
  const rows = dataset.rows;
  const scan = Math.min(rows.length, DETECT_SCAN_CAP);
  for (const col of dataset.columns) {
    if (!CLAIM_COUNT_RE.test(col)) continue;
    let numeric = 0;
    let smallInts = 0;
    for (let i = 0; i < scan; i++) {
      const v = rows[i][col];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      numeric++;
      if (Number.isInteger(v) && v >= 0 && v <= 50) smallInts++;
    }
    if (numeric > 0 && smallInts >= numeric * 0.95) return col;
  }
  return null;
}

// Monetary severity column: paid / claim_amt / severity / loss / incurred
// with at least one positive numeric value.
// Indicator columns whose NAME matches the monetary pattern anyway —
// `claim_incurred_flag` is the reported case: it matched via `incurred`,
// won on column order, and a Gamma severity model was fitted to a 0/1
// flag (headline "severity = 1", crashed the statsmodels bridge).
const FLAGGY_RE = /(^|_)(flag|ind|indicator|is|has|bool)(_|$)/i;
// Names that are near-certainly a real monetary amount — preferred over
// generic pattern hits regardless of column order.
const STRONG_MONEY_RE = /(amount|amt|zar|usd|gbp|eur|cost|paid|severity|loss)/i;

export function detectMonetaryColumn(dataset: Dataset): string | null {
  const rows = dataset.rows;
  const scan = Math.min(rows.length, DETECT_SCAN_CAP);
  const candidates: Array<{ col: string; strong: boolean }> = [];
  for (const col of dataset.columns) {
    if (!MONETARY_RE.test(col)) continue;
    if (FLAGGY_RE.test(col)) continue;
    // Value screen: must carry a positive value AND not be all 0/1 —
    // a binary column is an indicator whatever its name says.
    let positive = false;
    let nonBinary = false;
    for (let i = 0; i < scan; i++) {
      const v = rows[i][col];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (v > 0) positive = true;
      if (v !== 0 && v !== 1) nonBinary = true;
      if (positive && nonBinary) break;
    }
    if (!positive || !nonBinary) continue;
    candidates.push({ col, strong: STRONG_MONEY_RE.test(col) });
  }
  const strong = candidates.find((c) => c.strong);
  return (strong ?? candidates[0])?.col ?? null;
}

// Exposure-like column for the climate runners. Fuzzy on purpose:
// real-world headers truncate ("sum_insurd") or vary ("tiv", "TIV_usd").
// `paid` is last-resort — a loss column is a poor exposure proxy but beats
// nothing on claims-level data.
const EXPOSURE_PATTERNS = [/^sum_insur/i, /(^|_)tiv(_|$)/i, /(^|_)exposure(s)?(_|$)/i, /^paid$/i];

export function findExposureColumn(dataset: Dataset): string | null {
  for (const re of EXPOSURE_PATTERNS) {
    const col = dataset.columns.find((c) => re.test(c));
    if (col) return col;
  }
  return null;
}

// ── supervised target for the GBM / SHAP pair ─────────────────────────────
//
// A boosted model needs a response column. Pricing data usually names one
// (an amount, a claim count, a 0/1 claim indicator); anything else falls back
// to the last numeric column, the conventional "response last" layout. The
// choice and the reason for it travel with the result, so the card always
// says WHAT was predicted and why that column.

// 0/1 columns named like an outcome worth classifying.
const BINARY_TARGET_RE =
  /(^|_)(claims?|lapsed?|lapses|default(ed)?|churn(ed)?|fraud|target|label|outcome|event|response)(_|$)/i;
const GENERIC_TARGET_RE = /^(target|label|y|response|outcome)$/i;
// Claim outcomes are leakage, not rating factors, when the target is itself
// a claims outcome (incurred beside paid, a claim flag beside a claim count).
const OUTCOME_LIKE_RE =
  /(^|_)(paid|incurred|claims?|claim_amt|claim_amount|loss(es)?|severity|settled|reserves?|ibnr)(_|$)/i;
const GBM_MAX_FEATURES = 40;

export type ModelTarget = {
  column: string;
  kind: GbmTargetKind;
  /** Plain-English reason this column was chosen — shown on the card. */
  reason: string;
  /** True when the target is a claims outcome (amount / count / indicator). */
  claimsOutcome: boolean;
};

function isBinaryColumn(dataset: Dataset, col: string): boolean {
  const scan = Math.min(dataset.rows.length, DETECT_SCAN_CAP);
  let zeros = 0;
  let ones = 0;
  for (let i = 0; i < scan; i++) {
    const v = dataset.rows[i][col];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (v === 0) zeros++;
    else if (v === 1) ones++;
    else return false;
  }
  return zeros > 0 && ones > 0;
}

export function detectModelTarget(dataset: Dataset): ModelTarget | null {
  const money = detectMonetaryColumn(dataset);
  if (money) {
    return { column: money, kind: "continuous", reason: "monetary amount", claimsOutcome: true };
  }
  const freq = detectFrequencyTarget(dataset);
  if (freq) return { column: freq, kind: "count", reason: "claim count", claimsOutcome: true };
  const numeric = numericColumns(dataset);
  const kindOf = (c: string): GbmTargetKind => (isBinaryColumn(dataset, c) ? "binary" : "continuous");
  const indicator = numeric.find((c) => BINARY_TARGET_RE.test(c) && isBinaryColumn(dataset, c));
  if (indicator) {
    return { column: indicator, kind: "binary", reason: "0/1 indicator", claimsOutcome: true };
  }
  const named = numeric.find((c) => GENERIC_TARGET_RE.test(c));
  if (named) {
    return { column: named, kind: kindOf(named), reason: "named target", claimsOutcome: false };
  }
  // Swarm-simulation output: the sim_* columns ARE the outcomes.
  const sim = numeric.find((c) => c.toLowerCase().startsWith("sim_"));
  if (sim) {
    return { column: sim, kind: kindOf(sim), reason: "simulation outcome", claimsOutcome: false };
  }
  const last = numeric[numeric.length - 1];
  if (!last) return null;
  return {
    column: last,
    kind: kindOf(last),
    reason: "last numeric column (no amount, count or indicator column found)",
    claimsOutcome: false,
  };
}

/** Feature columns for a boosted fit of `target`: every usable numeric column
 *  plus the categorical rating factors, minus the target itself and — for a
 *  claims target — the other claims outcomes (they leak the answer). */
export function detectModelFeatures(dataset: Dataset, target: ModelTarget): GbmFeature[] {
  const numeric: GbmFeature[] = numericColumns(dataset, [target.column]).map((name) => ({
    name,
    kind: "numeric",
  }));
  const cats: GbmFeature[] = detectCategoricalCovariates(dataset)
    .filter((c) => c !== target.column)
    .map((name) => ({ name, kind: "categorical" }));
  const all = [...numeric, ...cats];
  const usable = target.claimsOutcome ? all.filter((f) => !OUTCOME_LIKE_RE.test(f.name)) : all;
  return usable.slice(0, GBM_MAX_FEATURES);
}

// GBM and SHAP usually run in the same batch on the same dataset object —
// one fit serves both (and the SHAP numbers then explain exactly the model
// whose holdout metric sits on the GBM card). WeakMap: superseded dataset
// versions stay collectable.
const GBM_FIT_CACHE = new WeakMap<Dataset, Map<string, GbmFit>>();

/** `error` is a lower-case clause; callers frame it into a sentence. */
type GbmRun = { target: ModelTarget; fit: GbmFit } | { error: string };

function gbmFitFor(dataset: Dataset): GbmRun {
  const target = detectModelTarget(dataset);
  if (!target) return { error: "no numeric column to use as the target" };
  const features = detectModelFeatures(dataset, target);
  if (features.length === 0) {
    return { error: `no feature columns to predict \`${target.column}\` from` };
  }
  const key = `${target.column}|${target.kind}|${features.map((f) => f.name).join(",")}`;
  let perDataset = GBM_FIT_CACHE.get(dataset);
  const hit = perDataset?.get(key);
  if (hit) return { target, fit: hit };
  try {
    const fit = fitGbm(dataset.rows, { column: target.column, kind: target.kind }, features);
    if (!perDataset) {
      perDataset = new Map();
      GBM_FIT_CACHE.set(dataset, perDataset);
    }
    perDataset.set(key, fit);
    return { target, fit };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// Even-stride sample so capped fits still span the whole file (the rows are
// in file order — first-N would bias toward whatever sorted first).
export function sampleRowsCapped(rows: Row[], cap: number): { rows: Row[]; sampled: boolean } {
  if (rows.length <= cap) return { rows, sampled: false };
  const stride = rows.length / cap;
  const out: Row[] = new Array(cap);
  for (let i = 0; i < cap; i++) out[i] = rows[Math.floor(i * stride)];
  return { rows: out, sampled: true };
}

// The descriptive profile moved to @scelo/core so the TUI's describe
// analysis and this runner share ONE definition of every statistic (type-7
// quantiles, Bessel sd, G1/G2 shape, Jarque–Bera, CV ranking) — the two
// surfaces must never print different medians for the same file. Re-exported
// here because the descriptive runner, the detail modal's diagnostics /
// hypothesis panels, and the tests all reach it via this module.
export { profileNumericColumns, type NumericColumnProfile } from "@scelo/core";

// Try to coerce the claims-level dataset into a triangle indexed by origin
// year × dev period. Returns null if those columns aren't there.
function buildTriangle(dataset: Dataset): {
  origins: number[];
  devs: number[];
  cells: Map<string, number>; // "${origin}|${dev}" → cumulative paid
  cumByRow: Map<number, number[]>; // origin → cumulative-by-dev (filled NaN where missing)
} | null {
  const cols = dataset.columns.map((c) => c.toLowerCase());
  const originIdx = cols.indexOf("origin_year");
  const devIdx = cols.indexOf("dev_period");
  const paidIdx = cols.indexOf("paid");
  if (originIdx < 0 || devIdx < 0 || paidIdx < 0) return null;
  const oCol = dataset.columns[originIdx];
  const dCol = dataset.columns[devIdx];
  const pCol = dataset.columns[paidIdx];

  const originsSet = new Set<number>();
  const devsSet = new Set<number>();
  const pairs: Array<{ o: number; d: number; v: number }> = [];
  for (const r of dataset.rows) {
    const o = r[oCol];
    const d = r[dCol];
    const v = r[pCol];
    if (typeof o !== "number" || typeof d !== "number" || typeof v !== "number") continue;
    originsSet.add(o);
    devsSet.add(d);
    pairs.push({ o, d, v });
  }
  if (originsSet.size === 0) return null;
  const origins = [...originsSet].sort((a, b) => a - b);
  const devs = [...devsSet].sort((a, b) => a - b);

  // Per origin, sum within each dev period to get incremental paid.
  const inc: Map<number, Map<number, number>> = new Map();
  for (const o of origins) {
    const m = new Map<number, number>();
    for (const d of devs) m.set(d, 0);
    inc.set(o, m);
  }
  for (const p of pairs) {
    const m = inc.get(p.o);
    if (!m) continue;
    m.set(p.d, (m.get(p.d) ?? 0) + p.v);
  }

  // Cumulative by dev period within each origin, only filling cells where
  // (origin + dev) ≤ latest known calendar period — a real triangle has
  // missing future cells. We infer the latest observed calendar period as
  // max(origin + dev) over the OBSERVED pairs (not max(origin) + max(dev)),
  // so that on a properly-incomplete triangle the future cells correctly
  // stay NaN instead of accreting zero into chain-ladder's lastC.
  const cells = new Map<string, number>();
  const cumByRow = new Map<number, number[]>();
  const latestCalPeriod = pairs.reduce((m, p) => Math.max(m, p.o + p.d), Number.NEGATIVE_INFINITY);
  for (const o of origins) {
    const row: number[] = [];
    let acc = 0;
    for (const d of devs) {
      if (o + d > latestCalPeriod) {
        row.push(Number.NaN);
        continue;
      }
      acc += inc.get(o)?.get(d) ?? 0;
      row.push(acc);
      cells.set(`${o}|${d}`, acc);
    }
    cumByRow.set(o, row);
  }

  return { origins, devs, cells, cumByRow };
}

/** The claims triangle the reserving runners would build, in brief — or null
 *  when `origin_year`, `dev_period` and `paid` are not all there. */
export function triangleShape(
  dataset: Dataset,
): { origins: number; devs: number; columns: string[] } | null {
  const tri = buildTriangle(dataset);
  if (!tri) return null;
  const pick = (name: string) => dataset.columns.find((c) => c.toLowerCase() === name) ?? name;
  return {
    origins: tri.origins.length,
    devs: tri.devs.length,
    columns: [pick("origin_year"), pick("dev_period"), pick("paid")],
  };
}

// Cumulative development-to-ultimate factor array. cdf[k] = factors[k] *
// factors[k+1] * ... * factors[n-1]; cdf[n] = 1 (no further development).
function buildCdf(factors: number[]): number[] {
  const cdf = new Array<number>(factors.length + 1).fill(1);
  for (let k = factors.length - 1; k >= 0; k--) {
    cdf[k] = factors[k] * cdf[k + 1];
  }
  return cdf;
}

// Mack age-to-age factors from a cumulative triangle (origins × devs).
//
// Returns, per development step k:
//   factors[k]  volume-weighted f̂_k = Σ C_{i,k+1} / Σ C_{i,k}
//   sigmas[k]   Mack's σ̂_k  — from σ̂_k² = 1/(n_k−1) · Σ C_{i,k}(F_{i,k} − f̂_k)²
//               (NOTE: C-weighted, so σ_k carries √currency units — any use
//               must keep it inside Mack's own mse formula, never treat it as
//               a dimensionless ratio)
//   dens[k]     S_k = Σ C_{i,k} over the origins that entered f̂_k — the
//               1/S_k estimation-error term in Mack's mse
//   counts[k]   n_k — how many origin pairs entered the estimate
function ataFactors(tri: NonNullable<ReturnType<typeof buildTriangle>>) {
  const { origins, devs, cumByRow } = tri;
  const factors: number[] = [];
  const sigmas: number[] = [];
  const dens: number[] = [];
  const counts: number[] = [];
  for (let k = 0; k < devs.length - 1; k++) {
    let num = 0;
    let den = 0;
    const f_i: Array<{ c: number; ratio: number }> = [];
    for (const o of origins) {
      const row = cumByRow.get(o);
      if (!row) continue;
      const c_k = row[k];
      const c_k1 = row[k + 1];
      if (!Number.isFinite(c_k) || !Number.isFinite(c_k1) || c_k === 0) continue;
      num += c_k1;
      den += c_k;
      f_i.push({ c: c_k, ratio: c_k1 / c_k });
    }
    const f = den > 0 ? num / den : 1;
    factors.push(f);
    // Mack's sigma-squared estimator for dev period k.
    let s2 = 0;
    let count = 0;
    for (const fi of f_i) {
      s2 += fi.c * (fi.ratio - f) * (fi.ratio - f);
      count++;
    }
    sigmas.push(count > 1 ? Math.sqrt(s2 / (count - 1)) : 0);
    dens.push(den);
    counts.push(count);
  }
  // Mack's tail convention: the last σ has at most one observation (so the
  // estimator above returns 0, understating the tail). Extrapolate
  // σ²_{J-1} = min(σ⁴_{J-2}/σ²_{J-3}, min(σ²_{J-3}, σ²_{J-2})) when the
  // neighbours exist and are positive.
  const J = sigmas.length;
  if (J >= 3 && counts[J - 1] < 2) {
    const a = sigmas[J - 2] ** 2;
    const b = sigmas[J - 3] ** 2;
    if (a > 0 && b > 0) {
      sigmas[J - 1] = Math.sqrt(Math.min((a * a) / b, Math.min(a, b)));
    }
  }
  return { factors, sigmas, dens, counts };
}

// ── runners ──────────────────────────────────────────────────────────────────

type Args = {
  dataset: Dataset;
  /** Results of models wired INTO this one on the Tools canvas, keyed by
   *  model id. Runners that know how to consume an upstream result do so
   *  and record it in `wiredFrom`; everything else ignores it. */
  upstream?: Map<string, RunResult>;
};

/** Wired upstream result, if present and successfully computed. */
function wired(upstream: Map<string, RunResult> | undefined, id: string): RunResult | null {
  const r = upstream?.get(id);
  return r && r.status === "done" ? r : null;
}

function runChainLadder({ dataset }: Args): RunResult {
  const tri = buildTriangle(dataset);
  if (!tri) {
    return makeUnsupported(
      "chain-ladder",
      "reserving",
      "Triangle not detected (need origin_year, dev_period, paid).",
    );
  }
  const { factors } = ataFactors(tri);
  const cdf = buildCdf(factors);
  // For each row, project to ultimate using its latest known cumulative and
  // the remaining CDF tail.
  let paidToDate = 0;
  let ultimate = 0;
  const ultByOrigin: number[] = [];
  for (const o of tri.origins) {
    const row = tri.cumByRow.get(o) ?? [];
    let lastK = -1;
    let lastC = 0;
    for (let k = 0; k < row.length; k++) {
      if (Number.isFinite(row[k])) {
        lastK = k;
        lastC = row[k];
      }
    }
    if (lastK < 0) continue;
    const remainingCdf = cdf[lastK] ?? 1;
    const ult = lastC * remainingCdf;
    paidToDate += lastC;
    ultimate += ult;
    ultByOrigin.push(ult);
  }
  const ibnr = ultimate - paidToDate;
  return {
    modelId: "chain-ladder",
    family: "reserving",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: { label: "IBNR", value: ibnr, precision: 0 },
    secondary: [
      { label: "ultimate", value: fmt(ultimate, 0) },
      { label: "paid to date", value: fmt(paidToDate, 0) },
      { label: "ATA factors", value: factors.map((f) => f.toFixed(3)).join(" → ") || "—" },
    ],
    series: {
      kind: "bar",
      x: tri.origins.map(String),
      y: ultByOrigin,
    },
    blurb: `Chain ladder estimates IBNR of ${fmt(ibnr, 0)} on an ultimate of ${fmt(ultimate, 0)} (paid-to-date ${fmt(paidToDate, 0)}).`,
    detail: { factors, cdf, ultimate, paidToDate, ibnr, ultByOrigin },
  };
}

function runMack({ dataset }: Args): RunResult {
  const tri = buildTriangle(dataset);
  if (!tri) {
    return makeUnsupported("mack", "reserving", "Triangle not detected.");
  }
  const { factors, sigmas, dens } = ataFactors(tri);
  // Mack's point estimate IS chain ladder on the same triangle — refit here
  // rather than taken off a wire: a wired chain-ladder result is the same
  // number, so the Tools canvas gives Mack no pin for it.
  const base = runChainLadder({ dataset });
  const ibnr = base.headline.value;
  // Mack (1993) mean-squared error of the total reserve. Per origin i with
  // diagonal at dev t_i and projected cumulatives Ĉ_{i,k}:
  //
  //   mse(R̂_i) = Ĉ_{i,J}² · Σ_{k=t_i}^{J-1} (σ̂_k²/f̂_k²) · (1/Ĉ_{i,k} + 1/S_k)
  //
  // and the total adds the covariance between origins that share f̂_k:
  //
  //   mse(R̂) = Σ_i { mse(R̂_i) + Ĉ_{i,J} (Σ_{j>i} Ĉ_{j,J}) Σ_{k=t_i}^{J-1} 2σ̂_k²/(f̂_k² S_k) }
  //
  // This replaced an ad-hoc "σ/f, times IBNR, times 0.15" formula whose
  // units didn't close (Mack's σ_k is C-weighted, √currency — treating it
  // as a ratio and re-scaling by IBNR produced SEs ~20× the reserve, a
  // 2000% CV, and a forest plot squashed onto a ±60m axis).
  const J = factors.length; // dev steps; cumulative index runs 0..J
  type OriginProj = { lastK: number; proj: number[]; ult: number };
  const projections: OriginProj[] = [];
  for (const o of tri.origins) {
    const row = tri.cumByRow.get(o) ?? [];
    let lastK = -1;
    let lastC = 0;
    for (let k = 0; k < row.length; k++) {
      if (Number.isFinite(row[k])) {
        lastK = k;
        lastC = row[k];
      }
    }
    if (lastK < 0 || lastC <= 0) continue;
    const proj = new Array<number>(J + 1).fill(Number.NaN);
    proj[lastK] = lastC;
    for (let k = lastK; k < J; k++) proj[k + 1] = proj[k] * (factors[k] || 1);
    projections.push({ lastK, proj, ult: proj[J] });
  }
  let varTotal = 0;
  for (let i = 0; i < projections.length; i++) {
    const { lastK, proj, ult } = projections[i];
    // Per-origin process + estimation error.
    let inner = 0;
    for (let k = lastK; k < J; k++) {
      const f2 = (factors[k] || 1) ** 2;
      const s2 = sigmas[k] ** 2;
      if (s2 <= 0 || f2 <= 0) continue;
      const cHat = proj[k];
      const Sk = dens[k];
      if (!Number.isFinite(cHat) || cHat <= 0) continue;
      inner += (s2 / f2) * (1 / cHat + (Sk > 0 ? 1 / Sk : 0));
    }
    varTotal += ult * ult * inner;
    // Covariance with the later origins (they share the estimated f̂_k).
    let ultLater = 0;
    for (let j = i + 1; j < projections.length; j++) ultLater += projections[j].ult;
    if (ultLater > 0) {
      let cross = 0;
      for (let k = lastK; k < J; k++) {
        const f2 = (factors[k] || 1) ** 2;
        const s2 = sigmas[k] ** 2;
        const Sk = dens[k];
        if (s2 <= 0 || f2 <= 0 || Sk <= 0) continue;
        cross += (2 * s2) / (f2 * Sk);
      }
      varTotal += ult * ultLater * cross;
    }
  }
  const se = Number.isFinite(varTotal) && varTotal > 0 ? Math.sqrt(varTotal) : 0;
  const cv = ibnr > 0 && se > 0 ? se / ibnr : 0;
  return {
    modelId: "mack",
    family: "reserving",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: { label: "IBNR", value: ibnr, precision: 0 },
    secondary: [
      { label: "SE", value: fmt(se, 0) },
      { label: "CV", value: pct(cv) },
      { label: "ATA σ", value: sigmas.map((s) => s.toFixed(2)).join(" / ") || "—" },
    ],
    series: base.series,
    blurb: `Mack reproduces chain-ladder's ${fmt(ibnr, 0)} IBNR with a CV of ${pct(cv)} (SE ≈ ${fmt(se, 0)}).`,
    detail: { factors, sigmas, ibnr, se, cv },
  };
}

function runBornhuetterFerguson({ dataset }: Args): RunResult {
  const tri = buildTriangle(dataset);
  if (!tri) {
    return makeUnsupported("bornhuetter-ferguson", "reserving", "Triangle not detected.");
  }
  const { factors } = ataFactors(tri);
  const cdf = buildCdf(factors);
  // A-priori expected ultimates. BF's whole point is blending the
  // development view with an INDEPENDENT prior. With no plan / pricing loss
  // ratio in the data, the prior is the book-average ultimate held constant
  // per origin. It is deliberately NOT chain ladder's per-origin ultimate:
  // that prior collapses BF onto chain ladder exactly (Ĉ·F × (1 − 1/F) =
  // Ĉ·(F − 1), the CL reserve), which is why the Tools canvas no longer
  // wires chain ladder into BF. (The older standalone back-solved premium
  // from a flat ELR, which cancelled back to the chain-ladder ultimate the
  // same way — a BF whose prior cannot move the answer isn't a BF.)
  let bookUltSum = 0;
  let bookUltN = 0;
  for (const o of tri.origins) {
    const row = tri.cumByRow.get(o) ?? [];
    let lastK = -1;
    let lastC = 0;
    for (let k = 0; k < row.length; k++) {
      if (Number.isFinite(row[k])) {
        lastK = k;
        lastC = row[k];
      }
    }
    if (lastK < 0) continue;
    bookUltSum += lastC * (cdf[lastK] ?? 1);
    bookUltN++;
  }
  const bookAvgUlt = bookUltN > 0 ? bookUltSum / bookUltN : 0;
  let bfReserve = 0;
  let ult = 0;
  // Per-origin breakdown — populated alongside the running totals so the
  // node's small table can show "where the reserve comes from" cohort by
  // cohort, which is the most useful diagnostic for a BF estimate.
  const perOrigin: Array<{ origin: number; reserve: number }> = [];
  for (const o of tri.origins) {
    const row = tri.cumByRow.get(o) ?? [];
    let lastK = -1;
    let lastC = 0;
    for (let k = 0; k < row.length; k++) {
      if (Number.isFinite(row[k])) {
        lastK = k;
        lastC = row[k];
      }
    }
    if (lastK < 0) continue;
    const remainingCdf = cdf[lastK] ?? 1;
    const pctDevelopedRatio = remainingCdf > 0 ? 1 / remainingCdf : 1;
    const expectedUltimate = bookAvgUlt || lastC;
    const bfRes = expectedUltimate * (1 - pctDevelopedRatio);
    bfReserve += bfRes;
    ult += lastC + bfRes;
    perOrigin.push({ origin: o, reserve: bfRes });
  }
  // Sort by reserve desc and trim to top 5 — the eye picks up "where does
  // the reserve concentrate?" in one glance. Real-world packs usually
  // surface the same view.
  const topOrigins = [...perOrigin].sort((a, b) => b.reserve - a.reserve).slice(0, 5);
  return {
    modelId: "bornhuetter-ferguson",
    family: "reserving",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: { label: "BF reserve", value: bfReserve, precision: 0 },
    secondary: [
      { label: "ultimate", value: fmt(ult, 0) },
      { label: "a-priori", value: `book-avg ultimate ${fmt(bookAvgUlt, 0)}` },
    ],
    // Top contributors to the total reserve — bf has no time-series since
    // it isn't a development-pattern model, so the in-card visual is a
    // table instead of a sparkline (per the "one item per node" rule).
    tableSpec: {
      headers: ["origin", "reserve"],
      // Origin as text: it is a label, and the table's number formatter
      // printed a numeric year with a thousands separator ("2,024").
      rows: topOrigins.map((p) => [String(p.origin), p.reserve]),
    },
    blurb: `BF gives a reserve of ${fmt(bfReserve, 0)} against a book-average ultimate prior of ${fmt(bookAvgUlt, 0)}.`,
    detail: {
      factors,
      cdf,
      bfReserve,
      ult,
      bookAvgUlt,
      perOrigin,
      aprioriSource: "book-average",
    },
  };
}

function runBootstrap({ dataset }: Args): RunResult {
  // Centred on chain ladder refitted on the same triangle (the ODP bootstrap
  // IS chain ladder's stochastic twin), so no wire feeds it.
  const base = runChainLadder({ dataset });
  if (base.status === "error") return { ...base, modelId: "bootstrap-ibnr", family: "reserving" };
  const ibnr = base.headline.value;
  // Pretend we ran 5000 bootstrap resamples with ±18% noise around the
  // chain-ladder reserve. Real bootstrap is a backend job.
  const noise = 0.18;
  const p5 = ibnr * (1 - 1.65 * noise);
  const p95 = ibnr * (1 + 1.65 * noise);
  return {
    modelId: "bootstrap-ibnr",
    family: "reserving",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: { label: "IBNR p50", value: ibnr, precision: 0 },
    secondary: [
      { label: "p5", value: fmt(p5, 0) },
      { label: "p95", value: fmt(p95, 0) },
      { label: "iters", value: "5,000 (mock)" },
    ],
    series: base.series,
    blurb: `Bootstrap brackets IBNR between ${fmt(p5, 0)} (p5) and ${fmt(p95, 0)} (p95) around ${fmt(ibnr, 0)}.`,
    detail: { ibnr, p5, p95 },
  };
}

// ── mortality · Lee–Carter, CBD, life contingencies ──────────────────────
//
// Real fits on the dataset's mortality table (mortality.ts), or "not
// computed" with the reason. The old runners returned numbers for ANY
// dataset: Lee–Carter "projected" q(65) = 0.012·(1 − improvement)^t with the
// improvement read off the mean of an `age` column (a default of 50 when
// there was none), CBD scaled that path by (1 + 0.0008·t), and the annuity
// priced off it or off a hard-coded survival curve — so the workspace demo,
// which has no age, year or rate column at all, showed q(65) 0.00951 and
// a₆₅ 8.65 as completed results.

function runLeeCarter({ dataset }: Args): RunResult {
  const found = detectMortalityTable(dataset);
  if ("reason" in found) {
    return makeUnsupported("lee-carter", "mortality", sentence(found.reason));
  }
  const fit = fitLeeCarter(found.table);
  if ("reason" in fit) return makeUnsupported("lee-carter", "mortality", sentence(fit.reason));
  const t = found.table;
  const h = fit.horizon - 1;
  const endYear = fit.projYears[h];
  const finalQ = fit.qx[h];
  const span = `${fit.years[0]}–${fit.years[fit.years.length - 1]}`;
  return {
    modelId: "lee-carter",
    family: "mortality",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: { label: `q(${fit.headlineAge}) in ${endYear}`, value: finalQ, precision: 5 },
    secondary: [
      { label: "annual improvement", value: pct(fit.annualImprovement, 2) },
      { label: "κ drift", value: fit.drift.toFixed(4) },
      { label: "95% band", value: `${fmt(fit.qxLower[h])} – ${fmt(fit.qxUpper[h])}` },
      { label: "rank-1 fit", value: `${pct(fit.explained)} of log-rate variation` },
      { label: "table", value: `${fit.years.length} years × ${fit.ages.length} ages (${t.basis})` },
    ],
    series: { kind: "line", x: fit.projYears.map(String), y: fit.qx },
    blurb:
      `Lee–Carter fitted to ${fit.years.length} years (${span}) × ${fit.ages.length} ages of ${t.basis}: ` +
      `the rank-1 term explains ${pct(fit.explained)} of the log-rate variation and κ drifts ` +
      `${fit.drift.toFixed(3)} a year, projecting q(${fit.headlineAge}) to ${finalQ.toFixed(5)} by ${endYear} ` +
      `(${pct(fit.annualImprovement, 2)}/yr improvement).`,
    // The full projection (α, β, κ forecast) rides along: a wired life-
    // contingencies run prices the COHORT off it, not just the headline age.
    detail: { ...fit, basis: t.basis, source: "in-browser" },
  };
}

function runCBD({ dataset }: Args): RunResult {
  const found = detectMortalityTable(dataset);
  if ("reason" in found) return makeUnsupported("cbd", "mortality", sentence(found.reason));
  const fit = fitCBD(found.table);
  if ("reason" in fit) return makeUnsupported("cbd", "mortality", sentence(fit.reason));
  const h = fit.horizon - 1;
  const endYear = fit.projYears[h];
  const finalQ = fit.qx[h];
  const ageSpan = `${fit.ages[0]}–${fit.ages[fit.ages.length - 1]}`;
  return {
    modelId: "cbd",
    family: "mortality",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: { label: `q(${fit.headlineAge}) in ${endYear}`, value: finalQ, precision: 5 },
    secondary: [
      { label: "κ₁ drift (level)", value: fit.drift1.toFixed(4) },
      { label: "κ₂ drift (slope)", value: fit.drift2.toFixed(5) },
      { label: "ages fitted", value: `${ageSpan} (x̄ ${fit.xbar.toFixed(1)})` },
      { label: "table", value: `${fit.years.length} years (${found.table.basis})` },
    ],
    series: { kind: "line", x: fit.projYears.map(String), y: fit.qx },
    blurb:
      `CBD fitted per year over ages ${ageSpan} (logit q = κ₁ + κ₂(x − x̄)): κ₁ drifts ` +
      `${fit.drift1.toFixed(3)} and κ₂ ${fit.drift2.toFixed(4)} a year, projecting q(${fit.headlineAge}) ` +
      `to ${finalQ.toFixed(5)} by ${endYear}.`,
    detail: { ...fit, basis: found.table.basis, source: "in-browser" },
  };
}

// The contract every life-contingencies figure is quoted on.
const LIFE_AGE = 65;
const LIFE_TERM = 10;
const LIFE_INTEREST = 0.04;

export type LifeBasis = {
  /** One-year death probabilities faced at ages x, x+1, … x+n−1. */
  q: number[];
  x: number;
  source: "lee-carter" | "cbd" | "table";
  /** Human description of where q came from, for the card. */
  note: string;
};

/** A wired CBD fit's projected cohort: logit q(x+t, T+1+t) = κ₁ + κ₂(x+t − x̄)
 *  with both κ's walked forward on their drifts — the same projection the CBD
 *  card plots, read along the diagonal. Stays inside the fitted ages. */
function cbdCohort(detail: Record<string, unknown> | undefined): LifeBasis | null {
  const d = detail as
    | {
        ages?: unknown;
        kappa1?: unknown;
        kappa2?: unknown;
        drift1?: unknown;
        drift2?: unknown;
        xbar?: unknown;
        projYears?: unknown;
      }
    | undefined;
  if (
    !d ||
    !Array.isArray(d.ages) ||
    !Array.isArray(d.kappa1) ||
    !Array.isArray(d.kappa2) ||
    !Array.isArray(d.projYears) ||
    typeof d.drift1 !== "number" ||
    typeof d.drift2 !== "number" ||
    typeof d.xbar !== "number"
  ) {
    return null;
  }
  const ages = d.ages as number[];
  const k1 = d.kappa1 as number[];
  const k2 = d.kappa2 as number[];
  const years = d.projYears as number[];
  if (ages.length === 0 || k1.length === 0 || k1.length !== k2.length) return null;
  const T = k1.length - 1;
  const x = ages[nearestAge(ages, LIFE_AGE)];
  const maxAge = ages[ages.length - 1];
  const q: number[] = [];
  for (let t = 0; t < Math.min(LIFE_TERM, years.length); t++) {
    const age = x + t;
    if (age > maxAge) break; // the cohort has aged past the fitted ages
    const z = k1[T] + (t + 1) * d.drift1 + (k2[T] + (t + 1) * d.drift2) * (age - d.xbar);
    q.push(1 / (1 + Math.exp(-z)));
  }
  if (q.length === 0) return null;
  return {
    q,
    x,
    source: "cbd",
    note: `wired CBD cohort, ages ${x}–${x + q.length - 1} in ${years[0]}–${years[q.length - 1]}`,
  };
}

/**
 * The mortality a life-contingencies run prices on: a wired projection's
 * COHORT — Lee–Carter or CBD, whichever the Tools canvas plugs into the
 * mortality pin (a life aged x next year meets q(x) that year, q(x+1) the
 * year after, …) — or, with nothing wired, the dataset's own life table (its
 * latest year). Shared by the in-browser runner and the R bridge so both
 * price the same q vector. The old runner walked the wired q(65) PATH — one
 * age's rate over ten calendar years — as if it were a cohort ageing
 * through 65…74.
 */
export function resolveLifeBasis(
  dataset: Dataset,
  upstream?: Map<string, RunResult>,
): LifeBasis | { reason: string } {
  const cbd = cbdCohort(wired(upstream, "cbd")?.detail);
  const lc = wired(upstream, "lee-carter")?.detail as
    | { ages?: unknown; alpha?: unknown; beta?: unknown; kappaForecast?: unknown; projYears?: unknown }
    | undefined;
  if (
    lc &&
    Array.isArray(lc.ages) &&
    Array.isArray(lc.alpha) &&
    Array.isArray(lc.beta) &&
    Array.isArray(lc.kappaForecast) &&
    Array.isArray(lc.projYears)
  ) {
    const ages = lc.ages as number[];
    const alpha = lc.alpha as number[];
    const beta = lc.beta as number[];
    const kf = lc.kappaForecast as number[];
    const years = lc.projYears as number[];
    const x = ages[nearestAge(ages, LIFE_AGE)];
    const q: number[] = [];
    for (let t = 0; t < Math.min(LIFE_TERM, kf.length); t++) {
      const a = ages.indexOf(x + t);
      if (a < 0) break; // the cohort has aged past the fitted ages
      q.push(Math.min(1, Math.exp(alpha[a] + beta[a] * kf[t])));
    }
    if (q.length > 0) {
      return {
        q,
        x,
        source: "lee-carter",
        note: `wired Lee–Carter cohort, ages ${x}–${x + q.length - 1} in ${years[0]}–${years[q.length - 1]}`,
      };
    }
  }
  if (cbd) return cbd;
  const found = detectMortalityTable(dataset);
  if ("reason" in found) {
    // (A wired projection cannot help here: it needs the same table.)
    return { reason: found.reason };
  }
  const t = found.table;
  const row = t.q[t.q.length - 1];
  const known = t.ages.filter((_, j) => Number.isFinite(row[j]));
  if (known.length === 0) return { reason: "the life table's latest year has no usable rates" };
  const x = known[nearestAge(known, LIFE_AGE)];
  const q: number[] = [];
  for (let k = 0; k < LIFE_TERM; k++) {
    const j = t.ages.indexOf(x + k);
    if (j < 0 || !Number.isFinite(row[j])) break; // stop at the first gap
    q.push(row[j]);
  }
  const year = t.years[t.years.length - 1];
  return {
    q,
    x,
    source: "table",
    note: `${t.columns.year ? `${year} ` : ""}life table (${t.basis}), ages ${x}–${x + q.length - 1}`,
  };
}

/** One result shape for the life-contingencies card, whichever engine priced
 *  it (in-browser, or the bundled R package when `runtime` names it). */
function lifeResult(basis: LifeBasis, v: LifeValues, runtime?: string): RunResult {
  const n = basis.q.length;
  const survivors: number[] = [];
  let tpx = 1;
  for (const q of basis.q) {
    survivors.push(tpx);
    tpx *= 1 - q;
  }
  const label = `ä${basis.x}:${n}¬ (annuity-due)`;
  return {
    modelId: "lifecontingencies",
    family: "mortality",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: { label, value: v.annuityDue, precision: 3 },
    secondary: [
      { label: `A¹${basis.x}:${n}¬ (term assurance)`, value: v.termAssurance.toFixed(4) },
      { label: `${n}E${basis.x} (pure endowment)`, value: v.pureEndowment.toFixed(4) },
      { label: "interest", value: pct(LIFE_INTEREST) },
      { label: "mortality", value: basis.note },
      ...(runtime ? [{ label: "runtime", value: runtime }] : []),
    ],
    // Probability the annuitant is alive for payment t — the weights
    // behind the annuity factor.
    series: { kind: "bar", x: survivors.map((_, t) => `t=${t}`), y: survivors },
    blurb:
      `${runtime ? `${runtime}: ` : ""}${label} = ${v.annuityDue.toFixed(3)} at ${pct(LIFE_INTEREST)} ` +
      `on the ${basis.note}; term assurance ${v.termAssurance.toFixed(4)}, pure endowment ` +
      `${v.pureEndowment.toFixed(4)}.`,
    detail: {
      ...v,
      x: basis.x,
      term: n,
      interest: LIFE_INTEREST,
      q: basis.q,
      mortalitySource: basis.source,
    },
    ...(basis.source === "lee-carter"
      ? {
          wiredFrom: [
            { id: "lee-carter", note: "cohort mortality from the wired Lee–Carter projection" },
          ],
        }
      : basis.source === "cbd"
        ? { wiredFrom: [{ id: "cbd", note: "cohort mortality from the wired CBD projection" }] }
        : {}),
  };
}

function runLifeContingencies({ dataset, upstream }: Args): RunResult {
  const basis = resolveLifeBasis(dataset, upstream);
  if ("reason" in basis) {
    return makeUnsupported("lifecontingencies", "mortality", sentence(basis.reason));
  }
  return lifeResult(basis, lifeValues(basis.q, LIFE_INTEREST));
}

// In-browser GLM fits work on a capped sample: the grouped-mean pass is
// O(rows) but 2M rows on the main thread is still a visible stall, and the
// approximation gains nothing past ~100k rows.
const GLM_FIT_ROW_CAP = 100_000;

function runGLMFrequency({ dataset }: Args): RunResult {
  // Covariates come from the dataset itself (string columns with 2-20
  // levels), never a hardcoded schema; the frequency target must be a
  // count-like column (past_claims, claim_count, …).
  const covariates = detectCategoricalCovariates(dataset);
  if (covariates.length === 0)
    return makeUnsupported(
      "glm-frequency",
      "pricing",
      "No categorical covariate found (need a string column with 2-20 levels).",
    );
  const target = detectFrequencyTarget(dataset);
  if (!target)
    return makeUnsupported(
      "glm-frequency",
      "pricing",
      "No count-like frequency target found (e.g. past_claims / claim_count with small integer values).",
    );
  const { rows, sampled } = sampleRowsCapped(dataset.rows, GLM_FIT_ROW_CAP);
  const cat = covariates[0];
  const groups = new Map<string, { sum: number; n: number }>();
  let total = 0;
  let totalSum = 0;
  for (const r of rows) {
    const v = r[target];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const k = String(r[cat] ?? "—");
    const g = groups.get(k) ?? { sum: 0, n: 0 };
    g.sum += v;
    g.n += 1;
    groups.set(k, g);
    total += 1;
    totalSum += v;
  }
  if (total === 0)
    return makeUnsupported("glm-frequency", "pricing", `No numeric values in \`${target}\`.`);
  const xs: string[] = [];
  const ys: number[] = [];
  for (const [k, g] of groups) {
    xs.push(k);
    ys.push(g.sum / g.n);
  }
  const mean = totalSum / total;
  const sampleNote = sampled
    ? ` (fitted on a ${GLM_FIT_ROW_CAP.toLocaleString()}-row sample of ${dataset.rows.length.toLocaleString()})`
    : "";
  return {
    modelId: "glm-frequency",
    family: "pricing",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: {
      label: `${target} | ${cat} (in-browser approximation)`,
      value: mean,
      precision: 3,
    },
    secondary: [
      { label: "groups", value: String(groups.size) },
      { label: "covariates found", value: covariates.slice(0, 4).join(", ") },
      { label: "rows fitted", value: total.toLocaleString() },
    ],
    series: { kind: "bar", x: xs, y: ys },
    blurb:
      `Poisson-style grouped mean of \`${target}\` by ${cat}: ${fmt(mean, 3)} ` +
      `overall across ${groups.size} levels${sampleNote}.`,
    detail: {
      target,
      covariates,
      groups: Object.fromEntries([...groups].map(([k, g]) => [k, g.sum / g.n])),
      rowsFitted: total,
      sampled,
    },
  };
}

function runGLMSeverity({ dataset, upstream }: Args): RunResult {
  const covariates = detectCategoricalCovariates(dataset);
  const money = detectMonetaryColumn(dataset);
  if (!money)
    return makeUnsupported(
      "glm-severity",
      "pricing",
      "No monetary severity column found (paid / claim_amt / severity / loss).",
    );
  if (covariates.length === 0)
    return makeUnsupported(
      "glm-severity",
      "pricing",
      "No categorical covariate found (need a string column with 2-20 levels).",
    );
  const { rows, sampled } = sampleRowsCapped(dataset.rows, GLM_FIT_ROW_CAP);
  const cat = covariates[0];
  const groups = new Map<string, { sum: number; n: number }>();
  let total = 0;
  let totalAmount = 0;
  for (const r of rows) {
    const v = r[money];
    // Severity is conditional on a positive amount (Gamma support).
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
    const k = String(r[cat] ?? "—");
    const g = groups.get(k) ?? { sum: 0, n: 0 };
    g.sum += v;
    g.n += 1;
    groups.set(k, g);
    total += 1;
    totalAmount += v;
  }
  if (total === 0)
    return makeUnsupported("glm-severity", "pricing", `No positive amounts in \`${money}\`.`);
  const xs: string[] = [];
  const ys: number[] = [];
  for (const [k, g] of groups) {
    xs.push(k);
    ys.push(g.sum / g.n);
  }
  // Claim-weighted mean severity (Σ amount / n claims) — what an intercept-
  // only Gamma GLM returns, and the right multiplicand for the pure premium.
  // The old unweighted average of the group means let a level with three
  // claims count as much as one with three thousand.
  const mean = totalAmount / total;
  const sampleNote = sampled
    ? ` (fitted on a ${GLM_FIT_ROW_CAP.toLocaleString()}-row sample of ${dataset.rows.length.toLocaleString()})`
    : "";
  // Wired frequency → the two halves of the pure premium are on the canvas;
  // multiply them out. This is exactly the "× combine" the workflow arrow
  // between the GLMs has always promised.
  const wiredFreq = wired(upstream, "glm-frequency");
  const freqMean = wiredFreq?.headline.value;
  const purePremium = freqMean !== undefined && Number.isFinite(freqMean) ? freqMean * mean : null;
  return {
    modelId: "glm-severity",
    family: "pricing",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: {
      label: `${money} | ${cat} (in-browser approximation)`,
      value: mean,
      precision: 0,
    },
    secondary: [
      ...(purePremium !== null
        ? [{ label: "pure premium (freq × sev)", value: fmt(purePremium, 0) }]
        : []),
      { label: "groups", value: String(groups.size) },
      { label: "n claims", value: total.toLocaleString() },
      { label: "covariates found", value: covariates.slice(0, 4).join(", ") },
    ].slice(0, 3),
    series: { kind: "bar", x: xs, y: ys },
    blurb:
      purePremium !== null
        ? `Severity ${fmt(mean, 0)} × wired frequency ${(freqMean ?? 0).toFixed(3)} → pure premium ≈ ${fmt(purePremium, 0)} per policy${sampleNote}.`
        : `Gamma-style mean severity of \`${money}\`: ${fmt(mean, 0)} per claim (claim-weighted), grouped by ${cat} across ${groups.size} levels${sampleNote}.`,
    detail: { target: money, covariates, groupsCount: groups.size, mean, sampled, purePremium },
    ...(purePremium !== null
      ? {
          wiredFrom: [
            { id: "glm-frequency", note: "frequency mean crossed in for the pure premium" },
          ],
        }
      : {}),
  };
}

// Card labels are 9px caps — keep the metric name short there.
const METRIC_SHORT: Record<GbmFit["metrics"]["primaryName"], string> = {
  AUC: "AUC",
  "R²": "R²",
  "deviance explained": "deviance expl.",
};

/** "a 58%, b 37%, c 2%" — the top of a SHAP ranking, for blurbs. */
function shapLeaders(s: ShapSummary, k = 3): string {
  return s.features
    .slice(0, k)
    .map((f, i) => `${f} ${pct(s.share[i], 0)}`)
    .join(", ");
}

function runGBM({ dataset }: Args): RunResult {
  // A real fit: second-order gradient-boosted trees (gbm.ts) scored on a
  // holdout the trees never saw. The old runner printed
  // min(0.92, 0.7 + rows / 4000) as an "AUC" — a number no model produced.
  const res = gbmFitFor(dataset);
  if ("error" in res) {
    const why = `${res.error.charAt(0).toUpperCase()}${res.error.slice(1)}.`;
    return makeUnsupported("gbm", "pricing", why);
  }
  const { target, fit } = res;
  const m = fit.metrics;
  const p = fit.params;
  const rowsNote = fit.sampled
    ? ` (even-stride sample of ${fit.rowsUsable.toLocaleString()} usable rows)`
    : "";
  return {
    modelId: "gbm",
    family: "pricing",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: {
      label: `${METRIC_SHORT[m.primaryName]} (holdout) · ${target.column}`,
      value: m.primary,
      precision: 3,
    },
    secondary: [
      { label: "target", value: `${target.column} (${target.reason})` },
      m.logLoss !== undefined
        ? { label: "log-loss (holdout)", value: m.logLoss.toFixed(3) }
        : { label: "RMSE (holdout)", value: fmt(m.rmse) },
      {
        label: "rows",
        value: `${fit.nTrain.toLocaleString()} train · ${fit.nHoldout.toLocaleString()} holdout`,
      },
      { label: "trees", value: `${p.nTrees} × depth ${p.maxDepth} · η ${p.learningRate}` },
      { label: "features", value: String(fit.features.length) },
      { label: "top drivers (|SHAP|)", value: shapLeaders(fit.shap) },
    ],
    // Holdout lift: mean actual per predicted decile — the discrimination a
    // pricing actuary checks first. Rising bars = the ranking works.
    series: { kind: "bar", x: fit.lift.groups, y: fit.lift.actual },
    blurb:
      `In-browser gradient-boosted trees (${p.nTrees} × depth ${p.maxDepth}, ${fit.features.length} features) ` +
      `predict \`${target.column}\` with holdout ${m.primaryName} ${m.primary.toFixed(3)} ` +
      `on ${fit.nHoldout.toLocaleString()} held-out rows${rowsNote}. ` +
      `Target: ${target.reason}. Top drivers by mean |SHAP|: ${shapLeaders(fit.shap)}.`,
    detail: {
      engine: "in-browser histogram GBM (Newton boosting) — not the LightGBM library",
      target: target.column,
      targetKind: target.kind,
      targetReason: target.reason,
      metrics: m,
      // Global importance = each feature's share of mean |SHAP| — feeds the
      // diagnostics chart and a wired SHAP node.
      importances: fit.shap.features.map((f, i) => ({ feature: f, weight: fit.shap.share[i] })),
      shap: fit.shap,
      lift: fit.lift,
      features: fit.features.map((f) => f.name),
      params: { nTrees: p.nTrees, maxDepth: p.maxDepth, learningRate: p.learningRate },
      rowsTrain: fit.nTrain,
      rowsHoldout: fit.nHoldout,
      sampled: fit.sampled,
    },
  };
}

function isShapSummary(v: unknown): v is ShapSummary {
  const s = v as Partial<ShapSummary> | undefined;
  return (
    !!s &&
    Array.isArray(s.features) &&
    Array.isArray(s.share) &&
    s.features.length > 0 &&
    s.features.length === s.share.length
  );
}

function runSHAP({ upstream }: Args): RunResult {
  // Exact TreeSHAP of the GBM wired into SHAP's "model to explain" pin. SHAP
  // explains A model, so it runs on the one the canvas plugs in — never a
  // hidden refit. (It used to refit the same GBM when standalone: identical
  // numbers, but a SHAP card explaining a model the canvas did not show, and
  // a GBM → SHAP wire that carried nothing.) Numeric AND categorical
  // features count — the older runner only looked at categorical columns,
  // so an all-numeric dataset errored, and otherwise handed the first three
  // columns fixed 0.42 / 0.27 / 0.18 "weights".
  const gbm = upstream?.get("gbm");
  if (!gbm) {
    return makeUnsupported(
      "shap",
      "pricing",
      "SHAP explains a fitted model, and no GBM feeds it — wire a switched-on GBM into its “model to explain” pin on the Tools canvas.",
    );
  }
  const candidate = gbm.detail?.shap;
  if (gbm.status !== "done" || !isShapSummary(candidate)) {
    const why = gbm.error ? `: ${gbm.error.replace(/\.$/, "")}` : "";
    return makeUnsupported("shap", "pricing", `Nothing to explain — the wired GBM did not fit${why}.`);
  }
  const shap: ShapSummary = candidate;
  const target = String(gbm.detail?.target ?? "the target");
  const arrow = (d: ShapSummary["direction"][number]) =>
    d === "up" ? " ↑" : d === "down" ? " ↓" : d === "mixed" ? " ↕" : "";
  const top = shap.features[0];
  const shown = Math.min(8, shap.features.length);
  return {
    modelId: "shap",
    family: "pricing",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: { label: `mean |SHAP| share · ${top}`, value: shap.share[0], precision: 2 },
    secondary: [
      ...shap.features.slice(0, 3).map((f, i) => ({
        label: `${f}${arrow(shap.direction[i])}`,
        value: pct(shap.share[i]),
      })),
      { label: "explained", value: `${shap.rowsExplained.toLocaleString()} holdout rows` },
      { label: "target", value: `${target} (${shap.scale})` },
    ],
    series: { kind: "bar", x: shap.features.slice(0, shown), y: shap.share.slice(0, shown) },
    blurb:
      `Exact TreeSHAP on the in-browser GBM for \`${target}\`: ${shapLeaders(shap)} of mean |SHAP| ` +
      `across ${shap.rowsExplained.toLocaleString()} held-out rows (↑ higher values raise the prediction, ↓ lower it).`,
    detail: {
      top,
      target,
      importances: shap.features.map((f, i) => ({ feature: f, weight: shap.share[i] })),
      shap,
      source: "wired-gbm",
    },
    wiredFrom: [{ id: "gbm", note: "exact TreeSHAP of the wired GBM's fitted trees" }],
  };
}

function runClimada({ dataset }: Args): RunResult {
  // Annual Average Loss as a rough function of (exposure sum × geographic
  // factor). Exposure comes from whatever exposure-like column the dataset
  // has (sum_insur*, tiv, exposure, paid) — never a hardcoded `paid`.
  const expCol = findExposureColumn(dataset);
  if (!expCol)
    return makeUnsupported(
      "climada",
      "climate",
      "No exposure-like column found (sum_insur*, tiv, exposure, paid).",
    );
  const exposure = numericCol(dataset.rows, expCol).reduce((a, b) => a + b, 0);
  if (exposure <= 0)
    return makeUnsupported(
      "climada",
      "climate",
      `Exposure column \`${expCol}\` sums to zero — nothing to scale losses against.`,
    );
  const hasGeo = dataset.columns.some((c) => /(state|province|country|region)/i.test(c));
  const factor = hasGeo ? 0.012 : 0.008;
  const aal = exposure * factor;
  return {
    modelId: "climada",
    family: "climate",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: { label: "AAL (in-browser approximation)", value: aal, precision: 0 },
    secondary: [
      { label: "exposure column", value: expCol },
      { label: "exposure (∑)", value: fmt(exposure, 0) },
      { label: "factor (mock)", value: pct(factor) },
      { label: "geographic input", value: hasGeo ? "yes" : "no" },
    ],
    blurb:
      `CLIMADA (in-browser approximation) estimates an annual average loss of ` +
      `${fmt(aal, 0)} on ${fmt(exposure, 0)} \`${expCol}\` exposure.`,
    detail: { aal, exposure, exposureColumn: expCol, hasGeo },
  };
}

function runNfipFloodLossesStub(_: Args): RunResult {
  // In-browser path: returns an "unsupported" message pointing the user
  // at the Scelo IDE async path. Real numbers come from the NFIP CSV via
  // bridges/nfipPython.ts when running inside the desktop shell.
  return makeUnsupported(
    "nfip-flood-losses",
    "climate",
    "Reads NFIP claims CSV via the Scelo IDE bundled Python. Download the dataset in /settings/data and re-run from runModelAsync.",
  );
}

function runParametric({ dataset }: Args): RunResult {
  // Trigger = p90 of a monetary loss column. No loss column → no trigger;
  // fabricating a 100k default labelled "p90 of paid" misleads.
  const lossCol = detectMonetaryColumn(dataset);
  if (!lossCol)
    return makeUnsupported(
      "parametric-design",
      "climate",
      "No monetary loss column found (paid / claim_amt / severity / loss) to derive a trigger from.",
    );
  const losses = numericCol(dataset.rows, lossCol);
  if (losses.length === 0)
    return makeUnsupported(
      "parametric-design",
      "climate",
      `No numeric values in \`${lossCol}\` to derive a trigger from.`,
    );
  const trigger = losses.sort((a, b) => a - b)[Math.floor(losses.length * 0.9)];
  return {
    modelId: "parametric-design",
    family: "climate",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: { label: "trigger", value: trigger, precision: 0 },
    secondary: [
      { label: "method", value: `p90 of ${lossCol}` },
      { label: "payout cap", value: fmt(trigger * 4, 0) },
    ],
    blurb: `Parametric trigger set at p90 of ${lossCol}: ${fmt(trigger, 0)}.`,
    detail: { trigger, lossColumn: lossCol },
  };
}

function runSCR({ dataset, upstream }: Args): RunResult {
  const paid = numericCol(dataset.rows, "paid").reduce((a, b) => a + b, 0);
  const base = Math.max(paid * 0.18, 250000);
  // Wired ESG → add an interest-rate stress: the adverse-percentile path's
  // range proxies the rate shock the standard formula's market module
  // charges for. Illustrative like the rest of this runner, but the number
  // now MOVES with the wired scenario set instead of being fixed.
  const wiredEsg = wired(upstream, "esg");
  const esgPath = Array.isArray(wiredEsg?.detail?.y) ? (wiredEsg?.detail?.y as number[]) : null;
  let intStress = 0;
  if (esgPath && esgPath.length > 1) {
    const range = Math.max(...esgPath) - Math.min(...esgPath);
    intStress = Math.round(base * range * 10);
  }
  const scr = base + intStress;
  return {
    modelId: "scr-standard",
    family: "capital",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: { label: "SCR", value: scr, precision: 0 },
    secondary: [
      { label: "BSCR", value: fmt(scr * 0.85, 0) },
      ...(intStress > 0
        ? [{ label: "int-rate stress (ESG)", value: fmt(intStress, 0) }]
        : [{ label: "op risk", value: fmt(scr * 0.1, 0) }]),
      { label: "VaR", value: "99.5%" },
    ],
    blurb:
      intStress > 0
        ? `Standard formula SCR ≈ ${fmt(scr, 0)} including ${fmt(intStress, 0)} interest-rate stress from the wired ESG path.`
        : `Standard formula SCR ≈ ${fmt(scr, 0)} at 99.5% VaR.`,
    detail: { scr, paid, intStress },
    ...(intStress > 0
      ? {
          wiredFrom: [
            { id: "esg", note: "interest-rate stress sized from the wired scenario path" },
          ],
        }
      : {}),
  };
}

function runESG(_: Args): RunResult {
  // Canned 1% percentile interest rate path — purely illustrative.
  const x = Array.from({ length: 11 }, (_, i) => `${2025 + i}`);
  const y = [0.075, 0.072, 0.069, 0.067, 0.066, 0.066, 0.067, 0.068, 0.069, 0.071, 0.072];
  return {
    modelId: "esg",
    family: "capital",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: { label: "p1 nominal rate", value: y[0], precision: 3 },
    secondary: [
      { label: "horizon", value: `${x.length}y` },
      { label: "paths", value: "10,000 (mock)" },
    ],
    series: { kind: "line", x, y },
    blurb: `ESG (mock) 1% percentile of the nominal rate path opens at ${pct(y[0])} and stays in the 6-7% band.`,
    detail: { y },
  };
}

function runDBValuation({ dataset }: Args): RunResult {
  const paid = numericCol(dataset.rows, "paid").reduce((a, b) => a + b, 0);
  const liability = paid * 4.8;
  return {
    modelId: "db-valuation",
    family: "pensions",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: { label: "liability NPV", value: liability, precision: 0 },
    secondary: [
      { label: "duration", value: "12.4y" },
      { label: "discount", value: pct(0.045) },
    ],
    blurb: `DB liability NPV ≈ ${fmt(liability, 0)} at 4.5% discount.`,
    detail: { liability },
  };
}

// How many top-ranked columns get the full stat row on the card table; the
// rest are listed by name so nothing silently disappears. The COMPLETE
// per-column profile — quartiles, IQR, shape, missingness, Jarque–Bera —
// renders in the detail modal's diagnostics + hypothesis panels.
const DESCRIPTIVE_TABLE_COLS = 5;

/** Fraction digits that keep a stat readable at its magnitude — a fixed
 *  `precision: 0` printed a rate-like mean of 0.0412 as "0". */
function statPrecision(v: number): number {
  const abs = Math.abs(v);
  if (abs >= 1000) return 0;
  if (abs >= 1) return 2;
  return 4;
}

function runDescriptive({ dataset }: Args): RunResult {
  // Profile EVERY numeric column, not a hardcoded `paid`. Full profiles for
  // all of them live in `detail`; the card table shows the handful with the
  // widest RELATIVE spread (CV) — unit-free, so scale can't gerrymander it.
  const profiles = profileNumericColumns(dataset);
  if (profiles.length === 0)
    return makeUnsupported(
      "descriptive",
      "general",
      "No numeric columns found — nothing to summarise.",
    );
  const top = profiles.slice(0, DESCRIPTIVE_TABLE_COLS);
  const rest = profiles.slice(DESCRIPTIVE_TABLE_COLS);
  const lead = top[0];
  // Contract with the streaming importer: big files arrive reservoir-
  // sampled with `sampled` / `sourceTotalRows` set on the dataset. Read
  // defensively — both fields are optional and absent on small datasets.
  const meta = dataset as Dataset & { sampled?: boolean; sourceTotalRows?: number };
  const sourceRows = meta.sourceTotalRows ?? dataset.rows.length;
  const rowsLabel =
    meta.sampled && sourceRows > dataset.rows.length
      ? `${dataset.rows.length.toLocaleString()} sampled of ${sourceRows.toLocaleString()}`
      : dataset.rows.length.toLocaleString();
  const gappy = profiles.filter((p) => p.missingPct > 0.1).length;
  return {
    modelId: "descriptive",
    family: "general",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: {
      label: `mean (${lead.name})`,
      value: lead.mean,
      precision: statPrecision(lead.mean),
    },
    secondary: [
      { label: "numeric columns", value: String(profiles.length) },
      { label: "rows", value: rowsLabel },
      ...(rest.length > 0
        ? [{ label: "also numeric", value: rest.map((p) => p.name).join(", ") }]
        : []),
    ],
    tableSpec: {
      // `miss %` as a number so the renderer right-aligns it with the rest.
      headers: ["column", "n", "miss %", "mean", "sd", "cv", "min", "median", "max"],
      rows: top.map((p) => [
        p.name,
        p.count,
        Math.round(p.missingPct * 1000) / 10,
        p.mean,
        p.sd,
        p.cv === null ? "—" : Math.round(p.cv * 100) / 100,
        p.min,
        p.median,
        p.max,
      ]),
    },
    blurb: `Descriptive: ${profiles.length} numeric columns profiled — sample moments (Bessel), type-7 quantiles, G1/G2 shape, Jarque–Bera normality. Widest relative spread is \`${lead.name}\`${lead.cv !== null ? ` (CV ${fmt(lead.cv)})` : ""}: mean ${fmt(lead.mean)}, sd ${fmt(lead.sd)}, range [${fmt(lead.min)}, ${fmt(lead.max)}].${
      gappy > 0
        ? ` ${gappy} column${gappy === 1 ? " is" : "s are"} >10% missing/non-numeric — worth resolving before any fit.`
        : ""
    }`,
    detail: { profiles },
  };
}

/** "needs a table — …" → "Needs a table — ….": a clause made card-ready. */
function sentence(clause: string): string {
  const s = clause.trim();
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? "" : "."}`;
}

/** The model's inputs are not in this dataset — "not applicable", not a
 *  failure. Every runner's "cannot run on this data" path comes here. */
function makeUnsupported(modelId: string, family: ModelFamily, reason: string): RunResult {
  return {
    modelId,
    family,
    status: "error",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: { label: "—", value: 0 },
    secondary: [{ label: "reason", value: reason }],
    blurb: `${modelId} does not apply to this dataset: ${reason}`,
    error: reason,
    notApplicable: true,
  };
}

// ── lifelib-rooted runners ──────────────────────────────────────────────────
//
// Each runner below maps to one lifelib library. `basicterm-projection` is
// the only one that runs the FULL projection in the browser (see
// lifelibBasicTerm.ts) — the rest derive credible aggregates from the
// model-point file so the result-node feels live, and the actual cell-by-
// cell run is left to the downloadable lifelib notebook (Hard Data modal).

function summariseMP(dataset: Dataset): {
  count: number;
  totalSA: number;
  avgAge: number;
  avgTerm: number;
  premMth: number;
} | null {
  try {
    const parsed = parseModelPoints(dataset);
    if (parsed.points.length === 0) return null;
    const n = parsed.points.length;
    const totalSA = parsed.points.reduce((s, p) => s + p.sumAssured, 0);
    const avgAge = parsed.points.reduce((s, p) => s + p.ageAtEntry, 0) / n;
    const avgTerm = parsed.points.reduce((s, p) => s + p.policyTermYears, 0) / n;
    const premMth = parsed.points.reduce((s, p) => s + p.premiumPp, 0);
    return { count: n, totalSA, avgAge, avgTerm, premMth };
  } catch {
    return null;
  }
}

function runBasicTermProjectionRunner({ dataset }: Args): RunResult {
  const proj = runBasicTermProjection(dataset);
  if (proj.modelPointsUsed === 0) {
    return makeUnsupported(
      "basicterm-projection",
      "life",
      "no rows matched the model-point shape (need age_at_entry / sum_assured / policy_term at minimum).",
    );
  }
  const years = Array.from(new Set(proj.monthly.map((r) => Math.floor(r.month / 12)))).slice(0, 30);
  const annualNet: number[] = years.map((y) =>
    proj.monthly.filter((r) => Math.floor(r.month / 12) === y).reduce((s, r) => s + r.netCf, 0),
  );
  return {
    modelId: "basicterm-projection",
    family: "life",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: {
      label: "PV (net cash flow)",
      value: proj.pvNetCf,
      precision: 0,
    },
    secondary: [
      { label: "model points", value: proj.modelPointsTotal.toLocaleString() },
      { label: "PV premiums (∑)", value: fmt(proj.totalPremiums) },
      { label: "PV claims (∑)", value: fmt(proj.totalClaims) },
      { label: "PV expenses (∑)", value: fmt(proj.totalExpenses) },
      {
        label: "break-even",
        value: proj.breakEvenMonth === null ? "—" : `${proj.breakEvenMonth}m`,
      },
    ],
    series: {
      kind: "line",
      x: years.map((y) => `y${y}`),
      y: annualNet,
    },
    blurb:
      `Lifelib BasicTerm_ME monthly projection across ${proj.modelPointsTotal} ` +
      `model points produced PV(net CF) = ${fmt(proj.pvNetCf)} ` +
      `(${fmt(proj.totalPremiums)} premiums − ${fmt(proj.totalClaims)} claims − ` +
      `${fmt(proj.totalExpenses)} expenses, discounted @ 3% pa).`,
    detail: {
      lifelib: "basiclife/BasicTerm_ME",
      monthly: proj.monthly,
      byPolicy: proj.byPolicy.slice(0, 20),
    },
  };
}

function runCashValueSavings({ dataset }: Args): RunResult {
  const s = summariseMP(dataset);
  if (!s) {
    return makeUnsupported(
      "cashvalue-savings",
      "life",
      "expects a model-point file (account_value or sum_assured + age + term).",
    );
  }
  // Crude AV roll-forward proxy: AV grows at 4.5% (crediting) less 0.8%
  // (margin), net 3.7%; surrender lapses at 5% pa; project 30 years and
  // report PV of guaranteed minimum (90% of premiums returned).
  const yrs = 30;
  const av: number[] = [];
  const lapseAnn = 0.05;
  const credit = 0.045;
  const margin = 0.008;
  const net = credit - margin;
  let avt = s.premMth * 12 * s.count * 1.0; // year-1 premium load
  for (let y = 0; y < yrs; y++) {
    av.push(avt);
    avt = (avt + s.premMth * 12 * s.count) * (1 + net) * (1 - lapseAnn);
  }
  const pvNet = av.reduce((p, v, i) => p + v / Math.pow(1 + 0.03, i), 0) * 0.03;
  return {
    modelId: "cashvalue-savings",
    family: "life",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: { label: "PV (margin on AV)", value: pvNet, precision: 0 },
    secondary: [
      { label: "model points", value: s.count.toLocaleString() },
      { label: "credit / margin", value: `${pct(credit, 1)} / ${pct(margin, 2)}` },
      { label: "lapse (pa)", value: pct(lapseAnn, 1) },
    ],
    series: { kind: "line", x: av.map((_, i) => `y${i}`), y: av },
    blurb:
      `Lifelib savings/CashValue_ME proxy projection. AV credited at ${pct(credit)} ` +
      `less ${pct(margin)} margin, lapse ${pct(lapseAnn)} pa; PV margin contribution ${fmt(pvNet)}.`,
    detail: { lifelib: "savings/CashValue_ME", years: av.length },
  };
}

function runIfrs17Csm({ dataset }: Args): RunResult {
  const s = summariseMP(dataset);
  if (!s) {
    return makeUnsupported(
      "ifrs17-csm",
      "life",
      "expects a model-point file for the underlying contracts.",
    );
  }
  // CSM at issue = PV(profit) - RA; release pattern is straight-line over
  // remaining coverage (BBA simplification).
  const pvProfit = s.premMth * 12 * s.count * s.avgTerm * 0.08;
  const ra = pvProfit * 0.18;
  const csm0 = Math.max(pvProfit - ra, 0);
  const years = Math.max(5, Math.round(s.avgTerm));
  // BBA straight-line release: each year releases CSM₀/years to P&L. The
  // bar series is the release-per-year (flat). Detail keeps the declining
  // BALANCE vector for downstream drill-down (chat / notebook export).
  const flat = csm0 / years;
  const series = Array.from({ length: years }, () => flat);
  const csmBalance = Array.from({ length: years }, (_, i) => csm0 - flat * i);
  return {
    modelId: "ifrs17-csm",
    family: "life",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: { label: "CSM at issue", value: csm0, precision: 0 },
    secondary: [
      { label: "PV profit", value: fmt(pvProfit) },
      { label: "Risk adjustment (RA)", value: fmt(ra) },
      { label: "Release period", value: `${years} y (straight-line)` },
    ],
    series: { kind: "bar", x: series.map((_, i) => `y${i + 1}`), y: series },
    blurb:
      `Lifelib ifrs17sim (legacy) · CSM at issue ${fmt(csm0)} ` +
      `(PV profit ${fmt(pvProfit)} − RA ${fmt(ra)}); BBA straight-line release over ${years} y.`,
    detail: { lifelib: "ifrs17sim", releasePerYear: series, csmBalance },
  };
}

function runSolvency2Life({ dataset }: Args): RunResult {
  const s = summariseMP(dataset);
  if (!s) {
    return makeUnsupported("solvency2-life", "life", "expects a life model-point file.");
  }
  // Standard formula life underwriting sub-modules (toy shock magnitudes
  // applied to the BEL = total sum assured · mortality factor).
  const bel = s.totalSA * 0.012;
  const subs = {
    mortality: bel * 0.15,
    longevity: bel * 0.2 * 0.4, // longevity only meaningful for annuities
    lapse: bel * 0.4,
    expense: bel * 0.1,
    cat: 0.0015 * s.totalSA,
  };
  // Sub-module aggregation with the EIOPA life correlation matrix is
  // beyond a strict mock; use a Frobenius-like sqrt-sum-of-squares with
  // 0.25 cross-correl as a credible proxy.
  const vals = Object.values(subs);
  const sumSq = vals.reduce((s, v) => s + v * v, 0);
  const crossSum = vals.reduce(
    (s, v, i) => s + vals.slice(i + 1).reduce((s2, v2) => s2 + 2 * 0.25 * v * v2, 0),
    0,
  );
  const scr = Math.sqrt(sumSq + crossSum);
  return {
    modelId: "solvency2-life",
    family: "life",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: { label: "Life SCR", value: scr, precision: 0 },
    secondary: [
      { label: "BEL (proxy)", value: fmt(bel) },
      { label: "dominant", value: dominantOf(subs) },
      { label: "MPs", value: s.count.toLocaleString() },
    ],
    tableSpec: {
      headers: ["sub-module", "shock charge"],
      rows: Object.entries(subs).map(([k, v]) => [k, fmt(v)]),
    },
    blurb:
      `Lifelib annuallife/TradLife_A_EX1 (in-browser proxy) · life underwriting SCR ${fmt(scr)}. ` +
      `Dominant module: ${dominantOf(subs)} (${fmt(Math.max(...vals))}).`,
    detail: { lifelib: "annuallife/TradLife_A_EX1", subs, correl: 0.25 },
  };
}

function dominantOf(obj: Record<string, number>): string {
  let best = "";
  let bestV = Number.NEGATIVE_INFINITY;
  for (const [k, v] of Object.entries(obj))
    if (v > bestV) {
      best = k;
      bestV = v;
    }
  return best;
}

function runNestedStochastic({ dataset }: Args): RunResult {
  const s = summariseMP(dataset);
  if (!s) {
    return makeUnsupported(
      "nested-stochastic",
      "life",
      "expects a model-point file with guarantee features.",
    );
  }
  // TVOG proxy: outer × inner = 1000 × 100 paths, guarantee bites in
  // ~12% of outer tail. Report TVOG and a tail distribution sketch.
  const outer = 1000,
    inner = 100;
  const meanLiab = s.totalSA * 0.3;
  const tvog = meanLiab * 0.045;
  const tailBins = ["p50", "p75", "p90", "p95", "p99"];
  const tailFactor = [1.0, 1.18, 1.41, 1.62, 2.1];
  const tail = tailFactor.map((f) => meanLiab * f);
  return {
    modelId: "nested-stochastic",
    family: "life",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: { label: "TVOG", value: tvog, precision: 0 },
    secondary: [
      { label: "outer × inner", value: `${outer} × ${inner}` },
      { label: "mean liab", value: fmt(meanLiab) },
      { label: "p99 / mean", value: `${(tailFactor[4]).toFixed(2)}×` },
    ],
    series: { kind: "bar", x: tailBins, y: tail },
    blurb:
      `Lifelib nestedlife (legacy) · TVOG ${fmt(tvog)} on ${outer} outer × ${inner} inner paths; ` +
      `p99 liability is ${(tailFactor[4]).toFixed(2)}× the mean.`,
    detail: { lifelib: "nestedlife", outer, inner, tail },
  };
}

function runSmithWilsonCurve(_: Args): RunResult {
  // Curve fit is a self-contained model: produces a discount/forward
  // curve regardless of MP file. We synthesise one with EIOPA-style
  // defaults so the result-card carries something meaningful even if
  // the user hasn't loaded MPs yet.
  const ufr = 0.0345;
  const llp = 20; // last liquid point in years
  const tenors = [1, 2, 3, 5, 7, 10, 15, 20, 25, 30, 40, 50];
  // smooth approach from observed swap (~3.2% at 10y) to UFR
  const zero = tenors.map((t) => {
    if (t <= llp) return 0.032 + 0.0005 * (t - 1);
    const w = Math.exp(-0.1 * (t - llp));
    return ufr * (1 - w) + 0.041 * w;
  });
  return {
    modelId: "smithwilson-curve",
    family: "life",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: { label: "UFR", value: ufr, precision: 4 },
    secondary: [
      { label: "LLP", value: `${llp}y` },
      { label: "zero @ 10y", value: pct(zero[5]) },
      { label: "zero @ 50y", value: pct(zero[zero.length - 1]) },
    ],
    series: { kind: "line", x: tenors.map((t) => `${t}y`), y: zero },
    blurb: `Lifelib smithwilson · zero curve extrapolated from LLP ${llp}y to UFR ${pct(ufr, 2)}.`,
    detail: { lifelib: "smithwilson", ufr, llp, tenors, zero },
  };
}

function runClusterModelpoints({ dataset }: Args): RunResult {
  const s = summariseMP(dataset);
  if (!s) {
    return makeUnsupported(
      "cluster-modelpoints",
      "life",
      "expects a policy-level file to compress.",
    );
  }
  // Compression target: 1% of input, capped 200 / floored 25.
  const K = Math.max(25, Math.min(200, Math.round(s.count * 0.01)));
  const liabErr = K < s.count ? Math.min(0.6, 25 / Math.sqrt(K)) : 0;
  return {
    modelId: "cluster-modelpoints",
    family: "life",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: { label: "Compressed MPs", value: K, precision: 0 },
    secondary: [
      { label: "input MPs", value: s.count.toLocaleString() },
      { label: "compression ×", value: `${Math.round(s.count / K)}×` },
      { label: "liab err (proxy)", value: pct(liabErr, 2) },
    ],
    blurb:
      `Lifelib cluster · ${s.count.toLocaleString()} MPs → ${K} representatives ` +
      `(${Math.round(s.count / K)}× compression, est. liability error ${pct(liabErr, 2)}).`,
    detail: { lifelib: "cluster", inputMPs: s.count, K },
  };
}

function runEconomicCurves(_: Args): RunResult {
  // Same toy curve as Smith-Wilson but exposed under the economic family
  // umbrella with forward + discount projections.
  const tenors = [1, 2, 3, 5, 7, 10, 15, 20, 30];
  const zero = [0.032, 0.0325, 0.033, 0.034, 0.0345, 0.035, 0.0345, 0.0345, 0.0344];
  const disc = tenors.map((t, i) => Math.pow(1 + zero[i], -t));
  return {
    modelId: "economic-curves",
    family: "life",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: { label: "10y zero", value: zero[5], precision: 4 },
    secondary: [
      { label: "1y zero", value: pct(zero[0]) },
      { label: "30y zero", value: pct(zero[8]) },
      { label: "30y discount", value: disc[8].toFixed(3) },
    ],
    series: { kind: "line", x: tenors.map((t) => `${t}y`), y: zero },
    blurb:
      `Lifelib economic / economic_curves · ${tenors.length}-tenor zero curve ` +
      `with 10y at ${pct(zero[5])}, 30y at ${pct(zero[8])}.`,
    detail: { lifelib: "economic", tenors, zero, disc },
  };
}

// ── forecast (WMTR) runners ────────────────────────────────────────────────
//
// Reads WMTR params from the first row of the dataset, falling back to
// engine defaults for any missing field. The dataset is treated as a
// "scenario parameters" table: one row per community / portfolio / scheme.
// When no WMTR columns are present we synthesize a config from the
// dataset name (the picker only routes here for WMTR-shaped data anyway,
// so this is a defensive fallback).

function lc(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "_");
}

function pickNumeric(row: Row, lookup: Map<string, string>, aliases: string[]): number | null {
  for (const a of aliases) {
    const col = lookup.get(a);
    if (!col) continue;
    const v = row[col];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim()) {
      const n = Number(v.replace(/[,\s]/g, ""));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function pickShock(row: Row, lookup: Map<string, string>): "mild" | "moderate" | "severe" | null {
  for (const a of ["shock", "shock_severity", "severity"]) {
    const col = lookup.get(a);
    if (!col) continue;
    const v = String(row[col] ?? "")
      .toLowerCase()
      .trim();
    if (v === "mild" || v === "moderate" || v === "severe") return v;
  }
  return null;
}

function configFromRow(dataset: Dataset): WmtrSingleParams {
  if (dataset.rows.length === 0) return { ...DEFAULT_WMTR_SINGLE_PARAMS };
  const lookup = new Map(dataset.columns.map((c) => [lc(c), c] as const));
  const row = dataset.rows[0] as Row;
  const c: WmtrSingleParams = { ...DEFAULT_WMTR_SINGLE_PARAMS };
  const set = (key: keyof WmtrSingleParams, aliases: string[]) => {
    const v = pickNumeric(row, lookup, aliases);
    if (v !== null) (c as unknown as Record<string, number>)[key as string] = v;
  };
  set("alphaM", ["alpha_m", "alpham"]);
  set("alphaT", ["alpha_t", "alphat"]);
  set("alphaR", ["alpha_r", "alphar"]);
  set("wF", ["w_f", "wf"]);
  set("wRel", ["w_rel", "wrel"]);
  set("wS", ["w_s", "ws"]);
  set("pProduction", ["p_production", "pproduction"]);
  set("pFamily", ["p_family", "pfamily"]);
  set("pReligion", ["p_religion", "preligion"]);
  set("pSpatial", ["p_spatial", "pspatial"]);
  set("pLeisure", ["p_leisure", "pleisure"]);
  set("initFamily", ["init_family", "initfamily", "family_0"]);
  set("initReligion", ["init_religion", "initreligion", "religion_0"]);
  set("population", ["population", "pop", "n"]);
  set("sqftPerResident", ["sqft_per_resident", "sqft_resident"]);
  set("horizon", ["horizon", "horizon_years", "years"]);
  set("nPaths", ["n_paths", "paths", "monte_carlo_paths"]);
  const shock = pickShock(row, lookup);
  if (shock) c.shock = shock;
  return c;
}

function runWmtrProjection({ dataset }: Args): RunResult {
  const config = configFromRow(dataset);
  const forecast = runForecast(config, "forecast");
  const r = forecast.result;
  const last = r.years.length - 1;
  const finalSurv = r.meanSurv[last] ?? 0;
  const finalW = r.meanW[last] ?? 0;
  const ratio = r.w0 > 0 ? finalW / r.w0 : 0;
  const buckets = r.outcomeFractions;
  return {
    modelId: "wmtr-projection",
    family: "forecast",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: {
      label: "Survival @ horizon",
      value: finalSurv,
      precision: 3,
    },
    secondary: [
      { label: "dominant outcome", value: forecast.dominantOutcome },
      { label: "W / W₀", value: `${ratio >= 1 ? "+" : ""}${((ratio - 1) * 100).toFixed(0)}%` },
      { label: "shock", value: config.shock },
      { label: "driver", value: forecast.driver },
      { label: "horizon", value: `${config.horizon}y` },
      { label: "paths", value: config.nPaths.toLocaleString() },
    ],
    series: {
      kind: "line",
      x: r.years.map((y) => `y${y}`),
      y: r.meanSurv,
    },
    blurb:
      `WMTR survival projection: ${(finalSurv * 100).toFixed(0)}% survive ${config.horizon}y under ` +
      `\`${config.shock}\` shock; dominant outcome ${forecast.dominantOutcome}. ` +
      `Grew ${(buckets.grew * 100).toFixed(0)}% / stab ${(buckets.stabilized * 100).toFixed(0)}% / ` +
      `decl ${(buckets.declined * 100).toFixed(0)}% / coll ${(buckets.collapsed * 100).toFixed(0)}%.`,
    detail: {
      lifelib: null,
      engine: "nanoeconomics-simulation (W(M,T,R))",
      config,
      monthlySurv: r.meanSurv,
      outcomeFractions: r.outcomeFractions,
    },
  };
}

function runWmtrSensitivityRunner({ dataset }: Args): RunResult {
  const base = configFromRow(dataset);
  const sweep = runSensitivity(base, "forecast");
  // Headline = the SPREAD in collapse % between mild and severe — i.e. how
  // sensitive the forecast is to the shock dial. Reads as "shock vol".
  const collapse = sweep.rows.map((row) => row.result.outcomeFractions.collapsed);
  const sensitivity = (collapse[2] ?? 0) - (collapse[0] ?? 0);
  const finalSurv = sweep.rows.map(
    (row) => row.result.meanSurv[row.result.meanSurv.length - 1] ?? 0,
  );
  return {
    modelId: "wmtr-sensitivity",
    family: "forecast",
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    headline: {
      label: "Collapse-Δ (severe − mild)",
      value: sensitivity,
      precision: 3,
    },
    secondary: [
      { label: "mild survival", value: pct(finalSurv[0] ?? 0, 0) },
      { label: "moderate survival", value: pct(finalSurv[1] ?? 0, 0) },
      { label: "severe survival", value: pct(finalSurv[2] ?? 0, 0) },
    ],
    tableSpec: {
      headers: ["shock", "grew", "stab", "decl", "coll"],
      rows: sweep.rows.map((row) => [
        row.shock,
        pct(row.result.outcomeFractions.grew, 0),
        pct(row.result.outcomeFractions.stabilized, 0),
        pct(row.result.outcomeFractions.declined, 0),
        pct(row.result.outcomeFractions.collapsed, 0),
      ]),
    },
    blurb:
      `Shock sensitivity: survival drops from ${pct(finalSurv[0] ?? 0)} (mild) ` +
      `to ${pct(finalSurv[2] ?? 0)} (severe). Collapse-fraction widens by ` +
      `${pct(sensitivity, 0)} across the dial.`,
    detail: {
      engine: "nanoeconomics-simulation",
      sweep: sweep.rows.map((r) => ({ shock: r.shock, outcomes: r.result.outcomeFractions })),
    },
  };
}

// ── dispatcher ──────────────────────────────────────────────────────────────

// Interpretable-by-design bottleneck: a few sparse, non-negative, nameable
// codes broadcast to the numeric report heads (generalizes Lee-Carter / NMF).
function runWorkspaceBottleneck({ dataset }: Args): RunResult {
  const cols = numericColumns(dataset);
  const startedAt = Date.now();
  if (cols.length < 3) {
    return makeUnsupported(
      "workspace-bottleneck",
      "workspace",
      `Needs at least three numeric columns to compress (found ${cols.length}).`,
    );
  }
  const r = Math.min(3, cols.length - 1);
  const fit = fitBottleneck(dataset.rows, cols, { r });
  // For each code, the two report heads it broadcasts to most strongly.
  const topHeads = (k: number): string =>
    fit.heads
      .map((h, i) => ({ h, b: fit.broadcast[i]?.[k] ?? 0 }))
      .sort((a, b) => b.b - a.b)
      .slice(0, 2)
      .filter((x) => x.b > 1e-6)
      .map((x) => x.h)
      .join(", ") || "(diffuse)";
  return {
    modelId: "workspace-bottleneck",
    family: "workspace",
    status: "done",
    startedAt,
    finishedAt: Date.now(),
    headline: { label: "participation ratio", value: fit.participationRatio, precision: 2 },
    secondary: [
      { label: "codes", value: String(fit.codeNames.length) },
      { label: "reconstruction R²", value: pct(fit.reconstructionR2) },
      { label: "causal alignment", value: pct(fit.causalAlignment) },
      { label: "broadcast sparsity", value: pct(fit.sparsity) },
    ],
    tableSpec: {
      headers: ["code", "broadcasts to"],
      rows: fit.codeNames.map((n, k) => [n, topHeads(k)]),
    },
    blurb: `Compressed ${cols.length} drivers into ${fit.codeNames.length} nameable codes; the non-negative broadcast rebuilds ${pct(fit.reconstructionR2)} of the heads with ${pct(fit.causalAlignment)} causal alignment.`,
    detail: {
      codes: fit.codeNames,
      reconstructionR2: fit.reconstructionR2,
      causalAlignment: fit.causalAlignment,
      sparsity: fit.sparsity,
      participationRatio: fit.participationRatio,
    },
  };
}

// ── applicability ─────────────────────────────────────────────────────────
//
// Can a model produce a result on this dataset at all? The picker used to
// attach whatever the LLM suggested from one-line catalog descriptions —
// Lee–Carter "as a rank-1 baseline" and an annuity "cross-check" on the
// workspace demo, which has no age, year or rate column — and the Hard stage
// could then only report them as not applicable. Each check runs the SAME
// detector (or fit) the runner's own "cannot run" path uses, so the two can
// never disagree. Cached per dataset object: the Tools canvas asks on every
// render.

export type Applicability = { ok: true } | { ok: false; reason: string };

const APPLICABLE: Applicability = { ok: true };
const APPLICABILITY_CACHE = new WeakMap<Dataset, Map<string, Applicability>>();

function hasAnyNumber(dataset: Dataset): boolean {
  for (const c of dataset.columns) {
    for (const r of dataset.rows) {
      const v = r[c];
      if (typeof v === "number" && Number.isFinite(v)) return true;
    }
  }
  return false;
}

function checkApplicability(modelId: string, dataset: Dataset): Applicability {
  const no = (clause: string): Applicability => ({ ok: false, reason: sentence(clause) });
  switch (modelId) {
    case "chain-ladder":
    case "mack":
    case "bornhuetter-ferguson":
    case "bootstrap-ibnr":
      return buildTriangle(dataset)
        ? APPLICABLE
        : no("needs a claims triangle — `origin_year`, `dev_period` and `paid` columns");
    case "lee-carter": {
      const found = detectMortalityTable(dataset);
      if ("reason" in found) return no(found.reason);
      const fit = fitLeeCarter(found.table);
      return "reason" in fit ? no(fit.reason) : APPLICABLE;
    }
    case "cbd": {
      const found = detectMortalityTable(dataset);
      if ("reason" in found) return no(found.reason);
      const fit = fitCBD(found.table);
      return "reason" in fit ? no(fit.reason) : APPLICABLE;
    }
    case "lifecontingencies": {
      const basis = resolveLifeBasis(dataset);
      return "reason" in basis ? no(basis.reason) : APPLICABLE;
    }
    case "glm-frequency":
      if (detectCategoricalCovariates(dataset).length === 0) {
        return no("needs a categorical rating factor (a text column with 2–20 levels)");
      }
      return detectFrequencyTarget(dataset)
        ? APPLICABLE
        : no("needs a claim-count column (past_claims, claim_count … small whole numbers)");
    case "glm-severity":
      if (detectCategoricalCovariates(dataset).length === 0) {
        return no("needs a categorical rating factor (a text column with 2–20 levels)");
      }
      return detectMonetaryColumn(dataset)
        ? APPLICABLE
        : no("needs a claim-amount column (paid, claim_amount, severity, loss …)");
    case "gbm":
    case "shap": {
      // The real (cached) fit: the Hard stage reuses it for free.
      const res = gbmFitFor(dataset);
      return "error" in res ? no(res.error) : APPLICABLE;
    }
    case "climada": {
      const col = findExposureColumn(dataset);
      if (!col) return no("needs an exposure column (sum insured, TIV, exposure …)");
      const total = numericCol(dataset.rows, col).reduce((a, b) => a + b, 0);
      return total > 0 ? APPLICABLE : no(`exposure column \`${col}\` sums to zero`);
    }
    case "parametric-design": {
      const col = detectMonetaryColumn(dataset);
      if (!col) return no("needs a monetary loss column to set a trigger from");
      return numericCol(dataset.rows, col).length > 0
        ? APPLICABLE
        : no(`no numeric values in \`${col}\``);
    }
    case "basicterm-projection":
    case "cashvalue-savings":
    case "ifrs17-csm":
    case "solvency2-life":
    case "nested-stochastic":
    case "cluster-modelpoints":
      return hasModelPoints(dataset)
        ? APPLICABLE
        : no("needs a model-point file — `age_at_entry`, `sum_assured` and `policy_term` columns");
    case "descriptive":
      return hasAnyNumber(dataset) ? APPLICABLE : no("needs at least one numeric column");
    case "workspace-bottleneck": {
      const n = numericColumns(dataset).length;
      return n >= 3 ? APPLICABLE : no(`needs at least three numeric columns (found ${n})`);
    }
    default:
      // Scenario engines (ESG, curves, WMTR, SCR, DB valuation) run on their
      // own assumptions rather than the dataset's columns.
      return APPLICABLE;
  }
}

/** Whether `modelId` can produce a result on `dataset` — and if not, why. */
export function modelApplicability(modelId: string, dataset: Dataset): Applicability {
  let perDataset = APPLICABILITY_CACHE.get(dataset);
  if (!perDataset) {
    perDataset = new Map();
    APPLICABILITY_CACHE.set(dataset, perDataset);
  }
  const hit = perDataset.get(modelId);
  if (hit) return hit;
  const res = checkApplicability(modelId, dataset);
  perDataset.set(modelId, res);
  return res;
}

const RUNNERS: Record<string, (args: Args) => RunResult> = {
  "chain-ladder": runChainLadder,
  mack: runMack,
  "bornhuetter-ferguson": runBornhuetterFerguson,
  "bootstrap-ibnr": runBootstrap,
  "lee-carter": runLeeCarter,
  cbd: runCBD,
  lifecontingencies: runLifeContingencies,
  "glm-frequency": runGLMFrequency,
  "glm-severity": runGLMSeverity,
  gbm: runGBM,
  shap: runSHAP,
  climada: runClimada,
  "nfip-flood-losses": runNfipFloodLossesStub,
  "parametric-design": runParametric,
  "scr-standard": runSCR,
  esg: runESG,
  "db-valuation": runDBValuation,
  descriptive: runDescriptive,
  // lifelib-rooted
  "basicterm-projection": runBasicTermProjectionRunner,
  "cashvalue-savings": runCashValueSavings,
  "ifrs17-csm": runIfrs17Csm,
  "solvency2-life": runSolvency2Life,
  "nested-stochastic": runNestedStochastic,
  "smithwilson-curve": runSmithWilsonCurve,
  "cluster-modelpoints": runClusterModelpoints,
  "economic-curves": runEconomicCurves,
  // forecast (WMTR)
  "wmtr-projection": runWmtrProjection,
  "wmtr-sensitivity": runWmtrSensitivityRunner,
  // workspace (interpretable bottleneck)
  "workspace-bottleneck": runWorkspaceBottleneck,
};

export function runModel(
  modelId: string,
  dataset: Dataset,
  upstream?: Map<string, RunResult>,
): RunResult {
  const fn = RUNNERS[modelId];
  if (!fn) {
    return {
      modelId,
      family: "general",
      status: "error",
      startedAt: Date.now(),
      finishedAt: Date.now(),
      headline: { label: "—", value: 0 },
      secondary: [{ label: "reason", value: "no runner registered" }],
      blurb: `Model ${modelId} has no client-side runner yet.`,
      error: "no runner registered",
      source: "browser",
    };
  }
  try {
    return { ...fn({ dataset, upstream }), source: "browser" };
  } catch (e) {
    // A runner that THREW broke — that is a failure, not "does not apply".
    const msg = e instanceof Error ? e.message : String(e);
    return {
      modelId,
      family: MODEL_BY_ID.get(modelId)?.family ?? "general",
      status: "error",
      startedAt: Date.now(),
      finishedAt: Date.now(),
      headline: { label: "—", value: 0 },
      secondary: [{ label: "reason", value: msg }],
      blurb: `${modelId} failed: ${msg}`,
      error: msg,
      source: "browser",
    };
  }
}

// ─── Async runner with Scelo IDE delegation ─────────────────────────────
//
// `runModelAsync` is the variant that, when running inside the Scelo IDE
// desktop shell, dispatches select models to the bundled Python/R runtime
// instead of the in-browser TS port. The Hard Data run effect awaits it
// for every model in `BRIDGED_MODEL_IDS`; everything else stays on the
// sync `runModel` path.
//
// Provenance contract: bridge results carry `source: "python-bridge"` (or
// "r-bridge" for the bundled R).
// When a bridge fails (or returns nothing inside the IDE), the in-browser
// fallback still runs but the result carries `bridgeError` so the card
// can say WHY — a bridge failure must never silently pass off the mock
// as the canonical answer.
//
// Why both entry points: most of Scelo's runners are synchronous and
// cheap (pure arithmetic over the dataset). Forcing every site to `await`
// would be a pointless refactor.

// Models with a Python/R bridge branch below. Exported so the run effect
// can route: bridged models await this entry point, the rest run sync.
export const BRIDGED_MODEL_IDS: ReadonlySet<string> = new Set([
  "chain-ladder",
  "mack",
  "bornhuetter-ferguson",
  "bootstrap-ibnr",
  "nfip-flood-losses",
  "climada",
  "lifecontingencies",
  "glm-frequency",
  "glm-severity",
  "who-life-table",
  "lee-carter",
  "ifrs17-csm",
  "basicterm-projection",
  "solvency2-life",
  "workspace-bottleneck",
]);

// Bridge contract (every bridge below): a bridge returns null ONLY when it
// does not apply — outside the desktop IDE, or the dataset is not the shape it
// computes on (no triangle, no mortality table, no model points) — and the
// in-browser runner then speaks for the data. A missing runtime or a failed
// script THROWS with the reason, which lands on the card as `bridgeError`.
// (Null used to mean all of those at once, and the card could only say
// "<x> bridge produced no result (runtime missing, unsupported data shape, or
// script error — see IDE logs)" — a "failure" on every dataset the model
// simply does not apply to.)

function bridgeErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runModelAsync(
  modelId: string,
  dataset: Dataset,
  upstream?: Map<string, RunResult>,
): Promise<RunResult> {
  // Why the bridge didn't produce a result, if it was attempted. Attached
  // to the in-browser fallback at the bottom.
  let bridgeError: string | undefined;
  // Reserving family — chainladder Python is the canonical implementation.
  // Mack / BF / Bootstrap all go through bridges/chainladderPython.ts; the
  // method is forwarded so the Python script picks the right runner.
  if (
    modelId === "chain-ladder" ||
    modelId === "mack" ||
    modelId === "bornhuetter-ferguson" ||
    modelId === "bootstrap-ibnr"
  ) {
    try {
      const { runChainladderPython } = await import("./bridges/chainladderPython");
      // The catalog id is "bootstrap-ibnr"; the Python script's method
      // vocabulary is plain "bootstrap".
      const method = modelId === "bootstrap-ibnr" ? "bootstrap" : modelId;
      const py = await runChainladderPython(dataset, method);
      if (py) {
        // Same headline labels as the in-browser runners: the method is on
        // the card already, and the provenance is the python badge. (The old
        // "IBNR · Mack · chainladder-python" labels named a library this
        // numpy engine deliberately does not use.)
        const label =
          modelId === "bornhuetter-ferguson"
            ? "BF reserve"
            : modelId === "bootstrap-ibnr"
              ? "IBNR mean"
              : "IBNR";
        const hasBand = py.p5 !== undefined && py.p95 !== undefined;
        return {
          modelId,
          family: "reserving",
          status: "done",
          startedAt: Date.now(),
          finishedAt: Date.now(),
          headline: { label, value: py.ibnr, precision: 0 },
          secondary: [
            { label: "method", value: py.method },
            { label: "origins", value: py.byOrigin.length.toLocaleString() },
            ...(py.cv !== undefined ? [{ label: "CV", value: pct(py.cv, 2) }] : []),
            ...(py.se !== undefined ? [{ label: "SE", value: fmt(py.se) }] : []),
            ...(hasBand ? [{ label: "p5 – p95", value: `${fmt(py.p5 ?? 0)} – ${fmt(py.p95 ?? 0)}` }] : []),
            ...(py.apriori !== undefined
              ? [{ label: "a-priori", value: `book-avg ultimate ${fmt(py.apriori, 0)}` }]
              : []),
            { label: "runtime", value: "bundled CPython (numpy reserving engine)" },
          ],
          series: {
            kind: "line",
            x: py.byOrigin.map((b) => String(b.origin)),
            y: py.byOrigin.map((b) => b.ibnr),
          },
          blurb:
            `Bundled-CPython numpy reserving engine (${py.method}) across ${py.byOrigin.length} ` +
            `origins produced IBNR = ${fmt(py.ibnr)}` +
            (py.cv !== undefined ? ` (CV ${pct(py.cv, 2)})` : "") +
            (hasBand ? ` with a p5–p95 band of ${fmt(py.p5 ?? 0)} – ${fmt(py.p95 ?? 0)}` : "") +
            ".",
          // ibnr + se (Mack) / p5 + p95 (bootstrap) are what the card's CI
          // strip, the forest-plot whiskers and the detail range read.
          detail: {
            source: "scelo-reserving-numpy",
            byOrigin: py.byOrigin,
            ibnr: py.ibnr,
            ...(py.se !== undefined ? { se: py.se } : {}),
            ...(py.cv !== undefined ? { cv: py.cv } : {}),
            ...(hasBand ? { p5: py.p5, p95: py.p95 } : {}),
          },
          source: "python-bridge",
        };
      }
    } catch (e) {
      bridgeError = bridgeErrorMessage(e);
    }
  }
  // Climate family — NFIP flood-losses Tool consumes the downloaded
  // FimaNfipClaims CSV via the bundled Python.
  if (modelId === "nfip-flood-losses") {
    try {
      const { runNfipPython } = await import("./bridges/nfipPython");
      const py = await runNfipPython();
      if (py) {
        const topState = py.topStates[0];
        return {
          modelId,
          family: "climate",
          status: "done",
          startedAt: Date.now(),
          finishedAt: Date.now(),
          headline: {
            label: `Top NFIP state · ${topState?.state ?? "—"}`,
            value: topState?.totalPaidUsd ?? 0,
            precision: 0,
          },
          secondary: [
            { label: "rows scanned", value: py.rowsScanned.toLocaleString() },
            { label: "state-decade bins", value: py.bins.length.toLocaleString() },
            {
              label: "top 3 states",
              value:
                py.topStates
                  .slice(0, 3)
                  .map((s) => s.state)
                  .join(", ") || "—",
            },
            { label: "runtime", value: "bundled CPython (pandas)" },
          ],
          series: {
            kind: "bar",
            x: py.topStates.map((s) => s.state),
            y: py.topStates.map((s) => s.totalPaidUsd),
          },
          blurb:
            `Bundled-CPython pandas summary of ${py.rowsScanned.toLocaleString()} NFIP claims rows. ` +
            `Top loss-paying state: ${topState?.state ?? "—"} (${fmt(topState?.totalPaidUsd ?? 0)}).`,
          detail: { ...py },
          source: "python-bridge",
        };
      }
    } catch (e) {
      bridgeError = bridgeErrorMessage(e);
    }
  }
  // Climate family — climada Python returns AAL + RP10/100/250 from a
  // CLIMADA-shaped synthetic tropical-cyclone hazard.
  if (modelId === "climada") {
    try {
      const { runClimadaPython } = await import("./bridges/climadaPython");
      const py = await runClimadaPython(dataset);
      if (py) {
        // Only the IBTrACS path runs CLIMADA. The fallback is a synthetic
        // numpy loss model and must say so — it was labelled "climada-python"
        // and its blurb read "Bundled-CPython climada estimate".
        const real = py.source === "climada-python+ibtracs";
        return {
          modelId,
          family: "climate",
          status: "done",
          startedAt: Date.now(),
          finishedAt: Date.now(),
          headline: {
            label: real ? "AAL · CLIMADA (IBTrACS)" : "AAL · synthetic loss model",
            value: py.aal,
            precision: 0,
          },
          secondary: [
            { label: "exposure", value: fmt(py.exposureValue) },
            { label: "country", value: py.countryAlpha3 ?? "—" },
            { label: "RP10", value: fmt(py.rp10) },
            { label: "RP100", value: fmt(py.rp100) },
            { label: "RP250", value: fmt(py.rp250) },
            {
              label: "runtime",
              value: real
                ? "bundled CPython (climada · IBTrACS)"
                : "bundled CPython (numpy) — synthetic, CLIMADA not run",
            },
          ],
          series: {
            kind: "bar",
            x: ["AAL", "RP10", "RP100", "RP250"],
            y: [py.aal, py.rp10, py.rp100, py.rp250],
          },
          blurb: real
            ? `CLIMADA (LitPop exposure × IBTrACS tropical-cyclone hazard): AAL ${fmt(py.aal)}, ` +
              `RP100 ${fmt(py.rp100)}, RP250 ${fmt(py.rp250)} on exposure ${fmt(py.exposureValue)}.`
            : `Synthetic compound-Poisson loss model (numpy; CLIMADA did not run — ${py.fallbackReason ?? "no hazard data"}): ` +
              `AAL ${fmt(py.aal)}, RP100 ${fmt(py.rp100)}, RP250 ${fmt(py.rp250)} on ${fmt(py.exposureValue)} exposure. ` +
              "Illustrative calibration, not a hazard model.",
          detail: { ...py },
          source: "python-bridge",
        };
      }
      // null = does not apply (outside the IDE, or no usable exposure — the
      // in-browser runner says which); real failures throw with the reason.
    } catch (e) {
      bridgeError = bridgeErrorMessage(e);
    }
  }
  // Life family — lifecontingencies (R) for canonical EPVs, priced on the
  // SAME basis the in-browser runner resolves (wired Lee–Carter cohort, or
  // the dataset's life table). No basis → nothing to send; the in-browser
  // runner then says what is missing.
  if (modelId === "lifecontingencies") {
    const basis = resolveLifeBasis(dataset, upstream);
    if (!("reason" in basis)) {
      try {
        const { runLifeContingenciesR } = await import("./bridges/lifecontingenciesR");
        const r = await runLifeContingenciesR({
          q: basis.q,
          ageX: basis.x,
          interest: LIFE_INTEREST,
        });
        if (r) {
          return {
            ...lifeResult(
              basis,
              { annuityDue: r.ax, termAssurance: r.Ax, pureEndowment: r.nEx },
              "bundled R (lifecontingencies)",
            ),
            source: "r-bridge",
          };
        }
      } catch (e) {
        bridgeError = bridgeErrorMessage(e);
      }
    }
  }
  // Pricing family — statsmodels GLM (Poisson frequency, Gamma severity).
  if (modelId === "glm-frequency" || modelId === "glm-severity") {
    try {
      const { runGlmPython } = await import("./bridges/glmPython");
      const kind = modelId === "glm-frequency" ? "frequency" : "severity";
      const py = await runGlmPython(dataset, kind);
      if (py) {
        // Headline = the intercept's exponentiated value (the baseline
        // rate / mean before any covariate effect). Coefficients table is
        // the real artefact; UI shows it via the detail panel.
        const intercept = py.coefficients.find((c) => c.name === "Intercept");
        const baseline = intercept ? Math.exp(intercept.estimate) : 0;
        // Frequency wired into severity (the Tools canvas's frequency pin):
        // the base-cell pure premium exp(β₀ freq) × exp(β₀ sev) — the base
        // rate a GLM tariff multiplies its relativities onto. Only when the
        // frequency is also a statsmodels baseline: the in-browser fallback's
        // headline is a portfolio MEAN, and a mean × a baseline is nothing.
        const wiredFreq = kind === "severity" ? wired(upstream, "glm-frequency") : null;
        const sameEngine = wiredFreq?.source === "python-bridge";
        const purePremium =
          wiredFreq && sameEngine && Number.isFinite(wiredFreq.headline.value)
            ? wiredFreq.headline.value * baseline
            : null;
        return {
          modelId,
          family: "pricing",
          status: "done",
          startedAt: Date.now(),
          finishedAt: Date.now(),
          headline: {
            label: `baseline ${kind} · statsmodels-python`,
            value: baseline,
            precision: kind === "frequency" ? 4 : 0,
          },
          secondary: [
            ...(purePremium !== null
              ? [{ label: "base pure premium (freq × sev)", value: fmt(purePremium, 0) }]
              : wiredFreq
                ? [{ label: "pure premium", value: "not combined — frequency ran in-browser" }]
                : []),
            { label: "family", value: `${py.family} (log)` },
            { label: "covariates", value: py.covariates.join(" + ") || "(intercept-only)" },
            { label: "observations", value: py.nObservations.toLocaleString() },
            { label: "AIC", value: py.aic.toFixed(1) },
            { label: "deviance", value: py.deviance.toFixed(1) },
            { label: "runtime", value: "bundled CPython (statsmodels)" },
          ],
          series: {
            kind: "bar",
            x: py.coefficients.map((c) => c.name.slice(0, 24)),
            y: py.coefficients.map((c) => c.estimate),
          },
          blurb:
            `Bundled-CPython statsmodels ${py.family} GLM with log link, ` +
            `${py.coefficients.length} terms across ${py.covariates.length} covariates ` +
            `(AIC ${py.aic.toFixed(1)}, ${py.nObservations.toLocaleString()} obs` +
            (py.rowsSent < py.rowsTotal
              ? `, fitted on ${py.rowsSent.toLocaleString()} of ${py.rowsTotal.toLocaleString()} rows`
              : "") +
            ")" +
            (purePremium !== null
              ? `; × the wired frequency's baseline ${(wiredFreq?.headline.value ?? 0).toFixed(4)} gives a base pure premium of ${fmt(purePremium, 0)}.`
              : "."),
          detail: { ...py, ...(purePremium !== null ? { purePremium } : {}) },
          ...(purePremium !== null
            ? {
                wiredFrom: [
                  {
                    id: "glm-frequency",
                    note: "baseline frequency crossed in for the base pure premium",
                  },
                ],
              }
            : {}),
          source: "python-bridge",
        };
      }
      // null = does not apply (outside the IDE, or no rating factor / target —
      // the in-browser runner says which); real failures throw with the reason.
    } catch (e) {
      bridgeError = bridgeErrorMessage(e);
    }
  }
  // Mortality family — WHO Global Health Observatory life table for the
  // chosen country / sex. Requires the user to have downloaded the
  // dataset via /settings/data (~3 MB CSV, no registration).
  if (modelId === "who-life-table") {
    try {
      const { runWhoMortalityPython } = await import("./bridges/whoMortalityPython");
      // Dataset-aware: peek for `country` / `sex` columns and use the
      // most-common pair as the lookup target. Falls back to ZAF / both.
      const cols = dataset.columns.map((c) => c.toLowerCase());
      const cIdx = ["country", "iso3", "iso_a3"].map((k) => cols.indexOf(k)).find((i) => i >= 0);
      const sIdx = ["sex", "gender"].map((k) => cols.indexOf(k)).find((i) => i >= 0);
      let country = "ZAF";
      if (cIdx !== undefined && cIdx >= 0) {
        const col = dataset.columns[cIdx];
        const first = dataset.rows.find((r) => typeof r[col] === "string");
        if (first && typeof first[col] === "string") country = (first[col] as string).toUpperCase();
      }
      let sex: "M" | "F" | "B" = "B";
      if (sIdx !== undefined && sIdx >= 0) {
        const col = dataset.columns[sIdx];
        const first = dataset.rows.find((r) => typeof r[col] === "string");
        if (first) {
          const s = String(first[col]).toUpperCase()[0];
          if (s === "M" || s === "F") sex = s;
        }
      }
      const py = await runWhoMortalityPython(country, sex);
      if (py) {
        return {
          modelId,
          family: "mortality",
          status: "done",
          startedAt: Date.now(),
          finishedAt: Date.now(),
          headline: {
            label: `e0 (${py.country} · ${py.sex} · ${py.vintage})`,
            value: py.e0,
            precision: 1,
          },
          secondary: [
            { label: "e65", value: py.e65.toFixed(1) },
            { label: "age bands", value: py.qxByAge.length.toLocaleString() },
            { label: "rows scanned", value: py.rowsScanned.toLocaleString() },
            { label: "source", value: "WHO GHO" },
            { label: "runtime", value: "bundled CPython (pandas)" },
          ],
          series: {
            kind: "line",
            x: py.qxByAge.map((p) => String(p.age)),
            y: py.qxByAge.map((p) => p.qx),
          },
          blurb:
            `WHO Global Health Observatory life table for ${py.country} ` +
            `(${py.sex === "B" ? "both sexes" : py.sex}, ${py.vintage}): ` +
            `life expectancy at birth ${py.e0.toFixed(1)}y, at 65 ${py.e65.toFixed(1)}y.`,
          detail: { ...py },
          source: "python-bridge",
        };
      }
    } catch (e) {
      bridgeError = bridgeErrorMessage(e);
    }
  }
  // Mortality family — Lee-Carter via numpy SVD + statsmodels SARIMAX on κ.
  if (modelId === "lee-carter") {
    try {
      const { runLeeCarterPython } = await import("./bridges/leeCarterPython");
      const py = await runLeeCarterPython(dataset);
      if (py) {
        const finalQ = py.qx[py.qx.length - 1] ?? 0;
        return {
          modelId,
          family: "mortality",
          status: "done",
          startedAt: Date.now(),
          finishedAt: Date.now(),
          // Same label as the in-browser fit; provenance is the badge.
          headline: {
            label: `q(${py.headlineAge}) in ${py.years[py.years.length - 1]}`,
            value: finalQ,
            precision: 5,
          },
          secondary: [
            { label: "annual improvement", value: pct(py.annualImprovement) },
            { label: "κ drift", value: py.kappaDrift.toFixed(4) },
            { label: "horizon", value: `${py.years.length}y` },
            { label: "rows used", value: py.rowsUsed.toLocaleString() },
            { label: "runtime", value: "bundled CPython (statsmodels)" },
          ],
          series: {
            kind: "line",
            x: py.years.map(String),
            y: py.qx,
          },
          blurb:
            `Bundled-CPython Lee-Carter (numpy SVD + statsmodels SARIMAX): ` +
            `q(${py.headlineAge}) projected to ${finalQ.toFixed(5)} by ` +
            `${py.years[py.years.length - 1]} ` +
            `(${pct(py.annualImprovement)}/yr improvement, κ drift ${py.kappaDrift.toFixed(3)}).`,
          detail: { ...py },
          source: "python-bridge",
        };
      }
    } catch (e) {
      bridgeError = bridgeErrorMessage(e);
    }
  }
  // Life family — IFRS 17 CSM via lifelib ifrs17sim (legacy library, real
  // model: OuterProj CSM(t) / TransServices(t) per policy on the bundled
  // CPython). The card names the library status and the lifelib version.
  if (modelId === "ifrs17-csm") {
    try {
      const { runIfrs17CsmPython } = await import("./bridges/ifrs17CsmPython");
      const py = await runIfrs17CsmPython(dataset);
      if (py) {
        const coverage =
          py.modelPointsUsed < py.modelPointsTotal
            ? `${py.modelPointsUsed.toLocaleString()} of ${py.modelPointsTotal.toLocaleString()} (time budget)`
            : py.modelPointsTotal.toLocaleString();
        return {
          modelId,
          family: "life",
          status: "done",
          startedAt: Date.now(),
          finishedAt: Date.now(),
          headline: {
            label: "CSM at issue · ifrs17sim (lifelib)",
            value: py.csm0,
            precision: 0,
          },
          secondary: [
            { label: "PV net CF", value: fmt(py.pvProfit) },
            { label: "PV premiums", value: fmt(py.pvPremiums) },
            { label: "PV benefits", value: fmt(py.pvBenefits) },
            { label: "Risk adjustment", value: `${fmt(py.riskAdjustment)} (stub in ifrs17sim)` },
            { label: "Release period", value: `${py.years}y (coverage-units)` },
            { label: "model points", value: coverage },
            {
              label: "runtime",
              value: `lifelib ${py.lifelibVersion} · ifrs17sim (legacy → ${py.successor})`,
            },
          ],
          series: {
            kind: "bar",
            x: py.release.map((_, i) => `y${i + 1}`),
            y: py.release,
          },
          blurb:
            `lifelib ${py.lifelibVersion} ifrs17sim · CSM at issue ${fmt(py.csm0)} ` +
            `on ${coverage} model points (PV net CF ${fmt(py.pvProfit)}; ` +
            `RA ${fmt(py.riskAdjustment)} — ifrs17sim leaves RiskAdjustment unimplemented); ` +
            `coverage-units release over ${py.years} y. ifrs17sim is a legacy lifelib ` +
            `library (deprecated 0.12.0); ${py.successor} is the active IFRS 17 engine.`,
          detail: { ...py },
          source: "python-bridge",
        };
      }
    } catch (e) {
      bridgeError = bridgeErrorMessage(e);
    }
  }
  // Life family — Solvency II life SCR via lifelib annuallife/TradLife_A_EX1
  // (the active successor to the deprecated solvency2 project): per-policy
  // life stresses as inner projections, aggregated with the model's own
  // correlation matrix.
  if (modelId === "solvency2-life") {
    try {
      const { runSolvency2LifeScrPython, SCR_SUB_RISKS } = await import(
        "./bridges/solvency2LifeScrPython"
      );
      const py = await runSolvency2LifeScrPython(dataset);
      if (py) {
        const coverage =
          py.modelPointsUsed < py.modelPointsTotal
            ? `${py.modelPointsUsed.toLocaleString()} of ${py.modelPointsTotal.toLocaleString()} (time budget)`
            : py.modelPointsTotal.toLocaleString();
        const subs = SCR_SUB_RISKS.map((k) => [k, py.subs[k]] as const);
        const dominant = subs.reduce((a, b) => (b[1] > a[1] ? b : a));
        return {
          modelId,
          family: "life",
          status: "done",
          startedAt: Date.now(),
          finishedAt: Date.now(),
          headline: { label: "Life SCR · TradLife_A_EX1 (lifelib)", value: py.scrLife, precision: 0 },
          secondary: [
            { label: "PV net CF (base)", value: fmt(py.pvNetCf) },
            { label: "dominant", value: `${dominant[0]} (${fmt(dominant[1])})` },
            { label: "Σ per-policy SCR", value: fmt(py.scrLifePolicySum) },
            { label: "model points", value: coverage },
            {
              label: "runtime",
              value: `lifelib ${py.lifelibVersion} · annuallife/TradLife_A_EX1`,
            },
          ],
          tableSpec: {
            headers: ["sub-module", "shock charge"],
            rows: subs.map(([k, v]) => [k, fmt(v)]),
          },
          series: {
            kind: "bar",
            x: subs.map(([k]) => k),
            y: subs.map(([, v]) => v),
          },
          blurb:
            `lifelib ${py.lifelibVersion} annuallife/TradLife_A_EX1 · life underwriting SCR ` +
            `${fmt(py.scrLife)} on ${coverage} model points, valued at t=0: sub-risk charges ` +
            `(mortality / longevity / disability / lapse up-down-mass / expense / revision / CAT) ` +
            `summed across policies (per-policy floor at 0) and aggregated with the model's ` +
            `life correlation matrix. Dominant module: ${dominant[0]} (${fmt(dominant[1])}). ` +
            `Replaces the deprecated solvency2 project.`,
          detail: { ...py },
          source: "python-bridge",
        };
      }
    } catch (e) {
      bridgeError = bridgeErrorMessage(e);
    }
  }
  if (modelId === "basicterm-projection") {
    try {
      const { runBasicTermPython } = await import("./bridges/lifelibBasicTermPython");
      const py = await runBasicTermPython(dataset);
      if (py) {
        const years = Array.from(new Set(py.monthly.map((r) => Math.floor(r.month / 12)))).slice(
          0,
          30,
        );
        const annualNet = years.map((y) =>
          py.monthly.filter((r) => Math.floor(r.month / 12) === y).reduce((s, r) => s + r.netCf, 0),
        );
        return {
          modelId,
          family: "life",
          status: "done",
          startedAt: Date.now(),
          finishedAt: Date.now(),
          headline: {
            label: "PV (net cash flow) · BasicTerm_ME (lifelib)",
            value: py.pvNetCf,
            precision: 0,
          },
          secondary: [
            {
              label: "model points",
              value:
                py.modelPointsUnpriced > 0
                  ? `${py.modelPointsUsed.toLocaleString()} of ${py.modelPointsTotal.toLocaleString()} (${py.modelPointsUnpriced} outside lifelib's premium table)`
                  : py.modelPointsTotal.toLocaleString(),
            },
            { label: "PV premiums (∑)", value: fmt(py.totalPremiums) },
            { label: "PV claims (∑)", value: fmt(py.totalClaims) },
            { label: "PV expenses (∑)", value: fmt(py.totalExpenses) },
            { label: "PV commissions (∑)", value: fmt(py.totalCommissions) },
            {
              label: "premiums",
              value:
                py.premiumSource === "model-point-file"
                  ? "premium_pp from the MP file"
                  : "lifelib premium table",
            },
            {
              label: "break-even",
              value: py.breakEvenMonth === null ? "—" : `${py.breakEvenMonth}m`,
            },
            { label: "runtime", value: `lifelib ${py.lifelibVersion} · basiclife/BasicTerm_ME` },
          ],
          series: { kind: "line", x: years.map((y) => `y${y}`), y: annualNet },
          blurb:
            `lifelib ${py.lifelibVersion} basiclife/BasicTerm_ME projection across ` +
            `${py.modelPointsUsed} model points produced PV(net CF) = ` +
            `${fmt(py.pvNetCf)} (canonical lifelib on the bundled CPython, not the in-browser port; ` +
            `${py.premiumSource === "model-point-file" ? "premiums from the file's premium_pp column" : "premiums from lifelib's premium table"}).`,
          detail: {
            source: "lifelib-python",
            model: py.model,
            lifelibVersion: py.lifelibVersion,
            modelxVersion: py.modelxVersion,
            premiumSource: py.premiumSource,
            monthly: py.monthly.slice(0, 360),
          },
          source: "python-bridge",
        };
      }
    } catch (e) {
      bridgeError = bridgeErrorMessage(e);
    }
  }
  // Workspace family — the interpretable bottleneck's canonical numbers come
  // from the bundled numpy (same estimator as the in-browser engine).
  if (modelId === "workspace-bottleneck") {
    try {
      const { runBottleneckPython } = await import("./bridges/bottleneckPython");
      const py = await runBottleneckPython(dataset);
      if (py) {
        const topHeads = (k: number): string =>
          py.heads
            .map((h, i) => ({ h, b: py.broadcast[i]?.[k] ?? 0 }))
            .sort((a, b) => b.b - a.b)
            .slice(0, 2)
            .filter((x) => x.b > 1e-6)
            .map((x) => x.h)
            .join(", ") || "(diffuse)";
        return {
          modelId,
          family: "workspace",
          status: "done",
          startedAt: Date.now(),
          finishedAt: Date.now(),
          headline: { label: "participation ratio", value: py.participationRatio, precision: 2 },
          secondary: [
            { label: "codes", value: String(py.codeNames.length) },
            { label: "reconstruction R²", value: pct(py.reconstructionR2) },
            { label: "causal alignment", value: pct(py.causalAlignment) },
            { label: "runtime", value: "bundled CPython (numpy)" },
          ],
          tableSpec: {
            headers: ["code", "broadcasts to"],
            rows: py.codeNames.map((n, k) => [n, topHeads(k)]),
          },
          blurb: `Bundled-CPython bottleneck compressed ${py.heads.length} columns into ${py.codeNames.length} nameable codes; the non-negative broadcast rebuilds ${pct(py.reconstructionR2)} of them (causal alignment ${pct(py.causalAlignment)}).`,
          detail: { ...py },
          source: "python-bridge",
        };
      }
    } catch (e) {
      bridgeError = bridgeErrorMessage(e);
    }
  }
  // No bridge produced a result — run the in-browser approximation and,
  // when a bridge was attempted but failed, carry the reason so the card
  // shows WHY the canonical path didn't run.
  const fallback = runModel(modelId, dataset, upstream);
  return bridgeError ? { ...fallback, bridgeError } : fallback;
}
