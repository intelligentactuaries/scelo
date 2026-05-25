// Find-in-files panel. Shells out to ripgrep (`@vscode/ripgrep` ships
// per-platform prebuilt binaries; we use the bundled path when available
// and fall back to a system `rg` on PATH otherwise) via the streaming
// shell IPC, parses one JSON event per line.
//
// Per-match highlights come from ripgrep's `submatches[]` field — for
// each match line we render the preview as a sequence of bold and
// plain spans.  Include / exclude glob inputs map straight to `--glob`
// flags so the user can scope to e.g. `*.py` or skip vendor dirs.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { refreshGit } from "../../lib/gitBus";
import { useDraft } from "../../lib/inputDrafts";
import { isDesktopIDE } from "../../lib/sceloIDE";
import { emitToast } from "../../lib/toastBus";

interface Submatch {
  start: number;
  end: number;
}

interface Match {
  path: string;        // relative to workspace
  lineNumber: number;
  preview: string;
  submatches: Submatch[];
}

interface Props {
  workspacePath: string | null;
  onOpen: (relPath: string, line: number) => void;
}

const HISTORY_MAX = 20;
const HISTORY_KEY_PREFIX = "ia.scelo.search.history.";

function historyKey(workspacePath: string | null): string {
  // Per-workspace history so switching workspaces doesn't intermix
  // queries that referenced files that no longer exist.
  return `${HISTORY_KEY_PREFIX}${workspacePath ?? "default"}`;
}

function readHistory(workspacePath: string | null): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(historyKey(workspacePath));
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string").slice(0, HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

function pushHistory(workspacePath: string | null, query: string): void {
  if (typeof localStorage === "undefined") return;
  if (!query.trim()) return;
  const cur = readHistory(workspacePath).filter((q) => q !== query);
  const next = [query, ...cur].slice(0, HISTORY_MAX);
  try {
    localStorage.setItem(historyKey(workspacePath), JSON.stringify(next));
  } catch {
    // ignore quota errors
  }
}

export default function SearchPanel({ workspacePath, onOpen }: Props) {
  // Per-workspace draft persistence — flipping to another sidebar
  // tab and back keeps the query, glob filters, and replacement
  // exactly as the user left them.
  const draftScope = `search.${workspacePath ?? "default"}`;
  const [query, setQuery] = useDraft(`${draftScope}.query`);
  const [includeGlob, setIncludeGlob] = useDraft(`${draftScope}.include`);
  const [excludeGlob, setExcludeGlob] = useDraft(`${draftScope}.exclude`);
  const [replacement, setReplacement] = useDraft(`${draftScope}.replace`);
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [matches, setMatches] = useState<Match[]>([]);
  const [status, setStatus] = useState<"idle" | "searching" | "done" | { error: string }>(
    "idle",
  );
  const [rgPath, setRgPath] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const sessionIdRef = useRef<string | null>(null);
  const bufferRef = useRef("");

  // Group matches by file so the replace IPC payload is compact + so
  // the "Replace in N files" button can report something meaningful.
  const fileCount = useMemo(() => {
    const s = new Set<string>();
    for (const m of matches) s.add(m.path);
    return s.size;
  }, [matches]);

  const runReplace = useCallback(async () => {
    if (!isDesktopIDE() || matches.length === 0) return;
    setBusy(true);
    const grouped = new Map<string, Array<{ lineNumber: number; start: number; end: number }>>();
    for (const m of matches) {
      const arr = grouped.get(m.path) ?? [];
      for (const sm of m.submatches) {
        arr.push({ lineNumber: m.lineNumber, start: sm.start, end: sm.end });
      }
      grouped.set(m.path, arr);
    }
    const files = Array.from(grouped, ([path, edits]) => ({ path, edits }));
    const r = await window.scelo!.fs.replace(files, replacement);
    setBusy(false);
    setShowConfirm(false);
    if (r.ok) {
      emitToast(
        `Replaced ${r.matchesReplaced} match${r.matchesReplaced === 1 ? "" : "es"} in ${r.filesWritten} file${r.filesWritten === 1 ? "" : "s"}.`,
        "success",
      );
      void refreshGit();
      // Clear matches: their offsets are stale post-write.
      setMatches([]);
      setStatus("done");
    } else {
      emitToast(r.error ?? "Replace failed.", "error");
    }
  }, [matches, replacement]);

  // Refresh history whenever the workspace changes (history is per-workspace).
  useEffect(() => {
    setHistory(readHistory(workspacePath));
  }, [workspacePath]);

  // Resolve the bundled rg path on mount; null means "fall back to PATH".
  useEffect(() => {
    if (!isDesktopIDE()) return;
    window.scelo!.tools.ripgrepPath().then((r) => setRgPath(r.path));
  }, []);

  const stop = useCallback(async () => {
    if (sessionIdRef.current && isDesktopIDE()) {
      await window.scelo!.exec.cancel(sessionIdRef.current);
    }
    sessionIdRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      void stop();
    };
  }, [stop]);

  const runSearch = useCallback(async () => {
    if (!isDesktopIDE() || !workspacePath) return;
    if (!query.trim()) {
      setMatches([]);
      setStatus("idle");
      return;
    }
    await stop();
    setMatches([]);
    setStatus("searching");
    bufferRef.current = "";
    pushHistory(workspacePath, query);
    setHistory(readHistory(workspacePath));

    // Build the rg argv. We always pass --json + --max-count cap; the
    // user can narrow via include/exclude globs without touching the
    // base flags.
    const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    const parts: string[] = [
      rgPath ? sq(rgPath) : "rg",
      "--json",
      "--max-count 200",
      "--hidden",
      "--glob '!node_modules'",
      "--glob '!__pycache__'",
      "--glob '!.git'",
    ];
    if (includeGlob.trim()) parts.push(`--glob ${sq(includeGlob.trim())}`);
    if (excludeGlob.trim()) parts.push(`--glob ${sq("!" + excludeGlob.trim())}`);
    parts.push(sq(query));
    parts.push(sq(workspacePath));
    const cmd = parts.join(" ");

    const res = await window.scelo!.exec.start({
      runtime: "shell",
      command: cmd,
      cwd: workspacePath,
    });
    if ("error" in res) {
      setStatus({ error: res.error });
      return;
    }
    sessionIdRef.current = res.sessionId;

    const offChunk = window.scelo!.exec.onChunk((chunk) => {
      if (chunk.sessionId !== res.sessionId) return;
      bufferRef.current += chunk.data;
      const lines = bufferRef.current.split("\n");
      bufferRef.current = lines.pop() ?? "";
      const newOnes: Match[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as {
            type: string;
            data?: {
              path?: { text?: string };
              line_number?: number;
              lines?: { text?: string };
              submatches?: Array<{ start: number; end: number }>;
            };
          };
          if (ev.type !== "match" || !ev.data) continue;
          const path = ev.data.path?.text ?? "";
          const ln = ev.data.line_number ?? 0;
          const preview = (ev.data.lines?.text ?? "").replace(/\n$/, "");
          if (!path || !ln) continue;
          newOnes.push({
            path: makeRel(path, workspacePath),
            lineNumber: ln,
            preview,
            submatches: ev.data.submatches ?? [],
          });
        } catch {
          // not a JSON line (rg startup banner, etc.) — skip
        }
      }
      if (newOnes.length > 0) setMatches((cur) => [...cur, ...newOnes]);
    });

    const offEnd = window.scelo!.exec.onEnd((end) => {
      if (end.sessionId !== res.sessionId) return;
      offChunk();
      offEnd();
      sessionIdRef.current = null;
      if (end.error) {
        setStatus({ error: end.error });
      } else {
        setStatus("done");
      }
    });
  }, [query, includeGlob, excludeGlob, workspacePath, rgPath, stop]);

  if (!isDesktopIDE()) {
    return (
      <div className="p-3 text-xs text-fg-mute">
        Find-in-files is only available inside Scelo IDE.
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col bg-bg-2 text-fg">
      <div className="border-b border-border px-3 py-1">
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-wider text-fg-mute">search</span>
          <span className="text-[9px] text-fg-mute" title={rgPath ?? "system PATH"}>
            {rgPath ? "bundled rg" : "system rg"}
          </span>
        </div>
        <div className="mt-1 flex gap-1">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runSearch();
              if (e.key === "Escape") stop();
            }}
            placeholder="ripgrep regex…"
            className="flex-1 rounded border border-border bg-bg px-2 py-1 font-mono text-[11px]"
            disabled={!workspacePath}
          />
          <button
            type="button"
            onClick={runSearch}
            disabled={!workspacePath || !query.trim()}
            className="ia-btn ia-btn-sm ia-btn-primary"
          >
            find
          </button>
        </div>
        <div className="mt-1 grid grid-cols-2 gap-1">
          <input
            type="text"
            value={includeGlob}
            onChange={(e) => setIncludeGlob(e.target.value)}
            placeholder="include · e.g. *.py"
            className="rounded border border-border bg-bg px-2 py-0.5 font-mono text-[10px]"
            disabled={!workspacePath}
          />
          <input
            type="text"
            value={excludeGlob}
            onChange={(e) => setExcludeGlob(e.target.value)}
            placeholder="exclude · e.g. tests/*"
            className="rounded border border-border bg-bg px-2 py-0.5 font-mono text-[10px]"
            disabled={!workspacePath}
          />
        </div>
        <div className="mt-1 flex gap-1">
          <input
            type="text"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            placeholder="replace · literal string (empty = delete matches)"
            className="flex-1 rounded border border-border bg-bg px-2 py-1 font-mono text-[10px]"
            disabled={!workspacePath || matches.length === 0}
          />
          <button
            type="button"
            onClick={() => setShowConfirm(true)}
            disabled={!workspacePath || matches.length === 0 || busy}
            className="ia-btn ia-btn-sm ia-btn-secondary"
            title={
              matches.length === 0
                ? "Run a search first"
                : `Replace ${matches.length} match${matches.length === 1 ? "" : "es"} in ${fileCount} file${fileCount === 1 ? "" : "s"}`
            }
          >
            replace…
          </button>
        </div>
        {history.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {history.slice(0, 8).map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => {
                  setQuery(h);
                  // Defer so query state lands before the search reads it.
                  setTimeout(() => runSearch(), 0);
                }}
                title={h}
                className="max-w-[12em] truncate rounded-full border border-border bg-bg px-2 py-0.5 font-mono text-[10px] text-fg-mute hover:border-fg hover:text-fg"
              >
                {h}
              </button>
            ))}
          </div>
        )}
        <div className="mt-1 text-[10px] text-fg-mute">
          {status === "searching" && "searching…"}
          {status === "done" && `${matches.length} match${matches.length === 1 ? "" : "es"}`}
          {typeof status === "object" &&
            (status.error.includes("not found") ||
            status.error.toLowerCase().includes("command not found")
              ? "ripgrep not on PATH and bundled binary unavailable"
              : `error: ${status.error}`)}
          {!workspacePath && "pick a workspace first"}
        </div>
      </div>
      <ul className="flex-1 overflow-auto text-xs">
        {matches.map((m, i) => (
          <li
            key={`${m.path}:${m.lineNumber}:${i}`}
            className="cursor-pointer border-b border-border/40 px-3 py-1 hover:bg-bg"
            onClick={() => onOpen(m.path, m.lineNumber)}
          >
            <div className="font-mono text-[10px] text-fg-mute">
              {m.path}:{m.lineNumber}
            </div>
            <div className="mt-0.5 truncate font-mono text-[11px]">
              {renderHighlighted(m.preview, m.submatches)}
            </div>
          </li>
        ))}
      </ul>
      {showConfirm && (
        <ReplaceConfirm
          matchCount={matches.length}
          fileCount={fileCount}
          replacement={replacement}
          onCancel={() => setShowConfirm(false)}
          onConfirm={runReplace}
          busy={busy}
        />
      )}
    </div>
  );
}

function ReplaceConfirm({
  matchCount,
  fileCount,
  replacement,
  onCancel,
  onConfirm,
  busy,
}: {
  matchCount: number;
  fileCount: number;
  replacement: string;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-bg/80 p-4">
      <div className="w-full max-w-sm rounded border border-border bg-bg-2 p-4 text-xs">
        <h3 className="text-sm text-fg">Confirm replace</h3>
        <p className="mt-2 text-fg-mute">
          About to rewrite <span className="text-fg">{fileCount}</span> file
          {fileCount === 1 ? "" : "s"} with{" "}
          <span className="text-fg">{matchCount}</span> total replacement
          {matchCount === 1 ? "" : "s"}. This writes directly to disk; review
          the diff in the source-control panel afterwards if you need to
          undo.
        </p>
        <pre className="mt-2 max-h-24 overflow-auto rounded border border-border bg-bg px-2 py-1 font-mono text-[10px] text-fg">
          {replacement.length === 0 ? "(empty — matches will be deleted)" : replacement}
        </pre>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="ia-btn ia-btn-sm ia-btn-ghost"
          >
            cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="ia-btn ia-btn-sm ia-btn-primary"
          >
            {busy ? "replacing…" : "replace"}
          </button>
        </div>
      </div>
    </div>
  );
}

function makeRel(absPath: string, workspacePath: string): string {
  const trim = workspacePath.endsWith("/") ? workspacePath : workspacePath + "/";
  return absPath.startsWith(trim) ? absPath.slice(trim.length) : absPath;
}

/** Render the preview line with the ripgrep-reported submatches bolded.
 *  Submatch offsets are byte-based; we treat the preview as UTF-8 and
 *  slice by char index — close enough for ASCII-heavy actuarial code,
 *  and graceful if it slightly mis-slices on multi-byte characters. */
function renderHighlighted(preview: string, submatches: Submatch[]) {
  if (submatches.length === 0) return preview;
  const ordered = [...submatches].sort((a, b) => a.start - b.start);
  const out: React.ReactNode[] = [];
  let cursor = 0;
  ordered.forEach((sm, i) => {
    if (sm.start > cursor) out.push(preview.slice(cursor, sm.start));
    out.push(
      <strong key={i} className="rounded bg-dissent/20 text-fg">
        {preview.slice(sm.start, sm.end)}
      </strong>,
    );
    cursor = sm.end;
  });
  if (cursor < preview.length) out.push(preview.slice(cursor));
  return out;
}
