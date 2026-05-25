// Problems panel — roll-up of every diagnostic the LSP has published
// across the workspace so far, grouped by file. Click a row to open
// that file at the offending line.
//
// Source of truth is `diagnosticsBus`; EditorPanel mirrors every
// `textDocument/publishDiagnostics` notification onto it. This panel
// is a pure subscriber.

import { useEffect, useMemo, useState } from "react";
import {
  getAllDiagnostics,
  subscribeDiagnostics,
  type Diagnostic,
} from "../../lib/diagnosticsBus";

interface Props {
  onOpenAtLine: (path: string, line: number) => void;
}

export default function ProblemsPanel({ onOpenAtLine }: Props) {
  const [snapshot, setSnapshot] = useState<Map<string, Diagnostic[]>>(
    () => new Map(getAllDiagnostics()),
  );
  useEffect(
    () => subscribeDiagnostics((s) => setSnapshot(new Map(s))),
    [],
  );

  const grouped = useMemo(() => {
    const out: Array<{ path: string; diags: Diagnostic[] }> = [];
    for (const [path, diags] of snapshot) {
      if (diags.length === 0) continue;
      out.push({ path, diags });
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }, [snapshot]);

  const totals = useMemo(() => {
    let err = 0;
    let warn = 0;
    let info = 0;
    for (const { diags } of grouped) {
      for (const d of diags) {
        if (d.severity === "error") err++;
        else if (d.severity === "warning") warn++;
        else info++;
      }
    }
    return { err, warn, info };
  }, [grouped]);

  return (
    <div className="flex h-full flex-col bg-bg-2 text-fg">
      <div className="flex items-baseline justify-between border-b border-border px-3 py-1">
        <span className="text-[10px] uppercase tracking-wider text-fg-mute">
          problems
        </span>
        <span className="text-[10px] text-fg-mute">
          {totals.err > 0 && <span className="text-error">●{totals.err} </span>}
          {totals.warn > 0 && <span className="text-warn">●{totals.warn} </span>}
          {totals.info > 0 && <span>●{totals.info}</span>}
          {totals.err + totals.warn + totals.info === 0 && <span>0</span>}
        </span>
      </div>
      <div className="flex-1 overflow-auto px-3 py-2 text-xs">
        {grouped.length === 0 ? (
          <p className="text-[11px] text-fg-mute">
            No problems reported. Open a Python or R file to invoke the
            language server.
          </p>
        ) : (
          grouped.map(({ path, diags }) => (
            <div key={path} className="mb-3">
              <div
                className="font-mono text-[11px] text-fg-mute"
                title={path}
              >
                {path}
                <span className="ml-2 text-[10px] text-fg-mute">
                  ({diags.length})
                </span>
              </div>
              <ul className="m-0 mt-1 list-none p-0">
                {diags.map((d, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      onClick={() => onOpenAtLine(path, d.line + 1)}
                      className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-bg"
                    >
                      <SeverityDot severity={d.severity} />
                      <span className="font-mono text-[10px] text-fg-mute">
                        {d.line + 1}:{d.character + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-fg">
                        {d.message}
                      </span>
                      <span className="font-mono text-[10px] text-fg-mute">
                        {d.source}
                        {d.code ? `(${d.code})` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function SeverityDot({ severity }: { severity: Diagnostic["severity"] }) {
  const color =
    severity === "error"
      ? "bg-error"
      : severity === "warning"
        ? "bg-warn"
        : "bg-fg-dim";
  return (
    <span
      aria-hidden="true"
      className={`mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${color}`}
    />
  );
}
