// ForecastCanvas — the headline artifact of a run.
//
// A run produces a Nanoeconomics forecast: "will this community decline /
// stabilize / grow / collapse?". This canvas centers that forecast at full
// size, then docks the swarm's reaction beneath: how many agents trust the
// forecast, which WMTR parameter the council says is mis-calibrated, and
// which consensus intervention would shift the trajectory. The
// council / society / synthesis tabs become drill-downs from here.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Run, InterventionCluster, RunWmtr } from '../../shared/types';
import { OUTCOME_COLOR, type Outcome } from '../../shared/wmtr';
import { colorsForTheme } from '../../shared/constants';
import { useTheme } from '../lib/theme';
import { PauseIcon, PlayIcon, StopIcon } from './Icons';
import { voiceFor } from '../lib/forecastVoice';
import {
  InterventionRow,
  MIX_ORDER,
  WmtrChart,
  OUTCOME_BY_LABEL,
  componentsOption,
  driverBridgeOption,
  driverContributions,
  outcomeGaugeOption,
  outcomeMixByYear,
  outcomeMixMatchesBars,
  outcomeLabel,
  type OutcomeAspect,
  outcomeMixOption,
} from './WmtrStrip';
import {
  explainComponents,
  explainDriverBridge,
  explainOutcomeGauge,
  explainOutcomeMix,
} from '../lib/panelInsight';

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
  // Declared above the early return — a hook cannot sit behind a condition.
  // `null` is the resting state: the whole run, exactly as before playback
  // existed. A number is a year cursor the panels render as of.
  const [cursor, setCursor] = useState<number | null>(null);
  // Lifted out of <Playback> because the verdict language keys off it: a run
  // in flight is "Growing", the same run paused is "Grew".
  const [playing, setPlaying] = useState(false);
  const aspect: OutcomeAspect = playing ? 'progressive' : 'settled';
  const asOf = { aspect, ...(cursor === null ? {} : { upTo: cursor }) };
  // O(years × paths); the header re-reads it on every playback tick, so it is
  // derived once per run rather than once per frame. Computed above the early
  // return because a hook cannot sit behind a condition.
  const mixByYear = useMemo(
    () => (run.wmtr ? outcomeMixByYear(run.wmtr.result) : null),
    [run.wmtr],
  );

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
  const last = res.years.length - 1;
  const clusters = run.summary?.interventionClusters ?? [];

  // ── The verdict, as of the cursor ────────────────────────────────────────
  //
  // A forecast is a conclusion about a horizon, so it has to be read against
  // the horizon actually on screen. With the panels scrubbing and the headline
  // frozen on year 30, pausing at year 8 put "STABILIZED · 56% of 200 paths"
  // above four charts showing something else — the one number a reader trusts
  // most, describing a year they are not looking at.
  //
  // Uncursored (the resting state) everything below falls back to the run's
  // own stored fields, so the default render is byte-for-byte what it was.
  const atYear = cursor ?? last;
  const scrubbing = cursor !== null;

  const buckets: Record<Outcome, number> =
    scrubbing && mixByYear
      ? (Object.fromEntries(
          MIX_ORDER.map((o) => [o, mixByYear[o][atYear] ?? 0]),
        ) as Record<Outcome, number>)
      : res.outcomeFractions;

  // Ties keep MIX_ORDER's canonical best→worst precedence rather than
  // flickering between two equal buckets on consecutive frames.
  const domAt: Outcome = scrubbing
    ? MIX_ORDER.reduce((best, o) => (buckets[o] > buckets[best] ? o : best), MIX_ORDER[0])
    : dom;

  const wAt = res.meanW[atYear] ?? 0;
  const survAt = res.meanSurv[atYear] ?? 0;
  const ratio = res.w0 > 0 ? wAt / res.w0 : 0;

  const driverAt = scrubbing
    ? (() => {
        const c = driverContributions(res, atYear);
        return (['M', 'T', 'R'] as const).reduce((b, k) =>
          Math.abs(c[k]) > Math.abs(c[b]) ? k : b,
        );
      })()
    : wmtr.driver;

  return (
    <div className="forecast-canvas">
      {/* ─── Verdict header ────────────────────────────────────────────── */}
      <header className="forecast-verdict">
        <div className="forecast-eyebrow">
          <span className="forecast-eyebrow-dot" /> W(M, T, R) · nanoeconomics forecast
        </div>
        <div className="forecast-headline">
          <span className="forecast-headline-lead">
            {scrubbing ? `Through year ${atYear}:` : 'Most likely outcome:'}
          </span>
          <span
            className="forecast-headline-verdict"
            style={{ color: OUTCOME_COLOR[domAt], borderColor: OUTCOME_COLOR[domAt] }}
            data-tooltip={explainOutcome(run)}
            // Focusable so the explanation is reachable by keyboard, not just
            // by hovering a mouse over it.
            tabIndex={0}
            role="note"
            aria-label={`${outcomeLabel(domAt, aspect)} — ${explainOutcome(run).replace(/\n+/g, ' ')}`}
          >
            {outcomeLabel(domAt, aspect).toUpperCase()}
          </span>
          <span className="forecast-headline-share">
            {pct(buckets[domAt])} of {cfg.nPaths} paths
          </span>
        </div>
        <div className="forecast-headline-meta">
          horizon {cfg.horizon} y · shock {cfg.shock} · driver {driverAt} ·
          {scrubbing ? ` W/W₀ at yr ${atYear} ` : ' final W/W₀ '}
          {ratio >= 1 ? '+' : ''}{((ratio - 1) * 100).toFixed(0)}% ·
          {scrubbing ? ' survival ' : ' final survival '}
          {pct(survAt)}
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
      <Playback
        years={res.years.length}
        cursor={cursor}
        onCursor={setCursor}
        playing={playing}
        onPlaying={setPlaying}
        autoKey={run.id}
      />

      <div className="forecast-grid">
        <ForecastPanel
          title="What moved W · money, time and relationships"
          className="forecast-panel--primary"
          insight={explainDriverBridge(wmtr, run.scenario)}
        >
          <WmtrChart options={driverBridgeOption(wmtr, colors, asOf)} height={300} />
        </ForecastPanel>
        <ForecastPanel
          title="W(M,T,R) components · mean across paths"
          className="forecast-panel--primary"
          insight={explainComponents(wmtr, run.scenario)}
        >
          <WmtrChart
            options={componentsOption(wmtr, colors, { compact: false, ...asOf })}
            height={300}
          />
        </ForecastPanel>
        {/* Paired with the mix chart beside it: where the paths landed at the
            end of the horizon, then how they got there. */}
        <ForecastPanel
          title="Outcome distribution · click to drill into divergent agents"
          onClickHeader={onFilterByOutcome ? () => onFilterByOutcome(dom) : undefined}
          insight={explainOutcomeGauge(wmtr, run.scenario)}
        >
          {/* The rings carry the same drill-down the bar rows did: clicking
              one filters the council to agents whose vote diverges from that
              bucket. */}
          <WmtrChart
            options={outcomeGaugeOption(wmtr, colors, asOf)}
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
          insight={explainOutcomeMix(wmtr, run.scenario)}
        >
          {/* Matches the gauge beside it so the row has no dead strip under
              the shorter panel. */}
          <WmtrChart options={outcomeMixOption(wmtr, colors, asOf)} height={280} />
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
  /** What this plot says about THIS run, revealed on hovering the title. */
  insight,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
  onClickHeader?: () => void;
  insight?: string;
}) {
  return (
    <section className={`forecast-panel ${className ?? ''}`}>
      <header
        className={`forecast-panel-head ${onClickHeader ? 'forecast-panel-head--clickable' : ''} ${
          insight ? 'forecast-panel-head--explained' : ''
        }`}
        onClick={onClickHeader}
        role={onClickHeader ? 'button' : undefined}
        // Focusable when it carries an explanation, so the reading is
        // reachable by keyboard and not only by hovering a mouse.
        tabIndex={onClickHeader || insight ? 0 : undefined}
        data-tooltip={insight}
        aria-label={insight ? `${title}. ${insight}` : undefined}
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

/**
 * Year scrubber for the four forecast panels.
 *
 * Every panel here is a view of a 60-year Monte Carlo that only ever showed
 * its final frame — the bridge decomposed the whole run, the gauge carried the
 * terminal verdict, the two time charts drew every year at once. The shapes
 * are the interesting part: WHEN the green band overtakes the blue, when the
 * first path collapses, when relationships overtake money as the driver. A
 * cursor makes that visible without changing what any panel means, because
 * each one already computes from a horizon — it was simply always handed the
 * last index.
 *
 * `null` cursor is the resting state (the whole run), so a viewer who never
 * touches the control sees exactly what they saw before.
 */
function Playback({
  years,
  cursor,
  onCursor,
  playing,
  onPlaying,
  autoKey,
}: {
  years: number;
  cursor: number | null;
  onCursor: (c: number | null) => void;
  /** Owned by the canvas — the verdict's tense reads from the same flag. */
  playing: boolean;
  onPlaying: (p: boolean) => void;
  /** Changes when a different forecast loads, which re-arms the autoplay. */
  autoKey: string;
}) {
  const last = Math.max(0, years - 1);
  const setPlaying = onPlaying;
  // Held in a ref so the interval effect can depend on `playing` alone; taking
  // `cursor` as a dependency would tear down and rebuild the timer on every
  // tick, which drifts the cadence.
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  useEffect(() => {
    if (!playing || last <= 0) return;
    const id = setInterval(() => {
      const at = cursorRef.current ?? 0;
      if (at >= last) {
        // Finish by RELEASING the cursor rather than parking it on the last
        // index. The two look identical on three panels, but the gauge reads
        // the run's stored `outcomeFractions` when uncursored and re-derives
        // the mix when cursored — and for runs predating the `classify` fix
        // those legitimately disagree. Releasing guarantees the state you are
        // left looking at is the same one the panel shows when nobody has
        // touched the control. No loop: the end state is the forecast, and a
        // silent restart reads as a glitch.
        setPlaying(false);
        onCursor(null);
        return;
      }
      onCursor(at + 1);
    }, 140);
    return () => clearInterval(id);
  }, [playing, last, onCursor]);

  // Autoplay once per forecast. A ref rather than state so it cannot re-fire
  // on an unrelated re-render, and keyed on the run so loading a different
  // forecast plays that one too.
  //
  // Skipped under prefers-reduced-motion: someone who has asked their OS not
  // to animate things has not asked any less for the forecast — the panels
  // simply open on the complete run, and the control is still there to play
  // it deliberately.
  const startedFor = useRef<string | null>(null);
  useEffect(() => {
    if (startedFor.current === autoKey) return;
    startedFor.current = autoKey;
    if (last <= 0) return;
    if (
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }
    onCursor(0);
    setPlaying(true);
  }, [autoKey, last, onCursor]);

  if (last <= 0) return null;

  const at = cursor ?? last;
  const play = () => {
    // Replay from the top when we are sitting on the end — whether that is
    // the resting state or a finished run.
    if (cursor === null || cursor >= last) onCursor(0);
    setPlaying(true);
  };

  return (
    <div className="forecast-playback">
      <div className="forecast-playback-btns">
        <button
          type="button"
          className="forecast-playback-btn"
          onClick={playing ? () => setPlaying(false) : play}
          title={playing ? 'pause' : 'play the run year by year'}
          aria-label={playing ? 'pause' : 'play'}
        >
          {playing ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
        </button>
        <button
          type="button"
          className="forecast-playback-btn"
          onClick={() => {
            setPlaying(false);
            onCursor(null);
          }}
          disabled={!playing && cursor === null}
          // Stop returns to the COMPLETE run rather than to year 0. The whole
          // forecast is this dashboard's resting state; rewinding to an empty
          // first frame would leave the panels showing nothing at all.
          title="stop and show the complete run"
          aria-label="stop"
        >
          <StopIcon size={18} />
        </button>
      </div>
      <input
        type="range"
        className="forecast-playback-range"
        min={0}
        max={last}
        value={at}
        onChange={(e) => {
          setPlaying(false);
          onCursor(Number(e.target.value));
        }}
        aria-label="year"
      />
      <span className="forecast-playback-year num">
        {cursor === null ? `all ${last} years` : `year ${at} / ${last}`}
      </span>
    </div>
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
  // Value and label share a line so each figure reads as the phrase it is —
  // "0% trust the forecast" — rather than as a number stacked above a caption
  // in a box. The three are peers in a sentence about one run, not three
  // independent metrics that happened to be laid out side by side.
  return (
    <button
      type="button"
      className={`forecast-readback-stat ${accent ? 'is-accent' : ''} ${interactive ? 'is-interactive' : ''}`}
      onClick={onClick}
      disabled={!interactive}
    >
      <span className="forecast-readback-head">
        <span className="forecast-readback-big">{big}</span>
        <span className="forecast-readback-label">{label}</span>
      </span>
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

