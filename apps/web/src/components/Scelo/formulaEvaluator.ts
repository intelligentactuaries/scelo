// Formula evaluator for Soft Data derived / transformed columns.
//
// Originally numeric-only; now a small cleaning DSL so the chat agent can
// actually DO the everyday cleaning verbs instead of only describing them:
//
//   numeric : + - * / % **, log/exp/sqrt/abs/round/floor/ceil/min/max/pow/sign/...
//   logic   : if(cond, a, b), coalesce(a, b, ...), isnull(x), == != > >= < <= && ||
//   strings : lower upper trim len replace(s, find, repl) concat(...) str(x)
//   dates   : to_us_date to_iso_date to_eu_date to_long_date year month day weekday
//   columns : reference a column by bare name (paid) OR backtick-quote names
//             with spaces/punctuation (`Joined Date`); `value` (alias `col`,
//             `cell`) means "this column" in a per-column transform.
//   aggregs : mean(col) median(col) mode(col) colmin(col) colmax(col)
//             colsum(col) colcount(col) stdev(col) — whole-column constants,
//             the basis for imputation, e.g. replace -999 with the average:
//               if(`age` == -999, mean(`age`), `age`)
//
// Why not `new Function(formula)` raw: the formula runs against every row,
// so we keep a strict identifier whitelist — nothing reaches fetch/window —
// and we want explainable errors ("unknown column `paud`") rather than a
// raw ReferenceError.
//
// Implementation: tokenizer → aggregate-substitution pass (folds mean(col)
// etc. to a literal computed from the rows) → identifier whitelist →
// codegen to a guarded `new Function`.

import type { CellValue, Row } from "./SoftDataWorkstation";

// Binary/unary math helpers — compiled to `Math.<name>`.
const MATH_FUNCS = new Set([
  "log",
  "log10",
  "log2",
  "exp",
  "sqrt",
  "abs",
  "min",
  "max",
  "floor",
  "ceil",
  "round",
  "pow",
  "sign",
  "sin",
  "cos",
  "tan",
]);

// Per-row helpers compiled to a local `_<name>` reference. Each takes the
// cell value(s) and returns a CellValue. Grouped only for documentation.
const LOGIC_FUNCS = new Set(["if", "isnull", "coalesce"]);
const STRING_FUNCS = new Set(["lower", "upper", "trim", "len", "replace", "concat", "str"]);
const DATE_FUNCS = new Set([
  "to_us_date",
  "to_iso_date",
  "to_eu_date",
  "to_long_date",
  "year",
  "month",
  "day",
  "weekday",
]);
const HELPER_FUNCS = new Set([...LOGIC_FUNCS, ...STRING_FUNCS, ...DATE_FUNCS]);

// Funcs whose single column argument should be passed RAW (the untouched
// cell, not coerced to 0) so strings / dates survive. Numeric refs keep the
// historical `?? 0` default so arithmetic stays null-safe.
const RAW_ARG_FUNCS = new Set([...STRING_FUNCS, ...DATE_FUNCS]);

// Whole-column aggregates — folded to a literal at compile time from the
// dataset rows. Need `opts.rows`.
const AGG_FUNCS = new Set([
  "mean",
  "median",
  "mode",
  "colmin",
  "colmax",
  "colsum",
  "colcount",
  "stdev",
]);

const KEYWORDS = new Set(["true", "false", "null"]);
// Names that resolve to "the current column" in a per-column transform.
const SELF_REFS = new Set(["value", "col", "cell"]);

const VALID_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Token =
  | { kind: "num"; value: string }
  | { kind: "str"; value: string } // value is the raw (unquoted) string content
  | { kind: "id"; value: string }
  | { kind: "col"; value: string } // backtick-quoted column name (may contain spaces)
  | { kind: "op"; value: string }
  | { kind: "lparen"; value: "(" }
  | { kind: "rparen"; value: ")" }
  | { kind: "comma"; value: "," };

function tokenize(src: string): Token[] {
  // Drop the JS-ism the LLM reliably emits: `Math.round` → `round`. We no
  // longer strip backticks here — backticks now denote a column reference.
  const cleaned = src.replace(/\bMath\./g, "");
  const toks: Token[] = [];
  let i = 0;
  while (i < cleaned.length) {
    const c = cleaned[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // String literal: '...' or "..." with backslash escapes.
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      let out = "";
      while (j < cleaned.length && cleaned[j] !== quote) {
        if (cleaned[j] === "\\" && j + 1 < cleaned.length) {
          const next = cleaned[j + 1];
          out += next === "n" ? "\n" : next === "t" ? "\t" : next;
          j += 2;
          continue;
        }
        out += cleaned[j];
        j++;
      }
      if (j >= cleaned.length) throw new Error("Unterminated string literal.");
      toks.push({ kind: "str", value: out });
      i = j + 1;
      continue;
    }
    // Backtick column reference: `Any Column Name`.
    if (c === "`") {
      let j = i + 1;
      let out = "";
      while (j < cleaned.length && cleaned[j] !== "`") {
        out += cleaned[j];
        j++;
      }
      if (j >= cleaned.length) throw new Error("Unterminated `column` reference.");
      toks.push({ kind: "col", value: out.trim() });
      i = j + 1;
      continue;
    }
    // Numbers: integer / float / scientific. Allow leading dot.
    if (/\d/.test(c) || (c === "." && /\d/.test(cleaned[i + 1] ?? ""))) {
      let j = i;
      while (j < cleaned.length && /[\d.]/.test(cleaned[j])) j++;
      if (j < cleaned.length && (cleaned[j] === "e" || cleaned[j] === "E")) {
        j++;
        if (cleaned[j] === "+" || cleaned[j] === "-") j++;
        while (j < cleaned.length && /\d/.test(cleaned[j])) j++;
      }
      toks.push({ kind: "num", value: cleaned.slice(i, j) });
      i = j;
      continue;
    }
    // Identifiers
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < cleaned.length && /[A-Za-z0-9_]/.test(cleaned[j])) j++;
      toks.push({ kind: "id", value: cleaned.slice(i, j) });
      i = j;
      continue;
    }
    if (c === "(") {
      toks.push({ kind: "lparen", value: "(" });
      i++;
      continue;
    }
    if (c === ")") {
      toks.push({ kind: "rparen", value: ")" });
      i++;
      continue;
    }
    if (c === ",") {
      toks.push({ kind: "comma", value: "," });
      i++;
      continue;
    }
    const two = cleaned.slice(i, i + 2);
    if (["**", "==", "!=", ">=", "<=", "&&", "||"].includes(two)) {
      toks.push({ kind: "op", value: two });
      i += 2;
      continue;
    }
    if ("+-*/%<>!".includes(c)) {
      toks.push({ kind: "op", value: c });
      i++;
      continue;
    }
    throw new Error(`Unexpected character "${c}" at position ${i}`);
  }
  return toks;
}

// ─── column aggregates ───────────────────────────────────────────────────────

function columnValues(rows: Row[], col: string): CellValue[] {
  return rows.map((r) => r[col] ?? null);
}
function numericValues(rows: Row[], col: string): number[] {
  const out: number[] = [];
  for (const r of rows) {
    const v = r[col];
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
    else if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
      out.push(Number(v));
    }
  }
  return out;
}

function computeAggregate(fn: string, rows: Row[], col: string): CellValue {
  if (fn === "mode") {
    // Most frequent non-null value (works for categoricals and numbers).
    const counts = new Map<string, { value: CellValue; n: number }>();
    for (const v of columnValues(rows, col)) {
      if (v === null || v === "") continue;
      const key = String(v);
      const entry = counts.get(key);
      if (entry) entry.n++;
      else counts.set(key, { value: v, n: 1 });
    }
    let best: { value: CellValue; n: number } | null = null;
    for (const e of counts.values()) if (!best || e.n > best.n) best = e;
    return best ? best.value : null;
  }
  if (fn === "colcount") return numericValues(rows, col).length;

  const nums = numericValues(rows, col);
  if (nums.length === 0) return null;
  switch (fn) {
    case "mean":
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case "colsum":
      return nums.reduce((a, b) => a + b, 0);
    case "colmin":
      return Math.min(...nums);
    case "colmax":
      return Math.max(...nums);
    case "median": {
      const s = [...nums].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }
    case "stdev": {
      const m = nums.reduce((a, b) => a + b, 0) / nums.length;
      const variance = nums.reduce((a, b) => a + (b - m) ** 2, 0) / nums.length;
      return Math.sqrt(variance);
    }
    default:
      return null;
  }
}

// Fold every `aggfn(column)` triple into a literal token computed from the
// rows. Accepts the column as a bare id, a backtick `col`, or a self-ref.
function substituteAggregates(
  tokens: Token[],
  colSet: Set<string>,
  rows: Row[] | undefined,
  selfColumn: string | undefined,
): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === "id" && AGG_FUNCS.has(t.value)) {
      const lp = tokens[i + 1];
      const arg = tokens[i + 2];
      const rp = tokens[i + 3];
      if (lp?.kind !== "lparen" || rp?.kind !== "rparen" || !arg) {
        throw new Error(`${t.value}() takes one column, e.g. ${t.value}(\`column\`).`);
      }
      let col: string | null = null;
      if (arg.kind === "col") col = arg.value;
      else if (arg.kind === "id" && SELF_REFS.has(arg.value)) col = selfColumn ?? null;
      else if (arg.kind === "id") col = arg.value;
      if (!col) throw new Error(`${t.value}() needs a column name as its argument.`);
      if (!colSet.has(col)) throw new Error(`Unknown column "${col}" in ${t.value}().`);
      if (!rows) {
        throw new Error(
          `${t.value}() needs the dataset to compute a column statistic, but it wasn't available here.`,
        );
      }
      const agg = computeAggregate(t.value, rows, col);
      if (agg === null) {
        throw new Error(`${t.value}(\`${col}\`) has no numeric values to aggregate.`);
      }
      out.push(
        typeof agg === "number"
          ? { kind: "num", value: String(agg) }
          : { kind: "str", value: String(agg) },
      );
      i += 3; // consumed lparen, arg, rparen
      continue;
    }
    out.push(t);
  }
  return out;
}

export type CompiledFormula = {
  evaluate: (row: Row) => CellValue;
  referencedColumns: string[];
};

export type CompileOpts = {
  /** Dataset rows — required for aggregate functions (mean/median/...). */
  rows?: Row[];
  /** Column this formula is scoped to, so `value`/`col`/`cell` resolve to it. */
  selfColumn?: string;
};

export function compileFormula(
  formula: string,
  columns: string[],
  opts: CompileOpts = {},
): CompiledFormula {
  const trimmed = formula.trim();
  if (trimmed === "") throw new Error("Formula is empty.");

  const colSet = new Set(columns);
  const selfColumn = opts.selfColumn && colSet.has(opts.selfColumn) ? opts.selfColumn : undefined;

  let tokens = tokenize(trimmed);
  tokens = substituteAggregates(tokens, colSet, opts.rows, selfColumn);
  const referenced = new Set<string>();

  // Resolve `value`/`col`/`cell` self-refs to the scoped column up front so
  // the rest of the pipeline treats them as ordinary column references.
  tokens = tokens.map((t) => {
    if (t.kind === "id" && SELF_REFS.has(t.value)) {
      if (!selfColumn) {
        throw new Error("`value` only works in a per-column transform. Name the column instead.");
      }
      return { kind: "col", value: selfColumn } as Token;
    }
    return t;
  });

  // Whitelist pass — every identifier must be a known function or keyword;
  // every `col` token must be a real column.
  for (const t of tokens) {
    if (t.kind === "col") {
      if (!colSet.has(t.value)) {
        throw new Error(`Unknown column \`${t.value}\`. Use an exact column name.`);
      }
      referenced.add(t.value);
      continue;
    }
    if (t.kind !== "id") continue;
    if (colSet.has(t.value)) {
      referenced.add(t.value);
      continue;
    }
    if (MATH_FUNCS.has(t.value)) continue;
    if (HELPER_FUNCS.has(t.value)) continue;
    if (KEYWORDS.has(t.value)) continue;
    throw new Error(`Unknown identifier "${t.value}". Use a column name or a built-in function.`);
  }

  // Mark column tokens that are the FIRST argument of a string/date function,
  // so they pass the raw cell rather than the `?? 0` numeric default (which
  // would turn a missing string/date cell into the number 0). Works for both
  // single-arg `lower(value)` and multi-arg `replace(value, 'a', 'b')`.
  const rawIdx = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === "id" && RAW_ARG_FUNCS.has(t.value) && tokens[i + 1]?.kind === "lparen") {
      const arg = tokens[i + 2];
      const after = tokens[i + 3];
      const argIsColumn = arg?.kind === "col" || (arg?.kind === "id" && colSet.has(arg.value));
      if (argIsColumn && (after?.kind === "rparen" || after?.kind === "comma")) {
        rawIdx.add(i + 2);
      }
    }
  }

  // Codegen.
  const parts: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === "col") {
      parts.push(rawIdx.has(i) ? rawCol(t.value) : numCol(t.value));
    } else if (t.kind === "id") {
      if (colSet.has(t.value)) {
        parts.push(rawIdx.has(i) ? rawCol(t.value) : numCol(t.value));
      } else if (MATH_FUNCS.has(t.value)) {
        parts.push(`Math.${t.value}`);
      } else if (HELPER_FUNCS.has(t.value)) {
        parts.push(`_${t.value}`);
      } else {
        parts.push(t.value); // keyword
      }
    } else if (t.kind === "str") {
      parts.push(JSON.stringify(t.value));
    } else {
      parts.push(t.value);
    }
  }
  const body = `return (${parts.join(" ")});`;

  const helperNames = [...HELPER_FUNCS].map((n) => `_${n}`);
  let fn: (...args: unknown[]) => unknown;
  try {
    fn = new Function("r", ...helperNames, body) as (...args: unknown[]) => unknown;
  } catch (e) {
    throw new Error(`Could not compile formula: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Bind helpers once (not per row) so the hot path is just the row call.
  const helpers = helperNames.map((n) => HELPERS[n]);
  const evaluate = (row: Row): CellValue => {
    try {
      const v = (fn as (r: Row, ...h: unknown[]) => unknown)(row, ...helpers);
      if (typeof v === "number") return Number.isFinite(v) ? v : null;
      if (typeof v === "string") return v;
      if (typeof v === "boolean") return v ? "true" : "false";
      return null;
    } catch {
      return null;
    }
  };

  return { evaluate, referencedColumns: [...referenced] };
}

// Column accessors injected into the compiled body. `r` is the row.
function numCol(name: string): string {
  // Numeric/default context — missing → 0 so arithmetic stays well-behaved.
  return `(r[${JSON.stringify(name)}] ?? 0)`;
}
function rawCol(name: string): string {
  // String/date context — missing → null so the helper can short-circuit.
  return `(r[${JSON.stringify(name)}] ?? null)`;
}

// ─── per-row helpers (closures injected by name) ─────────────────────────────

function asText(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return String(v);
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_IDX: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

// Calendar date, timezone-free: we only ever carry (year, month, day) so
// formatting can never drift across a UTC/local midnight boundary — the bug
// that made `12/31/2023` come back as `12/30/2023`.
type YMD = { y: number; m: number; d: number };

function expandYear(y: number): number {
  return y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y;
}
function mkYMD(y: number, m: number, d: number): YMD | null {
  if (!Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1700 || y > 2200) return null;
  return { y, m, d };
}

// Parse the common date shapes into a bare calendar date without ever
// constructing a Date from an ambiguous string. Anything outside these
// shapes returns null (self-contained — no dependency on cleaning.ts).
function parseYMD(v: unknown): YMD | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return null; // ambiguous (epoch? year?) — don't guess
  const s = String(v).trim();
  // ISO-ish: YYYY-MM-DD (also tolerates / or .)
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (iso) return mkYMD(+iso[1], +iso[2], +iso[3]);
  // numeric D/M/Y or M/D/Y (slash, dash, or dot)
  const num = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s);
  if (num) {
    const a = +num[1];
    const b = +num[2];
    const y = expandYear(+num[3]);
    // a>12 forces day-first (DD/MM); otherwise default to US month-first.
    return a > 12 && b <= 12 ? mkYMD(y, b, a) : mkYMD(y, a, b);
  }
  // textual: "Mon D, YYYY" / "Month D YYYY"
  const mdy = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s);
  if (mdy) {
    const mo = MONTH_IDX[mdy[1].slice(0, 3).toLowerCase()];
    if (mo) return mkYMD(+mdy[3], mo, +mdy[2]);
  }
  // textual: "D Mon YYYY"
  const dmy = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})/.exec(s);
  if (dmy) {
    const mo = MONTH_IDX[dmy[2].slice(0, 3).toLowerCase()];
    if (mo) return mkYMD(+dmy[3], mo, +dmy[1]);
  }
  return null;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
function fmtUS(d: YMD): string {
  return `${pad2(d.m)}/${pad2(d.d)}/${d.y}`;
}
function fmtEU(d: YMD): string {
  return `${pad2(d.d)}/${pad2(d.m)}/${d.y}`;
}
function fmtISO(d: YMD): string {
  return `${d.y}-${pad2(d.m)}-${pad2(d.d)}`;
}

const HELPERS: Record<string, unknown> = {
  // logic
  _if: (cond: unknown, a: unknown, b: unknown): unknown => (cond ? a : b),
  _isnull: (v: unknown): boolean =>
    v === null || v === undefined || v === "" || (typeof v === "number" && !Number.isFinite(v)),
  _coalesce: (...args: unknown[]): unknown => {
    for (const a of args)
      if (
        !(
          a === null ||
          a === undefined ||
          a === "" ||
          (typeof a === "number" && !Number.isFinite(a))
        )
      )
        return a;
    return null;
  },
  // strings
  _lower: (v: unknown): CellValue => {
    const s = asText(v);
    return s === null ? null : s.toLowerCase();
  },
  _upper: (v: unknown): CellValue => {
    const s = asText(v);
    return s === null ? null : s.toUpperCase();
  },
  _trim: (v: unknown): CellValue => {
    const s = asText(v);
    return s === null ? null : s.trim();
  },
  _len: (v: unknown): CellValue => {
    const s = asText(v);
    return s === null ? 0 : s.length;
  },
  _replace: (v: unknown, find: unknown, repl: unknown): CellValue => {
    const s = asText(v);
    if (s === null) return null;
    const f = find === null || find === undefined ? "" : String(find);
    const r = repl === null || repl === undefined ? "" : String(repl);
    return f === "" ? s : s.split(f).join(r);
  },
  _concat: (...args: unknown[]): CellValue =>
    args.map((a) => (a === null || a === undefined ? "" : String(a))).join(""),
  _str: (v: unknown): CellValue => asText(v),
  // dates — all via the timezone-free calendar parser.
  _to_us_date: (v: unknown): CellValue => {
    const d = parseYMD(v);
    return d ? fmtUS(d) : null;
  },
  _to_eu_date: (v: unknown): CellValue => {
    const d = parseYMD(v);
    return d ? fmtEU(d) : null;
  },
  _to_iso_date: (v: unknown): CellValue => {
    const d = parseYMD(v);
    return d ? fmtISO(d) : null;
  },
  _to_long_date: (v: unknown): CellValue => {
    const d = parseYMD(v);
    return d ? `${MONTHS[d.m - 1]} ${d.d}, ${d.y}` : null;
  },
  _year: (v: unknown): CellValue => parseYMD(v)?.y ?? null,
  _month: (v: unknown): CellValue => parseYMD(v)?.m ?? null,
  _day: (v: unknown): CellValue => parseYMD(v)?.d ?? null,
  _weekday: (v: unknown): CellValue => {
    const d = parseYMD(v);
    return d ? WEEKDAYS[new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay()] : null;
  },
};

// Validate a proposed column name. Returns null if OK, an error string otherwise.
export function validateColumnName(name: string, existing: string[]): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Name is required.";
  if (!VALID_NAME_RE.test(trimmed)) {
    return "Name must start with a letter or underscore and contain only letters, digits, or underscores.";
  }
  if (existing.includes(trimmed)) return `Column "${trimmed}" already exists.`;
  if (
    MATH_FUNCS.has(trimmed) ||
    HELPER_FUNCS.has(trimmed) ||
    AGG_FUNCS.has(trimmed) ||
    KEYWORDS.has(trimmed) ||
    SELF_REFS.has(trimmed)
  ) {
    return `"${trimmed}" is a reserved word.`;
  }
  return null;
}

// Convenience: try to compile + run on the first N rows to surface errors
// before applying to the whole dataset.
export function previewFormula(
  formula: string,
  columns: string[],
  rows: Row[],
  sampleSize = 5,
  opts: CompileOpts = {},
): { samples: CellValue[]; error?: string; referencedColumns: string[] } {
  try {
    const compiled = compileFormula(formula, columns, { rows, ...opts });
    const samples = rows.slice(0, sampleSize).map((r) => compiled.evaluate(r));
    return { samples, referencedColumns: compiled.referencedColumns };
  } catch (e) {
    return {
      samples: [],
      error: e instanceof Error ? e.message : String(e),
      referencedColumns: [],
    };
  }
}
