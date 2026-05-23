// Nanoeconomics survival simulation — TypeScript port of the Python core.
//
// Single-community Monte Carlo + multi-community society network with
// trade (gravity), migration, contagion, and R-contagion. All math is
// faithfully ported from `src/*.py` in the open-source repo:
//   github.com/intelligentactuaries/nanoeconomics-simulation
//
// Public API:
//   - DEFAULT_WMTR_SINGLE_PARAMS / DEFAULT_WMTR_SOCIETY_PARAMS
//   - runSingleCommunity(params): Monte Carlo paths + outcome stats
//   - runSocietyWithFrames(params): per-year network frames + metrics

// ─────────────────────────────────────────────────────────────────────────
// Seedable RNG (Mulberry32). Lets simulation runs be reproducible.
// ─────────────────────────────────────────────────────────────────────────

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand: () => number, mu = 0, sigma = 1): number {
  // Box-Muller. Two uniforms → one normal.
  const u1 = Math.max(rand(), 1e-12);
  const u2 = rand();
  return mu + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function poisson(rand: () => number, lambda: number): number {
  // Knuth's algorithm — fine for small λ (<10) which is our regime.
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > L);
  return k - 1;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// ─────────────────────────────────────────────────────────────────────────
// Wealth and relational capital
// ─────────────────────────────────────────────────────────────────────────

function computeW(M: number, T: number, R: number, aM: number, aT: number, aR: number): number {
  // Cobb-Douglas. Guard against zero/negative inputs (would NaN under
  // fractional exponents). The simulation never produces negatives in
  // practice but guard anyway.
  const m = Math.max(M, 1e-9);
  const t = Math.max(T, 1e-9);
  const r = Math.max(R, 1e-9);
  return Math.pow(m, aM) * Math.pow(t, aT) * Math.pow(r, aR);
}

// Logistic-bell spatial component peaking at ~250 sqft/resident
// (Jacobs 1961, Alexander 1977). Same params as the Python source.
const SPATIAL_PEAK = 250;
const SPATIAL_K = 0.015 * 3;
const SPATIAL_LOW = 100;
const SPATIAL_HIGH = 400;

function spatialR(sqftPerResident: number): number {
  if (sqftPerResident < 0) return 0;
  const left = 1 / (1 + Math.exp(-SPATIAL_K * (sqftPerResident - SPATIAL_LOW)));
  const right = 1 - 1 / (1 + Math.exp(-SPATIAL_K * (sqftPerResident - SPATIAL_HIGH)));
  const raw = left * right;
  // Normalize so peak ≈ 1.0 at SPATIAL_PEAK.
  const pkLeft = 1 / (1 + Math.exp(-SPATIAL_K * (SPATIAL_PEAK - SPATIAL_LOW)));
  const pkRight = 1 - 1 / (1 + Math.exp(-SPATIAL_K * (SPATIAL_PEAK - SPATIAL_HIGH)));
  const peak = pkLeft * pkRight;
  return peak <= 0 ? 0 : clamp(raw / peak, 0, 1);
}

function computeR(
  family: number,
  religion: number,
  sqftPerResident: number,
  wF: number,
  wRel: number,
  wS: number,
): number {
  const total = wF + wRel + wS;
  const t = total > 0 ? total : 1;
  const s = spatialR(sqftPerResident);
  return (wF / t) * family + (wRel / t) * religion + (wS / t) * s;
}

// ─────────────────────────────────────────────────────────────────────────
// Shocks
// ─────────────────────────────────────────────────────────────────────────

// Shocks. Mirrors src/shocks.py exactly — env params, target weights, and
// topology weights (idiosyncratic / local / regional / global).

export type ShockEnvironment = "mild" | "moderate" | "severe";

interface ShockEnvParams {
  // Annual Poisson rate for the shock event count
  annualShockProbability: number;
  // Severity ~ Normal(mu, sigma), clipped to (0.01, 0.90)
  meanSeverity: number;
  severityStd: number;
  // Topology mix
  pLocal: number;
  pRegional: number;
  pGlobal: number;
  pIdiosyncratic: number;
}

// Values copied verbatim from src/shocks.py (MILD_ENV, MODERATE_ENV, SEVERE_ENV).
const SHOCK_PARAMS: Record<ShockEnvironment, ShockEnvParams> = {
  mild: {
    annualShockProbability: 0.1,
    meanSeverity: 0.08,
    severityStd: 0.04,
    pLocal: 0.35,
    pRegional: 0.1,
    pGlobal: 0.02,
    pIdiosyncratic: 0.53,
  },
  moderate: {
    annualShockProbability: 0.25,
    meanSeverity: 0.15,
    severityStd: 0.08,
    pLocal: 0.35,
    pRegional: 0.2,
    pGlobal: 0.05,
    pIdiosyncratic: 0.4,
  },
  severe: {
    annualShockProbability: 0.45,
    meanSeverity: 0.25,
    severityStd: 0.12,
    pLocal: 0.3,
    pRegional: 0.3,
    pGlobal: 0.15,
    pIdiosyncratic: 0.25,
  },
};

type ShockTarget = "material" | "time" | "family" | "religion" | "meaning_crisis" | "combined";
type ShockTopology = "idiosyncratic" | "local" | "regional" | "global";

// Same weights as src/shocks.py (p_material 0.35, p_time 0.20, p_family 0.15,
// p_religion 0.10, p_meaning_crisis 0.10, p_combined 0.10).
const TARGET_WEIGHTS: { target: ShockTarget; w: number }[] = [
  { target: "material", w: 0.35 },
  { target: "time", w: 0.2 },
  { target: "family", w: 0.15 },
  { target: "religion", w: 0.1 },
  { target: "meaning_crisis", w: 0.1 },
  { target: "combined", w: 0.1 },
];

function pickTarget(rand: () => number): ShockTarget {
  let r = rand();
  for (const t of TARGET_WEIGHTS) {
    r -= t.w;
    if (r <= 0) return t.target;
  }
  return "material";
}

function pickTopology(rand: () => number, env: ShockEnvParams): ShockTopology {
  const total = env.pLocal + env.pRegional + env.pGlobal + env.pIdiosyncratic;
  let r = rand() * total;
  if ((r -= env.pLocal) <= 0) return "local";
  if ((r -= env.pRegional) <= 0) return "regional";
  if ((r -= env.pGlobal) <= 0) return "global";
  return "idiosyncratic";
}

interface ShockEvent {
  topology: ShockTopology;
  target: ShockTarget;
  severity: number;
  affected: number[]; // community indices
}

// For the SINGLE-community simulator there's only one community, so topology
// collapses to "always affects the one community". This produces a flat list
// of shocks (target + severity) for that single community.
function generateSingleShocks(
  rand: () => number,
  env: ShockEnvironment,
): { target: ShockTarget; severity: number }[] {
  const p = SHOCK_PARAMS[env];
  const n = poisson(rand, p.annualShockProbability);
  const out: { target: ShockTarget; severity: number }[] = [];
  for (let i = 0; i < n; i++) {
    const sev = clamp(gauss(rand, p.meanSeverity, p.severityStd), 0.01, 0.9);
    out.push({ target: pickTarget(rand), severity: sev });
  }
  return out;
}

// SOCIETY shock generator: produces N events per year, each affecting a subset
// of communities according to topology. Mirrors ShockGenerator.generate_shocks.
function generateSocietyShocks(
  rand: () => number,
  env: ShockEnvironment,
  nCommunities: number,
  neighbors: number[][],
  cooldown: Map<number, number>,
  currentYear: number,
): ShockEvent[] {
  const p = SHOCK_PARAMS[env];
  const n = poisson(rand, p.annualShockProbability);
  const events: ShockEvent[] = [];

  for (let s = 0; s < n; s++) {
    const topology = pickTopology(rand, p);
    const target = pickTarget(rand);
    const severity = clamp(gauss(rand, p.meanSeverity, p.severityStd), 0.01, 0.9);

    let affected: number[];
    if (nCommunities === 1) {
      affected = [0];
    } else if (topology === "idiosyncratic") {
      affected = [Math.floor(rand() * nCommunities)];
    } else if (topology === "local") {
      const center = Math.floor(rand() * nCommunities);
      const set = new Set<number>([center]);
      const nLocal = 1 + Math.floor(rand() * 3); // 1..3
      const nbrs = neighbors[center].slice(0, nLocal);
      for (const j of nbrs) set.add(j);
      affected = Array.from(set);
    } else if (topology === "regional") {
      const fraction = 0.3 + rand() * 0.2; // [0.30, 0.50)
      const nAffected = Math.max(1, Math.floor(fraction * nCommunities));
      // Sample without replacement
      const indices = Array.from({ length: nCommunities }, (_, i) => i);
      // Fisher-Yates partial shuffle
      for (let i = 0; i < nAffected; i++) {
        const j = i + Math.floor(rand() * (nCommunities - i));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      affected = indices.slice(0, nAffected);
    } else {
      // global
      affected = Array.from({ length: nCommunities }, (_, i) => i);
    }

    // Filter out communities still in cooldown
    affected = affected.filter((i) => (cooldown.get(i) ?? -1) <= currentYear);
    if (affected.length === 0) continue;

    events.push({ topology, target, severity, affected });
    for (const i of affected) cooldown.set(i, currentYear + 0.5);
  }

  return events;
}

// ─────────────────────────────────────────────────────────────────────────
// Outcome classification
// ─────────────────────────────────────────────────────────────────────────

export type Outcome = "grew" | "stabilized" | "declined" | "collapsed";
export const OUTCOME_COLOR: Record<Outcome, string> = {
  grew: "#16a34a",
  stabilized: "#3b82f6",
  declined: "#f59e0b",
  collapsed: "#dc2626",
};

export interface OutcomeThresholds {
  collapse: number; // W < collapse * W0 → collapsed candidate
  recovery: number; // consecutive periods needed to confirm collapse
  growth: number; // W(T) > W0 * (1 + growth) → grew
  stability: number; // |W(T)-W0| / W0 ≤ stability → stabilized
}

function classify(wHist: number[], w0: number, th: OutcomeThresholds): Outcome {
  // Consecutive collapse run check
  let run = 0;
  for (const w of wHist) {
    if (w < th.collapse * w0) {
      run++;
      if (run >= th.recovery) return "collapsed";
    } else {
      run = 0;
    }
  }
  const wT = wHist[wHist.length - 1];
  if (wT > w0 * (1 + th.growth)) return "grew";
  if (Math.abs(wT - w0) / w0 <= th.stability) return "stabilized";
  return "declined";
}

// ─────────────────────────────────────────────────────────────────────────
// Single-community simulation
// ─────────────────────────────────────────────────────────────────────────

export interface WmtrSingleParams {
  // Demographics
  population: number;
  sqftPerResident: number;
  // Wealth function (renormalized)
  alphaM: number;
  alphaT: number;
  alphaR: number;
  // Relational weights (renormalized)
  wF: number;
  wRel: number;
  wS: number;
  // Time allocation (renormalized)
  pProduction: number;
  pFamily: number;
  pReligion: number;
  pSpatial: number;
  pLeisure: number;
  // Initial state
  initFamily: number;
  initReligion: number;
  // Shock + thresholds
  shock: ShockEnvironment;
  thresholds: OutcomeThresholds;
  // Sim
  horizon: number;
  nPaths: number;
  seed: number;
}

export const DEFAULT_WMTR_SINGLE_PARAMS: WmtrSingleParams = {
  population: 500,
  sqftPerResident: 300,
  alphaM: 0.4,
  alphaT: 0.3,
  alphaR: 0.3,
  wF: 0.4,
  wRel: 0.3,
  wS: 0.3,
  pProduction: 0.4,
  pFamily: 0.25,
  pReligion: 0.15,
  pSpatial: 0.1,
  pLeisure: 0.1,
  initFamily: 0.7,
  initReligion: 0.6,
  shock: "moderate",
  thresholds: { collapse: 0.3, recovery: 5, growth: 0.2, stability: 0.1 },
  horizon: 30,
  nPaths: 200,
  seed: 42,
};

// Hazard: h(t) = h0 · exp(-βw · log(W/W0))
const H0 = 0.02;
const BETA_W = 2.0;

interface PathResult {
  wHist: number[];
  mHist: number[];
  tHist: number[];
  rHist: number[];
  surv: number[];
  outcome: Outcome;
}

function normalizeFive(p: number[]): number[] {
  const total = p.reduce((s, x) => s + x, 0);
  return total > 0 ? p.map((x) => x / total) : [0.2, 0.2, 0.2, 0.2, 0.2];
}

function runOnePath(p: WmtrSingleParams, rand: () => number): PathResult {
  const dt = 1.0;
  const [pProdInit, pFam, pRel, pSpInit, pLeis] = normalizeFive([
    p.pProduction,
    p.pFamily,
    p.pReligion,
    p.pSpatial,
    p.pLeisure,
  ]);
  const aSum = p.alphaM + p.alphaT + p.alphaR || 1;
  const aM = p.alphaM / aSum,
    aT = p.alphaT / aSum,
    aR = p.alphaR / aSum;

  let M = 1; // initial material capital
  let family = clamp(p.initFamily, 0, 1);
  let religion = clamp(p.initReligion, 0, 1);
  // pProd and pSp are mutated by TIME shocks (Python keeps it as a
  // TimeAllocation that gets replaced on each shock).
  let pProd = pProdInit;
  let pSp = pSpInit;
  const sqft = p.sqftPerResident;

  const Teff0 = pProd + 0.3 * pLeis;
  const R0 = computeR(family, religion, sqft, p.wF, p.wRel, p.wS);
  const W0 = computeW(M, Teff0, R0, aM, aT, aR);

  const wHist: number[] = [W0];
  const mHist: number[] = [M];
  const tHist: number[] = [Teff0];
  const rHist: number[] = [R0];
  const surv: number[] = [1];
  let cumHaz = 0;

  // Cooldown so the same community isn't hammered repeatedly within 0.5 years
  let cooldown = 0;

  for (let yr = 1; yr <= p.horizon; yr++) {
    // Material capital growth (production-driven) minus maintenance drain
    const mGrowth = 0.04 * pProd * M * dt;
    const mDrain = 0.01 * M * dt;
    M = Math.max(M + mGrowth - mDrain, 1e-6);

    // Apply shocks if not in cooldown
    let mcSeverity = 0;
    if (cooldown <= 0) {
      const shocks = generateSingleShocks(rand, p.shock);
      for (const s of shocks) {
        if (s.target === "material" || s.target === "combined") {
          M = Math.max(M * (1 - s.severity), 1e-6);
        }
        if (s.target === "time" || s.target === "combined") {
          // Mirror Python: reduce production time fraction by 0.5·s·prod,
          // shift half of the reduction into spatial maintenance (the other
          // half is "lost"). This persists into future years' Teff.
          const prodReduction = pProd * s.severity * 0.5;
          pProd = Math.max(pProd - prodReduction, 0.01);
          pSp = pSp + prodReduction * 0.5;
        }
        if (s.target === "family") {
          family = Math.max(family * (1 - s.severity), 0);
        }
        if (s.target === "religion") {
          religion = Math.max(religion * (1 - s.severity), 0);
        }
        if (s.target === "meaning_crisis") {
          mcSeverity = Math.max(mcSeverity, s.severity);
        }
      }
      if (shocks.length > 0) cooldown = 0.5;
    } else {
      cooldown -= dt;
    }

    // Relational dynamics (mirrors RelationalState.step)
    const familyMin = 0.1;
    if (pFam >= familyMin) {
      family = clamp(family + 0.1 * pFam * dt, 0, 1);
    } else {
      family = clamp(family - 0.05 * dt, 0, 1);
    }
    const religionMin = 0.05;
    const effRelTime = pRel * (1.0 + religion * 0.2);
    if (pRel >= religionMin) {
      religion = clamp(religion + 0.08 * effRelTime * dt, 0, 1);
    } else {
      religion = clamp(religion - 0.03 * dt, 0, 1);
    }
    // Religion buffers meaning-crisis shocks
    if (mcSeverity > 0) {
      religion = clamp(religion - mcSeverity * religion * 0.1 * dt, 0, 1);
    }

    const Teff = pProd + 0.3 * pLeis;
    const R = computeR(family, religion, sqft, p.wF, p.wRel, p.wS);
    const W = computeW(M, Teff, R, aM, aT, aR);

    // Hazard + survival accumulation
    const h = H0 * Math.exp(-BETA_W * Math.log(Math.max(W / W0, 1e-6)));
    cumHaz += h * dt;
    surv.push(Math.exp(-cumHaz));

    wHist.push(W);
    mHist.push(M);
    tHist.push(Teff);
    rHist.push(R);
  }

  return {
    wHist,
    mHist,
    tHist,
    rHist,
    surv,
    outcome: classify(wHist, W0, p.thresholds),
  };
}

export interface WmtrSingleResult {
  years: number[];
  paths: PathResult[];
  meanW: number[];
  p10W: number[];
  p25W: number[];
  p75W: number[];
  p90W: number[];
  meanSurv: number[];
  meanM: number[];
  meanT: number[];
  meanR: number[];
  outcomeFractions: Record<Outcome, number>;
  dominant: Outcome;
  w0: number;
  config: WmtrSingleParams;
  elapsedMs: number;
}

function percentile(sorted: number[], pct: number): number {
  const idx = clamp(Math.floor((pct / 100) * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[idx];
}

export function runSingleCommunity(params: WmtrSingleParams): WmtrSingleResult {
  const t0 = performance.now();
  const rand = rng(params.seed);
  const paths: PathResult[] = [];
  for (let i = 0; i < params.nPaths; i++) paths.push(runOnePath(params, rand));

  const T = params.horizon + 1;
  const years = Array.from({ length: T }, (_, i) => i);
  const aggregate = (key: keyof PathResult, pct: number | "mean"): number[] => {
    const out: number[] = [];
    for (let i = 0; i < T; i++) {
      const col = paths.map((p) => (p[key] as number[])[i]).sort((a, b) => a - b);
      out.push(pct === "mean" ? col.reduce((s, x) => s + x, 0) / col.length : percentile(col, pct));
    }
    return out;
  };

  const counts: Record<Outcome, number> = { grew: 0, stabilized: 0, declined: 0, collapsed: 0 };
  paths.forEach((p) => counts[p.outcome]++);
  const total = paths.length || 1;
  const fracs: Record<Outcome, number> = {
    grew: counts.grew / total,
    stabilized: counts.stabilized / total,
    declined: counts.declined / total,
    collapsed: counts.collapsed / total,
  };
  let dominant: Outcome = "stabilized";
  let best = -1;
  (Object.keys(fracs) as Outcome[]).forEach((k) => {
    if (fracs[k] > best) {
      best = fracs[k];
      dominant = k;
    }
  });

  return {
    years,
    paths,
    meanW: aggregate("wHist", "mean"),
    p10W: aggregate("wHist", 10),
    p25W: aggregate("wHist", 25),
    p75W: aggregate("wHist", 75),
    p90W: aggregate("wHist", 90),
    meanSurv: aggregate("surv", "mean"),
    meanM: aggregate("mHist", "mean"),
    meanT: aggregate("tHist", "mean"),
    meanR: aggregate("rHist", "mean"),
    outcomeFractions: fracs,
    dominant,
    w0: paths[0]?.wHist[0] ?? 1,
    config: params,
    elapsedMs: performance.now() - t0,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Society network simulation
// ─────────────────────────────────────────────────────────────────────────

export type Archetype =
  | "strong_nuclear_religious_dense"
  | "independent_secular_suburban"
  | "extended_kin_religious_dense"
  | "mixed_diverse";

export const ARCHETYPE_LABEL: Record<Archetype, string> = {
  strong_nuclear_religious_dense: "Strong nuclear + religious + dense",
  independent_secular_suburban: "Independent + secular + suburban",
  extended_kin_religious_dense: "Extended kin + religious + dense",
  mixed_diverse: "Mixed / diverse",
};

interface ArchetypeSpec {
  pop: [number, number];
  sqft: [number, number];
  wF: number;
  wRel: number;
  wS: number;
  pProd: number;
  pFam: number;
  pRel: number;
  pSp: number;
  pLeis: number;
}

const ARCHETYPE_SPECS: Record<Archetype, ArchetypeSpec> = {
  strong_nuclear_religious_dense: {
    pop: [300, 500],
    sqft: [150, 280],
    wF: 0.5,
    wRel: 0.3,
    wS: 0.2,
    pProd: 0.35,
    pFam: 0.3,
    pRel: 0.2,
    pSp: 0.08,
    pLeis: 0.07,
  },
  independent_secular_suburban: {
    pop: [400, 700],
    sqft: [600, 1200],
    wF: 0.3,
    wRel: 0.1,
    wS: 0.6,
    pProd: 0.5,
    pFam: 0.15,
    pRel: 0.05,
    pSp: 0.15,
    pLeis: 0.15,
  },
  extended_kin_religious_dense: {
    pop: [300, 450],
    sqft: [130, 250],
    wF: 0.45,
    wRel: 0.35,
    wS: 0.2,
    pProd: 0.3,
    pFam: 0.35,
    pRel: 0.2,
    pSp: 0.08,
    pLeis: 0.07,
  },
  mixed_diverse: {
    pop: [300, 600],
    sqft: [250, 600],
    wF: 0.35,
    wRel: 0.25,
    wS: 0.4,
    pProd: 0.4,
    pFam: 0.22,
    pRel: 0.13,
    pSp: 0.12,
    pLeis: 0.13,
  },
};

export interface WmtrSocietyParams {
  nCommunities: number;
  archetypeFractions: Record<Archetype, number>;
  spatialSpread: number;
  networkK: number;
  tradeStrength: number;
  migrationFriction: number;
  rContagionStrength: number;
  shock: ShockEnvironment;
  horizon: number;
  seed: number;
  thresholds: OutcomeThresholds;
}

export const DEFAULT_WMTR_SOCIETY_PARAMS: WmtrSocietyParams = {
  nCommunities: 30,
  archetypeFractions: {
    strong_nuclear_religious_dense: 0.25,
    independent_secular_suburban: 0.25,
    extended_kin_religious_dense: 0.25,
    mixed_diverse: 0.25,
  },
  spatialSpread: 50,
  networkK: 4,
  tradeStrength: 1.0,
  migrationFriction: 0.3,
  rContagionStrength: 0.3,
  shock: "moderate",
  horizon: 30,
  seed: 42,
  thresholds: { collapse: 0.3, recovery: 5, growth: 0.2, stability: 0.1 },
};

interface CommunityState {
  M: number;
  family: number;
  religion: number;
  sqft: number;
  // pProd/pSp are mutated by TIME shocks; pLeis/pFam/pRelTime stay constant.
  pProd: number;
  pFam: number;
  pRelTime: number;
  pSp: number;
  pLeis: number;
  archetype: Archetype;
  pop: number;
  pos: [number, number];
  W0: number;
  wHist: number[];
  mHist: number[];
  alive: boolean;
  spec: ArchetypeSpec;
}

export interface WmtrSocietyFrame {
  year: number;
  positions: [number, number][];
  ws: number[];
  rs: number[];
  alive: boolean[];
  totalWealth: number;
  meanWealth: number;
  gini: number;
  migrationFlux: number;
  nGrew: number;
  nStabilized: number;
  nDeclined: number;
  nCollapsed: number;
  nInProgress: number;
  // For visual edge styling (which edges are active this year, e.g. trade flow)
  edgeFlux: number[];
}

export interface WmtrSocietyResult {
  config: WmtrSocietyParams;
  archetypes: Archetype[];
  positions: [number, number][];
  edges: [number, number][];
  /** Initial wealth per community (W₀); used by the UI for size scaling. */
  w0s: number[];
  frames: WmtrSocietyFrame[];
  finalOutcomes: Outcome[];
  elapsedMs: number;
}

function pickArchetype(rand: () => number, fracs: Record<Archetype, number>): Archetype {
  const keys = Object.keys(fracs) as Archetype[];
  const total = keys.reduce((s, k) => s + Math.max(fracs[k], 0), 0);
  if (total <= 0) return "mixed_diverse";
  let r = rand() * total;
  for (const k of keys) {
    r -= Math.max(fracs[k], 0);
    if (r <= 0) return k;
  }
  return keys[keys.length - 1];
}

function uniformRange(rand: () => number, [lo, hi]: [number, number]): number {
  return lo + rand() * (hi - lo);
}

function buildKnnGraph(positions: [number, number][], k: number): [number, number][] {
  const n = positions.length;
  const edges = new Set<string>();
  for (let i = 0; i < n; i++) {
    const dists: { j: number; d: number }[] = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const dx = positions[i][0] - positions[j][0];
      const dy = positions[i][1] - positions[j][1];
      dists.push({ j, d: dx * dx + dy * dy });
    }
    dists.sort((a, b) => a.d - b.d);
    for (let m = 0; m < Math.min(k, dists.length); m++) {
      const a = i,
        b = dists[m].j;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      edges.add(key);
    }
  }
  return Array.from(edges).map((s) => {
    const [a, b] = s.split("-").map(Number);
    return [a, b] as [number, number];
  });
}

function gini(ws: number[]): number {
  if (ws.length === 0) return 0;
  const sorted = [...ws].sort((a, b) => a - b);
  const n = sorted.length;
  let sum = 0;
  let weighted = 0;
  for (let i = 0; i < n; i++) {
    sum += sorted[i];
    weighted += (i + 1) * sorted[i];
  }
  if (sum <= 0) return 0;
  return (2 * weighted) / (n * sum) - (n + 1) / n;
}

export function runSocietyWithFrames(p: WmtrSocietyParams): WmtrSocietyResult {
  const t0 = performance.now();
  const rand = rng(p.seed);
  const n = p.nCommunities;

  // 1. Pick archetypes + initialize communities
  const archetypes: Archetype[] = [];
  const positions: [number, number][] = [];
  const states: CommunityState[] = [];
  // Alphas use the defaults (0.4 / 0.3 / 0.3, summing to 1) — society
  // archetypes don't override these.
  const aM = 0.4,
    aT = 0.3,
    aR = 0.3;

  for (let i = 0; i < n; i++) {
    const arch = pickArchetype(rand, p.archetypeFractions);
    const spec = ARCHETYPE_SPECS[arch];
    const pop = Math.round(uniformRange(rand, spec.pop));
    const sqft = uniformRange(rand, spec.sqft);
    const family = clamp(spec.wF * 0.9, 0, 1);
    const religion = clamp(spec.wRel * 0.9, 0, 1);
    const [pProd, pFamT, pRelT, pSp, pLeis] = normalizeFive([
      spec.pProd,
      spec.pFam,
      spec.pRel,
      spec.pSp,
      spec.pLeis,
    ]);
    const Teff = pProd + 0.3 * pLeis;
    const R0 = computeR(family, religion, sqft, spec.wF, spec.wRel, spec.wS);
    const M = 1;
    const W0 = computeW(M, Teff, R0, aM, aT, aR);

    const pos: [number, number] = [rand() * p.spatialSpread, rand() * p.spatialSpread];

    archetypes.push(arch);
    positions.push(pos);
    states.push({
      M,
      family,
      religion,
      sqft,
      pProd,
      pFam: pFamT,
      pRelTime: pRelT,
      pSp,
      pLeis,
      archetype: arch,
      pop,
      pos,
      W0,
      wHist: [W0],
      mHist: [M],
      alive: true,
      spec,
    });
  }

  // 2. Build k-NN graph
  const edges = buildKnnGraph(positions, Math.min(p.networkK, Math.max(n - 1, 1)));
  // Adjacency: index i → neighbors[]
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) {
    adj[a].push(b);
    adj[b].push(a);
  }

  // 3. Step through time, emitting one frame per year
  const frames: WmtrSocietyFrame[] = [];
  const dt = 1.0;
  // Per-community cooldown (year a community is allowed to be shocked again)
  const cooldown = new Map<number, number>();
  frames.push(buildFrame(0, states, edges, 0, p.thresholds));

  for (let yr = 1; yr <= p.horizon; yr++) {
    // 1. Generate shock events FIRST (Python order). Each event has a
    //    topology and a list of affected community indices.
    const events = generateSocietyShocks(rand, p.shock, n, adj, cooldown, yr);

    // 2. Trade gravity model — uses W (computed wealth), NOT M alone.
    //    Mirrors Python: kappa * W_i * W_j / (d² + ε)
    const currentW = states.map((s) => s.wHist[s.wHist.length - 1]);
    const tradeBoost = new Array(n).fill(0);
    const edgeFlux = new Array(edges.length).fill(0);
    const kappa = 0.002 * p.tradeStrength;
    const eps = 1.0;
    edges.forEach(([a, b], eIdx) => {
      if (!states[a].alive || !states[b].alive) return;
      const dx = positions[a][0] - positions[b][0];
      const dy = positions[a][1] - positions[b][1];
      const d2 = dx * dx + dy * dy + eps;
      const flow = (kappa * currentW[a] * currentW[b]) / d2;
      tradeBoost[a] += flow * dt;
      tradeBoost[b] += flow * dt;
      edgeFlux[eIdx] = flow;
    });

    // 3. R-contagion: each community nudges toward neighbor mean R
    const currentR = states.map((s) =>
      computeR(s.family, s.religion, s.sqft, s.spec.wF, s.spec.wRel, s.spec.wS),
    );
    const rPull = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      if (adj[i].length === 0) continue;
      const meanNbr = adj[i].reduce((s, j) => s + currentR[j], 0) / adj[i].length;
      rPull[i] = p.rContagionStrength * (meanNbr - currentR[i]) * dt * 0.1;
    }

    // 4. Step each community
    let migrationFlux = 0;
    for (let i = 0; i < n; i++) {
      const s = states[i];
      if (!s.alive) {
        s.wHist.push(s.wHist[s.wHist.length - 1]);
        s.mHist.push(s.M);
        continue;
      }

      // Material capital with trade boost
      const mGrowth = 0.04 * s.pProd * s.M * dt;
      const mDrain = 0.01 * s.M * dt;
      s.M = Math.max(s.M + mGrowth - mDrain + tradeBoost[i], 1e-6);

      // Apply only the events that target THIS community
      let mcSeverity = 0;
      for (const ev of events) {
        if (!ev.affected.includes(i)) continue;
        const sev = ev.severity;
        if (ev.target === "material" || ev.target === "combined") {
          s.M = Math.max(s.M * (1 - sev), 1e-6);
        }
        if (ev.target === "time" || ev.target === "combined") {
          // Reduce production time fraction (persists into future years)
          const reduction = s.pProd * sev * 0.5;
          s.pProd = Math.max(s.pProd - reduction, 0.01);
          s.pSp = s.pSp + reduction * 0.5;
        }
        if (ev.target === "family") s.family = Math.max(s.family * (1 - sev), 0);
        if (ev.target === "religion") s.religion = Math.max(s.religion * (1 - sev), 0);
        if (ev.target === "meaning_crisis") mcSeverity = Math.max(mcSeverity, sev);
      }

      // Relational dynamics
      if (s.pFam >= 0.1) {
        s.family = clamp(s.family + 0.1 * s.pFam * dt, 0, 1);
      } else {
        s.family = clamp(s.family - 0.05 * dt, 0, 1);
      }
      const effRel = s.pRelTime * (1.0 + s.religion * 0.2);
      if (s.pRelTime >= 0.05) {
        s.religion = clamp(s.religion + 0.08 * effRel * dt, 0, 1);
      } else {
        s.religion = clamp(s.religion - 0.03 * dt, 0, 1);
      }
      if (mcSeverity > 0) {
        s.religion = clamp(s.religion - mcSeverity * s.religion * 0.1 * dt, 0, 1);
      }

      // R-contagion application — split nudge across family + religion
      s.family = clamp(s.family + rPull[i] * 0.5, 0, 1);
      s.religion = clamp(s.religion + rPull[i] * 0.5, 0, 1);

      const Teff = s.pProd + 0.3 * s.pLeis;
      const R = computeR(s.family, s.religion, s.sqft, s.spec.wF, s.spec.wRel, s.spec.wS);
      const W = computeW(s.M, Teff, R, aM, aT, aR);

      s.wHist.push(W);
      s.mHist.push(s.M);

      // 5. Migration: trigger when W < migration_threshold·W0; transfer μ·M to a richer neighbor
      const tauM = 0.6;
      if (W < tauM * s.W0) {
        let bestJ = -1;
        let bestW = Number.NEGATIVE_INFINITY;
        for (const j of adj[i]) {
          if (!states[j].alive) continue;
          const Wj = states[j].wHist[states[j].wHist.length - 1];
          if (Wj > bestW) {
            bestW = Wj;
            bestJ = j;
          }
        }
        if (bestJ >= 0 && bestW > W) {
          const mu = 0.02 * (1 - p.migrationFriction);
          const transfer = mu * s.M;
          s.M = Math.max(s.M - transfer, 1e-6);
          states[bestJ].M += transfer * 0.8; // friction loss
          migrationFlux += transfer;
        }
      }
    }

    // Mark collapsed communities (post-step, using full history so far)
    for (const s of states) {
      if (!s.alive) continue;
      let run = 0;
      for (const w of s.wHist) {
        if (w < p.thresholds.collapse * s.W0) {
          run++;
          if (run >= p.thresholds.recovery) {
            s.alive = false;
            break;
          }
        } else {
          run = 0;
        }
      }
    }

    frames.push(buildFrame(yr, states, edges, migrationFlux, p.thresholds, edgeFlux));
  }

  // Final outcome per community
  const finalOutcomes: Outcome[] = states.map((s) => classify(s.wHist, s.W0, p.thresholds));

  return {
    config: p,
    archetypes,
    positions,
    edges,
    w0s: states.map((s) => s.W0),
    frames,
    finalOutcomes,
    elapsedMs: performance.now() - t0,
  };
}

function buildFrame(
  year: number,
  states: CommunityState[],
  edges: [number, number][],
  migrationFlux: number,
  th: OutcomeThresholds,
  edgeFlux?: number[],
): WmtrSocietyFrame {
  const ws = states.map((s) => s.wHist[s.wHist.length - 1]);
  const rs = states.map((s) =>
    computeR(s.family, s.religion, s.sqft, s.spec.wF, s.spec.wRel, s.spec.wS),
  );
  const alive = states.map((s) => s.alive);
  const total = ws.reduce((sum, w, i) => sum + w * (states[i].pop || 1), 0);
  const mean = ws.reduce((s, w) => s + w, 0) / Math.max(ws.length, 1);
  const g = gini(ws);

  // Interim outcomes (this year)
  let nG = 0,
    nS = 0,
    nD = 0,
    nC = 0,
    nIp = 0;
  states.forEach((s) => {
    const w = s.wHist[s.wHist.length - 1];
    let run = 0;
    let collapsed = false;
    for (const wi of s.wHist) {
      if (wi < th.collapse * s.W0) {
        run++;
        if (run >= th.recovery) {
          collapsed = true;
          break;
        }
      } else {
        run = 0;
      }
    }
    if (collapsed) {
      nC++;
      return;
    }
    if (year < 5) {
      nIp++;
      return;
    }
    if (w > s.W0 * (1 + th.growth)) nG++;
    else if (Math.abs(w - s.W0) / s.W0 <= th.stability) nS++;
    else if (w < s.W0) nD++;
    else nIp++;
  });

  return {
    year,
    positions: states.map((s) => s.pos),
    ws,
    rs,
    alive,
    totalWealth: total,
    meanWealth: mean,
    gini: g,
    migrationFlux,
    nGrew: nG,
    nStabilized: nS,
    nDeclined: nD,
    nCollapsed: nC,
    nInProgress: nIp,
    edgeFlux: edgeFlux ?? new Array(edges.length).fill(0),
  };
}
