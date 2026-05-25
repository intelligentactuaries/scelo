// xterm.js terminal panel for the Scelo IDE workspace.
//
// Talks to a child bash/zsh (mac/linux) or cmd.exe (windows) via the
// Electron exec IPC. PATH is augmented in the main process so `python`
// and `R` resolve to the bundled runtimes — `python -c "import lifelib"`
// works out of the box for an actuary who just downloaded the IDE.
//
// We use a long-lived shell session (no specific command), then forward
// each keystroke as a stdin write. That's NOT a real PTY — line-edit and
// readline behaviour is limited — but it's good enough for one-liners
// (pip install, R --version, ls, …) without pulling node-pty (which is
// a native module and complicates Electron packaging).

import { useEffect, useRef, useState } from "react";
import { FitAddon } from "xterm-addon-fit";
import { Terminal } from "xterm";
import "xterm/css/xterm.css";
import { isDesktopIDE } from "../../lib/sceloIDE";
import { subscribeTerminal } from "../../lib/terminalBus";

interface Props {
  cwd?: string | null;
}

export default function TerminalPanel({ cwd }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      fontFamily:
        "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12,
      lineHeight: 1.2,
      // Theme follows the active IDE palette. We pick CSS vars at runtime so a
      // theme switch repaints on the next resize.
      theme: themeFromDocument(),
      cursorBlink: true,
      convertEol: true,
      scrollback: 4000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(containerRef.current);

    if (!isDesktopIDE()) {
      term.writeln(
        "\x1b[33mTerminal is only available inside Scelo IDE.\x1b[0m",
      );
      term.writeln("(window.scelo is not exposed in a regular browser.)");
      return () => {
        ro.disconnect();
        term.dispose();
      };
    }

    let offChunk: (() => void) | null = null;
    let offEnd: (() => void) | null = null;
    let offTerminalBus: (() => void) | null = null;

    (async () => {
      const res = await window.scelo!.exec.start({
        runtime: "shell",
        cwd: cwd ?? undefined,
      });
      if ("error" in res) {
        term.writeln(`\x1b[31mfailed to start shell: ${res.error}\x1b[0m`);
        return;
      }
      sessionIdRef.current = res.sessionId;
      setRunning(true);

      offChunk = window.scelo!.exec.onChunk((chunk) => {
        if (chunk.sessionId !== res.sessionId) return;
        term.write(chunk.data);
      });
      offEnd = window.scelo!.exec.onEnd((end) => {
        if (end.sessionId !== res.sessionId) return;
        if (end.error) {
          term.writeln(`\r\n\x1b[31m[shell exited: ${end.error}]\x1b[0m`);
        } else {
          term.writeln(`\r\n\x1b[2m[shell exited (code ${end.exitCode ?? 0})]\x1b[0m`);
        }
        setRunning(false);
      });

      term.onData((data) => {
        if (!sessionIdRef.current) return;
        window.scelo!.exec.write(sessionIdRef.current, data);
      });
      term.onResize(({ cols, rows }) => {
        if (!sessionIdRef.current) return;
        window.scelo!.exec.resize(sessionIdRef.current, cols, rows);
      });
      // Send the current geometry once we have a session, so the bundled
      // shell starts at the right size instead of the default 80×24.
      window.scelo!.exec.resize(res.sessionId, term.cols, term.rows);

      // Listen for "Run: Current File" (and any other) command requests
      // and pipe them straight to the shell as if the user typed them.
      offTerminalBus = subscribeTerminal((cmd) => {
        if (!sessionIdRef.current) return;
        const payload = cmd.endsWith("\n") ? cmd : `${cmd}\n`;
        window.scelo!.exec.write(sessionIdRef.current, payload);
      });
    })();

    return () => {
      ro.disconnect();
      offChunk?.();
      offEnd?.();
      offTerminalBus?.();
      if (sessionIdRef.current) {
        window.scelo!.exec.cancel(sessionIdRef.current);
      }
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      <div className="flex items-baseline justify-between border-b border-border bg-bg-2 px-3 py-1">
        <span className="text-[10px] uppercase tracking-wider text-fg-mute">
          terminal {cwd ? `· ${cwd}` : ""}
        </span>
        <span className="text-[10px] text-fg-mute">
          {running ? "running" : "exited"} · bundled python/R on PATH
        </span>
      </div>
      <div ref={containerRef} className="flex-1 overflow-hidden p-1" />
    </div>
  );
}

// Pull the cream/charcoal-ink palette out of the document so xterm doesn't
// need its own theme system — flips automatically when the user toggles
// the IDE theme since the CSS vars do.
function themeFromDocument(): Record<string, string> {
  if (typeof getComputedStyle === "undefined") return {};
  const style = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--bg", "#1B1815"),
    foreground: v("--fg", "#F1ECDF"),
    cursor: v("--fg", "#F1ECDF"),
    selectionBackground: "rgba(48,145,95,0.35)",
  };
}
