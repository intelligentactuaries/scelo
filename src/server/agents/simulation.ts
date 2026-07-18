// Population simulation engine — per-agent LLM call returning a strict
// JSON outcome envelope. Scenarios can be medical (new virus, drug
// introduction, treatment regimen) or social (policy change, market
// shock); the per-agent profile + reference data shapes the reaction.

import { router, type Message } from '../llm/router';
import type {
  SimulationAgentResult,
  SimulationOutcome,
  SocietyAgent,
} from '../../shared/types';

const TIER = 'society' as const;
const MAX_TOKENS = 280;

export interface SimulationOpts {
  scenario: string;
  /** Pre-formatted reference data block (PubChem / OpenFDA / ChEMBL etc).
   *  Empty string = no reference data. */
  referenceBlock: string;
  /** Concurrency cap to keep local Ollama from melting. Defaults to 12. */
  concurrency?: number;
  fresh?: boolean;
  onProgress?: (e: SimulationProgress) => void;
}

export type SimulationProgress =
  | { type: 'sim_start'; total: number }
  | { type: 'sim_progress'; done: number; total: number }
  | { type: 'sim_done'; total: number; elapsedMs: number };

function buildAgentSystemPrompt(agent: SocietyAgent, scenario: string, ref: string): string {
  const h = agent.health;
  // Minors don't answer for themselves. Under 12 (below SA's medical-consent
  // age, Children's Act s129) the caregiver speaks and decides; 12-17 speak
  // in their own voice but with a guardian involved. Under 15 nobody works
  // (BCEA s43) — stated here and enforced again after parsing.
  const youngChild = agent.age < 12;
  const minor = agent.age < 18;
  const profile = [
    `id=${agent.id}`,
    `age=${agent.age}`,
    `sex=${agent.sex ?? h?.sex ?? '?'}`,
    `income=${agent.incomeBand} (household)`,
    `education=${agent.employment === 'child' ? 'none (pre-school)' : agent.education}`,
    `employment=${agent.employment === 'child' ? 'child (below school age)' : agent.employment}`,
    `region=${agent.region}`,
    `culture=${agent.culture}`,
    `risk_tol=${agent.riskTolerance.toFixed(2)}`,
    `fin_lit=${agent.financialLiteracy.toFixed(2)}`,
  ];
  if (h) {
    profile.push(
      `comorbidities=[${h.comorbidities.join(', ') || 'none'}]`,
      `baseline_mortality=${h.baselineMortality.toFixed(4)}`,
      `vaccination=${h.vaccinationHistory}`,
      `trust_health_system=${h.trustInHealthSystem.toFixed(2)}`,
      `health_literacy=${h.healthLiteracy.toFixed(2)}`,
      `insurance_cov=${h.insuranceCoverage.toFixed(2)}`,
    );
  }
  const framing = youngChild
    ? [
        `You are the parent/guardian of ONE child, reacting to a real-world scenario.`,
        `The profile below describes THE CHILD, not you. Answer entirely on the`,
        `child's behalf: treatment, isolation, and spending decisions are yours,`,
        `costs come out of the household budget, and the rationale must speak in`,
        `the caregiver's voice ("My daughter is 2, so…", "I'd keep him home…").`,
        `The health fields still describe the CHILD's own risk.`,
      ]
    : minor
      ? [
          `You are simulating ONE person's reaction to a real-world scenario.`,
          `You are a minor (under 18) still in school. React in your own voice,`,
          `but any medical treatment involves your parent/guardian's say-so and`,
          `money usually isn't yours to spend.`,
        ]
      : [
          `You are simulating ONE person's reaction to a real-world scenario.`,
          `You are NOT an expert; you are an ordinary individual with the profile below.`,
          `React as that person would — your education, income, comorbidities, and`,
          `trust in institutions all shape your decisions.`,
        ];
  return [
    ...framing,
    ``,
    `## ${youngChild ? "The child's profile" : 'Your profile'}`,
    profile.join('\n'),
    ``,
    `## Scenario`,
    scenario.trim(),
    ``,
    ref || '',
    ``,
    `## Output protocol`,
    `Respond with JSON only (no prose, no fences), in this exact shape:`,
    `{`,
    `  "behaviour": {`,
    `    "treatmentUptake": "accepted" | "declined" | "unsure",`,
    `    "isolationDays": <0-30>,`,
    `    "spendingShift": "reduced" | "unchanged" | "increased",`,
    `    "rationale": "<=140 char first-person reason"`,
    `  },`,
    `  "health": {`,
    `    "infectionProbability": <0.0-1.0>,`,
    `    "severityIfInfected": "asymptomatic" | "mild" | "moderate" | "severe" | "critical",`,
    `    "mortalityProbability": <0.0-1.0>,`,
    `    "hospitalised": true | false`,
    `  },`,
    `  "economic": {`,
    `    "workdaysLost": <0-365>,`,
    `    "outOfPocketCostZar": <0-500000>,`,
    `    "insurerClaimZar": <0-2000000>`,
    `  }`,
    `}`,
    `Cite only data from the Reference block above; do not invent compounds,`,
    `mechanisms, or adverse events. If the scenario doesn't apply (e.g. you're`,
    `outside the affected age band), reflect that with low infectionProbability`,
    `and 0 isolationDays.`,
    `severityIfInfected, mortalityProbability, and hospitalised are all`,
    `CONDITIONAL on ${youngChild ? 'the child' : 'you'} actually being affected`,
    `(infectionProbability is the chance of that). "hospitalised" must be false`,
    `unless severityIfInfected is "moderate", "severe", or "critical".`,
    ...(agent.age < 15
      ? [
          `${youngChild ? 'The child' : 'You'} cannot legally work (SA minimum`,
          `working age is 15): workdaysLost MUST be 0. School days missed go in`,
          `isolationDays, and outOfPocketCostZar is household money spent.`,
        ]
      : []),
  ].join('\n');
}

function clampNum(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = typeof n === 'number' ? n : typeof n === 'string' ? Number(n) : NaN;
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}

function parseOutcome(text: string): SimulationOutcome {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first === -1 || last <= first) return defaultOutcome('parse failed: no JSON');
  try {
    const j = JSON.parse(cleaned.slice(first, last + 1)) as Record<string, unknown>;
    const b = (j.behaviour ?? {}) as Record<string, unknown>;
    const h = (j.health ?? {}) as Record<string, unknown>;
    const e = (j.economic ?? {}) as Record<string, unknown>;
    return {
      behaviour: {
        treatmentUptake: normaliseUptake(b.treatmentUptake),
        isolationDays: clampNum(b.isolationDays, 0, 30, 0),
        spendingShift: normaliseSpending(b.spendingShift),
        rationale: String(b.rationale ?? '').slice(0, 200),
      },
      health: (() => {
        const severityIfInfected = normaliseSeverity(h.severityIfInfected);
        return {
          infectionProbability: clampNum(h.infectionProbability, 0, 1, 0),
          severityIfInfected,
          mortalityProbability: clampNum(h.mortalityProbability, 0, 1, 0),
          // Enforce the prompt's validity rule: nobody is admitted while
          // asymptomatic or mild. Models frequently tick hospitalised=true
          // regardless, which used to inflate admissions past severe counts.
          hospitalised:
            Boolean(h.hospitalised) &&
            severityIfInfected !== 'asymptomatic' &&
            severityIfInfected !== 'mild',
        };
      })(),
      economic: {
        workdaysLost: clampNum(e.workdaysLost, 0, 365, 0),
        outOfPocketCostZar: clampNum(e.outOfPocketCostZar, 0, 500000, 0),
        insurerClaimZar: clampNum(e.insurerClaimZar, 0, 2000000, 0),
      },
    };
  } catch {
    return defaultOutcome('parse failed: invalid JSON');
  }
}

function defaultOutcome(reason: string): SimulationOutcome {
  return {
    behaviour: {
      treatmentUptake: 'unsure',
      isolationDays: 0,
      spendingShift: 'unchanged',
      rationale: reason,
    },
    health: {
      infectionProbability: 0,
      severityIfInfected: 'asymptomatic',
      mortalityProbability: 0,
      hospitalised: false,
    },
    economic: { workdaysLost: 0, outOfPocketCostZar: 0, insurerClaimZar: 0 },
  };
}

function normaliseUptake(v: unknown): 'accepted' | 'declined' | 'unsure' {
  const s = String(v ?? '').toLowerCase();
  if (s === 'accepted' || s === 'declined' || s === 'unsure') return s;
  return 'unsure';
}
function normaliseSpending(v: unknown): 'reduced' | 'unchanged' | 'increased' {
  const s = String(v ?? '').toLowerCase();
  if (s === 'reduced' || s === 'unchanged' || s === 'increased') return s;
  return 'unchanged';
}
function normaliseSeverity(
  v: unknown,
): 'asymptomatic' | 'mild' | 'moderate' | 'severe' | 'critical' {
  const s = String(v ?? '').toLowerCase();
  if (['asymptomatic', 'mild', 'moderate', 'severe', 'critical'].includes(s)) {
    return s as 'asymptomatic' | 'mild' | 'moderate' | 'severe' | 'critical';
  }
  return 'asymptomatic';
}

async function runOne(
  agent: SocietyAgent,
  scenario: string,
  ref: string,
  fresh: boolean,
): Promise<SimulationAgentResult> {
  const system = buildAgentSystemPrompt(agent, scenario, ref);
  const messages: Message[] = [
    { role: 'system', content: system },
    { role: 'user', content: 'Respond with the JSON envelope only.' },
  ];
  try {
    const raw = await router.route(messages, TIER, {
      fresh,
      maxTokens: MAX_TOKENS,
      temperature: 0.5,
    });
    const outcome = parseOutcome(raw);
    // Hard rule regardless of what the model wrote: under-15s cannot be
    // employed (SA BCEA s43), so they cannot lose workdays. Keeps the
    // 0-14 age band at zero in the macro workdays table by construction.
    if (agent.age < 15) outcome.economic.workdaysLost = 0;
    return { agent, outcome, raw };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { agent, outcome: defaultOutcome(`router error: ${msg}`), raw: '' };
  }
}

/**
 * Run the simulation across every agent with bounded concurrency.
 */
export async function runSimulation(
  agents: SocietyAgent[],
  opts: SimulationOpts,
): Promise<{ results: SimulationAgentResult[]; elapsedMs: number }> {
  const start = performance.now();
  const concurrency = opts.concurrency ?? 12;
  const total = agents.length;
  opts.onProgress?.({ type: 'sim_start', total });

  const results: SimulationAgentResult[] = new Array(total);
  let done = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < agents.length) {
      const i = cursor++;
      const agent = agents[i];
      results[i] = await runOne(agent, opts.scenario, opts.referenceBlock, !!opts.fresh);
      done++;
      // Throttle progress events — every 10 or at the boundaries.
      if (done % 10 === 0 || done === total) {
        opts.onProgress?.({ type: 'sim_progress', done, total });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, () => worker()),
  );

  const elapsedMs = Math.round(performance.now() - start);
  opts.onProgress?.({ type: 'sim_done', total, elapsedMs });
  return { results, elapsedMs };
}
