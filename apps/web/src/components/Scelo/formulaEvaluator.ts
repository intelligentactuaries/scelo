// Tiny safe(-ish) formula evaluator for Soft Data derived columns.
//
// Why not just `new Function(formula)` directly:
//   - The user-typed formula gets run against every row in their dataset,
//     so even a "local-only" eval surface is worth guarding. A typo or
//     paste of unexpected text shouldn't reach `fetch`, `document`, or
//     `window`.
//   - We need a deterministic, explainable error when an identifier doesn't
//     match a real column ("unknown column `paud`" — not a JS ReferenceError).
//
// The approach is a one-pass tokenizer plus a strict identifier whitelist.
// Allowed identifiers fall into three buckets:
//   1. Column names (exact match against the dataset's columns)
//   2. A short list of math helpers (`log`, `exp`, `sqrt`, ...)
//   3. Keywords (`true`, `false`, `null`, `if`, `isnull`, `coalesce`)
// Anything else is rejected before the JS engine ever sees it.
//
// Column references compile to `r[<name>] ?? 0` so missing-cell rows
// produce a sane 0 rather than a NaN that propagates everywhere.

import type { CellValue, Row } from "./SoftDataWorkstation";

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

const KEYWORDS = new Set(["true", "false", "null"]);
const HELPER_FUNCS = new Set(["if", "isnull", "coalesce"]);

const VALID_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Token =
  | { kind: "num"; value: string }
  | { kind: "id"; value: string }
  | { kind: "op"; value: string }
  | { kind: "lparen"; value: "(" }
  | { kind: "rparen"; value: ")" }
  | { kind: "comma"; value: "," };

function tokenize(src: string): Token[] {
  // Pre-pass tolerance for LLM-emitted JS-isms that the strict grammar
  // would otherwise reject. The canonical formula is `round(paid)` but
  // language models trained on JavaScript reliably emit either:
  //   - `Math.round(paid)` — drop the `Math.` prefix, the compiler emits
  //     `Math.round` anyway when round is a recognised math func.
  //   - `round(\`paid\`)` — strip backticks from identifier wraps; bare
  //     identifiers are what the tokenizer accepts.
  // Both rewrites are no-ops on already-canonical formulas.
  const cleaned = src.replace(/\bMath\./g, "").replace(/`([A-Za-z_][A-Za-z0-9_]*)`/g, "$1");
  const toks: Token[] = [];
  let i = 0;
  while (i < cleaned.length) {
    const c = cleaned[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // Numbers: integer / float / scientific. Allow leading dot.
    if (/\d/.test(c) || (c === "." && /\d/.test(cleaned[i + 1] ?? ""))) {
      let j = i;
      // basic numeric scan — handles 1, 1.5, 1e3, 1.5e-3
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
    // Two-char operators take priority over single-char.
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

export type CompiledFormula = {
  evaluate: (row: Row) => CellValue;
  referencedColumns: string[];
};

export function compileFormula(formula: string, columns: string[]): CompiledFormula {
  const trimmed = formula.trim();
  if (trimmed === "") throw new Error("Formula is empty.");

  const colSet = new Set(columns);
  const tokens = tokenize(trimmed);
  const referenced = new Set<string>();

  // Whitelist pass — every identifier must be one of: column, math fn,
  // helper fn, or keyword. Anything else hard-fails BEFORE we feed
  // anything to `new Function`.
  for (const t of tokens) {
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

  // Compile to a JS expression. Column refs become `r[<name>]`, math
  // functions become `Math.<name>`, helpers become local function refs.
  const parts: string[] = [];
  for (const t of tokens) {
    if (t.kind === "id") {
      if (colSet.has(t.value)) {
        // `?? 0` so missing values default to zero — feels more useful
        // than NaN propagation for everyday actuarial sums / ratios.
        parts.push(`(r[${JSON.stringify(t.value)}] ?? 0)`);
      } else if (MATH_FUNCS.has(t.value)) {
        parts.push(`Math.${t.value}`);
      } else if (HELPER_FUNCS.has(t.value)) {
        parts.push(`_${t.value}`);
      } else {
        // Must be a keyword — emit verbatim.
        parts.push(t.value);
      }
    } else {
      parts.push(t.value);
    }
  }
  const body = `return (${parts.join(" ")});`;

  let fn: (...args: unknown[]) => unknown;
  try {
    fn = new Function("r", "_if", "_isnull", "_coalesce", body) as (...args: unknown[]) => unknown;
  } catch (e) {
    throw new Error(`Could not compile formula: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Helpers — defined here so they close over consistent semantics.
  const _if = (cond: unknown, a: unknown, b: unknown): unknown => (cond ? a : b);
  const _isnull = (v: unknown): boolean =>
    v === null || v === undefined || v === "" || (typeof v === "number" && !Number.isFinite(v));
  const _coalesce = (...args: unknown[]): unknown => {
    for (const a of args) if (!_isnull(a)) return a;
    return null;
  };

  const evaluate = (row: Row): CellValue => {
    try {
      const v = fn(row, _if, _isnull, _coalesce);
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

// Validate a proposed column name. Returns null if OK, an error string otherwise.
export function validateColumnName(name: string, existing: string[]): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Name is required.";
  if (!VALID_NAME_RE.test(trimmed)) {
    return "Name must start with a letter or underscore and contain only letters, digits, or underscores.";
  }
  if (existing.includes(trimmed)) return `Column "${trimmed}" already exists.`;
  if (MATH_FUNCS.has(trimmed) || HELPER_FUNCS.has(trimmed) || KEYWORDS.has(trimmed)) {
    return `"${trimmed}" is a reserved word.`;
  }
  return null;
}

// Convenience: try to compile + run on the first N rows to surface errors
// before applying to the whole dataset. Returns either a sample of values
// or a thrown error caught and stringified.
export function previewFormula(
  formula: string,
  columns: string[],
  rows: Row[],
  sampleSize = 5,
): { samples: CellValue[]; error?: string; referencedColumns: string[] } {
  try {
    const compiled = compileFormula(formula, columns);
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
