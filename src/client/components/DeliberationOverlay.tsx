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

import { useEffect, useState } from 'react';
import { PersonaBloom } from './PersonaBloom';

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
  total,
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
  /** Roster size — the bloom lays out for the full crowd, then reveals it. */
  total: number;
  /** Agents that have answered. */
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

  return (
    <div className="delib-overlay" role="status" aria-live="polite">
      <div className="delib-top">
        <span className="delib-eyebrow">{eyebrow}</span>
        <span className="delib-elapsed">{elapsed}</span>
      </div>

      {/* Progress as a bloom of personas rather than a ring of identical
          dots: which professions have reported, not just how many agents
          have. The phase pips and the society arc move out of the ring's
          centre into their own strips below. */}
      <PersonaBloom total={total} litSeats={litSeats} seatIds={seatIds} />

      <div className="delib-strips">
        <div className="delib-pips" aria-hidden>
          {Array.from({ length: ticks }, (_, i) => i + 1).map((r) => (
            <span
              key={r}
              className={`delib-pip ${r < tickCurrent ? 'is-done' : r === tickCurrent ? 'is-now' : ''}`}
            />
          ))}
        </div>
        {outerFrac != null && (
          <div className="delib-outer" title="society pulse">
            <div className="delib-outer-fill" style={{ width: `${Math.round(outerFrac * 100)}%` }} />
          </div>
        )}
        {indeterminate && <span className="delib-working">working…</span>}
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
