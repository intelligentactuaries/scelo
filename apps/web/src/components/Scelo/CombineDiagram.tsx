// Minimal combine preview: ONE stacked bar showing the composition of the
// result, a caption naming its parts, and a one-line summary. Exact counts
// come from previewCombine (chained through prior steps by the caller).
//
//   append     [ current █████████ | file ████████ ]  = rows × cols
//   join-left  [ matched █ | no match ░░░░░░░░░░░░ ]  = rows × cols (+new)
//   join-inner [ kept █ | dropped ▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨ ]  = rows × cols (+new)

import type { CombinePreview } from "./combineData";

const fmt = (n: number) => n.toLocaleString();
const trunc = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, Math.ceil(n * 0.6))}…${s.slice(-Math.floor(n * 0.3))}` : s;

interface Seg {
  rows: number;
  className: string;
  striped?: boolean;
  title: string;
}

function Bar({ segments, total }: { segments: Seg[]; total: number }) {
  return (
    <div className="flex h-3 w-full items-stretch gap-px">
      {segments
        .filter((s) => s.rows > 0)
        .map((s) => (
          <div
            key={s.title}
            title={s.title}
            className={`rounded-[2px] ${s.className}`}
            style={{
              width: `${Math.max(0.6, (s.rows / Math.max(1, total)) * 100)}%`,
              ...(s.striped
                ? {
                    backgroundImage:
                      "repeating-linear-gradient(135deg, transparent 0 3px, rgb(var(--rgb-bg) / 0.6) 3px 5px)",
                  }
                : {}),
            }}
          />
        ))}
    </div>
  );
}

function Dot({ className }: { className: string }) {
  return <i className={`inline-block h-2 w-2 shrink-0 rounded-[2px] ${className}`} />;
}

export function CombineDiagram({
  preview,
  baseName,
  otherName,
}: {
  preview: CombinePreview;
  /** File name for the first staged file; "result of step N" after. */
  baseName: string;
  otherName: string;
}) {
  const j = preview.join;
  const a = preview.append;

  const colsNote =
    preview.newColumns.length > 0
      ? ` (+${preview.newColumns.length} col${preview.newColumns.length === 1 ? "" : "s"}: ${
          preview.newColumns.length > 3
            ? `${preview.newColumns.slice(0, 3).join(", ")} +${preview.newColumns.length - 3}`
            : preview.newColumns.join(", ")
        })`
      : "";

  if (a) {
    return (
      <div className="mt-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[9px]">
          <span className="inline-flex min-w-0 items-center gap-1 text-accent-2">
            <Dot className="bg-accent-2/70" />
            <span className="truncate" title={baseName}>
              {trunc(baseName, 30)}
            </span>
            <span className="text-fg-dim">{fmt(preview.baseRows)}</span>
          </span>
          <span className="inline-flex min-w-0 items-center gap-1 text-accent-3">
            <Dot className="bg-accent-3/70" />
            <span className="truncate" title={otherName}>
              + {trunc(otherName, 30)}
            </span>
            <span className="text-fg-dim">
              {fmt(a.appended)}
              {a.duplicatesDropped > 0 ? ` (−${fmt(a.duplicatesDropped)} dupes)` : ""}
            </span>
          </span>
        </div>
        <div className="mt-1">
          <Bar
            total={preview.resultRows}
            segments={[
              {
                rows: preview.baseRows,
                className: "bg-accent-2/70",
                title: `${fmt(preview.baseRows)} rows from ${baseName}`,
              },
              {
                rows: a.appended,
                className: "bg-accent-3/70",
                title: `${fmt(a.appended)} rows appended from ${otherName}`,
              },
            ]}
          />
        </div>
        <div className="mt-1 font-mono text-[9px] text-fg-mute">
          = <span className="text-fg">{fmt(preview.resultRows)} rows</span> ×{" "}
          {preview.resultColumns} cols{colsNote}
          {a.duplicatesDropped > 0 && ` · ${fmt(a.duplicatesDropped)} exact duplicates dropped`}
        </div>
      </div>
    );
  }

  if (!j) return null;
  const inner = preview.strategy === "join-inner";
  const unmatched = j.baseOnly + j.baseNullKey;

  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[9px]">
        <span className="inline-flex items-center gap-1 text-fg-mute">
          <Dot className="bg-accent-2/70" />
          <span className="text-fg">{fmt(j.matched)}</span> match {otherName} on{" "}
          <span className="text-fg">{j.key}</span> → get its columns
        </span>
        <span className={`inline-flex items-center gap-1 ${inner ? "text-error" : "text-fg-mute"}`}>
          <Dot className={inner ? "bg-error/40" : "bg-accent-2/25"} />
          <span className={inner ? "" : "text-fg"}>{fmt(unmatched)}</span> no match —{" "}
          {inner ? "dropped" : "kept, nulls"}
        </span>
      </div>
      <div className="mt-1">
        <Bar
          total={preview.baseRows}
          segments={[
            {
              rows: j.matched,
              className: "bg-accent-2/70",
              title: `${fmt(j.matched)} rows match on ${j.key} and receive ${otherName}'s columns`,
            },
            {
              rows: unmatched,
              className: inner ? "bg-error/30" : "bg-accent-2/25",
              striped: inner,
              title: inner
                ? `${fmt(unmatched)} rows have no match — inner join drops them`
                : `${fmt(unmatched)} rows have no match — kept, new columns null`,
            },
          ]}
        />
      </div>
      <div className="mt-1 font-mono text-[9px] text-fg-mute">
        = <span className="text-fg">{fmt(preview.resultRows)} rows</span> × {preview.resultColumns}{" "}
        cols{colsNote}
        {j.otherOnlyKeys > 0 && ` · ${fmt(j.otherOnlyKeys)} file-only keys ignored`}
        {j.duplicateRightKeys > 0 && (
          <span className="text-warn">
            {" "}
            · {fmt(j.duplicateRightKeys)} duplicate file keys (first wins)
          </span>
        )}
      </div>
    </div>
  );
}
