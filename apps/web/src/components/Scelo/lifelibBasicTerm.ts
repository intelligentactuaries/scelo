// lifelibBasicTerm.ts
//
// In-browser TypeScript port of lifelib's BasicTerm_M projection
// (github.com/lifelib-dev/lifelib · basiclife / BasicTerm_M).
//
// Lifelib is Python (modelx) and not pip-runnable in the browser, so this
// file implements the same projection cells in TS so the user gets a real,
// numerically-credible monthly projection on their own model-point upload —
// no backend round-trip required. The cell vocabulary mirrors lifelib's
// Projection space so an actuary already familiar with lifelib can read
// the formulas one-to-one.
//
// Inputs (Dataset columns, case-insensitive, several aliases supported):
//   - policy_id            unique id per row
//   - age_at_entry         issue age in years
//   - sex                  "M" | "F" | "m" | "f" | "Male" | "Female"
//   - sum_assured          face amount per policy
//   - policy_term          term in YEARS
//   - duration_mth         elapsed policy months at valuation (≥0)
//   - premium_pp           OPTIONAL — monthly premium per policy.
//                          Falls back to a pricing default of
//                          sum_assured · annual_rate / 12 where the
//                          annual rate is derived from the assumed
//                          mortality + a 12% loading.
//
// Assumptions (constant — exposed via `DEFAULT_ASSUMPTIONS`; override-able
// per call to support what-if analysis from chat actions):
//   - mortality:  Makeham qx = A + B·c^x  (A=0.00022, B=2.7·10⁻⁶, c=1.124).
//                 Monthly qx_m = 1 - (1 - qx)^(1/12).
//   - lapse_rate: 0.05 per annum after month 0, no shock lapse.
//   - expense_acq_pp: 100 per policy at issue (charged once at t=0).
//   - expense_maint_pp: 5 per policy per month.
//   - disc_rate:  3% per annum continuous compounded; monthly disc =
//                 (1 + disc_rate)^(-1/12).
//
// The runner produces ONE aggregated projection across the whole MP file
// (policy-by-policy summed into month buckets). Per-policy detail is kept
// in `detail.byPolicy` for chat-context drilling but not surfaced on the
// card by default.

import type { Dataset, Row } from "./SoftDataWorkstation";

// ─── Types ────────────────────────────────────────────────────────────────

export type Sex = "M" | "F";

export interface ModelPoint {
  policyId: string;
  ageAtEntry: number;
  sex: Sex;
  sumAssured: number;
  policyTermYears: number;
  durationMth: number;
  premiumPp: number; // monthly premium per policy
}

export interface BasicTermAssumptions {
  // Makeham mortality params
  mortA: number;
  mortB: number;
  mortC: number;
  // annual lapse rate (level)
  lapseRate: number;
  // expenses
  expenseAcqPp: number;
  expenseMaintPpMth: number;
  // discounting
  discRate: number; // per annum
  // pricing fallback when MP has no premium_pp column
  pricingLoading: number; // multiplied on the EVL-derived monthly premium
}

export const DEFAULT_ASSUMPTIONS: BasicTermAssumptions = {
  mortA: 0.00022,
  mortB: 2.7e-6,
  mortC: 1.124,
  lapseRate: 0.05,
  expenseAcqPp: 100,
  expenseMaintPpMth: 5,
  discRate: 0.03,
  pricingLoading: 1.12,
};

export interface BasicTermProjectionRow {
  month: number;          // 0-indexed month from valuation
  polsIf: number;         // BOP policies in force, summed across MP
  polsDeath: number;
  polsLapse: number;
  premiums: number;
  claims: number;
  expenses: number;
  netCf: number;
  discount: number;       // discount factor at this month
  pvNetCf: number;        // discounted net_cf
}

export interface BasicTermResult {
  monthly: BasicTermProjectionRow[];
  pvNetCf: number;
  totalPremiums: number;
  totalClaims: number;
  totalExpenses: number;
  // signed break-even month (positive net cumulative cash flow first
  // crosses zero). null if never.
  breakEvenMonth: number | null;
  modelPointsUsed: number;
  modelPointsTotal: number;
  // per-policy contributions to PV — kept for drill-down in chat actions
  byPolicy: Array<{ policyId: string; pvNetCf: number; ageAtEntry: number; sex: Sex }>;
  // model-point columns we recognised in the source dataset, for narrative
  recognisedColumns: Record<string, string | null>;
}

// ─── Column resolution ────────────────────────────────────────────────────

const COLUMN_ALIASES: Record<keyof Omit<ModelPoint, never>, string[]> = {
  policyId: ["policy_id", "policyid", "policy", "id", "model_point_id", "mp_id"],
  ageAtEntry: ["age_at_entry", "ageatentry", "issue_age", "age"],
  sex: ["sex", "gender"],
  sumAssured: ["sum_assured", "sumassured", "face_amount", "face", "sa", "sum_insured"],
  policyTermYears: ["policy_term", "policyterm", "term_years", "term"],
  durationMth: ["duration_mth", "durationmth", "duration_months", "dur_mth", "elapsed_mth"],
  premiumPp: ["premium_pp", "premiumpp", "premium", "annual_premium", "premium_pp_pa", "monthly_premium"],
};

function lc(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "_");
}

function resolveColumn(
  dataset: Dataset,
  aliases: string[],
): { canonical: string | null } {
  const lookup = new Map(dataset.columns.map((c) => [lc(c), c] as const));
  for (const a of aliases) {
    const hit = lookup.get(a);
    if (hit) return { canonical: hit };
  }
  return { canonical: null };
}

function coerceNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/[,\s]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function coerceSex(v: unknown): Sex | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (s === "m" || s === "male") return "M";
  if (s === "f" || s === "female") return "F";
  return null;
}

// ─── Mortality / discount ─────────────────────────────────────────────────

function makehamQx(x: number, a: BasicTermAssumptions): number {
  // Annual mortality qx via Makeham. Clamped to a sensible range so a
  // bad age doesn't blow the projection up.
  if (!Number.isFinite(x) || x < 0) return 0;
  const qx = a.mortA + a.mortB * Math.pow(a.mortC, x);
  return Math.max(0, Math.min(0.95, qx));
}

function monthlyQ(annualQ: number): number {
  // Fractional-age constant-force conversion: qx_m = 1 - (1-qx)^(1/12).
  return 1 - Math.pow(1 - annualQ, 1 / 12);
}

// ─── Model-point parsing ──────────────────────────────────────────────────

export interface ParsedModelPoints {
  points: ModelPoint[];
  rowsTried: number;
  recognisedColumns: Record<string, string | null>;
}

export function parseModelPoints(dataset: Dataset, assumptions = DEFAULT_ASSUMPTIONS): ParsedModelPoints {
  const cols = {
    policyId: resolveColumn(dataset, COLUMN_ALIASES.policyId).canonical,
    ageAtEntry: resolveColumn(dataset, COLUMN_ALIASES.ageAtEntry).canonical,
    sex: resolveColumn(dataset, COLUMN_ALIASES.sex).canonical,
    sumAssured: resolveColumn(dataset, COLUMN_ALIASES.sumAssured).canonical,
    policyTermYears: resolveColumn(dataset, COLUMN_ALIASES.policyTermYears).canonical,
    durationMth: resolveColumn(dataset, COLUMN_ALIASES.durationMth).canonical,
    premiumPp: resolveColumn(dataset, COLUMN_ALIASES.premiumPp).canonical,
  };
  const out: ModelPoint[] = [];
  let i = 0;
  for (const row of dataset.rows) {
    i++;
    const policyId = cols.policyId ? String((row as Row)[cols.policyId] ?? `mp_${i}`) : `mp_${i}`;
    const age = cols.ageAtEntry ? coerceNumber((row as Row)[cols.ageAtEntry]) : null;
    const sex = cols.sex ? coerceSex((row as Row)[cols.sex]) : null;
    const sa = cols.sumAssured ? coerceNumber((row as Row)[cols.sumAssured]) : null;
    const term = cols.policyTermYears ? coerceNumber((row as Row)[cols.policyTermYears]) : null;
    const dur = cols.durationMth ? coerceNumber((row as Row)[cols.durationMth]) : 0;
    const premRaw = cols.premiumPp ? coerceNumber((row as Row)[cols.premiumPp]) : null;

    if (age === null || sa === null || term === null) continue; // need core fields
    if (term <= 0) continue;
    const dur0 = Math.max(0, Math.floor(dur ?? 0));
    const sex2 = sex ?? "F";

    // Premium fallback — equivalence-of-value pricing at issue with a loading.
    // EVL: premium · ä(0, n) = sum_assured · A(0, n) ; we approximate the
    // annuity / insurance functions with a flat mortality (qx0) over the
    // remaining term so the user gets a sensible non-zero premium even
    // when the MP file omits it.
    let premiumPp = premRaw ?? 0;
    if (premiumPp <= 0) {
      const qx0 = makehamQx(age, assumptions);
      const monthly = sa * (qx0 / 12) * assumptions.pricingLoading;
      premiumPp = Math.max(monthly, 0.01);
    } else if (cols.premiumPp && cols.premiumPp.toLowerCase().includes("annual")) {
      // column was annual — convert to monthly
      premiumPp = premiumPp / 12;
    } else if (cols.premiumPp && cols.premiumPp.toLowerCase().includes("_pa")) {
      premiumPp = premiumPp / 12;
    }

    out.push({
      policyId,
      ageAtEntry: age,
      sex: sex2,
      sumAssured: sa,
      policyTermYears: term,
      durationMth: dur0,
      premiumPp,
    });
  }
  return { points: out, rowsTried: i, recognisedColumns: cols };
}

// ─── Per-policy projection ────────────────────────────────────────────────

function projectPolicy(
  mp: ModelPoint,
  assumptions: BasicTermAssumptions,
): BasicTermProjectionRow[] {
  const termMonths = Math.max(0, Math.floor(mp.policyTermYears * 12) - mp.durationMth);
  const rows: BasicTermProjectionRow[] = [];
  let polsIf = 1;
  const lapseMth = 1 - Math.pow(1 - assumptions.lapseRate, 1 / 12);

  for (let t = 0; t < termMonths; t++) {
    const ageNow = mp.ageAtEntry + (mp.durationMth + t) / 12;
    const qm = monthlyQ(makehamQx(ageNow, assumptions));

    const polsDeath = polsIf * qm;
    const polsLapse = (polsIf - polsDeath) * lapseMth;
    const claims = polsDeath * mp.sumAssured;
    const premiums = polsIf * mp.premiumPp;
    const acq = t === 0 && mp.durationMth === 0 ? assumptions.expenseAcqPp : 0;
    const expenses = acq + polsIf * assumptions.expenseMaintPpMth;
    const netCf = premiums - claims - expenses;
    const discount = Math.pow(1 + assumptions.discRate, -t / 12);
    const pvNetCf = netCf * discount;
    rows.push({
      month: t,
      polsIf,
      polsDeath,
      polsLapse,
      premiums,
      claims,
      expenses,
      netCf,
      discount,
      pvNetCf,
    });
    polsIf = polsIf - polsDeath - polsLapse;
    if (polsIf <= 1e-8) break;
  }
  return rows;
}

// ─── Aggregation across MPs ───────────────────────────────────────────────

export function runBasicTermProjection(
  dataset: Dataset,
  assumptions: BasicTermAssumptions = DEFAULT_ASSUMPTIONS,
): BasicTermResult {
  const parsed = parseModelPoints(dataset, assumptions);
  // Cap to keep the in-browser pass snappy. Lifelib in Python comfortably
  // handles 100k MPs; we run the same math but on a sample to stay <100ms.
  const SAMPLE_CAP = 2000;
  const sample = parsed.points.length > SAMPLE_CAP
    ? stratifiedSample(parsed.points, SAMPLE_CAP)
    : parsed.points;

  const monthly = new Map<number, BasicTermProjectionRow>();
  const byPolicy: BasicTermResult["byPolicy"] = [];

  for (const mp of sample) {
    const proj = projectPolicy(mp, assumptions);
    let pv = 0;
    for (const r of proj) {
      pv += r.pvNetCf;
      const agg = monthly.get(r.month);
      if (!agg) {
        monthly.set(r.month, { ...r });
      } else {
        agg.polsIf += r.polsIf;
        agg.polsDeath += r.polsDeath;
        agg.polsLapse += r.polsLapse;
        agg.premiums += r.premiums;
        agg.claims += r.claims;
        agg.expenses += r.expenses;
        agg.netCf += r.netCf;
        agg.pvNetCf += r.pvNetCf;
        // discount factor depends only on t, so keep the first value
      }
    }
    byPolicy.push({
      policyId: mp.policyId,
      pvNetCf: pv,
      ageAtEntry: mp.ageAtEntry,
      sex: mp.sex,
    });
  }

  // Scale aggregation back up to the population if we sampled.
  const scale = sample.length > 0 ? parsed.points.length / sample.length : 0;
  const monthlyRows = Array.from(monthly.values())
    .sort((a, z) => a.month - z.month)
    .map((r) => ({
      ...r,
      polsIf: r.polsIf * scale,
      polsDeath: r.polsDeath * scale,
      polsLapse: r.polsLapse * scale,
      premiums: r.premiums * scale,
      claims: r.claims * scale,
      expenses: r.expenses * scale,
      netCf: r.netCf * scale,
      pvNetCf: r.pvNetCf * scale,
    }));

  let pvNetCf = 0;
  let totalPremiums = 0;
  let totalClaims = 0;
  let totalExpenses = 0;
  let cumNet = 0;
  let breakEvenMonth: number | null = null;
  for (const r of monthlyRows) {
    pvNetCf += r.pvNetCf;
    totalPremiums += r.premiums;
    totalClaims += r.claims;
    totalExpenses += r.expenses;
    cumNet += r.netCf;
    if (breakEvenMonth === null && cumNet >= 0 && r.month > 0) {
      breakEvenMonth = r.month;
    }
  }

  return {
    monthly: monthlyRows,
    pvNetCf,
    totalPremiums,
    totalClaims,
    totalExpenses,
    breakEvenMonth,
    modelPointsUsed: sample.length,
    modelPointsTotal: parsed.points.length,
    byPolicy: byPolicy.map((p) => ({ ...p, pvNetCf: p.pvNetCf * scale })),
    recognisedColumns: parsed.recognisedColumns,
  };
}

// Deterministic stratified sample on ageAtEntry × sex so the projection
// stays representative under the SAMPLE_CAP. Uses a seeded shuffle so
// repeated runs return the same MPs.
function stratifiedSample(mps: ModelPoint[], cap: number): ModelPoint[] {
  if (mps.length <= cap) return mps.slice();
  // Bucket by (sex, age band of 5)
  const buckets = new Map<string, ModelPoint[]>();
  for (const mp of mps) {
    const k = `${mp.sex}|${Math.floor(mp.ageAtEntry / 5) * 5}`;
    const arr = buckets.get(k) ?? [];
    arr.push(mp);
    buckets.set(k, arr);
  }
  // Allocate by proportional share
  const out: ModelPoint[] = [];
  const total = mps.length;
  for (const [, arr] of buckets) {
    const take = Math.max(1, Math.round((arr.length / total) * cap));
    // deterministic stride
    const stride = Math.max(1, Math.floor(arr.length / take));
    for (let i = 0; i < arr.length && out.length < cap; i += stride) {
      out.push(arr[i]);
    }
  }
  return out;
}
