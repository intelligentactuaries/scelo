import type { Run } from '../../shared/types';
import { colorsForTheme, PROFESSIONS, type Profession } from '../../shared/constants';
import { useTheme } from '../lib/theme';

type Props = {
  run: Run;
  onSelectAgent: (id: string) => void;
};

export function SynthesisView({ run, onSelectAgent }: Props) {
  const s = run.summary;
  const { resolved } = useTheme();
  const colors = colorsForTheme(resolved);
  if (!s) {
    return (
      <div className="canvas-body">
        <div className="empty-state">
          <div className="muted small">
            no readback yet — the council synthesis lands after round 3.
          </div>
        </div>
      </div>
    );
  }

  const byProf = new Map<Profession, { sup: number; opp: number; abs: number }>();
  for (const p of PROFESSIONS) byProf.set(p, { sup: 0, opp: 0, abs: 0 });
  for (const r of run.councilResults) {
    const c = byProf.get(r.agent.profession)!;
    if (r.finalStance === 'support') c.sup++;
    else if (r.finalStance === 'oppose') c.opp++;
    else c.abs++;
  }

  const dissenters = s.dissentingAgentIds
    .map((id) => run.councilResults.find((r) => r.agent.id === id))
    .filter((x): x is NonNullable<typeof x> => !!x)
    .slice(0, 16);

  return (
    <div className="synthesis-scroll">
      <div className="syn-note muted small">
        council readback on the W(M,T,R) forecast — the simulator predicts, the
        council interrogates, the professor decides.
      </div>

      <section className="syn-section">
        <div className="panel-label">trust in the forecast</div>
        <StackBar support={s.supportPct} oppose={s.opposePct} abstain={s.abstainPct} colors={colors} />
        <div className="syn-legend muted small">
          <span><i style={{ background: colors.consensus }} /> trust {s.supportPct}%</span>
          <span><i style={{ background: colors.adversarial }} /> distrust {s.opposePct}%</span>
          <span><i style={{ background: colors.muted }} /> uncertain {s.abstainPct}%</span>
        </div>
        <div className="syn-metric">
          <div>
            <div className="panel-label">consensus</div>
            <div className="big-num num">{s.consensusScore}</div>
            <div className="muted small">/100 (majority share)</div>
          </div>
          <div>
            <div className="panel-label">dissenters</div>
            <div className="big-num num">{s.dissentingAgentIds.length}</div>
            <div className="muted small">agents against majority</div>
          </div>
          <div>
            <div className="panel-label">agents</div>
            <div className="big-num num">{run.councilResults.length}</div>
            <div className="muted small">council size</div>
          </div>
        </div>
      </section>

      <section className="syn-section">
        <div className="panel-label">trust by profession</div>
        <table className="syn-table">
          <thead>
            <tr>
              <th>profession</th>
              <th className="num">trust</th>
              <th className="num">distrust</th>
              <th className="num">uncertain</th>
            </tr>
          </thead>
          <tbody>
            {[...byProf.entries()].map(([p, c]) => (
              <tr key={p}>
                <td>{p}</td>
                <td className="num status-ok">{c.sup}</td>
                <td className="num status-err">{c.opp}</td>
                <td className="num muted">{c.abs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="syn-section">
        <div className="panel-label">what the forecast misses (or captures) · clustered key risks</div>
        <div className="syn-risks">
          {s.topRisks.length === 0 && <div className="muted small">no risks reported</div>}
          {s.topRisks.map((r, i) => (
            <div key={i} className="syn-risk">
              <span className="num count-pill">{r.count}</span>
              <span>{r.risk}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="syn-section">
        <div className="panel-label">dissenters from the council majority · sorted by confidence</div>
        {dissenters.length === 0 ? (
          <div className="muted small">unanimous (none dissenting)</div>
        ) : (
          <div className="dissent-list">
            {dissenters.map((r) => (
              <button key={r.agent.id} className="dissent-row" onClick={() => onSelectAgent(r.agent.id)}>
                <span className="muted small">{r.agent.profession.slice(0, 4)}/{r.agent.mbti}/{r.agent.gender}</span>
                <span className={r.finalStance === 'support' ? 'status-ok' : r.finalStance === 'oppose' ? 'status-err' : 'muted'}>
                  {r.finalStance === 'support' ? 'trust' : r.finalStance === 'oppose' ? 'distrust' : 'uncertain'}
                </span>
                <span className="num">{r.finalConfidence}</span>
                <span className="dissent-risk">{r.keyRisk}</span>
              </button>
            ))}
            {s.dissentingAgentIds.length > dissenters.length && (
              <div className="muted small" style={{ padding: '4px 2px' }}>
                … {s.dissentingAgentIds.length - dissenters.length} more — drill in via the council tab.
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function StackBar({ support, oppose, abstain, colors }: { support: number; oppose: number; abstain: number; colors: ReturnType<typeof colorsForTheme> }) {
  const segs = [
    { key: 'trust', v: support, bg: colors.consensus },
    { key: 'distrust', v: oppose, bg: colors.adversarial },
    { key: 'uncertain', v: abstain, bg: colors.muted },
  ].filter((s) => s.v > 0);
  return (
    <div className="stack-bar">
      {segs.map((s) => (
        <div key={s.key} className="stack-seg" style={{ flex: s.v, background: s.bg }} />
      ))}
    </div>
  );
}
