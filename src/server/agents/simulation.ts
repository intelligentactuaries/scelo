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
/**
 * The envelope alone is ~180 tokens once a model pretty-prints it the way the
 * protocol below shows it, and the rationale is now two or three spoken
 * sentences rather than a 140-character fragment. At the old 280 the reply
 * was routinely cut off mid-object, which arrives here as unparseable JSON —
 * the "parse failed: invalid JSON" cells were mostly truncation, not a model
 * that can't write JSON.
 */
const MAX_TOKENS = 700;
/** Rationale cap, applied after parsing. Kept in step with the prompt's own
 *  stated limit — when these two drift the model writes to one number and
 *  gets cut at the other, mid-word. */
const RATIONALE_MAX_CHARS = 400;
/** Employment states that can actually lose a paid workday. Mirrors the zero
 *  wage `macroMap.dailyWageFor` assigns to everyone else. */
const WORKING_EMPLOYMENT = new Set<SocietyAgent['employment']>([
  'employed',
  'self-employed',
  'informal',
]);

export interface SimulationOpts {
  scenario: string;
  /** Pre-formatted reference data block (PubChem / OpenFDA / ChEMBL etc).
   *  Empty string = no reference data. */
  referenceBlock: string;
  /** Concurrency cap to keep local Ollama from melting. Defaults to 12. */
  concurrency?: number;
  fresh?: boolean;
  /** The run's population seed. Folded into the LLM cache key so each draw
   *  is independent, and so re-running a pinned seed reproduces it exactly. */
  seed?: number;
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
  // Who is speaking, and how the rationale must read. The two used to
  // disagree: the caregiver framing said "speak as the parent" while the
  // output protocol asked for a "first-person reason", so the model split the
  // difference and produced impersonal fragments — which is how a 2-year-old
  // ended up with a stated opinion. Voice is now decided once, here, and the
  // protocol quotes this same description instead of hard-coding a person.
  const child = youngChild
    ? agent.sex === 'F'
      ? 'daughter'
      : agent.sex === 'M'
        ? 'son'
        : 'child'
    : null;
  const them = agent.sex === 'F' ? 'her' : agent.sex === 'M' ? 'him' : 'them';
  // Where the child spends the day, so the caregiver's example doesn't put a
  // 10-year-old back in crèche.
  const dayPlace = agent.age < 6 ? 'crèche' : 'school';
  const voice = youngChild
    ? `the caregiver's own voice, speaking ABOUT the ${child} in the third person ("My ${child} is only ${agent.age}, so…", "I'd keep ${them} home from ${dayPlace}…"). NEVER write as the ${child}: a ${agent.age}-year-old does not explain their own medical decisions`
    : minor
      ? `your own voice as a ${agent.age}-year-old, mentioning a parent or guardian where they'd be the one deciding`
      : `your own voice, first person`;
  const framing = youngChild
    ? [
        `You are the parent/guardian of ONE young child, reacting to a real-world`,
        `scenario. The profile below describes THE CHILD, not you. Answer entirely`,
        `on the child's behalf: treatment, isolation and spending decisions are`,
        `yours to make, and the costs come out of your household budget.`,
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
    `    "rationale": "2-3 sentences, <=${RATIONALE_MAX_CHARS} chars"`,
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
    ``,
    `### The rationale field`,
    `Write it in ${voice}.`,
    `Speak the way a real person answers a question from a neighbour: 2-3 plain`,
    `sentences, contractions welcome, naming the ONE thing that actually decided`,
    `it for you. Say what you are weighing — the cost against this month's money,`,
    `the clinic queue, what happened last time, who else is in the house, whether`,
    `you believe what you've been told.`,
    `Do NOT write a telegram ("Free vaccine, trust health system") — that is a`,
    `label, not a reason, and it is useless to whoever reads this dataset.`,
    `Do NOT restate the profile fields back as a list, and do NOT quote their`,
    `labels at yourself — a person says "money's tight this month", never "my`,
    `income band is low" or "my trust in the health system is 0.3".`,
    `Do NOT open by announcing the decision ("Accepted the vaccine because…") —`,
    `the decision is already in the fields above. Start with the reason.`,
    `Do NOT mention the profile, this exercise, probabilities, or that you are`,
    `simulating anyone.`,
    ...(WORKING_EMPLOYMENT.has(agent.employment)
      ? []
      : [
          `You are ${agent.employment === 'child' ? 'a pre-school child' : agent.employment},`,
          `so do not talk about losing pay or missing work — that is not your`,
          `situation, and workdaysLost must be 0.`,
        ]),
    `Ground it in this person's actual circumstances: a ${agent.incomeBand}-income`,
    `${agent.region} household${
      h && h.comorbidities.length ? ` with ${h.comorbidities.join(' and ')}` : ''
    } does not reason like anyone else's.`,
    ``,
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

/**
 * Read the model's reply as JSON, tolerating the three ways a small local
 * model routinely fails to emit it cleanly:
 *
 *   1. fences and a chatty preamble around the object,
 *   2. a trailing comma before a closing brace,
 *   3. the reply being cut off at the token ceiling, so the closing braces
 *      never arrive at all.
 *
 * (3) was the big one: an object truncated mid-value has a `}` somewhere
 * inside it, so slicing to the LAST `}` produced a fragment that could never
 * parse. Balancing the delimiters recovers every field the model did finish,
 * which is nearly all of them — far better than discarding the whole agent.
 */
export function repairJson(text: string): string | null {
  const cleaned = text
    .replace(/^[^{]*?```(?:json)?\s*/i, '')
    .replace(/```[\s\S]*$/i, '')
    .trim();
  const first = cleaned.indexOf('{');
  if (first === -1) return null;
  let body = cleaned.slice(first);

  // Walk the text tracking string state so braces inside a rationale ("I'd
  // say {maybe}") never count as structure.
  let inString = false;
  let escaped = false;
  let end = -1;
  const stack: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\') {
      escaped = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      stack.pop();
      if (stack.length === 0) {
        end = i;
        break;
      }
    }
  }

  if (end !== -1) {
    body = body.slice(0, end + 1);
  } else {
    // Truncated. Close whatever is still open, innermost first. An unfinished
    // string has to be closed before its container.
    if (inString) body += '"';
    // Peel off whatever the cut left dangling before the braces land: a
    // trailing comma, a key with no value, or a key severed before its own
    // colon. Looped because removing one can expose the next. The delimiter
    // capture is what keeps a trailing VALUE — preceded by `:`, not by `{`
    // or `,` — from being mistaken for a dangling key and discarded.
    for (;;) {
      const before = body;
      body = body
        .replace(/[,\s]+$/, '')
        .replace(/([{,])\s*"(?:[^"\\]|\\.)*"\s*:?\s*$/, (_m, delim: string) =>
          delim === '{' ? '{' : '',
        );
      if (body === before) break;
    }
    for (let i = stack.length - 1; i >= 0; i--) body += stack[i];
  }
  // Trailing commas are legal in JS, not in JSON.
  return body.replace(/,(\s*[}\]])/g, '$1');
}

export function parseOutcome(text: string): { outcome: SimulationOutcome; failure?: string } {
  const repaired = repairJson(text);
  if (repaired === null) return { outcome: neutralOutcome(), failure: 'no JSON in reply' };
  try {
    const j = JSON.parse(repaired) as Record<string, unknown>;
    const b = (j.behaviour ?? {}) as Record<string, unknown>;
    const h = (j.health ?? {}) as Record<string, unknown>;
    const e = (j.economic ?? {}) as Record<string, unknown>;
    const rationale = String(b.rationale ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, RATIONALE_MAX_CHARS);
    // A reply whose envelope parsed but carries no reason is not a usable
    // agent — every downstream reader treats the rationale as the evidence.
    if (!rationale) {
      return { outcome: neutralOutcome(), failure: 'reply carried no rationale' };
    }
    const severityIfInfected = normaliseSeverity(h.severityIfInfected);
    // Couple the health fields to the severity the model just reported.
    // Untethered, they contradicted the macro panel outright — 136,000
    // expected deaths beside a severe-or-critical count of zero, because
    // mortality was read straight off a reply that had also said
    // "asymptomatic".
    //
    // Admission needs moderate+ (the prompt's own rule). Death needs severe+:
    // fatalities are modelled as passing through severe or critical illness,
    // which keeps deaths ≤ severe/critical ≤ admissions instead of letting
    // the three tiles disagree about the same cohort. Deaths from an
    // unhospitalised moderate case are real but rare, and excluding them is
    // the standard simplification — noted in SA_MACRO_PROVENANCE.
    const admissible =
      severityIfInfected === 'moderate' ||
      severityIfInfected === 'severe' ||
      severityIfInfected === 'critical';
    const fatal = severityIfInfected === 'severe' || severityIfInfected === 'critical';
    return {
      outcome: {
        behaviour: {
          treatmentUptake: normaliseUptake(b.treatmentUptake),
          isolationDays: clampNum(b.isolationDays, 0, 30, 0),
          spendingShift: normaliseSpending(b.spendingShift),
          rationale,
        },
        health: {
          infectionProbability: clampNum(h.infectionProbability, 0, 1, 0),
          severityIfInfected,
          mortalityProbability: fatal ? clampNum(h.mortalityProbability, 0, 1, 0) : 0,
          hospitalised: Boolean(h.hospitalised) && admissible,
        },
        economic: {
          workdaysLost: clampNum(e.workdaysLost, 0, 365, 0),
          outOfPocketCostZar: clampNum(e.outOfPocketCostZar, 0, 500000, 0),
          insurerClaimZar: clampNum(e.insurerClaimZar, 0, 2000000, 0),
        },
      },
    };
  } catch (err) {
    return {
      outcome: neutralOutcome(),
      failure: `invalid JSON (${err instanceof Error ? err.message.slice(0, 80) : 'unknown'})`,
    };
  }
}

/**
 * Placeholder for an agent that produced nothing usable. Deliberately carries
 * an EMPTY rationale: the reason a call failed is plumbing, and writing it
 * here put "parse failed: invalid JSON" into the dataset's `sim_rationale`
 * column as though the person had said it. The failure now travels beside the
 * outcome on `SimulationAgentResult.failure`, where the aggregates can see it
 * and drop the row.
 */
function neutralOutcome(): SimulationOutcome {
  return {
    behaviour: {
      treatmentUptake: 'unsure',
      isolationDays: 0,
      spendingShift: 'unchanged',
      rationale: '',
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
  seed: number | undefined,
): Promise<SimulationAgentResult> {
  const system = buildAgentSystemPrompt(agent, scenario, ref);
  const ask = async (nudge: string, salt: number | undefined): Promise<string> =>
    router.route(
      [
        { role: 'system', content: system },
        { role: 'user', content: nudge },
      ] satisfies Message[],
      TIER,
      { fresh, maxTokens: MAX_TOKENS, temperature: 0.5, cacheSalt: salt },
    );

  try {
    let raw = await ask('Respond with the JSON envelope only.', seed);
    let parsed = parseOutcome(raw);

    // One retry on a bad envelope. A local model that rambles once will
    // usually comply when told exactly what went wrong, and losing a whole
    // agent — which then has to be excluded from every aggregate — is far
    // more expensive than one extra call. The salt is changed so the retry
    // isn't served the same cached reply that just failed.
    if (parsed.failure) {
      const retryRaw = await ask(
        'Your previous reply could not be read as JSON. Output ONLY the JSON object described above — no prose, no markdown fences, no commentary — and make sure every brace is closed.',
        (seed ?? 0) + 1_000_003,
      );
      const retry = parseOutcome(retryRaw);
      if (!retry.failure) {
        raw = retryRaw;
        parsed = retry;
      }
    }

    if (parsed.failure) {
      return {
        agent,
        outcome: parsed.outcome,
        raw,
        failure: { kind: 'parse_failed', message: parsed.failure },
      };
    }

    // Hard rules regardless of what the model wrote. Under-15s cannot be
    // employed (SA BCEA s43), and nobody outside work loses workdays — the
    // macro layer already values their day at R0, so a retired agent
    // reporting "10 workdays lost" moved the national workdays headline
    // without moving GDP drag, which is the same number disagreeing with
    // itself. School days missed belong in isolationDays.
    if (agent.age < 15 || !WORKING_EMPLOYMENT.has(agent.employment)) {
      parsed.outcome.economic.workdaysLost = 0;
    }
    return { agent, outcome: parsed.outcome, raw };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      agent,
      outcome: neutralOutcome(),
      raw: '',
      failure: { kind: 'router_error', message: msg },
    };
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
      results[i] = await runOne(agent, opts.scenario, opts.referenceBlock, !!opts.fresh, opts.seed);
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
