import type { CouncilAgentResult, RunSummary, Stance } from '../../shared/types';
import { clusterRisks } from '../../shared/risks';
import { colorsForTheme } from '../../shared/constants';
import { useTheme } from '../lib/theme';
import type { TabId } from './ViewTabs';

type Props = {
  scenario: string | null;
  /** ≤12-word LLM tagline. Preferred when available; falls back to the
   *  raw scenario clipped to 12 words while the summary is being generated. */
  scenarioSummary?: string | null;
  /** Run summary used to render the dominant-stance pill next to the
   *  scenario chip. Hovering the pill reveals the full distribution. */
  summary?: RunSummary | null;
  /** Per-agent votes, used to explain the dominant stance from the votes
   *  that produced it. */
  councilResults?: CouncilAgentResult[];
  tab: TabId;
  /** Reveal the refine bar prefilled with this run's scenario. Omitted on
   *  surfaces where there is nothing to edit. */
  onEditScenario?: () => void;
  /** Clear the run and return to the empty composer. */
  onNewScenario?: () => void;
  /** Both actions are suppressed mid-run — a run in flight is about to
   *  replace whatever they would edit. */
  busy?: boolean;
};

const GREETING = 'Welcome — what community shall we forecast?';

// Empty: greeting in the accent colour (still attention-grabbing).
// Run state: charcoal tagline in a pill-bordered chip, smaller — reads as
//   "metadata about this view" rather than a screaming headline.
// Canon: always "IAAI Canon" in the accent colour.
export function CenterHeading({
  scenario,
  scenarioSummary,
  summary,
  councilResults,
  tab,
  onEditScenario,
  onNewScenario,
  busy,
}: Props) {
  if (tab === 'canon') {
    return (
      <div className="center-heading-wrap">
        <h1 className="center-heading">IAAI Canon</h1>
      </div>
    );
  }
  if (!scenario) {
    return (
      <div className="center-heading-wrap">
        <h1 className="center-heading">{GREETING}</h1>
      </div>
    );
  }
  const text = scenarioSummary?.trim() || clipToWords(scenario, 12);
  return (
    <div className="center-heading-wrap">
      <div className="scenario-heading-row">
        <div
          className="scenario-summary-chip"
          aria-label={`Scenario: ${scenario}`}
          // Styled hover bubble below the chip. The native browser `title`
          // tooltip is intentionally NOT set here — it would double up with
          // the styled one. The aria-label above still gives screen readers
          // the full scenario.
          data-tooltip={scenario}
        >
          {text}
        </div>
        {summary && (
          <StanceDominantPill summary={summary} councilResults={councilResults} />
        )}
        {/* The scenario is otherwise read-only once a run exists: the composer
            that created it is only rendered in the empty state, so there was
            no way back to the text without reloading the page. */}
        {(onEditScenario || onNewScenario) && (
          <div className="scenario-heading-actions">
            {onEditScenario && (
              <button
                type="button"
                className="ghost-btn"
                onClick={onEditScenario}
                disabled={busy}
                title="edit this scenario and re-forecast"
              >
                edit scenario
              </button>
            )}
            {onNewScenario && (
              <button
                type="button"
                className="ghost-btn"
                onClick={onNewScenario}
                disabled={busy}
                title="clear this run and start from a blank scenario"
              >
                new scenario
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Why the council landed where it did, read off the votes that produced the
 * verdict rather than asserted over them.
 *
 * Deliberately not model-generated: this is a hover, so it has to be there the
 * instant the pointer arrives, and a summary invented after the fact could
 * name reasons no agent actually gave. Everything below is counted from the
 * agents whose vote IS the dominant stance — their own stated risks, their
 * own confidence, their own professions.
 */
/**
 * An agent's key risk runs to 120 characters and often ends in its own
 * punctuation. Two of them quoted whole turn a hover into a paragraph, and
 * the sentence that frames them then reads "…simultaneously..". Clip to a
 * readable phrase and drop the trailing mark so the caller owns the period.
 */
function clipRisk(risk: string, max = 72): string {
  const t = (risk || '').trim().replace(/[.;,\s]+$/u, '');
  if (t.length <= max) return t;
  // Break on a word boundary rather than mid-word.
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[.;,\s]+$/u, '')}…`;
}

function explainStance(
  results: CouncilAgentResult[],
  stance: Stance,
): { headline: string; risks: { risk: string; count: number }[]; whom: string | null } | null {
  if (!results.length) return null;
  const group = results.filter((r) => r.finalStance === stance);
  if (!group.length) return null;

  const meanConf = Math.round(
    group.reduce((s, r) => s + (r.finalConfidence ?? 0), 0) / group.length,
  );

  // Same clustering the server used for summary.topRisks, but over this
  // stance only — the question is why THESE agents voted this way.
  const risks = clusterRisks(group.map((r) => r.keyRisk))
    .slice(0, 2)
    .map((c) => ({ risk: clipRisk(c.risk), count: c.count }));

  // Professions carrying the stance, but only when they actually concentrate
  // it — naming two seats out of twenty would imply a pattern that isn't there.
  const byProf = new Map<string, number>();
  for (const r of group) byProf.set(r.agent.profession, (byProf.get(r.agent.profession) ?? 0) + 1);
  const leaders = [...byProf.entries()]
    .sort((a, b) => b[1] - a[1])
    .filter(([, n]) => n >= 2 && n / group.length >= 0.2)
    .slice(0, 2)
    .map(([p]) => p);

  return {
    headline: `${group.length} of ${results.length} agents, at ${meanConf}% mean confidence.`,
    risks,
    whom: leaders.length ? leaders.join(' and ') : null,
  };
}

function StanceDominantPill({
  summary,
  councilResults,
}: {
  summary: RunSummary;
  councilResults?: CouncilAgentResult[];
}) {
  // In this run the council votes on the FORECAST, not on a proposition.
  // We reuse the existing stance vocabulary but re-label for that frame:
  //   support → trust   |   oppose → distrust   |   abstain → uncertain.
  const { resolved } = useTheme();
  const colors = colorsForTheme(resolved);
  const entries = [
    { key: 'support', label: 'Trust', pct: summary.supportPct, color: colors.consensus },
    { key: 'oppose', label: 'Distrust', pct: summary.opposePct, color: colors.adversarial },
    { key: 'abstain', label: 'Uncertain', pct: summary.abstainPct, color: colors.muted },
  ] as const;
  // The pill relabels stances for the forecast frame; the votes are still
  // stored under the original names.
  const STANCE_OF: Record<(typeof entries)[number]['key'], Stance> = {
    support: 'support',
    oppose: 'oppose',
    abstain: 'abstain',
  };
  const dominant = entries.reduce((a, b) => (b.pct > a.pct ? b : a));
  const why = explainStance(councilResults ?? [], STANCE_OF[dominant.key]);
  // Wording follows the stance being explained: `explainStance` is already
  // scoped to one side of the vote, and "chief concern" is only true of the
  // side that objects. A supporter's key_risk is what the forecast gets right.
  const affirming = STANCE_OF[dominant.key] === 'support';
  const spoken = why
    ? ` ${why.headline}${
        why.risks.length
          ? ` ${affirming ? 'Chiefly because it captures' : 'Chief concern'}: ${why.risks[0].risk}.`
          : ''
      }`
    : '';
  return (
    <div
      className="stance-dominant-pill"
      tabIndex={0}
      role="img"
      aria-label={`Council readback: ${dominant.label} the forecast at ${dominant.pct}%. Trust ${summary.supportPct}%, distrust ${summary.opposePct}%, uncertain ${summary.abstainPct}%.${spoken}`}
    >
      <span className="stance-dot" style={{ background: dominant.color }} aria-hidden="true" />
      <span className="stance-pill-label">{dominant.label}</span>
      <span className="stance-pill-pct num">{dominant.pct}%</span>
      <div className="stance-popup" role="tooltip">
        <div className="stance-popup-title">council trust in forecast</div>
        <div className="stance-popup-bar">
          {entries.map((e) => (
            <div
              key={e.key}
              className="stance-popup-seg"
              style={{ flex: Math.max(e.pct, 0.0001), background: e.color }}
            />
          ))}
        </div>
        <div className="stance-popup-legend">
          {entries.map((e) => (
            <div key={e.key} className="stance-popup-row">
              <i style={{ background: e.color }} aria-hidden="true" />
              <span className="stance-popup-name">{e.label}</span>
              <span className="num stance-popup-val">{e.pct}%</span>
            </div>
          ))}
        </div>
        {why && (
          <div className="stance-popup-why">
            <div className="stance-popup-title">
              why {dominant.label.toLowerCase()}
            </div>
            <p className="stance-popup-line">{why.headline}</p>
            {why.risks.length > 0 && (
              <>
                <p className="stance-popup-line">
                  {affirming
                    ? why.risks.length > 1
                      ? 'What they say it captures'
                      : 'What they say it captures'
                    : why.risks.length > 1
                      ? 'Risks they cite'
                      : 'The risk they cite'}
                </p>
                {/* One per line: an agent's risk is a clause that often
                    contains its own semicolons, so joining two into a
                    sentence made them impossible to tell apart. */}
                <ul className="stance-popup-risks">
                  {why.risks.map((r) => (
                    <li key={r.risk} className="stance-popup-line">
                      <em>{r.risk}</em>
                      {r.count > 1 && ` (×${r.count})`}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {why.whom && <p className="stance-popup-line">Concentrated in {why.whom}.</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function clipToWords(s: string, n: number): string {
  const words = s.split(/\s+/u).filter(Boolean);
  if (words.length <= n) return words.join(' ');
  return words.slice(0, n).join(' ') + '…';
}
