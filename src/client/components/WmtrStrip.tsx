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

const ECHART_GRID = { left: 44, right: 16, top: 22, bottom: 30, containLabel: false };

function baseOption(colors: ThemeColors) {
  return {
    backgroundColor: 'transparent',
    textStyle: {
      color: colors.fg,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    },
    grid: ECHART_GRID,
    xAxis: {
      type: 'value' as const,
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
      backgroundColor: colors.tooltipBg,
      borderColor: colors.tooltipBorder,
      textStyle: { color: colors.tooltipText, fontSize: 11 },
    },
    legend: {
      textStyle: { color: colors.fgMute, fontSize: 10 },
      top: 0,
      right: 8,
    },
  };
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
  /** Called after a successful intervention re-simulation. */
  onInterveneStarted?: (newRunId: string | null) => void;
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
        <WmtrPanel title="Components · M / T / R (mean across paths)">
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
  const xs = r.years;
  const b = baseOption(colors);
  return {
    ...b,
    xAxis: { ...b.xAxis, data: xs, name: '', boundaryGap: false },
    yAxis: { ...b.yAxis, name: '' },
    legend: { ...b.legend, show: false },
    series: [
      {
        name: 'p25',
        type: 'line',
        data: r.p25W,
        showSymbol: false,
        lineStyle: { opacity: 0 },
        stack: 'band',
        silent: true,
      },
      {
        name: '25–75',
        type: 'line',
        data: r.p75W.map((v, i) => v - r.p25W[i]),
        showSymbol: false,
        lineStyle: { opacity: 0 },
        areaStyle: { color: `${colors.consensus}30` },
        stack: 'band',
      },
      {
        name: 'mean',
        type: 'line',
        data: r.meanW,
        showSymbol: false,
        lineStyle: { color: colors.consensus, width: 2 },
      },
      {
        name: 'W₀',
        type: 'line',
        data: xs.map(() => r.w0),
        showSymbol: false,
        lineStyle: { color: colors.muted, type: 'dashed', width: 1 },
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
    yAxis: { ...b.yAxis, min: 0, max: 1.05 },
    legend: { ...b.legend, show: false },
    series: [
      {
        name: 'S(t)',
        type: 'line',
        data: r.years.map((y, i) => [y, r.meanSurv[i]]),
        showSymbol: false,
        lineStyle: { color: colors.consensus, width: 2 },
        areaStyle: { color: `${colors.consensus}24` },
      },
    ],
  };
}

export function componentsOption(w: RunWmtr, colors: ThemeColors): object {
  const r = w.result;
  const b = baseOption(colors);
  return {
    ...b,
    xAxis: { ...b.xAxis, boundaryGap: false },
    yAxis: { ...b.yAxis },
    legend: { ...b.legend, data: ['M', 'T', 'R'] },
    series: [
      {
        name: 'M',
        type: 'line',
        data: r.years.map((y, i) => [y, r.meanM[i]]),
        showSymbol: false,
        lineStyle: { color: colors.dissent, width: 1.6 },
      },
      {
        name: 'T',
        type: 'line',
        data: r.years.map((y, i) => [y, r.meanT[i]]),
        showSymbol: false,
        lineStyle: { color: '#6366f1', width: 1.6 },
      },
      {
        name: 'R',
        type: 'line',
        data: r.years.map((y, i) => [y, r.meanR[i]]),
        showSymbol: false,
        lineStyle: { color: colors.adversarial, width: 1.6 },
      },
    ],
  };
}

export function outcomeOption(w: RunWmtr, colors: ThemeColors): object {
  const order: Outcome[] = ['grew', 'stabilized', 'declined', 'collapsed'];
  const f = w.result.outcomeFractions;
  const b = baseOption(colors);
  return {
    ...b,
    grid: { ...ECHART_GRID, left: 56, bottom: 32 },
    legend: { show: false },
    xAxis: {
      ...b.xAxis,
      type: 'category' as const,
      data: order.map((o) => o[0].toUpperCase() + o.slice(1, 4)),
      boundaryGap: true,
    },
    yAxis: { ...b.yAxis, max: 105 },
    series: [
      {
        type: 'bar',
        data: order.map((o) => ({
          value: +(f[o] * 100).toFixed(1),
          itemStyle: { color: OUTCOME_COLOR[o] },
        })),
        barWidth: '60%',
        label: {
          show: true,
          position: 'top',
          formatter: (p: { value: number }) => `${p.value.toFixed(0)}%`,
          color: colors.fgMute,
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
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
  onInterveneStarted?: (newRunId: string | null) => void;
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
        onInterveneStarted?.(r.runId ?? null);
      } else if (scenario) {
        // Preview path — re-run WMTR only.
        await api.runWmtr({ scenario, intervention: interv });
        onInterveneStarted?.(null);
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
