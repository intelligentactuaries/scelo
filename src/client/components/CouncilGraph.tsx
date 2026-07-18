import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { GraphChart } from 'echarts/charts';
import { LegendComponent, TooltipComponent, TitleComponent, GridComponent, GraphicComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { Run, CouncilAgentResult } from '../../shared/types';
import { colorsForTheme, PROFESSIONS, professionColor, type Profession, type ThemeColors } from '../../shared/constants';
import { useTheme } from '../lib/theme';
import { layoutCells, forceClusterLayout, type Group, type FNode, type FEdge } from '../lib/groupLayout';
import { installGroupHulls, type HullDatum } from '../lib/groupHulls';
import { STANCE_LABEL, stanceColors } from '../lib/stance';

echarts.use([GraphChart, LegendComponent, TooltipComponent, TitleComponent, GridComponent, GraphicComponent, CanvasRenderer]);

/** Cross-chart highlight payload.
 *
 *  - `key`   uniquely identifies the source item (e.g. `node:c-finance-intp-f`,
 *            `edge:prof:Finance|stance:oppose`). Used so a second click on
 *            the same item clears the lock.
 *  - `locked` distinguishes a sticky click-lock from an ephemeral hover.
 *            While locked, neither chart's hover listeners write state. */
export type CrossHighlight = {
  source: 'graph' | 'sankey' | 'legend' | 'group';
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
  const { resolved } = useTheme();
  const colors = useMemo(() => colorsForTheme(resolved), [resolved]);
  // Measured canvas size drives the labelled-region grid layout; it's remeasured
  // on container resize so the region boxes always fill the panel.
  const [size, setSize] = useState({ w: 0, h: 0 });
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

  const built = useMemo(() => buildOption(run, colors, size, resolved === 'dark'), [run, colors, size, resolved]);
  const option = built.option;

  // Agents per profession — for legend → cross-highlight emission and for
  // lighting the legend chips when a highlight (from anywhere) is active.
  const profAgents = useMemo(() => {
    const m = new Map<Profession, string[]>();
    for (const r of run.councilResults) {
      const a = m.get(r.agent.profession) ?? [];
      a.push(r.agent.id);
      m.set(r.agent.profession, a);
    }
    return m;
  }, [run]);
  const profAgentsRef = useRef(profAgents);
  useEffect(() => {
    profAgentsRef.current = profAgents;
  }, [profAgents]);

  // Which professions are represented in the current highlight (drives the chip
  // glow, so a Sankey/graph selection lights the matching legend entries).
  const activeProfs = useMemo(() => {
    const s = new Set<string>();
    if (crossHighlight && crossHighlight.agentIds.length) {
      const byId = new Map(run.councilResults.map((r) => [r.agent.id, r.agent.profession] as const));
      for (const id of crossHighlight.agentIds) {
        const p = byId.get(id);
        if (p) s.add(p);
      }
    }
    return s;
  }, [crossHighlight, run]);
  const highlightActive = !!crossHighlight && crossHighlight.agentIds.length > 0;
  // A *legend* hover should light only the hovered chip (the rest grey out); a
  // graph / Sankey / group highlight lights every profession it represents.
  const legendSrc = crossHighlight?.source === 'legend';
  const chKey = crossHighlight?.key ?? '';
  const chipActive = (p: Profession) => (legendSrc ? chKey === `legend:${p}` : activeProfs.has(p));

  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const chart = echarts.init(el, null, { renderer: 'canvas' });
    chartRef.current = chart;
    chart.setOption(option);
    // Reflow the canvas immediately on resize, but debounce the size *state*
    // update — that rebuilds the option (which re-runs the force layout), so we
    // only want it once the drag settles, not on every intermediate width.
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

    // Emit cross-chart hover (ephemeral). Skipped while a lock is active so the
    // user's pinned focus is sacred. A short debounce on mouse-out clears the
    // highlight promptly when the pointer leaves an item, while a new hover
    // within the window cancels the pending clear — so moving between adjacent
    // items doesn't flicker, but releasing resets fast. (We can't rely on the
    // pointer reaching blank canvas anymore: the group hulls now cover it.)
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
    // Pointer left an item — schedule a quick clear (a new hover cancels it).
    chart.on('mouseout', () => {
      cancelClear();
      clearTimer = setTimeout(() => clearEphemeralHover(), 60);
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
      // Only the genuine "out of window" case — when the related target
      // is null and the pointer is at the document edge.
      if (!ev.relatedTarget) clearEphemeralHover();
    };
    document.addEventListener('mouseleave', onDocLeave);

    // Node positions are now deterministic (labelled-region grid, layout:'none'),
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

  // Draggable, hoverable group hulls. Reinstalled whenever the layout rebuilds
  // (the effect owns the `graphic` component; the option-effect above no longer
  // touches graphic, so the two don't fight). Runs after the option-effect.
  useEffect(() => {
    const chart = chartRef.current;
    const el = ref.current;
    if (!chart || !el) return;
    return installGroupHulls(chart, el, built.hulls, built.basePos, resolved === 'dark', {
      // Hovering a hull emits a group cross-highlight: the graph lights the
      // group's nodes + all attached edges, and the Sankey + legend react too.
      onHover: (memberIds, key) =>
        onCrossHighlightRef.current?.({ source: 'group', agentIds: memberIds, key: `group:${key}`, locked: false }),
      onLeave: () => {
        const cur = crossHighlightRef.current;
        if (cur && cur.source === 'group' && !cur.locked) onCrossHighlightRef.current?.(null);
      },
    });
  }, [built, resolved]);

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
    applyAgentFocus(chart, new Set(crossHighlight.agentIds), crossHighlight.source === 'group' ? 'touch' : 'within');
  }, [crossHighlight]);

  // Legend hover/click flow through the shared cross-highlight so the graph AND
  // the Sankey react (and the chip lights via `activeProfs`). Hover is ephemeral;
  // click pins (opens the group inspector) with a locked highlight.
  const onLegendEnter = useCallback((p: Profession) => {
    if (pinnedRef.current) return; // pin takes precedence
    onCrossHighlightRef.current?.({ source: 'legend', agentIds: profAgentsRef.current.get(p) ?? [], key: `legend:${p}`, locked: false });
  }, []);

  const onLegendLeave = useCallback(() => {
    if (pinnedRef.current) return; // pin survives mouse-out
    const cur = crossHighlightRef.current;
    if (cur && cur.source === 'legend' && !cur.locked) onCrossHighlightRef.current?.(null);
  }, []);

  const onLegendClick = useCallback(
    (p: Profession): void => {
      if (pinnedRef.current === p) {
        onPinnedProfessionChange(null);
        onCrossHighlightRef.current?.(null);
      } else {
        onPinnedProfessionChange(p);
        onCrossHighlightRef.current?.({ source: 'legend', agentIds: profAgentsRef.current.get(p) ?? [], key: `legend:${p}`, locked: true });
      }
    },
    [onPinnedProfessionChange],
  );

  return (
    <>
      <div ref={ref} className="graph-canvas" />
      <div className="graph-legend graph-legend-horizontal" onMouseLeave={onLegendLeave}>
        {PROFESSIONS.map((p) => (
          <span
            key={p}
            className={`graph-legend-item ${pinned === p ? 'is-pinned' : ''}${highlightActive ? (chipActive(p) ? ' is-active' : ' is-muted') : ''}`}
            onMouseEnter={() => onLegendEnter(p)}
            onClick={() => onLegendClick(p)}
            role="button"
            tabIndex={0}
          >
            <i style={{ background: professionColor(p, resolved === 'dark') }} />
            <span className="graph-legend-item-label">{p}</span>
          </span>
        ))}
      </div>
    </>
  );
}

function buildOption(
  run: Run,
  colors: ThemeColors,
  size: { w: number; h: number },
  dark: boolean,
): { option: echarts.EChartsCoreOption; hulls: HullDatum[]; basePos: Map<string, { x: number; y: number }> } {
  const STANCE_BORDER = stanceColors(colors);
  const categories = PROFESSIONS.map((p) => ({ name: p, itemStyle: { color: professionColor(p, dark) } }));
  const profIndex = new Map(PROFESSIONS.map((p, i) => [p, i] as const));

  // ─── Group cells ─────────────────────────────────────────────────────
  // One cell per profession present in this run, tiled across the canvas. Each
  // cell centre becomes the anchor for that profession's clump (see below), so
  // the graph reads as grouped shaded regions rather than a force-scattered cloud.
  const present = PROFESSIONS.filter((p) => run.councilResults.some((r) => r.agent.profession === p));
  const groups: Group[] = present.map((p) => ({ key: p, label: p, color: professionColor(p, dark) }));
  const W = size.w > 0 ? size.w : 900;
  const H = size.h > 0 ? size.h : 600;
  const cells = layoutCells(groups, W, H);
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

  // ─── Force layout, clustered by profession ───────────────────────────
  // A small force sim gives each profession an organic clump (connected agents
  // drift together, no rigid rows) around its cell centre, then wraps each
  // settled cluster in a soft translucent hull. Nodes/edges read as the original
  // force graph; the hulls add the grouping.
  const fnodes: FNode[] = run.councilResults.map((r) => ({ id: r.agent.id, group: r.agent.profession, r: sizeFor(r.agent.id) / 2 }));
  const fedges: FEdge[] = run.councilEdges.map((e) => ({ source: e.source, target: e.target }));
  const { pos: nodePos, groupCircle } = forceClusterLayout(fnodes, fedges, cells, W, H);

  // Per-group edge statistics (shown when a hull is hovered).
  const profOf = new Map(run.councilResults.map((r) => [r.agent.id, r.agent.profession]));
  const stanceById = new Map(run.councilResults.map((r) => [r.agent.id, r.finalStance]));
  const membersByProf = new Map<string, string[]>();
  for (const r of run.councilResults) {
    const a = membersByProf.get(r.agent.profession) ?? [];
    a.push(r.agent.id);
    membersByProf.set(r.agent.profession, a);
  }
  const stat = new Map<string, { internal: number; external: number; wSum: number }>();
  const ensureStat = (p: string) => stat.get(p) ?? (stat.set(p, { internal: 0, external: 0, wSum: 0 }), stat.get(p)!);
  for (const e of run.councilEdges) {
    const pa = profOf.get(e.source), pb = profOf.get(e.target);
    if (pa == null || pb == null) continue;
    if (pa === pb) { const s = ensureStat(pa); s.internal++; s.wSum += e.value; }
    else { ensureStat(pa).external++; ensureStat(pb).external++; }
  }
  const hulls: HullDatum[] = cells.map((c) => {
    const g = groupCircle.get(c.key) ?? { cx: c.cx, cy: c.cy, r: 30 };
    const ids = membersByProf.get(c.key) ?? [];
    const s = stat.get(c.key) ?? { internal: 0, external: 0, wSum: 0 };
    const counts: Record<string, number> = { support: 0, oppose: 0, abstain: 0 };
    for (const id of ids) { const st = stanceById.get(id); if (st) counts[st]++; }
    const domStance = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] as CouncilAgentResult['finalStance'];
    const avg = s.internal ? s.wSum / s.internal : 0;
    const statsHtml =
      `<b style="color:${c.color}">${escapeHtml(c.label)}</b><br/>` +
      `${ids.length} agent${ids.length === 1 ? '' : 's'} · mostly <b>${STANCE_LABEL[domStance]}</b> the forecast<br/>` +
      `<span style="opacity:.7">shared-reasoning edges</span><br/>` +
      `within group: <b>${s.internal}</b>${s.internal ? ` · avg agreement <b>${avg.toFixed(2)}</b>` : ''}<br/>` +
      `to other groups: <b>${s.external}</b>`;
    return { key: c.key, label: c.label, color: c.color, cx: g.cx, cy: g.cy, r: g.r, memberIds: ids, statsHtml };
  });

  const nodes = run.councilResults.map((r) => {
    const size = sizeFor(r.agent.id);
    const pos = nodePos.get(r.agent.id) ?? { x: W / 2, y: H / 2 };
    return {
      id: r.agent.id,
      name: `${r.agent.profession.slice(0, 4).toLowerCase()}/${r.agent.mbti}/${r.agent.gender}`,
      category: profIndex.get(r.agent.profession) ?? 0,
      // On cartesian2d the node position comes from `value: [x, y]`.
      value: [pos.x, pos.y],
      // Headline confidence moved off `value` (now the coord) — tooltip reads `conf`.
      conf: r.finalConfidence,
      symbolSize: size,
      // `degree` is preserved for the inspector / debug overlays if we want
      // to surface "this hub talks to N other agents at average weight W".
      degree: weightedDegree.get(r.agent.id) ?? 0,
      itemStyle: {
        color: professionColor(r.agent.profession, dark),
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

  const option: echarts.EChartsCoreOption = {
    backgroundColor: 'transparent',
    // Hidden cartesian grid fills the panel; the graph nodes and the hulls (drawn
    // by installGroupHulls) share these axes, so they align exactly — no
    // force-layout auto-fit to fight. yAxis inverted → pixel coords map 1:1.
    grid: { left: 0, right: 0, top: 0, bottom: 0 },
    xAxis: { type: 'value', min: 0, max: W, show: false, silent: true },
    yAxis: { type: 'value', min: 0, max: H, inverse: true, show: false, silent: true },
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
            agent: { id: string; profession: string; mbti: string; gender: string };
            stance: string;
            conf: number;
            keyRisk: string;
          };
          return `${d.agent.id}<br/>${d.agent.profession} · ${d.agent.mbti} · ${d.agent.gender}<br/>verdict: <b>${STANCE_LABEL[d.stance as CouncilAgentResult['finalStance']]}s the forecast</b> · conf: <b>${d.conf}</b><br/>risk: ${escapeHtml(d.keyRisk).slice(0, 100)}`;
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
            ? `verdict: both <b>${STANCE_LABEL[a.finalStance]}</b>`
            : `verdict: <b>${STANCE_LABEL[a.finalStance]}</b> vs <b>${STANCE_LABEL[b.finalStance]}</b>`;
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
        coordinateSystem: 'cartesian2d', // nodes positioned by value:[x,y]
        z: 3,
        animation: false,
        legendHoverLink: false,         // custom legend chips handle hover focus
        label: {
          show: true,                   // labels visible by default; hideOverlap thins them
          color: colors.fg,
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
        // `color: 'source'` paints each edge with its source-node category colour —
        // a Finance→Investor edge reads as Finance-blue, etc. Curveness 0.2 keeps
        // the bend organic without spaghetti in the dense council layout.
        lineStyle: { color: 'source', curveness: 0.2, opacity: 0.7 },
      },
    ],
  };

  return { option, hulls, basePos: nodePos };
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
function applyAgentFocus(chart: echarts.ECharts, ids: Set<string>, edgeMode: 'within' | 'touch' = 'within') {
  const opt = chart.getOption() as { series: Array<{ data: Array<Record<string, unknown> & { id: string }>; edges: Array<Record<string, unknown> & { source: string; target: string }> }> };
  const series = opt.series?.[0];
  if (!series) return;
  const nextData = series.data.map((n) => {
    const match = ids.has(n.id);
    return { ...n, itemStyle: { ...(n.itemStyle as object | undefined), opacity: match ? 1 : 0.1 } };
  });
  const nextEdges = series.edges.map((e) => {
    // 'within' = edge fully inside the set (default); 'touch' = at least one
    // endpoint in the set — used for group-hull hover so EVERY edge attached to
    // the group's members lights up, not just internal ones.
    const on = edgeMode === 'touch' ? ids.has(e.source) || ids.has(e.target) : ids.has(e.source) && ids.has(e.target);
    return { ...e, lineStyle: { ...(e.lineStyle as object | undefined), opacity: on ? 0.85 : 0.04 } };
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
