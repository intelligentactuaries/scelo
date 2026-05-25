// Minimal RFC-4180 CSV/TSV parser. Handles:
//   * Quoted fields ("Hello, world")
//   * Escaped quotes inside quoted fields ("She said ""hi""")
//   * Embedded newlines inside quoted fields
//   * Mixed line endings (\n, \r\n)
//
// What it does NOT do:
//   * Streaming  (returns rows[][] in memory)
//   * Type inference  (every field is a string)
//   * Header detection  (callers pass `hasHeader` if they need it)
//
// `maxRows` caps how many records the parser emits so the table view
// can load a 5 GB CSV without exploding the renderer.

export interface CsvParseOptions {
  delimiter?: string;
  maxRows?: number;
}

export interface CsvParseResult {
  rows: string[][];
  truncated: boolean;
  /** True when at least one field used quoting; helps callers decide
   *  whether the file is "really" CSV or just plain lines. */
  hadQuotes: boolean;
}

export function parseCsv(text: string, opts: CsvParseOptions = {}): CsvParseResult {
  const delim = opts.delimiter ?? ",";
  const maxRows = opts.maxRows ?? 500;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let hadQuotes = false;
  let truncated = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      hadQuotes = true;
      continue;
    }
    if (c === delim) {
      pushField();
      continue;
    }
    if (c === "\r") {
      if (text[i + 1] === "\n") i++;
      pushField();
      pushRow();
      continue;
    }
    if (c === "\n") {
      pushField();
      pushRow();
      continue;
    }
    field += c;
  }
  // Trailing field / row — only emit when something is in flight; an
  // empty trailing newline shouldn't produce a phantom row.
  if (field.length > 0 || row.length > 0) {
    pushField();
    pushRow();
  }

  return { rows, truncated, hadQuotes };
}

/** Whether the file extension suggests tab- or comma-separated values. */
export function delimiterFor(path: string): "," | "\t" {
  return path.toLowerCase().endsWith(".tsv") ? "\t" : ",";
}
