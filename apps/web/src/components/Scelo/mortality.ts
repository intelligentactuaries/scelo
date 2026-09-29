// In-browser mortality engine: find a mortality table in a dataset, fit
// Lee–Carter and Cairns–Blake–Dowd to it, and price life contingencies off
// the result.
//
// These replace canned stand-ins. The old Lee–Carter "projection" was
// q(65) = 0.012 · (1 − improvement)^t with the improvement read off the
// dataset's MEAN AGE (50 when there was no age column), so every dataset —
// a mortality table or not — got a q(65) path; CBD multiplied that path by
// (1 + 0.0008·t); the annuity priced off it, or off a hard-coded survival
// curve. On the workspace demo (no age, year or rate column at all) the
// Hard canvas showed q(65) 0.00951 and a₆₅ 8.65 as completed results.
//
// Pure: no React, no dataset heuristics beyond the column-name contract
// below. Deterministic.

import type { Dataset } from "@scelo/core";

// ── table detection ─────────────────────────────────────────────────────────

const AGE_RE = /^(age|age_x)$/i;
const YEAR_RE = /^(year|calendar_year|cal_year|period)$/i;
const QX_RE = /^(q_?x|q)$/i;
const MX_RE = /^(m_?x|central_death_rate|death_rate)$/i;
const DEATHS_RE = /^(deaths?|death_count|n_deaths)$/i;
const EXPOSURE_RE =
  /^(exposures?|central_exposure|e_?x|etr|lives|person_years|policy_years|pop|population)$/i;

export type MortalityTable = {
  /** Sorted calendar years (a single 0 when the table has no year column). */
  years: number[];
  /** Sorted ages. */
  ages: number[];
  /** q[yearIndex][ageIndex]: one-year death probability, NaN where missing. */
  q: number[][];
  /** How q was obtained. */
  basis: "qx" | "mx" | "deaths / exposure";
  columns: { year: string | null; age: string; rate: string };
};

/** The column contract, spelled out for "not applicable" messages. */
export const MORTALITY_TABLE_NEED = "`age` with `qx`, `mx`, or `deaths` + `exposure` (and `year`)";

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Locate a mortality table in the dataset, or say exactly what is missing. */
export function detectMortalityTable(
  dataset: Dataset,
): { table: MortalityTable } | { reason: string } {
  const find = (re: RegExp) => dataset.columns.find((c) => re.test(c.trim())) ?? null;
  const age = find(AGE_RE);
  const year = find(YEAR_RE);
  const qx = find(QX_RE);
  const mx = find(MX_RE);
  const deaths = find(DEATHS_RE);
  const exposure = find(EXPOSURE_RE);
  const rateCol = qx ?? mx ?? (deaths && exposure ? `${deaths} / ${exposure}` : null);
  if (!age || !rateCol) {
    // Gist first — result cards show only the opening lines.
    const have = age ? "has `age` but no death rates" : "has no `age` column";
    return {
      reason: `needs a mortality table — death rates by age, and by year to project; this dataset ${have}. Reads ${MORTALITY_TABLE_NEED}`,
    };
  }
  const basis: MortalityTable["basis"] = qx ? "qx" : mx ? "mx" : "deaths / exposure";

  // Aggregate per (year, age) cell: mean rate, or pooled deaths / exposure.
  const cells = new Map<
    string,
    { y: number; a: number; s: number; n: number; d: number; e: number }
  >();
  for (const r of dataset.rows) {
    const a = num(r[age]);
    const y = year ? num(r[year]) : 0;
    if (a === null || y === null) continue;
    const key = `${y}|${a}`;
    const cell = cells.get(key) ?? { y, a, s: 0, n: 0, d: 0, e: 0 };
    if (basis === "deaths / exposure") {
      const d = num(r[deaths as string]);
      const e = num(r[exposure as string]);
      if (d === null || e === null || d < 0 || e <= 0) continue;
      cell.d += d;
      cell.e += e;
    } else {
      const v = num(r[(qx ?? mx) as string]);
      if (v === null || v < 0 || (basis === "qx" && v > 1)) continue;
      cell.s += v;
      cell.n += 1;
    }
    cells.set(key, cell);
  }
  const usable = [...cells.values()].filter((c) =>
    basis === "deaths / exposure" ? c.e > 0 : c.n > 0,
  );
  if (usable.length === 0) {
    return { reason: `found \`${age}\` and \`${rateCol}\` but no row with a usable rate` };
  }
  const years = [...new Set(usable.map((c) => c.y))].sort((a, b) => a - b);
  const ages = [...new Set(usable.map((c) => c.a))].sort((a, b) => a - b);
  const yIdx = new Map(years.map((y, i) => [y, i]));
  const aIdx = new Map(ages.map((a, i) => [a, i]));
  const q = years.map(() => new Array<number>(ages.length).fill(Number.NaN));
  for (const c of usable) {
    let rate: number;
    if (basis === "qx") rate = c.s / c.n;
    else if (basis === "mx") rate = 1 - Math.exp(-(c.s / c.n));
    else rate = 1 - Math.exp(-(c.d / c.e)); // central rate m = D / E → q = 1 − e^(−m)
    q[yIdx.get(c.y) as number][aIdx.get(c.a) as number] = rate;
  }
  return { table: { years, ages, q, basis, columns: { year, age, rate: rateCol } } };
}

/** Ages (and their column indices) with a finite, positive rate in EVERY year —
 *  the complete rectangle a period model needs. */
function completeAges(t: MortalityTable): number[] {
  const out: number[] = [];
  for (let j = 0; j < t.ages.length; j++) {
    if (t.q.every((row) => Number.isFinite(row[j]) && row[j] > 0 && row[j] < 1)) out.push(j);
  }
  return out;
}

/** Index of the value closest to `target` (first wins on a tie). */
export function nearestAge(values: number[], target: number): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (Math.abs(values[i] - target) < Math.abs(values[best] - target)) best = i;
  }
  return best;
}

// ── Lee–Carter ──────────────────────────────────────────────────────────────

export type LeeCarterFit = {
  years: number[];
  ages: number[];
  alpha: number[];
  beta: number[];
  kappa: number[];
  /** Random-walk drift of κ and the s.d. of its innovations. */
  drift: number;
  sigma: number;
  /** Share of the centred log-rate variation the rank-1 term explains. */
  explained: number;
  horizon: number;
  projYears: number[];
  kappaForecast: number[];
  headlineAge: number;
  /** q at the headline age, per projection year, with a 95% band from κ. */
  qx: number[];
  qxLower: number[];
  qxUpper: number[];
  annualImprovement: number;
  cells: number;
};

/**
 * Classic Lee–Carter (1992): log q(x,t) = α_x + β_x κ_t, fitted by the rank-1
 * SVD of the age-centred log-rate matrix (β normalised to sum 1), κ projected
 * as a random walk with drift. Same estimator as the bundled-Python bridge,
 * which adds a SARIMAX fit on κ (identical point forecast for ARIMA(0,1,0)).
 */
export function fitLeeCarter(
  t: MortalityTable,
  opts: { headlineAge?: number; horizon?: number } = {},
): LeeCarterFit | { reason: string } {
  const horizon = opts.horizon ?? 10;
  const cols = completeAges(t);
  if (t.years.length < 3 || cols.length < 2) {
    return {
      reason: `Lee–Carter needs at least 3 years × 2 ages with a rate in every year (have ${t.years.length} year${t.years.length === 1 ? "" : "s"} × ${cols.length} complete age${cols.length === 1 ? "" : "s"})`,
    };
  }
  const ages = cols.map((j) => t.ages[j]);
  const T = t.years.length;
  const A = ages.length;
  const M = t.q.map((row) => cols.map((j) => Math.log(row[j])));
  const alpha = ages.map((_, a) => M.reduce((s, row) => s + row[a], 0) / T);
  const C = M.map((row) => row.map((v, a) => v - alpha[a]));
  // Leading right singular vector of C by power iteration on CᵀC.
  let v = new Array<number>(A).fill(1 / Math.sqrt(A));
  for (let it = 0; it < 1000; it++) {
    const Cv = C.map((row) => row.reduce((s, c, a) => s + c * v[a], 0));
    const next = ages.map((_, a) => C.reduce((s, row, i) => s + row[a] * Cv[i], 0));
    const norm = Math.hypot(...next);
    if (norm === 0) break;
    const nv = next.map((x) => x / norm);
    const delta = Math.max(...nv.map((x, a) => Math.abs(x - v[a])));
    v = nv;
    if (delta < 1e-13) break;
  }
  const sumV = v.reduce((s, x) => s + x, 0);
  if (Math.abs(sumV) < 1e-12) {
    return { reason: "Lee–Carter is degenerate on this table (the age sensitivities sum to zero)" };
  }
  const beta = v.map((x) => x / sumV);
  const Cv = C.map((row) => row.reduce((s, c, a) => s + c * v[a], 0));
  const kappa = Cv.map((x) => x * sumV);
  const total = C.reduce((s, row) => s + row.reduce((r, c) => r + c * c, 0), 0);
  const explained = total > 0 ? Cv.reduce((s, x) => s + x * x, 0) / total : 1;

  const diffs = kappa.slice(1).map((k, i) => k - kappa[i]);
  const drift = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const sigma =
    diffs.length > 1
      ? Math.sqrt(diffs.reduce((s, d) => s + (d - drift) ** 2, 0) / (diffs.length - 1))
      : 0;
  const last = t.years[T - 1];
  const projYears = Array.from({ length: horizon }, (_, h) => last + h + 1);
  const kappaForecast = projYears.map((_, h) => kappa[T - 1] + (h + 1) * drift);
  const hx = nearestAge(ages, opts.headlineAge ?? 65);
  const qAt = (k: number) => Math.min(1, Math.exp(alpha[hx] + beta[hx] * k));
  const qx = kappaForecast.map(qAt);
  const band = kappaForecast.map((_, h) => 1.96 * sigma * Math.sqrt(h + 1));
  // β can be negative at some ages, so take the band's ends in q-space.
  const qxLower = kappaForecast.map((k, h) => Math.min(qAt(k - band[h]), qAt(k + band[h])));
  const qxUpper = kappaForecast.map((k, h) => Math.max(qAt(k - band[h]), qAt(k + band[h])));
  const qNow = qAt(kappa[T - 1]);
  const annualImprovement = qNow > 0 ? 1 - (qx[horizon - 1] / qNow) ** (1 / horizon) : 0;
  return {
    years: t.years,
    ages,
    alpha,
    beta,
    kappa,
    drift,
    sigma,
    explained,
    horizon,
    projYears,
    kappaForecast,
    headlineAge: ages[hx],
    qx,
    qxLower,
    qxUpper,
    annualImprovement,
    cells: T * A,
  };
}

// ── Cairns–Blake–Dowd ───────────────────────────────────────────────────────

export type CbdFit = {
  years: number[];
  ages: number[];
  xbar: number;
  kappa1: number[];
  kappa2: number[];
  drift1: number;
  drift2: number;
  horizon: number;
  projYears: number[];
  headlineAge: number;
  qx: number[];
};

const logit = (p: number) => Math.log(p / (1 - p));
const expit = (z: number) => 1 / (1 + Math.exp(-z));

/**
 * CBD (2006): logit q(x,t) = κ1_t + κ2_t (x − x̄), one least-squares line per
 * year over the old ages (≥ 50 when at least three are complete, else every
 * complete age), then a random walk with drift on (κ1, κ2).
 */
export function fitCBD(
  t: MortalityTable,
  opts: { headlineAge?: number; horizon?: number } = {},
): CbdFit | { reason: string } {
  const horizon = opts.horizon ?? 10;
  const complete = completeAges(t);
  const old = complete.filter((j) => t.ages[j] >= 50);
  const cols = old.length >= 3 ? old : complete;
  if (t.years.length < 3 || cols.length < 2) {
    return {
      reason: `CBD needs at least 3 years × 2 ages with a rate in every year (have ${t.years.length} year${t.years.length === 1 ? "" : "s"} × ${cols.length} complete age${cols.length === 1 ? "" : "s"})`,
    };
  }
  const ages = cols.map((j) => t.ages[j]);
  const xbar = ages.reduce((s, a) => s + a, 0) / ages.length;
  const sxx = ages.reduce((s, a) => s + (a - xbar) ** 2, 0);
  const kappa1: number[] = [];
  const kappa2: number[] = [];
  for (const row of t.q) {
    const y = cols.map((j) => logit(row[j]));
    kappa1.push(y.reduce((s, v) => s + v, 0) / y.length);
    kappa2.push(y.reduce((s, v, i) => s + (ages[i] - xbar) * v, 0) / sxx);
  }
  const T = t.years.length;
  const drift1 = (kappa1[T - 1] - kappa1[0]) / (T - 1);
  const drift2 = (kappa2[T - 1] - kappa2[0]) / (T - 1);
  const x = ages[nearestAge(ages, opts.headlineAge ?? 65)];
  const last = t.years[T - 1];
  const projYears = Array.from({ length: horizon }, (_, h) => last + h + 1);
  const qx = projYears.map((_, h) =>
    expit(kappa1[T - 1] + (h + 1) * drift1 + (kappa2[T - 1] + (h + 1) * drift2) * (x - xbar)),
  );
  return {
    years: t.years,
    ages,
    xbar,
    kappa1,
    kappa2,
    drift1,
    drift2,
    horizon,
    projYears,
    headlineAge: x,
    qx,
  };
}

// ── life contingencies ──────────────────────────────────────────────────────

export type LifeValues = {
  /** Temporary life annuity-due ä(x:n). */
  annuityDue: number;
  /** Term assurance A¹(x:n), 1 payable at the end of the year of death. */
  termAssurance: number;
  /** Pure endowment nEx. */
  pureEndowment: number;
};

/**
 * Expected present values for a life aged x over n years, from the one-year
 * death probabilities q[0..n−1] it faces (q[t] applies at age x+t — from a
 * period table, or along a projected cohort diagonal). Matches the
 * `lifecontingencies` R bridge's axn / Axn / nEx (annuity paid in advance).
 */
export function lifeValues(q: number[], interest: number): LifeValues {
  const v = 1 / (1 + interest);
  let tpx = 1;
  let annuityDue = 0;
  let termAssurance = 0;
  for (let t = 0; t < q.length; t++) {
    annuityDue += v ** t * tpx;
    termAssurance += v ** (t + 1) * tpx * q[t];
    tpx *= 1 - q[t];
  }
  return { annuityDue, termAssurance, pureEndowment: v ** q.length * tpx };
}
