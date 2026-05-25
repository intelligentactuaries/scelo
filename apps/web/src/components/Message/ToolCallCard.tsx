// Expandable card per tool call. Closed by default once the tool returns;
// expanded shows the raw input/output in a JSON code block.

import { useState } from "react";

type Props = {
  tool: string;
  // `args` is the input from the tool_call event.
  args?: Record<string, unknown>;
  // `output` is undefined while running, present once tool_result arrives.
  output?: unknown;
  durationMs?: number;
  errored?: boolean;
};

export function ToolCallCard({ tool, args, output, durationMs, errored = false }: Props) {
  const [open, setOpen] = useState(false);
  const finished = output !== undefined || errored;
  const status = errored ? "✕" : finished ? "✓" : "…";
  const statusColor = errored
    ? "text-error"
    : finished
      ? "text-primary"
      : "text-fg-mute animate-pulse";
  return (
    <details
      className="border-l-2 border-border bg-bg-1/40 px-2 py-1 text-xs"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer select-none items-center gap-2 font-mono">
        <span className={statusColor}>{status}</span>
        <span className="text-fg">{tool}</span>
        {typeof durationMs === "number" && <span className="text-fg-dim">· {durationMs}ms</span>}
        <span className="ml-auto text-fg-dim">{open ? "hide" : "details"}</span>
      </summary>
      <div className="mt-2 space-y-2">
        {args && Object.keys(args).length > 0 && (
          <div>
            <div className="font-mono text-[10px] uppercase text-fg-dim">input</div>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all bg-bg p-2 font-mono text-[11px] text-fg-mute">
              {JSON.stringify(args, null, 2)}
            </pre>
          </div>
        )}
        {finished && (
          <div>
            <div className="font-mono text-[10px] uppercase text-fg-dim">output</div>
            <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-all bg-bg p-2 font-mono text-[11px] text-fg-mute">
              {typeof output === "string" ? output : JSON.stringify(output, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}
