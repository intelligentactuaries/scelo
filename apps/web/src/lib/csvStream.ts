// Streaming RFC-4180 CSV parser for large files.
//
// lib/csvParse.ts decodes the whole file into one string before parsing —
// fine for previews, fatal for a 300 MB upload (the decoded string plus the
// per-line splits plus 2M row objects blow straight past the renderer's
// ~4 GB heap). This parser reads the Blob through file.stream() chunk by
// chunk, so the full text never exists in memory at once:
//
//   * Quote/field state carries across chunk boundaries (including an
//     escaped quote or \r\n split exactly at a boundary).
//   * Retained rows are capped: beyond `maxRows` the parser switches to
//     uniform reservoir sampling, so any file size parses in bounded memory
//     and the retained rows stay statistically representative.
//   * The event loop gets a macrotask yield every few chunks, and
//     `onProgress` fires per chunk so callers can paint a real progress bar.
//
// Cells come back as raw strings — type coercion is the caller's business.

export interface CsvStreamOptions {
  delimiter?: string;
  /** Max data rows retained. Beyond this the parser reservoir-samples
   *  uniformly; `totalDataRows` still counts every row in the file. */
  maxRows?: number;
  onProgress?: (p: { bytesRead: number; totalBytes: number; rowsSeen: number }) => void;
  signal?: AbortSignal;
}

export interface CsvStreamResult {
  header: string[];
  /** Retained data rows, in original file order even when sampled. */
  rows: string[][];
  /** Data rows in the file (excludes header and blank lines). */
  totalDataRows: number;
  /** True when totalDataRows exceeded maxRows and rows is a uniform sample. */
  sampled: boolean;
  hadQuotes: boolean;
  /** Rows whose cell count disagreed with the header (padded/truncated). */
  malformedRows: number;
}

// Yield to the event loop every N chunks. Blob streams hand out chunks of
// ~64 KB–2 MB, so this keeps the main thread responsive without paying the
// ~4 ms setTimeout clamp on every single chunk.
const YIELD_EVERY_CHUNKS = 4;

export async function streamParseCsv(
  file: Blob,
  opts: CsvStreamOptions = {},
): Promise<CsvStreamResult> {
  return parseCsvChunks(blobChunks(file), file.size, opts);
}

async function* blobChunks(file: Blob): AsyncGenerator<Uint8Array> {
  const reader = (file.stream() as ReadableStream<Uint8Array>).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

// Duplicate header names get numeric suffixes (x, x_2, x_3) so row objects
// keyed by column name can't silently collapse columns; empty header cells
// become "column".
function dedupeHeader(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const base = raw.length > 0 ? raw : "column";
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}_${n + 1}`;
  });
}

/** Core state machine. Exposed separately from streamParseCsv so tests can
 *  feed hand-cut chunk boundaries (mid-quote, mid-\r\n, mid-codepoint). */
export async function parseCsvChunks(
  chunks: AsyncIterable<Uint8Array>,
  totalBytes: number,
  opts: CsvStreamOptions = {},
): Promise<CsvStreamResult> {
  const delim = opts.delimiter ?? ",";
  const maxRows = opts.maxRows ?? Number.POSITIVE_INFINITY;
  // TextDecoder with stream:true reassembles multi-byte sequences split
  // across chunks and strips a UTF-8 BOM.
  const decoder = new TextDecoder("utf-8");

  let header: string[] | null = null;
  const rows: string[][] = [];
  // Original data-row index of each retained row — reservoir replacement
  // shuffles positions, so order is restored from these at the end.
  const rowIndices: number[] = [];

  // Cell interning. Categorical CSVs repeat a small value set millions of
  // times; sharing one string per distinct value collapses that memory
  // (measured: 4.0 GB -> ~0.3 GB live heap on a 250k×25 retained set). As a
  // side effect, the Map hash lookup forces the lazily-concatenated field
  // strings to flatten, so even unique cells (ids, floats) stop carrying
  // rope overhead. The cap only bounds the pool — cells beyond it still
  // get the flattening benefit of the .get() call.
  const INTERN_CAP = 100_000;
  const intern = new Map<string, string>();
  const internCell = (s: string): string => {
    const hit = intern.get(s);
    if (hit !== undefined) return hit;
    if (intern.size < INTERN_CAP) intern.set(s, s);
    return s;
  };
  let totalDataRows = 0;
  let malformedRows = 0;
  let hadQuotes = false;

  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  // A '"' seen while inQuotes: either an escape ("" -> literal quote) or the
  // closing quote — undecidable until the NEXT character, which may live in
  // the next chunk. The flag carries that decision across the boundary.
  let pendingQuote = false;
  // A '\r' ends a record immediately; a following '\n' (possibly in the next
  // chunk) must then be swallowed rather than emitting a phantom blank row.
  let prevWasCR = false;

  const acceptRow = (r: string[]) => {
    // Skip blank lines (a lone newline parses as one empty cell) — matches
    // how the legacy whole-string parsers treated whitespace-only lines.
    if (r.length === 1 && r[0].trim() === "") return;
    if (header === null) {
      header = dedupeHeader(r.map((h) => h.trim()));
      return;
    }
    let cells = r;
    if (cells.length !== header.length) {
      malformedRows++;
      cells =
        cells.length > header.length
          ? cells.slice(0, header.length)
          : [...cells, ...new Array<string>(header.length - cells.length).fill("")];
    }
    const n = totalDataRows++;
    if (rows.length < maxRows) {
      rows.push(cells);
      rowIndices.push(n);
    } else {
      // Reservoir sampling: row n replaces a random slot with probability
      // maxRows/(n+1), keeping the retained set uniform over all rows seen.
      const j = Math.floor(Math.random() * (n + 1));
      if (j < maxRows) {
        rows[j] = cells;
        rowIndices[j] = n;
      }
    }
  };

  const endField = () => {
    row.push(internCell(field));
    field = "";
  };
  const endRecord = () => {
    endField();
    acceptRow(row);
    row = [];
  };

  const feed = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (pendingQuote) {
        pendingQuote = false;
        if (c === '"') {
          field += '"';
          continue;
        }
        inQuotes = false; // that quote closed the field; c falls through
      }
      if (prevWasCR) {
        prevWasCR = false;
        if (c === "\n") continue; // second half of \r\n; record already ended
      }
      if (inQuotes) {
        if (c === '"') pendingQuote = true;
        else field += c;
        continue;
      }
      if (c === '"') {
        inQuotes = true;
        hadQuotes = true;
        continue;
      }
      if (c === delim) {
        endField();
        continue;
      }
      if (c === "\n") {
        endRecord();
        continue;
      }
      if (c === "\r") {
        endRecord();
        prevWasCR = true;
        continue;
      }
      field += c;
    }
  };

  let bytesRead = 0;
  let chunkCount = 0;
  for await (const chunk of chunks) {
    if (opts.signal?.aborted) throw new Error("aborted");
    bytesRead += chunk.byteLength;
    feed(decoder.decode(chunk, { stream: true }));
    chunkCount++;
    opts.onProgress?.({ bytesRead, totalBytes, rowsSeen: totalDataRows });
    if (chunkCount % YIELD_EVERY_CHUNKS === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  feed(decoder.decode()); // flush any buffered multi-byte tail
  if (pendingQuote) {
    // EOF right after a quote while quoted: it was the closing quote.
    pendingQuote = false;
    inQuotes = false;
  }
  if (field.length > 0 || row.length > 0) endRecord();
  opts.onProgress?.({ bytesRead, totalBytes, rowsSeen: totalDataRows });

  const sampled = totalDataRows > rows.length;
  let finalRows = rows;
  if (sampled) {
    const order = rowIndices.map((_, k) => k).sort((a, b) => rowIndices[a] - rowIndices[b]);
    finalRows = order.map((k) => rows[k]);
  }

  return {
    header: header ?? [],
    rows: finalRows,
    totalDataRows,
    sampled,
    hadQuotes,
    malformedRows,
  };
}
