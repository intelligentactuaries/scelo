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
import {
  InterventionRow,
  WmtrChart,
  componentsOption,
  outcomeOption,
  survivalOption,
  trajectoryOption,
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

      {/* ─── Big chart grid (the headline artifact) ────────────────────── */}
      <div className="forecast-grid">
        <ForecastPanel title="Wealth trajectory · mean ± 25–75 band" className="forecast-panel--wide">
          <WmtrChart options={trajectoryOption(wmtr, colors)} height={300} />
        </ForecastPanel>
        <ForecastPanel title="Survival probability · S(t)">
          <WmtrChart options={survivalOption(wmtr, colors)} height={300} />
        </ForecastPanel>
        <ForecastPanel
          title="Outcome distribution · click to drill into divergent agents"
          onClickHeader={onFilterByOutcome ? () => onFilterByOutcome(dom) : undefined}
        >
          <ClickableOutcomes
            buckets={buckets}
            onClick={(o) => {
              onFilterByOutcome?.(o);
              onShowCouncil?.();
            }}
          />
        </ForecastPanel>
        <ForecastPanel title="Components · M / T / R (mean across paths)">
          <WmtrChart options={componentsOption(wmtr, colors)} height={220} />
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

// ─── Outcome bars (custom, clickable, replaces the ECharts version so we
//     get a real DOM click target with affordance) ─────────────────────────

const OUTCOMES_ORDER: Outcome[] = ['grew', 'stabilized', 'declined', 'collapsed'];
const OUTCOME_LABEL: Record<Outcome, string> = {
  grew: 'Grew',
  stabilized: 'Stabilized',
  declined: 'Declined',
  collapsed: 'Collapsed',
};

function ClickableOutcomes({
  buckets,
  onClick,
}: {
  buckets: Record<Outcome, number>;
  onClick: (o: Outcome) => void;
}) {
  const maxV = Math.max(...OUTCOMES_ORDER.map((o) => buckets[o]), 0.01);
  return (
    <div className="forecast-outcomes">
      {OUTCOMES_ORDER.map((o) => {
        const v = buckets[o];
        const w = (v / maxV) * 100;
        return (
          <button
            key={o}
            type="button"
            className="forecast-outcome-row"
            onClick={() => onClick(o)}
            title={`drill into council agents whose vote diverges from "${OUTCOME_LABEL[o]}"`}
          >
            <span className="forecast-outcome-label">{OUTCOME_LABEL[o]}</span>
            <span className="forecast-outcome-track">
              <span
                className="forecast-outcome-fill"
                style={{ width: `${w}%`, background: OUTCOME_COLOR[o] }}
              />
            </span>
            <span className="forecast-outcome-pct">{pct(v)}</span>
          </button>
        );
      })}
    </div>
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

