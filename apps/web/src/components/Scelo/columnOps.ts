// Deterministic column operations + the natural-language intent parser that
// routes chat requests to them. The column hover-chat and the soft stage chat
// both call `parseColumnOpIntent` first; when it matches, the workstation
// EXECUTES the operation on the grid instead of letting the AI describe it.
// Every transform follows cleaning.ts's convention — map rows, spread-copy
// only changed rows, no-op returns the original dataset object — but keeps
// the dataset's `sampled` metadata via object spread (the sampling banner
// must survive an in-place column op).

import type { CellValue, ColumnMeta, Dataset } from "./SoftDataWorkstation";
import { coerceNumericValue } from "./cleaning";

// ─── transforms ─────────────────────────────────────────────────────────────

/** Numbers → their literal string form; strings and nulls untouched. */
export function convertColumnToString(
  dataset: Dataset,
  column: string,
): { dataset: Dataset; converted: number } {
  if (!dataset.columns.includes(column)) return { dataset, converted: 0 };
  let converted = 0;
  const rows = dataset.rows.map((r) => {
    const v = r[column];
    if (typeof v !== "number") return r;
    converted++;
    return { ...r, [column]: String(v) };
  });
  if (converted === 0) return { dataset, converted: 0 };
  return { dataset: { ...dataset, rows }, converted };
}

/**
 * Strings → numbers via the flexible coercer ("R1 200,50", "6+", "45%"…);
 * unparseable text becomes null (counted separately so the reply is honest).
 * `integer` also rounds every numeric cell to a whole number.
 */
export function convertColumnToNumber(
  dataset: Dataset,
  column: string,
  integer = false,
): { dataset: Dataset; converted: number; nulled: number } {
  if (!dataset.columns.includes(column)) return { dataset, converted: 0, nulled: 0 };
  let converted = 0;
  let nulled = 0;
  const rows = dataset.rows.map((r) => {
    const v = r[column];
    if (v === null) return r;
    if (typeof v === "number") {
      if (!integer || Number.isInteger(v)) return r;
      converted++;
      return { ...r, [column]: Math.round(v) };
    }
    const n = coerceNumericValue(v);
    if (n === null) {
      nulled++;
      return { ...r, [column]: null };
    }
    converted++;
    return { ...r, [column]: integer ? Math.round(n) : n };
  });
  if (converted === 0 && nulled === 0) return { dataset, converted: 0, nulled: 0 };
  return { dataset: { ...dataset, rows }, converted, nulled };
}

export type CaseMode = "lower" | "upper" | "title";

const toTitleCase = (s: string) =>
  s.replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

/** Lower/upper/title-case every string cell; numbers and nulls untouched. */
export function transformColumnCase(
  dataset: Dataset,
  column: string,
  mode: CaseMode,
): { dataset: Dataset; changed: number } {
  if (!dataset.columns.includes(column)) return { dataset, changed: 0 };
  const apply =
    mode === "lower"
      ? (s: string) => s.toLowerCase()
      : mode === "upper"
        ? (s: string) => s.toUpperCase()
        : toTitleCase;
  let changed = 0;
  const rows = dataset.rows.map((r) => {
    const v = r[column];
    if (typeof v !== "string") return r;
    const next = apply(v);
    if (next === v) return r;
    changed++;
    return { ...r, [column]: next };
  });
  if (changed === 0) return { dataset, changed: 0 };
  return { dataset: { ...dataset, rows }, changed };
}

/** Round numeric cells to `decimals` places; strings and nulls untouched. */
export function roundColumnValues(
  dataset: Dataset,
  column: string,
  decimals: number,
): { dataset: Dataset; changed: number } {
  if (!dataset.columns.includes(column)) return { dataset, changed: 0 };
  const f = 10 ** Math.max(0, Math.min(12, decimals));
  let changed = 0;
  const rows = dataset.rows.map((r) => {
    const v = r[column];
    if (typeof v !== "number") return r;
    const next = Math.round(v * f) / f;
    if (next === v) return r;
    changed++;
    return { ...r, [column]: next };
  });
  if (changed === 0) return { dataset, changed: 0 };
  return { dataset: { ...dataset, rows }, changed };
}

export type MissingFiller = "auto" | "mean" | "median" | "mode" | "zero" | { value: string };

/**
 * Fill null cells. Statistical fillers compute from the column's non-null
 * cells (mean/median need a numeric majority); "auto" picks median for
 * numeric columns, mode otherwise. A literal value keeps the column's
 * dominant type — numeric-majority columns get the parsed number when the
 * literal parses. Returns the fill value actually used so the reply can
 * state it.
 */
export function fillMissingInColumn(
  dataset: Dataset,
  column: string,
  filler: MissingFiller,
): { dataset: Dataset; filled: number; fillValue: CellValue } {
  if (!dataset.columns.includes(column)) return { dataset, filled: 0, fillValue: null };
  const nums: number[] = [];
  const freq = new Map<CellValue, number>();
  let nonNull = 0;
  for (const r of dataset.rows) {
    const v = r[column];
    if (v === null) continue;
    nonNull++;
    if (typeof v === "number") nums.push(v);
    freq.set(v, (freq.get(v) ?? 0) + 1);
  }
  const numericMajority = nonNull > 0 && nums.length >= nonNull / 2;
  const mode = (): CellValue => {
    let best: CellValue = null;
    let bestN = 0;
    for (const [v, n] of freq) {
      if (n > bestN) {
        best = v;
        bestN = n;
      }
    }
    return best;
  };
  const median = (): number | null => {
    if (nums.length === 0) return null;
    const s = [...nums].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const mean = (): number | null => {
    if (nums.length === 0) return null;
    const m = nums.reduce((a, b) => a + b, 0) / nums.length;
    return Math.round(m * 1e6) / 1e6;
  };

  let fillValue: CellValue;
  if (typeof filler === "object") {
    const n = numericMajority ? coerceNumericValue(filler.value) : null;
    fillValue = n !== null ? n : filler.value;
  } else if (filler === "zero") {
    fillValue = 0;
  } else if (filler === "mean") {
    fillValue = mean();
  } else if (filler === "median") {
    fillValue = median();
  } else if (filler === "mode") {
    fillValue = mode();
  } else {
    fillValue = numericMajority ? median() : mode();
  }
  if (fillValue === null) return { dataset, filled: 0, fillValue: null };

  let filled = 0;
  const rows = dataset.rows.map((r) => {
    if (r[column] !== null) return r;
    filled++;
    return { ...r, [column]: fillValue };
  });
  if (filled === 0) return { dataset, filled: 0, fillValue };
  return { dataset: { ...dataset, rows }, filled, fillValue };
}

/** Remove the column from the schema and every row. */
export function dropColumnFromDataset(dataset: Dataset, column: string): { dataset: Dataset } {
  if (!dataset.columns.includes(column)) return { dataset };
  const rows = dataset.rows.map((r) => {
    const { [column]: _omit, ...rest } = r;
    return rest;
  });
  return { dataset: { ...dataset, columns: dataset.columns.filter((c) => c !== column), rows } };
}

/**
 * Drop rows whose value in `column` falls outside the Tukey fences already
 * computed in the column meta. Nulls and non-numeric cells are kept — removing
 * missing values is a different, explicit ask.
 */
export function removeOutlierRows(
  dataset: Dataset,
  column: string,
  meta: ColumnMeta | undefined,
): { dataset: Dataset; removed: number; lo: number; hi: number } | null {
  if (!dataset.columns.includes(column)) return null;
  if (!meta || meta.loFence === undefined || meta.hiFence === undefined) return null;
  const { loFence: lo, hiFence: hi } = meta;
  let removed = 0;
  const rows = dataset.rows.filter((r) => {
    const v = r[column];
    if (typeof v !== "number") return true;
    const keep = v >= lo && v <= hi;
    if (!keep) removed++;
    return keep;
  });
  if (removed === 0) return { dataset, removed: 0, lo, hi };
  return { dataset: { ...dataset, rows }, removed, lo, hi };
}

// ─── intent parser ──────────────────────────────────────────────────────────

export type ColumnOpIntent =
  | { kind: "to-string" }
  | { kind: "to-number"; integer: boolean }
  | { kind: "case"; mode: CaseMode }
  | { kind: "round"; decimals: number }
  | { kind: "fill-missing"; filler: MissingFiller }
  | { kind: "remove-outliers" }
  | { kind: "drop-column" }
  | { kind: "trim" };

// Questions get answers, not mutations — "what would happen if I converted
// this to string?" must reach the AI, not the executor.
const QUESTION_SHAPE =
  /^(what|what's|why|how|when|where|which|who|is|are|was|were|does|do|did|can|could|should|would|will|tell|explain|describe|show)\b|\?\s*$/;

const ACTION_VERB =
  /\b(convert|cast|coerce|change|turn|make|force|standardi[sz]e|transform|set|stringify|parse|treat)\b/;

/**
 * Parse a chat message into a column operation, or null to fall through to
 * the AI provider. Deliberately conservative: question-shaped messages and
 * anything date-flavoured (owned by the dedicated date handlers) never match.
 */
export function parseColumnOpIntent(text: string): ColumnOpIntent | null {
  const t = text.toLowerCase().trim();
  if (QUESTION_SHAPE.test(t)) return null;
  if (/\bdates?\b/.test(t)) return null;

  // trim / strip whitespace — before case/round so "trim spaces" wins. A
  // whitespace noun always qualifies ("strip spaces in this column");
  // otherwise a bare trim/strip only counts when no row/outlier noun steals
  // the verb ("strip the outlier rows" belongs to the outlier matcher).
  if (
    /\b(trim|strip)\b/.test(t) &&
    (/\b(whitespace|spaces?|padding)\b/.test(t) || !/\b(outliers?|duplicates?|rows?)\b/.test(t))
  ) {
    return { kind: "trim" };
  }

  // case transforms — before to-string ("make the text lowercase" is a case
  // ask even though it names "text").
  if (/\b(lower[\s-]?case|lowercase)\b/.test(t)) return { kind: "case", mode: "lower" };
  if (/\b(upper[\s-]?case|uppercase|capital letters|all caps)\b/.test(t)) {
    return { kind: "case", mode: "upper" };
  }
  if (/\b(title[\s-]?case|capitali[sz]e)\b/.test(t)) return { kind: "case", mode: "title" };

  // rounding — before to-number ("round to 2 decimals" names "decimals").
  if (/\bround\b/.test(t)) {
    const dp =
      t.match(/\b(\d+)\s*(?:decimal(?:\s+point)?s?|dp|places?|digits?)\b/) ??
      t.match(/\bto\s+(\d+)\b/);
    return { kind: "round", decimals: dp ? Number.parseInt(dp[1], 10) : 0 };
  }

  // fill missing — before type conversion ("replace nulls with 0" isn't a
  // numeric cast).
  const missingNoun = /\b(missing(?:\s+values?)?|blanks?|nulls?|empty|empties|nans?|n\/a)\b/;
  if (/\b(fill|impute|replace)\b/.test(t) && missingNoun.test(t)) {
    let filler: MissingFiller = "auto";
    if (/\b(mean|average|avg)\b/.test(t)) filler = "mean";
    else if (/\bmedian\b/.test(t)) filler = "median";
    else if (/\b(mode|most\s+(?:common|frequent))\b/.test(t)) filler = "mode";
    else if (/\b(?:with|to|as|using)\s+(?:a\s+)?(?:zero|0)\b/.test(t)) filler = "zero";
    else {
      const quoted = t.match(/(?:with|to|as|using)\s+["'“”]([^"'“”]+)["'“”]/);
      const bare = t.match(/(?:with|to|as|using)\s+([\w.+-]+)\s*$/);
      const v = quoted?.[1] ?? bare?.[1];
      if (v !== undefined && !missingNoun.test(v)) filler = { value: v };
    }
    return { kind: "fill-missing", filler };
  }

  // outlier row removal.
  if (/\b(remove|drop|delete|exclude|filter\s*(?:out)?)\b/.test(t) && /\boutliers?\b/.test(t)) {
    return { kind: "remove-outliers" };
  }

  // type conversion.
  const stringNoun = /\b(strings?|text|textual|varchar|stringif(?:y|ied))\b/;
  const numberNoun = /\b(numbers?|numeric(?:al)?|floats?|doubles?|decimals?|integers?|ints?)\b/;
  if (
    ACTION_VERB.test(t) ||
    /\bto\s+(?:a\s+)?(?:string|text|number|numeric|integer|int|float)\b/.test(t)
  ) {
    // "convert this text column to numbers" names both — the destination is
    // whatever follows "to"; otherwise first noun mentioned wins.
    const dest = t.match(/\bto\s+(?:a\s+)?(\w+)/)?.[1];
    if (dest && stringNoun.test(dest)) return { kind: "to-string" };
    if (dest && numberNoun.test(dest)) {
      return { kind: "to-number", integer: /\bint(?:eger)?s?\b/.test(dest) };
    }
    if (stringNoun.test(t) && !numberNoun.test(t)) return { kind: "to-string" };
    if (numberNoun.test(t) && !stringNoun.test(t)) {
      return { kind: "to-number", integer: /\bint(?:eger)?s?\b|\bwhole\s+numbers?\b/.test(t) };
    }
  }

  // drop the column itself — last and heavily guarded so row-level and
  // value-level removals never delete a column.
  if (
    /\b(drop|delete|remove|get rid of|discard)\b/.test(t) &&
    /\b(column|field|this|it)\b/.test(t) &&
    !/\b(rows?|values?|cells?|outliers?|missing|blanks?|nulls?|duplicates?|non[\s-]?dates?)\b/.test(
      t,
    )
  ) {
    return { kind: "drop-column" };
  }

  return null;
}

/**
 * Which dataset columns does the message name? Whole-word, case-insensitive.
 * The soft stage chat uses this to scope a parsed intent; exactly one match
 * executes, anything else asks the user to name the column.
 */
export function resolveColumnsMentioned(text: string, columns: string[]): string[] {
  const t = text.toLowerCase();
  return columns.filter((c) => {
    const escaped = c.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\w])${escaped}(?![\\w])`).test(t);
  });
}
