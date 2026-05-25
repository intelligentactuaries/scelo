// Tabular preview for .csv / .tsv files. Renders the first N rows of
// the buffer (the source of truth, so an unsaved edit in source mode
// is reflected when the user toggles back). No sorting, no filtering,
// no column hiding : a deliberately read-only first pass.

import { useMemo } from "react";
import { delimiterFor, parseCsv } from "../../../lib/csvParse";

interface Props {
  path: string;
  buffer: string;
  /** Cap how many rows we render. The parser also caps internally,
   *  but we expose this so the EditorPanel can pass a saner default
   *  when memory is tight. */
  maxRows?: number;
}

const MAX_COL_CHARS = 80;

export default function CsvTable({ path, buffer, maxRows = 500 }: Props) {
  const parsed = useMemo(
    () => parseCsv(buffer, { delimiter: delimiterFor(path), maxRows }),
    [buffer, maxRows, path],
  );

  if (parsed.rows.length === 0) {
    return (
      <div className="p-4 text-xs text-fg-mute">
        Empty file (or no rows parsed).
      </div>
    );
  }

  const [header, ...rest] = parsed.rows;
  const colCount = Math.max(header.length, ...rest.map((r) => r.length));

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-baseline justify-between border-b border-border bg-bg-2 px-3 py-1 text-[10px] text-fg-mute">
        <span>
          {rest.length} row{rest.length === 1 ? "" : "s"} · {colCount} cols
        </span>
        {parsed.truncated && (
          <span title={`First ${maxRows} rows shown; switch to source view for the full file.`}>
            preview truncated at {maxRows} rows
          </span>
        )}
      </div>
      <div className="flex-1 overflow-auto">
        <table className="min-w-full border-collapse font-mono text-[11px]">
          <thead className="sticky top-0 bg-bg-2">
            <tr>
              <th
                scope="col"
                className="border-b border-border px-2 py-1 text-left text-fg-mute"
              >
                #
              </th>
              {padTo(header, colCount).map((h, i) => (
                <th
                  key={i}
                  scope="col"
                  className="border-b border-border px-2 py-1 text-left text-fg"
                >
                  {truncate(h)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rest.map((row, r) => (
              <tr key={r} className="hover:bg-bg-2">
                <td className="border-b border-border/50 px-2 py-0.5 text-right text-fg-mute">
                  {r + 1}
                </td>
                {padTo(row, colCount).map((cell, c) => (
                  <td
                    key={c}
                    className="border-b border-border/50 px-2 py-0.5 align-top text-fg"
                    title={cell.length > MAX_COL_CHARS ? cell : undefined}
                  >
                    {truncate(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function padTo(arr: string[], n: number): string[] {
  if (arr.length >= n) return arr;
  return [...arr, ...new Array(n - arr.length).fill("")];
}

function truncate(s: string): string {
  if (s.length <= MAX_COL_CHARS) return s;
  return `${s.slice(0, MAX_COL_CHARS - 1)}…`;
}
