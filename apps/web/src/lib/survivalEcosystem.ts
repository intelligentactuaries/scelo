export type SurvivalScenario = "central" | "longevity" | "pandemic" | "selection";

export type SurvivalSpecies = {
  id: string;
  name: string;
  shortName: string;
  color: string;
};

export type SurvivalEcosystemParams = {
  scenario: SurvivalScenario;
  temperature: number;
  gateSteepness: number;
  survivalThreshold: number;
  learningRate: number;
  novelty: number;
  discountRate: number;
  selectedAge: number;
};

export type SurvivalHistoryPoint = {
  step: number;
  populations: number[];
  diversity: number;
  calibrationLoss: number;
  openEndedness: number;
  annuityPv: number;
  capitalStrain: number;
  turnover: number;
};

export type SurvivalEcosystemState = {
  step: number;
  ages: number[];
  years: number[];
  weights: number[][];
  dominant: number[];
  history: SurvivalHistoryPoint[];
};

export type CurvePoint = {
  year: number;
  age: number;
  targetLogMu: number;
  mixtureLogMu: number;
  speciesLogMu: number[];
};

export type SurvivalCurve = {
  name: string;
  color: string;
  points: Array<[number, number]>;
};

export const SURVIVAL_SPECIES: SurvivalSpecies[] = [
  { id: "lc", name: "Lee-Carter core", shortName: "LC", color: "#00d68f" },
  { id: "longevity", name: "Longevity wave", shortName: "LONG", color: "#7aa2f7" },
  { id: "frailty", name: "Frailty shock", shortName: "FRAIL", color: "#ff6b6b" },
  { id: "selection", name: "Selection front", shortName: "SEL", color: "#ffb454" },
  { id: "margin", name: "Reserve margin", shortName: "MARG", color: "#bb9af7" },
];

export const DEFAULT_SURVIVAL_PARAMS: SurvivalEcosystemParams = {
  scenario: "longevity",
  temperature: 0.82,
  gateSteepness: 5.2,
  survivalThreshold: 0.34,
  learningRate: 0.22,
  novelty: 0.26,
  discountRate: 0.035,
  selectedAge: 65,
};

const HISTORY_LIMIT = 180;
const START_YEAR = 2026;
const END_YEAR = 2065;
const MIN_AGE = 50;
const MAX_AGE = 100;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function sigmoid(value: number): number {
  if (value > 30) return 1;
  if (value < -30) return 0;
  return 1 / (1 + Math.exp(-value));
}

function deterministicNoise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function cellIndex(ageIdx: number, yearIdx: number, yearCount: number): number {
  return ageIdx * yearCount + yearIdx;
}

export function createSurvivalEcosystemState(): SurvivalEcosystemState {
  const ages = Array.from({ length: MAX_AGE - MIN_AGE + 1 }, (_, i) => MIN_AGE + i);
  const years = Array.from({ length: END_YEAR - START_YEAR + 1 }, (_, i) => START_YEAR + i);
  const cellCount = ages.length * years.length;
  const weights = SURVIVAL_SPECIES.map((_, speciesIdx) => {
    const values: number[] = [];
    for (let i = 0; i < cellCount; i += 1) {
      const ageIdx = Math.floor(i / years.length);
      const yearIdx = i % years.length;
      const ridge = Math.sin((ageIdx + 1) * 0.31 + speciesIdx * 1.7);
      const wave = Math.cos((yearIdx + 1) * 0.23 - speciesIdx * 0.9);
      const patch = deterministicNoise((speciesIdx + 1) * 101 + ageIdx * 13 + yearIdx * 17);
      values.push(0.18 + 0.11 * ridge + 0.08 * wave + 0.13 * patch);
    }
    return values;
  });

  const normalised = normalizeWeights(weights);
  const dominant = dominantByCell(normalised);
  const baseState: SurvivalEcosystemState = {
    step: 0,
    ages,
    years,
    weights: normalised,
    dominant,
    history: [],
  };
  return appendMetrics(baseState, DEFAULT_SURVIVAL_PARAMS, dominant);
}

export function cloneSurvivalEcosystemState(state: SurvivalEcosystemState): SurvivalEcosystemState {
  return {
    step: state.step,
    ages: [...state.ages],
    years: [...state.years],
    weights: state.weights.map((row) => [...row]),
    dominant: [...state.dominant],
    history: state.history.map((point) => ({
      ...point,
      populations: [...point.populations],
    })),
  };
}

export function stepSurvivalEcosystem(
  state: SurvivalEcosystemState,
  params: SurvivalEcosystemParams,
): SurvivalEcosystemState {
  const speciesCount = SURVIVAL_SPECIES.length;
  const cellCount = state.ages.length * state.years.length;
  const yearCount = state.years.length;
  const nextWeights = Array.from({ length: speciesCount }, () => Array(cellCount).fill(0));

  for (let ageIdx = 0; ageIdx < state.ages.length; ageIdx += 1) {
    const age = state.ages[ageIdx];
    for (let yearIdx = 0; yearIdx < state.years.length; yearIdx += 1) {
      const year = state.years[yearIdx];
      const idx = cellIndex(ageIdx, yearIdx, yearCount);
      const target = targetLogMu(age, year, params.scenario);
      const localAlive = SURVIVAL_SPECIES.map((_, speciesIdx) =>
        localMean(state.weights[speciesIdx], ageIdx, yearIdx, state.ages.length, yearCount),
      );
      const scores = SURVIVAL_SPECIES.map((_, speciesIdx) => {
        const fitted = speciesLogMu(speciesIdx, age, year);
        const calibration = -Math.abs(fitted - target);
        const neighbourhood = 0.54 * localAlive[speciesIdx];
        const frontier =
          params.novelty *
          0.22 *
          (deterministicNoise((state.step + 1) * (speciesIdx + 3) + idx * 0.37) - 0.5);
        const actuarialPreference = modelPreference(speciesIdx, age, year, params.scenario);
        return calibration * 1.35 + neighbourhood + frontier + actuarialPreference;
      });
      const competition = softmax(scores, params.temperature);

      let sum = 0;
      for (let speciesIdx = 0; speciesIdx < speciesCount; speciesIdx += 1) {
        const gate = sigmoid(
          params.gateSteepness * (localAlive[speciesIdx] - params.survivalThreshold),
        );
        const old = state.weights[speciesIdx][idx];
        const learned = old + params.learningRate * (competition[speciesIdx] * gate - old);
        const exploratory = params.novelty * 0.012 * localAlive[(speciesIdx + 1) % speciesCount];
        const value = Math.max(0.0001, learned + exploratory);
        nextWeights[speciesIdx][idx] = value;
        sum += value;
      }
      for (let speciesIdx = 0; speciesIdx < speciesCount; speciesIdx += 1) {
        nextWeights[speciesIdx][idx] /= sum;
      }
    }
  }

  emergencyRespawn(nextWeights, state.step);
  const normalised = normalizeWeights(nextWeights);
  const dominant = dominantByCell(normalised);
  const next: SurvivalEcosystemState = {
    ...state,
    step: state.step + 1,
    weights: normalised,
    dominant,
  };
  return appendMetrics(next, params, state.dominant);
}

export function runSurvivalEcosystemSteps(
  state: SurvivalEcosystemState,
  params: SurvivalEcosystemParams,
  steps: number,
): SurvivalEcosystemState {
  let next = state;
  for (let i = 0; i < steps; i += 1) {
    next = stepSurvivalEcosystem(next, params);
  }
  return next;
}

export function populationShares(state: SurvivalEcosystemState): number[] {
  const cellCount = state.ages.length * state.years.length;
  return state.weights.map((row) => row.reduce((sum, value) => sum + value, 0) / cellCount);
}

export function curveAtCurrentYear(
  state: SurvivalEcosystemState,
  params: SurvivalEcosystemParams,
): CurvePoint[] {
  const yearIdx = Math.min(state.years.length - 1, Math.floor(state.step / 3) % state.years.length);
  const year = state.years[yearIdx];
  return state.ages.map((age, ageIdx) => {
    const idx = cellIndex(ageIdx, yearIdx, state.years.length);
    const speciesValues = SURVIVAL_SPECIES.map((_, speciesIdx) =>
      speciesLogMu(speciesIdx, age, year),
    );
    const mixtureLogMu = weightedLogMu(state, idx, speciesValues);
    return {
      year,
      age,
      targetLogMu: targetLogMu(age, year, params.scenario),
      mixtureLogMu,
      speciesLogMu: speciesValues,
    };
  });
}

export function survivalCurves(
  state: SurvivalEcosystemState,
  params: SurvivalEcosystemParams,
  horizon = 35,
): SurvivalCurve[] {
  const speciesCurves = SURVIVAL_SPECIES.map((species, speciesIdx) => ({
    name: species.shortName,
    color: species.color,
    points: survivalCurveFor((age, year) => speciesLogMu(speciesIdx, age, year), params, horizon),
  }));
  return [
    {
      name: "target",
      color: "#e8e8e8",
      points: survivalCurveFor(
        (age, year) => targetLogMu(age, year, params.scenario),
        params,
        horizon,
      ),
    },
    {
      name: "ecosystem",
      color: "#00d68f",
      points: survivalCurveFor(
        (age, year, step) => {
          const ageIdx = clamp(Math.round(age) - state.ages[0], 0, state.ages.length - 1);
          const yearIdx = clamp(year - state.years[0], 0, state.years.length - 1);
          const idx = cellIndex(ageIdx, yearIdx, state.years.length);
          const speciesValues = SURVIVAL_SPECIES.map((_, speciesIdx) =>
            speciesLogMu(speciesIdx, age, year),
          );
          const blended = weightedLogMu(state, idx, speciesValues);
          const target = targetLogMu(age, year, params.scenario);
          const blendWeight = clamp(0.15 + (step / Math.max(1, horizon)) * 0.35, 0.15, 0.5);
          return blended * (1 - blendWeight) + target * blendWeight;
        },
        params,
        horizon,
      ),
    },
    ...speciesCurves,
  ];
}

export function annuityPresentValues(
  state: SurvivalEcosystemState,
  params: SurvivalEcosystemParams,
): Array<{ name: string; value: number; color: string }> {
  const rows = [
    {
      name: "target",
      value: annuityPvFor((age, year) => targetLogMu(age, year, params.scenario), params),
      color: "#e8e8e8",
    },
    {
      name: "ecosystem",
      value: annuityPvFor((age, year) => {
        const ageIdx = clamp(Math.round(age) - state.ages[0], 0, state.ages.length - 1);
        const yearIdx = clamp(year - state.years[0], 0, state.years.length - 1);
        const idx = cellIndex(ageIdx, yearIdx, state.years.length);
        const speciesValues = SURVIVAL_SPECIES.map((_, speciesIdx) =>
          speciesLogMu(speciesIdx, age, year),
        );
        return weightedLogMu(state, idx, speciesValues);
      }, params),
      color: "#00d68f",
    },
  ];
  return rows.concat(
    SURVIVAL_SPECIES.map((species, speciesIdx) => ({
      name: species.shortName,
      value: annuityPvFor((age, year) => speciesLogMu(speciesIdx, age, year), params),
      color: species.color,
    })),
  );
}

export function qxFromLogMu(logMu: number): number {
  const mu = Math.exp(clamp(logMu, -12, 3));
  return clamp(1 - Math.exp(-mu), 0, 1);
}

function targetLogMu(age: number, year: number, scenario: SurvivalScenario): number {
  const t = year - START_YEAR;
  const base = -7.75 + 0.086 * (age - 65) - 0.0105 * t + 0.00022 * (age - 74) ** 2;
  const oldAge = sigmoid((age - 74) / 4.5);
  const cohortWave = Math.exp(-((age - 72 - t * 0.18) ** 2) / 90);
  const pandemicPulse = Math.exp(-((year - 2032) ** 2) / 3.5) * sigmoid((age - 68) / 3.5);
  const selectionPulse = Math.exp(-((age - 61 - t * 0.1) ** 2) / 42) * Math.exp(-t / 25);

  if (scenario === "longevity") return base - 0.01 * t * oldAge - 0.18 * cohortWave;
  if (scenario === "pandemic") return base + 0.95 * pandemicPulse - 0.08 * cohortWave;
  if (scenario === "selection") return base + 0.38 * selectionPulse - 0.006 * t * oldAge;
  return base;
}

function speciesLogMu(speciesIdx: number, age: number, year: number): number {
  const t = year - START_YEAR;
  const base = -7.72 + 0.084 * (age - 65) - 0.0095 * t + 0.0002 * (age - 74) ** 2;
  const oldAge = sigmoid((age - 73) / 4.8);
  const cohortWave = Math.exp(-((age - 70 - t * 0.2) ** 2) / 85);
  const pandemicPulse = Math.exp(-((year - 2032) ** 2) / 4) * sigmoid((age - 67) / 3.4);
  const selectionPulse = Math.exp(-((age - 61 - t * 0.1) ** 2) / 46) * Math.exp(-t / 22);

  if (speciesIdx === 0) return base;
  if (speciesIdx === 1) return base - 0.014 * t * oldAge - 0.2 * cohortWave;
  if (speciesIdx === 2) return base + 0.82 * pandemicPulse - 0.003 * t;
  if (speciesIdx === 3) return base + 0.45 * selectionPulse - 0.006 * t * oldAge;
  return base - 0.011 * t * oldAge - 0.08 * cohortWave + 0.12 * sigmoid((age - 90) / 3);
}

function modelPreference(
  speciesIdx: number,
  age: number,
  year: number,
  scenario: SurvivalScenario,
): number {
  const t = year - START_YEAR;
  if (scenario === "longevity" && speciesIdx === 1 && age > 68) return 0.18 + 0.003 * t;
  if (scenario === "pandemic" && speciesIdx === 2 && year >= 2030 && year <= 2035) return 0.28;
  if (scenario === "selection" && speciesIdx === 3 && age >= 55 && age <= 72) return 0.2;
  if (scenario === "central" && speciesIdx === 0) return 0.12;
  if (speciesIdx === 4 && age >= 80) return 0.08;
  return 0;
}

function softmax(scores: number[], temperature: number): number[] {
  const temp = clamp(temperature, 0.08, 3);
  const scaled = scores.map((score) => score / temp);
  const max = Math.max(...scaled);
  const exp = scaled.map((score) => Math.exp(score - max));
  const sum = exp.reduce((total, value) => total + value, 0);
  return exp.map((value) => value / sum);
}

function localMean(
  values: number[],
  ageIdx: number,
  yearIdx: number,
  ageCount: number,
  yearCount: number,
): number {
  let sum = 0;
  let n = 0;
  for (let da = -1; da <= 1; da += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      const a = ageIdx + da;
      const y = yearIdx + dy;
      if (a >= 0 && a < ageCount && y >= 0 && y < yearCount) {
        sum += values[cellIndex(a, y, yearCount)];
        n += 1;
      }
    }
  }
  return sum / n;
}

function normalizeWeights(weights: number[][]): number[][] {
  if (weights.length === 0) return weights;
  const cellCount = weights[0].length;
  const out = weights.map((row) => [...row]);
  for (let idx = 0; idx < cellCount; idx += 1) {
    let sum = 0;
    for (const row of out) sum += row[idx];
    if (sum <= 0) {
      const equal = 1 / out.length;
      for (const row of out) row[idx] = equal;
    } else {
      for (const row of out) row[idx] /= sum;
    }
  }
  return out;
}

function dominantByCell(weights: number[][]): number[] {
  if (weights.length === 0) return [];
  return Array.from({ length: weights[0].length }, (_, idx) => {
    let best = 0;
    let bestValue = weights[0][idx];
    for (let speciesIdx = 1; speciesIdx < weights.length; speciesIdx += 1) {
      if (weights[speciesIdx][idx] > bestValue) {
        best = speciesIdx;
        bestValue = weights[speciesIdx][idx];
      }
    }
    return best;
  });
}

function emergencyRespawn(weights: number[][], step: number): void {
  if (weights.length === 0) return;
  const cellCount = weights[0].length;
  const floor = 0.025;
  const shares = weights.map((row) => row.reduce((sum, value) => sum + value, 0) / cellCount);
  shares.forEach((share, speciesIdx) => {
    if (share >= floor) return;
    for (let n = 0; n < 34; n += 1) {
      const idx = Math.floor(
        deterministicNoise((step + 17) * (speciesIdx + 5) * (n + 3)) * cellCount,
      );
      weights[speciesIdx][idx] += 0.18;
    }
  });
}

function appendMetrics(
  state: SurvivalEcosystemState,
  params: SurvivalEcosystemParams,
  previousDominant: number[],
): SurvivalEcosystemState {
  const populations = populationShares(state);
  const diversity = shannon(populations);
  const calibrationLoss = meanCalibrationLoss(state, params);
  const turnover =
    state.dominant.reduce(
      (count, value, idx) => count + (previousDominant[idx] !== value ? 1 : 0),
      0,
    ) / Math.max(1, state.dominant.length);
  const annuityPv = annuityPvFor((age, year) => {
    const ageIdx = clamp(Math.round(age) - state.ages[0], 0, state.ages.length - 1);
    const yearIdx = clamp(year - state.years[0], 0, state.years.length - 1);
    const idx = cellIndex(ageIdx, yearIdx, state.years.length);
    const speciesValues = SURVIVAL_SPECIES.map((_, speciesIdx) =>
      speciesLogMu(speciesIdx, age, year),
    );
    return weightedLogMu(state, idx, speciesValues);
  }, params);
  const basePv = annuityPvFor((age, year) => speciesLogMu(0, age, year), params);
  const capitalStrain = ((annuityPv - basePv) / Math.max(0.0001, basePv)) * 100;
  const openEndedness = clamp(0.58 * diversity + 0.32 * turnover + 0.1 * params.novelty, 0, 1);
  const nextPoint: SurvivalHistoryPoint = {
    step: state.step,
    populations,
    diversity,
    calibrationLoss,
    openEndedness,
    annuityPv,
    capitalStrain,
    turnover,
  };
  const history = [...state.history, nextPoint].slice(-HISTORY_LIMIT);
  return { ...state, history };
}

function shannon(values: number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0;
  const entropy = values.reduce((sum, value) => {
    const p = value / total;
    return p > 0 ? sum - p * Math.log(p) : sum;
  }, 0);
  return entropy / Math.log(values.length);
}

function meanCalibrationLoss(
  state: SurvivalEcosystemState,
  params: SurvivalEcosystemParams,
): number {
  let total = 0;
  let n = 0;
  for (let ageIdx = 0; ageIdx < state.ages.length; ageIdx += 1) {
    for (let yearIdx = 0; yearIdx < state.years.length; yearIdx += 1) {
      const idx = cellIndex(ageIdx, yearIdx, state.years.length);
      const age = state.ages[ageIdx];
      const year = state.years[yearIdx];
      const target = targetLogMu(age, year, params.scenario);
      const values = SURVIVAL_SPECIES.map((_, speciesIdx) => speciesLogMu(speciesIdx, age, year));
      total += Math.abs(weightedLogMu(state, idx, values) - target);
      n += 1;
    }
  }
  return total / Math.max(1, n);
}

function weightedLogMu(
  state: SurvivalEcosystemState,
  cell: number,
  speciesValues: number[],
): number {
  return speciesValues.reduce(
    (sum, value, speciesIdx) => sum + state.weights[speciesIdx][cell] * value,
    0,
  );
}

function survivalCurveFor(
  logMuFn: (age: number, year: number, step: number) => number,
  params: SurvivalEcosystemParams,
  horizon: number,
): Array<[number, number]> {
  let survival = 1;
  const points: Array<[number, number]> = [[0, 1]];
  for (let t = 1; t <= horizon; t += 1) {
    const age = Math.min(MAX_AGE, params.selectedAge + t - 1);
    const year = Math.min(END_YEAR, START_YEAR + t - 1);
    survival *= 1 - qxFromLogMu(logMuFn(age, year, t));
    points.push([t, Number(survival.toFixed(5))]);
  }
  return points;
}

function annuityPvFor(
  logMuFn: (age: number, year: number) => number,
  params: SurvivalEcosystemParams,
  horizon = 35,
): number {
  let survival = 1;
  let pv = 1;
  for (let t = 1; t <= horizon; t += 1) {
    const age = Math.min(MAX_AGE, params.selectedAge + t - 1);
    const year = Math.min(END_YEAR, START_YEAR + t - 1);
    survival *= 1 - qxFromLogMu(logMuFn(age, year));
    pv += survival / (1 + params.discountRate) ** t;
  }
  return Number(pv.toFixed(3));
}
