// Cmd/Ctrl-P fuzzy-file-picker.
//
// Owns the file enumeration (bundled `rg --files`) + the path-aware
// fuzzy matcher (basename + word-boundary + contiguous-match
// bonuses); defers to the shared `<Palette>` for the modal shell.

import { useEffect, useMemo, useRef, useState } from "react";
import { isDesktopIDE } from "../../lib/sceloIDE";
import Palette from "./Palette";

interface Props {
  workspacePath: string | null;
  onOpen: (relPath: string) => void;
  onClose: () => void;
}

export default function QuickOpen({ workspacePath, onOpen, onClose }: Props) {
  const [files, setFiles] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const sessionIdRef = useRef<string | null>(null);
  const bufferRef = useRef("");

  useEffect(() => {
    if (!isDesktopIDE() || !workspacePath) {
      setLoading(false);
      return;
    }
    setFiles([]);
    setLoading(true);
    bufferRef.current = "";
    let cancelled = false;
    (async () => {
      const rgPath = await window.scelo!.tools.ripgrepPath();
      const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const cmd = `${rgPath.path ? sq(rgPath.path) : "rg"} --files --hidden --glob '!node_modules' --glob '!__pycache__' --glob '!.git' ${sq(workspacePath)}`;
      const res = await window.scelo!.exec.start({
        runtime: "shell",
        command: cmd,
        cwd: workspacePath,
      });
      if ("error" in res || cancelled) {
        if (!cancelled) setLoading(false);
        return;
      }
      sessionIdRef.current = res.sessionId;
      const trim = workspacePath.endsWith("/") ? workspacePath : workspacePath + "/";
      const acc: string[] = [];
      const offChunk = window.scelo!.exec.onChunk((chunk) => {
        if (chunk.sessionId !== res.sessionId) return;
        bufferRef.current += chunk.data;
        const lines = bufferRef.current.split("\n");
        bufferRef.current = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          acc.push(line.startsWith(trim) ? line.slice(trim.length) : line);
        }
      });
      const offEnd = window.scelo!.exec.onEnd((end) => {
        if (end.sessionId !== res.sessionId) return;
        offChunk();
        offEnd();
        sessionIdRef.current = null;
        if (!cancelled) {
          setFiles(acc);
          setLoading(false);
        }
      });
    })();

    return () => {
      cancelled = true;
      if (sessionIdRef.current && isDesktopIDE()) {
        window.scelo!.exec.cancel(sessionIdRef.current);
      }
    };
  }, [workspacePath]);

  const narrowed = useMemo(() => {
    if (!query.trim()) return files;
    return files
      .map((f) => ({ path: f, score: fuzzyScore(query, f) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.path);
  }, [files, query]);

  return (
    <Palette<string>
      items={narrowed}
      getKey={(p) => p}
      renderItem={(p) => (
        <div className="font-mono">
          <div className="truncate text-fg">{basename(p)}</div>
          <div className="truncate text-[10px] text-fg-mute opacity-70">{dirname(p)}</div>
        </div>
      )}
      onSelect={(p) => onOpen(p)}
      onClose={onClose}
      placeholder={loading ? "Indexing workspace…" : "Type to fuzzy-find a file"}
      ariaLabel="Quick open file"
      onQueryChange={setQuery}
      summary={
        <>
          {narrowed.length} result{narrowed.length === 1 ? "" : "s"}
          {!loading && files.length > 0 && (
            <span className="ml-2 opacity-70">of {files.length} files</span>
          )}
        </>
      }
    />
  );
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

/** Path-aware fuzzy score: per-char base 1, +2 at word boundaries
 *  (`/`, `_`, `-`, `.`, ` `), +3 in the basename (after the last `/`),
 *  +5 contiguous-with-previous. Returns 0 on incomplete matches. */
function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const baseStart = Math.max(t.lastIndexOf("/") + 1, 0);
  let qi = 0;
  let score = 0;
  let prev = -2;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] !== q[qi]) continue;
    let s = 1;
    const isBoundary = i === 0 || /[\/_\-. ]/.test(t[i - 1]);
    if (isBoundary) s += 2;
    if (i >= baseStart) s += 3;
    if (i === prev + 1) s += 5;
    score += s;
    prev = i;
    qi++;
  }
  return qi === q.length ? score : 0;
}
