import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { GraphChart } from 'echarts/charts';
import { LegendComponent, TooltipComponent, TitleComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { Run, CouncilAgentResult } from '../../shared/types';
import { COLORS, PROFESSIONS, PROFESSION_PALETTE, type Profession } from '../../shared/constants';

echarts.use([GraphChart, LegendComponent, TooltipComponent, TitleComponent, CanvasRenderer]);

const STANCE_BORDER: Record<CouncilAgentResult['finalStance'], string> = {
  support: COLORS.consensus,
  oppose: COLORS.adversarial,
  abstain: COLORS.muted,
};

/** Cross-chart highlight payload.
 *
 *  - `key`   uniquely identifies the source item (e.g. `node:c-finance-intp-f`,
 *            `edge:prof:Finance|stance:oppose`). Used so a second click on
 *            the same item clears the lock.
 *  - `locked` distinguishes a sticky click-lock from an ephemeral hover.
 *            While locked, neither chart's hover listeners write state. */
export type CrossHighlight = {
  source: 'graph' | 'sankey';
  agentIds: string[];
  key: string;
  locked: boolean;
} | null;

type Props = {
  run: Run;
  selectedAgentId: string | null;
  onSelectAgent: (id: string | null) => void;
  pinnedProfession: Profession | null;
  onPinnedProfessionChange: (p: Profession | null) => void;
  crossHighlight?: CrossHighlight;
  onCrossHighlight?: (h: CrossHighlight) => void;
};

export function CouncilGraph({
  run,
  selectedAgentId,
  onSelectAgent,
  pinnedProfession,
  onPinnedProfessionChange,
  crossHighlight,
  onCrossHighlight,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  // Keep the latest onCrossHighlight + crossHighlight in refs so the
  // chart.on(...) handlers (registered once on mount) always read the
  // live values without re-registering.
  const onCrossHighlightRef = useRef(onCrossHighlight);
  const crossHighlightRef = useRef(crossHighlight);
  useEffect(() => {
    onCrossHighlightRef.current = onCrossHighlight;
  }, [onCrossHighlight]);
  useEffect(() => {
    crossHighlightRef.current = crossHighlight;
  }, [crossHighlight]);

  const option = useMemo(() => buildOption(run), [run]);

  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const chart = echarts.init(el, null, { renderer: 'canvas' });
    chartRef.current = chart;
    chart.setOption(option);
    const handler = () => chart.resize();
    window.addEventListener('resize', handler);
    // Also reflow when the container itself changes width (panel drag, etc.)
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);

    // Click: select the agent for the decision sidebar, AND toggle a
    // cross-chart lock so the Sankey freezes on the matching path even
    // after the mouse leaves. Clicking the same item again unlocks.
    chart.on('click', (params) => {
      if (params.dataType === 'node' && params.data) {
        const id = (params.data as { id?: string }).id;
        if (id) onSelectAgent(id);
        const cb = onCrossHighlightRef.current;
        if (!cb || !id) return;
        const key = `node:${id}`;
        const cur = crossHighlightRef.current;
        if (cur?.locked && cur.key === key) cb(null);
        else cb({ source: 'graph', agentIds: [id], key, locked: true });
      } else if (params.dataType === 'edge' && params.data) {
        const e = params.data as { source: string; target: string };
        const cb = onCrossHighlightRef.current;
        if (!cb) return;
        const key = `edge:${e.source}|${e.target}`;
        const cur = crossHighlightRef.current;
        if (cur?.locked && cur.key === key) cb(null);
        else cb({ source: 'graph', agentIds: [e.source, e.target], key, locked: true });
      }
    });

    // Background click (no datum under cursor) clears any active lock.
    chart.getZr().on('click', (e) => {
      // zr `click` fires even when an item handler also fired; only act
      // if no series item was the target (target.parent.__ecComponentInfo
      // isn't a clean check; using `e.target` undefined is the reliable
      // signal that the click landed on empty canvas).
      if (e.target) return;
      const cb = onCrossHighlightRef.current;
      const cur = crossHighlightRef.current;
      if (cb && cur?.locked) cb(null);
    });

    // Emit cross-chart hover (ephemeral). Skipped while a lock is
    // active so the user's pinned focus is sacred. We deliberately do
    // NOT clear on per-item mouseout — that causes a null→new flicker
    // when the mouse moves between adjacent items. Instead we clear on
    // container mouseleave below so the preview persists smoothly
    // while the cursor stays inside the chart.
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
    // Clear ephemeral hovers when the cursor leaves the chart. Locked
    // highlights and Sankey-originated highlights survive.
    //
    // Belt-and-braces: DOM mouseleave isn't 100% reliable (cursor moves
    // fast onto browser chrome, layout shifts the chart away, the user
    // tabs out — any of those can leave a highlight stuck on screen).
    // We listen on FIVE channels and clear from any of them:
    //   1. echarts `globalout` — fires when echarts' own pointer
    //      tracking sees the cursor leave the chart's canvas area.
    //   2. DOM `mouseleave` on the container div.
    //   3. DOM `pointerleave` (covers pen + touch in addition to mouse).
    //   4. window `blur` — user switched tab / app while hovering.
    //   5. document `mouseleave` — pointer left the whole window.
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
      // Only the genuine "out of window" case — when the related target
      // is null and the pointer is at the document edge.
      if (!ev.relatedTarget) clearEphemeralHover();
    };
    document.addEventListener('mouseleave', onDocLeave);

    // After the force layout has cooled, pin every node at its resting
    // position with fixed:true so the simulation stops touching it.
    // No ongoing drift — the graph settles and stays settled.
    type Anchor = { id: string; x: number; y: number };
    let anchors: Anchor[] = [];
    let pinTimer: ReturnType<typeof setTimeout> | undefined;
    let lastDataId: string | undefined;

    const captureAndPin = () => {
      const c = chartRef.current;
      if (!c) return;
      try {
        const m = (c as unknown as { getModel: () => unknown }).getModel() as {
          getSeriesByIndex: (i: number) => { getGraph: () => { eachNode: (cb: (n: { id: string; getLayout: () => [number, number] | null }) => void) => void } };
        };
        const series = m.getSeriesByIndex(0);
        const graph = series.getGraph();
        const next: Anchor[] = [];
        graph.eachNode((node) => {
          const layout = node.getLayout();
          if (!layout) return;
          next.push({ id: String(node.id), x: layout[0], y: layout[1] });
        });
        if (next.length === 0) return;
        anchors = next;
        lastDataId = next[0].id;

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
      } catch {
        /* model not ready */
      }
    };

    // Re-check on a slow heartbeat so a new run (different data ids)
    // re-captures and re-pins. We don't move anything per tick.
    const tick = () => {
      const c = chartRef.current;
      if (c) {
        const opt = c.getOption() as {
          series: Array<{ data: Array<Record<string, unknown> & { id: string }> }>;
        };
        const data = opt.series?.[0]?.data ?? [];
        if (data.length > 0 && (anchors.length === 0 || data[0].id !== lastDataId)) {
          anchors = [];
          captureAndPin();
        }
      }
      pinTimer = setTimeout(tick, 4000);
    };
    pinTimer = setTimeout(tick, 8000); // give the force layout a full cool-down first

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

  // pinned profession is owned by the parent (App) so the rest of the UI can
  // react to a group filter being active — open a group inspector, etc.
  const pinned = pinnedProfession;
  const pinnedRef = useRef<Profession | null>(null);
  useEffect(() => {
    pinnedRef.current = pinned;
  }, [pinned]);

  // clear pin when the run changes; the old category may not exist in the new one
  useEffect(() => {
    onPinnedProfessionChange(null);
  }, [run.id, onPinnedProfessionChange]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.setOption(option, { notMerge: false });
    // option just rewrote node opacities to 1 — re-apply the pinned focus if any
    if (pinnedRef.current) applyLegendFocus(chart, pinnedRef.current);
  }, [option]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.dispatchAction({ type: 'unselect', seriesIndex: 0 });
    if (selectedAgentId) {
      const idx = run.councilResults.findIndex((r) => r.agent.id === selectedAgentId);
      if (idx >= 0) {
        chart.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: idx });
      }
    }
  }, [selectedAgentId, run]);

  // Apply the bold dim whenever any cross-highlight is active. Hover
  // preview and click-lock now share the same visual focus: the
  // matching agents stay full-strength, everything else fades — on
  // both this graph and the Sankey simultaneously.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (!crossHighlight) {
      if (pinnedRef.current) applyLegendFocus(chart, pinnedRef.current);
      else clearLegendFocus(chart);
      return;
    }
    applyAgentFocus(chart, new Set(crossHighlight.agentIds));
  }, [crossHighlight]);

  const onLegendEnter = useCallback((p: Profession) => {
    if (pinnedRef.current) return; // pin takes precedence
    const chart = chartRef.current;
    if (chart) applyLegendFocus(chart, p);
  }, []);

  const onLegendLeave = useCallback(() => {
    if (pinnedRef.current) return; // pin survives mouse-out
    const chart = chartRef.current;
    if (chart) clearLegendFocus(chart);
  }, []);

  const onLegendClick = useCallback((p: Profession): void => {
    const chart = chartRef.current;
    if (!chart) return;
    if (pinnedRef.current === p) {
      onPinnedProfessionChange(null);
      clearLegendFocus(chart);
    } else {
      onPinnedProfessionChange(p);
      applyLegendFocus(chart, p);
    }
  }, []);

  return (
    <>
      <div ref={ref} className="graph-canvas" />
      <div className="graph-legend graph-legend-horizontal" onMouseLeave={onLegendLeave}>
        {PROFESSIONS.map((p) => (
          <span
            key={p}
            className={`graph-legend-item ${pinned === p ? 'is-pinned' : ''}`}
            onMouseEnter={() => onLegendEnter(p)}
            onClick={() => onLegendClick(p)}
            role="button"
            tabIndex={0}
          >
            <i style={{ background: PROFESSION_PALETTE[p] }} />
            <span className="graph-legend-item-label">{p}</span>
          </span>
        ))}
      </div>
    </>
  );
}

function buildOption(run: Run): echarts.EChartsCoreOption {
  const categories = PROFESSIONS.map((p) => ({ name: p, itemStyle: { color: PROFESSION_PALETTE[p] } }));
  const profIndex = new Map(PROFESSIONS.map((p, i) => [p, i] as const));
  // edge-tooltip needs to resolve each endpoint id to its full record so we
  // can render both agents' professions / MBTI / stance side by side.
  const byId = new Map(run.councilResults.map((r) => [r.agent.id, r] as const));

  // ─── Node size = weighted degree (Les-Mis-style centrality) ──────────
  // Sum every edge's value at each endpoint — agents who form strong
  // consensus links with many others read as hubs (big), isolated
  // dissenters as tiny satellites. Exactly the variance Les Misérables
  // uses for Valjean vs. Champtercier.
  const weightedDegree = new Map<string, number>();
  for (const e of run.councilEdges) {
    weightedDegree.set(e.source, (weightedDegree.get(e.source) ?? 0) + e.value);
    weightedDegree.set(e.target, (weightedDegree.get(e.target) ?? 0) + e.value);
  }
  const degVals = Array.from(weightedDegree.values());
  const maxDeg = degVals.length ? Math.max(...degVals) : 1;
  const minDeg = degVals.length ? Math.min(...degVals) : 0;
  const degSpan = Math.max(maxDeg - minDeg, 0.0001);
  // Sqrt curve compresses the tail so a few outliers don't crush the rest.
  // Range: 6 px (isolated) → 38 px (most connected hub). ~6× variance,
  // close to Valjean / minor-character ratio in the les-mis sample.
  const sizeFor = (id: string) => {
    const d = (weightedDegree.get(id) ?? 0) - minDeg;
    const norm = Math.sqrt(d / degSpan);
    return 6 + norm * 32;
  };

  const nodes = run.councilResults.map((r) => {
    const size = sizeFor(r.agent.id);
    return {
      id: r.agent.id,
      name: `${r.agent.profession.slice(0, 4).toLowerCase()}/${r.agent.mbti}/${r.agent.gender}`,
      category: profIndex.get(r.agent.profession) ?? 0,
      symbolSize: size,
      // Tooltip still reports confidence as the headline `value`; keep it.
      value: r.finalConfidence,
      // `degree` is preserved for the inspector / debug overlays if we want
      // to surface "this hub talks to N other agents at average weight W".
      degree: weightedDegree.get(r.agent.id) ?? 0,
      itemStyle: {
        color: PROFESSION_PALETTE[r.agent.profession],
        borderColor: STANCE_BORDER[r.finalStance],
        borderWidth: 1.8,
        opacity: 1,
      },
      label: { show: false },
      agent: r.agent,
      stance: r.finalStance,
      keyRisk: r.keyRisk,
      profession: r.agent.profession,
    };
  });

  // Per-edge style: keep only width + opacity. The series-level lineStyle
  // owns `color: 'source'` — each edge picks up its source node's category
  // colour — far richer than the old uniform grey wires.
  const links = run.councilEdges.map((e) => ({
    source: e.source,
    target: e.target,
    value: e.value,
    lineStyle: { opacity: 0.7, width: Math.max(0.8, e.value * 1.8) },
  }));

  return {
    backgroundColor: 'transparent',
    // Smooth motion on data updates (legend pin, breathing, run swap).
    animationDuration: 1500,
    animationDurationUpdate: 1500,
    animationEasingUpdate: 'quinticInOut',
    tooltip: {
      trigger: 'item',
      confine: true,
      enterable: false,
      showDelay: 0,
      hideDelay: 60,
      // liquid-glass tooltip — clear surface, the blur + saturate do the
      // heavy lifting so the canvas reads through behind the card.
      backgroundColor: 'rgba(255, 255, 255, 0.18)',
      borderColor: 'rgba(255, 255, 255, 0.7)',
      borderWidth: 1,
      extraCssText:
        'box-shadow: 0 8px 28px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.85);' +
        'border-radius: 10px;' +
        '-webkit-backdrop-filter: blur(8px) saturate(140%); backdrop-filter: blur(8px) saturate(140%);',
      textStyle: { color: COLORS.fg, fontFamily: 'SN Pro, system-ui, sans-serif', fontSize: 12 },
      formatter: (p: { dataType?: string; data?: Record<string, unknown> }) => {
        if (!p.data) return '';
        if (p.dataType === 'node') {
          const d = p.data as {
            agent: { id: string; profession: string; mbti: string; gender: string };
            stance: string;
            value: number;
            keyRisk: string;
          };
          return `${d.agent.id}<br/>${d.agent.profession} · ${d.agent.mbti} · ${d.agent.gender}<br/>stance: <b>${d.stance}</b> · conf: <b>${d.value}</b><br/>risk: ${escapeHtml(d.keyRisk).slice(0, 100)}`;
        }
        if (p.dataType === 'edge') {
          const e = p.data as { source: string; target: string; value: number };
          const a = byId.get(e.source);
          const b = byId.get(e.target);
          if (!a || !b) return '';
          const stancesMatch = a.finalStance === b.finalStance;
          const score = typeof e.value === 'number' ? e.value.toFixed(2) : '—';
          // The edge weight is `0.5 · stance-match + 0.5 · token-Jaccard(round-2
          // rationale)` — see server/agents/edges.ts. We surface both halves so
          // the hover explains *why* the wire was drawn instead of just showing
          // a magic number.
          const stanceLine = stancesMatch
            ? `stances: both <b>${a.finalStance}</b>`
            : `stances: <b>${a.finalStance}</b> vs <b>${b.finalStance}</b>`;
          return [
            `<b>shared-reasoning edge</b>`,
            `${a.agent.id} ↔ ${b.agent.id}`,
            `${a.agent.profession} · ${a.agent.mbti}  ·  ${b.agent.profession} · ${b.agent.mbti}`,
            stanceLine,
            `agreement: <b>${score}</b>`,
            `<span style="opacity:0.75">drawn when the two agents share a stance and/or<br/>overlap in round-2 reasoning. Thicker = stronger overlap.</span>`,
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
        roamTrigger: 'global',          // pan/zoom anywhere in the viewport
        scaleLimit: { min: 0.4, max: 8 },
        draggable: true,
        legendHoverLink: false,         // custom legend chips handle hover focus
        label: {
          show: true,                   // labels visible by default; hideOverlap thins them
          color: COLORS.fg,
          fontFamily: 'SN Pro, system-ui, sans-serif',
          fontSize: 11,
          fontWeight: 500,
          position: 'right',
          formatter: '{b}',
        },
        // Auto-hide labels that would collide. Remaining ones reveal on zoom —
        // solves "256 labels overlap into noise" without losing the always-on baseline.
        labelLayout: { hideOverlap: true },
        emphasis: {
          focus: 'adjacency',
          label: { show: true },
          // Don't override colour here — let source colouring stay; just thicken on hover.
          lineStyle: { width: 4, opacity: 1 },
        },
        blur: {
          itemStyle: { opacity: 0.12 },
          lineStyle: { opacity: 0.04 },
          label: { show: false },
        },
        categories,
        data: nodes,
        edges: links,
        force: { edgeLength: 18, repulsion: 55, gravity: 0.12, layoutAnimation: true },
        // `color: 'source'` paints each edge with its source-node category colour —
        // a Finance→Investor edge reads as Finance-blue, etc. Curveness 0.2 keeps
        // the bend organic without spaghetti in the dense council layout.
        lineStyle: { color: 'source', curveness: 0.2, opacity: 0.7 },
      },
    ],
  };
}

function applyLegendFocus(chart: echarts.ECharts, profession: Profession) {
  const opt = chart.getOption() as { series: Array<{ data: Array<Record<string, unknown> & { id: string; profession?: string }>; edges: Array<Record<string, unknown> & { source: string; target: string }> }> };
  const series = opt.series?.[0];
  if (!series) return;
  const matchIds = new Set<string>();
  const nextData = series.data.map((n) => {
    const match = n.profession === profession;
    if (match) matchIds.add(n.id);
    return { ...n, itemStyle: { ...(n.itemStyle as object | undefined), opacity: match ? 1 : 0.1 } };
  });
  const nextEdges = series.edges.map((e) => {
    const touches = matchIds.has(e.source) || matchIds.has(e.target);
    return { ...e, lineStyle: { ...(e.lineStyle as object | undefined), opacity: touches ? 0.85 : 0.04 } };
  });
  chart.setOption({ series: [{ data: nextData, edges: nextEdges }] }, { lazyUpdate: true });
}

// Cross-highlight from the Sankey: dim every node NOT in the agent set,
// dim every edge whose endpoints aren't both inside. Uses the same opacity
// budget as the legend focus so the two paths can't fight each other.
function applyAgentFocus(chart: echarts.ECharts, ids: Set<string>) {
  const opt = chart.getOption() as { series: Array<{ data: Array<Record<string, unknown> & { id: string }>; edges: Array<Record<string, unknown> & { source: string; target: string }> }> };
  const series = opt.series?.[0];
  if (!series) return;
  const nextData = series.data.map((n) => {
    const match = ids.has(n.id);
    return { ...n, itemStyle: { ...(n.itemStyle as object | undefined), opacity: match ? 1 : 0.1 } };
  });
  const nextEdges = series.edges.map((e) => {
    const touches = ids.has(e.source) && ids.has(e.target);
    return { ...e, lineStyle: { ...(e.lineStyle as object | undefined), opacity: touches ? 0.85 : 0.04 } };
  });
  chart.setOption({ series: [{ data: nextData, edges: nextEdges }] }, { lazyUpdate: true });
}

function clearLegendFocus(chart: echarts.ECharts) {
  const opt = chart.getOption() as { series: Array<{ data: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> }> };
  const series = opt.series?.[0];
  if (!series) return;
  const nextData = series.data.map((n) => ({
    ...n,
    itemStyle: { ...(n.itemStyle as object | undefined), opacity: 1 },
  }));
  const nextEdges = series.edges.map((e) => ({
    ...e,
    lineStyle: { ...(e.lineStyle as object | undefined), opacity: 0.85 },
  }));
  chart.setOption({ series: [{ data: nextData, edges: nextEdges }] }, { lazyUpdate: true });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}
