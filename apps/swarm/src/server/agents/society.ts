import type { SocietyAgent, SocietyAgentResult, SocietyParams, Sentiment } from '../../shared/types';
import { router, type Message } from '../llm/router';

const INCOME_BANDS = ['low', 'lower-mid', 'mid', 'upper-mid', 'high'] as const;
const EDUCATIONS = ['primary', 'secondary', 'tertiary', 'postgrad'] as const;
const EMPLOYMENTS = ['employed', 'self-employed', 'informal', 'unemployed', 'student', 'retired'] as const;

const SENTIMENTS: Sentiment[] = ['enthusiastic', 'supportive', 'neutral', 'skeptical', 'hostile'];

export type SocietyProgress =
  | { type: 'society_start'; total: number }
  | { type: 'society_progress'; done: number; total: number; agentId?: string }
  | { type: 'society_done'; total: number; elapsedMs: number }
  | { type: 'society_error'; agentId: string; message: string };

export interface SocietyOpts {
  size?: number;        // default 1000
  fresh?: boolean;
  seed?: number;        // deterministic sampling
  onProgress?: (e: SocietyProgress) => void;
}

// ---- deterministic RNG (mulberry32) ----
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted<T extends string>(rng: () => number, weights: Record<T, number>, keys: readonly T[]): T {
  const total = keys.reduce((s, k) => s + Math.max(0, weights[k] ?? 0), 0);
  if (total <= 0) return keys[0];
  const r = rng() * total;
  let acc = 0;
  for (const k of keys) {
    acc += Math.max(0, weights[k] ?? 0);
    if (r <= acc) return k;
  }
  return keys[keys.length - 1];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// box-muller for an age normal draw
function gauss(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function sampleSocietyAgents(params: SocietyParams, n: number, seed = 0xC0FFEE): SocietyAgent[] {
  const rng = mulberry32(seed);
  const out: SocietyAgent[] = [];
  for (let i = 0; i < n; i++) {
    const ageRaw = params.ageMean + gauss(rng) * (params.ageSpread / 2.5);
    const age = clamp(Math.round(ageRaw), 16, 85);
    const incomeBand = pickWeighted(rng, params.incomeMix, INCOME_BANDS);
    let education = pickWeighted(rng, params.educationMix, EDUCATIONS);
    let employment = pickWeighted(rng, params.employmentMix, EMPLOYMENTS);
    // Age-consistency guards: the user-dialled mixes are drawn independently
    // of age, which can produce a 16-year-old 'retired' or a 17-year-old
    // 'postgrad'. Same rules as the SA population sampler: minors are
    // students without degrees, and nobody retires before 50.
    if (age < 18) {
      employment = 'student';
      if (education === 'tertiary' || education === 'postgrad') education = 'secondary';
    } else if (employment === 'retired' && age < 50) {
      employment = 'unemployed';
    }
    let region: SocietyAgent['region'];
    const u = rng();
    const urb = clamp(params.urbanRatio, 0, 1);
    const periUrb = (1 - urb) * 0.5;
    if (u < urb) region = 'urban';
    else if (u < urb + periUrb) region = 'periurban';
    else region = 'rural';
    const riskTolerance = clamp(params.riskTolerance + (rng() - 0.5) * 0.4, 0, 1);
    const financialLiteracy = clamp(params.financialLiteracy + (rng() - 0.5) * 0.4, 0, 1);
    out.push({
      id: `s-${i.toString().padStart(4, '0')}`,
      age,
      incomeBand,
      education,
      region,
      riskTolerance,
      employment,
      financialLiteracy,
      culture: params.culture,
    });
  }
  return out;
}

function riskLabel(x: number): string {
  if (x < 0.25) return 'very low';
  if (x < 0.45) return 'low';
  if (x < 0.6) return 'moderate';
  if (x < 0.8) return 'high';
  return 'very high';
}

function litLabel(x: number): string {
  if (x < 0.25) return 'minimal';
  if (x < 0.5) return 'basic';
  if (x < 0.75) return 'fluent';
  return 'advanced';
}

function buildSystemPrompt(a: SocietyAgent): string {
  return `You are a ${a.age}-year-old ${a.incomeBand}-income ${a.region} ${a.employment} in ${a.culture}.
Education: ${a.education}. Risk tolerance: ${riskLabel(a.riskTolerance)}. Financial literacy: ${litLabel(a.financialLiteracy)}.

You are NOT a financial expert. React as an ordinary person would, in plain language, given your situation.

Respond with strict JSON only, no prose, no code fences:
{"reaction":"<1-2 sentence reaction>","sentiment":"enthusiastic"|"supportive"|"neutral"|"skeptical"|"hostile","intensity":0-100}`;
}

function userPrompt(scenario: string): string {
  return `Scenario:
${scenario}

Respond JSON only.`;
}

function parseSocietyResponse(text: string): { reaction: string; sentiment: Sentiment; intensity: number } {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const a = cleaned.indexOf('{');
  const b = cleaned.lastIndexOf('}');
  if (a !== -1 && b > a) {
    const slice = cleaned.slice(a, b + 1);
    try {
      const j = JSON.parse(slice) as { reaction?: string; sentiment?: string; intensity?: number | string };
      return {
        reaction: String(j.reaction ?? '').slice(0, 280),
        sentiment: normSentiment(j.sentiment),
        intensity: clamp(Number(j.intensity ?? 50) || 50, 0, 100),
      };
    } catch {
      // fall through
    }
  }
  // regex fallback
  const s = /"?sentiment"?\s*[:=]\s*"?(enthusiastic|supportive|neutral|skeptical|hostile)/i.exec(text)?.[1];
  const ints = /"?intensity"?\s*[:=]\s*(\d{1,3})/i.exec(text)?.[1];
  const r = /"?reaction"?\s*[:=]\s*"([^"]+)"/i.exec(text)?.[1];
  return {
    reaction: (r ?? text.replace(/[{}"]/g, '').trim().slice(0, 200)) || '(no reaction)',
    sentiment: normSentiment(s),
    intensity: clamp(ints ? parseInt(ints, 10) : 50, 0, 100),
  };
}

function normSentiment(v: unknown): Sentiment {
  const s = String(v ?? '').toLowerCase().trim();
  return (SENTIMENTS as string[]).includes(s) ? (s as Sentiment) : 'neutral';
}

export async function runSociety(
  scenario: string,
  agents: SocietyAgent[],
  opts: SocietyOpts = {},
): Promise<SocietyAgentResult[]> {
  const fresh = !!opts.fresh;
  const onProgress = opts.onProgress ?? (() => {});
  onProgress({ type: 'society_start', total: agents.length });
  const t0 = performance.now();
  let done = 0;
  // One event per persona until a run is big enough to need thinning, capped
  // at ~200 events. The previous `max(20, n/25)` floor meant a 200-persona
  // cohort reported exactly TEN times across the whole phase — the progress
  // crowd and the voice ticker were both starved of updates.
  const reportEvery = Math.max(1, Math.floor(agents.length / 200));

  const results = await Promise.all(
    agents.map(async (agent) => {
      const messages: Message[] = [
        { role: 'system', content: buildSystemPrompt(agent) },
        { role: 'user', content: userPrompt(scenario) },
      ];
      try {
        const text = await router.route(messages, 'society', {
          fresh,
          maxTokens: 160,
          temperature: 0.8,
        });
        const parsed = parseSocietyResponse(text);
        done++;
        // Every persona, thinned only on a run large enough to need it. The
        // old `reportEvery` throttle meant the overlay's crowd and its voice
        // ticker both sat frozen between beats — the ticker in particular
        // stopped moving entirely, because there was nothing to move it.
        // `agentId` rides along so each persona can carry its own hue and
        // name rather than the whole cohort sharing one.
        if (done % reportEvery === 0 || done === agents.length) {
          onProgress({
            type: 'society_progress',
            done,
            total: agents.length,
            agentId: agent.id,
          });
        }
        return {
          agent,
          reaction: parsed.reaction,
          sentiment: parsed.sentiment,
          intensity: parsed.intensity,
        } as SocietyAgentResult;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        onProgress({ type: 'society_error', agentId: agent.id, message: msg });
        done++;
        return {
          agent,
          reaction: '(error)',
          sentiment: 'neutral' as Sentiment,
          intensity: 0,
        } as SocietyAgentResult;
      }
    }),
  );

  onProgress({ type: 'society_done', total: agents.length, elapsedMs: Math.round(performance.now() - t0) });
  return results;
}
