import { useMemo } from 'react';
import type { Run, Stance } from '../../shared/types';
import { PROFESSION_PALETTE, type LegalJurisdiction, type Profession } from '../../shared/constants';
import { JustificationPanel } from './JustificationPanel';

type Props = {
  run: Run;
  runId: string | null;
  profession: Profession;
  legalJurisdiction: LegalJurisdiction;
  onClose: () => void;
};

const STANCE_CLASS: Record<Stance, string> = {
  support: 'status-ok',
  oppose: 'status-err',
  abstain: 'muted',
};

export function GroupInspector({
  run,
  runId,
  profession,
  legalJurisdiction,
  onClose,
}: Props) {
  const stats = useMemo(() => {
    const agents = run.councilResults.filter((r) => r.agent.profession === profession);
    const byStance: Record<Stance, { count: number; sumConf: number }> = {
      support: { count: 0, sumConf: 0 },
      oppose: { count: 0, sumConf: 0 },
      abstain: { count: 0, sumConf: 0 },
    };
    let sumConf = 0;
    for (const a of agents) {
      byStance[a.finalStance].count++;
      byStance[a.finalStance].sumConf += a.finalConfidence;
      sumConf += a.finalConfidence;
    }
    const dominant: Stance =
      (Object.entries(byStance).sort(
        (a, b) => b[1].count - a[1].count,
      )[0]?.[0] as Stance) ?? 'abstain';
    return {
      agents,
      total: agents.length,
      byStance,
      dominant,
      avgConf: agents.length ? Math.round(sumConf / agents.length) : 0,
    };
  }, [run, profession]);

  return (
    <aside className="inspector">
      <div className="inspector-header">
        <div>
          <div
            className="agent-tag"
            style={{ borderLeft: `3px solid ${PROFESSION_PALETTE[profession]}` }}
          >
            <div className="agent-id">{profession} group</div>
            <div className="muted small">
              {stats.total} agents · group justification
            </div>
          </div>
        </div>
        <button className="ghost-btn" onClick={onClose}>
          close
        </button>
      </div>

      <div className="inspector-vote">
        <div>
          <div className="panel-label">dominant stance</div>
          <div className={`big-num ${STANCE_CLASS[stats.dominant]}`}>
            {stats.dominant}
          </div>
        </div>
        <div>
          <div className="panel-label">avg confidence</div>
          <div className="big-num num">{stats.avgConf}</div>
        </div>
        <div>
          <div className="panel-label">distribution</div>
          <div className="small group-dist">
            <span className="status-ok">
              support {stats.byStance.support.count}
            </span>
            <span className="muted"> · </span>
            <span className="status-err">
              oppose {stats.byStance.oppose.count}
            </span>
            <span className="muted"> · </span>
            <span>abstain {stats.byStance.abstain.count}</span>
          </div>
        </div>
      </div>

      <div className="inspector-body">
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
              {stats.agents
                .slice()
                .sort((a, b) => b.finalConfidence - a.finalConfidence)
                .map((r) => (
                  <tr key={r.agent.id}>
                    <td className="muted small">
                      {r.agent.mbti}/{r.agent.gender}
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
        {runId && (
          <JustificationPanel
            runId={runId}
            target={{ kind: 'group', profession }}
            legalJurisdiction={legalJurisdiction}
          />
        )}
      </div>
    </aside>
  );
}
