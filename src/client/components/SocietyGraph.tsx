import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { GraphChart } from 'echarts/charts';
import { LegendComponent, TooltipComponent, GridComponent, GraphicComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { Run, Sentiment } from '../../shared/types';
import { colorsForTheme, type ThemeColors } from '../../shared/constants';
import { useTheme } from '../lib/theme';
import type { CrossHighlight } from './CouncilGraph';
import { layoutCells, forceClusterLayout, type Group, type FNode, type FEdge } from '../lib/groupLayout';
import { installGroupHulls, type HullDatum } from '../lib/groupHulls';

echarts.use([GraphChart, LegendComponent, TooltipComponent, GridComponent, GraphicComponent, CanvasRenderer]);

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
// Light-theme overrides: c3 (amber) and c5 (mint) wash out on a light ground, so
// they get darker variants there. All other clusters — and the whole dark-theme
// palette — are unchanged.
const CLUSTER_PALETTE_LIGHT = ['#4a9eff', '#b388ff', '#7fc8ff', '#c99700', '#a0a0a0', '#1f9e7b'];
const clusterColor = (i: number, dark: boolean) =>
  (dark ? CLUSTER_PALETTE : CLUSTER_PALETTE_LIGHT)[i % CLUSTER_PALETTE.length];

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
  // Measured canvas size drives the labelled-region (cluster) grid layout.
  const [size, setSize] = useState({ w: 0, h: 0 });

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

  const { option, clusterChips, hulls, basePos, clusterAgents, sentimentAgents, catOf, sentOf } = useMemo(
    () => buildOption(run, colors, size, resolved === 'dark'),
    [run, colors, size, resolved],
  );
  const clusterAgentsRef = useRef(clusterAgents);
  const sentimentAgentsRef = useRef(sentimentAgents);
  useEffect(() => {
    clusterAgentsRef.current = clusterAgents;
    sentimentAgentsRef.current = sentimentAgents;
  }, [clusterAgents, sentimentAgents]);

  // Which clusters / sentiments are represented in the current highlight — so a
  // graph, Sankey, or legend selection lights the matching legend entries.
  const activeClusters = useMemo(() => {
    const s = new Set<string>();
    if (crossHighlight && crossHighlight.agentIds.length) {
      for (const id of crossHighlight.agentIds) {
        const c = catOf.get(id);
        if (c) s.add(c);
      }
    }
    return s;
  }, [crossHighlight, catOf]);
  const activeSentiments = useMemo(() => {
    const s = new Set<string>();
    if (crossHighlight && crossHighlight.agentIds.length) {
      for (const id of crossHighlight.agentIds) {
        const se = sentOf.get(id);
        if (se) s.add(se);
      }
    }
    return s;
  }, [crossHighlight, sentOf]);
  const highlightActive = !!crossHighlight && crossHighlight.agentIds.length > 0;
  // A *legend* hover lights only the hovered entry (greying the rest of BOTH
  // legends); a graph / Sankey / group highlight lights every entry it contains.
  const legendSrc = crossHighlight?.source === 'legend';
  const chKey = crossHighlight?.key ?? '';
  const clusterActive = (name: string) => (legendSrc ? chKey === `legend:cluster:${name}` : activeClusters.has(name));
  const sentimentActive = (s: Sentiment) => (legendSrc ? chKey === `legend:sentiment:${s}` : activeSentiments.has(s));

  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const chart = echarts.init(el, null, { renderer: 'canvas' });
    chartRef.current = chart;
    chart.setOption(option);
    // Reflow the canvas immediately on resize, but debounce the size *state*
    // update — that re-runs the force layout, so only do it once the drag settles.
    const applySize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    };
    let sizeTimer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      chart.resize();
      if (sizeTimer) clearTimeout(sizeTimer);
      sizeTimer = setTimeout(applySize, 140);
    };
    applySize();
    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver(onResize);
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

    // Hover (ephemeral) — suppressed while a lock is active. A short debounce on
    // mouse-out clears it promptly on release, while a new hover within the
    // window cancels the pending clear (no flicker moving between adjacent
    // members). The group hulls now cover blank canvas, so we can't wait for the
    // pointer to reach empty space to trigger the clear.
    let clearTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelClear = () => {
      if (clearTimer) {
        clearTimeout(clearTimer);
        clearTimer = undefined;
      }
    };
    chart.on('mouseover', (params) => {
      cancelClear();
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
    chart.on('mouseout', () => {
      cancelClear();
      clearTimer = setTimeout(() => clearEphemeralHover(), 60);
    });
    // Belt-and-braces clear path — see CouncilGraph for the rationale.
    // Any of (echarts globalout, DOM mouseleave, pointerleave, window
    // blur, document mouseleave) clears the ephemeral hover.
    const clearEphemeralHover = () => {
      cancelClear();
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

    // Node positions are now deterministic (cluster-region grid, layout:'none'),
    // so the old force-cooldown capture-and-pin heartbeat is gone.

    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('blur', clearEphemeralHover);
      el.removeEventListener('mouseleave', clearEphemeralHover);
      el.removeEventListener('pointerleave', clearEphemeralHover);
      document.removeEventListener('mouseleave', onDocLeave);
      cancelClear();
      if (sizeTimer) clearTimeout(sizeTimer);
      ro.disconnect();
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

  // Draggable, hoverable cluster hulls. Owns the `graphic` component; runs after
  // the option-effect (which no longer touches graphic), reinstalling on rebuild.
  useEffect(() => {
    const chart = chartRef.current;
    const el = ref.current;
    if (!chart || !el) return;
    return installGroupHulls(chart, el, hulls, basePos, resolved === 'dark', {
      onHover: (memberIds, key) =>
        onCrossHighlightRef.current?.({ source: 'group', agentIds: memberIds, key: `group:${key}`, locked: false }),
      onLeave: () => {
        const cur = crossHighlightRef.current;
        if (cur && cur.source === 'group' && !cur.locked) onCrossHighlightRef.current?.(null);
      },
    });
  }, [hulls, basePos, resolved]);

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
    applySocietyAgentFocus(chart, new Set(crossHighlight.agentIds), crossHighlight.source === 'group' ? 'touch' : 'within');
  }, [crossHighlight]);

  // Both legends flow through the shared cross-highlight so the graph AND the
  // Sankey react, and the chips/pips glow via activeClusters / activeSentiments.
  const onLegendEnter = useCallback((name: string) => {
    if (pinnedRef.current) return;
    onCrossHighlightRef.current?.({ source: 'legend', agentIds: clusterAgentsRef.current.get(name) ?? [], key: `legend:cluster:${name}`, locked: false });
  }, []);

  const onLegendLeave = useCallback(() => {
    if (pinnedRef.current) return;
    const cur = crossHighlightRef.current;
    if (cur && cur.source === 'legend' && !cur.locked) onCrossHighlightRef.current?.(null);
  }, []);

  const onLegendClick = useCallback(
    (name: string) => {
      const cur = pinnedRef.current;
      if (cur?.kind === 'cluster' && cur.name === name) {
        onPinnedChange(null);
        onCrossHighlightRef.current?.(null);
      } else {
        onPinnedChange({ kind: 'cluster', name });
        onCrossHighlightRef.current?.({ source: 'legend', agentIds: clusterAgentsRef.current.get(name) ?? [], key: `legend:cluster:${name}`, locked: true });
      }
    },
    [onPinnedChange],
  );

  const onSentimentEnter = useCallback((s: Sentiment) => {
    if (pinnedRef.current) return;
    onCrossHighlightRef.current?.({ source: 'legend', agentIds: sentimentAgentsRef.current.get(s) ?? [], key: `legend:sentiment:${s}`, locked: false });
  }, []);

  const onSentimentLeave = useCallback(() => {
    if (pinnedRef.current) return;
    const cur = crossHighlightRef.current;
    if (cur && cur.source === 'legend' && !cur.locked) onCrossHighlightRef.current?.(null);
  }, []);

  const onSentimentClick = useCallback(
    (s: Sentiment) => {
      const cur = pinnedRef.current;
      if (cur?.kind === 'sentiment' && cur.name === s) {
        onPinnedChange(null);
        onCrossHighlightRef.current?.(null);
      } else {
        onPinnedChange({ kind: 'sentiment', name: s });
        onCrossHighlightRef.current?.({ source: 'legend', agentIds: sentimentAgentsRef.current.get(s) ?? [], key: `legend:sentiment:${s}`, locked: true });
      }
    },
    [onPinnedChange],
  );

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
              className={`graph-legend-item ${isPinned ? 'is-pinned' : ''}${highlightActive ? (clusterActive(c.name) ? ' is-active' : ' is-muted') : ''}`}
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
              className={`sentiment-pip ${isPinned ? 'is-pinned' : ''}${highlightActive ? (sentimentActive(s) ? ' is-active' : ' is-muted') : ''}`}
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

function buildOption(
  run: Run,
  colors: ThemeColors,
  size: { w: number; h: number },
  dark: boolean,
): {
  option: echarts.EChartsCoreOption;
  clusterChips: ClusterChip[];
  hulls: HullDatum[];
  basePos: Map<string, { x: number; y: number }>;
  clusterAgents: Map<string, string[]>;
  sentimentAgents: Map<string, string[]>;
  catOf: Map<string, string>;
  sentOf: Map<string, string>;
} {
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
      itemStyle: { color: clusterColor(i, dark) },
    };
  });

  const clusterChips: ClusterChip[] = categories.map((c, i) => ({
    name: c.name,
    color: clusterColor(i, dark),
  }));

  // ─── Cluster clumps + shaded hulls ───────────────────────────────────
  // One cell per cluster tiles the canvas; each cluster's members pack into an
  // organic disc around its cell centre, with a soft translucent hull (coloured
  // by cluster, matching the legend) behind it. Node fill stays sentiment-based,
  // so each hull shows a cluster's sentiment mix at a glance.
  const groups: Group[] = clusters.map((c, i) => ({
    key: String(c),
    label: categories[i].name,
    color: clusterColor(i, dark),
  }));
  const W = size.w > 0 ? size.w : 900;
  const H = size.h > 0 ? size.h : 600;
  const cells = layoutCells(groups, W, H);
  // A small force sim clusters each cluster's members organically around its
  // cell centre (peer-similarity edges pull neighbours together), then a soft
  // hull wraps each settled cluster — force-graph look, plus the grouping.
  const fnodes: FNode[] = run.societyResults.map((r) => ({
    id: r.agent.id,
    group: String(r.cluster ?? 0),
    r: (5 + (r.intensity / 100) * 7) / 2,
  }));
  const fedges: FEdge[] = run.societyEdges.map((e) => ({ source: e.source, target: e.target }));
  const { pos: nodePos, groupCircle } = forceClusterLayout(fnodes, fedges, cells, W, H);

  // Per-cluster edge statistics (shown when a hull is hovered).
  const cluOf = new Map(run.societyResults.map((r) => [r.agent.id, String(r.cluster ?? 0)]));
  const sentById = new Map(run.societyResults.map((r) => [r.agent.id, r.sentiment]));
  const membersByClu = new Map<string, string[]>();
  for (const r of run.societyResults) {
    const k = String(r.cluster ?? 0);
    const a = membersByClu.get(k) ?? [];
    a.push(r.agent.id);
    membersByClu.set(k, a);
  }
  const sstat = new Map<string, { internal: number; external: number; wSum: number }>();
  const ensureS = (k: string) => sstat.get(k) ?? (sstat.set(k, { internal: 0, external: 0, wSum: 0 }), sstat.get(k)!);
  for (const e of run.societyEdges) {
    const ka = cluOf.get(e.source), kb = cluOf.get(e.target);
    if (ka == null || kb == null) continue;
    if (ka === kb) { const s = ensureS(ka); s.internal++; s.wSum += e.value; }
    else { ensureS(ka).external++; ensureS(kb).external++; }
  }
  const hulls: HullDatum[] = cells.map((c) => {
    const g = groupCircle.get(c.key) ?? { cx: c.cx, cy: c.cy, r: 30 };
    const ids = membersByClu.get(c.key) ?? [];
    const s = sstat.get(c.key) ?? { internal: 0, external: 0, wSum: 0 };
    const counts = new Map<string, number>();
    for (const id of ids) { const se = sentById.get(id); if (se) counts.set(se, (counts.get(se) ?? 0) + 1); }
    const domSent = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';
    const avg = s.internal ? s.wSum / s.internal : 0;
    const statsHtml =
      `<b style="color:${c.color}">${escapeHtml(c.label)}</b><br/>` +
      `${ids.length} member${ids.length === 1 ? '' : 's'} · mostly <b>${domSent}</b><br/>` +
      `<span style="opacity:.7">peer-similarity edges</span><br/>` +
      `within cluster: <b>${s.internal}</b>${s.internal ? ` · avg proximity <b>${avg.toFixed(2)}</b>` : ''}<br/>` +
      `to other clusters: <b>${s.external}</b>`;
    return { key: c.key, label: c.label, color: c.color, cx: g.cx, cy: g.cy, r: g.r, memberIds: ids, statsHtml };
  });

  // Agent index by cluster (catName) and by sentiment — powers legend ↔ graph ↔
  // Sankey cross-highlighting (emit on legend hover; glow chips on any highlight).
  const clusterAgents = new Map<string, string[]>();
  const sentimentAgents = new Map<string, string[]>();
  const catOf = new Map<string, string>();
  const sentOf = new Map<string, string>();
  for (const r of run.societyResults) {
    const cn = categories[catIndex.get(r.cluster ?? 0) ?? 0]?.name ?? '';
    catOf.set(r.agent.id, cn);
    const ca = clusterAgents.get(cn) ?? [];
    ca.push(r.agent.id);
    clusterAgents.set(cn, ca);
    sentOf.set(r.agent.id, r.sentiment);
    const sa = sentimentAgents.get(r.sentiment) ?? [];
    sa.push(r.agent.id);
    sentimentAgents.set(r.sentiment, sa);
  }

  const nodes = run.societyResults.map((r) => {
    const size = 5 + (r.intensity / 100) * 7;
    const pos = nodePos.get(r.agent.id) ?? { x: W / 2, y: H / 2 };
    return {
      id: r.agent.id,
      name: r.agent.id,
      category: catIndex.get(r.cluster ?? 0) ?? 0,
      // On cartesian2d the node position comes from `value: [x, y]`.
      value: [pos.x, pos.y],
      // Intensity moved off `value` (now the coord) — tooltip reads `intensity`.
      intensity: r.intensity,
      symbolSize: size,
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
    // Hidden cartesian grid fills the panel; nodes and hulls (drawn by
    // installGroupHulls) share these axes so they align exactly. yAxis inverted →
    // pixel-space coords (y grows downward) map 1:1 to the canvas.
    grid: { left: 0, right: 0, top: 0, bottom: 0 },
    xAxis: { type: 'value', min: 0, max: W, show: false, silent: true },
    yAxis: { type: 'value', min: 0, max: H, inverse: true, show: false, silent: true },
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
            intensity: number;
          };
          return `${d.id} · cluster c${d.cluster}<br/>${d.age}y · ${d.income} · ${d.edu} · ${d.region} · ${d.emp}<br/><b>${d.sentiment}</b> · intensity ${d.intensity}<br/><i>${escapeHtml(d.reaction).slice(0, 200)}</i>`;
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
        coordinateSystem: 'cartesian2d', // nodes positioned by value:[x,y]
        z: 3,
        animation: false,
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
        lineStyle: { color: colors.muted, opacity: 0.4 },
      },
    ],
  };

  return { option, clusterChips, hulls, basePos: nodePos, clusterAgents, sentimentAgents, catOf, sentOf };
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
function applySocietyAgentFocus(chart: echarts.ECharts, ids: Set<string>, edgeMode: 'within' | 'touch' = 'within') {
  const opt = chart.getOption() as { series: Array<{ data: Array<Record<string, unknown> & { id: string }>; edges: Array<Record<string, unknown> & { source: string; target: string }> }> };
  const series = opt.series?.[0];
  if (!series) return;
  const nextData = series.data.map((n) => {
    const match = ids.has(n.id);
    return { ...n, itemStyle: { ...(n.itemStyle as object | undefined), opacity: match ? 0.95 : 0.08 } };
  });
  const nextEdges = series.edges.map((e) => {
    // 'touch' = any endpoint in the set (group-hull hover lights every attached
    // edge); 'within' = both endpoints in the set (default).
    const on = edgeMode === 'touch' ? ids.has(e.source) || ids.has(e.target) : ids.has(e.source) && ids.has(e.target);
    return { ...e, lineStyle: { ...(e.lineStyle as object | undefined), opacity: on ? 0.75 : 0.04 } };
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
