import { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts/core';
import { SankeyChart } from 'echarts/charts';
import { TooltipComponent, TitleComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { Run, Sentiment, SocietyAgentResult } from '../../shared/types';
import { colorsForTheme, type ThemeColors } from '../../shared/constants';
import { useTheme } from '../lib/theme';
import { SENTIMENT_ORDER, clusterColor, sentimentColors } from '../lib/societyPalette';
import type { CrossHighlight } from './CouncilGraph';

echarts.use([SankeyChart, TooltipComponent, TitleComponent, CanvasRenderer]);

// Bird's-eye society flow: Cluster → Sentiment → Intensity band.
// Each link width = number of society members. Reads left-to-right as
// "this demographic cluster reacted with this sentiment at this
// intensity."

type Props = {
  run: Run;
  crossHighlight?: CrossHighlight;
  onCrossHighlight?: (h: CrossHighlight) => void;
};

type IntBand = 'High ≥70' | 'Mid 40–69' | 'Low <40';
function intColor(c: ThemeColors): Record<IntBand, string> {
  return {
    'High ≥70': c.consensus,
    'Mid 40–69': c.dissent,
    'Low <40': c.muted,
  };
}

function intBand(i: number): IntBand {
  if (i >= 70) return 'High ≥70';
  if (i >= 40) return 'Mid 40–69';
  return 'Low <40';
}

export function SocietySankey({ run, crossHighlight, onCrossHighlight }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const { resolved } = useTheme();
  const colors = useMemo(() => colorsForTheme(resolved), [resolved]);

  const option = useMemo(() => buildOption(run, colors, resolved === 'dark'), [run, colors, resolved]);

  const onCrossHighlightRef = useRef(onCrossHighlight);
  const crossHighlightRef = useRef(crossHighlight);
  // Mount-time chart handlers must read the CURRENT run — a re-run reuses
  // agent ids, so a stale closure silently maps highlights through the old
  // run's clusters/stances.
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  }, [run]);
  useEffect(() => {
    onCrossHighlightRef.current = onCrossHighlight;
  }, [onCrossHighlight]);
  useEffect(() => {
    crossHighlightRef.current = crossHighlight;
  }, [crossHighlight]);

  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const chart = echarts.init(el, null, { renderer: 'canvas' });
    chartRef.current = chart;
    chart.setOption(option);
    const handler = () => chart.resize();
    window.addEventListener('resize', handler);
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);

    chart.on('click', (params) => {
      const cb = onCrossHighlightRef.current;
      if (!cb) return;
      if (params.dataType === 'node' && params.name) {
        const name = String(params.name);
        const ids = agentsForSankeyNode(name, runRef.current);
        const key = `node:${name}`;
        const cur = crossHighlightRef.current;
        if (cur?.locked && cur.key === key) cb(null);
        else cb({ source: 'sankey', agentIds: ids, key, locked: true });
      } else if (params.dataType === 'edge' && params.data) {
        const e = params.data as { source: string; target: string };
        const ids = agentsForSankeyLink(e.source, e.target, runRef.current);
        const key = `edge:${e.source}|${e.target}`;
        const cur = crossHighlightRef.current;
        if (cur?.locked && cur.key === key) cb(null);
        else cb({ source: 'sankey', agentIds: ids, key, locked: true });
      }
    });
    chart.getZr().on('click', (e) => {
      if (e.target) return;
      const cb = onCrossHighlightRef.current;
      const cur = crossHighlightRef.current;
      if (cb && cur?.locked) cb(null);
    });

    // Ephemeral hover preview. Per-item mouseout would null-flicker the
    // state, so we clear on container mouseleave instead.
    chart.on('mouseover', (params) => {
      const cb = onCrossHighlightRef.current;
      if (!cb || crossHighlightRef.current?.locked) return;
      if (params.dataType === 'node' && params.name) {
        const name = String(params.name);
        const ids = agentsForSankeyNode(name, runRef.current);
        cb({ source: 'sankey', agentIds: ids, key: `node:${name}`, locked: false });
      } else if (params.dataType === 'edge' && params.data) {
        const e = params.data as { source: string; target: string };
        const ids = agentsForSankeyLink(e.source, e.target, runRef.current);
        cb({ source: 'sankey', agentIds: ids, key: `edge:${e.source}|${e.target}`, locked: false });
      }
    });
    // Belt-and-braces clear path — see CouncilGraph for the rationale.
    const clearEphemeralHover = () => {
      const cb = onCrossHighlightRef.current;
      const cur = crossHighlightRef.current;
      if (cb && cur && !cur.locked && cur.source === 'sankey') cb(null);
    };
    chart.on('globalout', clearEphemeralHover);
    el.addEventListener('mouseleave', clearEphemeralHover);
    el.addEventListener('pointerleave', clearEphemeralHover);
    window.addEventListener('blur', clearEphemeralHover);
    const onDocLeave = (ev: MouseEvent) => {
      if (!ev.relatedTarget) clearEphemeralHover();
    };
    document.addEventListener('mouseleave', onDocLeave);

    return () => {
      window.removeEventListener('resize', handler);
      window.removeEventListener('blur', clearEphemeralHover);
      el.removeEventListener('mouseleave', clearEphemeralHover);
      el.removeEventListener('pointerleave', clearEphemeralHover);
      document.removeEventListener('mouseleave', onDocLeave);
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const c = chartRef.current;
    if (!c) return;
    c.setOption(option, { notMerge: true });
  }, [option]);

  // Apply the bold dim on every cross-highlight (hover preview AND
  // click-lock) — same visual focus regardless of which chart
  // originated the highlight.
  useEffect(() => {
    const c = chartRef.current;
    if (!c) return;
    if (!crossHighlight) { applySankeyFocus(c, null, run); return; }
    applySankeyFocus(c, new Set(crossHighlight.agentIds), run);
  }, [crossHighlight, run]);

  return <div ref={ref} className="decision-sankey-canvas" />;
}

function buildOption(run: Run, colors: ThemeColors, dark: boolean): echarts.EChartsCoreOption {
  const total = Math.max(1, run.societyResults.length);
  const SENTIMENT_COLOR = sentimentColors(colors);
  const INT_COLOR = intColor(colors);

  const clusterIds = Array.from(
    new Set(run.societyResults.map((r) => r.cluster).filter((c): c is number => c !== undefined)),
  ).sort((a, b) => a - b);

  const clusterNodes = clusterIds.map((c, i) => ({
    name: `clu:c${c}`,
    label: { formatter: `c${c}`, color: colors.fg, fontSize: 11 },
    itemStyle: { color: clusterColor(i, dark) },
  }));
  const sentiments: Sentiment[] = SENTIMENT_ORDER;
  const sentimentNodes = sentiments.map((s) => ({
    name: `sent:${s}`,
    label: { formatter: s, color: colors.fg, fontSize: 11, fontWeight: 500 as const },
    itemStyle: { color: SENTIMENT_COLOR[s] },
  }));
  const bands: IntBand[] = ['High ≥70', 'Mid 40–69', 'Low <40'];
  const bandNodes = bands.map((b) => ({
    name: `int:${b}`,
    label: { formatter: b, color: colors.fg, fontSize: 11 },
    itemStyle: { color: INT_COLOR[b] },
  }));

  const clusterSent = new Map<string, number>();
  const sentInt = new Map<string, number>();
  for (const r of run.societyResults) {
    if (r.cluster === undefined) continue;
    const k1 = `c${r.cluster}|${r.sentiment}`;
    clusterSent.set(k1, (clusterSent.get(k1) ?? 0) + 1);
    const b = intBand(r.intensity ?? 0);
    const k2 = `${r.sentiment}|${b}`;
    sentInt.set(k2, (sentInt.get(k2) ?? 0) + 1);
  }
  const links: { source: string; target: string; value: number }[] = [];
  for (const [k, v] of clusterSent) {
    const [c, s] = k.split('|');
    links.push({ source: `clu:${c}`, target: `sent:${s}`, value: v });
  }
  for (const [k, v] of sentInt) {
    const [s, b] = k.split('|');
    links.push({ source: `sent:${s}`, target: `int:${b}`, value: v });
  }

  return {
    backgroundColor: 'transparent',
    // Supersonic — barely-there motion so the flow draws / re-flows near-instantly.
    animationDuration: 30,
    animationDurationUpdate: 20,
    animationEasing: 'linear',
    animationEasingUpdate: 'linear',
    tooltip: {
      trigger: 'item',
      confine: true,
      backgroundColor: colors.tooltipBg,
      borderColor: colors.tooltipBorder,
      borderWidth: 1,
      extraCssText:
        'box-shadow: 0 8px 28px rgba(0,0,0,0.18);' +
        'border-radius: 10px;' +
        '-webkit-backdrop-filter: blur(8px) saturate(140%); backdrop-filter: blur(8px) saturate(140%);',
      textStyle: { color: colors.tooltipText, fontFamily: 'SN Pro, system-ui, sans-serif', fontSize: 12 },
      formatter: (p: { dataType?: string; data?: Record<string, unknown>; name?: string; value?: number }) => {
        if (p.dataType === 'edge' && p.data) {
          const d = p.data as { source: string; target: string; value: number };
          const pct = ((d.value / total) * 100).toFixed(1);
          return `<b>${prettify(d.source)}</b> → <b>${prettify(d.target)}</b><br/>${d.value} of ${total} members · ${pct}%`;
        }
        if (p.dataType === 'node' && p.name) {
          const v = typeof p.value === 'number' ? p.value : 0;
          const pct = ((v / total) * 100).toFixed(1);
          return `<b>${prettify(p.name)}</b><br/>${v} members · ${pct}%`;
        }
        return '';
      },
    },
    series: [
      {
        type: 'sankey',
        top: 30,
        bottom: 14,
        left: 60,
        right: 90,
        nodeGap: 6,
        nodeWidth: 11,
        nodeAlign: 'justify',
        emphasis: { focus: 'adjacency' },
        lineStyle: { color: 'gradient', curveness: 0.5, opacity: 0.55 },
        label: { color: colors.fg, fontFamily: 'SN Pro, system-ui, sans-serif' },
        data: [...clusterNodes, ...sentimentNodes, ...bandNodes],
        links,
      },
    ],
  };
}

function prettify(s: string): string {
  return s.replace(/^(clu|sent|int):/, '');
}

// ─── Cross-chart highlight helpers ────────────────────────────────────

function agentsForSankeyNode(name: string, run: Run): string[] {
  if (name.startsWith('clu:')) {
    const cn = name.slice(4);  // e.g. "c3"
    const c = Number(cn.replace(/^c/, ''));
    return run.societyResults.filter((r) => r.cluster === c).map((r) => r.agent.id);
  }
  if (name.startsWith('sent:')) {
    const s = name.slice(5) as Sentiment;
    return run.societyResults.filter((r) => r.sentiment === s).map((r) => r.agent.id);
  }
  if (name.startsWith('int:')) {
    const b = name.slice(4) as IntBand;
    return run.societyResults.filter((r) => intBand(r.intensity ?? 0) === b).map((r) => r.agent.id);
  }
  return [];
}

function agentsForSankeyLink(source: string, target: string, run: Run): string[] {
  return run.societyResults
    .filter((r) => sankeyMatch(source, r) && sankeyMatch(target, r))
    .map((r) => r.agent.id);
}

function sankeyMatch(name: string, r: SocietyAgentResult): boolean {
  if (name.startsWith('clu:')) {
    const c = Number(name.slice(4).replace(/^c/, ''));
    return r.cluster === c;
  }
  if (name.startsWith('sent:')) return r.sentiment === (name.slice(5) as Sentiment);
  if (name.startsWith('int:')) return intBand(r.intensity ?? 0) === (name.slice(4) as IntBand);
  return false;
}

function applySankeyFocus(chart: echarts.ECharts, ids: Set<string> | null, run: Run) {
  const opt = chart.getOption() as { series: Array<{ data: Array<Record<string, unknown> & { name: string }>; links: Array<Record<string, unknown> & { source: string; target: string }> }> };
  const series = opt.series?.[0];
  if (!series) return;

  if (!ids) {
    const nextData = series.data.map((n) => ({
      ...n,
      itemStyle: { ...(n.itemStyle as object | undefined), opacity: 1 },
      label: { ...(n.label as object | undefined), opacity: 1 },
    }));
    const nextLinks = series.links.map((l) => ({
      ...l,
      lineStyle: { ...(l.lineStyle as object | undefined), opacity: 0.55 },
    }));
    chart.setOption({ series: [{ data: nextData, links: nextLinks }] }, { lazyUpdate: true });
    return;
  }

  const matching = run.societyResults.filter((r) => ids.has(r.agent.id));
  const clusters = new Set<number>();
  const sents = new Set<string>();
  const bands = new Set<string>();
  const linkSet = new Set<string>();
  for (const r of matching) {
    if (r.cluster !== undefined) clusters.add(r.cluster);
    sents.add(r.sentiment);
    const b = intBand(r.intensity ?? 0);
    bands.add(b);
    if (r.cluster !== undefined) linkSet.add(`clu:c${r.cluster}|sent:${r.sentiment}`);
    linkSet.add(`sent:${r.sentiment}|int:${b}`);
  }

  const nodeMatches = (name: string) => {
    if (name.startsWith('clu:')) {
      const c = Number(name.slice(4).replace(/^c/, ''));
      return clusters.has(c);
    }
    if (name.startsWith('sent:')) return sents.has(name.slice(5));
    if (name.startsWith('int:')) return bands.has(name.slice(4));
    return false;
  };

  const nextData = series.data.map((n) => {
    const hit = nodeMatches(n.name);
    return {
      ...n,
      itemStyle: { ...(n.itemStyle as object | undefined), opacity: hit ? 1 : 0.18 },
      label: { ...(n.label as object | undefined), opacity: hit ? 1 : 0.35 },
    };
  });
  const nextLinks = series.links.map((l) => {
    const hit = linkSet.has(`${l.source}|${l.target}`);
    return {
      ...l,
      lineStyle: { ...(l.lineStyle as object | undefined), opacity: hit ? 0.85 : 0.08 },
    };
  });
  chart.setOption({ series: [{ data: nextData, links: nextLinks }] }, { lazyUpdate: true });
}
