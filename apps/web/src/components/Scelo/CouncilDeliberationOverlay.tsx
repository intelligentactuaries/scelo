// Full-screen deliberation overlay for the "Convene council" action. A
// council on a local LLM takes minutes; this owns the screen while it runs
// so the wait reads as PROGRESS, not a hang.
//
// Progress is real, not theatrical: the swarm streams per-agent SSE events
// (round_start / agent_done / round_done / society_progress / done) from
// /api/run/:id/stream — the same feed its own UI uses. Each completed agent
// adds a persona to the BLOOM — the swarm app's mirrored crowd-of-circles
// animation, ported back here so both shells show the same processing
// visual (the old seat ring could only say how MANY had answered, never
// who). Round pips and a labelled society bar sit under the crowd. If the
// stream can't attach, the overlay degrades to an indeterminate note and
// the caller's polling still lands completion.
//
// Esc / "hide" tucks the overlay away without touching the run; "cancel"
// aborts it. Animations respect prefers-reduced-motion.

import { useEffect, useRef, useState } from "react";
import { PersonaBloom, seatColorFor } from "./PersonaBloom";

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
  // index → agent id; the bloom colours each circle by its speaker. Reset per
  // round AND per phase — carrying the council's map into the society phase
  // would paint hundreds of personas with a few council hues.
  const [seatIds, setSeatIds] = useState<Map<number, string>>(() => new Map());
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
            setSeatIds(new Map());
            break;
          }
          case "agent_done": {
            next.phase = "council";
            next.round = (ev.round as 1 | 2 | 3) ?? prev.round;
            next.roundDone = (ev.done as number) ?? prev.roundDone + 1;
            next.roundTotal = (ev.total as number) ?? prev.roundTotal;
            const id = String(ev.agentId ?? "");
            if (id) {
              const idx = next.roundDone - 1;
              setSeatIds((m) => {
                const nm = new Map(m);
                nm.set(idx, id);
                return nm;
              });
              next.recent = [{ seq: seqRef.current++, id }, ...prev.recent].slice(0, 4);
            }
            break;
          }
          case "society_start": {
            next.phase = "society";
            next.societyTotal = (ev.total as number) ?? prev.societyTotal;
            next.societyDone = 0;
            setSeatIds(new Map());
            break;
          }
          case "society_progress": {
            next.phase = "society";
            next.societyDone = (ev.done as number) ?? prev.societyDone;
            next.societyTotal = (ev.total as number) ?? prev.societyTotal;
            const sid = String(ev.agentId ?? "");
            if (sid) {
              const idx = next.societyDone - 1;
              setSeatIds((m) => {
                const nm = new Map(m);
                nm.set(idx, sid);
                return nm;
              });
              next.recent = [{ seq: seqRef.current++, id: sid }, ...prev.recent].slice(0, 4);
            }
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

  // Bloom sizing — the crowd lays out for whichever roster is currently
  // answering (council rounds, then the society sample), and reveals exactly
  // as many circles as have reported. No cap: the bloom compresses spacing
  // for large rosters instead of truncating them.
  const bloomTotal =
    p.phase === "society" ? p.societyTotal : p.roundTotal > 0 ? p.roundTotal : agents;
  const bloomDone = p.phase === "council" ? p.roundDone : p.phase === "society" ? p.societyDone : 0;
  const societyFrac = p.societyTotal > 0 ? p.societyDone / p.societyTotal : 0;

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

  return (
    <div className="fixed inset-0 z-[90] flex flex-col items-center justify-center bg-bg/90 backdrop-blur-md">
      <style>{`
        @keyframes scelo-council-pip {
          0%, 100% { opacity: 0.45; }
          50% { opacity: 1; }
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

      {/* the bloom — one circle per persona that has answered, coloured by
          profession. Replaces the seat ring (same visual as the swarm app). */}
      <PersonaBloom total={bloomTotal} litSeats={bloomDone} seatIds={seatIds} />

      {/* strips under the crowd: round pips · society bar · stream note */}
      <div className="flex min-h-[14px] w-[min(620px,86vw)] items-center gap-3.5">
        <div className="flex flex-none gap-[7px]" aria-hidden>
          {([1, 2, 3] as const).map((r) => {
            const done = p.phase !== "starting" && (r < p.round || p.phase !== "council");
            const now = r === p.round && p.phase === "council";
            return (
              <span
                key={r}
                className="scelo-council-anim h-2 w-2 rounded-full border"
                style={{
                  borderColor: "rgb(var(--rgb-primary))",
                  background: done
                    ? "rgb(var(--rgb-primary))"
                    : now
                      ? "rgb(var(--rgb-primary) / 0.5)"
                      : "transparent",
                  opacity: done || now ? 1 : 0.6,
                  animation: now ? "scelo-council-pip 1.6s ease-in-out infinite" : undefined,
                }}
              />
            );
          })}
        </div>
        {!skipSociety && (
          <>
            {/* Named, not just implied: an unlabelled fill sitting mid-screen
                after the pips read as a glitch rather than the society's own
                meter. */}
            <span className="flex-none font-mono text-[10px] uppercase tracking-wider text-fg-dim">
              society
            </span>
            <div
              className="h-[3px] min-w-0 flex-1 overflow-hidden rounded-sm"
              title="society pulse"
              style={{ background: "rgb(var(--rgb-border))" }}
            >
              <div
                className="h-full rounded-sm"
                style={{
                  width: `${Math.round(societyFrac * 100)}%`,
                  background: "rgb(var(--rgb-accent-2))",
                  transition: "width 600ms ease",
                }}
              />
            </div>
          </>
        )}
        {(p.phase === "starting" || !p.streamLive) && (
          <span className="flex-none font-mono text-[11px] text-fg-mute">working…</span>
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
