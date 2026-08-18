// actuarialTables.ts — actuarial table generation, suggestion and prompt
// parsing. Headless: no React, no DOM, no LLM. Everything here is
// deterministic so a table built from a prompt today is the same table
// tomorrow, and so the swarm / tests / IDE all get one implementation.
//
// Three public surfaces:
//   1. `generateActuarialTable(spec, dataset)` — build the table.
//   2. `suggestActuarialTables(dataset, prompt?)` — the "agent that reads
//      through the data (and/or the prompt) and suggests tables", each with
//      a ready-to-send prompt AND the executable spec behind it.
//   3. `parseTablePrompt(text, dataset)` — natural-language prompt → spec,
//      so "build a life table at 4% from age 20 to 100" works in the chat
//      without any model in the loop. Round-trips every suggestion prompt.
//
// Table kinds
//   life-table          age, qx, px, lx, dx, Lx, Tx, ex
//   commutation         age, lx, dx, v^x, Dx, Nx, Cx, Mx, Rx, Sx (at i)
//   annuity-assurance   age, äx, ax, Ax [, äx:n, A¹x:n, nEx, Ax:n] (at i)
//   net-premium         age × term grid of annual net premium per 1,000 SA
//   runoff-triangle     origin × development (cumulative or incremental)
//   discount-curve      tenor, zero rate, discount factor, 1y forward, annuity-certain
//   exposure-ae         age band: exposure, actual deaths, expected, A/E
//   model-points        policy file → grouped model points (age band × sex × term)
//
// Mortality bases: a (age, qx) column pair, an (age, lx) pair, crude
// deaths/exposure, or Gompertz–Makeham μx = A + B·cˣ (defaults are Scelo's
// illustrative BasicTerm assumptions and are always labelled as such).

import type { CellValue, Dataset, Row } from "./index";

// ─── Types ────────────────────────────────────────────────────────────────

export type ActuarialTableKind =
  | "life-table"
  | "commutation"
  | "annuity-assurance"
  | "net-premium"
  | "runoff-triangle"
  | "discount-curve"
  | "exposure-ae"
  | "model-points";

export const ACTUARIAL_TABLE_KINDS: readonly ActuarialTableKind[] = [
  "life-table",
  "commutation",
  "annuity-assurance",
  "net-premium",
  "runoff-triangle",
  "discount-curve",
  "exposure-ae",
  "model-points",
];

export type MortalityBasis =
  | { kind: "qx-column"; ageColumn: string; qxColumn: string }
  | { kind: "lx-column"; ageColumn: string; lxColumn: string }
  | { kind: "deaths-exposure"; ageColumn: string; deathsColumn: string; exposureColumn: string }
  | { kind: "gompertz-makeham"; A: number; B: number; c: number; multiplier?: number };

/** Scelo's illustrative basis (also the in-browser BasicTerm port's). */
export const ILLUSTRATIVE_MAKEHAM = { A: 0.00022, B: 2.7e-6, c: 1.124 } as const;

export interface AgeRange {
  from?: number;
  to?: number;
}

export interface LifeTableSpec {
  kind: "life-table";
  title?: string;
  basis: MortalityBasis;
  ages?: AgeRange;
  radix?: number;
}
export interface CommutationSpec {
  kind: "commutation";
  title?: string;
  basis: MortalityBasis;
  interest: number;
  ages?: AgeRange;
  radix?: number;
}
export interface AnnuityAssuranceSpec {
  kind: "annuity-assurance";
  title?: string;
  basis: MortalityBasis;
  interest: number;
  term?: number;
  ages?: AgeRange;
}
export interface NetPremiumSpec {
  kind: "net-premium";
  title?: string;
  basis: MortalityBasis;
  interest: number;
  product: "term" | "endowment" | "whole-life";
  ages?: AgeRange & { step?: number };
  terms?: number[];
}
export interface RunoffTriangleSpec {
  kind: "runoff-triangle";
  title?: string;
  originColumn: string;
  /** Development lag column (integer periods) — or omit and give a payment
   *  period column, lag = payment period − origin period. */
  developmentColumn?: string;
  paymentColumn?: string;
  valueColumn: string;
  cumulative?: boolean;
}
export interface DiscountCurveSpec {
  kind: "discount-curve";
  title?: string;
  /** Either explicit (tenor, rate) points, columns to read them from, or a
   *  flat rate. Rates are annual-compound zero rates. */
  points?: Array<{ tenor: number; rate: number }>;
  tenorColumn?: string;
  rateColumn?: string;
  flatRate?: number;
  maxTenor?: number;
}
export interface ExposureAeSpec {
  kind: "exposure-ae";
  title?: string;
  ageColumn: string;
  deathsColumn: string;
  exposureColumn: string;
  expected: MortalityBasis;
  bandWidth?: number;
}
export interface ModelPointsSpec {
  kind: "model-points";
  title?: string;
  ageColumn: string;
  sexColumn?: string;
  termColumn?: string;
  sumAssuredColumn?: string;
  premiumColumn?: string;
  bandWidth?: number;
}

export type ActuarialTableSpec =
  | LifeTableSpec
  | CommutationSpec
  | AnnuityAssuranceSpec
  | NetPremiumSpec
  | RunoffTriangleSpec
  | DiscountCurveSpec
  | ExposureAeSpec
  | ModelPointsSpec;

export interface GeneratedTable {
  spec: ActuarialTableSpec;
  title: string;
  dataset: Dataset;
  /** Things an actuary should know before trusting the table. */
  notes: string[];
  /** One-line provenance ("Gompertz–Makeham illustrative basis · i = 4 %"). */
  basisLabel: string;
}

export interface TableSuggestion {
  id: string;
  kind: ActuarialTableKind;
  title: string;
  /** Why the agent thinks this table fits — names the columns/prompt cues. */
  why: string;
  /** Ready-to-send prompt; parseTablePrompt() turns it back into `spec`. */
  prompt: string;
  spec: ActuarialTableSpec;
  /** 0–1, higher = stronger evidence in the data / prompt. */
  score: number;
}

// ─── Small helpers ────────────────────────────────────────────────────────

const MAX_ROWS = 5_000;

function num(v: CellValue | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v)
    .trim()
    .replace(/[,%\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

function pct(v: number): string {
  return `${round(v * 100, 2)} %`;
}

function lc(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Find a dataset column by alias list (case/punctuation-insensitive). */
export function findColumn(columns: readonly string[], aliases: readonly string[]): string | null {
  const map = new Map(columns.map((c) => [lc(c), c] as const));
  for (const a of aliases) {
    const hit = map.get(lc(a));
    if (hit) return hit;
  }
  return null;
}

export const COLUMN_ALIASES = {
  age: [
    "age",
    "age_at_entry",
    "ageatentry",
    "issue_age",
    "attained_age",
    "x",
    "age_x",
    "age_band",
    "ageband",
  ],
  qx: ["qx", "q_x", "mortality", "mortality_rate", "death_rate", "q", "prob_death", "rate"],
  lx: ["lx", "l_x", "lives", "survivors", "l"],
  deaths: ["deaths", "death", "d", "dx", "actual_deaths", "claims_count", "n_deaths", "died"],
  exposure: [
    "exposure",
    "exposures",
    "exposed",
    "exposed_to_risk",
    "etr",
    "lives_exposed",
    "person_years",
    "policy_years",
    "central_exposure",
    "initial_exposure",
  ],
  origin: [
    "origin",
    "origin_year",
    "accident_year",
    "accidentyear",
    "ay",
    "uw_year",
    "underwriting_year",
    "occurrence_year",
    "loss_year",
    "year_of_origin",
    "cohort",
  ],
  development: [
    "development",
    "dev",
    "development_period",
    "dev_period",
    "development_year",
    "dev_year",
    "lag",
    "delay",
    "age_months",
    "development_lag",
  ],
  payment: [
    "payment_year",
    "calendar_year",
    "paid_year",
    "settlement_year",
    "transaction_year",
    "report_year",
    "valuation_year",
  ],
  value: [
    "paid",
    "incurred",
    "paid_amount",
    "incurred_amount",
    "claims",
    "claim_amount",
    "amount",
    "loss",
    "losses",
    "payments",
    "value",
    "cumulative",
    "reported",
  ],
  tenor: ["tenor", "maturity", "term", "years", "year", "t", "maturity_years"],
  rate: [
    "rate",
    "zero_rate",
    "spot",
    "spot_rate",
    "yield",
    "zero",
    "swap_rate",
    "par_rate",
    "interest_rate",
  ],
  sex: ["sex", "gender"],
  policyTerm: ["policy_term", "policyterm", "term", "term_years", "policy_term_years"],
  sumAssured: ["sum_assured", "sumassured", "sa", "face_amount", "face", "benefit"],
  premium: ["premium_pp", "premium", "annual_premium", "monthly_premium", "prem"],
} as const;

// ─── Mortality basis → qx by age ──────────────────────────────────────────

interface QxTable {
  ages: number[];
  qx: number[];
  notes: string[];
  label: string;
}

function makehamQx(x: number, A: number, B: number, c: number, mult = 1): number {
  // ∫_x^{x+1} μ_s ds with μ_s = A + B c^s  →  A + B c^x (c − 1) / ln c
  const integral = A + (B * c ** x * (c - 1)) / Math.log(c);
  const q = 1 - Math.exp(-integral * mult);
  return Math.min(1, Math.max(0, q));
}

function collectByAge(
  dataset: Dataset,
  ageColumn: string,
  valueColumn: string,
  agg: "mean" | "sum",
): Map<number, number> {
  const acc = new Map<number, { s: number; n: number }>();
  for (const r of dataset.rows) {
    const a = num(r[ageColumn]);
    const v = num(r[valueColumn]);
    if (a === null || v === null) continue;
    const age = Math.round(a);
    const cur = acc.get(age) ?? { s: 0, n: 0 };
    cur.s += v;
    cur.n += 1;
    acc.set(age, cur);
  }
  const out = new Map<number, number>();
  for (const [age, { s, n }] of acc) out.set(age, agg === "sum" ? s : s / n);
  return out;
}

function fillGaps(
  ages: number[],
  values: Map<number, number>,
): { ages: number[]; v: number[]; filled: number } {
  const lo = Math.min(...ages);
  const hi = Math.max(...ages);
  const outAges: number[] = [];
  const outV: number[] = [];
  let filled = 0;
  const known = [...values.entries()].sort((a, b) => a[0] - b[0]);
  for (let a = lo; a <= hi; a++) {
    const v = values.get(a);
    if (v !== undefined) {
      outAges.push(a);
      outV.push(v);
      continue;
    }
    // linear interpolation between the nearest known ages
    let prev: [number, number] | null = null;
    let next: [number, number] | null = null;
    for (const k of known) {
      if (k[0] < a) prev = k;
      if (k[0] > a) {
        next = k;
        break;
      }
    }
    if (prev && next) {
      const t = (a - prev[0]) / (next[0] - prev[0]);
      outAges.push(a);
      outV.push(prev[1] + t * (next[1] - prev[1]));
      filled += 1;
    }
  }
  return { ages: outAges, v: outV, filled };
}

export function qxFromBasis(
  basis: MortalityBasis,
  dataset: Dataset | null,
  ages?: AgeRange,
): QxTable {
  const notes: string[] = [];
  if (basis.kind === "gompertz-makeham") {
    const from = ages?.from ?? 20;
    const to = ages?.to ?? 110;
    const out: number[] = [];
    const ax: number[] = [];
    for (let a = from; a <= to; a++) {
      ax.push(a);
      out.push(makehamQx(a, basis.A, basis.B, basis.c, basis.multiplier ?? 1));
    }
    const isIllustrative =
      basis.A === ILLUSTRATIVE_MAKEHAM.A &&
      basis.B === ILLUSTRATIVE_MAKEHAM.B &&
      basis.c === ILLUSTRATIVE_MAKEHAM.c;
    notes.push(
      isIllustrative
        ? "Mortality is Scelo's ILLUSTRATIVE Gompertz–Makeham basis (A = 0.00022, B = 2.7e-6, c = 1.124), not a published standard table — swap in your own qx column or parameters before relying on the figures."
        : `Mortality from Gompertz–Makeham μx = A + B·cˣ with A = ${basis.A}, B = ${basis.B}, c = ${basis.c}${basis.multiplier && basis.multiplier !== 1 ? `, × ${basis.multiplier}` : ""}.`,
    );
    return {
      ages: ax,
      qx: out,
      notes,
      label: isIllustrative ? "Gompertz–Makeham (illustrative)" : "Gompertz–Makeham (custom)",
    };
  }
  if (!dataset) throw new Error("this mortality basis needs a dataset with the named columns");
  const need = (c: string) => {
    if (!dataset.columns.includes(c)) throw new Error(`column "${c}" is not in the dataset`);
  };
  need(basis.ageColumn);
  let byAge: Map<number, number>;
  let label: string;
  if (basis.kind === "qx-column") {
    need(basis.qxColumn);
    byAge = collectByAge(dataset, basis.ageColumn, basis.qxColumn, "mean");
    // Percent-shaped qx (e.g. 0.5 meaning 0.5 %) — detect values > 1.
    const maxV = Math.max(...byAge.values());
    if (maxV > 1) {
      for (const [k, v] of byAge) byAge.set(k, v / 100);
      notes.push(
        `\`${basis.qxColumn}\` looked like percentages (max ${round(maxV, 3)}) — divided by 100.`,
      );
    }
    label = `qx from \`${basis.qxColumn}\` by \`${basis.ageColumn}\``;
  } else if (basis.kind === "lx-column") {
    need(basis.lxColumn);
    const lx = collectByAge(dataset, basis.ageColumn, basis.lxColumn, "mean");
    byAge = new Map();
    const sorted = [...lx.keys()].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const l0 = lx.get(a) ?? 0;
      const l1 = lx.get(sorted[i + 1]) ?? 0;
      if (l0 > 0 && sorted[i + 1] === a + 1) byAge.set(a, Math.min(1, Math.max(0, 1 - l1 / l0)));
    }
    label = `qx derived from \`${basis.lxColumn}\` by \`${basis.ageColumn}\``;
    notes.push(
      "qx = 1 − l(x+1)/l(x) from the survivor column; the last age has no successor and is closed with qx = 1.",
    );
  } else {
    need(basis.deathsColumn);
    need(basis.exposureColumn);
    const d = collectByAge(dataset, basis.ageColumn, basis.deathsColumn, "sum");
    const e = collectByAge(dataset, basis.ageColumn, basis.exposureColumn, "sum");
    byAge = new Map();
    for (const [age, dd] of d) {
      const ee = e.get(age);
      if (ee && ee > 0) byAge.set(age, Math.min(1, Math.max(0, dd / ee)));
    }
    label = `crude qx = \`${basis.deathsColumn}\` / \`${basis.exposureColumn}\` by \`${basis.ageColumn}\``;
    notes.push(
      "Crude rates (deaths ÷ exposure) — ungraduated. Graduate before using for pricing or reserving.",
    );
  }
  if (byAge.size === 0)
    throw new Error("no usable (age, rate) pairs — check the columns are numeric");
  const filled = fillGaps([...byAge.keys()], byAge);
  if (filled.filled > 0)
    notes.push(
      `${filled.filled} missing age${filled.filled === 1 ? "" : "s"} interpolated linearly.`,
    );
  let ax = filled.ages;
  let qx = filled.v;
  if (ages?.from !== undefined || ages?.to !== undefined) {
    const from = ages.from ?? Number.NEGATIVE_INFINITY;
    const to = ages.to ?? Number.POSITIVE_INFINITY;
    const keep = ax.map((a, i) => [a, qx[i]] as const).filter(([a]) => a >= from && a <= to);
    ax = keep.map(([a]) => a);
    qx = keep.map(([, q]) => q);
    if (ax.length === 0) throw new Error("no ages left inside the requested range");
  }
  return { ages: ax, qx, notes, label };
}

// ─── Life table core ──────────────────────────────────────────────────────

interface LifeCols {
  ages: number[];
  qx: number[];
  px: number[];
  lx: number[];
  dx: number[];
  Lx: number[];
  Tx: number[];
  ex: number[];
}

function lifeColumns(q: QxTable, radix: number): LifeCols {
  const n = q.ages.length;
  const qx = q.qx.slice();
  // Close the table: the last age must carry qx = 1 for T_x / e_x to be finite.
  qx[n - 1] = 1;
  const px = qx.map((v) => 1 - v);
  const lx: number[] = [radix];
  const dx: number[] = [];
  for (let i = 0; i < n; i++) {
    dx.push(lx[i] * qx[i]);
    if (i < n - 1) lx.push(lx[i] - dx[i]);
  }
  const Lx = lx.map((l, i) => l - dx[i] / 2);
  const Tx: number[] = new Array(n).fill(0);
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) {
    acc += Lx[i];
    Tx[i] = acc;
  }
  const ex = lx.map((l, i) => (l > 0 ? Tx[i] / l : 0));
  return { ages: q.ages, qx, px, lx, dx, Lx, Tx, ex };
}

function commutationColumns(life: LifeCols, i: number) {
  const v = 1 / (1 + i);
  const n = life.ages.length;
  const x0 = life.ages[0];
  const vx = life.ages.map((a) => v ** (a - x0)); // v^(x − x0): relative to the first tabulated age
  const Dx = life.lx.map((l, k) => vx[k] * l);
  const Cx = life.dx.map((d, k) => vx[k] * v * d);
  const Nx = new Array<number>(n).fill(0);
  const Mx = new Array<number>(n).fill(0);
  const Rx = new Array<number>(n).fill(0);
  const Sx = new Array<number>(n).fill(0);
  let sN = 0;
  let sM = 0;
  for (let k = n - 1; k >= 0; k--) {
    sN += Dx[k];
    sM += Cx[k];
    Nx[k] = sN;
    Mx[k] = sM;
  }
  let sR = 0;
  let sS = 0;
  for (let k = n - 1; k >= 0; k--) {
    sR += Mx[k];
    sS += Nx[k];
    Rx[k] = sR;
    Sx[k] = sS;
  }
  return { v, vx, Dx, Cx, Nx, Mx, Rx, Sx };
}

// ─── Generators ───────────────────────────────────────────────────────────

function ds(name: string, columns: string[], rows: Row[]): Dataset {
  return { name, columns, rows: rows.slice(0, MAX_ROWS) };
}

function genLifeTable(spec: LifeTableSpec, dataset: Dataset | null): GeneratedTable {
  const radix = spec.radix ?? 100_000;
  const q = qxFromBasis(spec.basis, dataset, spec.ages);
  const L = lifeColumns(q, radix);
  const rows: Row[] = L.ages.map((age, k) => ({
    age,
    qx: round(L.qx[k], 6),
    px: round(L.px[k], 6),
    lx: round(L.lx[k], 2),
    dx: round(L.dx[k], 2),
    Lx: round(L.Lx[k], 2),
    Tx: round(L.Tx[k], 2),
    ex: round(L.ex[k], 3),
  }));
  const title = spec.title ?? `Life table · ${q.label}`;
  return {
    spec,
    title,
    dataset: ds(title, ["age", "qx", "px", "lx", "dx", "Lx", "Tx", "ex"], rows),
    notes: [
      ...q.notes,
      `Radix l(${L.ages[0]}) = ${radix.toLocaleString()}; table closed at age ${L.ages[L.ages.length - 1]} (qx set to 1). Lx uses the uniform-deaths approximation lx − ½dx.`,
    ],
    basisLabel: q.label,
  };
}

function genCommutation(spec: CommutationSpec, dataset: Dataset | null): GeneratedTable {
  const radix = spec.radix ?? 100_000;
  const q = qxFromBasis(spec.basis, dataset, spec.ages);
  const L = lifeColumns(q, radix);
  const C = commutationColumns(L, spec.interest);
  const rows: Row[] = L.ages.map((age, k) => ({
    age,
    lx: round(L.lx[k], 2),
    dx: round(L.dx[k], 2),
    "v^x": round(C.vx[k], 6),
    Dx: round(C.Dx[k], 2),
    Nx: round(C.Nx[k], 2),
    Cx: round(C.Cx[k], 2),
    Mx: round(C.Mx[k], 2),
    Rx: round(C.Rx[k], 2),
    Sx: round(C.Sx[k], 2),
  }));
  const title = spec.title ?? `Commutation functions · ${q.label} · i = ${pct(spec.interest)}`;
  return {
    spec,
    title,
    dataset: ds(title, ["age", "lx", "dx", "v^x", "Dx", "Nx", "Cx", "Mx", "Rx", "Sx"], rows),
    notes: [
      ...q.notes,
      `Interest ${pct(spec.interest)} p.a.; v^x is measured from the first tabulated age (${L.ages[0]}), so ratios (Nx/Dx, Mx/Dx …) are unaffected. Radix ${radix.toLocaleString()}.`,
    ],
    basisLabel: `${q.label} · i = ${pct(spec.interest)}`,
  };
}

function genAnnuityAssurance(spec: AnnuityAssuranceSpec, dataset: Dataset | null): GeneratedTable {
  const q = qxFromBasis(spec.basis, dataset, spec.ages);
  const L = lifeColumns(q, 100_000);
  const C = commutationColumns(L, spec.interest);
  const n = spec.term;
  const cols = ["age", "äx", "ax", "Ax"];
  if (n) cols.push(`äx:${n}`, `A¹x:${n}`, `${n}Ex`, `Ax:${n}`);
  const rows: Row[] = L.ages.map((age, k) => {
    const Dx = C.Dx[k];
    const row: Row = {
      age,
      äx: round(C.Nx[k] / Dx, 4),
      ax: round(C.Nx[k] / Dx - 1, 4),
      Ax: round(C.Mx[k] / Dx, 5),
    };
    if (n) {
      const kn = k + n;
      if (kn < L.ages.length) {
        row[`äx:${n}`] = round((C.Nx[k] - C.Nx[kn]) / Dx, 4);
        row[`A¹x:${n}`] = round((C.Mx[k] - C.Mx[kn]) / Dx, 5);
        row[`${n}Ex`] = round(C.Dx[kn] / Dx, 5);
        row[`Ax:${n}`] = round((C.Mx[k] - C.Mx[kn] + C.Dx[kn]) / Dx, 5);
      } else {
        row[`äx:${n}`] = null;
        row[`A¹x:${n}`] = null;
        row[`${n}Ex`] = null;
        row[`Ax:${n}`] = null;
      }
    }
    return row;
  });
  const title =
    spec.title ??
    `Annuity & assurance factors · ${q.label} · i = ${pct(spec.interest)}${n ? ` · n = ${n}` : ""}`;
  return {
    spec,
    title,
    dataset: ds(title, cols, rows),
    notes: [
      ...q.notes,
      `äx = Nx/Dx (annuity-due), ax = äx − 1, Ax = Mx/Dx (whole-life assurance, end-of-year benefit)${
        n
          ? `; äx:${n} = (Nx − Nx+${n})/Dx, A¹x:${n} = (Mx − Mx+${n})/Dx, ${n}Ex = Dx+${n}/Dx, Ax:${n} = A¹x:${n} + ${n}Ex. Blank where x + ${n} runs past the table.`
          : "."
      } Interest ${pct(spec.interest)}.`,
    ],
    basisLabel: `${q.label} · i = ${pct(spec.interest)}`,
  };
}

function genNetPremium(spec: NetPremiumSpec, dataset: Dataset | null): GeneratedTable {
  const terms = spec.terms && spec.terms.length > 0 ? spec.terms : [10, 15, 20, 25, 30];
  const from = spec.ages?.from ?? 20;
  const to = spec.ages?.to ?? 65;
  const step = spec.ages?.step ?? 5;
  // Need the mortality table to run past the oldest age + longest term.
  const maxTerm = Math.max(...terms);
  const q = qxFromBasis(
    spec.basis,
    dataset,
    spec.basis.kind === "gompertz-makeham"
      ? { from: Math.min(from, 20), to: Math.max(to + maxTerm, 110) }
      : undefined,
  );
  const L = lifeColumns(q, 100_000);
  const C = commutationColumns(L, spec.interest);
  const idx = new Map(L.ages.map((a, k) => [a, k] as const));
  const cols = [
    "age",
    ...(spec.product === "whole-life" ? ["whole life"] : terms.map((n) => `n=${n}`)),
  ];
  const rows: Row[] = [];
  const perThousand = (k: number, n: number | null): number | null => {
    const Dx = C.Dx[k];
    if (spec.product === "whole-life" || n === null) return round((1000 * C.Mx[k]) / C.Nx[k], 4);
    const kn = k + n;
    if (kn >= L.ages.length) return null;
    const adue = (C.Nx[k] - C.Nx[kn]) / Dx;
    const term = (C.Mx[k] - C.Mx[kn]) / Dx;
    const endow = term + C.Dx[kn] / Dx;
    return round((1000 * (spec.product === "endowment" ? endow : term)) / adue, 4);
  };
  for (let a = from; a <= to; a += step) {
    const k = idx.get(a);
    if (k === undefined) continue;
    const row: Row = { age: a };
    if (spec.product === "whole-life") row["whole life"] = perThousand(k, null);
    else for (const n of terms) row[`n=${n}`] = perThousand(k, n);
    rows.push(row);
  }
  if (rows.length === 0)
    throw new Error("no ages in the requested range are covered by the mortality basis");
  const productLabel =
    spec.product === "term"
      ? "term assurance"
      : spec.product === "endowment"
        ? "endowment"
        : "whole-life";
  const title =
    spec.title ??
    `Net premium per 1,000 SA · ${productLabel} · ${q.label} · i = ${pct(spec.interest)}`;
  return {
    spec,
    title,
    dataset: ds(title, cols, rows),
    notes: [
      ...q.notes,
      `Annual net (equivalence-principle) premium per 1,000 sum assured, payable in advance throughout the term (whole of life for whole-life): P = 1000·A/ä. No expense loading, no profit margin — a pure risk premium.`,
      `Interest ${pct(spec.interest)}.`,
    ],
    basisLabel: `${productLabel} · ${q.label} · i = ${pct(spec.interest)}`,
  };
}

function periodOf(v: CellValue): number | null {
  const n = num(v);
  if (n !== null) return Math.round(n);
  const s = String(v ?? "").trim();
  const m = /^(\d{4})/.exec(s);
  return m ? Number(m[1]) : null;
}

function genRunoff(spec: RunoffTriangleSpec, dataset: Dataset | null): GeneratedTable {
  if (!dataset) throw new Error("a run-off triangle needs a claims dataset");
  for (const c of [
    spec.originColumn,
    spec.valueColumn,
    spec.developmentColumn,
    spec.paymentColumn,
  ]) {
    if (c && !dataset.columns.includes(c)) throw new Error(`column "${c}" is not in the dataset`);
  }
  if (!spec.developmentColumn && !spec.paymentColumn)
    throw new Error("need a development-lag column or a payment-period column");
  const cells = new Map<number, Map<number, number>>();
  let skipped = 0;
  for (const r of dataset.rows) {
    const o = periodOf(r[spec.originColumn]);
    const v = num(r[spec.valueColumn]);
    let d: number | null;
    if (spec.developmentColumn) d = num(r[spec.developmentColumn]);
    else {
      const p = periodOf(r[spec.paymentColumn as string]);
      d = o !== null && p !== null ? p - o : null;
    }
    if (o === null || v === null || d === null || d < 0) {
      skipped += 1;
      continue;
    }
    const dev = Math.round(d);
    const row = cells.get(o) ?? new Map<number, number>();
    row.set(dev, (row.get(dev) ?? 0) + v);
    cells.set(o, row);
  }
  if (cells.size === 0) throw new Error("no (origin, development, value) triples could be read");
  const origins = [...cells.keys()].sort((a, b) => a - b);
  const devs = [...new Set([...cells.values()].flatMap((m) => [...m.keys()]))].sort(
    (a, b) => a - b,
  );
  // Was the input already cumulative? Heuristic: values never decrease along
  // development for most origins.
  const cumulative = spec.cumulative ?? true;
  const cols = ["origin", ...devs.map((d) => `dev ${d}`)];
  const rows: Row[] = origins.map((o) => {
    const m = cells.get(o) as Map<number, number>;
    const row: Row = { origin: o };
    let acc = 0;
    let seen = false;
    for (const d of devs) {
      const inc = m.get(d);
      if (inc === undefined) {
        // Beyond the diagonal → blank; inside with no claims → 0 (cumulative carries).
        row[`dev ${d}`] = seen && cumulative && d < Math.max(...m.keys()) ? round(acc, 2) : null;
        continue;
      }
      seen = true;
      acc += inc;
      row[`dev ${d}`] = round(cumulative ? acc : inc, 2);
    }
    return row;
  });
  const title =
    spec.title ??
    `${cumulative ? "Cumulative" : "Incremental"} run-off triangle · ${spec.valueColumn} by ${spec.originColumn} × development`;
  return {
    spec,
    title,
    dataset: ds(title, cols, rows),
    notes: [
      `${origins.length} origin periods × ${devs.length} development lags, summed from ${dataset.rows.length.toLocaleString()} rows${skipped ? ` (${skipped} rows skipped: unreadable origin / lag / value)` : ""}. Values are treated as INCREMENTAL amounts per row and ${cumulative ? "accumulated along development" : "left incremental"}; if your file already holds cumulative figures, ask for the incremental triangle instead.`,
      spec.paymentColumn
        ? `Development lag = ${spec.paymentColumn} − ${spec.originColumn} (period difference).`
        : `Development lag read from \`${spec.developmentColumn}\`.`,
    ],
    basisLabel: `${spec.valueColumn} · ${spec.originColumn} × dev`,
  };
}

function genDiscountCurve(spec: DiscountCurveSpec, dataset: Dataset | null): GeneratedTable {
  let points: Array<{ tenor: number; rate: number }> = [];
  let label: string;
  const notes: string[] = [];
  if (spec.points && spec.points.length > 0) {
    points = spec.points.slice();
    label = `${points.length} quoted tenors`;
  } else if (spec.tenorColumn && spec.rateColumn) {
    if (!dataset) throw new Error("a rate curve from columns needs a dataset");
    for (const c of [spec.tenorColumn, spec.rateColumn]) {
      if (!dataset.columns.includes(c)) throw new Error(`column "${c}" is not in the dataset`);
    }
    const byTenor = collectByAge(dataset, spec.tenorColumn, spec.rateColumn, "mean");
    points = [...byTenor.entries()]
      .map(([tenor, rate]) => ({ tenor, rate }))
      .sort((a, b) => a.tenor - b.tenor);
    const maxR = Math.max(...points.map((p) => p.rate));
    if (maxR > 1) {
      points = points.map((p) => ({ tenor: p.tenor, rate: p.rate / 100 }));
      notes.push(`\`${spec.rateColumn}\` looked like percentages — divided by 100.`);
    }
    label = `\`${spec.rateColumn}\` by \`${spec.tenorColumn}\``;
  } else {
    const r = spec.flatRate ?? 0.04;
    points = [{ tenor: 1, rate: r }];
    label = `flat ${pct(r)}`;
    notes.push(`Flat ${pct(r)} curve — every tenor discounts at the same rate.`);
  }
  if (points.length === 0) throw new Error("no (tenor, rate) points");
  const maxTenor = spec.maxTenor ?? Math.max(30, ...points.map((p) => Math.round(p.tenor)));
  const zero = (t: number): number => {
    if (points.length === 1) return points[0].rate;
    if (t <= points[0].tenor) return points[0].rate;
    const last = points[points.length - 1];
    if (t >= last.tenor) return last.rate;
    for (let k = 0; k < points.length - 1; k++) {
      const a = points[k];
      const b = points[k + 1];
      if (t >= a.tenor && t <= b.tenor) {
        const w = (t - a.tenor) / (b.tenor - a.tenor);
        return a.rate + w * (b.rate - a.rate);
      }
    }
    return last.rate;
  };
  const rows: Row[] = [];
  let prevDf = 1;
  let annuity = 0;
  for (let t = 1; t <= maxTenor; t++) {
    const z = zero(t);
    const df = (1 + z) ** -t;
    const fwd = prevDf / df - 1;
    annuity += df;
    rows.push({
      tenor: t,
      "zero rate": round(z, 6),
      "discount factor": round(df, 6),
      "1y forward": round(fwd, 6),
      "annuity-certain a_n": round(annuity, 6),
    });
    prevDf = df;
  }
  const title = spec.title ?? `Discount curve · ${label} · to ${maxTenor}y`;
  return {
    spec,
    title,
    dataset: ds(
      title,
      ["tenor", "zero rate", "discount factor", "1y forward", "annuity-certain a_n"],
      rows,
    ),
    notes: [
      ...notes,
      "Zero rates are annual-compound; linear interpolation between quoted tenors and flat extrapolation beyond the last one (use the Smith-Wilson tool for a UFR extrapolation). Discount factor v_t = (1+z_t)^−t; forward f(t−1,t) = v_{t−1}/v_t − 1; a_n = Σ v_t.",
    ],
    basisLabel: label,
  };
}

function genExposureAe(spec: ExposureAeSpec, dataset: Dataset | null): GeneratedTable {
  if (!dataset) throw new Error("an A/E table needs an experience dataset");
  for (const c of [spec.ageColumn, spec.deathsColumn, spec.exposureColumn]) {
    if (!dataset.columns.includes(c)) throw new Error(`column "${c}" is not in the dataset`);
  }
  const width = spec.bandWidth ?? 5;
  const deaths = collectByAge(dataset, spec.ageColumn, spec.deathsColumn, "sum");
  const expo = collectByAge(dataset, spec.ageColumn, spec.exposureColumn, "sum");
  const ages = [...expo.keys()].sort((a, b) => a - b);
  if (ages.length === 0) throw new Error("no exposure by age could be read");
  const q = qxFromBasis(spec.expected, dataset, { from: ages[0], to: ages[ages.length - 1] });
  const qAt = new Map(q.ages.map((a, k) => [a, q.qx[k]] as const));
  const bands = new Map<number, { e: number; d: number; x: number }>();
  for (const a of ages) {
    const band = Math.floor(a / width) * width;
    const cur = bands.get(band) ?? { e: 0, d: 0, x: 0 };
    const e = expo.get(a) ?? 0;
    cur.e += e;
    cur.d += deaths.get(a) ?? 0;
    cur.x += e * (qAt.get(a) ?? 0);
    bands.set(band, cur);
  }
  const rows: Row[] = [];
  let tE = 0;
  let tD = 0;
  let tX = 0;
  for (const [band, v] of [...bands.entries()].sort((a, b) => a[0] - b[0])) {
    tE += v.e;
    tD += v.d;
    tX += v.x;
    rows.push({
      "age band": `${band}–${band + width - 1}`,
      exposure: round(v.e, 2),
      "actual deaths": round(v.d, 2),
      "expected deaths": round(v.x, 2),
      "A/E": v.x > 0 ? round(v.d / v.x, 3) : null,
      "crude qx": v.e > 0 ? round(v.d / v.e, 6) : null,
    });
  }
  rows.push({
    "age band": "total",
    exposure: round(tE, 2),
    "actual deaths": round(tD, 2),
    "expected deaths": round(tX, 2),
    "A/E": tX > 0 ? round(tD / tX, 3) : null,
    "crude qx": tE > 0 ? round(tD / tE, 6) : null,
  });
  const title =
    spec.title ??
    `Actual vs expected · ${spec.deathsColumn} / ${spec.exposureColumn} vs ${q.label}`;
  return {
    spec,
    title,
    dataset: ds(
      title,
      ["age band", "exposure", "actual deaths", "expected deaths", "A/E", "crude qx"],
      rows,
    ),
    notes: [
      ...q.notes,
      `Expected deaths = exposure × qx(expected basis) at each age, summed into ${width}-year bands. A/E > 1 means heavier mortality than the basis.`,
    ],
    basisLabel: `expected: ${q.label}`,
  };
}

function genModelPoints(spec: ModelPointsSpec, dataset: Dataset | null): GeneratedTable {
  if (!dataset) throw new Error("model points need a policy dataset");
  for (const c of [
    spec.ageColumn,
    spec.sexColumn,
    spec.termColumn,
    spec.sumAssuredColumn,
    spec.premiumColumn,
  ]) {
    if (c && !dataset.columns.includes(c)) throw new Error(`column "${c}" is not in the dataset`);
  }
  const width = spec.bandWidth ?? 5;
  type Acc = { n: number; sa: number; prem: number; ageSum: number };
  const groups = new Map<string, Acc & { band: number; sex: string; term: string }>();
  for (const r of dataset.rows) {
    const a = num(r[spec.ageColumn]);
    if (a === null) continue;
    const band = Math.floor(a / width) * width;
    const sex = spec.sexColumn
      ? String(r[spec.sexColumn] ?? "")
          .trim()
          .toUpperCase()
          .slice(0, 1) || "?"
      : "all";
    const term = spec.termColumn ? String(num(r[spec.termColumn]) ?? "?") : "all";
    const key = `${band}|${sex}|${term}`;
    const g = groups.get(key) ?? { n: 0, sa: 0, prem: 0, ageSum: 0, band, sex, term };
    g.n += 1;
    g.sa += spec.sumAssuredColumn ? (num(r[spec.sumAssuredColumn]) ?? 0) : 0;
    g.prem += spec.premiumColumn ? (num(r[spec.premiumColumn]) ?? 0) : 0;
    g.ageSum += a;
    groups.set(key, g);
  }
  if (groups.size === 0) throw new Error("no policies could be grouped");
  const cols = [
    "model_point_id",
    "age_band",
    "age_at_entry",
    "sex",
    "policy_term",
    "policy_count",
    "sum_assured",
    "premium_pp",
  ];
  const rows: Row[] = [...groups.values()]
    .sort(
      (a, b) => a.band - b.band || a.sex.localeCompare(b.sex) || Number(a.term) - Number(b.term),
    )
    .map((g, i) => ({
      model_point_id: `MP${String(i + 1).padStart(4, "0")}`,
      age_band: `${g.band}–${g.band + width - 1}`,
      age_at_entry: Math.round(g.ageSum / g.n),
      sex: g.sex,
      policy_term: g.term === "all" ? null : Number(g.term),
      policy_count: g.n,
      sum_assured: round(g.sa, 2),
      premium_pp: g.n > 0 ? round(g.prem / g.n, 2) : null,
    }));
  const title =
    spec.title ??
    `Model points · ${dataset.rows.length.toLocaleString()} policies → ${rows.length} groups`;
  return {
    spec,
    title,
    dataset: ds(title, cols, rows),
    notes: [
      `Grouped by ${width}-year age band${spec.sexColumn ? " × sex" : ""}${spec.termColumn ? " × policy term" : ""}: policy_count = policies in the group, sum_assured = total, premium_pp = mean per policy, age_at_entry = group mean (rounded). Shape matches lifelib's basic_term model-point table, so it feeds BasicTerm / IFRS 17 / SCR runs directly.`,
      "Grouping loses within-band heterogeneity — validate a liability metric on grouped vs seriatim before relying on it (lifelib's cluster library does this by k-means on cash flows).",
    ],
    basisLabel: `${width}y bands`,
  };
}

export function generateActuarialTable(
  spec: ActuarialTableSpec,
  dataset: Dataset | null,
): GeneratedTable {
  switch (spec.kind) {
    case "life-table":
      return genLifeTable(spec, dataset);
    case "commutation":
      return genCommutation(spec, dataset);
    case "annuity-assurance":
      return genAnnuityAssurance(spec, dataset);
    case "net-premium":
      return genNetPremium(spec, dataset);
    case "runoff-triangle":
      return genRunoff(spec, dataset);
    case "discount-curve":
      return genDiscountCurve(spec, dataset);
    case "exposure-ae":
      return genExposureAe(spec, dataset);
    case "model-points":
      return genModelPoints(spec, dataset);
    default: {
      const never: never = spec;
      throw new Error(`unknown table kind ${(never as { kind: string }).kind}`);
    }
  }
}

/** Light validation of an untrusted (LLM-emitted / JSON) spec. Returns a
 *  typed spec or throws with a message the chat can show. */
export function coerceTableSpec(raw: unknown): ActuarialTableSpec {
  if (!raw || typeof raw !== "object") throw new Error("table spec must be a JSON object");
  const o = raw as Record<string, unknown>;
  const kind = String(o.kind ?? o.type ?? o.table ?? "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-") as ActuarialTableKind;
  if (!ACTUARIAL_TABLE_KINDS.includes(kind)) {
    throw new Error(
      `unknown table kind "${String(o.kind ?? o.type ?? "")}" — expected one of ${ACTUARIAL_TABLE_KINDS.join(", ")}`,
    );
  }
  const n = (v: unknown, fallback?: number): number | undefined => {
    if (v === undefined || v === null || v === "") return fallback;
    const x = typeof v === "number" ? v : Number(String(v).replace("%", ""));
    return Number.isFinite(x) ? x : fallback;
  };
  const s = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const interest = (v: unknown): number => {
    const x = n(v, 0.04) as number;
    return x > 1 ? x / 100 : x; // "4" → 0.04
  };
  const ages = (v: unknown): AgeRange | undefined => {
    if (!v || typeof v !== "object") return undefined;
    const a = v as Record<string, unknown>;
    const from = n(a.from ?? a.min ?? a.start);
    const to = n(a.to ?? a.max ?? a.end);
    return from === undefined && to === undefined ? undefined : { from, to };
  };
  const basis = (v: unknown): MortalityBasis => {
    if (!v || typeof v !== "object") return { kind: "gompertz-makeham", ...ILLUSTRATIVE_MAKEHAM };
    const b = v as Record<string, unknown>;
    const k = String(b.kind ?? b.type ?? "").toLowerCase();
    if (
      k.includes("gompertz") ||
      k.includes("makeham") ||
      k === "parametric" ||
      k === "illustrative"
    ) {
      return {
        kind: "gompertz-makeham",
        A: n(b.A ?? b.a, ILLUSTRATIVE_MAKEHAM.A) as number,
        B: n(b.B ?? b.b, ILLUSTRATIVE_MAKEHAM.B) as number,
        c: n(b.c ?? b.C, ILLUSTRATIVE_MAKEHAM.c) as number,
        multiplier: n(b.multiplier),
      };
    }
    if (k === "lx-column" || (b.lxColumn && !b.qxColumn)) {
      return {
        kind: "lx-column",
        ageColumn: s(b.ageColumn) ?? "age",
        lxColumn: s(b.lxColumn) ?? "lx",
      };
    }
    if (k === "deaths-exposure" || (b.deathsColumn && b.exposureColumn)) {
      return {
        kind: "deaths-exposure",
        ageColumn: s(b.ageColumn) ?? "age",
        deathsColumn: s(b.deathsColumn) ?? "deaths",
        exposureColumn: s(b.exposureColumn) ?? "exposure",
      };
    }
    if (k === "qx-column" || b.qxColumn) {
      return {
        kind: "qx-column",
        ageColumn: s(b.ageColumn) ?? "age",
        qxColumn: s(b.qxColumn) ?? "qx",
      };
    }
    return { kind: "gompertz-makeham", ...ILLUSTRATIVE_MAKEHAM };
  };
  const title = s(o.title);
  switch (kind) {
    case "life-table":
      return { kind, title, basis: basis(o.basis), ages: ages(o.ages), radix: n(o.radix) };
    case "commutation":
      return {
        kind,
        title,
        basis: basis(o.basis),
        interest: interest(o.interest ?? o.i),
        ages: ages(o.ages),
        radix: n(o.radix),
      };
    case "annuity-assurance":
      return {
        kind,
        title,
        basis: basis(o.basis),
        interest: interest(o.interest ?? o.i),
        term: n(o.term ?? o.n),
        ages: ages(o.ages),
      };
    case "net-premium": {
      const p = String(o.product ?? "term").toLowerCase();
      const product = p.includes("endow")
        ? "endowment"
        : p.includes("whole")
          ? "whole-life"
          : "term";
      const terms = Array.isArray(o.terms)
        ? o.terms.map((t) => n(t)).filter((t): t is number => t !== undefined && t > 0)
        : undefined;
      const a = ages(o.ages) as (AgeRange & { step?: number }) | undefined;
      const step =
        o.ages && typeof o.ages === "object"
          ? n((o.ages as Record<string, unknown>).step)
          : undefined;
      return {
        kind,
        title,
        basis: basis(o.basis),
        interest: interest(o.interest ?? o.i),
        product,
        ages: a ? { ...a, step } : step ? { step } : undefined,
        terms,
      };
    }
    case "runoff-triangle": {
      const originColumn = s(o.originColumn);
      const valueColumn = s(o.valueColumn);
      if (!originColumn || !valueColumn)
        throw new Error("runoff-triangle needs originColumn and valueColumn");
      return {
        kind,
        title,
        originColumn,
        valueColumn,
        developmentColumn: s(o.developmentColumn),
        paymentColumn: s(o.paymentColumn),
        cumulative: typeof o.cumulative === "boolean" ? o.cumulative : undefined,
      };
    }
    case "discount-curve": {
      const points = Array.isArray(o.points)
        ? o.points
            .map((p) => {
              const q = p as Record<string, unknown>;
              const tenor = n(q.tenor ?? q.t ?? q.maturity);
              const rate = n(q.rate ?? q.zero ?? q.r);
              return tenor !== undefined && rate !== undefined
                ? { tenor, rate: rate > 1 ? rate / 100 : rate }
                : null;
            })
            .filter((p): p is { tenor: number; rate: number } => p !== null)
        : undefined;
      const flat = n(o.flatRate ?? o.rate);
      return {
        kind,
        title,
        points: points && points.length > 0 ? points : undefined,
        tenorColumn: s(o.tenorColumn),
        rateColumn: s(o.rateColumn),
        flatRate: flat !== undefined ? (flat > 1 ? flat / 100 : flat) : undefined,
        maxTenor: n(o.maxTenor),
      };
    }
    case "exposure-ae": {
      const ageColumn = s(o.ageColumn) ?? "age";
      const deathsColumn = s(o.deathsColumn);
      const exposureColumn = s(o.exposureColumn);
      if (!deathsColumn || !exposureColumn)
        throw new Error("exposure-ae needs deathsColumn and exposureColumn");
      return {
        kind,
        title,
        ageColumn,
        deathsColumn,
        exposureColumn,
        expected: basis(o.expected ?? o.basis),
        bandWidth: n(o.bandWidth),
      };
    }
    case "model-points": {
      const ageColumn = s(o.ageColumn);
      if (!ageColumn) throw new Error("model-points needs ageColumn");
      return {
        kind,
        title,
        ageColumn,
        sexColumn: s(o.sexColumn),
        termColumn: s(o.termColumn),
        sumAssuredColumn: s(o.sumAssuredColumn),
        premiumColumn: s(o.premiumColumn),
        bandWidth: n(o.bandWidth),
      };
    }
  }
  throw new Error("unreachable");
}

// ─── Suggestions: read the data and/or the prompt ─────────────────────────

interface Signals {
  age: string | null;
  qx: string | null;
  lx: string | null;
  deaths: string | null;
  exposure: string | null;
  origin: string | null;
  development: string | null;
  payment: string | null;
  value: string | null;
  tenor: string | null;
  rate: string | null;
  sex: string | null;
  policyTerm: string | null;
  sumAssured: string | null;
  premium: string | null;
}

export function detectTableSignals(dataset: Dataset | null): Signals {
  const cols = dataset?.columns ?? [];
  const f = (a: readonly string[]) => findColumn(cols, a);
  const age = f(COLUMN_ALIASES.age);
  // `rate` is too generic to be qx unless there's an age column and no tenor.
  const tenor = f(COLUMN_ALIASES.tenor);
  const rate = f(COLUMN_ALIASES.rate);
  let qx = f(COLUMN_ALIASES.qx.filter((a) => a !== "rate"));
  if (!qx && age && !tenor && rate) qx = rate;
  return {
    age,
    qx,
    lx: f(COLUMN_ALIASES.lx),
    deaths: f(COLUMN_ALIASES.deaths),
    exposure: f(COLUMN_ALIASES.exposure),
    origin: f(COLUMN_ALIASES.origin),
    development: f(COLUMN_ALIASES.development),
    payment: f(COLUMN_ALIASES.payment),
    value: f(COLUMN_ALIASES.value),
    tenor: age && tenor === age ? null : tenor,
    rate: qx === rate ? null : rate,
    sex: f(COLUMN_ALIASES.sex),
    policyTerm: f(COLUMN_ALIASES.policyTerm),
    sumAssured: f(COLUMN_ALIASES.sumAssured),
    premium: f(COLUMN_ALIASES.premium),
  };
}

function q(s: string): string {
  return `\`${s}\``;
}

/** The illustrative Gompertz–Makeham basis, spelled the way the prompt
 *  parser recognises ("illustrative Gompertz-Makeham basis"). */
const ILLUSTRATIVE_WORDS = "the illustrative Gompertz-Makeham basis";

export function suggestActuarialTables(
  dataset: Dataset | null,
  prompt?: string | null,
): TableSuggestion[] {
  const out: TableSuggestion[] = [];
  const sig = detectTableSignals(dataset);
  const p = (prompt ?? "").toLowerCase();
  const rows = dataset?.rows.length ?? 0;
  const push = (t: Omit<TableSuggestion, "id">) => {
    if (out.some((o) => o.kind === t.kind && o.title === t.title)) return;
    out.push({ id: `${t.kind}:${out.length}`, ...t });
  };
  const wantsLife =
    /\b(life[- ]?table|mortality table|survival table|lx|qx|life expectancy)\b/.test(p);
  const wantsComm = /\bcommutation|\b[dncmrs]x\b/.test(p);
  const wantsAnn = /\bannuit|assurance factor|insurance factor|\bax\b|äx|\bAx\b/.test(p);
  const wantsPrem = /\bpremium (table|rates?)|net premium|premium per/.test(p);
  const wantsTri =
    /\btriangle|run[- ]?off|development (table|pattern)|chain[- ]?ladder|reserving/.test(p);
  const wantsCurve =
    /\b(discount|yield|zero|spot|forward) (curve|factor|rate)s?|discount factors?|term structure/.test(
      p,
    );
  const wantsAe =
    /\bactual (vs\.?|versus|to|against) expected|\ba\/e\b|experience (study|analysis|table)/.test(
      p,
    );
  const wantsMp = /\bmodel[- ]?points?|compress|group(ed)? polic/.test(p);
  const interest = parseInterest(p) ?? 0.04;

  // ── mortality-shaped data ────────────────────────────────────────────
  const mortBasis: MortalityBasis | null =
    sig.age && sig.qx
      ? { kind: "qx-column", ageColumn: sig.age, qxColumn: sig.qx }
      : sig.age && sig.lx
        ? { kind: "lx-column", ageColumn: sig.age, lxColumn: sig.lx }
        : sig.age && sig.deaths && sig.exposure
          ? {
              kind: "deaths-exposure",
              ageColumn: sig.age,
              deathsColumn: sig.deaths,
              exposureColumn: sig.exposure,
            }
          : null;
  if (mortBasis) {
    const basisWords =
      mortBasis.kind === "qx-column"
        ? `from ${q(mortBasis.ageColumn)} and ${q(mortBasis.qxColumn)}`
        : mortBasis.kind === "lx-column"
          ? `from ${q(mortBasis.ageColumn)} and ${q(mortBasis.lxColumn)}`
          : `from ${q(mortBasis.ageColumn)}, ${q((mortBasis as { deathsColumn: string }).deathsColumn)} and ${q((mortBasis as { exposureColumn: string }).exposureColumn)}`;
    const why =
      mortBasis.kind === "qx-column"
        ? `The file has an age column (${q(mortBasis.ageColumn)}) with mortality rates (${q(mortBasis.qxColumn)}) — that is a life table waiting to be completed.`
        : mortBasis.kind === "lx-column"
          ? `The file carries survivors by age (${q(mortBasis.lxColumn)}); qx, dx and eₓ follow directly.`
          : `Deaths and exposure by age give crude qx — a life table and an A/E check are the natural next tables.`;
    push({
      kind: "life-table",
      title: "Life table (qx · lx · dx · Lx · Tx · eₓ)",
      why,
      prompt: `Build a life table ${basisWords} with radix 100,000.`,
      spec: { kind: "life-table", basis: mortBasis, radix: 100_000 },
      score: 0.95,
    });
    push({
      kind: "commutation",
      title: `Commutation functions at ${pct(interest)}`,
      why: "Once qx is tabulated, Dx / Nx / Mx at a valuation rate turn it into a pricing and reserving table.",
      prompt: `Build a commutation table ${basisWords} at ${pct(interest)} interest.`,
      spec: { kind: "commutation", basis: mortBasis, interest },
      score: 0.8,
    });
    push({
      kind: "annuity-assurance",
      title: `Annuity & assurance factors at ${pct(interest)}`,
      why: "äx, ax and Ax by age from the same basis — the factors behind any life-contingent price or reserve.",
      prompt: `Build an annuity and assurance factor table ${basisWords} at ${pct(interest)} interest with a 20-year term.`,
      spec: { kind: "annuity-assurance", basis: mortBasis, interest, term: 20 },
      score: 0.7,
    });
    if (mortBasis.kind === "deaths-exposure") {
      push({
        kind: "exposure-ae",
        title: "Actual vs expected by age band",
        why: `Actual deaths (${q(mortBasis.deathsColumn)}) against expected on ${ILLUSTRATIVE_WORDS} — the experience-study view of the same data.`,
        prompt: `Build an actual versus expected table from ${q(mortBasis.ageColumn)}, ${q(mortBasis.deathsColumn)} and ${q(mortBasis.exposureColumn)} against ${ILLUSTRATIVE_WORDS} in 5-year bands.`,
        spec: {
          kind: "exposure-ae",
          ageColumn: mortBasis.ageColumn,
          deathsColumn: mortBasis.deathsColumn,
          exposureColumn: mortBasis.exposureColumn,
          expected: { kind: "gompertz-makeham", ...ILLUSTRATIVE_MAKEHAM },
          bandWidth: 5,
        },
        score: 0.75,
      });
    }
  }

  // ── claims data → triangle ───────────────────────────────────────────
  if (sig.origin && sig.value && (sig.development || sig.payment)) {
    const lag = sig.development
      ? `${q(sig.development)}`
      : `${q(sig.payment as string)} minus ${q(sig.origin)}`;
    push({
      kind: "runoff-triangle",
      title: "Cumulative run-off triangle",
      why: `Origin (${q(sig.origin)}), development lag (${lag}) and amounts (${q(sig.value)}) are the three legs of a reserving triangle — build it once and every chain-ladder / Mack / BF run reads from it.`,
      prompt: `Build a cumulative run-off triangle of ${q(sig.value)} by ${q(sig.origin)} and ${sig.development ? q(sig.development) : `payment period ${q(sig.payment as string)}`}.`,
      spec: {
        kind: "runoff-triangle",
        originColumn: sig.origin,
        developmentColumn: sig.development ?? undefined,
        paymentColumn: sig.development ? undefined : (sig.payment ?? undefined),
        valueColumn: sig.value,
        cumulative: true,
      },
      score: 0.9,
    });
  }

  // ── policy file → model points + premium table ───────────────────────
  if (sig.age && sig.sumAssured && sig.policyTerm && rows > 0) {
    push({
      kind: "model-points",
      title: "Model-point table (grouped policies)",
      why: `A policy-level file (${q(sig.age)}, ${q(sig.sumAssured)}, ${q(sig.policyTerm)}${sig.sex ? `, ${q(sig.sex)}` : ""}) compresses into lifelib-shaped model points by age band${sig.sex ? " × sex" : ""} × term.`,
      prompt: `Build a model point table from ${q(sig.age)}${sig.sex ? `, ${q(sig.sex)}` : ""}, ${q(sig.policyTerm)} and ${q(sig.sumAssured)} in 5-year age bands.`,
      spec: {
        kind: "model-points",
        ageColumn: sig.age,
        sexColumn: sig.sex ?? undefined,
        termColumn: sig.policyTerm,
        sumAssuredColumn: sig.sumAssured,
        premiumColumn: sig.premium ?? undefined,
        bandWidth: 5,
      },
      score: 0.85,
    });
    push({
      kind: "net-premium",
      title: `Net premium table (term assurance, ${pct(interest)})`,
      why: `The book's issue ages and terms suggest a per-1,000 net premium grid on ${ILLUSTRATIVE_WORDS} to sanity-check ${sig.premium ? q(sig.premium) : "the premiums"}.`,
      prompt: `Build a net premium table for term assurance on ${ILLUSTRATIVE_WORDS} at ${pct(interest)} interest for ages 20 to 65 and terms 10, 15, 20, 25, 30.`,
      spec: {
        kind: "net-premium",
        basis: { kind: "gompertz-makeham", ...ILLUSTRATIVE_MAKEHAM },
        interest,
        product: "term",
        ages: { from: 20, to: 65, step: 5 },
        terms: [10, 15, 20, 25, 30],
      },
      score: 0.6,
    });
  }

  // ── rates data → discount curve ──────────────────────────────────────
  if (sig.tenor && sig.rate) {
    push({
      kind: "discount-curve",
      title: "Discount factors & forwards from the quoted curve",
      why: `${q(sig.tenor)} and ${q(sig.rate)} read as a term structure — tabulate v_t, forwards and annuity-certain factors.`,
      prompt: `Build a discount curve table from ${q(sig.tenor)} and ${q(sig.rate)} out to 60 years.`,
      spec: { kind: "discount-curve", tenorColumn: sig.tenor, rateColumn: sig.rate, maxTenor: 60 },
      score: 0.85,
    });
  }

  // ── prompt-driven (works with no data at all) ────────────────────────
  const illustrative: MortalityBasis = { kind: "gompertz-makeham", ...ILLUSTRATIVE_MAKEHAM };
  const noteNoData = dataset
    ? ""
    : " (no mortality columns loaded — uses the illustrative basis; drop your own qx in to replace it)";
  if (wantsLife && !mortBasis) {
    push({
      kind: "life-table",
      title: "Life table on the illustrative basis",
      why: `You asked about a life table${noteNoData}.`,
      prompt: `Build a life table on ${ILLUSTRATIVE_WORDS} from age 20 to 110 with radix 100,000.`,
      spec: {
        kind: "life-table",
        basis: illustrative,
        ages: { from: 20, to: 110 },
        radix: 100_000,
      },
      score: 0.7,
    });
  }
  if (wantsComm && !mortBasis) {
    push({
      kind: "commutation",
      title: `Commutation functions at ${pct(interest)} (illustrative basis)`,
      why: `You asked about commutation functions${noteNoData}.`,
      prompt: `Build a commutation table on ${ILLUSTRATIVE_WORDS} at ${pct(interest)} interest from age 20 to 110.`,
      spec: { kind: "commutation", basis: illustrative, interest, ages: { from: 20, to: 110 } },
      score: 0.7,
    });
  }
  if (wantsAnn && !mortBasis) {
    const term = parseTerm(p) ?? 20;
    push({
      kind: "annuity-assurance",
      title: `Annuity & assurance factors at ${pct(interest)} (illustrative basis)`,
      why: `You asked about annuity / assurance factors${noteNoData}.`,
      prompt: `Build an annuity and assurance factor table on ${ILLUSTRATIVE_WORDS} at ${pct(interest)} interest with a ${term}-year term.`,
      spec: {
        kind: "annuity-assurance",
        basis: illustrative,
        interest,
        term,
        ages: { from: 20, to: 110 },
      },
      score: 0.7,
    });
  }
  if (wantsPrem && !(sig.age && sig.sumAssured && sig.policyTerm)) {
    const product = /endow/.test(p) ? "endowment" : /whole[- ]life/.test(p) ? "whole-life" : "term";
    push({
      kind: "net-premium",
      title: `Net premium table (${product}, ${pct(interest)})`,
      why: `You asked about premium rates${noteNoData}.`,
      prompt: `Build a net premium table for ${product === "whole-life" ? "whole life" : product === "endowment" ? "endowment" : "term assurance"} on ${ILLUSTRATIVE_WORDS} at ${pct(interest)} interest for ages 20 to 65 and terms 10, 15, 20, 25, 30.`,
      spec: {
        kind: "net-premium",
        basis: mortBasis ?? illustrative,
        interest,
        product,
        ages: { from: 20, to: 65, step: 5 },
        terms: [10, 15, 20, 25, 30],
      },
      score: 0.65,
    });
  }
  if (wantsCurve && !(sig.tenor && sig.rate)) {
    push({
      kind: "discount-curve",
      title: `Flat ${pct(interest)} discount table`,
      why: "You asked about discount factors; with no rate columns loaded this tabulates a flat curve you can edit.",
      prompt: `Build a discount curve table at a flat ${pct(interest)} out to 60 years.`,
      spec: { kind: "discount-curve", flatRate: interest, maxTenor: 60 },
      score: 0.6,
    });
  }
  if (wantsTri && !(sig.origin && sig.value)) {
    push({
      kind: "runoff-triangle",
      title: "Run-off triangle (needs origin, lag and amount columns)",
      why: "You asked about a triangle; load a claims file with origin period, development lag (or payment period) and paid/incurred amounts and I'll build it.",
      prompt: "Build a cumulative run-off triangle of `paid` by `origin` and `development`.",
      spec: {
        kind: "runoff-triangle",
        originColumn: "origin",
        developmentColumn: "development",
        valueColumn: "paid",
        cumulative: true,
      },
      score: 0.3,
    });
  }
  if (wantsAe && !(sig.age && sig.deaths && sig.exposure)) {
    push({
      kind: "exposure-ae",
      title: "Actual vs expected (needs age, deaths, exposure)",
      why: "An A/E study needs deaths and exposure by age — load an experience file and this becomes one click.",
      prompt: `Build an actual versus expected table from \`age\`, \`deaths\` and \`exposure\` against ${ILLUSTRATIVE_WORDS} in 5-year bands.`,
      spec: {
        kind: "exposure-ae",
        ageColumn: "age",
        deathsColumn: "deaths",
        exposureColumn: "exposure",
        expected: illustrative,
        bandWidth: 5,
      },
      score: 0.3,
    });
  }
  if (wantsMp && !(sig.age && sig.sumAssured && sig.policyTerm)) {
    push({
      kind: "model-points",
      title: "Model points (needs a policy file)",
      why: "Grouping needs policy-level rows with age, term and sum assured.",
      prompt:
        "Build a model point table from `age_at_entry`, `sex`, `policy_term` and `sum_assured` in 5-year age bands.",
      spec: {
        kind: "model-points",
        ageColumn: "age_at_entry",
        sexColumn: "sex",
        termColumn: "policy_term",
        sumAssuredColumn: "sum_assured",
        bandWidth: 5,
      },
      score: 0.3,
    });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, 6);
}

// ─── Prompt → spec ─────────────────────────────────────────────────────────

function parseInterest(t: string): number | null {
  const m =
    /(\d+(?:\.\d+)?)\s*%/.exec(t) ??
    /\b(?:i|interest|rate|at)\s*(?:=|of|:)?\s*(0?\.\d+)\b/.exec(t) ??
    /\b(\d+(?:\.\d+)?)\s*(?:per ?cent|percent)\b/.exec(t);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  return v > 1 ? v / 100 : v;
}

function parseTerm(t: string): number | null {
  const m =
    /\b(\d{1,3})[- ]?(?:year|yr)s?[- ]?(?:term|endowment|assurance|policy|annuity)?\b/.exec(t) ??
    /\bterm (?:of )?(\d{1,3})\b/.exec(t) ??
    /\bn\s*=\s*(\d{1,3})\b/.exec(t);
  return m ? Number(m[1]) : null;
}

function parseAges(t: string): AgeRange | null {
  const m =
    /\b(?:from )?ages?\s*(\d{1,3})\s*(?:to|-|–|through|until|up to)\s*(\d{1,3})\b/.exec(t) ??
    /\bfrom age (\d{1,3})\b(?:.*?\b(?:to|until|up to) (?:age )?(\d{1,3})\b)?/.exec(t);
  if (m) {
    const from = Number(m[1]);
    const to = m[2] !== undefined ? Number(m[2]) : undefined;
    return { from, to };
  }
  const only = /\b(?:up to|until|to) age (\d{1,3})\b/.exec(t);
  if (only) return { to: Number(only[1]) };
  return null;
}

function parseTermsList(t: string): number[] | null {
  const m = /\bterms?\s+((?:\d{1,3}\s*(?:,|and|&)\s*)+\d{1,3})\b/.exec(t);
  if (!m) return null;
  return m[1]
    .split(/\s*(?:,|and|&)\s*/)
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0);
}

/** Columns the prompt names in backticks or plain words that match dataset
 *  columns, in the order they appear. */
function columnsMentioned(text: string, columns: readonly string[]): string[] {
  const out: string[] = [];
  const ticks = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  for (const tk of ticks) {
    const hit = columns.find((c) => lc(c) === lc(tk));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  if (out.length > 0) return out;
  const words = text.toLowerCase();
  const sorted = [...columns].sort((a, b) => b.length - a.length);
  const positions: Array<[number, string]> = [];
  for (const c of sorted) {
    if (c.length < 2) continue;
    const re = new RegExp(
      `(^|[^a-z0-9_])${c.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9_])`,
    );
    const m = re.exec(words);
    if (m) positions.push([m.index, c]);
  }
  positions.sort((a, b) => a[0] - b[0]);
  for (const [, c] of positions) if (!out.includes(c)) out.push(c);
  return out;
}

function basisFromPrompt(t: string, dataset: Dataset | null, sig: Signals): MortalityBasis {
  const wantsIllustrative = /\b(illustrative|gompertz|makeham|parametric|standard basis)\b/.test(t);
  const mentioned = dataset ? columnsMentioned(t, dataset.columns) : [];
  const gm = /gompertz|makeham/.test(t);
  if (gm) {
    const A = /\bA\s*=\s*([0-9.e-]+)/i.exec(t);
    const B = /\bB\s*=\s*([0-9.e-]+)/i.exec(t);
    const c = /\bc\s*=\s*([0-9.]+)/i.exec(t);
    if (A || B || c) {
      return {
        kind: "gompertz-makeham",
        A: A ? Number(A[1]) : ILLUSTRATIVE_MAKEHAM.A,
        B: B ? Number(B[1]) : ILLUSTRATIVE_MAKEHAM.B,
        c: c ? Number(c[1]) : ILLUSTRATIVE_MAKEHAM.c,
      };
    }
  }
  if (!wantsIllustrative && dataset) {
    // Named columns win; then detected signals.
    const age = mentioned.find((c) => c === sig.age) ?? sig.age;
    const qx =
      mentioned.find((c) => c === sig.qx) ??
      (mentioned.length >= 2 && age
        ? (mentioned.find(
            (c) =>
              c !== age &&
              (lc(c).includes("q") || lc(c).includes("rate") || lc(c).includes("mort")),
          ) ?? null)
        : sig.qx);
    const lx = mentioned.find((c) => c === sig.lx) ?? sig.lx;
    if (age && qx) return { kind: "qx-column", ageColumn: age, qxColumn: qx };
    if (age && lx && /\blx\b|surviv/.test(t))
      return { kind: "lx-column", ageColumn: age, lxColumn: lx };
    if (age && sig.deaths && sig.exposure) {
      return {
        kind: "deaths-exposure",
        ageColumn: age,
        deathsColumn: sig.deaths,
        exposureColumn: sig.exposure,
      };
    }
    if (age && lx) return { kind: "lx-column", ageColumn: age, lxColumn: lx };
  }
  return { kind: "gompertz-makeham", ...ILLUSTRATIVE_MAKEHAM };
}

/**
 * Natural-language table request → spec, or null when the text is not a
 * table request at all (so other chat handlers get their turn). Every
 * prompt `suggestActuarialTables` emits round-trips through here.
 */
export function parseTablePrompt(text: string, dataset: Dataset | null): ActuarialTableSpec | null {
  const t = text.toLowerCase().trim();
  // A request, not a question: "what is a life table?" must fall through to
  // the LLM; "life table please" / "build a life table" are requests.
  const question =
    /\?\s*$|^\s*(what|how|why|when|which|who|explain|define|describe|tell me about|is|are|does|do|can you explain)\b/.test(
      t,
    );
  const verb =
    /\b(build|create|generate|make|construct|produce|derive|tabulate|compute|give me|show me|i need|i want|need|want|please|prepare|draw up|set up|develop|calculate|run)\b/.test(
      t,
    );
  if (question || !verb) return null;
  const sig = detectTableSignals(dataset);
  const interest = parseInterest(t);
  const ages = parseAges(t);
  const radixM = /\bradix (?:of )?(\d[\d,]*)\b/.exec(t);
  const radix = radixM ? Number(radixM[1].replace(/,/g, "")) : undefined;
  const cols = dataset?.columns ?? [];
  const mentioned = columnsMentioned(text, cols);

  // Order matters: the more specific tables first, "life table" last so
  // "commutation table from the life table columns" is commutation.
  if (/\bcommutation\b|\b(dx|nx|mx|rx|sx) (function|column|table)/.test(t)) {
    return {
      kind: "commutation",
      basis: basisFromPrompt(t, dataset, sig),
      interest: interest ?? 0.04,
      ages: ages ?? undefined,
      radix,
    };
  }
  if (/\bnet premium|premium (table|rates?|grid)|premiums? per (1,?000|thousand|unit)/.test(t)) {
    const product = /endow/.test(t) ? "endowment" : /whole[- ]life/.test(t) ? "whole-life" : "term";
    const terms = parseTermsList(t) ?? undefined;
    const stepM = /\bevery (\d{1,2}) years?\b|\bstep (\d{1,2})\b/.exec(t);
    const step = stepM ? Number(stepM[1] ?? stepM[2]) : undefined;
    return {
      kind: "net-premium",
      basis: basisFromPrompt(t, dataset, sig),
      interest: interest ?? 0.04,
      product,
      ages: ages ? { ...ages, step } : step ? { step } : undefined,
      terms,
    };
  }
  if (
    /\bannuit(y|ies)|assurance factor|insurance factor|\bax\b|äx|\bAx\b|life[- ]contingen/.test(
      t,
    ) &&
    !/\bannuity[- ]certain\b/.test(t)
  ) {
    return {
      kind: "annuity-assurance",
      basis: basisFromPrompt(t, dataset, sig),
      interest: interest ?? 0.04,
      term: parseTerm(t) ?? undefined,
      ages: ages ?? undefined,
    };
  }
  if (
    /\bactual (vs\.?|versus|to|against|and) expected|\ba\/e\b|\bae table|experience (study|table|analysis)/.test(
      t,
    )
  ) {
    const age = mentioned.find((c) => c === sig.age) ?? sig.age ?? "age";
    const deaths = mentioned.find((c) => c === sig.deaths) ?? sig.deaths ?? "deaths";
    const exposure = mentioned.find((c) => c === sig.exposure) ?? sig.exposure ?? "exposure";
    const bandM = /\b(\d{1,2})[- ]year bands?\b/.exec(t);
    return {
      kind: "exposure-ae",
      ageColumn: age,
      deathsColumn: deaths,
      exposureColumn: exposure,
      expected:
        /\bagainst\b|\bexpected on\b|illustrative|gompertz|makeham/.test(t) &&
        !/against `?(qx|rate)/.test(t)
          ? { kind: "gompertz-makeham", ...ILLUSTRATIVE_MAKEHAM }
          : basisFromPrompt(t, dataset, sig),
      bandWidth: bandM ? Number(bandM[1]) : 5,
    };
  }
  if (/\bmodel[- ]?points?\b|\bcompress(ed)? (the )?polic|\bgroup(ed)? (the )?polic/.test(t)) {
    const age = mentioned.find((c) => c === sig.age) ?? sig.age;
    if (!age && !dataset)
      return {
        kind: "model-points",
        ageColumn: "age_at_entry",
        sexColumn: "sex",
        termColumn: "policy_term",
        sumAssuredColumn: "sum_assured",
        bandWidth: 5,
      };
    const bandM = /\b(\d{1,2})[- ]year (age )?bands?\b/.exec(t);
    return {
      kind: "model-points",
      ageColumn: age ?? "age_at_entry",
      sexColumn: mentioned.find((c) => c === sig.sex) ?? sig.sex ?? undefined,
      termColumn: mentioned.find((c) => c === sig.policyTerm) ?? sig.policyTerm ?? undefined,
      sumAssuredColumn: mentioned.find((c) => c === sig.sumAssured) ?? sig.sumAssured ?? undefined,
      premiumColumn: sig.premium ?? undefined,
      bandWidth: bandM ? Number(bandM[1]) : 5,
    };
  }
  if (/\btriangle|run[- ]?off\b/.test(t)) {
    const cumulative = !/\bincremental\b/.test(t);
    // "of X by Y and Z" — value first, then origin, then lag.
    const ofM = /\bof `([^`]+)` by `([^`]+)` and (?:payment period )?`([^`]+)`/.exec(text);
    let origin = sig.origin;
    let value = sig.value;
    let dev = sig.development;
    let pay = sig.payment;
    if (ofM && cols.includes(ofM[1]) && cols.includes(ofM[2]) && cols.includes(ofM[3])) {
      value = ofM[1];
      origin = ofM[2];
      if (/payment period/.test(text)) {
        pay = ofM[3];
        dev = null;
      } else {
        dev = ofM[3];
        pay = null;
      }
    } else if (mentioned.length > 0) {
      // Any named column that reads as an amount / origin / lag overrides
      // the detected default of that role ("triangle of incurred").
      const isValue = (c: string) => findColumn([c], COLUMN_ALIASES.value) !== null;
      const isOrigin = (c: string) => findColumn([c], COLUMN_ALIASES.origin) !== null;
      const isDev = (c: string) => findColumn([c], COLUMN_ALIASES.development) !== null;
      value = mentioned.find(isValue) ?? value;
      origin = mentioned.find(isOrigin) ?? origin;
      dev = mentioned.find(isDev) ?? dev;
    }
    if (!origin || !value || (!dev && !pay)) {
      // Not enough to build — still a triangle request; the generator's
      // error message will say which column is missing.
      return {
        kind: "runoff-triangle",
        originColumn: origin ?? "origin",
        developmentColumn: dev ?? (pay ? undefined : "development"),
        paymentColumn: pay ?? undefined,
        valueColumn: value ?? "paid",
        cumulative,
      };
    }
    return {
      kind: "runoff-triangle",
      originColumn: origin,
      developmentColumn: dev ?? undefined,
      paymentColumn: dev ? undefined : (pay ?? undefined),
      valueColumn: value,
      cumulative,
    };
  }
  if (
    /\b(discount|yield|zero|spot|forward|interest)[- ](curve|factor|table)s?|\bdiscount factors?\b|term structure|\bannuity[- ]certain\b/.test(
      t,
    )
  ) {
    const maxM = /\b(?:out )?to (\d{1,3})\s*(?:years?|y)\b/.exec(t);
    const flat = /\bflat\b/.test(t) ? (interest ?? 0.04) : undefined;
    const tenor = mentioned.find((c) => c === sig.tenor) ?? sig.tenor;
    const rate = mentioned.find((c) => c === sig.rate) ?? sig.rate;
    if (flat === undefined && tenor && rate) {
      return {
        kind: "discount-curve",
        tenorColumn: tenor,
        rateColumn: rate,
        maxTenor: maxM ? Number(maxM[1]) : undefined,
      };
    }
    return {
      kind: "discount-curve",
      flatRate: flat ?? interest ?? 0.04,
      maxTenor: maxM ? Number(maxM[1]) : undefined,
    };
  }
  if (
    /\blife[- ]?table|mortality table|survival table|survivorship|life expectanc|\blx\b/.test(t)
  ) {
    return {
      kind: "life-table",
      basis: basisFromPrompt(t, dataset, sig),
      ages: ages ?? undefined,
      radix,
    };
  }
  return null;
}

/** Short human label for a spec — used for chat replies and the tables shelf. */
export function describeTableSpec(spec: ActuarialTableSpec): string {
  const basis = (b: MortalityBasis) =>
    b.kind === "gompertz-makeham"
      ? "Gompertz–Makeham"
      : b.kind === "qx-column"
        ? `${b.qxColumn} by ${b.ageColumn}`
        : b.kind === "lx-column"
          ? `${b.lxColumn} by ${b.ageColumn}`
          : `${b.deathsColumn}/${b.exposureColumn}`;
  switch (spec.kind) {
    case "life-table":
      return `life table · ${basis(spec.basis)}`;
    case "commutation":
      return `commutation · ${basis(spec.basis)} · ${pct(spec.interest)}`;
    case "annuity-assurance":
      return `annuity/assurance factors · ${basis(spec.basis)} · ${pct(spec.interest)}${spec.term ? ` · n=${spec.term}` : ""}`;
    case "net-premium":
      return `net premium · ${spec.product} · ${basis(spec.basis)} · ${pct(spec.interest)}`;
    case "runoff-triangle":
      return `${spec.cumulative === false ? "incremental" : "cumulative"} triangle · ${spec.valueColumn}`;
    case "discount-curve":
      return spec.flatRate !== undefined
        ? `discount curve · flat ${pct(spec.flatRate)}`
        : "discount curve";
    case "exposure-ae":
      return `A/E · ${spec.deathsColumn}/${spec.exposureColumn}`;
    case "model-points":
      return `model points · ${spec.ageColumn}`;
  }
}

/** Serialise a table to CSV (for download / clipboard). */
export function tableToCsv(dataset: Dataset): string {
  const esc = (v: CellValue) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    dataset.columns.map(esc).join(","),
    ...dataset.rows.map((r) => dataset.columns.map((c) => esc(r[c])).join(",")),
  ].join("\n");
}
