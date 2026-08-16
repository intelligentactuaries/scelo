// Deliberation progress as a bloom of personas — ported from the swarm
// app's PersonaBloom so both shells show the same processing animation.
//
// Mirrored rows of circles, one circle per agent that has reported, coloured
// by profession. Row lengths ease with `elasticOut`, so every change flings
// the tips outward and lets them settle back. That overshoot is the whole
// look: the motion comes from the EASING on the lengths, not from where the
// symbols sit.
//
// Canvas rather than a chart library: a hot rAF loop drawing a few hundred
// circles with per-item colour costs less and controls more.
//
// Honesty rules, since this is a progress display:
//   • the number of circles drawn is exactly the number of agents that have
//     answered — never rounded up to fill a row, never padded to look busy;
//   • the idle shimmer between arrivals moves tips by less than one circle
//     width, so it can never add or remove one.
//
// Differences from the swarm original: the accent colour is resolved from
// Scelo's `--rgb-primary` CSS custom property (this app themes through CSS
// variables, not a ThemeColors object), and it re-resolves when the root
// element's attributes change so a theme flip repaints the fallback dots.

import { useEffect, useRef } from "react";

const SEAT_COLORS = [
  "#4a9eff",
  "#00d0a0",
  "#b388ff",
  "#ffb000",
  "#f472b6",
  "#22d3ee",
  "#a3e635",
  "#ff6b6b",
];

/** Stable per-profession hue — agent ids look like `c-actuary-intj-f`. */
export function seatColorFor(agentId: string): string {
  const prof = agentId.split("-")[1] ?? agentId;
  let h = 0;
  for (let i = 0; i < prof.length; i++) h = (h * 31 + prof.charCodeAt(i)) >>> 0;
  return SEAT_COLORS[h % SEAT_COLORS.length];
}

const CFG = {
  rowCount: 10,
  /** One re-target per tick. */
  tickMs: 800,
  /** Elastic settle time inside a tick. */
  easeMs: 700,
  /** Virtual px across the full axis, half either side of centre. */
  gridW: 900,
  gridH: 280,
  /** Circle diameter in virtual px — the "symbol size". */
  dot: 26,
  /** Idle wobble, in virtual px. Kept under a dot so counts can't change. */
  wobble: 9,
  /** Circle diameter as a fraction of the per-agent spacing. */
  dotScale: 0.86,
};
const HALF = CFG.gridW / 2;
const ROW_STEP = CFG.gridH / CFG.rowCount;
/** rowCount rows, mirrored — slot < rowCount is the right side. */
const SLOTS = CFG.rowCount * 2;

/** ECharts' elasticOut — produces the scatter-and-settle. */
function elasticOut(k: number): number {
  if (k === 0 || k === 1) return k;
  const p = 0.4;
  const s = p / 4;
  return 2 ** (-10 * k) * Math.sin(((k - s) * (2 * Math.PI)) / p) + 1;
}

/** Relative capacity of each slot: rows nearer the middle are longer, and
 *  alternating rows are shortened a touch — the crowd's uneven silhouette. */
function slotWeight(slot: number): number {
  const n = CFG.rowCount;
  const i = slot % n;
  const negative = slot >= n;
  const trim = negative ? (i % 3 ? 0.9 : 1) : (i + 1) % 3 ? 0.9 : 1;
  return (n - Math.abs(i - n / 2 + 0.5)) * trim;
}

const WEIGHTS = Array.from({ length: SLOTS }, (_, s) => slotWeight(s));

/** The slot each agent lands in, in arrival order. Built once for the whole
 *  roster then read as a prefix — the layout is monotonic BY CONSTRUCTION so
 *  a circle never hops rows as the crowd fills. Sainte-Laguë quotients. */
function assignmentOrder(capacity: number): number[] {
  const filled = new Array<number>(SLOTS).fill(0);
  const order: number[] = [];
  for (let k = 0; k < capacity; k++) {
    let best = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let s = 0; s < SLOTS; s++) {
      const score = WEIGHTS[s] / (filled[s] + 0.5);
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    filled[best]++;
    order.push(best);
  }
  return order;
}

/** Agent indices per slot, in the order they will be drawn along the row. */
function slotAgents(order: number[]): number[][] {
  const out: number[][] = Array.from({ length: SLOTS }, () => []);
  order.forEach((slot, agent) => out[slot].push(agent));
  return out;
}

/** How many of each slot's agents have arrived, given `n` in total. */
function countsFor(order: number[], n: number): number[] {
  const counts = new Array<number>(SLOTS).fill(0);
  for (let k = 0; k < Math.min(n, order.length); k++) counts[order[k]]++;
  return counts;
}

export function PersonaBloom({
  total,
  litSeats,
  seatIds,
  className,
}: {
  /** Roster size. Fixes the scale so the crowd does not rescale as it fills. */
  total: number;
  /** Agents that have answered. */
  litSeats: number;
  /** index → agent id, for per-agent colour. */
  seatIds?: Map<number, string>;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  // The rAF loop reads live values through a ref so it can stay mounted for
  // the whole run; effect dependencies would tear down and restart the
  // easing on every incoming agent.
  const live = useRef({ total, litSeats, seatIds });
  live.current = { total, litSeats, seatIds };

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced =
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    let sc = 1;
    let dpr = 1;
    let raf = 0;
    // Fallback accent for seats without an id yet — Scelo themes via CSS
    // custom properties, so resolve `--rgb-primary` and re-resolve when the
    // root's attributes change (theme flips swap the variable).
    let accent = "#4a9eff";
    const resolveAccent = () => {
      const v = getComputedStyle(document.documentElement).getPropertyValue("--rgb-primary").trim();
      if (v) accent = `rgb(${v})`;
    };
    resolveAccent();
    const mo = new MutationObserver(resolveAccent);
    mo.observe(document.documentElement, { attributes: true });

    // Animated bar lengths, in virtual px, signed by side.
    const lengths = new Array<number>(SLOTS).fill(0);
    let from = lengths.slice();
    let to = lengths.slice();
    let tickStart = performance.now();
    let phase = 0;

    // Rebuilt only when the roster size changes, never per frame.
    let capacity = -1;
    let order: number[] = [];
    let agentsBySlot: number[][] = [];
    let perDot = CFG.dot;
    const ensure = (cap: number) => {
      const c = Math.max(cap, 1);
      if (c === capacity) return;
      capacity = c;
      order = assignmentOrder(c);
      agentsBySlot = slotAgents(order);
      const widest = Math.max(1, ...countsFor(order, c));
      perDot = Math.min(CFG.dot, HALF / widest);
    };

    const targetsFor = (n: number): number[] => {
      const counts = countsFor(order, n);
      return counts.map((c, s) => {
        const dir = s >= CFG.rowCount ? -1 : 1;
        const wob = reduced ? 0 : Math.sin(phase * 0.9 + s * 1.7) * CFG.wobble;
        const len = c * perDot + (c > 0 ? wob : 0);
        return dir * Math.max(0, Math.min(HALF, len));
      });
    };

    const layout = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sc = Math.min(w / (CFG.gridW + 40), h / (CFG.gridH + 40), 1.4);
    };

    const drawRow = (
      cx: number,
      y: number,
      len: number,
      count: number,
      rowIndex: number,
      agents: number[],
    ) => {
      if (count < 1) return;
      const dir = len < 0 ? -1 : 1;
      const step = Math.abs(len) / count;
      // Half-step nudge on alternate rows so the mirrored rows don't line up
      // into a grid.
      const offset = rowIndex % 2 ? perDot * 0.5 : 0;
      const ids = live.current.seatIds;
      const r = (perDot / 2) * CFG.dotScale * sc;
      for (let k = 0; k < count; k++) {
        const x = cx + dir * ((k + 0.5) * step + offset) * sc;
        const id = ids?.get(agents[k]);
        ctx.fillStyle = id ? seatColorFor(id) : accent;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const frame = (now: number) => {
      const { litSeats: n, total: cap } = live.current;

      ensure(cap);
      if (now - tickStart >= CFG.tickMs) {
        tickStart = now;
        phase += 1;
        from = lengths.slice();
        to = targetsFor(n);
      }

      const t = Math.min(1, (now - tickStart) / CFG.easeMs);
      const e = reduced ? 1 : elasticOut(t);
      for (let i = 0; i < SLOTS; i++) lengths[i] = from[i] + (to[i] - from[i]) * e;

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2;
      const gridBottom = h / 2 + (CFG.gridH / 2) * sc;

      const counts = countsFor(order, n);

      // Back rows first, so nearer rows overlap them.
      for (let i = CFG.rowCount - 1; i >= 0; i--) {
        const y = gridBottom - ROW_STEP * (i + 0.5) * sc;
        drawRow(cx, y, lengths[i], counts[i], i, agentsBySlot[i]);
        const m = CFG.rowCount + i;
        drawRow(cx, y, lengths[m], counts[m], i, agentsBySlot[m]);
      }

      raf = requestAnimationFrame(frame);
    };

    const ro = new ResizeObserver(layout);
    ro.observe(canvas);
    layout();
    ensure(live.current.total);
    to = targetsFor(live.current.litSeats);
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  return <canvas ref={ref} className={className ?? "block h-[300px] w-[min(620px,86vw)]"} />;
}
