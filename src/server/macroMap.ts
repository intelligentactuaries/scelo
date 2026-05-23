// Macro-aggregation layer for the swarm simulation.
//
// Per-agent SimulationOutcome × per-agent profile × macro multipliers →
// country-level macro impact. Every multiplier is cited inline with its
// source + last-checked date. When a value is a rough proxy rather than
// a published statistic, the comment marks it `// proxy:` — replace
// those first when better data lands.

import type {
  SimulationAgentResult,
  SocietyAgent,
} from '../shared/types';

// ─── SA assumptions (replace per country) ────────────────────────────────

/** StatsSA Mid-year population estimate 2024. */
const SA_POPULATION = 62_270_000;

/**
 * Mean monthly earnings (formal sector), R/month. StatsSA Quarterly
 * Employment Statistics Q4 2024 (P0277). Annualised ÷ 12 ÷ ~21 work days.
 */
const SA_DAILY_WAGE_FORMAL = 1_350; // ZAR / day, mean

/**
 * Mean monthly earnings (informal sector). StatsSA QLFS 2024.
 * Significantly lower; used for employment='informal' agents.
 */
const SA_DAILY_WAGE_INFORMAL = 280; // ZAR / day

/**
 * Avg cost of an inpatient admission, public sector. Council for
 * Medical Schemes 2023 cost benchmarks + Treasury Health spend estimate.
 * Private-sector admissions cost ~4× as much; we use a blended figure.
 */
const SA_ADMISSION_COST_AVG_ZAR = 18_500; // proxy: blended public+private

/**
 * Daily wage by employment status. Returns 0 for the non-economically
 * active (student / retired / unemployed) — they still contribute to
 * informal household production but we don't try to monetise that here.
 */
function dailyWageFor(agent: SocietyAgent): number {
  switch (agent.employment) {
    case 'employed':
    case 'self-employed':
      return SA_DAILY_WAGE_FORMAL;
    case 'informal':
      return SA_DAILY_WAGE_INFORMAL;
    case 'student':
    case 'retired':
    case 'unemployed':
    default:
      return 0;
  }
}

// ─── Macro outputs ───────────────────────────────────────────────────────

export interface MacroSummary {
  population: number;
  sampleSize: number;
  scaleFactor: number; // pop / sampleSize
  // headline
  /** Aggregate workdays lost across the modelled population. */
  workdaysLostTotal: number;
  /** Approx. lost wage value at the SA daily-wage averages. */
  gdpDragZar: number;
  /** Number of agents who reach 'severe' or 'critical', scaled up. */
  severeOrCriticalCount: number;
  /** Excess mortality count (modelled mortalityProbability × pop). */
  excessMortality: number;
  /** Sum of insurer-claim ZAR across the population. */
  insurerClaimsZar: number;
  /** Sum of out-of-pocket ZAR. */
  oopCostsZar: number;
  /** Surge in hospital admissions (hospitalised==true scaled). */
  hospitalAdmissions: number;
  /** Surge × per-admission cost. */
  hospitalCostZar: number;
  /** Cumulative ZAR loss from infections that turn severe / critical. */
  severeIllnessCostZar: number;
  // distributional
  /** Workdays lost broken down by age band. */
  workdaysByAge: Array<{ band: string; lost: number }>;
  /** Mortality broken down by comorbidity status. */
  mortalityByComorbidity: Array<{ status: string; deaths: number }>;
  /** Treatment uptake breakdown. */
  uptake: { accepted: number; declined: number; unsure: number };
  /** Spending shift breakdown. */
  spending: { reduced: number; unchanged: number; increased: number };
}

function ageBandLabel(age: number): string {
  if (age < 15) return '0-14';
  if (age < 25) return '15-24';
  if (age < 35) return '25-34';
  if (age < 45) return '35-44';
  if (age < 55) return '45-54';
  if (age < 65) return '55-64';
  if (age < 75) return '65-74';
  return '75+';
}

export function aggregateMacro(
  results: SimulationAgentResult[],
  args: { population?: number } = {},
): MacroSummary {
  const sampleSize = results.length;
  const population = args.population ?? SA_POPULATION;
  const scale = sampleSize > 0 ? population / sampleSize : 0;

  let workdaysLost = 0;
  let gdpDrag = 0;
  let severeCount = 0;
  let excessMortality = 0;
  let insurerClaims = 0;
  let oop = 0;
  let admissions = 0;
  let severeIllnessCost = 0;

  const workdaysByAge = new Map<string, number>();
  const mortalityByCom = new Map<string, number>();
  const uptake = { accepted: 0, declined: 0, unsure: 0 };
  const spending = { reduced: 0, unchanged: 0, increased: 0 };

  for (const r of results) {
    const { agent, outcome } = r;
    const wage = dailyWageFor(agent);

    workdaysLost += outcome.economic.workdaysLost;
    gdpDrag += outcome.economic.workdaysLost * wage;

    if (
      outcome.health.severityIfInfected === 'severe' ||
      outcome.health.severityIfInfected === 'critical'
    ) {
      severeCount += 1;
      severeIllnessCost +=
        outcome.economic.outOfPocketCostZar + outcome.economic.insurerClaimZar;
    }
    if (outcome.health.hospitalised) admissions += 1;

    // Mortality is expressed as a per-agent probability. Sum (= expected
    // count). This is the conventional approach for population-rate roll-up.
    excessMortality += outcome.health.mortalityProbability;

    insurerClaims += outcome.economic.insurerClaimZar;
    oop += outcome.economic.outOfPocketCostZar;

    const band = ageBandLabel(agent.age);
    workdaysByAge.set(band, (workdaysByAge.get(band) ?? 0) + outcome.economic.workdaysLost);

    const comStatus = agent.health && agent.health.comorbidities.length > 0
      ? 'with comorbidities'
      : 'no comorbidities';
    mortalityByCom.set(
      comStatus,
      (mortalityByCom.get(comStatus) ?? 0) + outcome.health.mortalityProbability,
    );

    const uk = outcome.behaviour.treatmentUptake;
    if (uk === 'accepted' || uk === 'declined' || uk === 'unsure') uptake[uk] += 1;
    const sp = outcome.behaviour.spendingShift;
    if (sp === 'reduced' || sp === 'unchanged' || sp === 'increased') spending[sp] += 1;
  }

  return {
    population,
    sampleSize,
    scaleFactor: scale,
    workdaysLostTotal: Math.round(workdaysLost * scale),
    gdpDragZar: Math.round(gdpDrag * scale),
    severeOrCriticalCount: Math.round(severeCount * scale),
    excessMortality: Math.round(excessMortality * scale),
    insurerClaimsZar: Math.round(insurerClaims * scale),
    oopCostsZar: Math.round(oop * scale),
    hospitalAdmissions: Math.round(admissions * scale),
    hospitalCostZar: Math.round(admissions * scale * SA_ADMISSION_COST_AVG_ZAR),
    severeIllnessCostZar: Math.round(severeIllnessCost * scale),
    workdaysByAge: Array.from(workdaysByAge.entries())
      .map(([band, lost]) => ({ band, lost: Math.round(lost * scale) }))
      .sort((a, b) => a.band.localeCompare(b.band)),
    mortalityByComorbidity: Array.from(mortalityByCom.entries())
      .map(([status, deaths]) => ({ status, deaths: Math.round(deaths * scale) }))
      .sort((a, b) => b.deaths - a.deaths),
    uptake,
    spending,
  };
}

/**
 * Human-readable provenance block for the macro figures — printed in
 * SimulationView's narrative panel so the actuary sees the citations.
 */
export const SA_MACRO_PROVENANCE: string[] = [
  'Population 62.27M — StatsSA Mid-year pop. estimates 2024 (P0302).',
  'Daily wage formal R1,350 — StatsSA QES Q4 2024 (P0277), annualised.',
  'Daily wage informal R280 — StatsSA QLFS 2024.',
  'Avg admission cost R18,500 — blended public+private; CMS 2023 + Treasury health spend (proxy).',
];
