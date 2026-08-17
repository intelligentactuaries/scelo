import { explainSynthesisByProfession, explainSynthesisTrust } from '../lib/plotExplainers';
import type { Run } from '../../shared/types';
import { colorsForTheme, PROFESSIONS, type Profession } from '../../shared/constants';
import { useTheme } from '../lib/theme';
import { HalfDonut } from './HalfDonut';

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

  // Older runs were summarised before these counts existed; fall back to the
  // shown slice so a rehydrated run reports no phantom hidden clusters.
  const clusterCount = s.riskClusterCount ?? s.topRisks.length;
  const hiddenRiskClusters = Math.max(0, clusterCount - s.topRisks.length);
  const captureHidden = Math.max(
    0,
    (s.captureClusterCount ?? (s.topCaptures ?? []).length) - (s.topCaptures ?? []).length,
  );

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
        <div
          className="panel-label explained-title"
          data-tooltip={explainSynthesisTrust(run)}
          tabIndex={0}
          role="note"
        >
          trust in the forecast
        </div>
        <HalfDonut
          name="trust in the forecast"
          data={[
            { name: 'trust', value: s.supportPct, color: colors.consensus },
            { name: 'distrust', value: s.opposePct, color: colors.adversarial },
            { name: 'uncertain', value: s.abstainPct, color: colors.muted },
          ]}
        />
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
        <div
          className="panel-label explained-title"
          data-tooltip={explainSynthesisByProfession(run)}
          tabIndex={0}
          role="note"
        >
          trust by profession
        </div>
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
        {/* Two lists, never one. `keyRisk` means opposite things on either
            side of the vote — what the forecast MISSES if you distrust it,
            what it GETS RIGHT if you trust it — and the old single list
            headed "misses (or captures)" merged both. Since the two groups
            draw on the same vocabulary, a supporter's endorsement clustered
            straight into an opposer's objection, which is what made trusting
            and distrusting agents look like they reasoned identically. */}
        <div className="panel-label">what the forecast misses · from the agents who distrust it</div>
        <div className="syn-risks">
          {s.topRisks.length === 0 && <div className="muted small">no objections reported</div>}
          {s.topRisks.map((r, i) => (
            <div key={i} className="syn-risk">
              <span className="num count-pill">{r.count}</span>
              <span>{r.risk}</span>
            </div>
          ))}
          {/* The list is a top-N slice. Saying so is the difference between
              "these are the council's concerns" and "these are the eight
              most-cited of nineteen" — the dissenters list below has always
              had this affordance and the risks list never did. */}
          {hiddenRiskClusters > 0 && (
            <div className="muted small" style={{ padding: '4px 2px' }}>
              … {hiddenRiskClusters} more cluster{hiddenRiskClusters === 1 ? '' : 's'} — the{' '}
              {s.topRisks.length} shown account for {s.riskAgentsShown} of {s.riskAgentsTotal}{' '}
              agents who stated a risk. Drill in via the council tab.
            </div>
          )}
        </div>
      </section>

      <section className="syn-section">
        <div className="panel-label">what it gets right · from the agents who trust it</div>
        <div className="syn-risks">
          {(s.topCaptures ?? []).length === 0 && (
            <div className="muted small">
              {s.supportPct > 0
                ? 'the supporting agents stated objections rather than endorsements — see the note below'
                : 'no agent trusted the forecast'}
            </div>
          )}
          {(s.topCaptures ?? []).map((r, i) => (
            <div key={i} className="syn-risk">
              <span className="num count-pill">{r.count}</span>
              <span>{r.risk}</span>
            </div>
          ))}
          {captureHidden > 0 && (
            <div className="muted small" style={{ padding: '4px 2px' }}>
              … {captureHidden} more cluster{captureHidden === 1 ? '' : 's'} — the{' '}
              {(s.topCaptures ?? []).length} shown account for {s.captureAgentsShown ?? 0} of{' '}
              {s.captureAgentsTotal ?? 0} supporting agents.
            </div>
          )}
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
                <span className="dissent-risk" title={r.keyRisk}>
                  {r.keyRisk}
                </span>
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
