import type { Run } from '../shared/types';
import { router, type Message } from './llm/router';
import { getRun } from './runs';
import { buildCondensedCanon } from './iaai';
import { listJustifications } from './justify';

const SYSTEM = `You are the SWARM COUNCIL chatbot.

The professor has run a multi-perspective deliberation: a council of 256 expert
agents (8 professions × 16 MBTI × 2 genders) and an optional 1000-agent society
sample. The full run state is provided below as structured data.

Rules:
- Answer ONLY from the data provided. If the data does not contain what is asked,
  say so plainly — do NOT invent agents, quotes, or numbers.
- Cite agents by their id (e.g. c-actuary-intj-f) when relevant.
- When the Justifications section is present, you can answer queries like "which
  lawyers cited the Companies Act" or "which actuaries used Bornhuetter-Ferguson"
  by scanning the cite: and formula: lines under each agent. When a Group
  justifications section is also present, those entries are the AGGREGATED
  voice of an entire profession on this council — use them to answer
  questions like "what is the Finance group's position" or "summarise the
  lawyers' collective view".
- Be terse. No filler. No hedging caveats unless materially warranted.
- The swarm does NOT make the decision; you are reporting on what the swarm said
  so the professor can decide.`;

export function buildChatContext(run: Run): string {
  const lines: string[] = [];
  lines.push('# RUN CONTEXT');
  lines.push(`run_id: ${run.id}`);
  lines.push(`created: ${new Date(run.createdAt).toISOString()}`);

  lines.push('\n## IAAI Canon (injected into every council agent\'s system prompt)');
  const canon = buildCondensedCanon();
  lines.push(canon || '(canon is empty — agents are told to say so when asked)');

  lines.push('\n## Scenario');
  lines.push(run.scenario);

  if (run.summary) {
    lines.push('\n## Council synthesis');
    lines.push(
      `support: ${run.summary.supportPct}%   oppose: ${run.summary.opposePct}%   abstain: ${run.summary.abstainPct}%`,
    );
    lines.push(`consensus_score: ${run.summary.consensusScore}/100`);
    lines.push(`dissenters: ${run.summary.dissentingAgentIds.length}`);
    if (run.summary.topRisks.length) {
      lines.push('top_risks_clustered:');
      for (const r of run.summary.topRisks.slice(0, 10)) {
        lines.push(`  - (${r.count}) ${r.risk}`);
      }
    }
  }

  // ---- council table ----
  if (run.councilResults.length) {
    lines.push(`\n## Council agents (n=${run.councilResults.length})`);
    lines.push('id | profession/mbti/gender | stance | conf | risk');
    for (const r of run.councilResults) {
      const tag = `${r.agent.profession}/${r.agent.mbti}/${r.agent.gender}`;
      const risk = r.keyRisk.replace(/\s+/g, ' ').slice(0, 110);
      lines.push(`${r.agent.id} | ${tag} | ${r.finalStance} | ${r.finalConfidence} | ${risk}`);
    }
  }

  // ---- top dissenters with r2 reasoning ----
  if (run.summary && run.summary.dissentingAgentIds.length) {
    const dissenters = run.summary.dissentingAgentIds
      .map((id) => run.councilResults.find((r) => r.agent.id === id))
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => b.finalConfidence - a.finalConfidence)
      .slice(0, 5);
    if (dissenters.length) {
      lines.push('\n## Top dissenters — round-2 reasoning');
      for (const r of dissenters) {
        const r2 = (r.rounds.find((x) => x.round === 2)?.content ?? '').replace(/\s+/g, ' ').slice(0, 500);
        lines.push(
          `- ${r.agent.id} (${r.finalStance} ${r.finalConfidence}, risk: ${r.keyRisk.slice(0, 80)})`,
        );
        lines.push(`  r2: ${r2}`);
      }
    }
  }

  // ---- justifications (individual + group-aggregated) ----
  const justifs = listJustifications(run.id);
  if (justifs.length) {
    const groupJustifs = justifs.filter((j) => j.agentId.startsWith('group:'));
    const indivJustifs = justifs.filter((j) => !j.agentId.startsWith('group:'));
    const byAgent = new Map(indivJustifs.map((j) => [j.agentId, j] as const));

    if (groupJustifs.length) {
      lines.push(`\n## Group justifications (n=${groupJustifs.length})`);
      lines.push(
        'each entry is the AGGREGATED voice of an entire profession group — defending',
      );
      lines.push('the collective round-3 stance using shared canonical material.');
      for (const g of groupJustifs) {
        const prof = g.agentId.replace(/^group:/, '');
        const size = run.councilResults.filter((r) => r.agent.profession === prof).length;
        lines.push(`\n- ${prof} group (n=${size})`);
        if (g.justification.framework) {
          lines.push(`  framework: ${g.justification.framework}`);
        }
        if (g.justification.citations.length) {
          for (const c of g.justification.citations) {
            const loc = c.locator ? ` @ ${c.locator}` : '';
            const rel = c.relevance ? ` — ${c.relevance.replace(/\s+/g, ' ').slice(0, 140)}` : '';
            lines.push(`  cite: ${c.source}${loc}${rel}`);
          }
        }
        if (g.justification.formulas.length) {
          for (const f of g.justification.formulas) {
            const name = f.name ? `${f.name}: ` : '';
            lines.push(`  formula: ${name}${f.latex.replace(/\s+/g, ' ').slice(0, 160)}`);
          }
        }
        if (g.justification.body) {
          lines.push(`  body: ${g.justification.body.replace(/\s+/g, ' ').slice(0, 480)}`);
        }
      }
    }

    if (indivJustifs.length) {
      lines.push(`\n## Justifications (n=${indivJustifs.length})`);
      lines.push(
        'each entry is the agent\'s on-demand defense of their round-3 vote, citing canonical material',
      );
      lines.push('of their profession (and the jurisdiction in effect for Lawyer).');
      for (const r of run.councilResults) {
        const j = byAgent.get(r.agent.id);
        if (!j) continue;
        const tag = `${r.agent.profession}/${r.agent.mbti}/${r.agent.gender}`;
        lines.push(`\n- ${r.agent.id} (${tag}) — ${r.finalStance} ${r.finalConfidence}`);
        if (j.justification.framework) {
          lines.push(`  framework: ${j.justification.framework}`);
        }
        if (j.justification.citations.length) {
          for (const c of j.justification.citations) {
            const loc = c.locator ? ` @ ${c.locator}` : '';
            const rel = c.relevance ? ` — ${c.relevance.replace(/\s+/g, ' ').slice(0, 140)}` : '';
            lines.push(`  cite: ${c.source}${loc}${rel}`);
          }
        }
        if (j.justification.formulas.length) {
          for (const f of j.justification.formulas) {
            const name = f.name ? `${f.name}: ` : '';
            lines.push(`  formula: ${name}${f.latex.replace(/\s+/g, ' ').slice(0, 160)}`);
          }
        }
        if (j.justification.body) {
          lines.push(`  body: ${j.justification.body.replace(/\s+/g, ' ').slice(0, 380)}`);
        }
      }
    }
  }

  // ---- society ----
  if (run.societySummary) {
    const s = run.societySummary;
    lines.push(`\n## Society (n=${s.size}, culture=${run.societyParams.culture})`);
    lines.push(`average_intensity: ${s.averageIntensity}`);
    lines.push(
      `sentiment_mix: ${Object.entries(s.sentimentMix)
        .map(([k, v]) => `${k}:${v}`)
        .join('  ')}`,
    );
    if (s.clusters.length) {
      lines.push('clusters:');
      for (const c of s.clusters) {
        const mix = Object.entries(c.sentimentMix)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${k}:${n}`)
          .join(', ');
        lines.push(`  - c${c.cluster} n=${c.size} ${c.description} [${mix}]`);
      }
    }
    // a small sample of society reactions per sentiment (max 2 each)
    const bySent = new Map<string, string[]>();
    for (const r of run.societyResults) {
      const arr = bySent.get(r.sentiment) ?? [];
      if (arr.length < 2) {
        arr.push(`(${r.agent.age}y, ${r.agent.incomeBand}, ${r.agent.region}): "${r.reaction.replace(/\s+/g, ' ').slice(0, 160)}"`);
        bySent.set(r.sentiment, arr);
      }
    }
    if (bySent.size) {
      lines.push('sample_reactions:');
      for (const [sent, arr] of bySent) {
        for (const line of arr) lines.push(`  [${sent}] ${line}`);
      }
    }
  }

  return lines.join('\n');
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export async function* streamChat(
  runId: string,
  message: string,
  history: ChatMessage[] = [],
  opts: { fresh?: boolean } = {},
): AsyncGenerator<string, { provider: string; model: string; full: string }> {
  const run = getRun(runId);
  if (!run) throw new Error('run not found');
  if (run.status !== 'complete') throw new Error(`run is ${run.status}; chat only available on complete runs`);

  const context = buildChatContext(run);
  const messages: Message[] = [
    { role: 'system', content: `${SYSTEM}\n\n${context}` },
    ...history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: message },
  ];

  let acc = '';
  let provider = '';
  let model = '';
  const gen = router.routeStream(messages, 'chat', { fresh: opts.fresh, maxTokens: 700, temperature: 0.4 });
  let result: IteratorResult<string, { provider: string; model: string; cached: boolean; full: string }>;
  // manually iterate so we can capture the return value at the end
  // eslint-disable-next-line no-constant-condition
  while (true) {
    result = await gen.next();
    if (result.done) {
      provider = result.value.provider;
      model = result.value.model;
      acc = result.value.full;
      break;
    }
    acc += result.value;
    yield result.value;
  }
  return { provider, model, full: acc };
}
