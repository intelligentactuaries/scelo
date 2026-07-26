// Full-screen deliberation overlay — ported from Scelo's
// CouncilDeliberationOverlay.
//
// A council on a local model takes minutes. This owns the screen while it
// runs so the wait reads as PROGRESS rather than a hang: every completed
// agent lights a seat around the ring, the rounds tick through the centre,
// the society pulse fills the outer arc, and the most recent voices scroll
// underneath.
//
// Ported as PRESENTATIONAL — Scelo's copy opens its own EventSource against
// /api/run/:id/stream because it lives in another app. Inside the swarm that
// stream is already consumed by App.tsx, so opening a second subscription
// would double the traffic and could drift out of sync with the state the
// rest of the UI renders. Everything here comes in as props instead, which
// also lets the simulation view drive the same visual from a different feed.
//
// Progress is real, never theatrical: `litSeats` and `outerFrac` come from
// actual agent counts. When there is nothing truthful to show yet, pass
// `indeterminate` and an orbiting comet says "working, count unknown".
//
// Esc hides without touching the run. Animations respect
// prefers-reduced-motion (see .delib-* in styles.css).

import { useEffect, useMemo, useState } from 'react';

/** Stable per-profession hues, so a profession keeps its colour across
 *  rounds. Agent ids look like `c-actuary-intj-f`. */
const SEAT_COLORS = [
  '#4a9eff',
  '#00d0a0',
  '#b388ff',
  '#ffb000',
  '#f472b6',
  '#22d3ee',
  '#a3e635',
  '#ff6b6b',
];

export function seatColorFor(agentId: string): string {
  const prof = agentId.split('-')[1] ?? agentId;
  let h = 0;
  for (let i = 0; i < prof.length; i++) h = (h * 31 + prof.charCodeAt(i)) >>> 0;
  return SEAT_COLORS[h % SEAT_COLORS.length];
}

export function useElapsed(active: boolean): string {
  const [t0, setT0] = useState(() => Date.now());
  const [now, setNow] = useState(t0);
  useEffect(() => {
    if (!active) return;
    setT0(Date.now());
  }, [active]);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  const s = Math.max(0, Math.floor((now - t0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export type RecentVoice = { seq: number; id: string };

export function DeliberationOverlay({
  eyebrow,
  elapsed,
  title,
  subtitle,
  note,
  seats,
  litSeats,
  seatIds,
  ticks,
  tickCurrent,
  outerFrac,
  indeterminate,
  recent = [],
  onHide,
  onCancel,
  cancelLabel = 'cancel run',
}: {
  /** Top-left strip: what is running. */
  eyebrow: string;
  /** Top-right mm:ss. */
  elapsed: string;
  /** Big centred phase headline. */
  title: string;
  /** Counts under the headline. */
  subtitle: string;
  /** Optional warning line (e.g. stream lost). */
  note?: string;
  /** Seats drawn around the ring. */
  seats: number;
  /** How many are lit. */
  litSeats: number;
  /** index → agent id, for per-seat colour. */
  seatIds?: Map<number, string>;
  /** Centre pips — rounds, or pipeline phases. */
  ticks: number;
  /** 1-based index of the current tick. */
  tickCurrent: number;
  /** Outer arc fill 0..1, or null to hide the arc entirely. */
  outerFrac?: number | null;
  /** Show the orbiting comet — "working, but no counts yet". */
  indeterminate?: boolean;
  recent?: RecentVoice[];
  onHide: () => void;
  onCancel?: () => void;
  cancelLabel?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onHide();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onHide]);

  // Cap drawn seats so a 192-agent council stays legible; fills proportionally.
  const drawn = Math.min(Math.max(seats, 1), 48);
  const lit = seats > 0 ? Math.round((litSeats / seats) * drawn) : 0;
  const R = 118;
  const OUTER_R = 148;
  const outerCirc = 2 * Math.PI * OUTER_R;

  const seatDots = useMemo(
    () =>
      Array.from({ length: drawn }, (_, i) => {
        const angle = (i / drawn) * Math.PI * 2 - Math.PI / 2;
        const id = seatIds?.get(i);
        return {
          x: 170 + R * Math.cos(angle),
          y: 170 + R * Math.sin(angle),
          lit: i < lit,
          color: id ? seatColorFor(id) : 'var(--accent)',
        };
      }),
    [drawn, lit, seatIds],
  );

  return (
    <div className="delib-overlay" role="status" aria-live="polite">
      <div className="delib-top">
        <span className="delib-eyebrow">{eyebrow}</span>
        <span className="delib-elapsed">{elapsed}</span>
      </div>

      <div className="delib-ring">
        <svg width="340" height="340" viewBox="0 0 340 340" role="img" aria-label={title}>
          {outerFrac != null && (
            <>
              <circle
                cx="170"
                cy="170"
                r={OUTER_R}
                fill="none"
                stroke="var(--border)"
                strokeWidth="3"
                opacity="0.5"
              />
              {outerFrac > 0 && (
                <circle
                  cx="170"
                  cy="170"
                  r={OUTER_R}
                  fill="none"
                  stroke="var(--link)"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={`${outerFrac * outerCirc} ${outerCirc}`}
                  transform="rotate(-90 170 170)"
                  style={{ transition: 'stroke-dasharray 600ms ease' }}
                />
              )}
            </>
          )}

          {seatDots.map((s, i) => (
            <circle
              key={`${i}-${s.lit}`}
              cx={s.x}
              cy={s.y}
              r={s.lit ? 5 : 3.5}
              fill={s.lit ? s.color : 'transparent'}
              stroke={s.lit ? s.color : 'var(--muted)'}
              strokeWidth="1.4"
              opacity={s.lit ? 0.95 : 0.45}
              style={{ transition: 'all 300ms ease' }}
            />
          ))}

          <circle
            className="delib-breathe"
            cx="170"
            cy="170"
            r="52"
            fill="color-mix(in srgb, var(--accent) 12%, transparent)"
            stroke="color-mix(in srgb, var(--accent) 60%, transparent)"
            strokeWidth="1.5"
          />

          {Array.from({ length: ticks }, (_, i) => i + 1).map((r) => (
            <circle
              key={r}
              cx={170 - ((ticks - 1) * 16) / 2 + (r - 1) * 16}
              cy="170"
              r="4.5"
              fill={
                r < tickCurrent
                  ? 'var(--accent)'
                  : r === tickCurrent
                    ? 'color-mix(in srgb, var(--accent) 50%, transparent)'
                    : 'transparent'
              }
              stroke="var(--accent)"
              strokeWidth="1.2"
              opacity={r === tickCurrent ? 1 : 0.7}
            />
          ))}
        </svg>

        {indeterminate && (
          <div className="delib-comet" aria-hidden>
            <div className="delib-comet-dot" style={{ top: `${170 - R - 4}px` }} />
          </div>
        )}
      </div>

      <div className="delib-phase">
        <div className="delib-title">{title}</div>
        <div className="delib-sub">{subtitle}</div>
        {note && <div className="delib-note">{note}</div>}
      </div>

      <div className="delib-voices">
        {recent.map((r, i) => (
          <span key={r.seq} style={{ opacity: 1 - i * 0.22 }}>
            <span style={{ color: seatColorFor(r.id) }}>●</span> {r.id} responded
          </span>
        ))}
      </div>

      <div className="delib-controls">
        <button type="button" className="ghost-btn" onClick={onHide}>
          hide — keep running <kbd className="delib-kbd">esc</kbd>
        </button>
        {onCancel && (
          <button type="button" className="ghost-btn delib-cancel" onClick={onCancel}>
            {cancelLabel}
          </button>
        )}
      </div>
    </div>
  );
}
