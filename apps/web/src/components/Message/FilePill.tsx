// Renders an attached file as a chip with the classifier's suggestion.
// Shown both in the pending-input state (before send) and inline beneath
// the user message after send.

import type { AttachedFile } from "@/lib/conversations";

type Props = {
  file: AttachedFile;
  onRemove?: () => void;
};

const SPECIALIST_COLOR: Record<string, string> = {
  reserving: "border-primary text-primary",
  mortality: "border-primary text-primary",
  pensions: "border-primary text-primary",
  pricing: "border-primary text-primary",
  climate: "border-primary text-primary",
  capital: "border-primary text-primary",
  regulatory: "border-warn text-warn",
  documentation: "border-fg-mute text-fg-mute",
  unknown: "border-fg-dim text-fg-dim",
};

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilePill({ file, onRemove }: Props) {
  const c = file.classification;
  const cls = SPECIALIST_COLOR[c.specialist] ?? SPECIALIST_COLOR.unknown;
  return (
    <div className="flex items-center gap-2 border border-border bg-bg-1 px-2 py-1 font-mono text-xs">
      <span className="text-fg" title={file.saved_path}>
        ⎙ {file.filename}
      </span>
      <span className="text-fg-dim">· {bytes(file.bytes)}</span>
      <span className={`border px-1 ${cls}`}>
        → {c.specialist}.{c.suggested_capability}
        <span className="ml-1 text-fg-dim">{Math.round(c.confidence * 100)}%</span>
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove attachment"
          className="ml-1 text-fg-dim hover:text-error"
        >
          ×
        </button>
      )}
    </div>
  );
}
