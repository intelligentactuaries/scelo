// Augment's per-row lookup: index the reference cohort's outcomes at several
// granularities, then give each input row the medians / modes of the nearest
// populated neighbourhood of agents like the person in that row.
//
// A single decade × sex × comorbidity table is too sparse to stand alone:
// at the default sample size only ~30 of the ~40 possible buckets are
// occupied and several hold a single agent, so many input rows find no
// match. The previous fallback claimed to "fall back through coarser
// buckets" but actually took the FIRST bucket in Map insertion order —
// i.e. the bucket of whichever agent happened to be simulated first. An
// 80-year-old man with comorbidities could be handed a 20-year-old
// woman's outcomes. That was merely stable while the seed was frozen;
// with an independent draw per run it would have become erratic, so it
// has to be fixed alongside the seed rather than after it.
//
// These indexes let an unmatched row degrade to the nearest sensible
// neighbourhood — drop comorbidity, then sex, then widen the age band —
// and only reach the whole cohort as a last resort.
//
// A row is only matched on what it actually says. Rows used to be handed a
// default person wherever a column was missing — age 35, sex F, no
// comorbidity — so a table with no demographic columns at all (a scenario
// table, a claims extract) had every row matched to the one 30s-female-
// healthy bucket and labelled an exact age10+sex+comorbidity match, often
// on a single agent: one simulated woman's answers stamped on every row.
// A trait the row doesn't state now widens the search past that dimension,
// and a row with no age reaches the whole cohort, labelled as such.

import type { SimulationAgentResult } from '../../shared/types';

/** What a row says about the person in it; null where it says nothing. */
export interface RowTraits {
  age: number | null;
  sex: 'M' | 'F' | null;
  hasComorbidity: boolean | null;
}

/** Read age / sex / comorbidity off a row, matching column names
 *  case-insensitively. Blank cells count as unstated. */
export function rowTraits(row: Record<string, unknown>): RowTraits {
  const cols = new Map(Object.keys(row).map((k) => [k.toLowerCase(), k] as const));
  const stated = (names: string[]): unknown => {
    for (const n of names) {
      const real = cols.get(n);
      if (real !== undefined && row[real] != null && row[real] !== '') return row[real];
    }
    return undefined;
  };
  const age = Number(stated(['age', 'age_at_entry', 'ageatentry']));
  const sex = String(stated(['sex', 'gender']) ?? '')
    .trim()
    .charAt(0)
    .toUpperCase();
  const comorbidities = cols.get('comorbidities');
  return {
    age: Number.isFinite(age) ? age : null,
    sex: sex === 'M' ? 'M' : sex === 'F' || sex === 'W' ? 'F' : null,
    // In a comorbidities column an empty cell is a recorded "none"; with no
    // such column the row says nothing either way.
    hasComorbidity: comorbidities === undefined ? null : !!row[comorbidities],
  };
}

type Key = string;
type Bucketed = Map<Key, SimulationAgentResult[]>;

/** Index `results` (the agents that answered) and return the per-row lookup.
 *  The lookup yields the sim_* fields for a row, or null when there are no
 *  answers to draw on at all. */
export function buildAugmentLookup(results: SimulationAgentResult[]) {
  const byExact: Bucketed = new Map();
  const byDecadeSex: Bucketed = new Map();
  const byDecade: Bucketed = new Map();
  const byBandSex: Bucketed = new Map();
  const byBand: Bucketed = new Map();
  const bySex: Bucketed = new Map();
  const decadeOf = (age: number) => Math.floor(age / 10) * 10;
  const bandOf = (age: number) => Math.floor(age / 20) * 20;
  const push = (m: Bucketed, k: Key, r: SimulationAgentResult) => {
    const arr = m.get(k) ?? [];
    arr.push(r);
    m.set(k, arr);
  };
  for (const r of results) {
    const age = r.agent.age;
    const sex = r.agent.sex ?? r.agent.health?.sex ?? 'F';
    const hasCom = !!r.agent.health && r.agent.health.comorbidities.length > 0;
    push(byExact, `${decadeOf(age)}|${sex}|${hasCom ? 'c' : '0'}`, r);
    push(byDecadeSex, `${decadeOf(age)}|${sex}`, r);
    push(byDecade, `${decadeOf(age)}`, r);
    push(byBandSex, `${bandOf(age)}|${sex}`, r);
    push(byBand, `${bandOf(age)}`, r);
    push(bySex, sex, r);
  }

  /** Nearest populated neighbourhood for a row, plus how it was matched. */
  function resolveBucket({ age, sex, hasComorbidity }: RowTraits): {
    arr: SimulationAgentResult[];
    match: string;
  } {
    const tries: Array<[Bucketed, Key, string]> = [];
    if (age !== null) {
      const d = decadeOf(age);
      const b = bandOf(age);
      if (sex !== null && hasComorbidity !== null) {
        tries.push([byExact, `${d}|${sex}|${hasComorbidity ? 'c' : '0'}`, 'age10+sex+comorbidity']);
      }
      if (sex !== null) tries.push([byDecadeSex, `${d}|${sex}`, 'age10+sex']);
      tries.push([byDecade, `${d}`, 'age10']);
      if (sex !== null) tries.push([byBandSex, `${b}|${sex}`, 'age20+sex']);
      tries.push([byBand, `${b}`, 'age20']);
    } else if (sex !== null) {
      tries.push([bySex, sex, 'sex']);
    }
    for (const [m, k, match] of tries) {
      const arr = m.get(k);
      if (arr && arr.length > 0) return { arr, match };
    }
    return { arr: results, match: 'cohort' };
  }

  return function lookup(traits: RowTraits) {
    const { arr, match } = resolveBucket(traits);
    if (arr.length === 0) return null;
    return {
      // How the estimate was reached and how much evidence backs it. A
      // median over one agent and a median over thirty are not the same
      // claim, and the caller loads these rows straight into a modelling
      // workstation — the distinction has to travel with the data.
      sim_bucket_match: match,
      sim_bucket_n: arr.length,
      sim_treatment_uptake_mode: modeOf(arr.map((r) => r.outcome.behaviour.treatmentUptake)),
      sim_isolation_days_median: median(arr.map((r) => r.outcome.behaviour.isolationDays)),
      sim_spending_shift_mode: modeOf(arr.map((r) => r.outcome.behaviour.spendingShift)),
      sim_infection_probability_median: Number(
        median(arr.map((r) => r.outcome.health.infectionProbability)).toFixed(3),
      ),
      sim_severity_mode: modeOf(arr.map((r) => r.outcome.health.severityIfInfected)),
      sim_mortality_probability_median: Number(
        median(arr.map((r) => r.outcome.health.mortalityProbability)).toFixed(4),
      ),
      sim_hospitalised_rate: Number(
        (arr.filter((r) => r.outcome.health.hospitalised).length / arr.length).toFixed(3),
      ),
      sim_workdays_lost_median: median(arr.map((r) => r.outcome.economic.workdaysLost)),
      sim_oop_zar_median: Math.round(median(arr.map((r) => r.outcome.economic.outOfPocketCostZar))),
      sim_insurer_claim_zar_median: Math.round(
        median(arr.map((r) => r.outcome.economic.insurerClaimZar)),
      ),
    };
  };
}

/** Attach the sim_* fields to every row. `columns` lists the fields this pass
 *  added — empty when no agent answered — and never sim_* columns the rows
 *  already carried from an earlier pass, which a re-run overwrites. */
export function augmentRows(
  rows: Array<Record<string, unknown>>,
  results: SimulationAgentResult[],
): { rows: Array<Record<string, unknown>>; columns: string[] } {
  const lookup = buildAugmentLookup(results);
  let columns: string[] = [];
  const out = rows.map((row) => {
    const sim = lookup(rowTraits(row));
    if (sim && columns.length === 0) columns = Object.keys(sim);
    return { ...row, ...(sim ?? {}) };
  });
  return { rows: out, columns };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function modeOf<T extends string>(xs: T[]): T | '' {
  if (xs.length === 0) return '' as T;
  const counts = new Map<T, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: T = xs[0];
  let bestN = -1;
  for (const [k, v] of counts) if (v > bestN) { best = k; bestN = v; }
  return best;
}
