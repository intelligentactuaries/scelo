import { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts/core';
import { SankeyChart } from 'echarts/charts';
import { TooltipComponent, TitleComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { Run } from '../../shared/types';
import {
  colorsForTheme,
  PROFESSIONS,
  PROFESSION_PALETTE,
  type ThemeColors,
} from '../../shared/constants';
import { useTheme } from '../lib/theme';
import type { CrossHighlight } from './CouncilGraph';

echarts.use([SankeyChart, TooltipComponent, TitleComponent, CanvasRenderer]);

// Bird's-eye decision flow: Profession → Final stance → Confidence band.
// Each link width = number of council agents flowing through. Reads left-
// to-right as "this profession reached this stance with this conviction".
type Props = {
  run: Run;
  crossHighlight?: CrossHighlight;
  onCrossHighlight?: (h: CrossHighlight) => void;
};

function stanceColor(c: ThemeColors) {
  return {
    support: c.consensus,
    oppose: c.adversarial,
    abstain: c.muted,
  } as const;
}

type ConfBand = 'Confident ≥75' | 'Moderate 50–74' | 'Uncertain <50';
function confColor(c: ThemeColors): Record<ConfBand, string> {
  return {
    'Confident ≥75': c.consensus,
    'Moderate 50–74': c.dissent,
    'Uncertain <50': c.muted,
  };
}

function confBand(c: number): ConfBand {
  if (c >= 75) return 'Confident ≥75';
  if (c >= 50) return 'Moderate 50–74';
  return 'Uncertain <50';
}

export function DecisionSankey({ run, crossHighlight, onCrossHighlight }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const { resolved } = useTheme();
  const colors = useMemo(() => colorsForTheme(resolved), [resolved]);

  const option = useMemo(() => buildOption(run, colors), [run, colors]);

  // Keep the live callback + current state in refs so the chart.on(...)
  // handlers (registered once on mount) always see the live values.
  const onCrossHighlightRef = useRef(onCrossHighlight);
  const crossHighlightRef = useRef(crossHighlight);
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
    chart.showLoading({ text: '', color: colors.accent, textColor: colors.fg, maskColor: 'rgba(0,0,0,0)' });
    chart.hideLoading();
    chart.setOption(option);
    const handler = () => chart.resize();
    window.addEventListener('resize', handler);
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);

    // Click on a Sankey item: toggle a sticky lock. Hover still works
    // until something is locked; once locked, hover is ignored until
    // unlocked (by clicking the same item again, or the empty canvas).
    chart.on('click', (params) => {
      const cb = onCrossHighlightRef.current;
      if (!cb) return;
      if (params.dataType === 'node' && params.name) {
        const name = String(params.name);
        const ids = agentsForSankeyNode(name, run);
        const key = `node:${name}`;
        const cur = crossHighlightRef.current;
        if (cur?.locked && cur.key === key) cb(null);
        else cb({ source: 'sankey', agentIds: ids, key, locked: true });
      } else if (params.dataType === 'edge' && params.data) {
        const e = params.data as { source: string; target: string };
        const ids = agentsForSankeyLink(e.source, e.target, run);
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

    // Hover (ephemeral). Suppressed while a lock is active. We do NOT
    // clear on per-item mouseout — that would null-flicker the state as
    // the mouse passes between adjacent Sankey items. Instead we clear
    // on container mouseleave so the preview persists smoothly.
    chart.on('mouseover', (params) => {
      const cb = onCrossHighlightRef.current;
      if (!cb || crossHighlightRef.current?.locked) return;
      if (params.dataType === 'node' && params.name) {
        const name = String(params.name);
        const ids = agentsForSankeyNode(name, run);
        cb({ source: 'sankey', agentIds: ids, key: `node:${name}`, locked: false });
      } else if (params.dataType === 'edge' && params.data) {
        const e = params.data as { source: string; target: string };
        const ids = agentsForSankeyLink(e.source, e.target, run);
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

  // Apply the bold dim whenever any cross-highlight is active — hover
  // preview and click-lock should look identical, so the user sees the
  // *same* attention focus on the Sankey whether the cursor is over
  // the graph, over the Sankey itself, or after a click-lock.
  useEffect(() => {
    const c = chartRef.current;
    if (!c) return;
    if (!crossHighlight) {
      applySankeyFocus(c, null, run);
      return;
    }
    applySankeyFocus(c, new Set(crossHighlight.agentIds), run);
  }, [crossHighlight, run]);

  return <div ref={ref} className="decision-sankey-canvas" />;
}

function buildOption(run: Run, colors: ThemeColors): echarts.EChartsCoreOption {
  const total = Math.max(1, run.councilResults.length);
  const STANCE = stanceColor(colors);
  const BANDS_COLOR = confColor(colors);

  // ─── nodes ────────────────────────────────────────────────────────────
  // ECharts Sankey identifies nodes by `name` (must be unique across all
  // columns), so we prefix each column to avoid collisions when, e.g., a
  // profession label happens to overlap with a stance name.
  const profNodes = PROFESSIONS.map((p) => ({
    name: `prof:${p}`,
    label: { formatter: p, color: colors.fg, fontSize: 11 },
    itemStyle: { color: PROFESSION_PALETTE[p] },
  }));
  // Stance labels reframed for the forecast-interrogation run:
  //   support → trust  | oppose → distrust  | abstain → uncertain.
  // The internal id stays `stance:<original>` so existing handlers keep working.
  const STANCE_LABEL = { support: 'trust', oppose: 'distrust', abstain: 'uncertain' } as const;
  const stances = ['support', 'oppose', 'abstain'] as const;
  const stanceNodes = stances.map((s) => ({
    name: `stance:${s}`,
    label: { formatter: STANCE_LABEL[s], color: colors.fg, fontSize: 11, fontWeight: 500 as const },
    itemStyle: { color: STANCE[s] },
  }));
  const bands: ConfBand[] = ['Confident ≥75', 'Moderate 50–74', 'Uncertain <50'];
  const bandNodes = bands.map((b) => ({
    name: `conf:${b}`,
    label: { formatter: b, color: colors.fg, fontSize: 11 },
    itemStyle: { color: BANDS_COLOR[b] },
  }));

  // ─── aggregate links ──────────────────────────────────────────────────
  const profStance = new Map<string, number>();   // key = "prof|stance"
  const stanceConf = new Map<string, number>();   // key = "stance|band"
  for (const r of run.councilResults) {
    const k1 = `${r.agent.profession}|${r.finalStance}`;
    profStance.set(k1, (profStance.get(k1) ?? 0) + 1);
    const band = confBand(r.finalConfidence ?? 0);
    const k2 = `${r.finalStance}|${band}`;
    stanceConf.set(k2, (stanceConf.get(k2) ?? 0) + 1);
  }

  const links: { source: string; target: string; value: number }[] = [];
  for (const [k, v] of profStance) {
    const [p, s] = k.split('|');
    links.push({ source: `prof:${p}`, target: `stance:${s}`, value: v });
  }
  for (const [k, v] of stanceConf) {
    const [s, b] = k.split('|');
    links.push({ source: `stance:${s}`, target: `conf:${b}`, value: v });
  }

  // Drop nodes that don't participate in any link — a unanimous-support run
  // leaves the `oppose` / `abstain` / `Moderate` / `Uncertain` nodes at
  // height 0, and their labels would pile on top of each other at the column
  // edge. Keeping only the live nodes restores readable label spacing.
  const liveNames = new Set<string>();
  for (const l of links) {
    liveNames.add(l.source);
    liveNames.add(l.target);
  }
  const data = [...profNodes, ...stanceNodes, ...bandNodes].filter((n) =>
    liveNames.has(n.name),
  );

  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      confine: true,
      // Tooltip palette tracks theme — opaque-ish surface so it reads on
      // both light cream and warm-charcoal backgrounds.
      backgroundColor: colors.tooltipBg,
      borderColor: colors.tooltipBorder,
      borderWidth: 1,
      extraCssText:
        'box-shadow: 0 8px 28px rgba(0,0,0,0.18);' +
        'border-radius: 10px;' +
        '-webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);',
      textStyle: { color: colors.tooltipText, fontFamily: 'SN Pro, system-ui, sans-serif', fontSize: 12 },
      formatter: (p: { dataType?: string; data?: Record<string, unknown>; name?: string; value?: number }) => {
        if (p.dataType === 'edge' && p.data) {
          const d = p.data as { source: string; target: string; value: number };
          const pct = ((d.value / total) * 100).toFixed(1);
          return `<b>${prettify(d.source)}</b> → <b>${prettify(d.target)}</b><br/>${d.value} of ${total} agents · ${pct}%`;
        }
        if (p.dataType === 'node' && p.name) {
          const v = typeof p.value === 'number' ? p.value : 0;
          const pct = ((v / total) * 100).toFixed(1);
          return `<b>${prettify(p.name)}</b><br/>${v} agents · ${pct}%`;
        }
        return '';
      },
    },
    series: [
      {
        type: 'sankey',
        // The container itself is locked to a 16:9 landscape rectangle
        // via CSS aspect-ratio, so the diagram only needs modest internal
        // padding for labels and the header chip.
        top: 30,
        bottom: 14,
        left: 104,
        right: 132,
        // 20px nodeGap gives each stance / confidence node enough vertical
        // breathing room that adjacent labels never collide, even when a
        // single bucket dominates (eg. "Support 100%").
        nodeGap: 20,
        nodeWidth: 11,
        nodeAlign: 'justify',
        emphasis: { focus: 'adjacency' },
        // Following the canonical ECharts pattern: gradient link colour
        // (source → target) + soft curveness for a flowing read.
        lineStyle: { color: 'gradient', curveness: 0.5, opacity: 0.55 },
        label: {
          color: colors.fg,
          fontFamily: 'SN Pro, system-ui, sans-serif',
          position: 'right',
        },
        data,
        links,
      },
    ],
  };
}

// Drop the `prof:` / `stance:` / `conf:` prefix so the tooltip reads natural.
function prettify(s: string): string {
  return s.replace(/^(prof|stance|conf):/, '');
}

// ─── Cross-chart highlight helpers ────────────────────────────────────

// Which agents flow through a given Sankey node?
function agentsForSankeyNode(name: string, run: Run): string[] {
  if (name.startsWith('prof:')) {
    const p = name.slice(5);
    return run.councilResults.filter((r) => r.agent.profession === p).map((r) => r.agent.id);
  }
  if (name.startsWith('stance:')) {
    const s = name.slice(7);
    return run.councilResults.filter((r) => r.finalStance === s).map((r) => r.agent.id);
  }
  if (name.startsWith('conf:')) {
    const b = name.slice(5) as ConfBand;
    return run.councilResults.filter((r) => confBand(r.finalConfidence ?? 0) === b).map((r) => r.agent.id);
  }
  return [];
}

// Which agents flow through a given Sankey link? Both endpoints must
// match the agent's attributes.
function agentsForSankeyLink(source: string, target: string, run: Run): string[] {
  return run.councilResults
    .filter((r) => sankeyMatch(source, r) && sankeyMatch(target, r))
    .map((r) => r.agent.id);
}

function sankeyMatch(name: string, r: Run['councilResults'][number]): boolean {
  if (name.startsWith('prof:')) return r.agent.profession === name.slice(5);
  if (name.startsWith('stance:')) return r.finalStance === name.slice(7);
  if (name.startsWith('conf:')) return confBand(r.finalConfidence ?? 0) === name.slice(5);
  return false;
}

// Dim Sankey nodes that don't contain any highlighted agent, and links
// whose endpoints aren't both reachable from the highlighted set.
// Passing `null` for `ids` clears the dim.
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

  // Build the set of Sankey attributes covered by the highlighted agents.
  const matching = run.councilResults.filter((r) => ids.has(r.agent.id));
  const profs = new Set(matching.map((r) => r.agent.profession));
  const stances = new Set(matching.map((r) => r.finalStance));
  const bands = new Set(matching.map((r) => confBand(r.finalConfidence ?? 0)));
  const links = new Set<string>();
  for (const r of matching) {
    const b = confBand(r.finalConfidence ?? 0);
    links.add(`prof:${r.agent.profession}|stance:${r.finalStance}`);
    links.add(`stance:${r.finalStance}|conf:${b}`);
  }

  const nodeMatches = (name: string) => {
    if (name.startsWith('prof:')) return (profs as Set<string>).has(name.slice(5));
    if (name.startsWith('stance:')) return (stances as Set<string>).has(name.slice(7));
    if (name.startsWith('conf:')) return (bands as Set<string>).has(name.slice(5));
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
    const hit = links.has(`${l.source}|${l.target}`);
    return {
      ...l,
      lineStyle: { ...(l.lineStyle as object | undefined), opacity: hit ? 0.85 : 0.08 },
    };
  });
  chart.setOption({ series: [{ data: nextData, links: nextLinks }] }, { lazyUpdate: true });
}
