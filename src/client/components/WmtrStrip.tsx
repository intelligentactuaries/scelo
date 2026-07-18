// WMTR strip — sits above the canvas tab content whenever a run carries
// a Nanoeconomics Monte Carlo baseline. Mirrors the visual grammar of
// website_v2's /lab/wmtr (cream panel chrome, JetBrains-Mono labels,
// ECharts `baseOption()` styling), so a viewer feels the two surfaces
// belong to one lab.

import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
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
import { OUTCOME_COLOR, type Outcome } from '../../shared/wmtr';
import { colorsForTheme, type ThemeColors } from '../../shared/constants';
import { useTheme } from '../lib/theme';
import { api } from '../lib/api';

echarts.use([
  LineChart,
  BarChart,
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

export function WmtrChart({ options, height }: { options: object; height: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const inst = echarts.init(el, null, { renderer: 'canvas' });
    chartRef.current = inst;
    const ro = new ResizeObserver(() => inst.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
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

export function componentsOption(w: RunWmtr, colors: ThemeColors): object {
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
    grid: { ...ECHART_GRID, top: 40 },
    xAxis: { ...b.xAxis, boundaryGap: false },
    yAxis: { ...b.yAxis, min: 0 },
    legend: {
      ...b.legend,
      left: 8,
      right: 8,
      top: 0,
      itemWidth: 12,
      itemGap: 6,
      textStyle: { ...b.legend.textStyle, fontSize: 9 },
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
