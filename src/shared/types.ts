import type { MBTIType, Profession, Gender } from './constants';
import type { WmtrSingleParams, WmtrSingleResult, Outcome } from './wmtr';

export type Stance = 'support' | 'oppose' | 'abstain';

// ─── WMTR-coupled types ───────────────────────────────────────────────────

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

export interface Intervention {
  param: InterventionParam;
  direction: 'increase' | 'decrease';
  magnitude: 'small' | 'large';
  rationale: string;
}

export interface RunWmtr {
  config: WmtrSingleParams;
  result: WmtrSingleResult;
  dominantOutcome: Outcome;
  driver: 'M' | 'T' | 'R';
}

export interface InterventionCluster {
  param: InterventionParam;
  direction: 'increase' | 'decrease';
  magnitude: 'small' | 'large';
  count: number;
  exemplarRationale: string;
  agentIds: string[];
}
export type Sentiment = 'enthusiastic' | 'supportive' | 'neutral' | 'skeptical' | 'hostile';

export type Tier = 'council' | 'society' | 'chat';

export interface CouncilAgent {
  id: string;
  profession: Profession;
  mbti: MBTIType;
  gender: Gender;
}

export interface SocietyAgent {
  id: string;
  age: number;
  incomeBand: 'low' | 'lower-mid' | 'mid' | 'upper-mid' | 'high';
  education: 'primary' | 'secondary' | 'tertiary' | 'postgrad';
  region: 'urban' | 'periurban' | 'rural';
  riskTolerance: number;
  /** 'child' = below school age (0-5); minors 6-17 are 'student'. Only
   *  the SA population sampler emits 'child' — society runs sample ages
   *  16-85 and never produce it. */
  employment: 'employed' | 'self-employed' | 'informal' | 'unemployed' | 'student' | 'retired' | 'child';
  financialLiteracy: number;
  culture: string;
  /** Health profile — populated for population-simulation runs; optional on
   *  legacy society runs so the existing scenario flow keeps working. */
  health?: HealthProfile;
  sex?: 'M' | 'F';
}

/** Per-agent health profile. SA-anchored prevalences applied in
 *  saPopulation.sampleSAPopulation(); generic OECD priors used as the
 *  fallback when no country tag is provided. */
export interface HealthProfile {
  sex: 'M' | 'F';
  comorbidities: ComorbidityCode[];
  /** Annual all-cause mortality probability under baseline (no shock). */
  baselineMortality: number;
  /** Behavioural / system-of-care variables that condition the agent's
   *  reaction to a medical scenario. */
  vaccinationHistory: 'up-to-date' | 'partial' | 'none';
  /** Self-reported, 0-1. Affects vaccine uptake, adherence, etc. */
  trustInHealthSystem: number;
  /** 0-1. Affects ability to follow regimens, read inserts. */
  healthLiteracy: number;
  /** 0-1. Reduces effective infection probability for the same exposure. */
  insuranceCoverage: number;
}

export type ComorbidityCode =
  | 'hypertension'
  | 'diabetes-t2'
  | 'hiv-on-art'
  | 'hiv-not-on-art'
  | 'tb-active'
  | 'asthma'
  | 'copd'
  | 'cvd'
  | 'obesity'
  | 'ckd'
  | 'cancer-active'
  | 'immunosuppressed'
  | 'pregnancy';

/** Per-agent simulated outcome — three buckets: behavioural (what they
 *  do), health (what happens to them clinically), economic (what it
 *  costs). All three are emitted by the LLM in a strict JSON envelope. */
export interface SimulationOutcome {
  // behavioural
  behaviour: {
    treatmentUptake: 'accepted' | 'declined' | 'unsure';
    isolationDays: number; // self-imposed
    spendingShift: 'reduced' | 'unchanged' | 'increased';
    /** How the person (or, for an under-12, their caregiver) explains the
     *  decision, in their own words. Empty when the call failed — a
     *  diagnostic never goes in here. */
    rationale: string; // <=400 chars
  };
  // health
  health: {
    infectionProbability: number; // 0-1
    severityIfInfected: 'asymptomatic' | 'mild' | 'moderate' | 'severe' | 'critical';
    mortalityProbability: number; // 0-1 — conditional on infection if applicable
    hospitalised: boolean;
  };
  // economic
  economic: {
    workdaysLost: number; // 0-365
    outOfPocketCostZar: number;
    insurerClaimZar: number;
  };
}

export interface SimulationAgentResult {
  agent: SocietyAgent;
  outcome: SimulationOutcome;
  /** Raw LLM text for chat-context drilling. */
  raw: string;
  /**
   * Set when this agent produced no usable answer — the provider was
   * unreachable, or the reply could not be read as the outcome envelope.
   *
   * `outcome` is then a NEUTRAL PLACEHOLDER, not an observation: it must be
   * excluded from every aggregate. Without this flag the placeholder was
   * indistinguishable from a real "declined, no isolation, no cost" agent,
   * so a total provider outage still produced a full, confident-looking
   * table of zeros — and the diagnostic string was written into the
   * `rationale` field, where it surfaced in the dataset as if the person
   * had said it.
   */
  failure?: { kind: 'parse_failed' | 'router_error'; message: string };
}

export interface CouncilRound {
  round: 1 | 2 | 3;
  content: string;
  confidence: number;
  stance?: Stance;
  keyRisk?: string;
}

export interface CouncilAgentResult {
  agent: CouncilAgent;
  rounds: CouncilRound[];
  finalStance: Stance;
  finalConfidence: number;
  keyRisk: string;
  /** Optional WMTR parameter intervention this agent recommended. */
  intervention?: Intervention;
}

export interface SocietyAgentResult {
  agent: SocietyAgent;
  reaction: string;
  sentiment: Sentiment;
  intensity: number;
  cluster?: number;
}

export interface SocietyParams {
  ageMean: number;
  ageSpread: number;
  incomeMix: Record<SocietyAgent['incomeBand'], number>;
  educationMix: Record<SocietyAgent['education'], number>;
  urbanRatio: number;
  riskTolerance: number;
  culture: string;
  employmentMix: Record<SocietyAgent['employment'], number>;
  financialLiteracy: number;
}

export interface ProviderPrefs {
  councilProvider: 'auto' | 'anthropic' | 'openai' | 'gemini' | 'hf' | 'ollama';
  societyProvider: 'auto' | 'anthropic' | 'openai' | 'gemini' | 'hf' | 'ollama';
  chatProvider: 'auto' | 'anthropic' | 'openai' | 'gemini' | 'hf' | 'ollama';
  models?: Partial<Record<'anthropic' | 'openai' | 'gemini' | 'hf' | 'ollama', string>>;
}

export interface RunSummary {
  consensusScore: number;
  supportPct: number;
  opposePct: number;
  abstainPct: number;
  /** The most-cited risk clusters — a TOP-N slice, not the whole set. */
  topRisks: { risk: string; count: number }[];
  /** Total clusters found, and how many agents the shown slice accounts for.
   *  Without these the readback rendered 8 clusters covering 10 of 32 agents
   *  with nothing to say the other 22 existed, so a truncated list read as
   *  the council's complete set of concerns. */
  riskClusterCount: number;
  riskAgentsShown: number;
  riskAgentsTotal: number;
  /**
   * What the SUPPORTING agents said the forecast gets right.
   *
   * `topRisks` above is drawn only from agents who did NOT support, because
   * `keyRisk` carries opposite meanings on either side of the vote. Merging
   * them put a supporter's endorsement and an opposer's objection in the same
   * cluster. Optional so runs summarised before the split still deserialise.
   */
  topCaptures?: { risk: string; count: number }[];
  captureClusterCount?: number;
  captureAgentsShown?: number;
  captureAgentsTotal?: number;
  dissentingAgentIds: string[];
  /** Aggregated WMTR interventions from round-3 votes. Sorted by count desc. */
  interventionClusters?: InterventionCluster[];
}

export interface GraphEdge {
  source: string;
  target: string;
  value: number;
}

export interface SocietyClusterSummary {
  cluster: number;
  size: number;
  description: string;
  sentimentMix: Record<Sentiment, number>;
}

export interface SocietySummary {
  size: number;
  sentimentMix: Record<Sentiment, number>;
  averageIntensity: number;
  clusters: SocietyClusterSummary[];
}

export interface Run {
  id: string;
  scenario: string;
  /** ≤12-word LLM-generated tagline of the scenario, used as the
   *  centre heading once the run begins. Populated asynchronously
   *  shortly after the run starts; null until then. */
  scenarioSummary?: string;
  societyParams: SocietyParams;
  providerPrefs: ProviderPrefs;
  createdAt: number;
  status: 'pending' | 'running' | 'complete' | 'failed';
  councilResults: CouncilAgentResult[];
  councilEdges: GraphEdge[];
  societyResults: SocietyAgentResult[];
  societyEdges: GraphEdge[];
  societySummary?: SocietySummary;
  summary?: RunSummary;
  error?: string;
  timings?: {
    councilMs?: number;
    societyMs?: number;
    wmtrMs?: number;
    totalMs?: number;
  };
  /** Pre-council WMTR Monte Carlo evidence (if enabled). */
  wmtr?: RunWmtr;
  /** Parent run id when this run was spawned by an intervention re-simulation. */
  parentRunId?: string;
  /** The intervention applied by this run vs its parent (if any). */
  appliedIntervention?: Intervention;
}

export interface CanonWork {
  title: string;
  year?: number;
  abstract?: string;
  url?: string;
  takeaway?: string;
}

export interface JustificationCitation {
  source: string;
  locator: string;
  relevance: string;
}

export interface JustificationFormula {
  name: string;
  latex: string;
  applied: string;
  // Set when the latex used a backslash-command the renderer doesn't know
  // about and a one-shot re-prompt didn't fix it. UI surfaces this with an
  // amber UNVERIFIED NOTATION tag instead of silently dropping the formula.
  renderWarning?: boolean;
}

export interface Justification {
  framework: string;
  citations: JustificationCitation[];
  formulas: JustificationFormula[];
  body: string;
}

export interface JustificationResponse {
  agentId: string;
  cached: boolean;
  generatedAt: number;
  toolkitVersion: string;
  justification: Justification;
}

export interface GroupJustificationResponse {
  profession: string;
  groupSize: number;
  cached: boolean;
  generatedAt: number;
  toolkitVersion: string;
  justification: Justification;
}

export interface ProvidersInfo {
  configured: { anthropic: boolean; openai: boolean; gemini: boolean; hf: boolean };
  ollamaModels: string[];
  ollamaSelected: string | null;
  prefs: ProviderPrefs;
  /**
   * The provider + model each tier resolves to right now, straight from the
   * router's own selectProvider. Null for a tier with nothing available.
   * Read this for anything user-facing — never infer the active provider from
   * `ollamaSelected`, which says what is loaded locally, not what is used.
   */
  effective?: {
    council: { provider: string; model: string } | null;
    society: { provider: string; model: string } | null;
    chat: { provider: string; model: string } | null;
  };
}
