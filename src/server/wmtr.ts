// WMTR runner — wraps the lifted Nanoeconomics engine and produces the
// evidence block that gets injected into every council agent's prompt.
//
// Pipeline:
//   scenario text  ──▶  deriveConfigFromScenario  ──▶  runSingleCommunity
//                                                            │
//                                                            ▼
//                                              buildEvidenceBlock(result)
//                                                            │
//                                                            ▼
//                                  injected into personas.ts as
//                                  ## Simulator Evidence (W(M,T,R))

import {
  DEFAULT_WMTR_SINGLE_PARAMS,
  type Outcome,
  type ShockEnvironment,
  type WmtrSingleParams,
  type WmtrSingleResult,
  runSingleCommunity,
} from '../shared/wmtr';

export type InterventionParam =
  | 'alphaM'
  | 'alphaT'
  | 'alphaR'
  | 'wF'
  | 'wRel'
  | 'wS'
  | 'pProduction'
  | 'pFamily'
  | 'pReligion'
  | 'pSpatial'
  | 'pLeisure'
  | 'initFamily'
  | 'initReligion'
  | 'shock';

export const INTERVENTION_PARAMS: InterventionParam[] = [
  'alphaM',
  'alphaT',
  'alphaR',
  'wF',
  'wRel',
  'wS',
  'pProduction',
  'pFamily',
  'pReligion',
  'pSpatial',
  'pLeisure',
  'initFamily',
  'initReligion',
  'shock',
];

export interface Intervention {
  param: InterventionParam;
  direction: 'increase' | 'decrease';
  magnitude: 'small' | 'large';
  rationale: string;
}

export interface WmtrPayload {
  config: WmtrSingleParams;
  result: WmtrSingleResult;
  evidence: string;
  dominantOutcome: Outcome;
  driver: 'M' | 'T' | 'R';
}

const SCENARIO_HASH = (s: string): number => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) h = (h ^ s.charCodeAt(i)) * 16777619 >>> 0;
  return h >>> 0;
};

const KW = (s: string, words: string[]): boolean => {
  const lo = s.toLowerCase();
  return words.some((w) => lo.includes(w));
};

// Pull a coarse WMTR config from free-text scenario. Heuristic only; the
// council can later vote to override individual params via interventions.
export function deriveConfigFromScenario(
  scenario: string,
  overrides: Partial<WmtrSingleParams> = {},
): WmtrSingleParams {
  const base = { ...DEFAULT_WMTR_SINGLE_PARAMS };

  // Shock severity
  let shock: ShockEnvironment = 'moderate';
  if (KW(scenario, ['catastroph', 'war', 'pandemic', 'famine', 'collapse', 'severe', 'crisis', 'depression']))
    shock = 'severe';
  else if (KW(scenario, ['mild', 'calm', 'stable', 'benign', 'orderly', 'normal']))
    shock = 'mild';
  base.shock = shock;

  // Urban / rural cues affect spatial + R weights + α decomposition.
  if (KW(scenario, ['rural', 'village', 'subsistence', 'agrarian', 'farming', 'pastoral'])) {
    base.alphaM = 0.30;
    base.alphaT = 0.30;
    base.alphaR = 0.40;
    base.wF = 0.50;
    base.wRel = 0.30;
    base.wS = 0.20;
    base.sqftPerResident = 800;
  } else if (KW(scenario, ['urban', 'city', 'metropol', 'megacity', 'downtown'])) {
    base.alphaM = 0.50;
    base.alphaT = 0.30;
    base.alphaR = 0.20;
    base.wF = 0.30;
    base.wRel = 0.20;
    base.wS = 0.50;
    base.sqftPerResident = 220;
  }

  // Religion / faith cues
  if (KW(scenario, ['religious', 'faith', 'church', 'mosque', 'temple', 'congregat', 'spiritual'])) {
    base.initReligion = Math.min(1, base.initReligion + 0.2);
    base.pReligion = Math.min(1, base.pReligion + 0.10);
  }

  // Family / kinship cues
  if (KW(scenario, ['family', 'kinship', 'extended family', 'household', 'multigenerational'])) {
    base.initFamily = Math.min(1, base.initFamily + 0.15);
    base.pFamily = Math.min(1, base.pFamily + 0.10);
  }

  // Demographics cues
  if (KW(scenario, ['elderly', 'aging', 'retiree', 'old age'])) {
    base.pProduction = Math.max(0.1, base.pProduction - 0.10);
    base.pLeisure = Math.min(1, base.pLeisure + 0.05);
  }
  if (KW(scenario, ['youth', 'young', 'student'])) {
    base.pProduction = Math.min(1, base.pProduction + 0.05);
  }

  // Horizon cues
  if (KW(scenario, ['century', 'long-term', 'multi-generational', 'generational'])) base.horizon = 60;
  else if (KW(scenario, ['next year', 'short term', 'immediate'])) base.horizon = 10;

  // Deterministic-but-scenario-specific seed so identical scenarios produce
  // identical evidence (cache friendly), but distinct scenarios diverge.
  base.seed = SCENARIO_HASH(scenario) % 9999;
  base.nPaths = 200;

  // User overrides win over heuristic.
  return { ...base, ...overrides };
}

export function applyIntervention(
  config: WmtrSingleParams,
  intervention: Intervention,
): WmtrSingleParams {
  const next: WmtrSingleParams = { ...config };
  const smallStep = 0.07;
  const largeStep = 0.20;
  const step = intervention.magnitude === 'small' ? smallStep : largeStep;
  const sign = intervention.direction === 'increase' ? 1 : -1;

  if (intervention.param === 'shock') {
    const order: ShockEnvironment[] = ['mild', 'moderate', 'severe'];
    const idx = order.indexOf(config.shock);
    const nextIdx = Math.max(0, Math.min(2, idx + (intervention.direction === 'increase' ? 1 : -1)));
    next.shock = order[nextIdx];
    return next;
  }

  const key = intervention.param;
  const cur = config[key] as number;
  const adjusted = Math.max(0, Math.min(1, cur + sign * step));
  (next as unknown as Record<string, unknown>)[key] = adjusted;
  return next;
}

function dominantDriver(result: WmtrSingleResult): 'M' | 'T' | 'R' {
  // Look at end-of-horizon mean component values to flag which one
  // dominates the wealth term. Not normalized: this is just an
  // observation the council can react to.
  const i = result.meanM.length - 1;
  const m = result.meanM[i] ?? 0;
  const t = result.meanT[i] ?? 0;
  const r = result.meanR[i] ?? 0;
  if (m >= t && m >= r) return 'M';
  if (t >= m && t >= r) return 'T';
  return 'R';
}

export function buildEvidenceBlock(
  config: WmtrSingleParams,
  result: WmtrSingleResult,
): string {
  const last = result.years.length - 1;
  const finalMeanW = result.meanW[last] ?? 0;
  const w0 = result.w0;
  const ratio = w0 > 0 ? finalMeanW / w0 : 0;
  const finalSurv = result.meanSurv[last] ?? 0;
  const dom = result.dominant;
  const driver = dominantDriver(result);
  const buckets = result.outcomeFractions;
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

  return `## Simulator Evidence (W(M,T,R) Nanoeconomics)

A faithful Monte Carlo of the W = M^aM · T^aT · R^aR survival model was run on this scenario for ${config.horizon} years over ${config.nPaths} paths under \`${config.shock}\` shock intensity (seed=${config.seed}).

Outcome distribution across paths:
- grew:       ${pct(buckets.grew)}
- stabilized: ${pct(buckets.stabilized)}
- declined:   ${pct(buckets.declined)}
- collapsed:  ${pct(buckets.collapsed)}

Dominant path outcome: ${dom.toUpperCase()}.
Mean wealth W at year ${config.horizon}: ${finalMeanW.toFixed(3)} (W/W0 = ${ratio.toFixed(2)}).
Mean survival probability S(t=${config.horizon}): ${pct(finalSurv)}.
Dominant component at horizon: ${driver} (out of M / T / R).

Active parameters: alphaM=${config.alphaM.toFixed(2)}, alphaT=${config.alphaT.toFixed(2)}, alphaR=${config.alphaR.toFixed(2)};
relational weights wF=${config.wF.toFixed(2)}, wRel=${config.wRel.toFixed(2)}, wS=${config.wS.toFixed(2)};
time allocation prod=${config.pProduction.toFixed(2)}, family=${config.pFamily.toFixed(2)}, religion=${config.pReligion.toFixed(2)}, spatial=${config.pSpatial.toFixed(2)}, leisure=${config.pLeisure.toFixed(2)}.

Engage with these numbers in your reasoning. If you disagree with a parameter choice, you may emit a recommended_intervention in your final vote (see Deliberation protocol).`;
}

export function runWmtrForScenario(
  scenario: string,
  overrides: Partial<WmtrSingleParams> = {},
): WmtrPayload {
  const config = deriveConfigFromScenario(scenario, overrides);
  const result = runSingleCommunity(config);
  const evidence = buildEvidenceBlock(config, result);
  return {
    config,
    result,
    evidence,
    dominantOutcome: result.dominant,
    driver: dominantDriver(result),
  };
}
