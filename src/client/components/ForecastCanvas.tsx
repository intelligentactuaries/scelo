// ForecastCanvas — the headline artifact of a run.
//
// A run produces a Nanoeconomics forecast: "will this community decline /
// stabilize / grow / collapse?". This canvas centers that forecast at full
// size, then docks the swarm's reaction beneath: how many agents trust the
// forecast, which WMTR parameter the council says is mis-calibrated, and
// which consensus intervention would shift the trajectory. The
// council / society / synthesis tabs become drill-downs from here.

import { useMemo } from 'react';
import type { Run, InterventionCluster, RunWmtr } from '../../shared/types';
import { OUTCOME_COLOR, type Outcome } from '../../shared/wmtr';
import { colorsForTheme } from '../../shared/constants';
import { useTheme } from '../lib/theme';
import { voiceFor } from '../lib/forecastVoice';
import {
  InterventionRow,
  WmtrChart,
  OUTCOME_BY_LABEL,
  componentsOption,
  driverBridgeOption,
  outcomeGaugeOption,
  outcomeMixMatchesBars,
  outcomeMixOption,
} from './WmtrStrip';

interface Props {
  run: Run;
  /** Switch to a non-forecast tab so the user can drill into the swarm
   *  reaction. Wired in App.tsx. */
  onShowCouncil?: () => void;
  onShowSociety?: () => void;
  onShowSynthesis?: () => void;
  /** Fires when the user clicks an outcome bucket to filter the council
   *  view to agents whose vote diverges from that outcome. Phase 2 wiring;
   *  the prop is accepted now so the click handler can stub. */
  onFilterByOutcome?: (o: Outcome) => void;
  /** Click-to-spawn intervention re-simulation. `wmtr` carries the freshly
   *  re-simulated forecast when the server re-ran the simulator inline
   *  (recouncil:false → runId is null); the parent swaps it into `run.wmtr`. */
  onInterveneStarted?: (newRunId: string | null, wmtr?: RunWmtr) => void;
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

/**
 * Plain-language answer to "why THIS outcome?", shown on hover over the
 * verdict.
 *
 * Written for the person the forecast is *for*, not the person who built it.
 * The label alone is a bare assertion — a reader can't tell whether
 * STABILIZED means "comfortably flat" or "edged out DECLINED by two runs" —
 * and the modelling vocabulary that used to explain it (paths, W against W₀,
 * thresholds, the driver as a bare letter) answers a question nobody asked.
 * So: what the verdict means for this scenario, how it was arrived at, how
 * close it was, and what moved it — in the scenario's own terms, with the
 * numbers kept and the jargon dropped.
 */
function explainOutcome(run: Run): string {
  const wmtr = run.wmtr;
  if (!wmtr) return '';
  const cfg = wmtr.config;
  const res = wmtr.result;
  const dom = wmtr.dominantOutcome;
  const th = cfg.thresholds;
  const v = voiceFor(run.scenario);

  const last = res.years.length - 1;
  const ratio = res.w0 > 0 ? (res.meanW[last] ?? 0) / res.w0 : 0;
  const endDelta = Math.round(Math.abs(ratio - 1) * 100);
  const endWord = ratio >= 1 ? 'above' : 'below';
  const growth = Math.round(th.growth * 100);
  const stability = Math.round(th.stability * 100);
  const collapse = Math.round(th.collapse * 100);

  const share = res.outcomeFractions[dom] ?? 0;
  const count = Math.round(share * cfg.nPaths);

  // What the verdict means, said as an outcome rather than as a rule.
  const MEANING: Record<Outcome, string> = {
    grew: `${v.subject} ends up clearly better than it started — more than ${growth}% ahead after ${cfg.horizon} years.`,
    stabilized: `${v.subject} ends up roughly where it started after ${cfg.horizon} years: not more than ${stability}% down, and not the ${growth}%-plus gain we'd call real growth.`,
    declined: `${v.subject} ends up worse than it started — more than ${stability}% down after ${cfg.horizon} years.`,
    collapsed: `${v.subject} falls below ${collapse}% of where it started and stays there for ${th.recovery} years or more — it doesn't recover.`,
  };

  const PLAIN: Record<Outcome, string> = {
    grew: 'clearly better off',
    stabilized: 'about where they started',
    declined: 'worse off',
    collapsed: 'in collapse',
  };

  const ranked = (Object.entries(res.outcomeFractions) as [Outcome, number][]).sort(
    (a, b) => b[1] - a[1],
  );
  const runner = ranked[1];
  const gap = runner ? (share - runner[1]) * 100 : 100;
  // A plurality this thin is inside the sampling noise of nPaths draws.
  // Saying "it could flip" is the honest version of that, and it is the one
  // sentence here a reader most needs in order not to over-trust the label.
  const closeness =
    runner && runner[1] > 0 && gap <= 10
      ? `It was close, though. ${pct(runner[1])} of the runs ended ${PLAIN[runner[0]]} instead — near enough that a different roll of the dice could change the headline. Treat it as "could go either way", not a firm call.`
      : runner && runner[1] > 0
        ? `The next most common ending was ${PLAIN[runner[0]]}, in ${pct(runner[1])} of runs.`
        : 'No other ending occurred in any run.';

  const DRIVER: Record<'M' | 'T' | 'R', string> = { M: v.M, T: v.T, R: v.R };
  const others = (['M', 'T', 'R'] as const).filter((k) => k !== wmtr.driver);

  return [
    `What this means — ${MEANING[dom]}`,
    `How we got it — we played the scenario out ${cfg.nPaths} times over ${cfg.horizon} years, letting ${v.setbacks} land at random (set to "${cfg.shock}"). ${count} of those ${cfg.nPaths} runs (${pct(share)}) ended that way, more than any other result. That is what "most likely" means here — the commonest ending, not a certainty.`,
    closeness,
    // The three capital labels are themselves phrases containing "and", so
    // "ahead of X and Y" produces a two-"and" pile-up. Split the comparison
    // into its own sentence and join the pair with "or".
    `What moved it most — ${DRIVER[wmtr.driver]}. That counted for more than ${DRIVER[others[0]]}, or ${DRIVER[others[1]]}. Averaged over every run, ${v.subject} finished about ${endDelta}% ${endWord} where it began.`,
  ].join('\n\n');
}

export function ForecastCanvas({
  run,
  onShowCouncil,
  onShowSociety,
  onShowSynthesis,
  onFilterByOutcome,
  onInterveneStarted,
}: Props) {
  const wmtr = run.wmtr;
  const { resolved } = useTheme();
  const colors = colorsForTheme(resolved);

  if (!wmtr) {
    return (
      <div className="forecast-canvas forecast-canvas--empty">
        <div className="forecast-empty">
          <div className="forecast-empty-eyebrow">forecast</div>
          <div className="forecast-empty-line">no WMTR forecast on this run.</div>
        </div>
      </div>
    );
  }

  const cfg = wmtr.config;
  const res = wmtr.result;
  const dom = wmtr.dominantOutcome;
  const buckets = res.outcomeFractions;
  const last = res.years.length - 1;
  const finalW = res.meanW[last] ?? 0;
  const finalSurv = res.meanSurv[last] ?? 0;
  const ratio = res.w0 > 0 ? finalW / res.w0 : 0;
  const clusters = run.summary?.interventionClusters ?? [];

  return (
    <div className="forecast-canvas">
      {/* ─── Verdict header ────────────────────────────────────────────── */}
      <header className="forecast-verdict">
        <div className="forecast-eyebrow">
          <span className="forecast-eyebrow-dot" /> W(M, T, R) · nanoeconomics forecast
        </div>
        <div className="forecast-headline">
          <span className="forecast-headline-lead">Most likely outcome:</span>
          <span
            className="forecast-headline-verdict"
            style={{ color: OUTCOME_COLOR[dom], borderColor: OUTCOME_COLOR[dom] }}
            data-tooltip={explainOutcome(run)}
            // Focusable so the explanation is reachable by keyboard, not just
            // by hovering a mouse over it.
            tabIndex={0}
            role="note"
            aria-label={`${dom} — ${explainOutcome(run).replace(/\n+/g, ' ')}`}
          >
            {dom.toUpperCase()}
          </span>
          <span className="forecast-headline-share">
            {pct(buckets[dom])} of {cfg.nPaths} paths
          </span>
        </div>
        <div className="forecast-headline-meta">
          horizon {cfg.horizon} y · shock {cfg.shock} · driver {wmtr.driver} ·
          final W/W₀ {ratio >= 1 ? '+' : ''}{((ratio - 1) * 100).toFixed(0)}% ·
          final survival {pct(finalSurv)}
        </div>
      </header>

      {/* ─── Big chart grid (the headline artifact) ──────────────────────
          Two co-primary plots on the top row: the wealth trajectory and the
          W(M,T,R) decomposition that explains it — the trajectory says what
          happened, the components say which of money / time / relationships
          drove it. The outcome split — where the paths landed, then how they
          got there — is the supporting row. DOM order is the layout order, so
          the primaries also come first when the grid collapses to one column
          on narrow screens. */}
      <div className="forecast-grid">
        <ForecastPanel
          title="What moved W · money, time and relationships"
          className="forecast-panel--primary"
        >
          <WmtrChart options={driverBridgeOption(wmtr, colors)} height={300} />
        </ForecastPanel>
        <ForecastPanel
          title="W(M,T,R) components · mean across paths"
          className="forecast-panel--primary"
        >
          <WmtrChart
            options={componentsOption(wmtr, colors, { compact: false })}
            height={300}
          />
        </ForecastPanel>
        {/* Paired with the mix chart beside it: where the paths landed at the
            end of the horizon, then how they got there. */}
        <ForecastPanel
          title="Outcome distribution · click to drill into divergent agents"
          onClickHeader={onFilterByOutcome ? () => onFilterByOutcome(dom) : undefined}
        >
          {/* The rings carry the same drill-down the bar rows did: clicking
              one filters the council to agents whose vote diverges from that
              bucket. */}
          <WmtrChart
            options={outcomeGaugeOption(wmtr, colors)}
            height={280}
            onSelect={(name) => {
              const o = OUTCOME_BY_LABEL[name];
              if (!o) return;
              onFilterByOutcome?.(o);
              onShowCouncil?.();
            }}
          />
        </ForecastPanel>
        <ForecastPanel
          title={
            outcomeMixMatchesBars(res)
              ? 'Outcome mix over time · where the paths stood at each year'
              : 'Outcome mix over time · re-derived under the current rule, which this older run pre-dates'
          }
        >
          {/* Matches the gauge beside it so the row has no dead strip under
              the shorter panel. */}
          <WmtrChart options={outcomeMixOption(wmtr, colors)} height={280} />
        </ForecastPanel>
      </div>

      {/* ─── Council readback — how the swarm reacts to the forecast ───── */}
      <CouncilReadback
        run={run}
        onShowCouncil={onShowCouncil}
        onShowSociety={onShowSociety}
        onShowSynthesis={onShowSynthesis}
      />

      {/* ─── Intervention loop (forecast-aware) ────────────────────────── */}
      {clusters.length > 0 ? (
        <InterventionRow
          clusters={clusters}
          runId={run.id}
          scenario={run.scenario}
          onInterveneStarted={onInterveneStarted}
        />
      ) : run.councilResults.length > 0 ? (
        <div className="forecast-intervene-empty">
          council emitted no parameter interventions on this forecast.
        </div>
      ) : null}
    </div>
  );
}

// ─── Panel chrome ────────────────────────────────────────────────────────

function ForecastPanel({
  title,
  children,
  className,
  onClickHeader,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
  onClickHeader?: () => void;
}) {
  return (
    <section className={`forecast-panel ${className ?? ''}`}>
      <header
        className={`forecast-panel-head ${onClickHeader ? 'forecast-panel-head--clickable' : ''}`}
        onClick={onClickHeader}
        role={onClickHeader ? 'button' : undefined}
        tabIndex={onClickHeader ? 0 : undefined}
      >
        {title}
      </header>
      <div className="forecast-panel-body">{children}</div>
    </section>
  );
}

// ─── Council readback ────────────────────────────────────────────────────

function CouncilReadback({
  run,
  onShowCouncil,
  onShowSociety,
  onShowSynthesis,
}: {
  run: Run;
  onShowCouncil?: () => void;
  onShowSociety?: () => void;
  onShowSynthesis?: () => void;
}) {
  const total = run.councilResults.length;

  // Stance interpretation in the forecast frame:
  //   support → trust the forecast
  //   oppose  → distrust the forecast
  //   abstain → uncertain
  const trustPct = useMemo(() => {
    if (!total) return null;
    const trust = run.councilResults.filter((r) => r.finalStance === 'support').length;
    return Math.round((trust / total) * 100);
  }, [run.councilResults, total]);

  const distrustPct = useMemo(() => {
    if (!total) return null;
    const distrust = run.councilResults.filter((r) => r.finalStance === 'oppose').length;
    return Math.round((distrust / total) * 100);
  }, [run.councilResults, total]);

  const topCluster: InterventionCluster | null =
    run.summary?.interventionClusters?.[0] ?? null;

  // Society sentiment, if loaded.
  const societyTotal = run.societyResults.length;
  const societyPositive = useMemo(() => {
    if (!societyTotal) return null;
    const positive = run.societyResults.filter(
      (r) => r.sentiment === 'enthusiastic' || r.sentiment === 'supportive',
    ).length;
    return Math.round((positive / societyTotal) * 100);
  }, [run.societyResults, societyTotal]);

  if (!total) {
    return (
      <section className="forecast-readback forecast-readback--pending">
        <span className="forecast-readback-eyebrow">
          <span className="forecast-eyebrow-dot" /> council readback
        </span>
        <span className="forecast-readback-pending">
          council pending… swarm will react to this forecast once round 3 lands.
        </span>
      </section>
    );
  }

  return (
    <section className="forecast-readback">
      <div className="forecast-readback-eyebrow">
        <span className="forecast-eyebrow-dot" /> council readback on this forecast
      </div>

      <div className="forecast-readback-row">
        <ReadbackStat
          big={`${trustPct}%`}
          label="trust the forecast"
          sub={`${distrustPct ?? 0}% distrust · ${total} agents`}
          onClick={onShowCouncil}
        />
        <ReadbackStat
          big={topCluster ? `${topCluster.direction === 'increase' ? '↑' : '↓'} ${paramShortLabel(topCluster.param)}` : '—'}
          label="dominant proposed shift"
          sub={topCluster ? `${topCluster.count} agents · ${topCluster.magnitude}` : 'no intervention consensus'}
          accent
          onClick={onShowSynthesis}
        />
        {societyPositive !== null && (
          <ReadbackStat
            big={`${societyPositive}%`}
            label="society broadly accepts"
            sub={`${societyTotal} sampled · enthusiastic + supportive`}
            onClick={onShowSociety}
          />
        )}
      </div>

      {topCluster?.exemplarRationale && (
        <blockquote className="forecast-readback-quote">
          “{topCluster.exemplarRationale}”
        </blockquote>
      )}
    </section>
  );
}

function ReadbackStat({
  big,
  label,
  sub,
  accent,
  onClick,
}: {
  big: string;
  label: string;
  sub: string;
  accent?: boolean;
  onClick?: () => void;
}) {
  const interactive = !!onClick;
  return (
    <button
      type="button"
      className={`forecast-readback-stat ${accent ? 'is-accent' : ''} ${interactive ? 'is-interactive' : ''}`}
      onClick={onClick}
      disabled={!interactive}
    >
      <span className="forecast-readback-big">{big}</span>
      <span className="forecast-readback-label">{label}</span>
      <span className="forecast-readback-sub">{sub}</span>
    </button>
  );
}

function paramShortLabel(p: string): string {
  switch (p) {
    case 'alphaM':
      return 'αM';
    case 'alphaT':
      return 'αT';
    case 'alphaR':
      return 'αR';
    case 'pProduction':
      return 'p·prod';
    case 'pFamily':
      return 'p·family';
    case 'pReligion':
      return 'p·rel';
    case 'pSpatial':
      return 'p·spatial';
    case 'pLeisure':
      return 'p·leisure';
    case 'initFamily':
      return 'family₀';
    case 'initReligion':
      return 'religion₀';
    default:
      return p;
  }
}

