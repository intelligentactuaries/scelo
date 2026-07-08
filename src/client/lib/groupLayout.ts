// Deterministic "labelled regions" layout for the graph views.
//
// Both the Council Reactions and Society Pulse graphs used to run an ECharts
// force layout that scattered every node into one undifferentiated cloud —
// pretty, but structureless. These helpers instead arrange the *categories*
// (council → profession, society → cluster) into a grid of labelled cells that
// fill the canvas, and place each group's nodes inside its own cell. The result
// reads as grouped regions with edges crossing between them.
//
// Everything here is pure and pixel-based: cells are laid out in the chart's
// pixel space (origin = top-left, y grows downward — matching both the ECharts
// canvas and `layout: 'none'` node coordinates), so the region boxes drawn via
// the `graphic` component line up exactly with the nodes. No RNG, so re-renders
// and resizes are stable.

export type Group = { key: string; label: string; color: string };

export type Cell = Group & {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
};

const GAP = 12;
const LABEL_H = 24;
const PAD = 16;

/** Arrange `groups` into a grid of cells filling a `width`×`height` canvas,
 *  choosing a column count that roughly matches the canvas aspect ratio and
 *  centring any short final row. */
export function layoutCells(groups: Group[], width: number, height: number): Cell[] {
  const n = groups.length;
  if (n === 0 || width <= 0 || height <= 0) return [];
  const aspect = width / Math.max(height, 1);
  let cols = Math.max(1, Math.round(Math.sqrt(n * aspect)));
  cols = Math.min(cols, n);
  const rows = Math.ceil(n / cols);
  const cellW = (width - GAP * (cols + 1)) / cols;
  const cellH = (height - GAP * (rows + 1)) / rows;
  const cells: Cell[] = [];
  groups.forEach((g, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const inThisRow = r === rows - 1 ? n - cols * r : cols;
    const rowOffset = ((cols - inThisRow) * (cellW + GAP)) / 2;
    const x0 = GAP + rowOffset + c * (cellW + GAP);
    const y0 = GAP + r * (cellH + GAP);
    const x1 = x0 + cellW;
    const y1 = y0 + cellH;
    cells.push({ ...g, x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
  });
  return cells;
}

/** Place the `i`-th of `count` nodes inside `cell`, reserving a top strip for
 *  the label and inner padding on all sides. Nodes fill a centred grid; the
 *  caller can pre-sort (e.g. hubs first) for a nicer read. */
export function placeInCell(cell: Cell, i: number, count: number): { x: number; y: number } {
  const ix0 = cell.x0 + PAD;
  const iy0 = cell.y0 + LABEL_H;
  const iw = Math.max(1, cell.x1 - PAD - ix0);
  const ih = Math.max(1, cell.y1 - PAD - iy0);
  if (count <= 1) return { x: ix0 + iw / 2, y: iy0 + ih / 2 };
  const cols = Math.max(1, Math.round(Math.sqrt(count * (iw / Math.max(ih, 1)))));
  const rows = Math.ceil(count / cols);
  const col = i % cols;
  const row = Math.floor(i / cols);
  const inThisRow = row === rows - 1 ? count - cols * row : cols;
  const stepX = iw / cols;
  const stepY = ih / Math.max(rows, 1);
  const rowPad = ((cols - inThisRow) * stepX) / 2;
  return {
    x: ix0 + rowPad + (col + 0.5) * stepX,
    y: iy0 + (row + 0.5) * stepY,
  };
}

/** ECharts `markArea` config (one labelled rectangle per cell) for a companion
 *  cartesian2d series drawn behind the graph. Coordinates are in the same
 *  cell/pixel space the nodes use, so on a hidden cartesian2d grid the boxes
 *  line up exactly with the nodes (no force-layout auto-fit to fight). */
export function regionMarkArea(cells: Cell[], dark: boolean): Record<string, unknown> {
  return {
    silent: true,
    label: {
      show: true,
      position: 'insideTopLeft',
      fontSize: 12,
      fontWeight: 600,
      fontFamily: 'SN Pro, system-ui, sans-serif',
    },
    data: cells.map((cell) => [
      {
        // top-left corner carries the box + label styling
        coord: [cell.x0, cell.y0],
        name: cell.label,
        itemStyle: {
          color: withAlpha(cell.color, dark ? 0.1 : 0.07),
          borderColor: withAlpha(cell.color, dark ? 0.55 : 0.45),
          borderWidth: 1,
          borderType: 'dashed',
        },
        label: { color: cell.color },
      },
      { coord: [cell.x1, cell.y1] }, // bottom-right corner
    ]),
  };
}

export type Hull = { cx: number; cy: number; r: number; label: string; color: string };

export type FNode = { id: string; group: string; r: number };
export type FEdge = { source: string; target: string };

/** A small deterministic force-directed layout that keeps each group clustered.
 *
 *  Restores the organic force-graph look (connected nodes drift together, no
 *  rigid rows) while still separating groups: each node is gently pulled toward
 *  its group's fixed cell centre (cohesion), same-group nodes repel so the clump
 *  breathes, and edges act as springs. Because we run the sim ourselves in plain
 *  pixel space (0..W × 0..H), the positions feed a cartesian2d graph 1:1 and the
 *  per-group hull circles — computed from the settled positions — line up exactly.
 *
 *  Deterministic (seeded), so the same run + size always yields the same layout. */
export function forceClusterLayout(
  fnodes: FNode[],
  fedges: FEdge[],
  cells: Cell[],
  W: number,
  H: number,
): { pos: Map<string, { x: number; y: number }>; groupCircle: Map<string, { cx: number; cy: number; r: number }> } {
  const centroid = new Map(cells.map((c) => [c.key, { x: c.cx, y: c.cy }]));
  const cellHalf = new Map(cells.map((c) => [c.key, Math.min(c.x1 - c.x0, c.y1 - c.y0) / 2]));
  const idx = new Map(fnodes.map((n, i) => [n.id, i]));

  // Seeded PRNG → stable initial jitter around each group centre.
  let s = 0x9e3779b9 >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const P = fnodes.map((n) => {
    const c = centroid.get(n.group) ?? { x: W / 2, y: H / 2 };
    const rad = (cellHalf.get(n.group) ?? 40) * 0.45 * Math.sqrt(rnd());
    const a = rnd() * Math.PI * 2;
    return { x: c.x + rad * Math.cos(a), y: c.y + rad * Math.sin(a), g: n.group, r: n.r };
  });

  const links = fedges
    .map((e) => [idx.get(e.source), idx.get(e.target)] as [number | undefined, number | undefined])
    .filter((l): l is [number, number] => l[0] != null && l[1] != null);

  const ITER = 260, KREP = 780, KSPRING = 0.05, KGROUP = 0.07, REST = 30;
  for (let it = 0; it < ITER; it++) {
    const cool = 1 - it / ITER;
    const dx = new Float64Array(P.length);
    const dy = new Float64Array(P.length);
    // repulsion — same-group only (cross-group separation comes from cohesion to
    // the fixed, already-separated centroids, so groups can't drift into each other)
    for (let i = 0; i < P.length; i++) {
      for (let j = i + 1; j < P.length; j++) {
        if (P[i].g !== P[j].g) continue;
        let ax = P[i].x - P[j].x, ay = P[i].y - P[j].y;
        let d2 = ax * ax + ay * ay;
        if (d2 < 1) { d2 = 1; ax = (i - j) || 1; ay = 1; }
        const d = Math.sqrt(d2);
        const f = KREP / d2;
        const fx = (ax / d) * f, fy = (ay / d) * f;
        dx[i] += fx; dy[i] += fy; dx[j] -= fx; dy[j] -= fy;
      }
    }
    // springs along edges — same-group only, so cross-group edges (drawn as
    // lines between hulls) don't stretch a cluster and inflate its hull
    for (const [a, b] of links) {
      if (P[a].g !== P[b].g) continue;
      const ax = P[a].x - P[b].x, ay = P[a].y - P[b].y;
      const d = Math.hypot(ax, ay) || 1;
      const f = KSPRING * (d - REST);
      const fx = (ax / d) * f, fy = (ay / d) * f;
      dx[a] -= fx; dy[a] -= fy; dx[b] += fx; dy[b] += fy;
    }
    // cohesion toward the group's fixed centre
    for (let i = 0; i < P.length; i++) {
      const c = centroid.get(P[i].g)!;
      dx[i] += (c.x - P[i].x) * KGROUP;
      dy[i] += (c.y - P[i].y) * KGROUP;
    }
    const maxStep = 16 * cool + 2;
    for (let i = 0; i < P.length; i++) {
      const dl = Math.hypot(dx[i], dy[i]) || 1;
      const step = Math.min(dl, maxStep);
      P[i].x = Math.max(8, Math.min(W - 8, P[i].x + (dx[i] / dl) * step));
      P[i].y = Math.max(8, Math.min(H - 8, P[i].y + (dy[i] / dl) * step));
    }
  }

  const pos = new Map<string, { x: number; y: number }>();
  fnodes.forEach((n, i) => pos.set(n.id, { x: P[i].x, y: P[i].y }));

  const groupCircle = new Map<string, { cx: number; cy: number; r: number }>();
  for (const c of cells) {
    const members = P.filter((p) => p.g === c.key);
    if (!members.length) { groupCircle.set(c.key, { cx: c.cx, cy: c.cy, r: 28 }); continue; }
    const cx = members.reduce((a, p) => a + p.x, 0) / members.length;
    const cy = members.reduce((a, p) => a + p.y, 0) / members.length;
    let r = 0;
    for (const p of members) r = Math.max(r, Math.hypot(p.x - cx, p.y - cy) + p.r);
    groupCircle.set(c.key, { cx, cy, r: r + 15 });
  }
  return { pos, groupCircle };
}

/** Node spacing for a clump that comfortably fits inside its cell. */
export function discSpacing(cell: Cell, count: number): number {
  const base = Math.min(cell.x1 - cell.x0, cell.y1 - cell.y0);
  return Math.max(10, Math.min(26, base / (2.4 * Math.sqrt(Math.max(count, 1)) + 2)));
}

/** Phyllotaxis (sunflower) placement of the i-th of `count` nodes in a disc
 *  centred on (cx,cy). Deterministic and evenly packed — an organic clump. */
export function placeInDisc(cx: number, cy: number, i: number, count: number, spacing: number): { x: number; y: number } {
  if (count <= 1) return { x: cx, y: cy };
  const golden = Math.PI * (3 - Math.sqrt(5));
  const r = spacing * Math.sqrt(i + 0.5);
  const t = i * golden;
  return { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) };
}

/** Radius of the translucent hull enclosing a clump of `count` nodes, leaving
 *  room for the largest node's radius plus padding. */
export function hullRadius(count: number, spacing: number, nodeMaxR: number): number {
  return spacing * Math.sqrt(Math.max(count - 0.4, 0.6)) + nodeMaxR + 14;
}

/** ECharts `graphic` elements (a soft translucent circle + a label per group)
 *  drawn behind the graph so each group reads as a shaded region. Coordinates
 *  are in the same pixel space the cartesian2d nodes use (axes span 0..W/0..H
 *  over the full grid), so the hulls sit exactly under their clumps. */
export function hullGraphics(hulls: Hull[], dark: boolean): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const h of hulls) {
    out.push({
      type: 'circle',
      z: 0,
      silent: true,
      shape: { cx: h.cx, cy: h.cy, r: h.r },
      style: {
        fill: withAlpha(h.color, dark ? 0.13 : 0.09),
        stroke: withAlpha(h.color, dark ? 0.5 : 0.42),
        lineWidth: 1,
      },
    });
    out.push({
      type: 'text',
      z: 2,
      silent: true,
      style: {
        text: h.label,
        x: h.cx,
        y: h.cy - h.r - 6,
        textAlign: 'center',
        textVerticalAlign: 'bottom',
        fill: h.color,
        font: '600 12px "SN Pro", system-ui, sans-serif',
      },
    });
  }
  return out;
}

/** #rgb / #rrggbb (or any CSS color that's already rgba-ish) → rgba(...) with
 *  the given alpha. Falls back to the input unchanged for non-hex colors. */
function withAlpha(color: string, alpha: number): string {
  const hex = color.trim();
  const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  const m6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  let r: number, g: number, b: number;
  if (m6) {
    r = parseInt(m6[1], 16);
    g = parseInt(m6[2], 16);
    b = parseInt(m6[3], 16);
  } else if (m3) {
    r = parseInt(m3[1] + m3[1], 16);
    g = parseInt(m3[2] + m3[2], 16);
    b = parseInt(m3[3] + m3[3], 16);
  } else {
    return hex;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
