// Full-screen deliberation overlay for the "Convene council" action. A
// council on a local LLM takes minutes; this owns the screen while it runs
// so the wait reads as PROGRESS, not a hang.
//
// Progress is real, not theatrical: the swarm streams per-agent SSE events
// (round_start / agent_done / round_done / society_progress / done) from
// /api/run/:id/stream — the same feed its own UI uses. Each completed agent
// lights a seat around the council ring; rounds sweep the ring three times;
// the society pulse fills the outer arc. If the stream can't attach, the
// overlay degrades to a breathing indeterminate state and the caller's
// polling still lands completion.
//
// Esc / "hide" tucks the overlay away without touching the run; "cancel"
// aborts it. Animations respect prefers-reduced-motion.

import { useEffect, useMemo, useRef, useState } from "react";

type Phase = "starting" | "council" | "society" | "finishing";

type Progress = {
  phase: Phase;
  round: 1 | 2 | 3;
  roundDone: number;
  roundTotal: number;
  societyDone: number;
  societyTotal: number;
  recent: Array<{ seq: number; id: string }>;
  streamLive: boolean;
};

const ROUND_LABEL: Record<1 | 2 | 3, string> = {
  1: "independent views",
  2: "peers respond",
  3: "votes + interventions",
};

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

function seatColorFor(agentId: string): string {
  // agent ids look like c-actuary-intj-f — hash the profession token so a
  // profession keeps its hue across rounds.
  const prof = agentId.split("-")[1] ?? agentId;
  let h = 0;
  for (let i = 0; i < prof.length; i++) h = (h * 31 + prof.charCodeAt(i)) >>> 0;
  return SEAT_COLORS[h % SEAT_COLORS.length];
}

function useElapsed(): string {
  const [t0] = useState(() => Date.now());
  const [now, setNow] = useState(t0);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const s = Math.floor((now - t0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function CouncilDeliberationOverlay({
  runId,
  swarmBase,
  agents,
  skipSociety,
  modelLabel,
  onHide,
  onCancel,
  onWatchLive,
  initialProgress,
}: {
  /** Null until the swarm acknowledges the run — "starting" phase. */
  runId: string | null;
  swarmBase: string;
  agents: number;
  skipSociety: boolean;
  modelLabel: string;
  /** Tuck the overlay away; the run keeps going. */
  onHide: () => void;
  /** Abort the run entirely. */
  onCancel: () => void;
  onWatchLive: () => void;
  /** Test/SSR hook: seed the progress state (no live stream needed). */
  initialProgress?: Partial<Progress>;
}) {
  const elapsed = useElapsed();
  const [p, setP] = useState<Progress>({
    phase: "starting",
    round: 1,
    roundDone: 0,
    roundTotal: agents,
    societyDone: 0,
    societyTotal: skipSociety ? 0 : 120,
    recent: [],
    streamLive: false,
    ...initialProgress,
  });
  const seatColorsRef = useRef<Map<number, string>>(new Map());
  const seqRef = useRef(0);

  // Live progress from the swarm's SSE feed.
  useEffect(() => {
    if (!runId) return;
    const es = new EventSource(`${swarmBase}/api/run/${encodeURIComponent(runId)}/stream`);
    es.onopen = () => setP((prev) => ({ ...prev, streamLive: true }));
    es.onmessage = (m) => {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(m.data) as Record<string, unknown>;
      } catch {
        return;
      }
      setP((prev) => {
        const next = { ...prev };
        switch (ev.type) {
          case "round_start": {
            next.phase = "council";
            next.round = (ev.round as 1 | 2 | 3) ?? prev.round;
            next.roundDone = 0;
            next.roundTotal = (ev.total as number) ?? prev.roundTotal;
            seatColorsRef.current = new Map();
            break;
          }
          case "agent_done": {
            next.phase = "council";
            next.round = (ev.round as 1 | 2 | 3) ?? prev.round;
            next.roundDone = (ev.done as number) ?? prev.roundDone + 1;
            next.roundTotal = (ev.total as number) ?? prev.roundTotal;
            const id = String(ev.agentId ?? "");
            if (id) {
              seatColorsRef.current.set(next.roundDone - 1, seatColorFor(id));
              next.recent = [{ seq: seqRef.current++, id }, ...prev.recent].slice(0, 4);
            }
            break;
          }
          case "society_start": {
            next.phase = "society";
            next.societyTotal = (ev.total as number) ?? prev.societyTotal;
            next.societyDone = 0;
            break;
          }
          case "society_progress": {
            next.phase = "society";
            next.societyDone = (ev.done as number) ?? prev.societyDone;
            next.societyTotal = (ev.total as number) ?? prev.societyTotal;
            break;
          }
          case "round_done": {
            if ((ev.round as number) === 3) next.phase = skipSociety ? "finishing" : prev.phase;
            break;
          }
          case "done": {
            next.phase = "finishing";
            break;
          }
          default:
            break;
        }
        return next;
      });
    };
    es.onerror = () => {
      // Stream lost — degrade to indeterminate; polling still completes.
      setP((prev) => ({ ...prev, streamLive: false }));
    };
    return () => es.close();
  }, [runId, swarmBase, skipSociety]);

  // Esc hides (capture phase so the detail dashboard behind doesn't also
  // close); the run keeps going in the background.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onHide();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onHide]);

  // Council ring geometry — cap the drawn seats so 192-agent councils stay
  // legible; fills proportionally.
  const seats = Math.min(agents, 48);
  const litSeats =
    p.phase === "council" && p.roundTotal > 0
      ? Math.round((p.roundDone / p.roundTotal) * seats)
      : p.phase === "starting"
        ? 0
        : seats;
  const R = 118;
  const societyFrac = p.societyTotal > 0 ? p.societyDone / p.societyTotal : 0;
  const OUTER_R = 148;
  const outerCirc = 2 * Math.PI * OUTER_R;

  const phaseTitle =
    p.phase === "starting"
      ? "convening the council"
      : p.phase === "council"
        ? `round ${p.round} · ${ROUND_LABEL[p.round]}`
        : p.phase === "society"
          ? "society pulse"
          : "synthesising the verdict";

  const phaseSub =
    p.phase === "starting"
      ? p.streamLive || runId
        ? "seating stratified personas…"
        : "contacting the swarm…"
      : p.phase === "council"
        ? `${p.roundDone} / ${p.roundTotal} agents responded`
        : p.phase === "society"
          ? `${p.societyDone} / ${p.societyTotal} personas reacted`
          : "clustering stances + proposed shifts";

  const seatDots = useMemo(() => {
    return Array.from({ length: seats }, (_, i) => {
      const angle = (i / seats) * Math.PI * 2 - Math.PI / 2;
      return {
        x: 170 + R * Math.cos(angle),
        y: 170 + R * Math.sin(angle),
        lit: i < litSeats,
        color: seatColorsRef.current.get(i) ?? "rgb(var(--rgb-primary))",
      };
    });
  }, [seats, litSeats]);

  return (
    <div className="fixed inset-0 z-[90] flex flex-col items-center justify-center bg-bg/90 backdrop-blur-md">
      <style>{`
        @keyframes scelo-council-breathe {
          0%, 100% { transform: scale(1); opacity: 0.55; }
          50% { transform: scale(1.12); opacity: 0.9; }
        }
        @keyframes scelo-council-spin {
          to { transform: rotate(360deg); }
        }
        @media (prefers-reduced-motion: reduce) {
          .scelo-council-anim { animation: none !important; }
        }
      `}</style>

      {/* top strip: what + elapsed */}
      <div className="absolute inset-x-0 top-0 flex items-center justify-between px-6 py-4 font-mono text-[11px] text-fg-dim">
        <span className="uppercase tracking-wider">
          council · {agents} agents{skipSociety ? "" : " + society"} · {modelLabel}
        </span>
        <span className="tabular-nums text-fg-mute">{elapsed}</span>
      </div>

      {/* the ring */}
      <div className="relative">
        <svg width="340" height="340" viewBox="0 0 340 340" role="img" aria-label={phaseTitle}>
          {/* society arc (outer) */}
          {!skipSociety && (
            <>
              <circle
                cx="170"
                cy="170"
                r={OUTER_R}
                fill="none"
                stroke="rgb(var(--rgb-border))"
                strokeWidth="3"
                opacity="0.5"
              />
              {societyFrac > 0 && (
                <circle
                  cx="170"
                  cy="170"
                  r={OUTER_R}
                  fill="none"
                  stroke="rgb(var(--rgb-accent-2))"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={`${societyFrac * outerCirc} ${outerCirc}`}
                  transform="rotate(-90 170 170)"
                  style={{ transition: "stroke-dasharray 600ms ease" }}
                />
              )}
            </>
          )}
          {/* seat dots */}
          {seatDots.map((s, i) => (
            <circle
              key={`${i}-${s.lit}`}
              cx={s.x}
              cy={s.y}
              r={s.lit ? 5 : 3.5}
              fill={s.lit ? s.color : "transparent"}
              stroke={s.lit ? s.color : "rgb(var(--rgb-fg-dim))"}
              strokeWidth="1.4"
              opacity={s.lit ? 0.95 : 0.45}
              style={{ transition: "all 300ms ease" }}
            />
          ))}
          {/* breathing centre */}
          <circle
            className="scelo-council-anim"
            cx="170"
            cy="170"
            r="52"
            fill="rgb(var(--rgb-primary) / 0.12)"
            stroke="rgb(var(--rgb-primary) / 0.6)"
            strokeWidth="1.5"
            style={{
              transformOrigin: "170px 170px",
              animation: "scelo-council-breathe 2.6s ease-in-out infinite",
            }}
          />
          {/* round ticks in the centre */}
          {[1, 2, 3].map((r) => (
            <circle
              key={r}
              cx={154 + (r - 1) * 16}
              cy="170"
              r="4.5"
              fill={
                p.phase !== "starting" && (r < p.round || p.phase !== "council")
                  ? "rgb(var(--rgb-primary))"
                  : r === p.round && p.phase === "council"
                    ? "rgb(var(--rgb-primary) / 0.5)"
                    : "transparent"
              }
              stroke="rgb(var(--rgb-primary))"
              strokeWidth="1.2"
              opacity={r === p.round && p.phase === "council" ? 1 : 0.7}
            />
          ))}
        </svg>
        {/* orbiting comet while indeterminate (starting / stream lost) */}
        {(p.phase === "starting" || !p.streamLive) && (
          <div
            className="scelo-council-anim pointer-events-none absolute inset-0"
            style={{ animation: "scelo-council-spin 3.4s linear infinite" }}
          >
            <div
              className="absolute h-2 w-2 rounded-full"
              style={{
                left: "50%",
                top: `${170 - R - 4}px`,
                transform: "translateX(-50%)",
                background: "rgb(var(--rgb-primary))",
                boxShadow: "0 0 12px rgb(var(--rgb-primary))",
              }}
            />
          </div>
        )}
      </div>

      {/* phase + counts */}
      <div className="mt-6 text-center">
        <div className="font-mono text-[13px] uppercase tracking-[0.2em] text-fg">{phaseTitle}</div>
        <div className="mt-1 font-mono text-[11px] tabular-nums text-fg-mute">{phaseSub}</div>
        {!p.streamLive && p.phase !== "starting" && (
          <div className="mt-1 font-mono text-[10px] text-fg-dim">
            live stream unavailable — still running, completion arrives by poll
          </div>
        )}
      </div>

      {/* recent voices */}
      <div className="mt-4 flex h-16 flex-col items-center gap-0.5 font-mono text-[10px]">
        {p.recent.map((r, i) => (
          <span key={r.seq} style={{ opacity: 1 - i * 0.22 }} className="text-fg-dim">
            <span style={{ color: seatColorFor(r.id) }}>●</span> {r.id} responded
          </span>
        ))}
      </div>

      {/* controls */}
      <div className="mt-2 flex items-center gap-2">
        <button type="button" onClick={onHide} className="ia-btn ia-btn-sm ia-btn-secondary">
          hide — keep running
          <span className="ml-1.5 rounded border border-border bg-bg px-1 font-mono text-[9px] text-fg-dim">
            esc
          </span>
        </button>
        <button type="button" onClick={onWatchLive} className="ia-btn ia-btn-sm ia-btn-secondary">
          watch live in swarm ↗
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="ia-btn ia-btn-sm ia-btn-secondary text-error hover:border-error"
        >
          cancel run
        </button>
      </div>
    </div>
  );
}
