// A living pet: the icon, drawn inline so its parts can move (see
// lib/petMotion.ts for how, lib/petShapes.ts for what).
//
// Every mounted pet shares one animation frame loop and one pointer listener.
// Frames write SVG transforms straight onto the parts — React renders the pet
// once and never again for motion, so a rail of six breathing, blinking,
// cursor-watching animals costs a handful of setAttribute calls per frame.
// The loop parks while the page is hidden, and with reduced motion the pet is
// simply the still icon.
//
// Hover and press are read from the nearest button or link around the pet,
// so callers keep their own markup: hovering a rail item makes its pet
// curious (leans in, eyes wide), pressing it makes it hop.

import { useEffect, useRef } from 'react';
import { PetMotion, type PetMood, type PetPose } from '../lib/petMotion';
import { PET_SHAPES, type PetKind, type PetPart } from '../lib/petShapes';

// ── one loop, one pointer ───────────────────────────────────────────────────

interface Driven {
  frame(now: number, dt: number): void;
}

const driven = new Set<Driven>();
let raf = 0;
let lastFrame = 0;
let pointer: { x: number; y: number; at: number } | null = null;
let listening = false;

function listen(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener(
    'pointermove',
    (e) => {
      pointer = { x: e.clientX, y: e.clientY, at: performance.now() };
    },
    { passive: true },
  );
  document.documentElement.addEventListener('pointerleave', () => {
    pointer = null;
  });
  window.addEventListener('blur', () => {
    pointer = null;
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) wake();
  });
}

function loop(now: number): void {
  raf = 0;
  if (document.hidden || driven.size === 0) return;
  const dt = lastFrame ? (now - lastFrame) / 1000 : 1 / 60;
  lastFrame = now;
  for (const d of driven) d.frame(now, dt);
  raf = requestAnimationFrame(loop);
}

function wake(): void {
  if (raf || driven.size === 0 || document.hidden) return;
  lastFrame = 0;
  raf = requestAnimationFrame(loop);
}

function reducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

// ── drawing ─────────────────────────────────────────────────────────────────

function Part({ part }: { part: PetPart }) {
  switch (part.shape) {
    case 'circle':
      return <circle cx={part.cx} cy={part.cy} r={part.r} fill={part.fill} />;
    case 'ellipse':
      return (
        <ellipse
          cx={part.cx}
          cy={part.cy}
          rx={part.rx}
          ry={part.ry}
          fill={part.fill}
          transform={part.rotate ? `rotate(${part.rotate} ${part.cx} ${part.cy})` : undefined}
        />
      );
    case 'path':
      return <path d={part.d} fill={part.fill} />;
  }
}

const f2 = (n: number) => (Math.abs(n) < 0.005 ? '0' : n.toFixed(2));
const f4 = (n: number) => n.toFixed(4);

export function Pet({
  kind,
  mood = 'idle',
  active = false,
  playful = false,
  reach = 1,
  className,
  dataPet,
}: {
  kind: PetKind;
  /** Resting temperament; hovering makes any pet curious. */
  mood?: PetMood;
  /** Hops when it becomes true (a rail pet being chosen). */
  active?: boolean;
  /** Pressing it twirls as well as hops — for a pet with nothing else to do. */
  playful?: boolean;
  /** How far the body drifts toward the cursor (the eyes always follow). */
  reach?: number;
  className?: string;
  /** Rendered as data-pet — the rail seat petFlight lands on. */
  dataPet?: string;
}) {
  const shape = PET_SHAPES[kind];
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const bodyRef = useRef<SVGGElement | null>(null);
  const earsRef = useRef<SVGGElement | null>(null);
  const faceRef = useRef<SVGGElement | null>(null);
  const eyeRefs = useRef<Array<SVGCircleElement | null>>([null, null]);
  const moodRef = useRef(mood);
  moodRef.current = mood;
  const motionRef = useRef<PetMotion | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || reducedMotion()) return;
    listen();
    const motion = new PetMotion(performance.now());
    motionRef.current = motion;
    const [px, py] = shape.pivot;
    const feet = shape.feet;
    const eyeAt = [shape.eyes.l, shape.eyes.r];
    let rect: DOMRect | null = null;
    let rectAt = -1e9;
    let hovered = false;
    const last = { body: '', ears: '', face: '', eyes: ['', ''] };

    const apply = (p: PetPose) => {
      const body = `translate(${f2(p.tx)} ${f2(p.ty)}) rotate(${f2(p.rot)} ${px} ${py}) translate(${px} ${feet}) scale(${f4(p.sx)} ${f4(p.sy)}) translate(${-px} ${-feet})`;
      if (body !== last.body) {
        bodyRef.current?.setAttribute('transform', body);
        last.body = body;
      }
      const ears = `translate(${f2(p.earX)} ${f2(p.earY)}) rotate(${f2(p.earRot)} ${px} ${py})`;
      if (ears !== last.ears) {
        earsRef.current?.setAttribute('transform', ears);
        last.ears = ears;
      }
      const face = `translate(${f2(p.faceX)} ${f2(p.faceY)})`;
      if (face !== last.face) {
        faceRef.current?.setAttribute('transform', face);
        last.face = face;
      }
      for (let i = 0; i < 2; i++) {
        const e = p.eyes[i];
        const [ex, ey] = eyeAt[i];
        const t = `translate(${f2(ex + e.dx)} ${f2(ey + e.dy)}) scale(${f4(e.scale)} ${f4(e.scale * e.open)}) translate(${-ex} ${-ey})`;
        if (t !== last.eyes[i]) {
          eyeRefs.current[i]?.setAttribute('transform', t);
          last.eyes[i] = t;
        }
      }
    };

    const d: Driven = {
      frame(now, dt) {
        if (now - rectAt > 200) {
          rect = root.getBoundingClientRect();
          rectAt = now;
        }
        // Collapsed or display:none — nothing to animate, nothing to see.
        if (!rect || rect.width === 0) return;
        apply(
          motion.step(now, dt, {
            mood: hovered ? 'curious' : moodRef.current,
            reach,
            playful,
            rect,
            pointer: pointer
              ? { x: pointer.x, y: pointer.y, still: now - pointer.at }
              : null,
          }),
        );
      },
    };
    driven.add(d);
    wake();

    const host: HTMLElement = root.closest('button, a') ?? root;
    const enter = () => {
      hovered = true;
    };
    const leave = () => {
      hovered = false;
    };
    const press = () => {
      const now = performance.now();
      motion.hop(now);
      if (playful) motion.twirl();
    };
    host.addEventListener('pointerenter', enter);
    host.addEventListener('pointerleave', leave);
    host.addEventListener('pointerdown', press);
    return () => {
      driven.delete(d);
      host.removeEventListener('pointerenter', enter);
      host.removeEventListener('pointerleave', leave);
      host.removeEventListener('pointerdown', press);
      motionRef.current = null;
    };
  }, [shape, playful, reach]);

  // Being chosen is worth a hop.
  useEffect(() => {
    if (active) motionRef.current?.hop(performance.now());
  }, [active]);

  const [lx, ly] = shape.eyes.l;
  const [rx, ry] = shape.eyes.r;
  return (
    <span ref={rootRef} className={className} data-pet={dataPet} aria-hidden>
      <svg
        className="pet-svg"
        viewBox="0 0 168 168"
        width="100%"
        height="100%"
        overflow="visible"
        focusable="false"
      >
        <g ref={bodyRef}>
          {shape.ears.length > 0 && (
            <g ref={earsRef}>
              {shape.ears.map((p, i) => (
                <Part key={i} part={p} />
              ))}
            </g>
          )}
          {shape.body.map((p, i) => (
            <Part key={i} part={p} />
          ))}
          <g ref={faceRef}>
            <circle
              ref={(el) => {
                eyeRefs.current[0] = el;
              }}
              cx={lx}
              cy={ly}
              r={shape.eyes.radius}
              fill={shape.eyes.fill}
            />
            <circle
              ref={(el) => {
                eyeRefs.current[1] = el;
              }}
              cx={rx}
              cy={ry}
              r={shape.eyes.radius}
              fill={shape.eyes.fill}
            />
            {shape.face.map((p, i) => (
                <Part key={i} part={p} />
            ))}
          </g>
        </g>
      </svg>
    </span>
  );
}
