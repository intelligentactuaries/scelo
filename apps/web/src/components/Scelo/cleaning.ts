// Dataset cleaning — analyse + apply.
//
// Two phases, fully separate:
//   1. `analyseCleaning(dataset, metas)` scans the rows (with sampling for
//      very large datasets) and returns a plan: a list of suggested ops, each
//      annotated with the count of affected cells/rows and a `safe` flag.
//      For datasets above ~200k rows we sample a stride so the scan stays
//      sub-second; counts are scaled back up so the banner shows the
//      estimated full-data figure (prefixed with `~`).
//   2. `applyCleaning(dataset, plan, enabled)` runs the user-selected subset
//      of those ops over the full dataset, returning a new Dataset. The two
//      phases never mutate the input.
//
// Detection coverage is deliberately wide because real-world data is messy:
// thousand separators, accounting parens, percentages, trailing currency
// codes, NaN/#N/A/missing markers in many spellings, mixed-case yes/no
// booleans, mojibake from a UTF-8 → Latin-1 misdecode, sentinel numerics
// like -999/9999 leaking in from Fortran-era exports, free-text dates,
// internal whitespace runs, non-snake column headers, etc.
//
// The op set tracks the traditional column-by-column cleaning playbook:
// structural fixes, string normalisation, numeric coercion, datetime
// parsing, boolean canonicalisation, missing-marker handling, and
// row-level dedupe. Anything that LEARNS from the data (imputation
// values, outlier thresholds, category vocabularies) is deliberately
// left out of this layer: those decisions should be fit on the training
// split, not baked into intake.

import type { ColumnMeta, Dataset, Row } from "./SoftDataWorkstation";

// "Missing"-equivalent string tokens we want to normalise to null. Compared
// case-insensitively against the trimmed cell. Pulled from CSV/parquet
// dumps across pandas / Excel / SQL exports — covers the long tail beyond
// the bare "NA".
const MISSING_TOKENS = new Set<string>([
  // standard
  "na",
  "n/a",
  "n.a.",
  "n/a.",
  "nan",
  "null",
  "nil",
  "none",
  "missing",
  "unknown",
  "undefined",
  "void",
  "no data",
  "no value",
  "not available",
  "not applicable",
  // pandas-style
  "<na>",
  "#na",
  "#n/a",
  // excel error tokens
  "#null!",
  "#div/0!",
  "#value!",
  "#ref!",
  "#name?",
  "#num!",
  // dashes / placeholders
  "-",
  "--",
  "---",
  "—",
  "–",
  "?",
  "??",
  "*",
  "**",
  ".",
  "x",
  // workflow placeholders
  "tbd",
  "tbc",
  "pending",
  "blank",
  "empty",
]);

// Boolean-equivalent tokens — case-insensitive. Numeric "0"/"1" are
// excluded on purpose: too easy to wreck a real numeric column.
const TRUE_TOKENS = new Set<string>(["true", "yes", "y", "t", "on", "ok", "✓", "✔"]);
const FALSE_TOKENS = new Set<string>(["false", "no", "n", "f", "off", "✗", "✘", "x"]);

// Common Fortran / SAS / SPSS sentinel numerics that codified "missing"
// before NULL semantics were widely understood. We only flag values that
// appear ≥3 times AND sit far outside the column's IQR — the heuristic is
// deliberately conservative so a real -999.99 monetary value never gets
// silently nulled out.
const NUMERIC_SENTINELS = new Set<number>([
  -1, -9, -99, -999, -9999, -99999, -999999, -888, -8888, 9, 99, 999, 9999, 99999, 999999,
  // float-rounded
  -999.99, 9999.99, 999.99,
]);

// Mojibake patterns from UTF-8 bytes incorrectly decoded as Windows-1252 /
// Latin-1. Order matters: longer patterns first so we don't half-fix a
// three-byte sequence into a worse two-byte one. Sourced from the long
// tail of CSV imports we've seen in practice — accented Latin letters,
// curly quotes / dashes from Word, and the BOM / NBSP / zero-width
// joiners that survive most ETL passes.
const MOJIBAKE_PAIRS: Array<[string, string]> = [
  // curly quotes / ellipsis / bullet (Word imports — these survive most
  // ETL pipelines because Word stamps them in by default). Note: longer
  // prefixes must come first so the matcher doesn't half-fix `â€™` into
  // `â€` + `™`.
  ["â€™", "’"],
  ["â€˜", "‘"],
  ["â€œ", "“"],
  ["â€", "”"],
  ["â€¦", "…"],
  ["â€¢", "•"],
  // accented Latin letters (UTF-8 → Latin-1 misdecode)
  ["Ã©", "é"],
  ["Ã¨", "è"],
  ["Ãª", "ê"],
  ["Ã«", "ë"],
  ["Ã ", "à"],
  ["Ã¢", "â"],
  ["Ã®", "î"],
  ["Ã¯", "ï"],
  ["Ã´", "ô"],
  ["Ã¶", "ö"],
  ["Ã»", "û"],
  ["Ã¼", "ü"],
  ["Ã§", "ç"],
  ["Ã±", "ñ"],
  ["Ã¡", "á"],
  ["Ã­", "í"],
  ["Ã³", "ó"],
  ["Ãº", "ú"],
  ["Ã„", "Ä"],
  ["Ã–", "Ö"],
  ["Ãœ", "Ü"],
  ["ÃŸ", "ß"],
  ["Â£", "£"],
  ["Â©", "©"],
  ["Â®", "®"],
  ["Â°", "°"],
  // Â appearing before ASCII punctuation is almost always spurious.
  ["Â ", " "],
];

// Single regex that catches the cheap encoding hygiene issues: BOM,
// non-breaking space, zero-width joiners, soft hyphen. Stripping these is
// always safe text-wise but can change downstream string comparisons, so
// we surface it as a labelled op rather than doing it silently on import.
const ENCODING_NOISE_RE = /\uFEFF|\u00A0|\u200B|\u200C|\u200D|\u2060|\u00AD/;

// Date-shaped strings the parser will accept. The regex pre-filter keeps
// us from feeding garbage into `new Date()` (which is famously lax — it
// happily turns "5" into 2001-01-05 in some engines). Anything that
// matches must ALSO produce a real Date when parsed; ambiguous DD/MM vs
// MM/DD formats are noted in the chat prompt but not auto-disambiguated
// here (we'd rather the user pick a locale than guess wrong silently).
const DATE_PATTERNS: RegExp[] = [
  // ISO 8601 (the canonical target)
  /^\d{4}-\d{1,2}-\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/,
  // slashed dates: 2024/01/05, 05/01/2024, 5/1/24
  /^\d{4}\/\d{1,2}\/\d{1,2}$/,
  /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,
  // dashed dates non-ISO: 05-01-2024, 5-1-24
  /^\d{1,2}-\d{1,2}-\d{2,4}$/,
  // dotted: 05.01.2024
  /^\d{1,2}\.\d{1,2}\.\d{2,4}$/,
  // month-name forms: "Jan 5, 2024", "5 Jan 2024", "January 5 2024"
  /^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4}$/,
  /^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}$/,
];

function parseFlexibleDate(raw: string): Date | null {
  const s = raw.trim();
  if (s.length < 6 || s.length > 35) return null;
  let matched = false;
  for (const re of DATE_PATTERNS) {
    if (re.test(s)) {
      matched = true;
      break;
    }
  }
  if (!matched) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  // Sanity range — guards against `new Date("0001")` returning year 1
  // and similar engine quirks.
  const year = d.getUTCFullYear();
  if (year < 1700 || year > 2200) return null;
  return d;
}

// Convert a parsed Date to the canonical ISO string form. Date-only
// inputs stay date-only (YYYY-MM-DD) so we don't manufacture spurious
// midnight-UTC timestamps on what was originally calendar data.
function toCanonicalIsoDate(raw: string, d: Date): string {
  // If the source string carried no time component, emit date-only.
  if (!/[T ]\d/.test(raw)) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  return d.toISOString();
}

// Internal whitespace collapse — matches two or more whitespace chars in
// a row (incl. tabs / newlines that snuck through). Cheap pre-check
// before allocating a new string so the per-cell pass stays fast on
// already-clean cells.
const INTERNAL_WS_RE = /\s{2,}/;

// Apply every encoding repair in one pass: mojibake substring → fix,
// then strip the BOM / NBSP / zero-width / soft-hyphen invisibles. NBSP
// is replaced with a normal space rather than removed so word boundaries
// survive (the trim / collapse-ws ops then mop up).
export function fixEncoding(raw: string): string {
  let out = raw;
  for (const [bad, good] of MOJIBAKE_PAIRS) {
    if (out.includes(bad)) out = out.split(bad).join(good);
  }
  // NBSP → space; the rest of the noise → drop.
  out = out.replace(/\u00A0/g, " ").replace(/\uFEFF|\u200B|\u200C|\u200D|\u2060|\u00AD/g, "");
  return out;
}

// snake_case rewrite. Splits on space / hyphen / dot / camelCase boundary,
// folds runs of underscores. Returns null when the column is already
// snake_case so the analyser can skip it.
export function toSnakeCase(name: string): string | null {
  const cleaned = name
    .replace(/['"`]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s\-.\\/()[\]{}]+/g, "_")
    .replace(/__+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (cleaned === "" || cleaned === name) return null;
  return cleaned;
}

// Cell counts above this row count switch the analyser into sampled mode.
const SAMPLE_THRESHOLD = 200_000;
// Target sample size when sampling — gives ~100k rows analysed regardless
// of input size. Empirically fast enough (<1s) on the main thread.
const SAMPLE_TARGET = 100_000;

export type CleaningOpKey =
  | "trim"
  | "collapse-whitespace"
  | "fix-encoding"
  | "missing-tokens"
  | "parse-numeric"
  | "parse-dates"
  | "standardise-booleans"
  | "replace-numeric-sentinels"
  | "drop-duplicates"
  | "drop-empty-cols"
  | "drop-constant-cols"
  | "lowercase-categoricals"
  | "rename-snake-case";

export type CleaningOp =
  | { key: "trim"; cells: number; safe: true }
  | { key: "collapse-whitespace"; cells: number; safe: true }
  | { key: "fix-encoding"; cells: number; samples: string[]; safe: true }
  | { key: "missing-tokens"; cells: number; tokens: string[]; safe: true }
  | { key: "parse-numeric"; columns: string[]; cells: number; safe: true }
  | { key: "parse-dates"; columns: string[]; cells: number; safe: true }
  | {
      key: "standardise-booleans";
      columns: Array<{ name: string; trueLabel: string; falseLabel: string }>;
      cells: number;
      safe: true;
    }
  | {
      key: "replace-numeric-sentinels";
      columns: Array<{ name: string; value: number; count: number }>;
      cells: number;
      safe: true;
    }
  | { key: "drop-duplicates"; rows: number; safe: false }
  | { key: "drop-empty-cols"; columns: Array<{ name: string; missingPct: number }>; safe: false }
  | { key: "drop-constant-cols"; columns: Array<{ name: string; value: string }>; safe: false }
  | {
      key: "lowercase-categoricals";
      columns: Array<{ name: string; merges: number }>;
      safe: false;
    }
  | {
      key: "rename-snake-case";
      columns: Array<{ from: string; to: string }>;
      safe: false;
    };

export type CleaningPlan = {
  ops: CleaningOp[];
  rowCount: number;
  columnCount: number;
  sampled: boolean;
  sampleSize: number;
};

// Format helper — flips count to "~X (sampled)" when the analyser took a
// shortcut, so users know the figure is an estimate not an exact tally.
function formatCount(n: number, sampled: boolean): string {
  const v = Math.round(n).toLocaleString();
  return sampled ? `~${v}` : v;
}

export function describeOp(op: CleaningOp, sampled = false): { title: string; detail: string } {
  switch (op.key) {
    case "trim":
      return {
        title: "trim whitespace",
        detail: `${formatCount(op.cells, sampled)} cells have leading or trailing whitespace.`,
      };
    case "collapse-whitespace":
      return {
        title: "collapse internal whitespace",
        detail: `${formatCount(op.cells, sampled)} cells contain runs of double / tab / newline whitespace — fold each run to a single space so case and category labels deduplicate cleanly.`,
      };
    case "fix-encoding": {
      const sample = op.samples
        .slice(0, 4)
        .map((s) => `"${s}"`)
        .join(", ");
      const more = op.samples.length > 4 ? ` (+${op.samples.length - 4} more)` : "";
      return {
        title: "fix encoding artefacts",
        detail: `${formatCount(op.cells, sampled)} cells carry mojibake or stray BOM / non-breaking space / zero-width characters (e.g. ${sample}${more}) — repair the UTF-8 misdecode and strip the invisibles.`,
      };
    }
    case "missing-tokens": {
      const sample = op.tokens
        .slice(0, 5)
        .map((t) => `"${t}"`)
        .join(", ");
      const more = op.tokens.length > 5 ? ` (+${op.tokens.length - 5} more)` : "";
      return {
        title: "normalise missing markers",
        detail: `${formatCount(op.cells, sampled)} cells use ${sample}${more} — convert to null so they count as missing in stats.`,
      };
    }
    case "parse-numeric":
      return {
        title: "parse numeric strings",
        detail: `${op.columns.length} column${op.columns.length === 1 ? "" : "s"} read as text but are ≥80% numeric — strip commas, currency, parens, % and coerce ${formatCount(op.cells, sampled)} cells.`,
      };
    case "parse-dates":
      return {
        title: "parse date strings",
        detail: `${op.columns.length} column${op.columns.length === 1 ? "" : "s"} read as text but are ≥80% date-shaped — canonicalise ${formatCount(op.cells, sampled)} cells to ISO 8601 (YYYY-MM-DD) so they sort, filter, and bin by quarter / year correctly.`,
      };
    case "replace-numeric-sentinels": {
      const sample = op.columns
        .slice(0, 3)
        .map((c) => `\`${c.name}\`=${c.value}`)
        .join(", ");
      const more = op.columns.length > 3 ? ` +${op.columns.length - 3} more` : "";
      return {
        title: "replace sentinel numerics",
        detail: `${op.columns.length} numeric column${op.columns.length === 1 ? "" : "s"} use repeated extreme codes (${sample}${more}) that look like legacy "missing" markers, not real measurements — null ${formatCount(op.cells, sampled)} cells so they stop dragging the mean.`,
      };
    }
    case "standardise-booleans": {
      const sample = op.columns
        .slice(0, 3)
        .map((c) => `\`${c.name}\` (${c.trueLabel}/${c.falseLabel})`)
        .join(", ");
      const more = op.columns.length > 3 ? ` +${op.columns.length - 3} more` : "";
      return {
        title: "standardise booleans",
        detail: `${op.columns.length} column${op.columns.length === 1 ? "" : "s"} use yes/no or true/false in mixed forms — normalise to "true"/"false": ${sample}${more}.`,
      };
    }
    case "drop-duplicates":
      return {
        title: "drop duplicate rows",
        detail: `${op.rows.toLocaleString()} exact-match duplicate row${op.rows === 1 ? "" : "s"} will be removed.`,
      };
    case "drop-empty-cols": {
      const sample = op.columns
        .slice(0, 3)
        .map((c) => `\`${c.name}\` (${c.missingPct.toFixed(0)}%)`)
        .join(", ");
      const more = op.columns.length > 3 ? ` +${op.columns.length - 3} more` : "";
      return {
        title: "drop near-empty columns",
        detail: `${op.columns.length} column${op.columns.length === 1 ? "" : "s"} are >95% missing — ${sample}${more}.`,
      };
    }
    case "drop-constant-cols": {
      const sample = op.columns
        .slice(0, 3)
        .map((c) => `\`${c.name}\`=${c.value}`)
        .join(", ");
      const more = op.columns.length > 3 ? ` +${op.columns.length - 3} more` : "";
      return {
        title: "drop constant columns",
        detail: `${op.columns.length} column${op.columns.length === 1 ? "" : "s"} carry a single value — ${sample}${more}.`,
      };
    }
    case "lowercase-categoricals": {
      const sample = op.columns
        .slice(0, 3)
        .map((c) => `\`${c.name}\``)
        .join(", ");
      const more = op.columns.length > 3 ? ` +${op.columns.length - 3} more` : "";
      return {
        title: "merge case-only duplicates",
        detail: `${op.columns.length} categorical column${op.columns.length === 1 ? "" : "s"} have buckets that differ only in case — lowercase to merge: ${sample}${more}.`,
      };
    }
    case "rename-snake-case": {
      const sample = op.columns
        .slice(0, 3)
        .map((c) => `\`${c.from}\` → \`${c.to}\``)
        .join(", ");
      const more = op.columns.length > 3 ? ` +${op.columns.length - 3} more` : "";
      return {
        title: "rename to snake_case",
        detail: `${op.columns.length} column${op.columns.length === 1 ? "" : "s"} contain spaces, dots, or mixed case — rename to snake_case for stable downstream references (${sample}${more}). Derived columns and filters reset on apply.`,
      };
    }
  }
}

// Permissive numeric parser. Handles common dirty-data dialects:
//   - leading/trailing whitespace + Unicode whitespace (NBSP, em-space)
//   - thousand separators (commas, underscores, spaces)
//   - leading/trailing currency symbols ($ £ € ¥ ₹) and 3-letter codes (USD…)
//   - accounting parens for negatives:  "(1,234)" → -1234
//   - trailing percent:                 "85%"     → 85
//   - Unicode minus / dash:             "−42"     → -42
// Returns null when nothing useful comes out — caller decides whether to keep
// the raw string or replace with null.
function parseFlexibleNumber(raw: string): number | null {
  let s = raw.trim();
  if (s === "") return null;

  // Normalise Unicode minus / dashes that look like '-' to ASCII.
  s = s.replace(/[‐-―−]/g, "-");

  // Accounting parens → negative.
  let negate = false;
  if (s.length >= 2 && s.startsWith("(") && s.endsWith(")")) {
    negate = true;
    s = s.slice(1, -1).trim();
  }

  // Trailing percent — keep the value as displayed (85 not 0.85).
  if (s.endsWith("%")) s = s.slice(0, -1).trim();

  // Strip currency symbols anywhere.
  s = s.replace(/[$£€¥₹]/g, "");
  // Strip a 3-letter currency code suffix (USD, EUR, GBP, ZAR, JPY, etc.).
  s = s.replace(/\s*[A-Za-z]{3,4}\s*$/, "");
  // Strip thousand separators / padding (commas, underscores, NBSP, ASCII ws).
  s = s.replace(/[,_\s ]/g, "");

  if (s === "" || s === "-" || s === "+") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negate ? -n : n;
}

// Cheap row-key for duplicate detection — far faster than JSON.stringify for
// wide rows and avoids the `123` vs `"123"` collision risk.
function rowKey(row: Row, columns: string[]): string {
  const parts: string[] = [];
  for (const c of columns) {
    const v = row[c];
    if (v === null) parts.push("∅");
    else if (typeof v === "number") parts.push(`n:${v}`);
    else parts.push(`s:${v}`);
  }
  return parts.join("");
}

export function analyseCleaning(dataset: Dataset, metas: ColumnMeta[]): CleaningPlan {
  const N = dataset.rows.length;
  const cols = dataset.columns;

  // Sampling decision — give a 100k-row budget regardless of input size so a
  // 5M-row dataset analyses in roughly the same wall-clock as a 200k one.
  const sampled = N > SAMPLE_THRESHOLD;
  const sampleStride = sampled ? Math.ceil(N / SAMPLE_TARGET) : 1;
  const sampleCount = sampled ? Math.ceil(N / sampleStride) : N;
  const scale = sampleStride;

  // Per-cell-pass accumulators.
  let trimCellsRaw = 0;
  let collapseWsCellsRaw = 0;
  let encodingCellsRaw = 0;
  let missingCellsRaw = 0;
  const foundTokens = new Set<string>();
  const encodingSamples = new Set<string>();
  // Per-column counters — built once because we touch each cell once.
  type ColAcc = {
    candidates: number; // non-null, non-missing-token cells (string only)
    numericFromString: number;
    dateFromString: number;
    trueCount: number;
    falseCount: number;
    booleanOther: number;
    firstTrueLabel: string | null;
    firstFalseLabel: string | null;
    // numeric-only: sentinel candidates (value → count). Populated when
    // the column meta says it's numeric so we can bypass the string fast
    // path. Kept on the ColAcc so the per-column rollup stays consistent.
    sentinelCounts: Map<number, number>;
  };
  const colAcc = new Map<string, ColAcc>();
  for (const c of cols) {
    colAcc.set(c, {
      candidates: 0,
      numericFromString: 0,
      dateFromString: 0,
      trueCount: 0,
      falseCount: 0,
      booleanOther: 0,
      firstTrueLabel: null,
      firstFalseLabel: null,
      sentinelCounts: new Map<number, number>(),
    });
  }

  // Single pass over (sampled) rows.
  for (let i = 0; i < N; i += sampleStride) {
    const row = dataset.rows[i];
    for (const c of cols) {
      const v = row[c];
      if (v === null) continue;
      const acc = colAcc.get(c);

      if (typeof v === "number") {
        // Sentinel-numeric candidate detection — only counts when the
        // exact value is in the known-sentinel set. Far-from-IQR + ≥3
        // occurrences guarding happens later, here we just tally.
        if (acc && NUMERIC_SENTINELS.has(v)) {
          acc.sentinelCounts.set(v, (acc.sentinelCounts.get(v) ?? 0) + 1);
        }
        continue;
      }
      if (typeof v !== "string") continue;

      if (v !== v.trim()) trimCellsRaw++;
      const trimmed = v.trim();
      if (trimmed === "") continue;

      // Encoding hygiene: mojibake + stray invisibles. Cheap regex pre-check
      // before the slower mojibake substring scan so already-clean cells
      // pay near-zero cost.
      let hasEncodingIssue = ENCODING_NOISE_RE.test(trimmed);
      if (!hasEncodingIssue) {
        for (const [bad] of MOJIBAKE_PAIRS) {
          if (trimmed.includes(bad)) {
            hasEncodingIssue = true;
            break;
          }
        }
      }
      if (hasEncodingIssue) {
        encodingCellsRaw++;
        if (encodingSamples.size < 8) encodingSamples.add(trimmed);
      }

      if (INTERNAL_WS_RE.test(trimmed)) collapseWsCellsRaw++;

      const lower = trimmed.toLowerCase();

      if (MISSING_TOKENS.has(lower)) {
        missingCellsRaw++;
        foundTokens.add(trimmed);
        continue;
      }

      if (!acc) continue;
      acc.candidates++;

      if (parseFlexibleNumber(trimmed) !== null) {
        acc.numericFromString++;
      }

      if (parseFlexibleDate(trimmed) !== null) {
        acc.dateFromString++;
      }

      if (TRUE_TOKENS.has(lower)) {
        acc.trueCount++;
        if (!acc.firstTrueLabel) acc.firstTrueLabel = trimmed;
      } else if (FALSE_TOKENS.has(lower)) {
        acc.falseCount++;
        if (!acc.firstFalseLabel) acc.firstFalseLabel = trimmed;
      } else {
        acc.booleanOther++;
      }
    }
  }

  const ops: CleaningOp[] = [];

  if (trimCellsRaw > 0) {
    ops.push({ key: "trim", cells: trimCellsRaw * scale, safe: true });
  }

  if (collapseWsCellsRaw > 0) {
    ops.push({ key: "collapse-whitespace", cells: collapseWsCellsRaw * scale, safe: true });
  }

  if (encodingCellsRaw > 0) {
    ops.push({
      key: "fix-encoding",
      cells: encodingCellsRaw * scale,
      samples: [...encodingSamples].slice(0, 8),
      safe: true,
    });
  }

  if (missingCellsRaw > 0) {
    ops.push({
      key: "missing-tokens",
      cells: missingCellsRaw * scale,
      tokens: [...foundTokens].sort().slice(0, 12),
      safe: true,
    });
  }

  // String columns that are ≥80% parseable as numbers (after stripping the
  // tokens we counted as missing above).
  const parseableCols: string[] = [];
  let parseCells = 0;
  for (const meta of metas) {
    if (meta.type !== "string") continue;
    const acc = colAcc.get(meta.name);
    if (!acc) continue;
    if (acc.candidates < 4) continue;
    if (acc.numericFromString / acc.candidates >= 0.8) {
      parseableCols.push(meta.name);
      parseCells += acc.numericFromString;
    }
  }
  if (parseableCols.length > 0) {
    ops.push({
      key: "parse-numeric",
      columns: parseableCols,
      cells: parseCells * scale,
      safe: true,
    });
  }

  // String columns that are ≥80% date-shaped. Numeric-first wins (a year
  // column like "2024" should be a number not a date) so we exclude any
  // column already claimed by parse-numeric.
  const dateCols: string[] = [];
  let dateCells = 0;
  for (const meta of metas) {
    if (meta.type !== "string") continue;
    if (parseableCols.includes(meta.name)) continue;
    const acc = colAcc.get(meta.name);
    if (!acc) continue;
    if (acc.candidates < 4) continue;
    if (acc.dateFromString / acc.candidates >= 0.8) {
      dateCols.push(meta.name);
      dateCells += acc.dateFromString;
    }
  }
  if (dateCols.length > 0) {
    ops.push({
      key: "parse-dates",
      columns: dateCols,
      cells: dateCells * scale,
      safe: true,
    });
  }

  // Columns whose non-missing string values are essentially {true-ish,
  // false-ish}. Both poles must appear, and "other" (non-bool, non-numeric)
  // tokens must be <5% noise.
  const boolCols: Array<{ name: string; trueLabel: string; falseLabel: string }> = [];
  let boolCells = 0;
  for (const meta of metas) {
    if (meta.type !== "string") continue;
    const acc = colAcc.get(meta.name);
    if (!acc) continue;
    if (acc.candidates < 4) continue;
    if (acc.trueCount === 0 || acc.falseCount === 0) continue;
    if (acc.booleanOther / acc.candidates > 0.05) continue;
    // Don't double-suggest if parse-numeric or parse-dates already claimed
    // this column.
    if (parseableCols.includes(meta.name)) continue;
    if (dateCols.includes(meta.name)) continue;
    boolCols.push({
      name: meta.name,
      trueLabel: acc.firstTrueLabel ?? "true",
      falseLabel: acc.firstFalseLabel ?? "false",
    });
    boolCells += acc.trueCount + acc.falseCount;
  }
  if (boolCols.length > 0) {
    ops.push({
      key: "standardise-booleans",
      columns: boolCols,
      cells: boolCells * scale,
      safe: true,
    });
  }

  // Sentinel numerics: -999 / 9999 / -1 etc that legacy systems used to
  // mean "missing". We only flag a value when (a) it appears at least 3
  // times in the sampled rows, AND (b) it sits more than 5×IQR outside
  // the column's interquartile range. That guards against a real -999.99
  // monetary entry being silently nulled.
  const sentinelCols: Array<{ name: string; value: number; count: number }> = [];
  let sentinelCellsRaw = 0;
  for (const meta of metas) {
    if (meta.type !== "number") continue;
    if (meta.q1 === undefined || meta.q3 === undefined) continue;
    const iqr = meta.q3 - meta.q1;
    if (!Number.isFinite(iqr) || iqr <= 0) continue;
    const loCut = meta.q1 - 5 * iqr;
    const hiCut = meta.q3 + 5 * iqr;
    const acc = colAcc.get(meta.name);
    if (!acc) continue;
    for (const [value, count] of acc.sentinelCounts) {
      if (count < 3) continue;
      if (value > loCut && value < hiCut) continue;
      sentinelCols.push({ name: meta.name, value, count });
      sentinelCellsRaw += count;
    }
  }
  if (sentinelCols.length > 0) {
    ops.push({
      key: "replace-numeric-sentinels",
      columns: sentinelCols,
      cells: sentinelCellsRaw * scale,
      safe: true,
    });
  }

  // Duplicate detection only on the sampled stride too — for 5M rows we
  // can't realistically hash every row in the analyser, but a stride-based
  // sample still surfaces a "your data has dupes" signal. Apply will do
  // the full-fidelity pass.
  const seen = new Set<string>();
  let dupes = 0;
  for (let i = 0; i < N; i += sampleStride) {
    const row = dataset.rows[i];
    const k = rowKey(row, cols);
    if (seen.has(k)) dupes++;
    else seen.add(k);
  }
  if (dupes > 0) {
    ops.push({ key: "drop-duplicates", rows: dupes * scale, safe: false });
  }

  // Column-level diagnostics come from metas — already O(cols), no
  // sampling needed.
  const emptyCols: Array<{ name: string; missingPct: number }> = [];
  for (const meta of metas) {
    if (meta.count === 0) continue;
    const pct = meta.missing / meta.count;
    if (pct > 0.95) emptyCols.push({ name: meta.name, missingPct: pct * 100 });
  }
  if (emptyCols.length > 0 && emptyCols.length < cols.length) {
    ops.push({ key: "drop-empty-cols", columns: emptyCols, safe: false });
  }

  const constantCols: Array<{ name: string; value: string }> = [];
  for (const meta of metas) {
    if (meta.unique !== 1) continue;
    if (meta.count - meta.missing === 0) continue;
    let constValue = "—";
    for (const row of dataset.rows) {
      const v = row[meta.name];
      if (v !== null) {
        constValue = String(v);
        break;
      }
    }
    constantCols.push({ name: meta.name, value: constValue });
  }
  if (constantCols.length > 0 && constantCols.length < cols.length) {
    ops.push({ key: "drop-constant-cols", columns: constantCols, safe: false });
  }

  const lcCols: Array<{ name: string; merges: number }> = [];
  for (const meta of metas) {
    if (meta.type !== "string") continue;
    if (!meta.topValues || meta.topValues.length < 2) continue;
    const lcCounts = new Map<string, number>();
    for (const v of meta.topValues) {
      const lc = v.value.toLowerCase();
      lcCounts.set(lc, (lcCounts.get(lc) ?? 0) + 1);
    }
    let merges = 0;
    for (const n of lcCounts.values()) if (n > 1) merges += n - 1;
    if (merges > 0) lcCols.push({ name: meta.name, merges });
  }
  if (lcCols.length > 0) {
    ops.push({ key: "lowercase-categoricals", columns: lcCols, safe: false });
  }

  // Header rename — columns that aren't snake_case. We only flag headers
  // that meaningfully differ (toSnakeCase returns null on a no-op rename)
  // and skip the whole op when two columns would collide on the target
  // name, since we can't tell which one to keep.
  const renames: Array<{ from: string; to: string }> = [];
  const renameTargets = new Set<string>();
  let collisions = false;
  for (const c of cols) {
    const target = toSnakeCase(c);
    if (target === null) continue;
    if (renameTargets.has(target) || cols.includes(target)) {
      collisions = true;
      break;
    }
    renameTargets.add(target);
    renames.push({ from: c, to: target });
  }
  if (renames.length > 0 && !collisions) {
    ops.push({ key: "rename-snake-case", columns: renames, safe: false });
  }

  return { ops, rowCount: N, columnCount: cols.length, sampled, sampleSize: sampleCount };
}

export function defaultEnabled(plan: CleaningPlan): Set<CleaningOpKey> {
  const enabled = new Set<CleaningOpKey>();
  for (const op of plan.ops) if (op.safe) enabled.add(op.key);
  return enabled;
}

// ─── Date display formats ────────────────────────────────────────────────
//
// The `parse-dates` op canonicalises to ISO 8601 because that's what sorts,
// filters, and bins correctly. But users frequently want the column *shown*
// in a locale form — most often American MM/DD/YYYY. These helpers let the
// chat ("make the dates american format") and any future banner control
// reformat a date column to a chosen style, parsing whatever shape the cells
// are currently in (ISO, slashed, dotted, month-name) first. Output is
// date-only — we don't manufacture clock components onto calendar data.

export type DateStyle = "iso" | "us" | "eu";

export const DATE_STYLE_LABEL: Record<DateStyle, string> = {
  iso: "ISO 8601 (YYYY-MM-DD)",
  us: "American (MM/DD/YYYY)",
  eu: "European (DD/MM/YYYY)",
};

// Calendar date as explicit components — parsed without leaning on the native
// `Date` parser, which can't read day-first forms (`new Date("29-01-2025")`
// is Invalid) and silently misreads ambiguous slashed dates as US month-first.
interface DateParts {
  y: number;
  m: number; // 1-12
  d: number; // 1-31
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

// 2-digit year → 4-digit. <70 ⇒ 2000s, else 1900s (the de-facto POSIX pivot).
function expandYear(y: number, digits: number): number {
  if (digits > 2) return y;
  return y < 70 ? 2000 + y : 1900 + y;
}

// Reject impossible component combos (month 13, day 31 in February, etc.).
function validParts(p: DateParts): DateParts | null {
  if (p.m < 1 || p.m > 12) return null;
  if (p.d < 1 || p.d > 31) return null;
  if (p.y < 1700 || p.y > 2200) return null;
  // Day-in-month bound, leap years included. Date(y, m, 0) = last day of month m.
  const lastDay = new Date(p.y, p.m, 0).getDate();
  if (p.d > lastDay) return null;
  return p;
}

// Parse one date string into explicit components. `dayFirst` only disambiguates
// purely-numeric slashed/dashed/dotted dates where BOTH leading parts are ≤12
// (e.g. 04/10/2024); ISO, month-name, and forms where one part is >12 are
// unambiguous and ignore the hint.
function parseDatePartsFlexible(raw: string, dayFirst: boolean): DateParts | null {
  const s = raw.trim();
  if (s.length < 6 || s.length > 35) return null;

  // ISO 8601 (optionally with a time component we don't keep).
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]\d.*)?$/);
  if (m) return validParts({ y: +m[1], m: +m[2], d: +m[3] });

  // Year-first slashed: 2024/01/05.
  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return validParts({ y: +m[1], m: +m[2], d: +m[3] });

  // Numeric A?B?C with / - or . separators, C = 2/4-digit year.
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    const y = expandYear(+m[3], m[3].length);
    let day: number;
    let mon: number;
    if (a > 12 && b <= 12) {
      day = a;
      mon = b; // first part can't be a month → day-first
    } else if (b > 12 && a <= 12) {
      mon = a;
      day = b; // second part can't be a month → month-first
    } else if (a > 12 && b > 12) {
      return null; // neither can be a month
    } else {
      // Genuinely ambiguous (both ≤12) — defer to the column-level hint.
      day = dayFirst ? a : b;
      mon = dayFirst ? b : a;
    }
    return validParts({ y, m: mon, d: day });
  }

  // Month-name first: "Jan 5, 2024", "January 5 2024".
  m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})$/);
  if (m) {
    const mon = MONTH_NAMES[m[1].toLowerCase()];
    if (!mon) return null;
    return validParts({ y: expandYear(+m[3], m[3].length), m: mon, d: +m[2] });
  }

  // Day-then-month-name: "5 Jan 2024".
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{2,4})$/);
  if (m) {
    const mon = MONTH_NAMES[m[2].toLowerCase()];
    if (!mon) return null;
    return validParts({ y: expandYear(+m[3], m[3].length), m: mon, d: +m[1] });
  }

  return null;
}

// Inspect a column's values and decide whether its numeric dates are day-first
// (DD/MM) or month-first (MM/DD). Any value whose first part is >12 is hard
// evidence for day-first; second part >12 is evidence for month-first. Majority
// wins; with no disambiguating evidence we default to month-first (US), which
// is also what the native parser assumes.
function inferDayFirst(values: string[]): boolean {
  let dayFirst = 0;
  let monthFirst = 0;
  for (const raw of values) {
    const m = raw.trim().match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.]\d{2,4}$/);
    if (!m) continue;
    const a = +m[1];
    const b = +m[2];
    if (a > 12 && b <= 12) dayFirst++;
    else if (b > 12 && a <= 12) monthFirst++;
  }
  return dayFirst > monthFirst;
}

function partsToStyle(p: DateParts, style: DateStyle): string {
  const y = String(p.y).padStart(4, "0");
  const m = String(p.m).padStart(2, "0");
  const d = String(p.d).padStart(2, "0");
  switch (style) {
    case "iso":
      return `${y}-${m}-${d}`;
    case "us":
      return `${m}/${d}/${y}`;
    case "eu":
      return `${d}/${m}/${y}`;
  }
}

// Reformat a single date string to the requested style, or null if it isn't a
// parseable date. `dayFirst` disambiguates numeric forms (default month-first).
export function formatDateStyled(raw: string, style: DateStyle, dayFirst = false): string | null {
  const p = parseDatePartsFlexible(raw, dayFirst);
  if (p === null) return null;
  return partsToStyle(p, style);
}

// Collect a sampled set of the string values in a column (cap so big datasets
// stay fast). Used to infer the column's date convention before reformatting.
function sampleStringValues(dataset: Dataset, column: string, cap = 20_000): string[] {
  const N = dataset.rows.length;
  const stride = N > cap ? Math.ceil(N / cap) : 1;
  const out: string[] = [];
  for (let i = 0; i < N; i += stride) {
    const v = dataset.rows[i][column];
    if (typeof v === "string") {
      const t = v.trim();
      if (t !== "") out.push(t);
    }
  }
  return out;
}

// Find string columns whose non-empty cells are ≥80% date-shaped. Format is
// inferred per column so day-first (European) columns are detected too — the
// native parser would reject most of those. Works directly off a Dataset (no
// metas) so chat can call it before any cleaning plan exists.
export function detectDateColumns(dataset: Dataset): string[] {
  if (dataset.rows.length === 0) return [];
  const out: string[] = [];
  for (const c of dataset.columns) {
    const values = sampleStringValues(dataset, c);
    if (values.length < 4) continue;
    const dayFirst = inferDayFirst(values);
    let hits = 0;
    for (const v of values) if (parseDatePartsFlexible(v, dayFirst) !== null) hits++;
    if (hits / values.length >= 0.8) out.push(c);
  }
  return out;
}

export interface ReformatColumnResult {
  name: string;
  dayFirst: boolean; // how ambiguous numeric source dates were read
  changed: number; // cells whose text actually changed
  unparsed: number; // non-empty cells that weren't recognisable dates
}

// Rewrite the date cells of the named columns into `style`. Each column's
// source convention is inferred independently, so a column mixing ISO,
// day-first slashed, and month-name values all land in one consistent target
// format. Non-date cells (and other columns) pass through untouched. Returns
// the new Dataset, the total cells changed, and per-column diagnostics so the
// caller can explain what it did and flag anything it couldn't parse.
export function reformatDateColumns(
  dataset: Dataset,
  columns: string[],
  style: DateStyle,
): { dataset: Dataset; changed: number; columns: ReformatColumnResult[] } {
  const targets = columns.filter((c) => dataset.columns.includes(c));
  if (targets.length === 0) return { dataset, changed: 0, columns: [] };

  // Infer each target column's day-first convention once, up front.
  const dayFirstByCol = new Map<string, boolean>();
  const stats = new Map<string, ReformatColumnResult>();
  for (const c of targets) {
    const dayFirst = inferDayFirst(sampleStringValues(dataset, c));
    dayFirstByCol.set(c, dayFirst);
    stats.set(c, { name: c, dayFirst, changed: 0, unparsed: 0 });
  }

  let changed = 0;
  const targetSet = new Set(targets);
  const rows = dataset.rows.map((r) => {
    let touched = false;
    const out: Row = {};
    for (const c of dataset.columns) {
      const v = r[c];
      if (targetSet.has(c) && typeof v === "string" && v.trim() !== "") {
        const p = parseDatePartsFlexible(v, dayFirstByCol.get(c) ?? false);
        const stat = stats.get(c);
        if (p === null) {
          if (stat) stat.unparsed++;
        } else {
          const f = partsToStyle(p, style);
          if (f !== v) {
            out[c] = f;
            changed++;
            touched = true;
            if (stat) stat.changed++;
            continue;
          }
        }
      }
      out[c] = v;
    }
    return touched ? out : r;
  });

  return {
    dataset: { name: dataset.name, columns: dataset.columns, rows },
    changed,
    columns: [...stats.values()],
  };
}

// Null every cell in `column` that isn't a recognisable date. The column's
// day-first convention is inferred first so European dates aren't wrongly
// discarded. Numbers and unparseable strings alike are treated as non-dates;
// already-null cells are left alone. Returns the new Dataset and the count
// cleared. Powers the per-column "remove all non-dates" chat intent.
export function clearNonDateCells(
  dataset: Dataset,
  column: string,
): { dataset: Dataset; cleared: number } {
  if (!dataset.columns.includes(column)) return { dataset, cleared: 0 };
  const dayFirst = inferDayFirst(sampleStringValues(dataset, column));
  let cleared = 0;
  const rows = dataset.rows.map((r) => {
    const v = r[column];
    if (v === null) return r;
    if (typeof v === "string" && parseDatePartsFlexible(v, dayFirst) !== null) return r;
    cleared++;
    return { ...r, [column]: null };
  });
  if (cleared === 0) return { dataset, cleared: 0 };
  return { dataset: { name: dataset.name, columns: dataset.columns, rows }, cleared };
}

// Light per-column clean scoped to one column (so "clean this column" doesn't
// touch the rest of the grid): repair encoding, trim, collapse internal
// whitespace, and null common missing-markers. Returns counts of cells tidied
// vs nulled.
export function cleanColumnCells(
  dataset: Dataset,
  column: string,
): { dataset: Dataset; tidied: number; nulled: number } {
  if (!dataset.columns.includes(column)) return { dataset, tidied: 0, nulled: 0 };
  let tidied = 0;
  let nulled = 0;
  const rows = dataset.rows.map((r) => {
    const v = r[column];
    if (typeof v !== "string") return r;
    const cleaned = fixEncoding(v).trim().replace(/\s{2,}/g, " ");
    const next: string | null = MISSING_TOKENS.has(cleaned.toLowerCase()) ? null : cleaned;
    if (next === v) return r;
    if (next === null) nulled++;
    else tidied++;
    return { ...r, [column]: next };
  });
  if (tidied === 0 && nulled === 0) return { dataset, tidied: 0, nulled: 0 };
  return { dataset: { name: dataset.name, columns: dataset.columns, rows }, tidied, nulled };
}

// ─── Data augmentation ────────────────────────────────────────────────────
//
// Quick intake-stage tabular augmentation: bootstrap-resample existing rows
// (preserving intra-row correlations) and add light Gaussian jitter to numeric
// columns so the synthetic rows aren't exact duplicates. Categorical / string
// / date cells are copied from the sampled base row; identifier-like numeric
// columns (near-unique integers) are extended past the observed max instead of
// jittered so they stay unique. This is deliberately simple and transparent —
// for correlation-preserving synthesis (SMOTE, copulas, CTGAN) the modeling
// stage is the right place.

// Standard normal via Box–Muller. Math.random is fine in app code.
function gaussianNoise(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Decimal places of a number's literal form, capped — so jittered floats keep
// roughly the source precision instead of sprouting 15 digits.
function decimalPlaces(n: number): number {
  if (Number.isInteger(n)) return 0;
  const s = String(n);
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : Math.min(6, s.length - dot - 1);
}

export function augmentDataset(
  dataset: Dataset,
  metas: ColumnMeta[],
  addRows: number,
): { dataset: Dataset; added: number } {
  const N = dataset.rows.length;
  if (N === 0 || addRows <= 0) return { dataset, added: 0 };

  type NumStat = { std: number; min: number; max: number; integer: boolean; idLike: boolean };
  const numStats = new Map<string, NumStat>();
  for (const m of metas) {
    if (m.type !== "number") continue;
    let sum = 0;
    let sumsq = 0;
    let cnt = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let integer = true;
    for (const r of dataset.rows) {
      const v = r[m.name];
      if (typeof v !== "number") continue;
      sum += v;
      sumsq += v * v;
      cnt++;
      if (v < min) min = v;
      if (v > max) max = v;
      if (!Number.isInteger(v)) integer = false;
    }
    if (cnt === 0) continue;
    const mean = sum / cnt;
    const std = Math.sqrt(Math.max(0, sumsq / cnt - mean * mean));
    const uniqueRatio = m.count > 0 ? m.unique / m.count : 0;
    // Identifier columns must not be jittered (it would corrupt keys) — but a
    // merely high-cardinality numeric (age, salary, a precise measurement) is
    // NOT an ID and SHOULD be jittered. So require a name that reads like an
    // identifier in addition to being a near-unique integer.
    const idName = /(^|[_\s])(id|ids|key|code|no|num|number|index|idx|uuid|guid)$/i.test(m.name);
    const idLike = integer && std > 0 && uniqueRatio >= 0.95 && idName;
    numStats.set(m.name, { std, min, max, integer, idLike });
  }

  const newRows: Row[] = [];
  for (let i = 0; i < addRows; i++) {
    const base = dataset.rows[Math.floor(Math.random() * N)];
    const out: Row = {};
    for (const c of dataset.columns) {
      const v = base[c];
      const stat = numStats.get(c);
      if (typeof v === "number" && stat) {
        if (stat.idLike) {
          out[c] = Math.round(stat.max) + i + 1; // keep IDs unique & monotonic
        } else if (stat.std === 0) {
          out[c] = v; // constant column — nothing to jitter
        } else {
          let nv = v + gaussianNoise() * stat.std * 0.25;
          nv = Math.min(stat.max, Math.max(stat.min, nv));
          out[c] = stat.integer ? Math.round(nv) : Number(nv.toFixed(decimalPlaces(v)));
        }
      } else {
        out[c] = v; // categorical / date / string / null copied from base row
      }
    }
    newRows.push(out);
  }

  return {
    dataset: { name: dataset.name, columns: dataset.columns, rows: [...dataset.rows, ...newRows] },
    added: addRows,
  };
}

// Apply runs at full fidelity (never sampled). Cell-level ops are fused
// into a single row pass — important for multi-million-row datasets where
// allocating a fresh Row[] per op would dominate wall time.
export function applyCleaning(
  dataset: Dataset,
  plan: CleaningPlan,
  enabled: Set<CleaningOpKey>,
): Dataset {
  // Active flags for the fused per-row transform.
  const doTrim = enabled.has("trim");
  const doCollapse = enabled.has("collapse-whitespace");
  const doEncoding = enabled.has("fix-encoding");
  const doMissing = enabled.has("missing-tokens");
  const doParse = enabled.has("parse-numeric");
  const doDates = enabled.has("parse-dates");
  const doBool = enabled.has("standardise-booleans");
  const doSentinels = enabled.has("replace-numeric-sentinels");
  const doLower = enabled.has("lowercase-categoricals");

  const parseTargets = new Set<string>();
  const dateTargets = new Set<string>();
  const boolTargets = new Set<string>();
  const lowerTargets = new Set<string>();
  // sentinel value lookup keyed by column → set of numbers to null out.
  const sentinelTargets = new Map<string, Set<number>>();
  for (const op of plan.ops) {
    if (op.key === "parse-numeric") for (const c of op.columns) parseTargets.add(c);
    if (op.key === "parse-dates") for (const c of op.columns) dateTargets.add(c);
    if (op.key === "standardise-booleans") for (const c of op.columns) boolTargets.add(c.name);
    if (op.key === "lowercase-categoricals") for (const c of op.columns) lowerTargets.add(c.name);
    if (op.key === "replace-numeric-sentinels") {
      for (const c of op.columns) {
        const set = sentinelTargets.get(c.name) ?? new Set<number>();
        set.add(c.value);
        sentinelTargets.set(c.name, set);
      }
    }
  }

  let columns: string[] = dataset.columns;
  let rows: Row[] = dataset.rows;

  // Single fused per-row transform — only allocates a new Row[] when at
  // least one cell-level op is enabled.
  const cellPassActive =
    doTrim ||
    doCollapse ||
    doEncoding ||
    doMissing ||
    doParse ||
    doDates ||
    doBool ||
    doLower ||
    (doSentinels && sentinelTargets.size > 0);
  if (cellPassActive) {
    rows = rows.map((r) => {
      const out: Row = {};
      for (const c of columns) {
        let v = r[c];
        // Numeric branch — only sentinel replacement applies here.
        if (typeof v === "number" && doSentinels) {
          const set = sentinelTargets.get(c);
          if (set?.has(v)) v = null;
        }
        if (typeof v === "string") {
          if (doEncoding) v = fixEncoding(v);
          if (typeof v === "string" && doTrim) v = v.trim();
          if (typeof v === "string" && doCollapse) v = v.replace(/\s{2,}/g, " ");
          if (typeof v === "string" && doMissing) {
            const lower = v.trim().toLowerCase();
            if (MISSING_TOKENS.has(lower)) v = null;
          }
          if (typeof v === "string" && doBool && boolTargets.has(c)) {
            const lower = v.trim().toLowerCase();
            if (TRUE_TOKENS.has(lower)) v = "true";
            else if (FALSE_TOKENS.has(lower)) v = "false";
          }
          if (typeof v === "string" && doDates && dateTargets.has(c)) {
            const d = parseFlexibleDate(v);
            if (d !== null) v = toCanonicalIsoDate(v, d);
          }
          if (typeof v === "string" && doParse && parseTargets.has(c)) {
            const n = parseFlexibleNumber(v);
            if (n !== null) v = n;
          }
          if (typeof v === "string" && doLower && lowerTargets.has(c)) {
            v = v.toLowerCase();
          }
        }
        out[c] = v;
      }
      return out;
    });
  }

  // Row-level: drop duplicates. Full-fidelity hash pass over the cell-cleaned
  // rows so duplicates introduced by normalisation are also caught.
  if (enabled.has("drop-duplicates")) {
    const seen = new Set<string>();
    rows = rows.filter((r) => {
      const k = rowKey(r, columns);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // Column-level: drop empty / constant columns. Done together so we only
  // re-project rows once when both ops are active.
  const dropSet = new Set<string>();
  for (const op of plan.ops) {
    if (op.key === "drop-empty-cols" && enabled.has("drop-empty-cols")) {
      for (const c of op.columns) dropSet.add(c.name);
    }
    if (op.key === "drop-constant-cols" && enabled.has("drop-constant-cols")) {
      for (const c of op.columns) dropSet.add(c.name);
    }
  }
  if (dropSet.size > 0) {
    columns = columns.filter((c) => !dropSet.has(c));
    rows = rows.map((r) => {
      const out: Row = {};
      for (const c of columns) out[c] = r[c];
      return out;
    });
  }

  // Header rename — done last so all preceding cell ops still see the
  // original column names. We re-project rows in column order so the
  // downstream Dataset.columns and Row keys stay consistent.
  if (enabled.has("rename-snake-case")) {
    const renameMap = new Map<string, string>();
    for (const op of plan.ops) {
      if (op.key !== "rename-snake-case") continue;
      for (const c of op.columns) renameMap.set(c.from, c.to);
    }
    if (renameMap.size > 0) {
      columns = columns.map((c) => renameMap.get(c) ?? c);
      rows = rows.map((r) => {
        const out: Row = {};
        for (const original of dataset.columns) {
          const final = renameMap.get(original) ?? original;
          if (columns.includes(final)) out[final] = r[original];
        }
        return out;
      });
    }
  }

  return { name: dataset.name, columns, rows };
}
