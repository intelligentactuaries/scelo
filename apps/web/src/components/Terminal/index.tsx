// xterm.js wrapper subscribing to /terminal/stream (SSE).
// Mirrors agent invocations, audit entries, and errors from the backend.

import { API_BASE } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";

type TerminalEvent = {
  ts?: string;
  // The event "kind" is carried by the SSE event name; payload is the JSON body.
};

type ConnState = "connecting" | "open" | "retrying" | "paused";

const PRIMARY = "\x1b[38;2;0;214;143m";
const DIM = "\x1b[38;2;90;90;90m";
const ERROR = "\x1b[38;2;255;107;107m";
const RESET = "\x1b[0m";

function fmtTime(ts?: string): string {
  if (!ts) return "         ";
  try {
    return new Date(ts).toISOString().slice(11, 19);
  } catch {
    return "         ";
  }
}

function colorFor(kind: string): string {
  if (kind === "error" || kind === "run_failed") return ERROR;
  if (kind === "agent_call" || kind === "agent_result" || kind === "tool_call") return PRIMARY;
  return DIM;
}

export function Terminal({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const pausedRef = useRef(false);
  const bufferRef = useRef<string[]>([]);
  const retryRef = useRef<number | null>(null);
  const [state, setState] = useState<ConnState>("connecting");
  const [paused, setPaused] = useState(false);
  const { resolved } = useTheme();

  // ── terminal mount ─────────────────────────────────────────────────────────
  // Re-mount when the theme switches — xterm doesn't expose a clean way to
  // mutate `theme` after construction, so we key the effect on `resolved`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit re-mount on theme change.
  useEffect(() => {
    if (!ref.current) return;
    const isLight = resolved === "light";
    const term = new XTerm({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      theme: {
        background: isLight ? "#ffffff" : "#0d0d0d",
        foreground: isLight ? "#181818" : "#e8e8e8",
        cursor: isLight ? "#009669" : "#00d68f",
      },
      cursorBlink: true,
      convertEol: true,
      disableStdin: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    fit.fit();
    term.writeln(`${PRIMARY}(Iα)ₐᵢ${RESET}  Intelligent Actuaries — terminal`);
    termRef.current = term;
    fitRef.current = fit;

    const onResize = () => fit.fit();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [resolved]);

  // ── SSE connect + reconnect ─────────────────────────────────────────────────
  useEffect(() => {
    let backoff = 1000;
    const MAX_BACKOFF = 30_000;
    let cancelled = false;

    const writeFrame = (kind: string, data: TerminalEvent) => {
      const term = termRef.current;
      if (!term) return;
      const line = `${DIM}${fmtTime(data.ts)}${RESET} ${colorFor(kind)}${kind.padEnd(14)}${RESET} ${DIM}${JSON.stringify(
        data,
      )}${RESET}`;
      if (pausedRef.current) {
        bufferRef.current.push(line);
        if (bufferRef.current.length > 1000) bufferRef.current.shift();
        return;
      }
      term.writeln(line);
    };

    const connect = () => {
      if (cancelled) return;
      setState("connecting");
      const es = new EventSource(`${API_BASE}/terminal/stream`);
      esRef.current = es;

      es.addEventListener("hello", () => {
        backoff = 1000;
        setState("open");
        termRef.current?.writeln(`${DIM}— stream connected —${RESET}`);
      });
      // Add listeners for the kinds the backend emits.
      for (const kind of ["agent_call", "agent_result", "audit", "error", "run_failed"]) {
        es.addEventListener(kind, (ev: MessageEvent) => {
          try {
            const body = JSON.parse(ev.data || "{}");
            writeFrame(kind, body);
          } catch {
            writeFrame(kind, { ts: new Date().toISOString() });
          }
        });
      }
      // ping/keepalive — no rendering.
      es.addEventListener("ping", () => {});

      es.onerror = () => {
        es.close();
        if (cancelled) return;
        setState("retrying");
        termRef.current?.writeln(`${ERROR}— disconnected; retrying in ${backoff}ms —${RESET}`);
        retryRef.current = window.setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF);
      };
    };

    connect();
    return () => {
      cancelled = true;
      esRef.current?.close();
      esRef.current = null;
      if (retryRef.current !== null) {
        window.clearTimeout(retryRef.current);
        retryRef.current = null;
      }
    };
  }, []);

  const togglePause = () => {
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
    if (!pausedRef.current && termRef.current) {
      // Drain buffer.
      const buf = bufferRef.current;
      bufferRef.current = [];
      for (const line of buf) termRef.current.writeln(line);
    }
  };

  const stateLabel =
    state === "open"
      ? "● live"
      : state === "connecting"
        ? "○ connecting"
        : state === "retrying"
          ? "◌ retrying"
          : "‖ paused";

  return (
    <div className={`flex flex-col ${className ?? ""}`}>
      <div className="flex items-center justify-between border-b border-border bg-bg-2 px-2 py-1 text-[11px] uppercase text-fg-mute">
        <span>terminal · /terminal/stream</span>
        <div className="flex items-center gap-3">
          <span
            className={
              state === "open"
                ? "text-primary"
                : state === "retrying"
                  ? "text-error"
                  : "text-fg-mute"
            }
          >
            {stateLabel}
          </span>
          <button
            type="button"
            onClick={togglePause}
            className="border border-border px-1.5 hover:border-primary hover:text-primary"
          >
            {paused ? "resume" : "pause"}
          </button>
        </div>
      </div>
      <div ref={ref} className="flex-1 overflow-hidden" />
    </div>
  );
}
