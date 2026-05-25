// Export helpers for /scelo/soft.
//
// CSV and JSON for now — both are dependency-free and round-trip back
// through the existing CSV importer. Parquet write would need a JS
// writer (none in the bundle today) and is the obvious follow-up.

import type { CellValue, Dataset, Row } from "./SoftDataWorkstation";

// RFC 4180 escape: wrap in quotes when the value contains a comma,
// quote, newline, or carriage return; double any embedded quotes.
function escapeCsv(v: CellValue): string {
  if (v === null) return "";
  const s = typeof v === "number" ? String(v) : v;
  if (/["\n\r,]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(columns: string[], rows: Row[]): string {
  const lines: string[] = [];
  lines.push(columns.map((c) => escapeCsv(c)).join(","));
  for (const r of rows) {
    lines.push(columns.map((c) => escapeCsv(r[c])).join(","));
  }
  return lines.join("\n");
}

function rowsToJson(columns: string[], rows: Row[]): string {
  // Re-pluck columns in declared order — JSON.stringify on `rows` directly
  // would emit whatever order `Object.keys` happens to give us, which
  // can drift after derived-column additions.
  const ordered = rows.map((r) => {
    const out: Row = {};
    for (const c of columns) out[c] = r[c];
    return out;
  });
  return JSON.stringify(ordered, null, 2);
}

function downloadBlob(filename: string, content: string, mime: string): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  // Append → click → remove keeps Firefox happy.
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Strip the source-file extension from the dataset name (if any) so the
// downloaded filename gets the new extension cleanly. "claims.csv" → "claims".
function stripExt(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return name;
  return name.slice(0, dot);
}

export function exportCsv(dataset: Dataset): void {
  const csv = rowsToCsv(dataset.columns, dataset.rows);
  downloadBlob(`${stripExt(dataset.name)}.csv`, csv, "text/csv;charset=utf-8");
}

export function exportJson(dataset: Dataset): void {
  const json = rowsToJson(dataset.columns, dataset.rows);
  downloadBlob(`${stripExt(dataset.name)}.json`, json, "application/json;charset=utf-8");
}

// Convenience: a single entry point keyed by format string. Lets the menu
// be data-driven and the call site stay one-liner.
export type ExportFormat = "csv" | "json";
export function exportDataset(dataset: Dataset, format: ExportFormat): void {
  switch (format) {
    case "csv":
      exportCsv(dataset);
      return;
    case "json":
      exportJson(dataset);
      return;
  }
}
