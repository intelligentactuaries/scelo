// How a pet moves — pure, frame-rate independent, testable without a DOM.
//
// Modelled closely on the xAI Grok desktop agents' characters: every moving
// quantity is a critically-damped (or slightly bouncy) spring chasing a target
// that the current mood writes each frame; idle life is a few slow sines at
// unrelated frequencies so nothing ever visibly loops; blinks are keyframed
// (shut, hold, open past fully, settle) with the odd double blink; the eyes
// follow the pointer, but only so far — the pull grows with the square root
// of the distance and saturates at two pet-widths, so a pet glances at the
// cursor rather than staring it down.
//
// Units are the pets' own 168-unit viewBox. The Grok constants were tuned on
// a 259-unit box; K rescales lengths so the proportions carry over.

const K = 168 / 259;

// ── primitives ──────────────────────────────────────────────────────────────

export interface Spring {
  x: number;
  v: number;
  t: number;
}

export const spring = (x: number): Spring => ({ x, v: 0, t: x });

/** Damped harmonic step: ω is stiffness (rad/s), ζ the damping ratio. */
export function stepSpring(s: Spring, omega: number, zeta: number, dt: number): void {
  s.v += (-2 * zeta * omega * s.v - omega * omega * (s.x - s.t)) * dt;
  s.x += s.v * dt;
  if (!Number.isFinite(s.x) || !Number.isFinite(s.v)) {
    s.x = s.t;
    s.v = 0;
  }
}

const SUBSTEP = 1 / 120;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Frame-rate-independent exponential smoothing: `k` is the share of the gap
 *  closed per 1/60 s frame. */
export const smoothing = (k: number, dt: number) => 1 - (1 - k) ** (60 * dt);

// ── gaze ────────────────────────────────────────────────────────────────────

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where the pet looks for a pointer at (x, y): a vector in the unit disk.
 * Direction is straight at the pointer; magnitude is √(distance / 2·width),
 * capped at 1 — near the pet the eyes track closely, from two pet-widths away
 * they are already at full turn and go no further however far the cursor
 * wanders.
 */
export function gazeToward(rect: Rect, x: number, y: number): { x: number; y: number } {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = x - cx;
  const dy = y - cy;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6 || rect.width <= 0) return { x: 0, y: 0 };
  const pull = Math.min(1, Math.sqrt(d / (rect.width * 2)));
  return { x: (dx / d) * pull, y: (dy / d) * pull };
}

// ── hops ────────────────────────────────────────────────────────────────────

/** A bounce: four parabolic arcs, each lower and quicker (height, seconds). */
export const HOPS: ReadonlyArray<{ h: number; d: number }> = [
  { h: 48 * K, d: 0.5 },
  { h: 28 * K, d: 0.382 },
  { h: 14 * K, d: 0.27 },
  { h: 6 * K, d: 0.177 },
];
const HOP_TOTAL = HOPS.reduce((s, h) => s + h.d, 0);

/** Height above the ground `t` seconds into a bounce, and which arc landed
 *  last (for the squash on touch-down). Negative is up, as in SVG. */
export function hopAt(t: number): { y: number; arc: number } {
  if (t < 0 || t >= HOP_TOTAL) return { y: 0, arc: -1 };
  let start = 0;
  for (let i = 0; i < HOPS.length; i++) {
    const { h, d } = HOPS[i];
    if (t < start + d) {
      const u = (t - start) / d;
      return { y: -4 * h * u * (1 - u), arc: i };
    }
    start += d;
  }
  return { y: 0, arc: -1 };
}

// ── blinks ──────────────────────────────────────────────────────────────────

export interface Keyframe {
  at: number;
  v: number;
}

/** Shut fast, hold, open a touch past fully, settle; sometimes twice. */
export function blinkKeyframes(now: number, double: boolean): Keyframe[] {
  const k = [
    { at: now, v: 0.05 },
    { at: now + 70, v: 0.05 },
    { at: now + 150, v: 1.08 },
    { at: now + 300, v: 1 },
  ];
  if (double) k.push({ at: now + 370, v: 0.05 }, { at: now + 480, v: 1 });
  return k;
}

// ── moods ───────────────────────────────────────────────────────────────────

/** idle — resting; happy — the chosen one / the greeter; curious — hovered. */
export type PetMood = 'idle' | 'happy' | 'curious';

const BLINK_EVERY: Record<PetMood, [number, number]> = {
  idle: [3500, 8000],
  happy: [2500, 5000],
  curious: [2500, 5500],
};

export interface PetInput {
  mood: PetMood;
  /** How far the body itself drifts toward the pointer (1 = a nudge; the
   *  greeter, with the screen to itself, goes further). Eyes are unaffected. */
  reach?: number;
  /** A happy playful pet sometimes twirls where others only hop. */
  playful?: boolean;
  /** Pet rect in client pixels, or null when unknown. */
  rect: Rect | null;
  /** Latest pointer, or null when it has left the window. `still` is how long
   *  it has been since it last moved (ms). */
  pointer: { x: number; y: number; still: number } | null;
}

export interface PetPose {
  /** Body: translation, lean (deg), scale — pivoting on the pet's centre and
   *  squashing from its feet. */
  tx: number;
  ty: number;
  rot: number;
  sx: number;
  sy: number;
  /** Eyes and beak slide together, like a face turning on a round head. */
  faceX: number;
  faceY: number;
  /** Ears trail the face a little, on a looser spring. */
  earX: number;
  earY: number;
  earRot: number;
  /** Per eye (left, right): offset within the face, scale, openness. */
  eyes: [EyePose, EyePose];
}

export interface EyePose {
  dx: number;
  dy: number;
  scale: number;
  open: number;
}

/** Maximum eye travel toward the pointer, in pet units. A little more than
 *  Grok's (8.4 of 259) because the pets' eyes are dots, with no white to move
 *  within — the whole dot has to travel for the look to read. */
const EYE_REACH = 10;
/** The face follows at this share of the eyes' travel. */
const FACE_FOLLOW = 0.55;
/** Lean toward the pointer (deg) at full pull; hovered pets lean further. */
const LEAN = 4.5;
const LEAN_CURIOUS = 8;
/** After this long without the pointer moving, the pet looks around again. */
const POINTER_STALE_MS = 3500;

const rand = (a: number, b: number, rnd: () => number) => a + rnd() * (b - a);

export class PetMotion {
  private readonly rnd: () => number;
  private readonly phase: number;
  // body
  private roll = spring(0);
  private sway = spring(0);
  private bob = spring(0);
  private breath = spring(1);
  private squash = spring(1);
  private spin: Spring | null = null;
  // eyes
  private open = spring(1);
  private eyeScale = spring(1);
  private lookX = spring(0);
  private lookY = spring(0);
  private gazeX = 0;
  private gazeY = 0;
  private earX = spring(0);
  private earY = spring(0);
  private earTilt = spring(0);
  private prevTx = 0;
  private prevTy = 0;
  private prevRot = 0;
  // schedules (ms, in the caller's clock)
  private blinkQueue: Keyframe[] = [];
  private nextBlink: number;
  private nextWink: number;
  private wink: { eye: 0 | 1; at: number } | null = null;
  private nextLook: number;
  private hopStart = -1e9;
  private lastArc = -1;
  private nextPerk: number;
  private perkAt = -1e9;
  private nextFlourish: number;
  private mood: PetMood | null = null;

  constructor(now: number, rnd: () => number = Math.random) {
    this.rnd = rnd;
    this.phase = rand(0, 100, rnd);
    this.nextBlink = now + rand(1500, 7000, rnd);
    this.nextWink = now + rand(12000, 26000, rnd);
    this.nextLook = now + rand(1200, 3000, rnd);
    this.nextPerk = now + rand(1600, 2800, rnd);
    this.nextFlourish = now + rand(14000, 28000, rnd);
  }

  /** Bounce — on selection, on a click. */
  hop(now: number): void {
    // Re-triggering mid-bounce would snap back to the ground; let it land.
    if (now - this.hopStart < HOP_TOTAL * 1000 * 0.6) return;
    this.hopStart = now;
    this.lastArc = -1;
  }

  /** A full turn on a spring — the greeter's answer to being clicked. */
  twirl(): void {
    if (this.spin) return;
    this.spin = { x: 0, v: 0, t: 360 * (this.rnd() < 0.5 ? 1 : -1) };
  }

  /** Blink now (e.g. on hover) unless one is already under way. */
  blink(now: number): void {
    if (this.blinkQueue.length === 0) this.blinkQueue = blinkKeyframes(now, false);
  }

  step(now: number, dtSeconds: number, input: PetInput): PetPose {
    const dt = clamp(dtSeconds, 0, 0.1);
    const { mood } = input;
    const C = now / 1000 + this.phase;
    if (mood !== this.mood) {
      // Entering a livelier mood announces itself with a blink, as Grok's
      // characters do on every state change.
      if (this.mood !== null && mood !== 'idle') this.blink(now);
      this.mood = mood;
    }

    // ── pointer → gaze (smoothed; saturating) ──────────────────────────────
    const fresh = input.pointer && input.pointer.still < POINTER_STALE_MS;
    let gx = 0;
    let gy = 0;
    if (input.pointer && input.rect) {
      const g = gazeToward(input.rect, input.pointer.x, input.pointer.y);
      // A pointer that has gone still keeps its pull, but only half of it: the
      // pet's attention drifts back to its own business.
      const hold = fresh ? 1 : 0.5;
      gx = g.x * hold;
      gy = g.y * hold;
    }
    const f = smoothing(0.16, dt);
    this.gazeX += (gx - this.gazeX) * f;
    this.gazeY += (gy - this.gazeY) * f;

    // ── look-around when the pointer is not claiming attention ─────────────
    if (now >= this.nextLook) {
      const wander = fresh ? 0.2 : 1;
      this.lookX.t = rand(-0.4, 0.4, this.rnd) * 15 * K * wander;
      this.lookY.t = rand(-0.3, 0.3, this.rnd) * 9 * K * wander;
      this.nextLook = now + rand(2500, 5500, this.rnd);
    }

    // ── mood recipes (targets) ──────────────────────────────────────────────
    const leanMax = mood === 'curious' ? LEAN_CURIOUS : LEAN;
    const lean = this.gazeX * leanMax;
    const reach = input.reach ?? 1;
    const followX = this.gazeX * 3 * reach;
    const followY = this.gazeY * 2 * reach;
    let eyeScale = 1;
    let openBase = 1;
    switch (mood) {
      case 'idle':
        this.roll.t = lean + Math.sin(C * 0.5) * 1.5 + Math.sin(C * 0.17) * 0.6;
        this.sway.t = Math.sin(C * 0.27) * 1 * K + followX;
        this.bob.t = Math.sin(C * 0.85) * 1.2 * K + followY;
        this.breath.t = 1 + Math.sin(C * 0.85) * 0.007;
        break;
      case 'happy': {
        const d = Math.sin(C * 2.4);
        this.roll.t = lean + Math.sin(C * 1.2) * 3;
        this.sway.t = Math.sin(C * 1.1) * 2.5 * K + followX;
        this.bob.t = -Math.abs(d) * 3 * K + followY;
        this.breath.t = 1 + d * 0.02;
        eyeScale = 1.05;
        // Now and then, for no reason at all, a little celebration — Grok's
        // happy characters do the same every ten-odd seconds.
        if (now >= this.nextFlourish) {
          if (input.playful && this.rnd() < 0.35) this.twirl();
          else this.hop(now);
          this.nextFlourish = now + rand(14000, 28000, this.rnd);
        }
        break;
      }
      case 'curious': {
        this.roll.t = lean + Math.sin(C * 0.7) * 3;
        this.sway.t = Math.sin(C * 0.6) * 2 * K + followX * 1.3;
        this.bob.t = -2 * K + Math.sin(C * 0.9) * 1.5 * K + followY * 1.3;
        this.breath.t = 1.01;
        eyeScale = 1.14;
        openBase = 1.08;
        // A little perk of the head every couple of seconds.
        if (now >= this.nextPerk) {
          this.perkAt = now;
          this.nextPerk = now + rand(1600, 2800, this.rnd);
        }
        const p = (now - this.perkAt) / 440;
        if (p >= 0 && p < 1) {
          const s = Math.sin(p * Math.PI);
          this.sway.t += s * 4 * K * Math.sign(this.gazeX || 1);
          this.roll.t += s * 2.5 * Math.sign(this.gazeX || 1);
        }
        break;
      }
    }
    this.eyeScale.t = eyeScale;

    // ── blinks and winks ────────────────────────────────────────────────────
    if (now >= this.nextBlink) {
      if (this.blinkQueue.length === 0) {
        this.blinkQueue = blinkKeyframes(now, this.rnd() < 0.14);
      }
      const [a, b] = BLINK_EVERY[mood];
      this.nextBlink = now + rand(a, b, this.rnd);
    }
    let keyed: number | null = null;
    while (this.blinkQueue.length > 0 && now >= this.blinkQueue[0].at) {
      keyed = (this.blinkQueue.shift() as Keyframe).v;
    }
    this.open.t = keyed ?? (this.blinkQueue.length > 0 ? this.open.t : openBase);
    if (now >= this.nextWink) {
      this.wink = { eye: this.rnd() < 0.5 ? 0 : 1, at: now };
      this.nextWink = now + rand(12000, 26000, this.rnd);
    }

    // ── hop ─────────────────────────────────────────────────────────────────
    const hop = hopAt((now - this.hopStart) / 1000);
    if (hop.arc !== this.lastArc) {
      // Each touch-down squashes the body; the breath spring's partner
      // (squash) springs it back with a small jiggle.
      if (this.lastArc >= 0) this.squash.x = 1 - 0.07 * (HOPS[this.lastArc].h / HOPS[0].h);
      this.lastArc = hop.arc;
    }

    // ── integrate ───────────────────────────────────────────────────────────
    const eyeTX = this.gazeX * EYE_REACH;
    const eyeTY = this.gazeY * EYE_REACH;
    this.earX.t = -eyeTX * FACE_FOLLOW * 0.3;
    this.earY.t = -eyeTY * FACE_FOLLOW * 0.2;
    const n = Math.max(1, Math.ceil(dt / SUBSTEP));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      stepSpring(this.roll, 5, 0.9, h);
      stepSpring(this.sway, 3.5, 1, h);
      stepSpring(this.bob, 4, 1, h);
      stepSpring(this.breath, 10, 0.8, h);
      stepSpring(this.squash, 12, 0.45, h);
      stepSpring(this.open, 26, 1, h);
      stepSpring(this.eyeScale, 9, 0.85, h);
      stepSpring(this.lookX, 13, 1, h);
      stepSpring(this.lookY, 13, 1, h);
      stepSpring(this.earX, 7, 0.55, h);
      stepSpring(this.earY, 7, 0.55, h);
      stepSpring(this.earTilt, 8, 0.5, h);
      if (this.spin) stepSpring(this.spin, 6.2, 1, h);
    }
    let spinDeg = 0;
    if (this.spin) {
      spinDeg = this.spin.x;
      if (Math.abs(this.spin.t - this.spin.x) < 0.5 && Math.abs(this.spin.v) < 1) this.spin = null;
    }
    const tx = this.sway.x;
    const ty = this.bob.x + hop.y;
    const rot = this.roll.x + spinDeg;
    // Ears are loosely attached: whatever the head just did, they are a beat
    // behind — pushed the other way, then sprung back with a little flop.
    if (dt > 0) {
      this.earX.x -= (tx - this.prevTx) * 0.45;
      this.earY.x -= (ty - this.prevTy) * 0.45;
      this.earTilt.x -= clamp(rot - this.prevRot, -20, 20) * 0.35;
    }
    this.prevTx = tx;
    this.prevTy = ty;
    this.prevRot = rot;

    // ── pose ────────────────────────────────────────────────────────────────
    const eyes = [0, 1].map((q) => {
      // Each eye drifts on its own few slow sines — alive, never in lockstep.
      const driftX = (Math.sin(now * 42e-5 + q) * 1.4 + Math.sin(now * 0.001 + q * 2) * 0.5) * K;
      const driftY = Math.sin(now * 58e-5 + q) * 0.9 * K;
      let open = Math.max(this.open.x, 0.04);
      if (this.wink && this.wink.eye === q) {
        const p = (now - this.wink.at) / 320;
        if (p >= 0 && p < 1) {
          const v = p < 0.42 ? 1 - p / 0.42 : (p - 0.42) / 0.58;
          open = Math.max(open * v, 0.04);
        }
      }
      return {
        dx: eyeTX * (1 - FACE_FOLLOW) + this.lookX.x + driftX,
        dy: eyeTY * (1 - FACE_FOLLOW) + this.lookY.x + driftY,
        scale: clamp(this.eyeScale.x, 0.5, 1.5),
        open: clamp(open, 0.04, 1.3),
      };
    }) as [EyePose, EyePose];
    if (this.wink && now - this.wink.at > 320) this.wink = null;

    return {
      tx,
      ty,
      rot,
      sx: 1 + (1 - this.squash.x) * 0.6,
      sy: this.breath.x * this.squash.x,
      faceX: eyeTX * FACE_FOLLOW,
      faceY: eyeTY * FACE_FOLLOW,
      earX: clamp(this.earX.x, -8, 8),
      earY: clamp(this.earY.x, -8, 8),
      earRot: clamp(this.earTilt.x, -10, 10),
      eyes,
    };
  }
}

/** The pose of a pet that is not moving at all (reduced motion). */
export const STILL_POSE: PetPose = {
  tx: 0,
  ty: 0,
  rot: 0,
  sx: 1,
  sy: 1,
  faceX: 0,
  faceY: 0,
  earX: 0,
  earY: 0,
  earRot: 0,
  eyes: [
    { dx: 0, dy: 0, scale: 1, open: 1 },
    { dx: 0, dy: 0, scale: 1, open: 1 },
  ],
};
