// Deliberation progress as a bloom of personas.
//
// Replaces the seat ring, which could only ever say how MANY agents had
// answered — never who.
//
// Mirrored rows of circles, one circle per agent that has reported, coloured
// by profession. Row lengths ease with `elasticOut`, so every change flings
// the tips outward and lets them settle back. That overshoot is the whole
// look: earlier passes chased it with randomised positions and a drifting
// scatter, which was the wrong mechanism — the motion in the reference comes
// from the EASING on the lengths, not from where the symbols sit.
//
// Canvas rather than ECharts. This is a hot rAF loop drawing a few hundred
// circles with per-item colour and sub-symbol positioning; going through a
// charting library's option diffing to get there costs more and controls
// less.
//
// Honesty rules, since this is a progress display:
//   • the number of circles drawn is exactly the number of agents that have
//     answered — never rounded up to fill a row, never padded to look busy;
//   • the idle shimmer between arrivals moves tips by less than one circle
//     width, so it can never add or remove one.

import { useEffect, useRef } from 'react';
import { colorsForTheme } from '../../shared/constants';
import { useTheme } from '../lib/theme';
import { seatColorFor } from './DeliberationOverlay';

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
  /** Circle diameter as a fraction of the per-agent spacing. Constant: in the
   *  reference the symbol size never changes — the crowd expands because more
   *  symbols arrive, not because each one grows. A swell was tried here and it
   *  read as one pulse rather than as growth. */
  dotScale: 0.86,
};
const HALF = CFG.gridW / 2;
const ROW_STEP = CFG.gridH / CFG.rowCount;
/** rowCount rows, mirrored — slot < rowCount is the right side. */
const SLOTS = CFG.rowCount * 2;

/** ECharts' elasticOut. This is what produces the scatter-and-settle. */
function elasticOut(k: number): number {
  if (k === 0 || k === 1) return k;
  const p = 0.4;
  const s = p / 4;
  return 2 ** (-10 * k) * Math.sin(((k - s) * (2 * Math.PI)) / p) + 1;
}

/**
 * Relative capacity of each slot.
 *
 * Straight from the reference's shape function: rows nearer the middle are
 * longer, and alternating rows are shortened a touch, which is what gives the
 * crowd its uneven silhouette instead of a rectangle. Here it only decides
 * how the real agents are DISTRIBUTED across rows — it never invents any.
 */
function slotWeight(slot: number): number {
  const n = CFG.rowCount;
  const i = slot % n;
  const negative = slot >= n;
  const trim = negative ? (i % 3 ? 0.9 : 1) : (i + 1) % 3 ? 0.9 : 1;
  return (n - Math.abs(i - n / 2 + 0.5)) * trim;
}

const WEIGHTS = Array.from({ length: SLOTS }, (_, s) => slotWeight(s));
const WEIGHT_SUM = WEIGHTS.reduce((a, b) => a + b, 0);

/**
 * The slot each agent lands in, in arrival order.
 *
 * Built once for the whole roster and then read as a prefix, which makes the
 * layout monotonic BY CONSTRUCTION: agent k is always in the same slot, at the
 * same index within it, however many have arrived. That matters twice over —
 * a circle must not hop rows as the crowd fills, and its colour is keyed on
 * the agent index, so a reshuffle would repaint circles that had already
 * settled.
 *
 * Recomputing a largest-remainder split per frame looked equivalent and is
 * not: measured over n = 0..400 it moved a circle between rows ten times.
 *
 * Sainte-Laguë quotients — give the next agent to whichever slot is furthest
 * behind its share — so every prefix approximates the weights, not just the
 * final total.
 */
function assignmentOrder(capacity: number): number[] {
  const filled = new Array<number>(SLOTS).fill(0);
  const order: number[] = [];
  for (let k = 0; k < capacity; k++) {
    let best = 0;
    let bestScore = -Infinity;
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
}: {
  /** Roster size. Fixes the scale so the crowd does not rescale as it fills. */
  total: number;
  /** Agents that have answered. */
  litSeats: number;
  /** index → agent id, for per-agent colour. */
  seatIds?: Map<number, string>;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const { resolved } = useTheme();
  const colors = colorsForTheme(resolved);

  // The rAF loop reads live values through a ref so it can stay mounted for
  // the whole run; taking them as effect dependencies would tear the loop
  // down and restart the easing on every incoming agent.
  const live = useRef({ total, litSeats, seatIds, accent: colors.accent });
  live.current = { total, litSeats, seatIds, accent: colors.accent };

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduced =
      typeof window !== 'undefined' &&
      !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    let sc = 1;
    let dpr = 1;
    let raf = 0;

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
      // One agent's length, fixed on the FULL roster so a circle already on
      // screen keeps its position as the crowd fills in around it.
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

    /**
     * One row. `count` is the truth (agents); `len` is the eased length the
     * dots are spread across — so the wobble slides them without ever
     * changing how many there are.
     */
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
      // The half-step nudge on alternate rows is the reference's
      // `symbolOffset: ['50%', 0]` — without it the mirrored rows line up
      // into columns and the crowd reads as a grid.
      const offset = rowIndex % 2 ? perDot * 0.5 : 0;
      const { seatIds: ids, accent } = live.current;
      // Sized off `perDot` — the actual per-agent spacing — not the nominal
      // `CFG.dot`. On a large roster the spacing compresses below the nominal
      // size, so a fixed radius overlapped into solid bands: at 400 agents the
      // widest row packs 27 into 450 virtual px, giving 16.7px of room for a
      // 22px circle.
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
    };
  }, []);

  return <canvas ref={ref} className="delib-bloom" />;
}
