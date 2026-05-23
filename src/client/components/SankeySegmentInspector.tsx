import { useMemo } from 'react';
import type { Run, Stance, Sentiment, CouncilAgentResult, SocietyAgentResult } from '../../shared/types';
import type { CrossHighlight } from './CouncilGraph';

type Props = {
  run: Run;
  highlight: NonNullable<CrossHighlight>;
  onClose: () => void;
};

const STANCE_CLASS: Record<Stance, string> = {
  support: 'status-ok',
  oppose: 'status-err',
  abstain: 'muted',
};

const SENTIMENT_CLASS: Record<Sentiment, string> = {
  enthusiastic: 'status-ok',
  supportive: 'status-ok',
  neutral: 'muted',
  skeptical: 'status-warn',
  hostile: 'status-err',
};

const ORDER_STANCE: Stance[] = ['support', 'oppose', 'abstain'];
const ORDER_SENT: Sentiment[] = ['enthusiastic', 'supportive', 'neutral', 'skeptical', 'hostile'];

/** Decision-sidebar view for a click-locked Sankey segment. Aggregates the
 *  matching agents into stats, distribution, and a sample listing. */
export function SankeySegmentInspector({ run, highlight, onClose }: Props) {
  const segment = useMemo(() => parseSegmentKey(highlight.key), [highlight.key]);
  const ids = useMemo(() => new Set(highlight.agentIds), [highlight.agentIds]);

  // Determine tier from id prefixes. Council ids start with `c-`, society
  // with `s-`. The Sankey only ever populates one tier per click.
  const isCouncil = highlight.agentIds.some((id) => id.startsWith('c-'));
  const isSociety = highlight.agentIds.some((id) => id.startsWith('s-'));

  if (isCouncil) {
    const agents = run.councilResults.filter((r) => ids.has(r.agent.id));
    return <CouncilSegment agents={agents} total={run.councilResults.length} segment={segment} onClose={onClose} />;
  }
  if (isSociety) {
    const members = run.societyResults.filter((r) => ids.has(r.agent.id));
    return <SocietySegment members={members} total={run.societyResults.length} segment={segment} onClose={onClose} />;
  }
  // No matching ids in this run (e.g. agentIds resolved to empty). Show a
  // friendly placeholder so the sidebar isn't blank.
  return (
    <aside className="inspector">
      <div className="inspector-header">
        <div className="agent-id">Sankey segment</div>
        <button className="ghost-btn" onClick={onClose}>close</button>
      </div>
      <div className="inspector-body">
        <div className="muted small">No agents flow through this segment in the current run.</div>
      </div>
    </aside>
  );
}

// ─── Council variant ──────────────────────────────────────────────────

function CouncilSegment({
  agents,
  total,
  segment,
  onClose,
}: {
  agents: CouncilAgentResult[];
  total: number;
  segment: { label: string; sublabel: string };
  onClose: () => void;
}) {
  const n = agents.length;
  const pct = total ? Math.round((n / total) * 1000) / 10 : 0;
  const byStance: Record<Stance, number> = { support: 0, oppose: 0, abstain: 0 };
  let sumConf = 0;
  const profCount = new Map<string, number>();
  const mbtiCount = new Map<string, number>();
  for (const r of agents) {
    byStance[r.finalStance]++;
    sumConf += r.finalConfidence;
    profCount.set(r.agent.profession, (profCount.get(r.agent.profession) ?? 0) + 1);
    mbtiCount.set(r.agent.mbti, (mbtiCount.get(r.agent.mbti) ?? 0) + 1);
  }
  const dominant = (Object.keys(byStance) as Stance[]).reduce(
    (best, k) => (byStance[k] > byStance[best] ? k : best),
    'abstain' as Stance,
  );
  const avgConf = n ? Math.round(sumConf / n) : 0;

  // Aggregate top key-risk phrases for a "justification at a glance"
  // takeaway. We count short phrase fragments rather than full sentences
  // so similar risks group together.
  const risks = topPhrases(agents.map((r) => r.keyRisk).filter(Boolean), 4);

  // Justification: a concise, deterministic English summary built from the
  // numbers — gives the user a takeaway without firing another LLM call.
  const justification = buildCouncilJustification({
    n, total, pct, dominant, byStance, avgConf, segment, profCount,
  });

  return (
    <aside className="inspector">
      <div className="inspector-header">
        <div>
          <div className="agent-tag">
            <div className="agent-id">Sankey segment · {segment.label}</div>
            <div className="muted small">{segment.sublabel}</div>
          </div>
        </div>
        <button className="ghost-btn" onClick={onClose}>close</button>
      </div>

      <div className="inspector-vote">
        <div>
          <div className="panel-label">agents</div>
          <div className="big-num num">{n}</div>
          <div className="muted small">{pct}% of {total}</div>
        </div>
        <div>
          <div className="panel-label">dominant stance</div>
          <div className={`big-num ${STANCE_CLASS[dominant]}`}>{dominant}</div>
        </div>
        <div>
          <div className="panel-label">avg confidence</div>
          <div className="big-num num">{avgConf}</div>
        </div>
      </div>

      <div className="inspector-body">
        <section className="round-block">
          <div className="round-header"><span className="panel-label">stance mix</span></div>
          <div className="small group-dist">
            {ORDER_STANCE.map((s, i) => (
              <span key={s}>
                {i > 0 && <span className="muted"> · </span>}
                <span className={STANCE_CLASS[s]}>{s} {byStance[s]}</span>
              </span>
            ))}
          </div>
        </section>

        {profCount.size > 1 && (
          <section className="round-block">
            <div className="round-header"><span className="panel-label">profession mix</span></div>
            <div className="small group-dist">
              {Array.from(profCount.entries())
                .sort((a, b) => b[1] - a[1])
                .map(([p, c], i) => (
                  <span key={p}>
                    {i > 0 && <span className="muted"> · </span>}
                    <span>{p} {c}</span>
                  </span>
                ))}
            </div>
          </section>
        )}

        {risks.length > 0 && (
          <section className="round-block">
            <div className="round-header"><span className="panel-label">recurring key risks</span></div>
            <ul className="muted small" style={{ paddingLeft: 18, margin: 0 }}>
              {risks.map((r) => (
                <li key={r.phrase}>{r.phrase}{r.count > 1 ? ` (${r.count}×)` : ''}</li>
              ))}
            </ul>
          </section>
        )}

        <section className="round-block">
          <div className="round-header"><span className="panel-label">justification</span></div>
          <p className="small" style={{ margin: 0 }}>{justification}</p>
        </section>

        <section className="round-block">
          <div className="round-header">
            <span className="panel-label">members</span>
            <span className="muted small">round-3 votes</span>
          </div>
          <table className="syn-table">
            <thead>
              <tr>
                <th>Member</th>
                <th>Stance</th>
                <th>Conf</th>
                <th>Key risk</th>
              </tr>
            </thead>
            <tbody>
              {agents
                .slice()
                .sort((a, b) => b.finalConfidence - a.finalConfidence)
                .map((r) => (
                  <tr key={r.agent.id}>
                    <td className="muted small">
                      {r.agent.profession.slice(0, 4).toLowerCase()}·{r.agent.mbti}/{r.agent.gender}
                    </td>
                    <td>
                      <span className={`stance-pill ${STANCE_CLASS[r.finalStance]}`}>
                        {r.finalStance}
                      </span>
                    </td>
                    <td className="num small">{r.finalConfidence}</td>
                    <td className="small">{r.keyRisk}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      </div>
    </aside>
  );
}

function buildCouncilJustification(p: {
  n: number;
  total: number;
  pct: number;
  dominant: Stance;
  byStance: Record<Stance, number>;
  avgConf: number;
  segment: { label: string; sublabel: string };
  profCount: Map<string, number>;
}): string {
  if (p.n === 0) return 'No council agents flow through this segment.';
  const verb = p.byStance[p.dominant] === p.n ? 'unanimously' : 'predominantly';
  const stanceText =
    p.dominant === 'support' ? 'support the proposal'
      : p.dominant === 'oppose' ? 'oppose the proposal'
        : 'abstain';
  const confText =
    p.avgConf >= 80 ? `with strong conviction (avg confidence ${p.avgConf})`
      : p.avgConf >= 60 ? `with moderate conviction (avg confidence ${p.avgConf})`
        : `with low conviction (avg confidence ${p.avgConf})`;
  const profs = Array.from(p.profCount.entries()).sort((a, b) => b[1] - a[1]);
  const profText = profs.length === 1
    ? ` All ${p.n} are ${profs[0][0]} agents.`
    : profs.length > 1
      ? ` Drawn from ${profs.length} professions (lead: ${profs[0][0]}).`
      : '';
  return (
    `${p.n} of ${p.total} council agents (${p.pct}%) sit in the “${p.segment.label}” band ` +
    `and ${verb} ${stanceText} ${confText}.${profText}`
  );
}

// ─── Society variant ──────────────────────────────────────────────────

function SocietySegment({
  members,
  total,
  segment,
  onClose,
}: {
  members: SocietyAgentResult[];
  total: number;
  segment: { label: string; sublabel: string };
  onClose: () => void;
}) {
  const n = members.length;
  const pct = total ? Math.round((n / total) * 1000) / 10 : 0;
  const bySent: Record<Sentiment, number> = {
    enthusiastic: 0, supportive: 0, neutral: 0, skeptical: 0, hostile: 0,
  };
  let sumInt = 0;
  let sumAge = 0;
  const incomeCount = new Map<string, number>();
  for (const r of members) {
    bySent[r.sentiment]++;
    sumInt += r.intensity ?? 0;
    sumAge += r.agent.age ?? 0;
    incomeCount.set(r.agent.incomeBand, (incomeCount.get(r.agent.incomeBand) ?? 0) + 1);
  }
  const dominant = (Object.keys(bySent) as Sentiment[]).reduce(
    (best, k) => (bySent[k] > bySent[best] ? k : best),
    'neutral' as Sentiment,
  );
  const avgInt = n ? Math.round(sumInt / n) : 0;
  const avgAge = n ? Math.round(sumAge / n) : 0;

  const justification = buildSocietyJustification({
    n, total, pct, dominant, bySent, avgInt, avgAge, segment, incomeCount,
  });

  // 5 strongest reactions (by intensity) as a flavour sample.
  const sample = members.slice().sort((a, b) => b.intensity - a.intensity).slice(0, 5);

  return (
    <aside className="inspector">
      <div className="inspector-header">
        <div>
          <div className="agent-tag">
            <div className="agent-id">Sankey segment · {segment.label}</div>
            <div className="muted small">{segment.sublabel}</div>
          </div>
        </div>
        <button className="ghost-btn" onClick={onClose}>close</button>
      </div>

      <div className="inspector-vote">
        <div>
          <div className="panel-label">members</div>
          <div className="big-num num">{n}</div>
          <div className="muted small">{pct}% of {total}</div>
        </div>
        <div>
          <div className="panel-label">dominant sentiment</div>
          <div className={`big-num ${SENTIMENT_CLASS[dominant]}`}>{dominant}</div>
        </div>
        <div>
          <div className="panel-label">avg intensity</div>
          <div className="big-num num">{avgInt}</div>
        </div>
      </div>

      <div className="inspector-body">
        <section className="round-block">
          <div className="round-header"><span className="panel-label">sentiment mix</span></div>
          <div className="small group-dist">
            {ORDER_SENT.filter((s) => bySent[s] > 0).map((s, i) => (
              <span key={s}>
                {i > 0 && <span className="muted"> · </span>}
                <span className={SENTIMENT_CLASS[s]}>{s} {bySent[s]}</span>
              </span>
            ))}
          </div>
        </section>

        {incomeCount.size > 1 && (
          <section className="round-block">
            <div className="round-header"><span className="panel-label">income mix</span></div>
            <div className="small group-dist">
              {Array.from(incomeCount.entries())
                .sort((a, b) => b[1] - a[1])
                .map(([b, c], i) => (
                  <span key={b}>
                    {i > 0 && <span className="muted"> · </span>}
                    <span>{b} {c}</span>
                  </span>
                ))}
            </div>
          </section>
        )}

        <section className="round-block">
          <div className="round-header"><span className="panel-label">justification</span></div>
          <p className="small" style={{ margin: 0 }}>{justification}</p>
        </section>

        <section className="round-block">
          <div className="round-header">
            <span className="panel-label">strongest reactions</span>
            <span className="muted small">top {sample.length} by intensity</span>
          </div>
          <ul className="muted small" style={{ paddingLeft: 18, margin: 0 }}>
            {sample.map((r) => (
              <li key={r.agent.id}>
                <span className={SENTIMENT_CLASS[r.sentiment]}>{r.sentiment}</span>{' '}
                <span className="num">{r.intensity}</span> · {r.agent.age}y · {r.agent.incomeBand} · {r.agent.region}
                {r.reaction && <div className="small" style={{ marginLeft: 0 }}>{r.reaction}</div>}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </aside>
  );
}

function buildSocietyJustification(p: {
  n: number;
  total: number;
  pct: number;
  dominant: Sentiment;
  bySent: Record<Sentiment, number>;
  avgInt: number;
  avgAge: number;
  segment: { label: string; sublabel: string };
  incomeCount: Map<string, number>;
}): string {
  if (p.n === 0) return 'No society members flow through this segment.';
  const verb = p.bySent[p.dominant] === p.n ? 'all of them' : 'most';
  const intText =
    p.avgInt >= 70 ? 'feeling it strongly'
      : p.avgInt >= 40 ? 'feeling it moderately'
        : 'feeling it mildly';
  const incomes = Array.from(p.incomeCount.entries()).sort((a, b) => b[1] - a[1]);
  const incomeText = incomes.length
    ? ` Income mix leans ${incomes[0][0]} (${incomes[0][1]} of ${p.n}).`
    : '';
  return (
    `${p.n} of ${p.total} society members (${p.pct}%) sit in “${p.segment.label}”. ` +
    `${verb[0].toUpperCase()}${verb.slice(1)} are ${p.dominant}, ${intText} ` +
    `(avg intensity ${p.avgInt}, avg age ${p.avgAge}).${incomeText}`
  );
}

// ─── helpers ──────────────────────────────────────────────────────────

function parseSegmentKey(key: string): { label: string; sublabel: string } {
  // Examples:
  //   node:prof:Actuary           → "Actuary"           · "profession"
  //   node:stance:oppose          → "oppose"            · "council stance"
  //   node:conf:Confident ≥75     → "Confident ≥75"     · "confidence band"
  //   node:clu:c2                 → "Cluster c2"        · "society cluster"
  //   node:sent:skeptical         → "skeptical"         · "society sentiment"
  //   node:int:Mid 40-69          → "Mid 40-69"         · "intensity band"
  //   edge:prof:Actuary|stance:oppose → "Actuary → oppose" · "flow"
  if (key.startsWith('edge:')) {
    const inner = key.slice(5);
    const [src, tgt] = inner.split('|');
    return { label: `${stripPrefix(src)} → ${stripPrefix(tgt)}`, sublabel: 'flow segment' };
  }
  if (key.startsWith('node:')) {
    const inner = key.slice(5);
    if (inner.startsWith('prof:')) return { label: inner.slice(5), sublabel: 'profession' };
    if (inner.startsWith('stance:')) return { label: inner.slice(7), sublabel: 'council stance' };
    if (inner.startsWith('conf:')) return { label: inner.slice(5), sublabel: 'confidence band' };
    if (inner.startsWith('clu:')) return { label: `Cluster ${inner.slice(4)}`, sublabel: 'society cluster' };
    if (inner.startsWith('sent:')) return { label: inner.slice(5), sublabel: 'society sentiment' };
    if (inner.startsWith('int:')) return { label: inner.slice(4), sublabel: 'intensity band' };
    return { label: inner, sublabel: 'segment' };
  }
  return { label: key, sublabel: 'segment' };
}

function stripPrefix(s: string): string {
  return s.replace(/^(prof|stance|conf|clu|sent|int):/, '');
}

// Count short-phrase frequencies across a corpus. Cheap and deterministic:
// lowercase, take the first 8 words of each risk, group exact duplicates,
// return top-N. Good enough to surface "Solvency II compliance" or
// "liquidity stress" as repeating themes.
function topPhrases(strings: string[], n: number): { phrase: string; count: number }[] {
  const c = new Map<string, { phrase: string; count: number }>();
  for (const s of strings) {
    const key = s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .slice(0, 8)
      .join(' ')
      .trim();
    if (!key) continue;
    const e = c.get(key);
    if (e) e.count++;
    else c.set(key, { phrase: s.split(/\s+/).slice(0, 14).join(' '), count: 1 });
  }
  return Array.from(c.values()).sort((a, b) => b.count - a.count).slice(0, n);
}
