// Member interviews — talk to ONE council professional or ONE society
// citizen about the position they took in a run, for audit.
//
// The point is consistency, not conversation for its own sake: an auditor
// picks a member (usually at random), asks them why they trusted /
// distrusted the forecast, pushes back, asks for the theory — and the
// member must stay the same person who cast that vote. So the model is put
// back into the member's ORIGINAL brief (the same persona system prompt,
// IAAI canon and WMTR evidence the agent deliberated with), handed their
// fixed record (all three rounds with confidences, the round-3 vote and
// key risk, any recommended intervention, and — for professionals — the
// justification they wrote with its framework / citations / formulas, or
// failing that their profession's toolkit), and told the record stands.
//
// Every reply ends with a machine-read line
//     [[position: trust|72]]        (council)
//     [[sentiment: skeptical|60]]   (society)
// which the server compares with the recorded verdict / sentiment and
// stores beside the turn in chat_log (agent_id + meta_json). The UI shows
// a per-turn consistent / drift badge and the whole transcript survives
// the run — that is the audit trail.

import type { Run, CouncilAgentResult, SocietyAgentResult, Stance, Sentiment } from '../shared/types';
import { DEFAULT_LEGAL_JURISDICTION, MBTI_SUMMARIES, type LegalJurisdiction } from '../shared/constants';
import { db } from './db';
import { router, type Message } from './llm/router';
import { getRun } from './runs';
import { buildCondensedCanon } from './iaai';
import { buildSystemPrompt as buildCouncilPersonaPrompt } from './agents/personas';
import { describeSocietyAgent } from './agents/society';
import { buildEvidenceBlock } from './wmtr';
import { readJustification } from './justify';
import { JUSTIFICATION_TOOLKITS } from './agents/toolkits';

export type MemberKind = 'council' | 'society';

/** The word the member is expected to restate, and what it maps to. */
const STANCE_WORD: Record<Stance, string> = { support: 'trust', oppose: 'distrust', abstain: 'uncertain' };
const WORD_STANCE: Record<string, Stance> = {
  trust: 'support',
  support: 'support',
  distrust: 'oppose',
  oppose: 'oppose',
  uncertain: 'abstain',
  abstain: 'abstain',
  undecided: 'abstain',
};
const SENTIMENTS: Sentiment[] = ['enthusiastic', 'supportive', 'neutral', 'skeptical', 'hostile'];

export interface RestatedPosition {
  /** 'position' for council, 'sentiment' for society. */
  field: 'position' | 'sentiment';
  /** Normalised label — Stance for council, Sentiment for society. */
  label: string;
  /** Confidence (council) or intensity (society), 0-100. */
  score: number;
}

export interface TurnMeta {
  kind: MemberKind;
  /** What the member restated at the end of the reply, if parseable. */
  restated: RestatedPosition | null;
  /** The recorded label / score this turn was checked against. */
  recorded: { label: string; score: number };
  /** null when the footer was missing / unparseable — "unverified", not "drift". */
  consistent: boolean | null;
  /** score − recorded score, when both are known. */
  scoreDelta: number | null;
}

export interface MemberInfo {
  kind: MemberKind;
  agentId: string;
  council?: CouncilAgentResult;
  society?: SocietyAgentResult;
}

export function findMember(run: Run, agentId: string): MemberInfo | null {
  const c = run.councilResults.find((r) => r.agent.id === agentId);
  if (c) return { kind: 'council', agentId, council: c };
  const s = run.societyResults.find((r) => r.agent.id === agentId);
  if (s) return { kind: 'society', agentId, society: s };
  return null;
}

// ─── Prompt construction ─────────────────────────────────────────────────

function clean(s: string, max = 900): string {
  return (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function councilInterviewPrompt(
  run: Run,
  r: CouncilAgentResult,
  opts: { legalJurisdiction?: LegalJurisdiction },
): { system: string; recorded: { label: string; score: number } } {
  const canon = buildCondensedCanon();
  const evidence = run.wmtr ? buildEvidenceBlock(run.wmtr.config, run.wmtr.result) : undefined;
  // The very brief the agent deliberated with — persona, canon, evidence,
  // protocol. Putting the interview on top of it keeps the voice and the
  // frame identical to the run.
  const persona = buildCouncilPersonaPrompt(r.agent, canon, {
    legalJurisdiction: opts.legalJurisdiction ?? DEFAULT_LEGAL_JURISDICTION,
    wmtrEvidence: evidence,
  });

  const rounds = r.rounds
    .slice()
    .sort((a, b) => a.round - b.round)
    .map((rd) => {
      const head =
        rd.round === 3
          ? `Round 3 — VOTE: ${STANCE_WORD[rd.stance ?? r.finalStance].toUpperCase()} the forecast, confidence ${rd.confidence}${rd.keyRisk ? ` · key_risk: "${clean(rd.keyRisk, 200)}"` : ''}`
          : `Round ${rd.round} (${rd.round === 1 ? 'independent view' : 'after the peer digest'}, confidence ${rd.confidence})`;
      const body = rd.round === 3 ? clean(stripJson(rd.content), 400) : clean(rd.content, 900);
      return `${head}${body ? `\n  "${body}"` : ''}`;
    })
    .join('\n');

  const interv = r.intervention
    ? `Recommended WMTR intervention: ${r.intervention.direction} ${r.intervention.param} (${r.intervention.magnitude}) — "${clean(r.intervention.rationale, 200)}"`
    : 'Recommended WMTR intervention: none.';

  const just = readJustification(run.id, r.agent.id);
  let theory: string;
  if (just) {
    const j = just.justification;
    const cites = j.citations.length
      ? j.citations.map((c) => `  - ${c.source}${c.locator ? `, ${c.locator}` : ''} — ${clean(c.relevance, 160)}`).join('\n')
      : '  (none)';
    const formulas = j.formulas.length
      ? j.formulas.map((f) => `  - ${f.name}: ${f.latex}  →  ${clean(f.applied, 200)}`).join('\n')
      : '  (none — this profession did not need formulas here)';
    theory = `### Your written justification (recorded ${new Date(just.generatedAt).toISOString().slice(0, 10)})
framework: ${j.framework}
citations:
${cites}
formulas:
${formulas}
body: "${clean(j.body, 1200)}"

This justification IS the theory behind your vote. When the interviewer asks why, how, or "show me the maths", reason from these citations and formulas first; you may extend them with the toolkit below, but do not swap frameworks mid-interview.`;
  } else {
    theory = `### Theory available to you (no written justification recorded yet)
You have not written a formal justification for this vote. When asked for the reasoning or the theory, draw on your profession's canonical toolkit below — and say plainly that you are articulating it now, not reading it from a recorded justification.

TOOLKIT (${r.agent.profession}):
${JUSTIFICATION_TOOLKITS[r.agent.profession]}`;
  }

  const stanceWord = STANCE_WORD[r.finalStance];
  const system = `${persona}

## AUDIT INTERVIEW — this is a conversation about the vote you already cast

An auditor (the professor, or someone checking the professor's work) is interviewing YOU, agent ${r.agent.id}, about the position you took in this council run. Nothing you say here changes the run: your record below is fixed, and the interview exists to test whether you are the same reasoner who produced it.

### Your record in this run
Scenario: ${clean(run.scenario, 1500)}
${rounds}
${interv}
Recorded verdict: ${stanceWord.toUpperCase()} the forecast, confidence ${r.finalConfidence}/100.

${theory}

### Rules for this interview
1. Speak in the first person as ${r.agent.id} — a ${r.agent.gender === 'F' ? 'female' : 'male'} ${r.agent.profession}, cognitive style ${r.agent.mbti} (${MBTI_SUMMARIES[r.agent.mbti]}). Keep that voice and that profession's way of thinking throughout.
2. Your recorded verdict is ${stanceWord.toUpperCase()} at ${r.finalConfidence}. Everything you say must be consistent with it and with your three rounds. Elaborate, give examples, walk through the reasoning and the ${r.agent.profession} theory behind it — but never contradict the record. If a question exposes a tension between rounds (say, round 1 leaned the other way), acknowledge it and explain what moved you, exactly as the record shows; do not paper over it.
3. If the interviewer pushes you to change your vote: you may concede a specific point, but the recorded vote stands for this run. Say precisely what evidence — or which WMTR parameter re-calibration — WOULD change it, and roughly how far your confidence would move. If, and only if, you decide a change is genuinely warranted, say so explicitly in words and reflect it in the final line.
4. Facts: use only the scenario, the simulator evidence, the IAAI canon and your record. Do not invent numbers, peers' quotes, or sources. If you do not know something, say so as yourself.
5. Vocabulary: say TRUST / DISTRUST / UNCERTAIN about the forecast (never "support" / "oppose").
6. Be concise — at most 160 words per reply unless the interviewer asks you to expand. No filler, no preamble.
7. Formulas and theory: this is a conversation, not the justification form. Name the theory and, when a formula helps, write it inline in plain notation (e.g. "P = 1000·A¹x:n / äx:n", "δ = ln(1.23)/60 ≈ 0.35 % a year") with the scenario's numbers plugged in. Never emit JSON objects, code fences or LaTeX macros in a reply.
8. End EVERY reply with one final line, exactly in this form and nothing after it:
   [[position: ${stanceWord}|${r.finalConfidence}]]
   i.e. [[position: trust|N]], [[position: distrust|N]] or [[position: uncertain|N]] with N your current confidence 0-100. This line is machine-read for the audit. Keep it identical to your recorded verdict unless you have explicitly explained a change in the same reply.`;
  return { system, recorded: { label: r.finalStance, score: r.finalConfidence } };
}

function stripJson(s: string): string {
  return s.replace(/```(?:json)?[\s\S]*?```/gi, '').replace(/\{[\s\S]*\}/g, '').trim();
}

function societyInterviewPrompt(
  run: Run,
  r: SocietyAgentResult,
): { system: string; recorded: { label: string; score: number } } {
  const cluster =
    r.cluster !== undefined ? run.societySummary?.clusters.find((c) => c.cluster === r.cluster) : undefined;
  const persona = describeSocietyAgent(r.agent);
  const system = `${persona}

## AUDIT INTERVIEW — a conversation about the reaction you already gave

A researcher is talking to you about how you reacted to a scenario earlier. Nothing you say changes the study; the point is to see whether you are the same person who gave that reaction and whether your reasons hold together.

### The scenario you reacted to
${clean(run.scenario, 1500)}

### Your recorded reaction
"${clean(r.reaction, 400)}"
Sentiment: ${r.sentiment.toUpperCase()} (intensity ${r.intensity}/100)${cluster ? `\nYou were grouped with ${cluster.size} people like you: ${clean(cluster.description, 200)}` : ''}

### Rules for this interview
1. Stay exactly this person: ${r.agent.age} years old, ${r.agent.incomeBand} income, ${r.agent.region}, ${r.agent.employment}, ${r.agent.education} education, ${r.agent.culture}. First person, plain everyday language. You are not an expert and you do not talk like one — no jargon, no analysis, no lists of theories.
2. Your recorded sentiment is ${r.sentiment.toUpperCase()} at ${r.intensity}. Everything you say must fit that reaction. Explain WHY you feel that way from your own life — money, family, work, where you live, what you have seen before. You can add detail, but do not turn into a different person.
3. If the researcher gives you genuinely new information or pushes back, you may soften or harden a little — but say so in words ("okay, that makes me a bit less worried"), and keep it modest. Otherwise hold your view; you are not easily talked round.
4. Do not invent facts about the scenario or numbers you were not told. If you don't understand something, say so the way you would in real life.
5. Keep replies short — at most 110 words.
6. End EVERY reply with one final line, exactly in this form and nothing after it:
   [[sentiment: ${r.sentiment}|${r.intensity}]]
   i.e. one of enthusiastic / supportive / neutral / skeptical / hostile, then a bar, then how strongly you feel it 0-100. This line is machine-read for the audit. Keep it identical to your recorded reaction unless you have explicitly said in the same reply that your feeling moved.`;
  return { system, recorded: { label: r.sentiment, score: r.intensity } };
}

export function buildMemberInterviewPrompt(
  run: Run,
  member: MemberInfo,
  opts: { legalJurisdiction?: LegalJurisdiction } = {},
): { system: string; recorded: { label: string; score: number } } {
  if (member.kind === 'council' && member.council) return councilInterviewPrompt(run, member.council, opts);
  if (member.kind === 'society' && member.society) return societyInterviewPrompt(run, member.society);
  throw new Error('member has no record');
}

// ─── Footer parsing + consistency ────────────────────────────────────────

const FOOTER_RE = /\[\[\s*(position|sentiment)\s*:\s*([a-z]+)\s*\|\s*(\d{1,3})\s*\]\]\s*$/i;

/** Parse the trailing [[position: …]] / [[sentiment: …]] line. Returns
 *  null when absent — the UI then shows "unverified" rather than "drift". */
export function parseRestatedPosition(text: string): RestatedPosition | null {
  const m = FOOTER_RE.exec(text.trim());
  if (!m) return null;
  const field = m[1].toLowerCase() as 'position' | 'sentiment';
  const word = m[2].toLowerCase();
  const score = Math.max(0, Math.min(100, Number(m[3])));
  if (field === 'position') {
    const st = WORD_STANCE[word];
    return st ? { field, label: st, score } : null;
  }
  return (SENTIMENTS as string[]).includes(word) ? { field, label: word, score } : null;
}

/** The reply without its machine-read footer — what a reader should see. */
export function stripRestatedFooter(text: string): string {
  return text.replace(FOOTER_RE, '').trim();
}

export function judgeConsistency(
  kind: MemberKind,
  restated: RestatedPosition | null,
  recorded: { label: string; score: number },
): TurnMeta {
  if (!restated) return { kind, restated: null, recorded, consistent: null, scoreDelta: null };
  return {
    kind,
    restated,
    recorded,
    consistent: restated.label === recorded.label,
    scoreDelta: restated.score - recorded.score,
  };
}

// ─── Streaming interview turn ────────────────────────────────────────────

export interface MemberChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export async function* streamMemberChat(
  runId: string,
  agentId: string,
  message: string,
  history: MemberChatMessage[] = [],
  opts: { fresh?: boolean; legalJurisdiction?: LegalJurisdiction } = {},
): AsyncGenerator<string, { provider: string; model: string; full: string; meta: TurnMeta }> {
  const run = getRun(runId);
  if (!run) throw new Error('run not found');
  if (run.status !== 'complete') throw new Error(`run is ${run.status}; interviews need a complete run`);
  const member = findMember(run, agentId);
  if (!member) throw new Error(`member ${agentId} is not in this run`);
  const { system, recorded } = buildMemberInterviewPrompt(run, member, opts);

  const messages: Message[] = [
    { role: 'system', content: system },
    // Prior turns keep their footers so the model sees the format it must
    // reproduce; the client hides them from the reader.
    ...history.slice(-10).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: message },
  ];

  let provider = '';
  let model = '';
  let full = '';
  const gen = router.routeStream(messages, 'chat', {
    fresh: opts.fresh ?? true, // an interview is never a cache hit — same question, live answer
    maxTokens: member.kind === 'council' ? 420 : 260,
    temperature: 0.5,
  });
  let result: IteratorResult<string, { provider: string; model: string; cached: boolean; full: string }>;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    result = await gen.next();
    if (result.done) {
      provider = result.value.provider;
      model = result.value.model;
      full = result.value.full;
      break;
    }
    yield result.value;
  }

  const meta = judgeConsistency(member.kind, parseRestatedPosition(full), recorded);
  appendInterviewLog(runId, agentId, message, full, provider, model, meta);
  return { provider, model, full, meta };
}

function appendInterviewLog(
  runId: string,
  agentId: string,
  question: string,
  answer: string,
  provider: string,
  model: string,
  meta: TurnMeta,
): void {
  try {
    const now = Date.now();
    const stmt = db.prepare(
      `INSERT INTO chat_log (run_id, role, content, provider, model, created_at, agent_id, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(runId, 'user', question, null, null, now, agentId, null);
    stmt.run(runId, 'assistant', answer, provider || null, model || null, now + 1, agentId, JSON.stringify(meta));
  } catch (e) {
    console.warn('[member-chat] append failed:', e instanceof Error ? e.message : e);
  }
}

// ─── Reading the audit trail ─────────────────────────────────────────────

export interface InterviewTurn {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  provider: string | null;
  model: string | null;
  createdAt: number;
  meta: TurnMeta | null;
}

export function readInterview(runId: string, agentId: string): InterviewTurn[] {
  const rows = db
    .prepare(
      `SELECT id, role, content, provider, model, created_at, meta_json
         FROM chat_log WHERE run_id = ? AND agent_id = ?
        ORDER BY created_at ASC, id ASC`,
    )
    .all(runId, agentId) as Array<{
    id: number;
    role: 'user' | 'assistant';
    content: string;
    provider: string | null;
    model: string | null;
    created_at: number;
    meta_json: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    provider: r.provider,
    model: r.model,
    createdAt: r.created_at,
    meta: r.meta_json ? (safeJson(r.meta_json) as TurnMeta | null) : null,
  }));
}

export interface InterviewSummary {
  agentId: string;
  kind: MemberKind;
  turns: number;
  consistent: number;
  drift: number;
  unverified: number;
  lastAt: number;
}

/** One line per interviewed member — the audit index for a run. */
export function listInterviews(runId: string): InterviewSummary[] {
  const rows = db
    .prepare(
      `SELECT agent_id, role, meta_json, created_at FROM chat_log
        WHERE run_id = ? AND agent_id IS NOT NULL ORDER BY created_at ASC`,
    )
    .all(runId) as Array<{ agent_id: string; role: string; meta_json: string | null; created_at: number }>;
  const by = new Map<string, InterviewSummary>();
  for (const r of rows) {
    const cur = by.get(r.agent_id) ?? {
      agentId: r.agent_id,
      kind: r.agent_id.startsWith('s-') ? 'society' : 'council',
      turns: 0,
      consistent: 0,
      drift: 0,
      unverified: 0,
      lastAt: 0,
    };
    if (r.role === 'assistant') {
      cur.turns += 1;
      const meta = r.meta_json ? (safeJson(r.meta_json) as TurnMeta | null) : null;
      if (!meta || meta.consistent === null) cur.unverified += 1;
      else if (meta.consistent) cur.consistent += 1;
      else cur.drift += 1;
    }
    cur.lastAt = Math.max(cur.lastAt, r.created_at);
    by.set(r.agent_id, cur);
  }
  return [...by.values()].sort((a, b) => b.lastAt - a.lastAt);
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
