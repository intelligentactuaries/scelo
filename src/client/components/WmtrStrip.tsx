// WMTR strip — sits above the canvas tab content whenever a run carries
// a Nanoeconomics Monte Carlo baseline. Mirrors the visual grammar of
// website_v2's /lab/wmtr (cream panel chrome, JetBrains-Mono labels,
// ECharts `baseOption()` styling), so a viewer feels the two surfaces
// belong to one lab.

import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { LineChart, BarChart, GaugeChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type {
  Intervention,
  InterventionCluster,
  InterventionParam,
  RunWmtr,
} from '../../shared/types';
import {
  OUTCOME_COLOR,
  classify,
  driverContributions as engineDriverContributions,
  type Outcome,
} from '../../shared/wmtr';
import { colorsForTheme, type ThemeColors } from '../../shared/constants';
import { useTheme } from '../lib/theme';
import { api } from '../lib/api';

echarts.use([
  LineChart,
  BarChart,
  GaugeChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  CanvasRenderer,
]);

// ─── ECharts base option (mirrors /lab/wmtr's baseOption) ────────────────
//
// Color discipline: every series sets its color at the SERIES level (never
// only inside lineStyle). ECharts derives legend chips and tooltip markers
// from the series-level color — style only the line and the legend renders
// default-palette blues/greens that match nothing on the plot, which is
// exactly the "legends look swapped" failure this file used to have.

// containLabel reserves room for tick labels but NOT for axis names, so the
// bottom margin carries the centred x-axis name.
const ECHART_GRID = { left: 8, right: 16, top: 26, bottom: 16, containLabel: true };

const MONO = "'JetBrains Mono', ui-monospace, monospace";

function baseOption(colors: ThemeColors) {
  return {
    backgroundColor: 'transparent',
    textStyle: { color: colors.fg, fontFamily: MONO },
    grid: ECHART_GRID,
    xAxis: {
      type: 'value' as const,
      name: 'years',
      nameLocation: 'middle' as const,
      nameGap: 26,
      nameTextStyle: { color: colors.muted, fontSize: 9, fontFamily: MONO },
      axisLine: { lineStyle: { color: colors.border } },
      axisLabel: { color: colors.fgMute, fontSize: 10 },
      splitLine: { lineStyle: { color: colors.grid } },
    },
    yAxis: {
      type: 'value' as const,
      axisLine: { lineStyle: { color: colors.border } },
      axisLabel: { color: colors.fgMute, fontSize: 10 },
      splitLine: { lineStyle: { color: colors.grid } },
    },
    tooltip: {
      trigger: 'axis' as const,
      axisPointer: { type: 'line' as const, lineStyle: { color: colors.muted, width: 1 } },
      backgroundColor: colors.tooltipBg,
      borderColor: colors.tooltipBorder,
      textStyle: { color: colors.tooltipText, fontSize: 11, fontFamily: MONO },
    },
    legend: {
      textStyle: { color: colors.fgMute, fontSize: 10, fontFamily: MONO },
      itemWidth: 14,
      itemHeight: 8,
      top: 0,
      right: 8,
    },
  };
}

// Tooltip marker dot matching a series color (ECharts' own chip markup).
function dot(color: string): string {
  return `<span style="display:inline-block;margin-right:5px;border-radius:50%;width:8px;height:8px;background:${color}"></span>`;
}

// ─── Component ─────────────────────────────────────────────────────────

interface Props {
  wmtr: RunWmtr;
  /** Optional intervention clusters to surface as small chips. */
  clusters?: InterventionCluster[];
  /** Run id, only set when this is an attached run. Pre-council previews
   *  leave this null, which hides the re-simulate flow. */
  runId?: string | null;
  /** Scenario text — used by the standalone preview path. */
  scenario?: string;
  /** Called after a successful intervention re-simulation. `wmtr` carries the
   *  re-simulated forecast for the inline (no-recouncil) path. */
  onInterveneStarted?: (newRunId: string | null, wmtr?: RunWmtr) => void;
}

export function WmtrStrip({ wmtr, clusters, runId, scenario, onInterveneStarted }: Props) {
  const dom = wmtr.dominantOutcome;
  const cfg = wmtr.config;
  const res = wmtr.result;
  const last = res.years.length - 1;
  const finalW = res.meanW[last] ?? 0;
  const finalSurv = res.meanSurv[last] ?? 0;
  const ratio = res.w0 > 0 ? finalW / res.w0 : 0;
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const { resolved } = useTheme();
  const colors = colorsForTheme(resolved);

  return (
    <section className="wmtr-strip" aria-label="WMTR nanoeconomics simulator evidence">
      <header className="wmtr-strip-head">
        <div className="wmtr-strip-eyebrow">
          <span className="wmtr-mono-eyebrow">W(M, T, R) · simulator evidence</span>
          <span className="wmtr-strip-pill" data-shock={cfg.shock}>
            shock={cfg.shock}
          </span>
          <span className="wmtr-strip-meta">
            horizon {cfg.horizon}y · {cfg.nPaths} paths · driver {wmtr.driver}
          </span>
        </div>
        <div className="wmtr-strip-dom" style={{ color: OUTCOME_COLOR[dom] }}>
          dominant outcome: <strong>{dom}</strong>
        </div>
      </header>

      <div className="wmtr-strip-grid">
        <WmtrPanel title="Wealth trajectory · 25–75 band + mean">
          <WmtrChart options={trajectoryOption(wmtr, colors)} height={150} />
        </WmtrPanel>
        <WmtrPanel title="Survival probability S(t)">
          <WmtrChart options={survivalOption(wmtr, colors)} height={150} />
        </WmtrPanel>
        <WmtrPanel title="Outcome distribution">
          <WmtrChart options={outcomeOption(wmtr, colors)} height={150} />
        </WmtrPanel>
        <WmtrPanel title="W(M,T,R) components · mean across paths">
          <WmtrChart options={componentsOption(wmtr, colors)} height={150} />
        </WmtrPanel>
      </div>

      <div className="wmtr-strip-foot">
        <div className="wmtr-strip-foot-stat">
          <span className="wmtr-foot-label">final mean W</span>
          <span className="wmtr-foot-value">
            {finalW.toFixed(3)} <em>(W/W₀ {ratio >= 1 ? '+' : ''}{((ratio - 1) * 100).toFixed(0)}%)</em>
          </span>
        </div>
        <div className="wmtr-strip-foot-stat">
          <span className="wmtr-foot-label">final survival</span>
          <span className="wmtr-foot-value">{pct(finalSurv)}</span>
        </div>
        <div className="wmtr-strip-foot-stat">
          <span className="wmtr-foot-label">α-mix M:T:R</span>
          <span className="wmtr-foot-value wmtr-foot-numeric">
            {cfg.alphaM.toFixed(2)} : {cfg.alphaT.toFixed(2)} : {cfg.alphaR.toFixed(2)}
          </span>
        </div>
        <div className="wmtr-strip-foot-stat">
          <span className="wmtr-foot-label">w-mix F:Rel:S</span>
          <span className="wmtr-foot-value wmtr-foot-numeric">
            {cfg.wF.toFixed(2)} : {cfg.wRel.toFixed(2)} : {cfg.wS.toFixed(2)}
          </span>
        </div>
      </div>

      {clusters && clusters.length > 0 && (
        <InterventionRow
          clusters={clusters}
          runId={runId ?? null}
          scenario={scenario ?? null}
          onInterveneStarted={onInterveneStarted}
        />
      )}
    </section>
  );
}

function WmtrPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="wmtr-panel">
      <div className="wmtr-panel-head">{title}</div>
      <div className="wmtr-panel-body">{children}</div>
    </div>
  );
}

// ─── Chart wrapper ─────────────────────────────────────────────────────

export function WmtrChart({
  options,
  height,
  /** Fires with the clicked datum's `name`. Lets a chart carry the same
   *  drill-down a DOM button would, without re-registering the handler on
   *  every render. */
  onSelect,
}: {
  options: object;
  height: number;
  onSelect?: (name: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  // Held in a ref so the mount effect can stay dependency-free: an inline
  // arrow from the parent changes identity every render, which would
  // otherwise tear down and rebind the listener each time.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const inst = echarts.init(el, null, { renderer: 'canvas' });
    chartRef.current = inst;
    const click = (p: { name?: string }) => {
      if (p?.name) onSelectRef.current?.(p.name);
    };
    inst.on('click', click);
    const ro = new ResizeObserver(() => inst.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      inst.off('click', click);
      inst.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const inst = chartRef.current;
    if (!inst) return;
    inst.setOption(options as echarts.EChartsCoreOption, { notMerge: true, lazyUpdate: true });
  }, [options]);

  return <div ref={ref} className="wmtr-chart" style={{ height }} />;
}

// ─── ECharts option builders (port of /lab/wmtr equivalents) ─────────

export function trajectoryOption(w: RunWmtr, colors: ThemeColors): object {
  const r = w.result;
  const b = baseOption(colors);
  const f3 = (x: number) => x.toFixed(3);
  return {
    ...b,
    // Category axis, not value: the band is drawn with `stack`, and ECharts
    // stacks EVERY dimension of pair data on a value axis (x runs to 2× the
    // horizon), while scalar data on a value axis is read as x. The classic
    // quantile-band recipe is category years + 1-D series.
    xAxis: { ...b.xAxis, type: 'category' as const, data: r.years, boundaryGap: false },
    // W sits in a narrow band (e.g. 0.60–0.76); a zero-based axis squashes
    // the whole story into the top fifth of the panel. scale:true fits the
    // data; the W₀ markLine keeps "where we started" visible for reference.
    yAxis: { ...b.yAxis, scale: true },
    legend: { ...b.legend, show: false },
    tooltip: {
      ...b.tooltip,
      // The band is drawn via an invisible stacked base + a delta series;
      // neither raw value means anything to a reader, so the tooltip is
      // built by hand from the real quantiles instead.
      formatter: (params: Array<{ dataIndex: number }>) => {
        const i = params[0]?.dataIndex ?? 0;
        return [
          `year ${r.years[i]}`,
          `${dot(colors.consensus)}mean W ${f3(r.meanW[i])}`,
          `${dot(`${colors.consensus}60`)}p25–p75 ${f3(r.p25W[i])} – ${f3(r.p75W[i])}`,
          `${dot(colors.muted)}W₀ ${f3(r.w0)}`,
        ].join('<br/>');
      },
    },
    // NOTE: the band series use 1-D arrays, not [year, value] pairs — with
    // `stack`, ECharts sums EVERY dimension of pair data, so the x values
    // stack too and the axis runs to 2× the horizon. Index == year holds by
    // construction (result.years is always 0..T-1).
    series: [
      {
        name: 'p25 (band base)',
        type: 'line',
        color: 'transparent',
        data: r.p25W,
        showSymbol: false,
        lineStyle: { opacity: 0 },
        stack: 'band',
        silent: true,
      },
      {
        name: '25–75 band',
        type: 'line',
        color: `${colors.consensus}30`,
        data: r.p75W.map((v, i) => v - r.p25W[i]),
        showSymbol: false,
        lineStyle: { opacity: 0 },
        areaStyle: { color: `${colors.consensus}30` },
        stack: 'band',
        silent: true,
      },
      {
        name: 'mean W',
        type: 'line',
        color: colors.consensus,
        data: r.meanW,
        showSymbol: false,
        lineStyle: { width: 2 },
        markLine: {
          silent: true,
          symbol: 'none',
          data: [{ yAxis: r.w0 }],
          lineStyle: { color: colors.muted, type: 'dashed', width: 1 },
          label: {
            formatter: 'W₀',
            position: 'insideEndTop',
            color: colors.muted,
            fontSize: 10,
            fontFamily: MONO,
          },
        },
      },
    ],
  };
}

export function survivalOption(w: RunWmtr, colors: ThemeColors): object {
  const r = w.result;
  const b = baseOption(colors);
  return {
    ...b,
    xAxis: { ...b.xAxis, boundaryGap: false },
    yAxis: {
      ...b.yAxis,
      min: 0,
      max: 1,
      axisLabel: {
        ...b.yAxis.axisLabel,
        formatter: (v: number) => `${Math.round(v * 100)}%`,
      },
    },
    legend: { ...b.legend, show: false },
    tooltip: {
      ...b.tooltip,
      valueFormatter: (v: unknown) => `${((v as number) * 100).toFixed(0)}%`,
    },
    series: [
      {
        name: 'P(survival)',
        type: 'line',
        color: colors.consensus,
        data: r.years.map((y, i) => [y, r.meanSurv[i]]),
        showSymbol: false,
        lineStyle: { width: 2 },
        areaStyle: { opacity: 0.14 },
      },
    ],
  };
}

export function componentsOption(
  w: RunWmtr,
  colors: ThemeColors,
  /**
   * `compact` (the default) sizes the legend for the 150px strip panels.
   * The forecast canvas renders this same chart as a headline plot at
   * roughly half the canvas width, where the strip's 9px legend and the
   * two-row gutter it reserves read as cramped — that surface passes
   * `compact: false`.
   */
  opts: { compact?: boolean } = {},
): object {
  const compact = opts.compact !== false;
  const r = w.result;
  const b = baseOption(colors);
  // Fixed identity → color assignment (validated CVD-safe trio); the legend
  // and tooltip chips inherit these same series-level colors, so the three
  // surfaces can never disagree again. Names are short enough to keep the
  // legend to ONE row even in the 150px strip panels; the panel title
  // ("W(M,T,R) components") carries the letter mapping.
  const defs = [
    { key: 'meanM' as const, name: 'money', color: colors.chartM },
    { key: 'meanT' as const, name: 'time', color: colors.chartT },
    { key: 'meanR' as const, name: 'relationships', color: colors.chartR },
  ];
  return {
    ...b,
    // Strip panels can be as narrow as 180px (minmax in .wmtr-strip-grid);
    // the compact legend wraps to two rows there, so the grid reserves room.
    // At canvas size the legend always fits one row, so the gutter shrinks.
    grid: { ...ECHART_GRID, top: compact ? 40 : 30 },
    xAxis: { ...b.xAxis, boundaryGap: false },
    yAxis: { ...b.yAxis, min: 0 },
    legend: {
      ...b.legend,
      left: 8,
      right: 8,
      top: 0,
      itemWidth: compact ? 12 : 16,
      itemGap: compact ? 6 : 16,
      textStyle: { ...b.legend.textStyle, fontSize: compact ? 9 : 11 },
    },
    tooltip: {
      ...b.tooltip,
      valueFormatter: (v: unknown) => (v as number).toFixed(3),
    },
    series: defs.map((d) => ({
      name: d.name,
      type: 'line',
      color: d.color,
      data: r.years.map((y, i) => [y, r[d.key][i]]),
      showSymbol: false,
      lineStyle: { width: 2 },
    })),
  };
}

export function outcomeOption(w: RunWmtr, colors: ThemeColors): object {
  const order: Outcome[] = ['grew', 'stabilized', 'declined', 'collapsed'];
  const f = w.result.outcomeFractions;
  const b = baseOption(colors);
  const full: Record<Outcome, string> = {
    grew: 'Grew',
    stabilized: 'Stabilized',
    declined: 'Declined',
    collapsed: 'Collapsed',
  };
  return {
    ...b,
    grid: { ...ECHART_GRID, top: 18, bottom: 2 },
    legend: { show: false },
    xAxis: {
      ...b.xAxis,
      type: 'category' as const,
      name: '',
      data: order.map((o) => full[o].slice(0, 4)),
      boundaryGap: true,
      axisLabel: { ...b.xAxis.axisLabel, interval: 0 },
    },
    yAxis: {
      ...b.yAxis,
      max: 105,
      axisLabel: { ...b.yAxis.axisLabel, formatter: (v: number) => `${v}%` },
    },
    tooltip: {
      ...b.tooltip,
      trigger: 'item' as const,
      formatter: (p: { dataIndex: number; value: number }) => {
        const o = order[p.dataIndex];
        return `${dot(OUTCOME_COLOR[o])}${full[o]} — ${p.value.toFixed(1)}% of ${w.config.nPaths} paths`;
      },
    },
    series: [
      {
        type: 'bar',
        data: order.map((o) => ({
          value: +(f[o] * 100).toFixed(1),
          itemStyle: { color: OUTCOME_COLOR[o], borderRadius: [4, 4, 0, 0] },
        })),
        barWidth: '60%',
        label: {
          show: true,
          position: 'top',
          formatter: (p: { value: number }) => `${p.value.toFixed(0)}%`,
          color: colors.fgMute,
          fontFamily: MONO,
          fontSize: 10,
        },
      },
    ],
  };
}

// ─── Outcome mix over time ────────────────────────────────────────────
//
// The outcome-distribution bars are one number per bucket: where the paths
// landed at the horizon. This is that same split evaluated at every year —
// "if the simulation had stopped here, how would the 200 paths have been
// classified?" — so the reader can see WHEN the verdict was decided rather
// than only what it was. A plurality that only appears in the last five
// years is a different claim from one that held from year 8 onward, and the
// bars cannot tell those apart.
//
// Derived on the client from `result.paths`, which carries every path's full
// wHist. That means it needs no engine, server or payload change and works
// on runs simulated before this chart existed.

/**
 * Stack order, bottom → top: best outcome on the floor, worst on the
 * ceiling. This ordering is what makes the chart's DIRECTION mean something,
 * and it is not interchangeable with the reverse:
 *
 *   - the top of `grew`                  = the growing share, which RISES
 *     as paths grow;
 *   - the top of `stabilized`            = the healthy share (grew +
 *     stabilized) — a waterline that FALLS as paths decline or collapse, and
 *     sits FLAT while the community holds steady;
 *   - the top of `declined`              = everything not yet collapsed, so
 *     a collapse presses it DOWN from the ceiling.
 *
 * Stacking worst-first does the opposite: a community falling apart is drawn
 * as a band climbing the screen, which reads as improvement at a glance even
 * though the legend says otherwise.
 */
const MIX_ORDER: Outcome[] = ['grew', 'stabilized', 'declined', 'collapsed'];

const MIX_LABEL: Record<Outcome, string> = {
  grew: 'Grew',
  stabilized: 'Stabilized',
  declined: 'Declined',
  collapsed: 'Collapsed',
};

/**
 * Fraction of paths in each bucket at each year, using the engine's own
 * `classify` on the prefix of each path. Two properties worth knowing:
 *  - year 0 is 100% stabilized by construction (W == W₀ for every path);
 *  - the final year reproduces `result.outcomeFractions` exactly, because
 *    it is the identical call the engine makes.
 */
export function outcomeMixByYear(r: RunWmtr['result']): Record<Outcome, number[]> {
  const th = r.config.thresholds;
  const out: Record<Outcome, number[]> = {
    grew: [],
    stabilized: [],
    declined: [],
    collapsed: [],
  };
  const total = r.paths.length || 1;
  for (let t = 0; t < r.years.length; t++) {
    const counts: Record<Outcome, number> = {
      grew: 0,
      stabilized: 0,
      declined: 0,
      collapsed: 0,
    };
    for (const p of r.paths) {
      // Each path is classified against its OWN W₀ (wHist[0]) — the same
      // value the engine passes — not the run-level w0, which is only
      // path 0's starting wealth.
      counts[classify(p.wHist.slice(0, t + 1), p.wHist[0], th)]++;
    }
    for (const o of MIX_ORDER) out[o].push(counts[o] / total);
  }
  return out;
}

/**
 * Whether the derived final year reproduces the run's stored
 * `outcomeFractions` — i.e. whether this chart and the outcome bars beside
 * it are telling the same story.
 *
 * It returns false only for runs simulated before `classify` was fixed to
 * stop labelling the (+stability, +growth] band — real gains — as
 * "declined". Those payloads carry per-path outcomes from the old rule, so
 * re-deriving them today legitimately moves paths from declined to
 * stabilized. The bars are left showing what the council actually
 * deliberated on; the caller discloses the mismatch instead of silently
 * rendering two panels that disagree.
 */
export function outcomeMixMatchesBars(r: RunWmtr['result']): boolean {
  const mix = outcomeMixByYear(r);
  const last = r.years.length - 1;
  if (last < 0) return true;
  return MIX_ORDER.every((o) => Math.abs(mix[o][last] - r.outcomeFractions[o]) < 5e-3);
}

export function outcomeMixOption(w: RunWmtr, colors: ThemeColors): object {
  const r = w.result;
  const b = baseOption(colors);
  const mix = outcomeMixByYear(r);
  const nPaths = r.paths.length;
  const last = r.years.length - 1;
  // A collapsed share is often 1-3%, which is ~2px of a 166px plot however
  // it is drawn — faithful, but easy to miss next to the bars, which give
  // any non-zero bucket a full row. Marking the year the first path crosses
  // makes the fact legible without inflating the band and lying about the
  // share, and answers the question the band alone can't: when.
  const firstCollapse = mix.collapsed.findIndex((v) => v > 0);

  return {
    ...b,
    // The right gutter has to hold the widest endpoint label ("Stabilized
    // 100%" ≈ 14 mono chars at 10px) plus its 6px offset, or ECharts draws
    // it straight through the panel edge.
    grid: { ...ECHART_GRID, top: 30, bottom: 16, right: 112 },
    // Category axis + 1-D series data, for the same reason trajectoryOption
    // uses them: with `stack`, ECharts sums EVERY dimension of pair data, so
    // [year, value] pairs stack the x values too and the axis runs to 2× the
    // horizon. Index == year holds by construction (years is always 0..T-1).
    xAxis: { ...b.xAxis, type: 'category' as const, data: r.years, boundaryGap: false },
    yAxis: {
      ...b.yAxis,
      min: 0,
      max: 1,
      axisLabel: {
        ...b.yAxis.axisLabel,
        formatter: (v: number) => `${Math.round(v * 100)}%`,
      },
    },
    legend: {
      ...b.legend,
      // Best → worst, matching the outcome bars beside it. Identity is never
      // colour-alone: legend + the endpoint labels below, which the palette
      // check makes mandatory (amber sits above the dark-mode lightness band
      // and under 3:1 on cream).
      data: MIX_ORDER.map((o) => MIX_LABEL[o]),
      left: 8,
      right: 8,
      top: 0,
      itemWidth: 14,
      itemGap: 14,
      textStyle: { ...b.legend.textStyle, fontSize: 10 },
    },
    tooltip: {
      ...b.tooltip,
      // Hand-built so the rows read best → worst (matching the legend and
      // the bars) and each carries the path count, not just the percentage.
      formatter: (params: Array<{ dataIndex: number }>) => {
        const i = params[0]?.dataIndex ?? 0;
        const rows = MIX_ORDER.map((o) => {
          const frac = mix[o][i];
          return `${dot(OUTCOME_COLOR[o])}${MIX_LABEL[o]} ${(frac * 100).toFixed(0)}% · ${Math.round(frac * nPaths)} paths`;
        });
        return [`year ${r.years[i]}`, ...rows].join('<br/>');
      },
    },
    series: ([] as any[]).concat(
      MIX_ORDER.map((o, idx) => ({
      name: MIX_LABEL[o],
      type: 'line',
      color: OUTCOME_COLOR[o],
      stack: 'mix',
      data: mix[o],
      showSymbol: false,
      // Each band's top edge is drawn in its OWN colour, and the top-most
      // band gets no edge at all. Both halves of that matter:
      //
      //  - A surface-coloured seam is wider than a small band. At 1% of a
      //    ~166px plot a band is ~1.7px tall, so a 2px separator centred on
      //    its boundary painted over the whole thing — which is why a run
      //    showing "Collapsed 1%" in the bars showed no red here at all.
      //    A same-hue edge delimits the band without erasing its neighbour.
      //  - The last series' cumulative is always exactly 100%, so its line
      //    is a constant at the plot ceiling carrying no information. Drawn
      //    in red it would assert a collapse even on runs with none.
      //  - A band that is zero at EVERY year has no top edge of its own: its
      //    line lies exactly on the boundary below it, so drawing it claims
      //    a bucket that never occurred (a green rule along 0% on a run
      //    where nothing grew).
      lineStyle:
        idx === MIX_ORDER.length - 1 || mix[o].every((v) => v <= 0)
          ? { width: 0, opacity: 0 }
          : { width: 1, color: OUTCOME_COLOR[o], opacity: 1 },
      // Held below full saturation — four stacked bands at full strength
      // read as a flag rather than a chart — but not so far down that a
      // 1%-tall band washes into the one beneath it.
      areaStyle: { color: OUTCOME_COLOR[o], opacity: 0.75 },
      // Direct-label the endpoint only — never a number on every point.
      // Bands thinner than 5% at the horizon are left to the tooltip and
      // legend: their labels sit on the band boundary, so a sliver's label
      // would collide with its neighbour's rather than inform.
      endLabel: {
        show: mix[o][last] >= 0.05,
        formatter: () => `${MIX_LABEL[o]} ${(mix[o][last] * 100).toFixed(0)}%`,
        color: colors.fgMute,
        fontFamily: MONO,
        fontSize: 10,
        distance: 6,
      },
      ...(o === 'collapsed' && firstCollapse > 0
        ? {
            markLine: {
              silent: true,
              symbol: 'none',
              data: [{ xAxis: firstCollapse }],
              lineStyle: {
                color: OUTCOME_COLOR.collapsed,
                type: 'dashed' as const,
                width: 1,
              },
              label: {
                formatter: `first collapse · yr ${r.years[firstCollapse]}`,
                position: 'end' as const,
                color: OUTCOME_COLOR.collapsed,
                fontSize: 9,
                fontFamily: MONO,
              },
            },
          }
        : {}),
      // No `emphasis.focus` here: the tooltip is axis-triggered and the
      // stack is part-to-whole, so fading the sibling bands on hover would
      // hide the very comparison the reader is making.
      z: MIX_ORDER.length - idx,
      })),
      // Outline for the collapsed cap. One path in 200 is 0.5% — about 1.5
      // device rows — so the fill anti-aliases into the amber beneath it and
      // never resolves as red, which is why the bars showed a Collapsed row
      // while this chart looked empty. This traces the band's LOWER edge at
      // (1 - collapsed), unstacked, and only for the years a collapse
      // actually exists: it makes a sub-pixel share legible without
      // inflating it into a lie about the size. Nulls elsewhere leave gaps
      // rather than a line implying collapse throughout.
      firstCollapse > 0
        ? [
            {
              name: 'collapsed-edge',
              type: 'line',
              color: OUTCOME_COLOR.collapsed,
              data: mix.collapsed.map((v) => (v > 0 ? 1 - v : null)),
              showSymbol: false,
              silent: true,
              lineStyle: { width: 2, color: OUTCOME_COLOR.collapsed, opacity: 1 },
              tooltip: { show: false },
              z: MIX_ORDER.length + 1,
            },
          ]
        : [],
    ),
  };
}

// ─── Outcome gauge ────────────────────────────────────────────────────
//
// Concentric progress rings, one per outcome bucket, replacing the bar
// list. Each ring is an independent 0-100% meter rather than a slice of one
// population — the four still sum to 100, but the form doesn't show that, so
// the tooltip carries the path counts and the outcome-mix panel beside it
// remains the part-to-whole view.
//
// Ring order is best → worst outward-in, matching the legend order of the
// mix chart and the bars this replaces. `progress.overlap: false` is what
// puts each datum on its own ring instead of stacking them on one track.

const GAUGE_ORDER: Outcome[] = ['grew', 'stabilized', 'declined', 'collapsed'];

/** Display label → outcome, for turning a click on a ring back into a filter. */
export const OUTCOME_BY_LABEL: Record<string, Outcome> = Object.fromEntries(
  GAUGE_ORDER.map((o) => [MIX_LABEL[o], o]),
) as Record<string, Outcome>;

export function outcomeGaugeOption(w: RunWmtr, colors: ThemeColors): object {
  const f = w.result.outcomeFractions;
  const nPaths = w.config.nPaths;

  // Four rows of readout share the donut hole, so they are laid out as
  // name-left / value-right on one line each rather than the stacked
  // title-above-value of a three-ring gauge, which would need eight lines.
  // ±33% of the radius keeps the outer rows clear of the ring: at that
  // offset the hole is still ~170px across, and a row is ~135px.
  const rowY = [-33, -11, 11, 33];

  return {
    backgroundColor: 'transparent',
    textStyle: { color: colors.fg, fontFamily: MONO },
    tooltip: {
      trigger: 'item' as const,
      backgroundColor: colors.tooltipBg,
      borderColor: colors.tooltipBorder,
      textStyle: { color: colors.tooltipText, fontSize: 11, fontFamily: MONO },
      formatter: (p: { name: string; value: number }) => {
        const o = OUTCOME_BY_LABEL[p.name];
        const paths = Math.round((f[o] ?? 0) * nPaths);
        return [
          `${dot(OUTCOME_COLOR[o])}${p.name} — ${p.value.toFixed(1)}%`,
          `${paths} of ${nPaths} paths`,
          'click to drill into divergent agents',
        ].join('<br/>');
      },
    },
    series: [
      {
        type: 'gauge',
        startAngle: 90,
        endAngle: -270,
        radius: '95%',
        min: 0,
        max: 100,
        pointer: { show: false },
        progress: {
          show: true,
          overlap: false,
          roundCap: true,
          clip: false,
          itemStyle: { borderWidth: 1, borderColor: colors.bg2 },
        },
        axisLine: {
          // The unfilled remainder of each ring, in the theme's border tone
          // so an empty bucket reads as an empty track rather than as absent.
          // NOTE this width is the budget for ALL FOUR rings — `overlap:
          // false` splits it between them — so it is 4× a single ring's
          // thickness, not one ring's. At 12 the rings came out ~3px hairlines.
          lineStyle: { width: 36, color: [[1, colors.border]] },
        },
        splitLine: { show: false },
        axisTick: { show: false },
        axisLabel: { show: false },
        title: { fontSize: 11, fontFamily: MONO, color: colors.fgMute },
        detail: {
          width: 42,
          height: 13,
          fontSize: 11,
          fontFamily: MONO,
          // Text in an ink token, pill outline in the series colour: the
          // palette check puts amber above the dark-mode lightness band and
          // under 3:1 on cream, so the number itself must not wear it.
          color: colors.fg,
          borderColor: 'inherit',
          borderRadius: 20,
          borderWidth: 1,
          formatter: '{value}%',
        },
        data: GAUGE_ORDER.map((o, i) => ({
          value: +((f[o] ?? 0) * 100).toFixed(1),
          name: MIX_LABEL[o],
          itemStyle: { color: OUTCOME_COLOR[o] },
          title: { offsetCenter: ['-30%', `${rowY[i]}%`] },
          detail: { valueAnimation: true, offsetCenter: ['34%', `${rowY[i]}%`] },
        })),
      },
    ],
  };
}

// ─── What moved W (driver bridge) ─────────────────────────────────────
//
// W is Cobb-Douglas — W = M^αM · T^αT · R^αR — so
//
//     ln W_T - ln W_0  =  αM·Δln M  +  αT·Δln T  +  αR·Δln R
//
// EXACTLY, with no residual and no interaction term. That makes "what moved
// the forecast" a fact to be read off rather than a judgement call, and it
// is the question the council actually acts on: the interventions it emits
// are parameter changes, so knowing whether money, time or relationships
// carried the move tells it which lever is worth pulling.
//
// The three time-series panels all answer "what happened". None of them
// answers "why", and the levels chart in particular cannot: M, T and R live
// on incommensurable scales (M starts at 1 and compounds without bound, T is
// a fraction of a day, R is a [0,1] index), so their lines cannot be
// compared by eye. Elasticity-weighted log changes are exactly the common
// scale that makes them comparable.
//
// Contributions are accumulated PER PATH and then averaged, which keeps the
// identity exact (verified to ~3e-16 on stored runs). Decomposing the mean
// series instead would leave a Jensen gap, because the mean of a product is
// not the product of the means.

export interface DriverContribution {
  /** Elasticity-weighted log change, in log points (≈ percentage points). */
  M: number;
  T: number;
  R: number;
  /** Mean log change in W. Equals M + T + R by construction. */
  net: number;
}

/**
 * The engine's attribution, scaled to log points for the axis. The maths
 * deliberately lives in `shared/wmtr.ts` — the same call backs the driver on
 * the header and the evidence block the council reads, so this chart cannot
 * contradict them.
 */
export function driverContributions(r: RunWmtr['result']): DriverContribution {
  const c = engineDriverContributions(r);
  return { M: c.M * 100, T: c.T * 100, R: c.R * 100, net: c.net * 100 };
}

export function driverBridgeOption(w: RunWmtr, colors: ThemeColors): object {
  const r = w.result;
  const b = baseOption(colors);
  const c = driverContributions(r);

  const steps = [
    { key: 'M' as const, label: 'money', value: c.M, color: colors.chartM },
    { key: 'T' as const, label: 'time', value: c.T, color: colors.chartT },
    { key: 'R' as const, label: 'relationships', value: c.R, color: colors.chartR },
  ];

  // Bridge geometry: each step floats from the running total to the next, so
  // an invisible bar carries it up to the step's lower edge and the visible
  // bar spans |value|. The closing bar is measured from zero.
  const offsets: number[] = [];
  const spans: number[] = [];
  let cum = 0;
  for (const s of steps) {
    offsets.push(Math.min(cum, cum + s.value));
    spans.push(Math.abs(s.value));
    cum += s.value;
  }
  offsets.push(Math.min(0, c.net));
  spans.push(Math.abs(c.net));

  const rows = [...steps.map((s) => s.label), 'net change'];
  const colorFor = (i: number) => (i < steps.length ? steps[i].color : colors.fgMute);
  const signed = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
  // exp(x)-1 turns a log contribution back into the multiplicative effect it
  // had on W; the three of them multiply to the net.
  const asPct = (v: number) => `${v >= 0 ? '+' : ''}${((Math.exp(v / 100) - 1) * 100).toFixed(1)}%`;

  return {
    ...b,
    // `containLabel` sizes the gutter from measured text, which under a
    // webfont can be measured before JetBrains Mono has loaded — leaving the
    // longest category ("relationships") clipped at the left edge. The extra
    // left margin is the slack that costs nothing and survives that race.
    grid: { left: 24, right: 64, top: 18, bottom: 20, containLabel: true },
    xAxis: {
      ...b.xAxis,
      type: 'value' as const,
      name: 'contribution to ln W (log points)',
      nameLocation: 'middle' as const,
      nameGap: 26,
      axisLabel: { ...b.xAxis.axisLabel, formatter: (v: number) => signed(v) },
    },
    yAxis: {
      ...b.yAxis,
      type: 'category' as const,
      // ECharts draws the first category at the bottom; reverse so the
      // bridge reads top-down in the order the terms compose.
      data: [...rows].reverse(),
      axisLabel: { ...b.yAxis.axisLabel, fontSize: 11 },
      splitLine: { show: false },
    },
    legend: { ...b.legend, show: false },
    tooltip: {
      ...b.tooltip,
      trigger: 'item' as const,
      formatter: (p: { dataIndex: number }) => {
        const i = rows.length - 1 - p.dataIndex;
        const isNet = i === steps.length;
        const v = isNet ? c.net : steps[i].value;
        const head = isNet
          ? `${dot(colors.fgMute)}net change ${signed(v)} log pts · ${asPct(v)} on W`
          : `${dot(steps[i].color)}${steps[i].label} ${signed(v)} log pts · ${asPct(v)} on W`;
        return [
          head,
          isNet
            ? 'money + time + relationships, exactly'
            : `elasticity α=${(i === 0 ? r.config.alphaM : i === 1 ? r.config.alphaT : r.config.alphaR).toFixed(2)} (renormalised) × its log change`,
        ].join('<br/>');
      },
    },
    series: [
      {
        name: 'offset',
        type: 'bar',
        stack: 'bridge',
        // ECharts stacks same-signed values only by default, so a negative
        // offset and a positive span are pushed in OPPOSITE directions from
        // zero and the bridge never chains — every bar starts at 0. 'all'
        // stacks regardless of sign, which is what a waterfall needs.
        stackStrategy: 'all' as const,
        itemStyle: { color: 'transparent' },
        emphasis: { itemStyle: { color: 'transparent' } },
        data: [...offsets].reverse(),
        silent: true,
      },
      {
        name: 'contribution',
        type: 'bar',
        stack: 'bridge',
        stackStrategy: 'all' as const,
        barWidth: '52%',
        data: [...spans].reverse().map((v, idx) => ({
          value: v,
          itemStyle: { color: colorFor(rows.length - 1 - idx), borderRadius: 3 },
        })),
        label: {
          show: true,
          position: 'right' as const,
          formatter: (p: { dataIndex: number }) => {
            const i = rows.length - 1 - p.dataIndex;
            return signed(i === steps.length ? c.net : steps[i].value);
          },
          color: colors.fgMute,
          fontFamily: MONO,
          fontSize: 10,
        },
      },
    ],
  };
}

// ─── Intervention row ─────────────────────────────────────────────────

function paramLabel(p: InterventionParam): string {
  const map: Record<InterventionParam, string> = {
    alphaM: 'αM',
    alphaT: 'αT',
    alphaR: 'αR',
    wF: 'wF',
    wRel: 'wRel',
    wS: 'wS',
    pProduction: 'p·prod',
    pFamily: 'p·family',
    pReligion: 'p·rel',
    pSpatial: 'p·spatial',
    pLeisure: 'p·leisure',
    initFamily: 'family₀',
    initReligion: 'religion₀',
    shock: 'shock',
  };
  return map[p] ?? p;
}

export function InterventionRow({
  clusters,
  runId,
  scenario,
  onInterveneStarted,
}: {
  clusters: InterventionCluster[];
  runId: string | null;
  scenario: string | null;
  onInterveneStarted?: (newRunId: string | null, wmtr?: RunWmtr) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [pickedIdx, setPickedIdx] = useState<number>(0);
  const top = clusters.slice(0, 6);
  const picked = top[pickedIdx];

  const apply = async () => {
    if (!picked) return;
    setBusy(true);
    try {
      const interv: Intervention = {
        param: picked.param,
        direction: picked.direction,
        magnitude: picked.magnitude,
        rationale: picked.exemplarRationale || `consensus of ${picked.count} agents`,
      };
      if (runId) {
        const r = await api.intervene(runId, { intervention: interv, recouncil: false });
        // recouncil:false → server returns the re-simulated forecast inline with
        // runId null. Hand the wmtr payload up so the forecast actually updates
        // (previously it was dropped and the click looked like a no-op).
        onInterveneStarted?.(r.runId ?? null, r.wmtr);
      } else if (scenario) {
        // Preview path — re-run WMTR only and surface the new forecast.
        const p = await api.runWmtr({ scenario, intervention: interv });
        onInterveneStarted?.(null, p);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wmtr-intervene">
      <div className="wmtr-intervene-head">
        <span className="wmtr-mono-eyebrow">consensus interventions</span>
        <span className="wmtr-strip-meta">choose one to re-simulate</span>
      </div>
      <div className="wmtr-intervene-chips">
        {top.map((c, i) => (
          <button
            key={`${c.param}|${c.direction}|${c.magnitude}`}
            type="button"
            className={`wmtr-chip ${i === pickedIdx ? 'is-active' : ''}`}
            onClick={() => setPickedIdx(i)}
            title={c.exemplarRationale}
          >
            <span className="wmtr-chip-count">×{c.count}</span>
            <span className="wmtr-chip-arrow">{c.direction === 'increase' ? '↑' : '↓'}</span>
            <span className="wmtr-chip-param">{paramLabel(c.param)}</span>
            <span className="wmtr-chip-mag">{c.magnitude}</span>
          </button>
        ))}
      </div>
      {picked && (
        <div className="wmtr-intervene-foot">
          <span className="wmtr-intervene-rationale">
            <em>“{picked.exemplarRationale || 'no rationale given'}”</em>
          </span>
          <button
            type="button"
            className="wmtr-intervene-button"
            onClick={apply}
            disabled={busy}
          >
            {busy ? 'simulating…' : '▶ apply & re-simulate'}
          </button>
        </div>
      )}
    </div>
  );
}
