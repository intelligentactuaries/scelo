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
