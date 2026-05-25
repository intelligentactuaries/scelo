// HTML table styled per the IA palette. Supports an optional totals row
// rendered with terminal-green emphasis.

type Cell = string | number | null | undefined;

type Props = {
  caption?: string;
  columns: string[];
  // Numeric or string rows. Cells are rendered with `Intl.NumberFormat`
  // when their column is numeric.
  rows: Cell[][];
  // Optional final row, rendered as <tfoot> with bold + terminal-green totals.
  totalsRow?: Cell[];
  // Per-column hint: "number" applies tabular-num formatting + right-align.
  columnTypes?: Array<"text" | "number">;
};

function fmt(cell: Cell, type: "text" | "number"): string {
  if (cell === null || cell === undefined) return "—";
  if (type === "number" && typeof cell === "number" && Number.isFinite(cell)) {
    return cell.toLocaleString(undefined, {
      maximumFractionDigits: Math.abs(cell) >= 100 ? 0 : 2,
    });
  }
  return String(cell);
}

export function TableBlock({ caption, columns, rows, totalsRow, columnTypes }: Props) {
  const types = columns.map((_, i) => columnTypes?.[i] ?? "text");
  return (
    <div className="overflow-x-auto border border-border bg-bg-1">
      {caption && (
        <div className="border-border border-b px-3 py-1 font-mono text-fg-dim text-[11px] uppercase">
          {caption}
        </div>
      )}
      <table
        className="w-full border-collapse text-sm"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        <thead className="bg-bg-2">
          <tr>
            {columns.map((c, i) => (
              <th
                key={c}
                className="border-border border-b px-3 py-2 text-left font-mono text-fg-mute text-[11px] uppercase tracking-wider"
                style={{ textAlign: types[i] === "number" ? "right" : "left" }}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rIdx) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows arrive in fixed order
            <tr key={rIdx} className={rIdx % 2 === 1 ? "bg-bg/40" : ""}>
              {row.map((cell, cIdx) => (
                <td
                  // biome-ignore lint/suspicious/noArrayIndexKey: stable column order
                  key={cIdx}
                  className="border-border/60 border-b px-3 py-1.5 text-fg"
                  style={{ textAlign: types[cIdx] === "number" ? "right" : "left" }}
                >
                  {fmt(cell, types[cIdx])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {totalsRow && (
          <tfoot>
            <tr className="border-border border-t bg-bg-2">
              {totalsRow.map((cell, cIdx) => (
                <td
                  // biome-ignore lint/suspicious/noArrayIndexKey: stable column order
                  key={cIdx}
                  className="px-3 py-2 font-semibold text-primary"
                  style={{ textAlign: types[cIdx] === "number" ? "right" : "left" }}
                >
                  {fmt(cell, types[cIdx])}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
