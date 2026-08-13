import type { CouncilAgent, CouncilAgentResult, CouncilRound, Intervention, InterventionParam, Stance } from '../../shared/types';
import type { LegalJurisdiction } from '../../shared/constants';
import { router, type Message } from '../llm/router';
import { buildAllPersonas, buildSystemPrompt } from './personas';

export interface CouncilOpts {
  subset?: number;        // limit to first N agents (for fast iteration)
  canon?: string;         // condensed canon text
  fresh?: boolean;        // bypass cache
  legalJurisdiction?: LegalJurisdiction;
  wmtrEvidence?: string;  // injected into system prompt when present
  onProgress?: (event: ProgressEvent) => void;
  digestPeers?: number;   // peers per profession bucket shown in r2
}

const INTERVENTION_PARAMS_SET = new Set<InterventionParam>([
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
]);

export type ProgressEvent =
  | { type: 'round_start'; round: 1 | 2 | 3; total: number }
  | { type: 'agent_done'; round: 1 | 2 | 3; agentId: string; done: number; total: number }
  | { type: 'round_done'; round: 1 | 2 | 3; total: number; elapsedMs: number }
  | { type: 'error'; agentId: string; round: 1 | 2 | 3; message: string };

const TIER = 'council' as const;
const R1_MAX = 360;
const R2_MAX = 420;
const R3_MAX = 180;

function r1Prompt(scenario: string, hasForecast: boolean): string {
  const lead = hasForecast
    ? `Scenario (community / context the forecast is about):
${scenario}

Read the Simulator Evidence (W(M, T, R) forecast) in your standing brief.
Round 1 — your independent view on whether to TRUST the forecast.
What does it get right? What does it miss for this profession's domain?
Respond in <=120 words.`
    : `Scenario:
${scenario}

Round 1 — your independent view. Respond in <=120 words.`;
  return `${lead}
End with a single final line in this exact format:
CONFIDENCE: <0-100>`;
}

function r2Prompt(scenario: string, yourR1: string, digest: string, hasForecast: boolean): string {
  const lead = hasForecast
    ? `Scenario (community / context):
${scenario}

The forecast in your standing brief is what the council is interrogating.

Your round-1 view (on whether to trust it):
${yourR1}

Peer digest (round-1 sample, intra- and cross-profession):
${digest}

Round 2 — respond to peers; update or hold your trust / distrust position;
name the specific WMTR parameter you think is mis-calibrated (if any).
Respond in <=140 words.`
    : `Scenario:
${scenario}

Your round-1 view:
${yourR1}

Peer digest (round-1 sample, intra- and cross-profession):
${digest}

Round 2 — respond to peers; update or hold your view; explain why. Respond in <=140 words.`;
  return `${lead}
End with a single final line in this exact format:
CONFIDENCE: <0-100>`;
}


/**
 * Words that make a key_risk read as an objection.
 *
 * Used to catch an agent that votes support and then states a criticism —
 * "ignores secure tenure" under a trust vote is the agent arguing against
 * itself, and it is what made trusting and distrusting agents look like they
 * were reasoning identically in the readback.
 */
const OBJECTION_RE =
  /\b(ignor\w*|miss\w*|missing|overlook\w*|underestimat\w*|underweigh\w*|overweigh\w*|overestimat\w*|overemphasi\w*|fails?|failing|neglect\w*|omits?|omitting|understat\w*|discount\w*)\b/i;

/** True when this vote contradicts the reason given for it. */
export function stanceContradictsRisk(stance: string, keyRisk: string): boolean {
  if (stance !== 'support') return false;
  return OBJECTION_RE.test(keyRisk ?? '');
}

function r3Prompt(scenario: string, yourR2: string, withIntervention: boolean): string {
  const baseShape = `{"stance":"support"|"oppose"|"abstain","confidence":0-100,"key_risk":"<<=120 chars>"}`;
  const interventionShape = `{"stance":"support"|"oppose"|"abstain","confidence":0-100,"key_risk":"<<=120 chars>","recommended_intervention":{"param":"alphaR","direction":"increase"|"decrease","magnitude":"small"|"large","rationale":"<<=120 chars>"}}`;
  // The stance vocabulary is NOT conditional on the intervention shape. It
  // was, and on a run without WMTR evidence the agents got no definition of
  // support/oppose at all and no guidance on what `key_risk` is for.
  //
  // `key_risk` carries opposite meanings depending on the vote — a supporter's
  // is what the forecast gets RIGHT — and a field called "key risk" pulls hard
  // the other way. One line of guidance was not enough: on a measured run all
  // eleven supporters still answered with a criticism ("ignores secure
  // tenure", "misses inherent stability"), which reads as an agent arguing
  // against the forecast and then voting to trust it. Hence the worked
  // examples and the explicit self-check below.
  const frame = `
Stance vocabulary in THIS run (you are interrogating a forecast):
  support = you TRUST the forecast | oppose = you DISTRUST it | abstain = insufficient evidence.

key_risk must MATCH your stance. Fill the shape from THIS scenario, in your
own words — the angle brackets are slots, not text to reuse:
  • support  → "captures <the specific thing that makes the forecast right here>"
  • oppose   → "ignores <the specific thing the forecast leaves out>"
  • abstain  → "no evidence on <what you would need in order to decide>"

Do NOT copy the wording of these shapes; an answer that reads like the
template rather than like this scenario is wrong.

Self-check before answering: a key_risk that would justify the OTHER vote is
the wrong one. If you voted support and wrote "ignores…", you have argued
against your own stance — rewrite it as what the forecast gets right.
`;

  return `Scenario:
${scenario}

Your round-2 view:
${yourR2}
${frame}
Round 3 — final vote. Respond with JSON only (no prose, no code fences). Shape:
${withIntervention ? interventionShape : baseShape}${withIntervention ? '\n(recommended_intervention is OPTIONAL — omit if no WMTR parameter feels mis-calibrated.)' : ''}`;
}

function parseConfidence(text: string): number {
  const m = text.match(/CONFIDENCE\s*[:=]\s*(\d{1,3})/i);
  if (!m) return 50;
  return clamp(parseInt(m[1], 10), 0, 100);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

interface Vote {
  stance: Stance;
  confidence: number;
  key_risk: string;
  intervention?: Intervention;
}

function parseIntervention(raw: unknown): Intervention | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const param = String(o.param ?? '') as InterventionParam;
  if (!INTERVENTION_PARAMS_SET.has(param)) return undefined;
  const direction = o.direction === 'increase' || o.direction === 'decrease' ? o.direction : null;
  const magnitude = o.magnitude === 'small' || o.magnitude === 'large' ? o.magnitude : 'small';
  if (!direction) return undefined;
  const rationale = String(o.rationale ?? '').slice(0, 200);
  return { param, direction, magnitude, rationale };
}

function parseR3(text: string): Vote {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const slice = cleaned.slice(firstBrace, lastBrace + 1);
    try {
      const j = JSON.parse(slice) as Partial<Vote> & { recommended_intervention?: unknown };
      const stance = normaliseStance(j.stance);
      const confidence = clamp(Number(j.confidence ?? 50) || 50, 0, 100);
      const key_risk = String(j.key_risk ?? '(none stated)').slice(0, 200);
      const intervention = parseIntervention(j.recommended_intervention);
      return { stance, confidence, key_risk, intervention };
    } catch {
      // fall through
    }
  }
  // regex fallback
  const s = /"?stance"?\s*[:=]\s*"?(support|oppose|abstain)/i.exec(text)?.[1];
  const c = /"?confidence"?\s*[:=]\s*(\d{1,3})/i.exec(text)?.[1];
  const k = /"?key_risk"?\s*[:=]\s*"([^"]+)"/i.exec(text)?.[1];
  return {
    stance: normaliseStance(s),
    confidence: clamp(c ? parseInt(c, 10) : 50, 0, 100),
    key_risk: (k ?? '(parse failed)').slice(0, 200),
  };
}

function normaliseStance(s: unknown): Stance {
  const v = String(s ?? '').toLowerCase();
  if (v === 'support' || v === 'oppose' || v === 'abstain') return v;
  return 'abstain';
}

function summariseForDigest(text: string): string {
  const cleaned = text.replace(/CONFIDENCE\s*[:=]\s*\d{1,3}\s*$/i, '').trim();
  // first 2 sentences, cap 180 chars
  const sentences = cleaned.split(/(?<=[.!?])\s+/);
  let out = sentences.slice(0, 2).join(' ');
  if (out.length > 180) out = out.slice(0, 177) + '...';
  return out;
}

function seededRng(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) h = (h ^ seed.charCodeAt(i)) * 16777619 >>> 0;
  return () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleN<T>(rng: () => number, arr: T[], n: number, excludeId?: string): T[] {
  const pool = excludeId
    ? arr.filter((x) => (x as unknown as { id?: string }).id !== excludeId)
    : arr.slice();
  if (pool.length <= n) return pool;
  const out: T[] = [];
  const taken = new Set<number>();
  while (out.length < n) {
    const i = Math.floor(rng() * pool.length);
    if (taken.has(i)) continue;
    taken.add(i);
    out.push(pool[i]);
  }
  return out;
}

interface Round1Item {
  id: string;
  agent: CouncilAgent;
  text: string;
  confidence: number;
}

function buildDigest(
  agent: CouncilAgent,
  pool: CouncilAgent[],
  r1: Round1Item[],
  perBucket: number,
): string {
  const rng = seededRng(agent.id);
  const sameProf = r1.filter((x) => x.agent.profession === agent.profession);
  const otherProf = r1.filter((x) => x.agent.profession !== agent.profession);
  const intra = sampleN(rng, sameProf, perBucket, agent.id);
  const cross = sampleN(rng, otherProf, perBucket, agent.id);
  const fmt = (x: Round1Item) =>
    `[${x.agent.profession}/${x.agent.mbti}/${x.agent.gender} conf=${x.confidence}] ${summariseForDigest(x.text)}`;
  const lines: string[] = [];
  if (intra.length) {
    lines.push('-- same profession --');
    lines.push(...intra.map(fmt));
  }
  if (cross.length) {
    lines.push('-- other professions --');
    lines.push(...cross.map(fmt));
  }
  if (!lines.length) lines.push('(no peer responses available)');
  return lines.join('\n');
}

async function runAgentRound(
  agent: CouncilAgent,
  systemPrompt: string,
  userPrompt: string,
  round: 1 | 2 | 3,
  maxTokens: number,
  fresh: boolean,
): Promise<string> {
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  try {
    return await router.route(messages, TIER, {
      fresh,
      maxTokens,
      temperature: round === 3 ? 0.3 : 0.7,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`agent ${agent.id} r${round} failed: ${msg}`);
  }
}

export async function runCouncil(
  scenario: string,
  opts: CouncilOpts = {},
): Promise<CouncilAgentResult[]> {
  const all = buildAllPersonas();
  const pool = opts.subset && opts.subset > 0 ? all.slice(0, opts.subset) : all;
  const canon = opts.canon ?? '';
  const fresh = !!opts.fresh;
  const perBucket = opts.digestPeers ?? 4;
  const onProgress = opts.onProgress ?? (() => {});

  const sys = new Map(
    pool.map(
      (a) =>
        [
          a.id,
          buildSystemPrompt(a, canon, {
            legalJurisdiction: opts.legalJurisdiction,
            wmtrEvidence: opts.wmtrEvidence,
          }),
        ] as const,
    ),
  );
  const withIntervention = !!opts.wmtrEvidence;

  // ---- Round 1 ----
  onProgress({ type: 'round_start', round: 1, total: pool.length });
  const r1Start = performance.now();
  let r1Done = 0;
  const r1Texts = await Promise.all(
    pool.map(async (agent) => {
      try {
        const text = await runAgentRound(agent, sys.get(agent.id)!, r1Prompt(scenario, withIntervention), 1, R1_MAX, fresh);
        r1Done++;
        onProgress({ type: 'agent_done', round: 1, agentId: agent.id, done: r1Done, total: pool.length });
        return { agent, text };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        onProgress({ type: 'error', agentId: agent.id, round: 1, message: msg });
        return { agent, text: 'I cannot respond (round 1 error).\nCONFIDENCE: 0' };
      }
    }),
  );
  onProgress({ type: 'round_done', round: 1, total: pool.length, elapsedMs: Math.round(performance.now() - r1Start) });

  const r1Items: Round1Item[] = r1Texts.map((x) => ({
    id: x.agent.id,
    agent: x.agent,
    text: x.text,
    confidence: parseConfidence(x.text),
  }));

  // ---- Round 2 ----
  onProgress({ type: 'round_start', round: 2, total: pool.length });
  const r2Start = performance.now();
  let r2Done = 0;
  const r2Texts = await Promise.all(
    pool.map(async (agent, i) => {
      const digest = buildDigest(agent, pool, r1Items, perBucket);
      const prompt = r2Prompt(scenario, r1Items[i].text, digest, withIntervention);
      try {
        const text = await runAgentRound(agent, sys.get(agent.id)!, prompt, 2, R2_MAX, fresh);
        r2Done++;
        onProgress({ type: 'agent_done', round: 2, agentId: agent.id, done: r2Done, total: pool.length });
        return text;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        onProgress({ type: 'error', agentId: agent.id, round: 2, message: msg });
        return 'I cannot respond (round 2 error).\nCONFIDENCE: 0';
      }
    }),
  );
  onProgress({ type: 'round_done', round: 2, total: pool.length, elapsedMs: Math.round(performance.now() - r2Start) });

  // ---- Round 3 ----
  onProgress({ type: 'round_start', round: 3, total: pool.length });
  const r3Start = performance.now();
  let r3Done = 0;
  const r3Texts = await Promise.all(
    pool.map(async (agent, i) => {
      const prompt = r3Prompt(scenario, r2Texts[i], withIntervention);
      try {
        let text = await runAgentRound(agent, sys.get(agent.id)!, prompt, 3, R3_MAX, fresh);

        // One correction pass when the vote and the reason disagree.
        //
        // The prompt says a supporter's key_risk is what the forecast gets
        // RIGHT, and the models still answer with a criticism a good share of
        // the time — measured at 11/11 supporters before the wording was
        // strengthened. Wording alone cannot be relied on, so the
        // contradiction is detected and handed back once, naming the specific
        // fault. If it comes back contradictory again the vote is kept as
        // given: the readback splits by stance, so a stray line is visible
        // rather than silently merged, and rewriting an agent's stated reason
        // would be inventing evidence.
        const first = parseR3(text);
        if (stanceContradictsRisk(first.stance, first.key_risk)) {
          const retry = await runAgentRound(
            agent,
            sys.get(agent.id)!,
            `${prompt}\n\nYour previous answer voted "support" but gave "${first.key_risk}" as key_risk — that is a reason to OPPOSE, not to support. Either state what the forecast gets RIGHT, or change your stance to "oppose". Respond with the JSON only.`,
            3,
            R3_MAX,
            // Bypass the cache: the same prompt just produced the reply we
            // are rejecting.
            true,
          );
          const second = parseR3(retry);
          if (!stanceContradictsRisk(second.stance, second.key_risk)) text = retry;
        }

        r3Done++;
        onProgress({ type: 'agent_done', round: 3, agentId: agent.id, done: r3Done, total: pool.length });
        return text;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        onProgress({ type: 'error', agentId: agent.id, round: 3, message: msg });
        return '{"stance":"abstain","confidence":0,"key_risk":"(error)"}';
      }
    }),
  );
  onProgress({ type: 'round_done', round: 3, total: pool.length, elapsedMs: Math.round(performance.now() - r3Start) });

  // ---- Assemble ----
  return pool.map((agent, i) => {
    const r1Text = r1Items[i].text;
    const r2Text = r2Texts[i];
    const r3Text = r3Texts[i];
    const vote = parseR3(r3Text);
    const rounds: CouncilRound[] = [
      { round: 1, content: r1Text, confidence: r1Items[i].confidence },
      { round: 2, content: r2Text, confidence: parseConfidence(r2Text) },
      { round: 3, content: r3Text, confidence: vote.confidence, stance: vote.stance, keyRisk: vote.key_risk },
    ];
    return {
      agent,
      rounds,
      finalStance: vote.stance,
      finalConfidence: vote.confidence,
      keyRisk: vote.key_risk,
      intervention: vote.intervention,
    };
  });
}
