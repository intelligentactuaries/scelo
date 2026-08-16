// SA-grounded population sampler for the swarm simulation.
//
// Every prior in this file is cited inline with the source + last-checked
// date so the macro mapping can claim provenance. When a number is a
// rough proxy rather than a published statistic, the comment marks it
// `// proxy:`. Replace those first when better data lands.

import type {
  ComorbidityCode,
  HealthProfile,
  SocietyAgent,
} from '../../shared/types';

// ─── PRNG ─────────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, weighted: Array<[T, number]>): T {
  const total = weighted.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of weighted) {
    if ((r -= w) <= 0) return v;
  }
  return weighted[weighted.length - 1][0];
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// ─── SA priors (StatsSA, SADHS, THEMBISA, World Bank) ────────────────────
//
// All prevalences are gross / conditional only where noted. They are
// applied per-agent as Bernoulli draws — the population in aggregate
// matches the source rate by construction.

/**
 * Age pyramid bands × sex.
 * Source: StatsSA Mid-year population estimates 2024 (P0302), Table 2.
 * https://www.statssa.gov.za/publications/P0302/P03022024.pdf
 * Last checked: 2026-05.
 */
const SA_AGE_BANDS: Array<{ band: [number, number]; mWeight: number; fWeight: number }> = [
  { band: [0, 4], mWeight: 5.4, fWeight: 5.2 },
  { band: [5, 9], mWeight: 5.0, fWeight: 4.8 },
  { band: [10, 14], mWeight: 4.7, fWeight: 4.6 },
  { band: [15, 19], mWeight: 4.6, fWeight: 4.5 },
  { band: [20, 24], mWeight: 4.5, fWeight: 4.4 },
  { band: [25, 29], mWeight: 4.6, fWeight: 4.6 },
  { band: [30, 34], mWeight: 4.5, fWeight: 4.7 },
  { band: [35, 39], mWeight: 4.0, fWeight: 4.3 },
  { band: [40, 44], mWeight: 3.4, fWeight: 3.7 },
  { band: [45, 49], mWeight: 2.9, fWeight: 3.2 },
  { band: [50, 54], mWeight: 2.4, fWeight: 2.7 },
  { band: [55, 59], mWeight: 1.9, fWeight: 2.3 },
  { band: [60, 64], mWeight: 1.5, fWeight: 1.9 },
  { band: [65, 69], mWeight: 1.1, fWeight: 1.5 },
  { band: [70, 74], mWeight: 0.7, fWeight: 1.1 },
  { band: [75, 79], mWeight: 0.4, fWeight: 0.7 },
  { band: [80, 100], mWeight: 0.3, fWeight: 0.6 },
];

/**
 * Comorbidity prevalences by sex and age band — applied as INDEPENDENT
 * Bernoulli draws. Reality has correlation structure (HIV+TB cluster,
 * diabetes+hypertension cluster) but for a v1 simulator the independent
 * draws produce a realistic-enough population for macro aggregation.
 *
 * Sources (last-checked 2026-05):
 * - Hypertension, diabetes, obesity, CKD: SA Demographic & Health Survey
 *   (SADHS) 2016, adult risk factors module + Stats SA NCD report 2022.
 * - HIV prevalence: THEMBISA model v4.7 release notes (NICD).
 * - HIV on ART: SA National HIV Survey 2024 (HSRC).
 * - TB active: WHO Global TB report 2024, SA country profile (RR per 100k).
 * - CVD, asthma, COPD: GBD 2021, SA-specific extracts.
 * - Cancer active, immunosuppressed: rough proxies pending CANSA registry
 *   age-stratified ingest.
 */
const SA_COMORBIDITY_PRIOR: Record<
  ComorbidityCode,
  (age: number, sex: 'M' | 'F') => number
> = {
  hypertension: (age) => {
    if (age < 18) return 0.005;
    if (age < 30) return 0.06;
    if (age < 45) return 0.21;
    if (age < 60) return 0.43;
    return 0.55; // SADHS 2016 adults ≥60
  },
  'diabetes-t2': (age, sex) => {
    if (age < 18) return 0.002;
    if (age < 30) return 0.02;
    if (age < 45) return 0.07;
    if (age < 60) return 0.14;
    return 0.18 * (sex === 'F' ? 1.1 : 1.0); // SADHS women slightly higher
  },
  'hiv-on-art': (age, sex) => {
    // SA HIV prevalence ~13% adults; ~75% on ART (HSRC 2024)
    const prev = age < 15 ? 0.02 : sex === 'F' ? 0.17 : 0.10;
    return prev * 0.75;
  },
  'hiv-not-on-art': (age, sex) => {
    const prev = age < 15 ? 0.02 : sex === 'F' ? 0.17 : 0.10;
    return prev * 0.25;
  },
  'tb-active': (age) => {
    // SA active TB ~615 per 100k (WHO 2024); higher in working-age + HIV+
    if (age < 15) return 0.001;
    if (age < 65) return 0.009;
    return 0.005;
  },
  asthma: (age) => (age < 18 ? 0.08 : 0.05),
  copd: (age) => {
    if (age < 40) return 0.005;
    if (age < 60) return 0.04;
    return 0.10;
  },
  cvd: (age) => {
    if (age < 40) return 0.01;
    if (age < 60) return 0.07;
    return 0.18;
  },
  obesity: (age, sex) => {
    // SADHS 2016: 41% adult F, 11% adult M obese
    if (age < 18) return 0.13;
    return sex === 'F' ? 0.41 : 0.11;
  },
  ckd: (age) => {
    if (age < 40) return 0.01;
    if (age < 65) return 0.05;
    return 0.13;
  },
  'cancer-active': (age) => {
    // proxy: rough age-stratified prevalence (CANSA 2022)
    if (age < 30) return 0.001;
    if (age < 60) return 0.012;
    return 0.045;
  },
  immunosuppressed: () => 0.015, // proxy: union of cancer-tx, post-transplant, biologics, advanced HIV
  pregnancy: (age, sex) => {
    if (sex !== 'F' || age < 15 || age > 49) return 0;
    return 0.04; // ~ TFR/12 averaged across reproductive years
  },
};

/**
 * Income mix — Stats SA Quarterly Labour Force Survey + Labour Market
 * Dynamics 2023. Hard splits along the formal/informal divide.
 */
const SA_INCOME_MIX: Array<['low' | 'lower-mid' | 'mid' | 'upper-mid' | 'high', number]> = [
  ['low', 0.42],
  ['lower-mid', 0.27],
  ['mid', 0.18],
  ['upper-mid', 0.09],
  ['high', 0.04],
];

const SA_EDUCATION_MIX: Array<['primary' | 'secondary' | 'tertiary' | 'postgrad', number]> = [
  ['primary', 0.18],
  ['secondary', 0.62],
  ['tertiary', 0.16],
  ['postgrad', 0.04],
];

/**
 * Employment conditional on age. The previous flat mix let the sampler
 * hand a 27-year-old 'retired' or a toddler 'student'; every band below
 * is constrained to combinations that exist in the QLFS tables.
 * - Under 6: below school age → 'child' (not economically active).
 * - 6-17: compulsory schooling (SA Schools Act) → 'student'; BCEA s43
 *   bars employment under 15 anyway.
 * - 18-24: StatsSA QLFS 2024 youth — high NEET share, ~1/3 studying.
 * - 25-49 / 50-59: QLFS prime-age mix; no students, early retirement
 *   only appearing in the 50s. // proxy: band splits interpolated
 * - 60-64: pre-/post-retirement blend; 65+: overwhelmingly retired.
 */
function employmentFor(
  rand: () => number,
  age: number,
): SocietyAgent['employment'] {
  if (age < 6) return 'child';
  if (age < 18) return 'student';
  if (age < 25) {
    return pick(rand, [
      ['student', 0.33],
      ['employed', 0.16],
      ['self-employed', 0.03],
      ['informal', 0.10],
      ['unemployed', 0.38], // expanded definition, youth
    ]);
  }
  if (age < 50) {
    return pick(rand, [
      ['employed', 0.40],
      ['self-employed', 0.10],
      ['informal', 0.17],
      ['unemployed', 0.33],
    ]);
  }
  if (age < 60) {
    return pick(rand, [
      ['employed', 0.38],
      ['self-employed', 0.11],
      ['informal', 0.15],
      ['unemployed', 0.28],
      ['retired', 0.08],
    ]);
  }
  if (age < 65) {
    return pick(rand, [
      ['retired', 0.40],
      ['employed', 0.25],
      ['self-employed', 0.08],
      ['informal', 0.10],
      ['unemployed', 0.17],
    ]);
  }
  return pick(rand, [
    ['retired', 0.85],
    ['employed', 0.05],
    ['self-employed', 0.05],
    ['informal', 0.05],
  ]);
}

/**
 * Education conditional on age — highest level attained/attending.
 * Children can't hold tertiary degrees; the adult attainment mix only
 * applies from ~23 once completion is plausible.
 */
function educationFor(
  rand: () => number,
  age: number,
): SocietyAgent['education'] {
  if (age < 13) return 'primary';
  if (age < 18) return 'secondary';
  if (age < 20) {
    return pick(rand, [
      ['primary', 0.10],
      ['secondary', 0.90],
    ]);
  }
  if (age < 23) {
    return pick(rand, [
      ['primary', 0.12],
      ['secondary', 0.68],
      ['tertiary', 0.20],
    ]);
  }
  return pick(rand, SA_EDUCATION_MIX);
}

const SA_REGION_MIX: Array<['urban' | 'periurban' | 'rural', number]> = [
  ['urban', 0.66],
  ['periurban', 0.14],
  ['rural', 0.20],
];

// Insurance coverage by income band (proxy: medical scheme coverage from
// CMS 2023 ~17% of population; concentrated in upper income bands).
const INSURANCE_BY_INCOME: Record<SocietyAgent['incomeBand'], number> = {
  low: 0.03,
  'lower-mid': 0.10,
  mid: 0.32,
  'upper-mid': 0.74,
  high: 0.93,
};

// ─── Baseline mortality table (qx, annual) ────────────────────────────────
//
// Heuristic SA life table — blended from StatsSA mortality estimates 2024
// + GBD 2021 SA age-specific mortality. Used as the floor against which a
// scenario-driven excess mortality is added.

function baselineMortality(age: number, sex: 'M' | 'F'): number {
  const base = (() => {
    if (age < 1) return 0.025;
    if (age < 5) return 0.004;
    if (age < 15) return 0.0008;
    if (age < 25) return 0.0025;
    if (age < 35) return 0.005;
    if (age < 45) return 0.008;
    if (age < 55) return 0.014;
    if (age < 65) return 0.026;
    if (age < 75) return 0.052;
    if (age < 85) return 0.105;
    return 0.180;
  })();
  return base * (sex === 'M' ? 1.25 : 1.0);
}

// ─── Sampler ──────────────────────────────────────────────────────────────

/**
 * How the age pyramid is weighted when drawing the cohort.
 *
 * `population` (default) — StatsSA mid-year weights. The cohort matches SA's
 * real age structure, which is REQUIRED anywhere the results are scaled to
 * national totals: `aggregateMacro` multiplies cohort rates by the country
 * population, so a non-representative cohort biases excess mortality,
 * admissions and GDP drag directly.
 *
 * `age-balanced` — weight each band by its year span instead, giving a
 * roughly uniform draw over ages 0-100 and therefore comparable numbers in
 * every age decade. SA's pyramid is young: the 80+ band carries ~0.3-0.6
 * weight against ~5.4 for 0-4, so a representative draw leaves the elderly
 * decades empty or backed by a single agent.
 *
 * This is ONLY valid for estimators that condition on age — the augment
 * lookup takes a median *within* each age × sex × comorbidity bucket, and a
 * conditional estimate is invariant to the marginal age distribution.
 * Oversampling the elderly therefore sharpens the elderly buckets without
 * biasing any of them. Do NOT use it for anything that aggregates across
 * ages.
 *
 * Everything downstream of the age draw — education, employment,
 * comorbidity prevalence, baseline mortality — is conditional on age, so
 * reweighting the band choice alone leaves every one of those priors intact.
 */
export type AgeWeighting = 'population' | 'age-balanced';

export function sampleSAPopulation(args: {
  size: number;
  seed?: number;
  ageWeighting?: AgeWeighting;
}): SocietyAgent[] {
  const rand = mulberry32(args.seed ?? 1);
  const balanced = args.ageWeighting === 'age-balanced';
  const agents: SocietyAgent[] = [];
  for (let i = 0; i < args.size; i++) {
    const sex: 'M' | 'F' = rand() < 0.51 ? 'F' : 'M';
    // Age — pick band by weight then uniform within band. Weighting a band
    // by its year span makes the resulting age draw uniform, which is what
    // gives every decade comparable coverage under 'age-balanced'.
    const band = pick(
      rand,
      SA_AGE_BANDS.map(
        (b) =>
          [
            b,
            balanced ? b.band[1] - b.band[0] + 1 : sex === 'M' ? b.mWeight : b.fWeight,
          ] as [typeof b, number],
      ),
    );
    const age = Math.floor(band.band[0] + rand() * (band.band[1] - band.band[0] + 1));

    const incomeBand = pick(rand, SA_INCOME_MIX);
    const education = educationFor(rand, age);
    const region = pick(rand, SA_REGION_MIX);
    const employment = employmentFor(rand, age);

    const comorbidities: ComorbidityCode[] = [];
    for (const [code, fn] of Object.entries(SA_COMORBIDITY_PRIOR) as Array<
      [ComorbidityCode, (a: number, s: 'M' | 'F') => number]
    >) {
      if (rand() < fn(age, sex)) comorbidities.push(code);
    }

    const insuranceCoverage = clamp01(
      INSURANCE_BY_INCOME[incomeBand] + (rand() - 0.5) * 0.1,
    );

    const health: HealthProfile = {
      sex,
      comorbidities,
      baselineMortality: baselineMortality(age, sex),
      vaccinationHistory: pick(rand, [
        ['up-to-date', 0.45],
        ['partial', 0.32],
        ['none', 0.23],
      ]),
      // Trust slightly higher in tertiary-educated, slightly lower among
      // the under-30s in line with SA survey post-2021 patterns.
      trustInHealthSystem: clamp01(
        0.55 + (education === 'tertiary' || education === 'postgrad' ? 0.10 : 0) - (age < 30 ? 0.08 : 0) + (rand() - 0.5) * 0.2,
      ),
      healthLiteracy: clamp01(
        0.45 + (education === 'tertiary' ? 0.18 : 0) + (education === 'postgrad' ? 0.28 : 0) + (rand() - 0.5) * 0.15,
      ),
      insuranceCoverage,
    };

    agents.push({
      id: `sim-${i}`,
      age,
      sex,
      incomeBand,
      education,
      region,
      riskTolerance: clamp01(0.4 + (rand() - 0.5) * 0.4),
      employment,
      financialLiteracy: clamp01(
        0.35 + (education === 'tertiary' ? 0.15 : 0) + (education === 'postgrad' ? 0.25 : 0) + (rand() - 0.5) * 0.2,
      ),
      culture: 'South Africa',
      health,
    });
  }
  return agents;
}
