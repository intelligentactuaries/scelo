import type { RunSummary } from '../../shared/types';
import { COLORS } from '../../shared/constants';
import type { TabId } from './ViewTabs';

type Props = {
  scenario: string | null;
  /** ≤12-word LLM tagline. Preferred when available; falls back to the
   *  raw scenario clipped to 12 words while the summary is being generated. */
  scenarioSummary?: string | null;
  /** Run summary used to render the dominant-stance pill next to the
   *  scenario chip. Hovering the pill reveals the full distribution. */
  summary?: RunSummary | null;
  tab: TabId;
};

const GREETING = 'Welcome — what community shall we forecast?';

// Empty: greeting in the accent colour (still attention-grabbing).
// Run state: charcoal tagline in a pill-bordered chip, smaller — reads as
//   "metadata about this view" rather than a screaming headline.
// Canon: always "IAAI Canon" in the accent colour.
export function CenterHeading({ scenario, scenarioSummary, summary, tab }: Props) {
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
        {summary && <StanceDominantPill summary={summary} />}
      </div>
    </div>
  );
}

function StanceDominantPill({ summary }: { summary: RunSummary }) {
  // In this run the council votes on the FORECAST, not on a proposition.
  // We reuse the existing stance vocabulary but re-label for that frame:
  //   support → trust   |   oppose → distrust   |   abstain → uncertain.
  const entries = [
    { key: 'support', label: 'Trust', pct: summary.supportPct, color: COLORS.consensus },
    { key: 'oppose', label: 'Distrust', pct: summary.opposePct, color: COLORS.adversarial },
    { key: 'abstain', label: 'Uncertain', pct: summary.abstainPct, color: COLORS.muted },
  ] as const;
  const dominant = entries.reduce((a, b) => (b.pct > a.pct ? b : a));
  return (
    <div
      className="stance-dominant-pill"
      tabIndex={0}
      role="img"
      aria-label={`Council readback: ${dominant.label} the forecast at ${dominant.pct}%. Trust ${summary.supportPct}%, distrust ${summary.opposePct}%, uncertain ${summary.abstainPct}%.`}
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
      </div>
    </div>
  );
}

function clipToWords(s: string, n: number): string {
  const words = s.split(/\s+/u).filter(Boolean);
  if (words.length <= n) return words.join(' ');
  return words.slice(0, n).join(' ') + '…';
}
