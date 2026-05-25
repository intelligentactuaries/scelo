// Cmd/Ctrl-Shift-P IDE command palette.
//
// Owns the command list + the fuzzy filter; defers to the shared
// `<Palette>` for the modal shell, keyboard navigation, render loop.
// Commands are simple { id, label, detail?, run } objects assembled by
// useWorkspaceShell.

import { useMemo, useState } from "react";
import Palette from "./Palette";

export interface PaletteCommand {
  id: string;
  label: string;
  detail?: string;
  run: () => void | Promise<void>;
}

interface Props {
  commands: PaletteCommand[];
  onClose: () => void;
}

export default function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState("");
  const narrowed = useMemo(() => {
    if (!query.trim()) return commands;
    return commands
      .map((c) => ({ c, score: fuzzyScore(query, c.label) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.c);
  }, [query, commands]);
  return (
    <Palette<PaletteCommand>
      items={narrowed}
      getKey={(c) => c.id}
      renderItem={(c) => (
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-fg">{c.label}</span>
          {c.detail && (
            <span className="ml-auto truncate font-mono text-[10px] text-fg-mute opacity-70">
              {c.detail}
            </span>
          )}
        </div>
      )}
      onSelect={(c) => c.run()}
      onClose={onClose}
      placeholder="Type a command…"
      ariaLabel="Command palette"
      onQueryChange={setQuery}
      summary={`${narrowed.length} command${narrowed.length === 1 ? "" : "s"}`}
    />
  );
}

/** Boundary-aware contiguous-match fuzzy score. Boundaries are
 *  whitespace, `:`, `_`, `-`, `.`. Returns 0 on incomplete matches. */
function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let prev = -2;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] !== q[qi]) continue;
    let s = 1;
    if (i === 0 || /[\s:_\-.]/.test(t[i - 1])) s += 2;
    if (i === prev + 1) s += 5;
    score += s;
    prev = i;
    qi++;
  }
  return qi === q.length ? score : 0;
}
