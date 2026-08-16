import { db } from './db';
import { router } from './llm/router';
import { loadCanon } from './iaai';
import { buildSystemPrompt } from './agents/personas';
import {
  TOOLKIT_VERSION,
  buildJustificationSystemAddendum,
  buildJustificationUserPrompt,
  buildGroupSystemAddendum,
  buildGroupUserPrompt,
  groupAgentId,
  groupVoteHash,
  matchCanonByKeywords,
  voteHash,
  type GroupVoteEntry,
  type Justification,
  type JustificationRecord,
} from './agents/toolkits';
import { ACTUARIAL_MACROS, KATEX_BUILTIN_WHITELIST } from '../client/lib/actuarialMacros';
import type { Run, CouncilAgentResult } from '../shared/types';
import { PROFESSIONS, type LegalJurisdiction, type Profession } from '../shared/constants';

const JUSTIFY_MAX_TOKENS = 1100;
const JUSTIFY_GROUP_MAX_TOKENS = 1600;

export interface JustifyOpts {
  fresh?: boolean;
  legalJurisdiction?: LegalJurisdiction;
}

export function readJustification(runId: string, agentId: string): JustificationRecord | null {
  const row = db
    .prepare(
      `SELECT run_id, agent_id, toolkit_version, vote_hash, payload_json, created_at
       FROM justifications WHERE run_id = ? AND agent_id = ?`,
    )
    .get(runId, agentId) as
    | {
        run_id: string;
        agent_id: string;
        toolkit_version: string;
        vote_hash: string;
        payload_json: string;
        created_at: number;
      }
    | null;
  if (!row) return null;
  try {
    return {
      runId: row.run_id,
      agentId: row.agent_id,
      toolkitVersion: row.toolkit_version,
      voteHash: row.vote_hash,
      generatedAt: row.created_at,
      justification: JSON.parse(row.payload_json) as Justification,
    };
  } catch {
    return null;
  }
}

export function listJustifications(runId: string): JustificationRecord[] {
  const rows = db
    .prepare(
      `SELECT run_id, agent_id, toolkit_version, vote_hash, payload_json, created_at
       FROM justifications WHERE run_id = ?`,
    )
    .all(runId) as Array<{
    run_id: string;
    agent_id: string;
    toolkit_version: string;
    vote_hash: string;
    payload_json: string;
    created_at: number;
  }>;
  const out: JustificationRecord[] = [];
  for (const row of rows) {
    try {
      out.push({
        runId: row.run_id,
        agentId: row.agent_id,
        toolkitVersion: row.toolkit_version,
        voteHash: row.vote_hash,
        generatedAt: row.created_at,
        justification: JSON.parse(row.payload_json) as Justification,
      });
    } catch {
      /* skip corrupt row */
    }
  }
  return out;
}

function writeJustification(rec: JustificationRecord): void {
  db.prepare(
    `INSERT OR REPLACE INTO justifications (run_id, agent_id, toolkit_version, vote_hash, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    rec.runId,
    rec.agentId,
    rec.toolkitVersion,
    rec.voteHash,
    JSON.stringify(rec.justification),
    rec.generatedAt,
  );
}

function extractJsonBlock(text: string): string {
  // Try to find the outermost {...} block, tracking string boundaries so that
  // braces inside JSON string literals (very common in latex) don't unbalance depth.
  const trimmed = text.trim();
  const fenceRe = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
  const m = fenceRe.exec(trimmed);
  const candidate = m ? m[1].trim() : trimmed;
  const start = candidate.indexOf('{');
  if (start < 0) return candidate;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return candidate.slice(start);
}

// LLMs frequently emit latex with bare backslashes inside JSON strings —
// e.g. "latex": "VaR_{\alpha}" or "5\%" — which is invalid JSON because \a
// and \% aren't recognized escapes. Walk the string forward, treat any valid
// escape (\", \\, \/, \b, \f, \n, \r, \t, \uXXXX) as an atomic unit, and
// double every other backslash so JSON.parse will accept the document.
// A regex-only fix is unsafe because the engine doesn't know that "\\" is
// already a complete pair — it would re-double the second backslash and break
// otherwise-valid input like "\\alpha".
function repairBackslashes(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch !== '\\') {
      out += ch;
      i++;
      continue;
    }
    const next = i + 1 < s.length ? s[i + 1] : undefined;
    if (next === undefined) {
      out += '\\\\';
      i++;
      continue;
    }
    if (
      next === '"' ||
      next === '\\' ||
      next === '/' ||
      next === 'b' ||
      next === 'f' ||
      next === 'n' ||
      next === 'r' ||
      next === 't'
    ) {
      out += ch + next;
      i += 2;
      continue;
    }
    if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) {
      out += s.slice(i, i + 6);
      i += 6;
      continue;
    }
    out += '\\\\';
    i++;
  }
  return out;
}

function tryParseJustificationJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }
  try {
    return JSON.parse(repairBackslashes(text));
  } catch {
    /* fall through */
  }
  return null;
}

function isLikelyRawJsonBody(j: Justification): boolean {
  if (j.framework || j.citations.length || j.formulas.length) return false;
  const b = j.body.trim();
  if (!b) return false;
  return b.startsWith('{') && /"\s*framework\s*"\s*:/i.test(b);
}

function normalizeJustification(raw: unknown): Justification {
  const r = (raw ?? {}) as Record<string, unknown>;
  const cite = Array.isArray(r.citations) ? r.citations : [];
  const formulas = Array.isArray(r.formulas) ? r.formulas : [];
  return {
    framework: typeof r.framework === 'string' ? r.framework.trim() : '',
    citations: cite
      .map((c) => {
        const cr = (c ?? {}) as Record<string, unknown>;
        return {
          source: typeof cr.source === 'string' ? cr.source.trim() : '',
          locator: typeof cr.locator === 'string' ? cr.locator.trim() : '',
          relevance: typeof cr.relevance === 'string' ? cr.relevance.trim() : '',
        };
      })
      .filter((c) => c.source.length > 0),
    formulas: formulas
      .map((f) => {
        const fr = (f ?? {}) as Record<string, unknown>;
        const out: { name: string; latex: string; applied: string; renderWarning?: boolean } = {
          name: typeof fr.name === 'string' ? fr.name.trim() : '',
          latex: typeof fr.latex === 'string' ? fr.latex.trim() : '',
          applied: typeof fr.applied === 'string' ? fr.applied.trim() : '',
        };
        if (fr.renderWarning === true) out.renderWarning = true;
        return out;
      })
      .filter((f) => f.latex.length > 0),
    body: typeof r.body === 'string' ? r.body.trim() : '',
  };
}

// ─── Actuary formula validation ───────────────────────────────────────
//
// Scan a formula's latex for backslash-commands (\name) and check each
// against the union of ACTUARIAL_MACROS keys + the KaTeX builtin
// whitelist. Returns the list of unknown command names (no leading \).

const ACTUARIAL_MACRO_NAMES = new Set(
  Object.keys(ACTUARIAL_MACROS).map((k) => k.replace(/^\\/, '')),
);

function unknownCommandsInLatex(latex: string): string[] {
  const matches = latex.match(/\\[a-zA-Z]+/g) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    const name = m.slice(1);
    if (seen.has(name)) continue;
    seen.add(name);
    if (ACTUARIAL_MACRO_NAMES.has(name)) continue;
    if (KATEX_BUILTIN_WHITELIST.has(name)) continue;
    out.push(name);
  }
  return out;
}

function buildRepromptUserMessage(unknown: Record<number, string[]>): string {
  const issues = Object.entries(unknown).map(([i, cmds]) => {
    const names = cmds.map((c) => `\\${c}`).join(', ');
    return `  formula[${i}] used ${names} — neither defined macro nor known KaTeX command.`;
  });
  return `Your previous JSON was almost good but had unknown LaTeX commands:
${issues.join('\n')}

Re-emit the SAME justification object, but rewrite the offending latex strings
using only the macros listed in the FORMULA OUTPUT CONTRACT (\\annimm, \\endow,
\\term, \\pureendow, \\reserve, etc.) or plain LaTeX (\\frac, ^, \\sum, \\int,
\\delta, ...). Do not invent macro names. Output strict JSON only — no preamble,
no code fences, no trailing commentary.`;
}

// If any formula contains unknown backslash commands, do ONE re-prompt of the
// model with the previous response in context plus a correction note. Apply
// renderWarning to any formula whose unknown commands persist after the
// re-prompt — never silently drop a formula.
async function applyActuaryRenderGuard(
  justification: Justification,
  systemPrompt: string,
  userPrompt: string,
  priorResponse: string,
  maxTokens: number,
  fresh: boolean | undefined,
): Promise<Justification> {
  if (justification.formulas.length === 0) return justification;

  const first: Record<number, string[]> = {};
  justification.formulas.forEach((f, i) => {
    const unk = unknownCommandsInLatex(f.latex);
    if (unk.length > 0) first[i] = unk;
  });
  if (Object.keys(first).length === 0) return justification;

  // One re-prompt: send original system + user, model's prior response, then
  // a correction user-turn naming the offending commands by index.
  let repromptedJustification = justification;
  try {
    const text = await router.route(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: priorResponse },
        { role: 'user', content: buildRepromptUserMessage(first) },
      ],
      'council',
      { temperature: 0.2, maxTokens, fresh: true },
    );
    const block = extractJsonBlock(text);
    const parsed = tryParseJustificationJson(block);
    if (parsed) {
      const candidate = normalizeJustification(parsed);
      // accept the re-prompt only if it gave us at least as many formulas
      if (candidate.formulas.length > 0) {
        repromptedJustification = candidate;
      }
    }
  } catch {
    /* re-prompt failed; fall through and warn on the original */
  }

  // Final pass: flag any formula whose latex still has unknown commands.
  const finalFormulas = repromptedJustification.formulas.map((f) => {
    const unk = unknownCommandsInLatex(f.latex);
    if (unk.length === 0) return f;
    return { ...f, renderWarning: true };
  });
  return { ...repromptedJustification, formulas: finalFormulas };
}

export interface JustifyResult {
  record: JustificationRecord;
  cached: boolean;
}

export interface JustifyBatchProgress {
  agentId: string;
  done: number;
  total: number;
  cached: boolean;
}

export interface JustifyBatchOpts extends JustifyOpts {
  onProgress?: (p: JustifyBatchProgress) => void;
  onAgentError?: (agentId: string, message: string) => void;
}

export async function justifyAllAgents(
  run: Run,
  canonText: string,
  opts: JustifyBatchOpts = {},
): Promise<{ records: JustificationRecord[]; elapsedMs: number; errors: number }> {
  const t0 = performance.now();
  const total = run.councilResults.length;
  let done = 0;
  let errors = 0;
  const records: JustificationRecord[] = [];
  // Fire in parallel — the LLM router's cloud semaphore (cap 8) and ollama semaphore (cap 32)
  // are what actually limit concurrency. Cache hits return instantly.
  await Promise.all(
    run.councilResults.map(async (agent) => {
      try {
        const r = await justifyAgent(run, agent, canonText, {
          fresh: opts.fresh,
          legalJurisdiction: opts.legalJurisdiction,
        });
        records.push(r.record);
        done++;
        opts.onProgress?.({ agentId: agent.agent.id, done, total, cached: r.cached });
      } catch (e) {
        errors++;
        done++;
        const msg = e instanceof Error ? e.message : String(e);
        opts.onAgentError?.(agent.agent.id, msg);
        opts.onProgress?.({ agentId: agent.agent.id, done, total, cached: false });
      }
    }),
  );
  return { records, elapsedMs: Math.round(performance.now() - t0), errors };
}

export async function justifyAgent(
  run: Run,
  agent: CouncilAgentResult,
  canonText: string,
  opts: JustifyOpts = {},
): Promise<JustifyResult> {
  const vote = {
    stance: agent.finalStance,
    confidence: agent.finalConfidence,
    keyRisk: agent.keyRisk,
  };
  const vh = voteHash(vote);

  if (!opts.fresh) {
    const existing = readJustification(run.id, agent.agent.id);
    if (
      existing &&
      existing.toolkitVersion === TOOLKIT_VERSION &&
      existing.voteHash === vh &&
      !isLikelyRawJsonBody(existing.justification)
    ) {
      return { record: existing, cached: true };
    }
  }

  const canon = loadCanon();
  const matchedCanon = matchCanonByKeywords(run.scenario, canon);

  const baseSystem = buildSystemPrompt(agent.agent, canonText, {
    legalJurisdiction: opts.legalJurisdiction,
  });
  const addendum = buildJustificationSystemAddendum({
    scenario: run.scenario,
    profession: agent.agent.profession,
    vote,
    matchedCanon,
    legalJurisdiction: opts.legalJurisdiction,
  });
  const userPrompt = buildJustificationUserPrompt({
    scenario: run.scenario,
    profession: agent.agent.profession,
    vote,
    matchedCanon,
    legalJurisdiction: opts.legalJurisdiction,
  });

  const systemPrompt = `${baseSystem}\n\n## JUSTIFICATION MODE\n${addendum}`;
  const text = await router.route(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    'council',
    { temperature: 0.2, maxTokens: JUSTIFY_MAX_TOKENS, fresh: opts.fresh },
  );

  const block = extractJsonBlock(text);
  const parsed = tryParseJustificationJson(block);
  let justification = normalizeJustification(
    parsed ?? { body: text.trim(), framework: '', citations: [], formulas: [] },
  );

  if (agent.agent.profession === 'Actuary') {
    justification = await applyActuaryRenderGuard(
      justification,
      systemPrompt,
      userPrompt,
      text,
      JUSTIFY_MAX_TOKENS,
      opts.fresh,
    );
  }

  const record: JustificationRecord = {
    runId: run.id,
    agentId: agent.agent.id,
    toolkitVersion: TOOLKIT_VERSION,
    voteHash: vh,
    generatedAt: Date.now(),
    justification,
  };
  writeJustification(record);
  return { record, cached: false };
}

// ─── Aggregated group justification ─────────────────────────────────────

export interface JustifyGroupResult {
  record: JustificationRecord;
  cached: boolean;
  size: number;
}

export function isProfession(s: string): s is Profession {
  return (PROFESSIONS as readonly string[]).includes(s);
}

export async function justifyGroup(
  run: Run,
  profession: Profession,
  canonText: string,
  opts: JustifyOpts = {},
): Promise<JustifyGroupResult> {
  const agents = run.councilResults.filter((r) => r.agent.profession === profession);
  if (agents.length === 0) {
    throw new Error(`no ${profession} agents in this run`);
  }
  const entries: GroupVoteEntry[] = agents.map((a) => ({
    agentId: a.agent.id,
    mbti: a.agent.mbti,
    gender: a.agent.gender,
    stance: a.finalStance,
    confidence: a.finalConfidence,
    keyRisk: a.keyRisk,
  }));
  const gh = groupVoteHash(entries);
  const cacheId = groupAgentId(profession);

  if (!opts.fresh) {
    const existing = readJustification(run.id, cacheId);
    if (
      existing &&
      existing.toolkitVersion === TOOLKIT_VERSION &&
      existing.voteHash === gh &&
      !isLikelyRawJsonBody(existing.justification)
    ) {
      return { record: existing, cached: true, size: agents.length };
    }
  }

  const matchedCanon = matchCanonByKeywords(run.scenario, loadCanon());
  const system = buildGroupSystemAddendum({
    scenario: run.scenario,
    profession,
    agents: entries,
    matchedCanon,
    legalJurisdiction: opts.legalJurisdiction,
  });
  const user = buildGroupUserPrompt({ scenario: run.scenario, profession });

  const text = await router.route(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    'council',
    { temperature: 0.2, maxTokens: JUSTIFY_GROUP_MAX_TOKENS, fresh: opts.fresh },
  );

  const block = extractJsonBlock(text);
  const parsed = tryParseJustificationJson(block);
  let justification = normalizeJustification(
    parsed ?? { body: text.trim(), framework: '', citations: [], formulas: [] },
  );

  if (profession === 'Actuary') {
    justification = await applyActuaryRenderGuard(
      justification,
      system,
      user,
      text,
      JUSTIFY_GROUP_MAX_TOKENS,
      opts.fresh,
    );
  }

  const record: JustificationRecord = {
    runId: run.id,
    agentId: cacheId,
    toolkitVersion: TOOLKIT_VERSION,
    voteHash: gh,
    generatedAt: Date.now(),
    justification,
  };
  writeJustification(record);
  return { record, cached: false, size: agents.length };
}
