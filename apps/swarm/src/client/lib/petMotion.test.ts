import { describe, expect, test } from 'bun:test';
import {
  HOPS,
  PetMotion,
  type PetPose,
  blinkKeyframes,
  gazeToward,
  hopAt,
  spring,
  stepSpring,
} from './petMotion';

// Deterministic randomness so schedules are reproducible.
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const rect = { left: 100, top: 100, width: 50, height: 50 }; // centre (125, 125)

function run(
  motion: PetMotion,
  from: number,
  ms: number,
  input: Parameters<PetMotion['step']>[2],
): PetPose[] {
  const poses: PetPose[] = [];
  for (let t = from; t <= from + ms; t += 16) poses.push(motion.step(t, 0.016, input));
  return poses;
}

describe('springs', () => {
  test('a critically damped spring settles on its target without overshoot', () => {
    const s = spring(0);
    s.t = 10;
    let max = 0;
    for (let i = 0; i < 240; i++) {
      stepSpring(s, 5, 1, 1 / 120);
      max = Math.max(max, s.x);
    }
    expect(s.x).toBeGreaterThan(9.5);
    expect(max).toBeLessThanOrEqual(10.0001);
  });

  test('an underdamped one overshoots, then settles', () => {
    const s = spring(1);
    s.t = 0;
    let min = 1;
    for (let i = 0; i < 600; i++) {
      stepSpring(s, 12, 0.45, 1 / 120);
      min = Math.min(min, s.x);
    }
    expect(min).toBeLessThan(0);
    expect(Math.abs(s.x)).toBeLessThan(0.01);
  });
});

describe('gaze follows the pointer, but only so far', () => {
  test('points at the pointer', () => {
    const right = gazeToward(rect, 200, 125);
    expect(right.x).toBeGreaterThan(0);
    expect(Math.abs(right.y)).toBeLessThan(1e-9);
    const up = gazeToward(rect, 125, 60);
    expect(up.y).toBeLessThan(0);
  });

  test('grows with √distance and saturates at two pet-widths', () => {
    const near = gazeToward(rect, 125 + 10, 125).x; // √(10/100)
    const mid = gazeToward(rect, 125 + 50, 125).x; // √(50/100)
    const edge = gazeToward(rect, 125 + 100, 125).x;
    const far = gazeToward(rect, 125 + 2000, 125).x;
    expect(near).toBeCloseTo(Math.sqrt(0.1), 9);
    expect(mid).toBeCloseTo(Math.sqrt(0.5), 9);
    expect(edge).toBeCloseTo(1, 9);
    expect(far).toBeCloseTo(1, 9); // no further, however far the cursor goes
    const diag = gazeToward(rect, 125 + 3000, 125 + 3000);
    expect(Math.hypot(diag.x, diag.y)).toBeCloseTo(1, 9);
  });

  test('the pet turns toward a pointer on its right, and stays within reach', () => {
    const m = new PetMotion(0, seeded(1));
    const poses = run(m, 0, 1500, {
      mood: 'idle',
      rect,
      pointer: { x: 5000, y: 125, still: 0 },
    });
    const p = poses[poses.length - 1];
    expect(p.faceX).toBeGreaterThan(2);
    expect(p.eyes[0].dx).toBeGreaterThan(1);
    expect(p.rot).toBeGreaterThan(0); // leans toward it
    // Bounded: face + eye travel never exceeds the reach plus idle drift.
    for (const q of poses) {
      expect(Math.abs(q.faceX + q.eyes[0].dx)).toBeLessThan(10 + 4);
      expect(Math.abs(q.rot)).toBeLessThan(4.5 + 2.2 + 0.5);
      expect(Math.abs(q.tx)).toBeLessThan(3 + 1);
    }
  });
});

describe('life', () => {
  test('blinks: shut fast, hold, overshoot open, settle — sometimes twice', () => {
    const k = blinkKeyframes(1000, false);
    expect(k.map((f) => f.v)).toEqual([0.05, 0.05, 1.08, 1]);
    expect(k[k.length - 1].at - k[0].at).toBe(300);
    expect(blinkKeyframes(0, true)).toHaveLength(6);
  });

  test('an idle pet blinks within ten seconds', () => {
    const m = new PetMotion(0, seeded(7));
    const poses = run(m, 0, 10_000, { mood: 'idle', rect, pointer: null });
    const minOpen = Math.min(...poses.map((p) => p.eyes[0].open));
    expect(minOpen).toBeLessThan(0.3);
  });

  test('it breathes and sways even when nothing happens', () => {
    const m = new PetMotion(0, seeded(3));
    const poses = run(m, 0, 6000, { mood: 'idle', rect, pointer: null });
    const rots = poses.map((p) => p.rot);
    expect(Math.max(...rots) - Math.min(...rots)).toBeGreaterThan(0.3);
    const sy = poses.map((p) => p.sy);
    expect(Math.max(...sy)).toBeGreaterThan(1);
  });

  test('a hop is four shrinking arcs that land back on the ground', () => {
    expect(hopAt(-1).y).toBe(0);
    const peaks = HOPS.map((_, i) => {
      const start = HOPS.slice(0, i).reduce((s, h) => s + h.d, 0);
      return -hopAt(start + HOPS[i].d / 2).y;
    });
    for (let i = 1; i < peaks.length; i++) expect(peaks[i]).toBeLessThan(peaks[i - 1]);
    const total = HOPS.reduce((s, h) => s + h.d, 0);
    expect(hopAt(total + 0.01).y).toBe(0);

    const m = new PetMotion(0, seeded(5));
    m.hop(0);
    const poses = run(m, 0, 1500, { mood: 'idle', rect, pointer: null });
    expect(Math.min(...poses.map((p) => p.ty))).toBeLessThan(-20);
    // Touch-down squashes the body.
    expect(Math.min(...poses.map((p) => p.sy))).toBeLessThan(0.97);
    expect(Math.abs(poses[poses.length - 1].ty)).toBeLessThan(2);
  });

  test('a hovered (curious) pet opens its eyes wide', () => {
    const m = new PetMotion(0, seeded(9));
    const poses = run(m, 0, 800, { mood: 'curious', rect, pointer: null });
    expect(poses[poses.length - 1].eyes[0].scale).toBeGreaterThan(1.1);
  });

  test('a twirl is one full turn, and it comes to rest', () => {
    const m = new PetMotion(0, seeded(11));
    m.twirl();
    const poses = run(m, 0, 3000, { mood: 'happy', rect, pointer: null });
    const most = Math.max(...poses.map((p) => Math.abs(p.rot)));
    expect(most).toBeGreaterThan(300);
    expect(Math.abs(poses[poses.length - 1].rot)).toBeLessThan(10);
  });
});
