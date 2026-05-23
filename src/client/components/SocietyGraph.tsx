import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { GraphChart } from 'echarts/charts';
import { LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { Run, Sentiment } from '../../shared/types';
import { colorsForTheme, type ThemeColors } from '../../shared/constants';
import { useTheme } from '../lib/theme';
import type { CrossHighlight } from './CouncilGraph';

echarts.use([GraphChart, LegendComponent, TooltipComponent, CanvasRenderer]);

function sentimentColor(c: ThemeColors): Record<Sentiment, string> {
  return {
    enthusiastic: c.consensus,
    supportive: '#7fef7c',
    neutral: c.fg,
    skeptical: c.dissent,
    hostile: c.adversarial,
  };
}

const SENTIMENT_ORDER: Sentiment[] = ['enthusiastic', 'supportive', 'neutral', 'skeptical', 'hostile'];

const CLUSTER_PALETTE = ['#4a9eff', '#b388ff', '#7fc8ff', '#ffd866', '#a0a0a0', '#5fdfb3'];

// External pin: lifted to App so the Decision Sidebar can react to
// what's pinned in the legend (cluster name or sentiment value).
export type SocietyPin =
  | { kind: 'cluster'; name: string }
  | { kind: 'sentiment'; name: Sentiment };

type Props = {
  run: Run;
  pinned: SocietyPin | null;
  onPinnedChange: (p: SocietyPin | null) => void;
  crossHighlight?: CrossHighlight;
  onCrossHighlight?: (h: CrossHighlight) => void;
};

type ClusterChip = {
  name: string;
  color: string;
};

export function SocietyGraph({
  run,
  pinned: externalPinned,
  onPinnedChange,
  crossHighlight,
  onCrossHighlight,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const { resolved } = useTheme();
  const colors = useMemo(() => colorsForTheme(resolved), [resolved]);
  const SENTIMENT_COLOR = useMemo(() => sentimentColor(colors), [colors]);

  // Live cross-highlight callback + state held in refs so the
  // chart.on(...) listeners (registered once on mount) keep seeing the
  // current values without re-registering.
  const onCrossHighlightRef = useRef(onCrossHighlight);
  const crossHighlightRef = useRef(crossHighlight);
  useEffect(() => {
    onCrossHighlightRef.current = onCrossHighlight;
  }, [onCrossHighlight]);
  useEffect(() => {
    crossHighlightRef.current = crossHighlight;
  }, [crossHighlight]);

  const { option, clusterChips } = useMemo(() => buildOption(run, colors), [run, colors]);

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

    // Click toggles a sticky cross-chart lock; clicking the same item
    // again, or an empty patch of canvas, unlocks.
    chart.on('click', (params) => {
      const cb = onCrossHighlightRef.current;
      if (!cb) return;
      if (params.dataType === 'node' && params.data) {
        const id = (params.data as { id?: string }).id;
        if (!id) return;
        const key = `node:${id}`;
        const cur = crossHighlightRef.current;
        if (cur?.locked && cur.key === key) cb(null);
        else cb({ source: 'graph', agentIds: [id], key, locked: true });
      } else if (params.dataType === 'edge' && params.data) {
        const e = params.data as { source: string; target: string };
        const key = `edge:${e.source}|${e.target}`;
        const cur = crossHighlightRef.current;
        if (cur?.locked && cur.key === key) cb(null);
        else cb({ source: 'graph', agentIds: [e.source, e.target], key, locked: true });
      }
    });
    chart.getZr().on('click', (e) => {
      if (e.target) return;
      const cb = onCrossHighlightRef.current;
      const cur = crossHighlightRef.current;
      if (cb && cur?.locked) cb(null);
    });

    // Hover (ephemeral) — suppressed while a lock is active. Clearing
    // happens on container mouseleave (below) rather than per-item
    // mouseout so the preview doesn't null-flicker as the mouse moves
    // between adjacent members.
    chart.on('mouseover', (params) => {
      const cb = onCrossHighlightRef.current;
      if (!cb || crossHighlightRef.current?.locked) return;
      if (params.dataType === 'node' && params.data) {
        const id = (params.data as { id?: string }).id;
        if (id) cb({ source: 'graph', agentIds: [id], key: `node:${id}`, locked: false });
      } else if (params.dataType === 'edge' && params.data) {
        const e = params.data as { source: string; target: string };
        cb({ source: 'graph', agentIds: [e.source, e.target], key: `edge:${e.source}|${e.target}`, locked: false });
      }
    });
    // Belt-and-braces clear path — see CouncilGraph for the rationale.
    // Any of (echarts globalout, DOM mouseleave, pointerleave, window
    // blur, document mouseleave) clears the ephemeral hover.
    const clearEphemeralHover = () => {
      const cb = onCrossHighlightRef.current;
      const cur = crossHighlightRef.current;
      if (cb && cur && !cur.locked && cur.source === 'graph') cb(null);
    };
    chart.on('globalout', clearEphemeralHover);
    el.addEventListener('mouseleave', clearEphemeralHover);
    el.addEventListener('pointerleave', clearEphemeralHover);
    window.addEventListener('blur', clearEphemeralHover);
    const onDocLeave = (ev: MouseEvent) => {
      if (!ev.relatedTarget) clearEphemeralHover();
    };
    document.addEventListener('mouseleave', onDocLeave);

    // After the force layout cools, pin every node at its converged
    // position with fixed:true so the simulation stops touching them.
    // No ongoing drift — the network settles and stays settled.
    type Anchor = { id: string; x: number; y: number };
    let anchors: Anchor[] = [];
    let lastDataId: string | undefined;
    let pinnedAll = false;
    let pinTimer: ReturnType<typeof setTimeout> | undefined;

    const captureAnchors = () => {
      const c = chartRef.current;
      if (!c) return;
      try {
        const m = (c as unknown as { getModel: () => unknown }).getModel() as {
          getSeriesByIndex: (i: number) => {
            getGraph: () => {
              eachNode: (
                cb: (n: { id: string; getLayout: () => [number, number] | null }) => void,
              ) => void;
            };
          };
        };
        const series = m.getSeriesByIndex(0);
        const graph = series.getGraph();
        const next: Anchor[] = [];
        graph.eachNode((node) => {
          const layout = node.getLayout();
          if (!layout) return;
          next.push({ id: String(node.id), x: layout[0], y: layout[1] });
        });
        if (next.length > 0) {
          anchors = next;
          lastDataId = next[0].id;
          pinnedAll = false;
        }
      } catch {
        /* model not ready */
      }
    };

    const pinAllToAnchors = () => {
      const c = chartRef.current;
      if (!c || anchors.length === 0) return;
      const opt = c.getOption() as {
        series: Array<{ data: Array<Record<string, unknown> & { id: string }> }>;
      };
      const data = opt.series?.[0]?.data ?? [];
      const byId = new Map(anchors.map((a) => [a.id, a] as const));
      const nextData = data.map((d) => {
        const a = byId.get(d.id);
        if (!a) return d;
        return { ...d, fixed: true, x: a.x, y: a.y };
      });
      c.setOption({ series: [{ data: nextData }] }, { lazyUpdate: true });
      pinnedAll = true;
    };

    // Slow heartbeat that only re-pins on a brand-new run (data ids
    // change). No periodic motion otherwise.
    const tick = () => {
      const c = chartRef.current;
      if (c) {
        const opt = c.getOption() as {
          series: Array<{ data: Array<Record<string, unknown> & { id: string }> }>;
        };
        const data = opt.series?.[0]?.data ?? [];
        if (data.length > 0 && (anchors.length === 0 || data[0].id !== lastDataId)) {
          anchors = [];
          captureAnchors();
        }
        if (anchors.length > 0 && !pinnedAll) {
          pinAllToAnchors();
        }
      }
      pinTimer = setTimeout(tick, 4000);
    };
    pinTimer = setTimeout(tick, 9000);

    return () => {
      window.removeEventListener('resize', handler);
      window.removeEventListener('blur', clearEphemeralHover);
      el.removeEventListener('mouseleave', clearEphemeralHover);
      el.removeEventListener('pointerleave', clearEphemeralHover);
      document.removeEventListener('mouseleave', onDocLeave);
      ro.disconnect();
      if (pinTimer) clearTimeout(pinTimer);
      chart.dispose();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // mutually-exclusive pin across the two legends in this graph — lifted
  // to App.tsx so the Decision Sidebar can render whichever group the
  // user has selected. External prop is the source of truth.
  const pinned = externalPinned;
  const pinnedRef = useRef<SocietyPin | null>(null);
  useEffect(() => {
    pinnedRef.current = pinned;
  }, [pinned]);

  // Clear the pin when the run changes — different agents, old pin's id
  // may not exist.
  useEffect(() => {
    onPinnedChange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.setOption(option, { notMerge: false });
    const p = pinnedRef.current;
    if (p?.kind === 'cluster') applySocietyLegendFocus(chart, p.name);
    else if (p?.kind === 'sentiment') applySocietySentimentFocus(chart, p.name);
  }, [option]);

  // Apply the bold dim on every cross-highlight (hover preview AND
  // click-lock) — they should produce the same visual focus. Pinned
  // cluster / sentiment focus restores when the highlight clears.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (!crossHighlight) {
      const p = pinnedRef.current;
      if (p?.kind === 'cluster') applySocietyLegendFocus(chart, p.name);
      else if (p?.kind === 'sentiment') applySocietySentimentFocus(chart, p.name);
      else clearSocietyLegendFocus(chart);
      return;
    }
    applySocietyAgentFocus(chart, new Set(crossHighlight.agentIds));
  }, [crossHighlight]);

  const onLegendEnter = useCallback((name: string) => {
    if (pinnedRef.current) return;
    const chart = chartRef.current;
    if (chart) applySocietyLegendFocus(chart, name);
  }, []);

  const onLegendLeave = useCallback(() => {
    if (pinnedRef.current) return;
    const chart = chartRef.current;
    if (chart) clearSocietyLegendFocus(chart);
  }, []);

  const onLegendClick = useCallback((name: string) => {
    const chart = chartRef.current;
    if (!chart) return;
    const cur = pinnedRef.current;
    if (cur?.kind === 'cluster' && cur.name === name) {
      onPinnedChange(null);
      clearSocietyLegendFocus(chart);
    } else {
      onPinnedChange({ kind: 'cluster', name });
      applySocietyLegendFocus(chart, name);
    }
  }, []);

  const onSentimentEnter = useCallback((s: Sentiment) => {
    if (pinnedRef.current) return;
    const chart = chartRef.current;
    if (chart) applySocietySentimentFocus(chart, s);
  }, []);

  const onSentimentLeave = useCallback(() => {
    if (pinnedRef.current) return;
    const chart = chartRef.current;
    if (chart) clearSocietyLegendFocus(chart);
  }, []);

  const onSentimentClick = useCallback((s: Sentiment) => {
    const chart = chartRef.current;
    if (!chart) return;
    const cur = pinnedRef.current;
    if (cur?.kind === 'sentiment' && cur.name === s) {
      onPinnedChange(null);
      clearSocietyLegendFocus(chart);
    } else {
      onPinnedChange({ kind: 'sentiment', name: s });
      applySocietySentimentFocus(chart, s);
    }
  }, []);

  if (!run.societyResults.length) {
    return (
      <div className="empty-state">
        <div className="muted small">no society results yet</div>
      </div>
    );
  }

  return (
    <>
      <div ref={ref} className="graph-canvas" />
      <div className="graph-legend graph-legend-vertical" onMouseLeave={onLegendLeave}>
        {clusterChips.map((c) => {
          const isPinned = pinned?.kind === 'cluster' && pinned.name === c.name;
          return (
            <span
              key={c.name}
              className={`graph-legend-item ${isPinned ? 'is-pinned' : ''}`}
              onMouseEnter={() => onLegendEnter(c.name)}
              onClick={() => onLegendClick(c.name)}
              role="button"
              tabIndex={0}
            >
              <i style={{ background: c.color }} />
              <span className="graph-legend-item-label">{c.name}</span>
            </span>
          );
        })}
      </div>
      <div className="sentiment-key" onMouseLeave={onSentimentLeave}>
        <div className="sentiment-key-label">sentiment</div>
        {SENTIMENT_ORDER.map((s) => {
          const isPinned = pinned?.kind === 'sentiment' && pinned.name === s;
          return (
            <span
              key={s}
              className={`sentiment-pip ${isPinned ? 'is-pinned' : ''}`}
              onMouseEnter={() => onSentimentEnter(s)}
              onClick={() => onSentimentClick(s)}
              role="button"
              tabIndex={0}
            >
              <i style={{ background: SENTIMENT_COLOR[s] }} />
              {s}
            </span>
          );
        })}
      </div>
    </>
  );
}

function buildOption(run: Run, colors: ThemeColors): { option: echarts.EChartsCoreOption; clusterChips: ClusterChip[] } {
  const SENTIMENT_COLOR = sentimentColor(colors);
  const clusterIds = new Set<number>();
  for (const r of run.societyResults) if (r.cluster !== undefined) clusterIds.add(r.cluster);
  const clusters = [...clusterIds].sort((a, b) => a - b);
  const catIndex = new Map(clusters.map((c, i) => [c, i] as const));
  // edge-tooltip needs each endpoint's full record (sentiment / cluster /
  // demographics) so the hover can explain *why* the two members are linked.
  const byId = new Map(run.societyResults.map((r) => [r.agent.id, r] as const));

  const categories = clusters.map((c, i) => {
    const desc = run.societySummary?.clusters.find((x) => x.cluster === c)?.description ?? '';
    return {
      name: `c${c} ${truncate(desc, 36)}`,
      itemStyle: { color: CLUSTER_PALETTE[i % CLUSTER_PALETTE.length] },
    };
  });

  const clusterChips: ClusterChip[] = categories.map((c, i) => ({
    name: c.name,
    color: CLUSTER_PALETTE[i % CLUSTER_PALETTE.length],
  }));

  const nodes = run.societyResults.map((r) => {
    const size = 5 + (r.intensity / 100) * 7;
    return {
      id: r.agent.id,
      name: r.agent.id,
      category: catIndex.get(r.cluster ?? 0) ?? 0,
      symbolSize: size,
      value: r.intensity,
      itemStyle: { color: SENTIMENT_COLOR[r.sentiment], opacity: 0.92 },
      label: { show: false },
      sentiment: r.sentiment,
      reaction: r.reaction,
      cluster: r.cluster,
      catName: categories[catIndex.get(r.cluster ?? 0) ?? 0]?.name ?? '',
      age: r.agent.age,
      income: r.agent.incomeBand,
      edu: r.agent.education,
      region: r.agent.region,
      emp: r.agent.employment,
    };
  });

  // Connective-tissue edges in theme-aware muted tone so they don't
  // compete with the node palette on either background.
  const links = run.societyEdges.map((e) => ({
    source: e.source,
    target: e.target,
    value: e.value,
    lineStyle: { color: colors.muted, opacity: 0.5, width: 0.9 },
  }));

  const option: echarts.EChartsCoreOption = {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      confine: true,
      enterable: false,
      showDelay: 0,
      hideDelay: 60,
      // theme-aware tooltip — opaque enough to read on either background,
      // blur + saturate keep the glass feel.
      backgroundColor: colors.tooltipBg,
      borderColor: colors.tooltipBorder,
      borderWidth: 1,
      extraCssText:
        'box-shadow: 0 8px 28px rgba(0,0,0,0.18);' +
        'border-radius: 10px;' +
        '-webkit-backdrop-filter: blur(8px) saturate(140%); backdrop-filter: blur(8px) saturate(140%);',
      textStyle: { color: colors.tooltipText, fontFamily: 'SN Pro, system-ui, sans-serif', fontSize: 12 },
      formatter: (p: { dataType?: string; data?: Record<string, unknown> }) => {
        if (!p.data) return '';
        if (p.dataType === 'node') {
          const d = p.data as {
            id: string;
            sentiment: string;
            reaction: string;
            cluster: number;
            age: number;
            income: string;
            edu: string;
            region: string;
            emp: string;
            value: number;
          };
          return `${d.id} · cluster c${d.cluster}<br/>${d.age}y · ${d.income} · ${d.edu} · ${d.region} · ${d.emp}<br/><b>${d.sentiment}</b> · intensity ${d.value}<br/><i>${escapeHtml(d.reaction).slice(0, 200)}</i>`;
        }
        if (p.dataType === 'edge') {
          const e = p.data as { source: string; target: string; value: number };
          const a = byId.get(e.source);
          const b = byId.get(e.target);
          if (!a || !b) return '';
          const sameCluster = a.cluster === b.cluster;
          const sameSentiment = a.sentiment === b.sentiment;
          // Society edges are within-cluster k-NN on the demographic+sentiment
          // feature vector — see server/agents/society_cluster.ts. value =
          // 1 − min(1, distance²), so higher = closer.
          const prox = typeof e.value === 'number' ? e.value.toFixed(2) : '—';
          const sentLine = sameSentiment
            ? `sentiment: both <b>${a.sentiment}</b>`
            : `sentiment: <b>${a.sentiment}</b> vs <b>${b.sentiment}</b>`;
          return [
            `<b>peer-similarity edge</b>`,
            `${a.agent.id} ↔ ${b.agent.id}`,
            sameCluster ? `cluster: <b>c${a.cluster}</b>` : `cluster: <b>c${a.cluster}</b> vs <b>c${b.cluster}</b>`,
            `${a.agent.age}y · ${a.agent.incomeBand} · ${a.agent.region}`,
            `${b.agent.age}y · ${b.agent.incomeBand} · ${b.agent.region}`,
            sentLine,
            `proximity: <b>${prox}</b>`,
            `<span style="opacity:0.75">drawn between nearest neighbours inside the same<br/>demographic-sentiment cluster. Higher = more alike.</span>`,
          ].join('<br/>');
        }
        return '';
      },
    },
    series: [
      {
        type: 'graph',
        layout: 'force',
        animation: false,
        roam: true,
        scaleLimit: { min: 0.3, max: 8 },
        draggable: true,
        label: { show: false },
        emphasis: { focus: 'adjacency' },
        blur: {
          itemStyle: { opacity: 0.08 },
          lineStyle: { opacity: 0.03 },
          label: { show: false },
        },
        categories,
        data: nodes,
        edges: links,
        force: { edgeLength: 8, repulsion: 35, gravity: 0.15, layoutAnimation: true },
        lineStyle: { color: colors.muted, opacity: 0.4 },
      },
    ],
  };

  return { option, clusterChips };
}

function applySocietyLegendFocus(chart: echarts.ECharts, catName: string) {
  const opt = chart.getOption() as { series: Array<{ data: Array<Record<string, unknown> & { id: string; catName?: string }>; edges: Array<Record<string, unknown> & { source: string; target: string }> }> };
  const series = opt.series?.[0];
  if (!series) return;
  const matchIds = new Set<string>();
  const nextData = series.data.map((n) => {
    const match = n.catName === catName;
    if (match) matchIds.add(n.id);
    return { ...n, itemStyle: { ...(n.itemStyle as object | undefined), opacity: match ? 0.95 : 0.06 } };
  });
  const nextEdges = series.edges.map((e) => {
    const touches = matchIds.has(e.source) && matchIds.has(e.target);
    return { ...e, lineStyle: { ...(e.lineStyle as object | undefined), opacity: touches ? 0.75 : 0.04 } };
  });
  chart.setOption({ series: [{ data: nextData, edges: nextEdges }] }, { lazyUpdate: true });
}

function applySocietySentimentFocus(chart: echarts.ECharts, sentiment: Sentiment) {
  const opt = chart.getOption() as { series: Array<{ data: Array<Record<string, unknown> & { id: string; sentiment?: Sentiment }>; edges: Array<Record<string, unknown> & { source: string; target: string }> }> };
  const series = opt.series?.[0];
  if (!series) return;
  const matchIds = new Set<string>();
  const nextData = series.data.map((n) => {
    const match = n.sentiment === sentiment;
    if (match) matchIds.add(n.id);
    return { ...n, itemStyle: { ...(n.itemStyle as object | undefined), opacity: match ? 0.95 : 0.06 } };
  });
  const nextEdges = series.edges.map((e) => {
    const touches = matchIds.has(e.source) && matchIds.has(e.target);
    return { ...e, lineStyle: { ...(e.lineStyle as object | undefined), opacity: touches ? 0.75 : 0.04 } };
  });
  chart.setOption({ series: [{ data: nextData, edges: nextEdges }] }, { lazyUpdate: true });
}

function clearSocietyLegendFocus(chart: echarts.ECharts) {
  const opt = chart.getOption() as { series: Array<{ data: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> }> };
  const series = opt.series?.[0];
  if (!series) return;
  const nextData = series.data.map((n) => ({
    ...n,
    itemStyle: { ...(n.itemStyle as object | undefined), opacity: 0.92 },
  }));
  const nextEdges = series.edges.map((e) => ({
    ...e,
    lineStyle: { ...(e.lineStyle as object | undefined), opacity: 0.75 },
  }));
  chart.setOption({ series: [{ data: nextData, edges: nextEdges }] }, { lazyUpdate: true });
}

// Cross-chart highlight from the society Sankey: dim every node NOT in
// the agent set, and every edge whose endpoints aren't both inside.
function applySocietyAgentFocus(chart: echarts.ECharts, ids: Set<string>) {
  const opt = chart.getOption() as { series: Array<{ data: Array<Record<string, unknown> & { id: string }>; edges: Array<Record<string, unknown> & { source: string; target: string }> }> };
  const series = opt.series?.[0];
  if (!series) return;
  const nextData = series.data.map((n) => {
    const match = ids.has(n.id);
    return { ...n, itemStyle: { ...(n.itemStyle as object | undefined), opacity: match ? 0.95 : 0.08 } };
  });
  const nextEdges = series.edges.map((e) => {
    const touches = ids.has(e.source) && ids.has(e.target);
    return { ...e, lineStyle: { ...(e.lineStyle as object | undefined), opacity: touches ? 0.75 : 0.04 } };
  });
  chart.setOption({ series: [{ data: nextData, edges: nextEdges }] }, { lazyUpdate: true });
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}
