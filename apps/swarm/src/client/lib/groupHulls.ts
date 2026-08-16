import type * as echarts from 'echarts/core';

// One draggable, hoverable group hull. `memberIds` are the node ids that ride
// with it when dragged; `statsHtml` is shown in a tooltip on hover.
export type HullDatum = {
  key: string;
  label: string;
  color: string;
  cx: number;
  cy: number;
  r: number;
  memberIds: string[];
  statsHtml: string;
};

type NodeDatum = { id?: string; value?: [number, number]; [k: string]: unknown };
type ZrEvent = { offsetX: number; offsetY: number; event?: MouseEvent };

function alpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

/** Render group hulls as draggable graphic elements with hover-stats tooltips.
 *
 *  - Dragging a hull (grab its shaded area or label) translates every member
 *    node with it — the group moves as a unit. Drag is manual (window pointer
 *    listeners) so it tracks past the element edge and never fights ECharts.
 *  - Hovering a hull shows a small tooltip with the group's edge statistics.
 *
 *  Owns the `graphic` component (installs via replaceMerge) and a tooltip DOM
 *  node. Returns a cleanup. Drag offsets live for this install only, so a full
 *  option rebuild (new run / resize / theme) resets positions to the base
 *  force-layout — which is the desired behaviour. */
export function installGroupHulls(
  chart: echarts.ECharts,
  container: HTMLElement,
  hulls: HullDatum[],
  basePos: Map<string, { x: number; y: number }>,
  dark: boolean,
  handlers?: { onHover?: (memberIds: string[], key: string) => void; onLeave?: () => void },
): () => void {
  const tip = document.createElement('div');
  Object.assign(tip.style, {
    position: 'absolute',
    pointerEvents: 'none',
    zIndex: '30',
    opacity: '0',
    transition: 'opacity .12s ease',
    transform: 'translate(-50%, calc(-100% - 14px))',
    padding: '9px 11px',
    borderRadius: '9px',
    font: '12px/1.55 "SN Pro", system-ui, sans-serif',
    background: dark ? 'rgba(18,22,28,.94)' : 'rgba(255,255,255,.96)',
    color: dark ? '#eef1f6' : '#14181f',
    border: `1px solid ${dark ? 'rgba(255,255,255,.13)' : 'rgba(0,0,0,.1)'}`,
    boxShadow: '0 10px 30px rgba(0,0,0,.24)',
    maxWidth: '260px',
    whiteSpace: 'normal',
    backdropFilter: 'blur(8px) saturate(140%)',
    WebkitBackdropFilter: 'blur(8px) saturate(140%)',
  });
  if (!container.style.position) container.style.position = 'relative';
  container.appendChild(tip);

  const memberSets = new Map(hulls.map((h) => [h.key, new Set(h.memberIds)]));
  const offsets = new Map<string, { dx: number; dy: number }>();
  hulls.forEach((h) => offsets.set(h.key, { dx: 0, dy: 0 }));
  let raf = 0;
  let dragging: string | null = null;

  const moveNodes = (key: string) => {
    const set = memberSets.get(key);
    const off = offsets.get(key);
    if (!set || !off) return;
    const opt = chart.getOption() as { series: { data: NodeDatum[] }[] };
    const data = opt.series?.[0]?.data ?? [];
    const next = data.map((d) => {
      if (!d.id || !set.has(d.id)) return d;
      const b = basePos.get(d.id);
      if (!b) return d;
      return { ...d, value: [b.x + off.dx, b.y + off.dy] as [number, number] };
    });
    chart.setOption({ series: [{ data: next }] }, { lazyUpdate: true, silent: true });
  };

  const setHullPos = (key: string) => {
    const off = offsets.get(key)!;
    chart.setOption({ graphic: [{ id: `hull-${key}`, x: off.dx, y: off.dy }] });
  };

  // Fade the other group hulls (circle + label) when one group is focused;
  // pass null to restore all. Opacity merges multiplicatively into each child's
  // existing style, so fill/stroke are preserved.
  const setHullDim = (activeKey: string | null) => {
    chart.setOption({
      graphic: hulls.map((h) => {
        const dim = activeKey != null && activeKey !== h.key;
        return {
          id: `hull-${h.key}`,
          children: [{ style: { opacity: dim ? 0.28 : 1 } }, { style: { opacity: dim ? 0.34 : 1 } }],
        };
      }),
    });
  };

  const showTip = (html: string, e: ZrEvent) => {
    if (dragging) return;
    tip.innerHTML = html;
    tip.style.left = `${e.offsetX}px`;
    tip.style.top = `${e.offsetY}px`;
    tip.style.opacity = '1';
  };
  const moveTip = (e: ZrEvent) => {
    if (dragging) return;
    tip.style.left = `${e.offsetX}px`;
    tip.style.top = `${e.offsetY}px`;
  };
  const hideTip = () => {
    tip.style.opacity = '0';
  };

  // Group hover → emit a cross-highlight (deduped per group) with a short leave
  // debounce so moving between the hull disc and its label doesn't flicker.
  let hoveredKey: string | null = null;
  let hoverLeaveTimer: ReturnType<typeof setTimeout> | undefined;
  const enterGroup = (h: HullDatum, e: ZrEvent) => {
    if (hoverLeaveTimer) {
      clearTimeout(hoverLeaveTimer);
      hoverLeaveTimer = undefined;
    }
    showTip(h.statsHtml, e);
    if (hoveredKey !== h.key) {
      hoveredKey = h.key;
      setHullDim(h.key); // fade the other groups' hulls
      handlers?.onHover?.(h.memberIds, h.key);
    }
  };
  const leaveGroup = () => {
    if (hoverLeaveTimer) clearTimeout(hoverLeaveTimer);
    hoverLeaveTimer = setTimeout(() => {
      hoverLeaveTimer = undefined;
      hoveredKey = null;
      setHullDim(null); // restore all hulls
      hideTip();
      handlers?.onLeave?.();
    }, 40);
  };

  // ── manual drag via window pointer listeners ──
  let startPx = 0, startPy = 0, startDx = 0, startDy = 0;
  const onWinMove = (ev: MouseEvent) => {
    if (!dragging) return;
    const rect = container.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    offsets.set(dragging, { dx: startDx + (px - startPx), dy: startDy + (py - startPy) });
    setHullPos(dragging);
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (dragging) moveNodes(dragging);
      });
    }
  };
  const onWinUp = () => {
    if (dragging) moveNodes(dragging);
    dragging = null;
    window.removeEventListener('mousemove', onWinMove);
    window.removeEventListener('mouseup', onWinUp);
  };
  const startDrag = (key: string, e: ZrEvent) => {
    dragging = key;
    hideTip();
    const rect = container.getBoundingClientRect();
    startPx = (e.event ? e.event.clientX - rect.left : e.offsetX);
    startPy = (e.event ? e.event.clientY - rect.top : e.offsetY);
    const off = offsets.get(key)!;
    startDx = off.dx;
    startDy = off.dy;
    e.event?.preventDefault();
    window.addEventListener('mousemove', onWinMove);
    window.addEventListener('mouseup', onWinUp);
  };

  // The group carries the id (so we translate it as a unit via setOption) and
  // holds the circle + label. Interaction handlers live on the circle child —
  // hovering/grabbing the shaded disc is the reliable hit surface.
  const graphic = hulls.map((h) => ({
    type: 'group' as const,
    id: `hull-${h.key}`,
    z: 0,
    x: 0,
    y: 0,
    children: [
      {
        type: 'circle' as const,
        shape: { cx: h.cx, cy: h.cy, r: h.r },
        cursor: 'grab',
        style: {
          fill: alpha(h.color, dark ? 0.13 : 0.09),
          stroke: alpha(h.color, dark ? 0.5 : 0.42),
          lineWidth: 1,
        },
        onmousedown: (e: ZrEvent) => startDrag(h.key, e),
        onmouseover: (e: ZrEvent) => enterGroup(h, e),
        onmousemove: (e: ZrEvent) => moveTip(e),
        onmouseout: () => leaveGroup(),
      },
      {
        type: 'text' as const,
        cursor: 'grab',
        style: {
          text: h.label,
          x: h.cx,
          y: h.cy - h.r - 6,
          textAlign: 'center' as const,
          textVerticalAlign: 'bottom' as const,
          fill: h.color,
          font: '600 12px "SN Pro", system-ui, sans-serif',
        },
        onmousedown: (e: ZrEvent) => startDrag(h.key, e),
        onmouseover: (e: ZrEvent) => enterGroup(h, e),
        onmouseout: () => leaveGroup(),
      },
    ],
  }));

  chart.setOption({ graphic }, { replaceMerge: ['graphic'] });

  return () => {
    if (raf) cancelAnimationFrame(raf);
    if (hoverLeaveTimer) clearTimeout(hoverLeaveTimer);
    window.removeEventListener('mousemove', onWinMove);
    window.removeEventListener('mouseup', onWinUp);
    tip.remove();
    if (!chart.isDisposed()) chart.setOption({ graphic: [] }, { replaceMerge: ['graphic'] });
  };
}
