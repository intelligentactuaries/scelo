// Chat-embedded column actions.
//
// Two fenced block types execute against the active dataset when they
// land in a chat reply:
//
//   ```derive
//   {"name": "paid_rounded", "formula": "round(paid)"}
//   ```
//   Creates a NEW column from the formula. Used for log / sqrt / bin /
//   any case where the original values should be preserved alongside.
//
//   ```transform
//   {"column": "paid", "formula": "round(paid)"}
//   ```
//   Replaces the values in an EXISTING column. Used when the user asks
//   to "round this column" / "log this column" / "clip this column" in
//   the per-column chat popover, which is scoped to that column and
//   semantically means "mutate it in place".
//
// Both are idempotent: derive on a name that already exists is a no-op,
// transform is keyed by (column + formula) fingerprint stored on context
// so re-rendering an old chat reply doesn't re-apply the action.
//
// After applying, each card renders a deterministic summary computed
// from the actual before/after values (cells changed, mean / min / max
// delta, sample of old → new pairs). This summary is the source of
// truth — the LLM's accompanying sentence is interpretive context.

import { useEffect, useMemo, useState } from "react";

import { type CellValue, type Row, formatNumber } from "./SoftDataWorkstation";
import { compileFormula, validateColumnName } from "./formulaEvaluator";
import { useScelo } from "./sceloContext";

// ─── shared parsing ─────────────────────────────────────────────────────────

type DeriveSpec = {
  name: string;
  formula: string;
  note?: string;
};

type TransformSpec = {
  column: string;
  formula: string;
  note?: string;
};

// Extract the first balanced JSON object from a string, ignoring any
// prose / commentary the LLM appended after it.
function extractFirstJsonObject(s: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        return s.slice(start, i + 1);
      }
    }
  }
  return null;
}

// Tolerate the formula-field aliases gpt-oss reliably swaps in.
function pickFormulaField(obj: Record<string, unknown>): string {
  if (typeof obj.formula === "string") return obj.formula;
  if (typeof obj.expression === "string") return obj.expression;
  if (typeof obj.expr === "string") return obj.expr;
  if (typeof obj.code === "string") return obj.code;
  return "";
}

function stripAssignmentPrefix(formula: string): string {
  return formula.replace(/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*/, "");
}

function safeParseDerive(raw: string): DeriveSpec | { error: string } {
  const json = extractFirstJsonObject(raw) ?? raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Invalid JSON" };
  }
  if (!parsed || typeof parsed !== "object") return { error: "Spec must be an object." };
  const obj = parsed as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  const formulaRaw = pickFormulaField(obj);
  if (!name) return { error: "Missing `name`." };
  if (!formulaRaw) return { error: "Missing `formula`." };
  return {
    name,
    formula: stripAssignmentPrefix(formulaRaw),
    note: typeof obj.note === "string" ? obj.note : undefined,
  };
}

function safeParseTransform(raw: string): TransformSpec | { error: string } {
  const json = extractFirstJsonObject(raw) ?? raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Invalid JSON" };
  }
  if (!parsed || typeof parsed !== "object") return { error: "Spec must be an object." };
  const obj = parsed as Record<string, unknown>;
  const column = typeof obj.column === "string" ? obj.column.trim() : "";
  const formulaRaw = pickFormulaField(obj);
  if (!column) return { error: "Missing `column`." };
  if (!formulaRaw) return { error: "Missing `formula`." };
  return {
    column,
    formula: stripAssignmentPrefix(formulaRaw),
    note: typeof obj.note === "string" ? obj.note : undefined,
  };
}

// ─── summary builder ────────────────────────────────────────────────────────

function fmtCell(v: CellValue): string {
  if (v === null) return "—";
  if (typeof v === "number") return formatNumber(v);
  const s = String(v);
  return s.length > 18 ? `${s.slice(0, 17)}…` : s;
}

function numericSummary(values: CellValue[]): { mean: number; min: number; max: number } | null {
  let sum = 0;
  let count = 0;
  let mn = Number.POSITIVE_INFINITY;
  let mx = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    sum += v;
    count++;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (count === 0) return null;
  return { mean: sum / count, min: mn, max: mx };
}

type ChangeSummary = {
  total: number;
  changed: number;
  added: number;
  becameNull: number;
  beforeStats: ReturnType<typeof numericSummary>;
  afterStats: ReturnType<typeof numericSummary>;
  // Up to four "old → new" pairs, sampled from rows where the value
  // actually changed. Picked from evenly-spaced row indices so the
  // sample isn't biased to the top of the file.
  pairs: Array<{ old: CellValue; next: CellValue }>;
};

// Walks both arrays in one pass to keep this cheap on multi-million-row
// datasets. `before` is the snapshot, `after` is the post-application
// row list; both indexed by row order, both keyed by the same column.
function buildChangeSummary(
  before: CellValue[],
  after: CellValue[],
  options: { isNew?: boolean } = {},
): ChangeSummary {
  const total = after.length;
  let changed = 0;
  let added = 0;
  let becameNull = 0;
  const changedIndices: number[] = [];
  for (let i = 0; i < total; i++) {
    const a = before[i];
    const b = after[i];
    const isNew = options.isNew === true || a === undefined;
    if (isNew) {
      if (b !== null && b !== undefined) added++;
      continue;
    }
    if (a !== b) {
      changed++;
      if (changedIndices.length < 64) changedIndices.push(i);
      if (b === null) becameNull++;
    }
  }
  // Sample evenly from the captured change indices so the preview pairs
  // span the dataset, not just the first few rows.
  const sampleN = Math.min(4, changedIndices.length);
  const pairs: ChangeSummary["pairs"] = [];
  if (sampleN > 0) {
    const step = Math.max(1, Math.floor(changedIndices.length / sampleN));
    for (let k = 0; k < changedIndices.length && pairs.length < sampleN; k += step) {
      const idx = changedIndices[k];
      pairs.push({ old: before[idx] ?? null, next: after[idx] });
    }
  }
  return {
    total,
    changed,
    added,
    becameNull,
    beforeStats: numericSummary(before),
    afterStats: numericSummary(after),
    pairs,
  };
}

// Card subsection: a small "Summary" block under the title that
// translates the change-summary numbers into one or two readable lines.
// All copy is deterministic so it never depends on the LLM.
function SummaryBlock({
  summary,
  kind,
}: {
  summary: ChangeSummary;
  kind: "transform" | "derive";
}) {
  const lines: string[] = [];
  if (kind === "derive") {
    lines.push(
      `Computed ${summary.added.toLocaleString()} of ${summary.total.toLocaleString()} cells (the rest stayed null).`,
    );
  } else {
    const pct = summary.total > 0 ? (100 * summary.changed) / summary.total : 0;
    lines.push(
      `Updated ${summary.changed.toLocaleString()} of ${summary.total.toLocaleString()} cells (${pct.toFixed(0)}%) in place.`,
    );
    if (summary.becameNull > 0) {
      lines.push(`${summary.becameNull.toLocaleString()} cells became null after the operation.`);
    }
  }
  const a = summary.beforeStats;
  const b = summary.afterStats;
  if (a && b) {
    const meanShift = b.mean - a.mean;
    const rangeBefore = `[${formatNumber(a.min)}, ${formatNumber(a.max)}]`;
    const rangeAfter = `[${formatNumber(b.min)}, ${formatNumber(b.max)}]`;
    lines.push(
      `Mean: ${formatNumber(a.mean)} → ${formatNumber(b.mean)} (Δ ${meanShift >= 0 ? "+" : ""}${formatNumber(meanShift)}). Range: ${rangeBefore} → ${rangeAfter}.`,
    );
  } else if (b) {
    lines.push(
      `Mean: ${formatNumber(b.mean)}. Range: [${formatNumber(b.min)}, ${formatNumber(b.max)}].`,
    );
  }
  return (
    <div className="mt-2 space-y-0.5 break-words text-fg-mute">
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: deterministic copy, order is stable.
        <div key={i}>{line}</div>
      ))}
      {summary.pairs.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-fg-dim">
          <span>sample:</span>
          {summary.pairs.map((p, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable order.
            <span key={i} className="inline-flex items-center gap-1">
              <code className="break-all text-fg-mute">{fmtCell(p.old)}</code>
              <span>→</span>
              <code className="break-all text-fg">{fmtCell(p.next)}</code>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// Shared card chrome. `min-w-0` + `overflow-hidden` on the outer wrapper
// guarantee long formulas / values inside a flex parent (the column
// popover, the stage chat panel) can't push past the popover edge.
// `break-words` / `break-all` on the leaf code elements does the actual
// wrapping.
function CardShell({
  tone,
  children,
}: {
  tone: "ok" | "neutral" | "error";
  children: React.ReactNode;
}) {
  const toneClass =
    tone === "ok"
      ? "border-primary/40 bg-primary/5 text-fg"
      : tone === "error"
        ? "border-error/40 bg-error/5 text-error"
        : "border-border bg-bg-1 text-fg-mute";
  return (
    <div
      className={`my-2 min-w-0 overflow-hidden rounded border ${toneClass} px-3 py-2 font-mono text-[11px] leading-snug`}
    >
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

// ─── ChatDerive ─────────────────────────────────────────────────────────────

type DeriveOutcome =
  | { kind: "ok"; column: string; summary: ChangeSummary }
  | { kind: "exists"; column: string }
  | { kind: "error"; message: string }
  | { kind: "pending" };

export function ChatDerive({ raw }: { raw: string }) {
  const parsed = useMemo(() => safeParseDerive(raw), [raw]);
  const { dataset, setDataset, derivedColumns, setDerivedColumns, logEvent } = useScelo();
  const [outcome, setOutcome] = useState<DeriveOutcome>({ kind: "pending" });

  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-run on spec / dataset identity changes.
  useEffect(() => {
    if ("error" in parsed) {
      setOutcome({ kind: "error", message: parsed.error });
      return;
    }
    const spec = parsed;
    if (!dataset) {
      setOutcome({ kind: "pending" });
      return;
    }
    if (dataset.columns.includes(spec.name)) {
      setOutcome({ kind: "exists", column: spec.name });
      return;
    }
    const nameError = validateColumnName(spec.name, dataset.columns);
    if (nameError) {
      setOutcome({ kind: "error", message: nameError });
      return;
    }
    let compiled: ReturnType<typeof compileFormula>;
    try {
      // rows → column aggregates (mean/colsum/...) fold to a constant.
      compiled = compileFormula(spec.formula, dataset.columns, { rows: dataset.rows });
    } catch (e) {
      setOutcome({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      return;
    }
    const newValues: CellValue[] = dataset.rows.map((r) => compiled.evaluate(r));
    const newRows: Row[] = dataset.rows.map((r, i) => ({ ...r, [spec.name]: newValues[i] }));
    setDataset({
      name: dataset.name,
      columns: [...dataset.columns, spec.name],
      rows: newRows,
    });
    setDerivedColumns((prev) => ({ ...prev, [spec.name]: spec.formula }));
    logEvent({
      stage: "soft",
      kind: "derived.add",
      payload: { name: spec.name, formula: spec.formula },
    });
    const summary = buildChangeSummary([], newValues, { isNew: true });
    setOutcome({ kind: "ok", column: spec.name, summary });
  }, [raw, dataset?.columns, dataset?.rows.length]);

  const spec = "error" in parsed ? null : parsed;
  const formula = spec?.formula ?? "";
  const note = spec?.note;

  if (outcome.kind === "pending") {
    return <CardShell tone="neutral">load a dataset to apply this derived column…</CardShell>;
  }
  if (outcome.kind === "error") {
    return (
      <CardShell tone="error">
        could not apply derived column: {outcome.message}
        {formula && (
          <div className="mt-1 break-words text-fg-mute">
            <span className="text-fg-dim">formula:</span>{" "}
            <code className="break-all">{formula}</code>
          </div>
        )}
      </CardShell>
    );
  }
  if (outcome.kind === "exists") {
    return (
      <CardShell tone="ok">
        <span className="text-primary">✓</span>{" "}
        <code className="break-all text-fg">{outcome.column}</code>{" "}
        <span className="text-primary">already in the columns list</span>
        {derivedColumns[outcome.column] && (
          <span className="text-fg-mute">
            {" "}
            · <code className="break-all">{derivedColumns[outcome.column]}</code>
          </span>
        )}
        .
      </CardShell>
    );
  }
  return (
    <CardShell tone="ok">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-primary">✓ added column</span>
        <code className="break-all text-fg">{outcome.column}</code>
      </div>
      <div className="mt-0.5 break-words text-fg-mute">
        <span className="text-fg-dim">= </span>
        <code className="break-all text-fg-mute">{formula}</code>
      </div>
      <SummaryBlock summary={outcome.summary} kind="derive" />
      {note && <div className="mt-1 break-words text-fg-mute">{note}</div>}
    </CardShell>
  );
}

// ─── ChatTransform ──────────────────────────────────────────────────────────

type TransformOutcome =
  | { kind: "ok"; column: string; summary: ChangeSummary }
  | { kind: "applied"; column: string }
  | { kind: "error"; message: string }
  | { kind: "pending" };

export function ChatTransform({ raw }: { raw: string }) {
  const parsed = useMemo(() => safeParseTransform(raw), [raw]);
  const { dataset, setDataset, transformLog, setTransformLog, logEvent } = useScelo();
  const [outcome, setOutcome] = useState<TransformOutcome>({ kind: "pending" });
  const fingerprint = "error" in parsed ? "" : `${parsed.column}::${parsed.formula}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-run on spec / dataset / log changes.
  useEffect(() => {
    if ("error" in parsed) {
      setOutcome({ kind: "error", message: parsed.error });
      return;
    }
    const spec = parsed;
    if (!dataset) {
      setOutcome({ kind: "pending" });
      return;
    }
    if (!dataset.columns.includes(spec.column)) {
      setOutcome({ kind: "error", message: `Column "${spec.column}" is not in the dataset.` });
      return;
    }
    if (transformLog.has(fingerprint)) {
      setOutcome({ kind: "applied", column: spec.column });
      return;
    }
    let compiled: ReturnType<typeof compileFormula>;
    try {
      // rows → aggregates; selfColumn lets the formula use `value` for this column.
      compiled = compileFormula(spec.formula, dataset.columns, {
        rows: dataset.rows,
        selfColumn: spec.column,
      });
    } catch (e) {
      setOutcome({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      return;
    }
    const before: CellValue[] = dataset.rows.map((r) => r[spec.column] as CellValue);
    const after: CellValue[] = dataset.rows.map((r) => compiled.evaluate(r));
    const newRows: Row[] = dataset.rows.map((r, i) => ({ ...r, [spec.column]: after[i] }));
    setDataset({
      name: dataset.name,
      columns: dataset.columns,
      rows: newRows,
    });
    setTransformLog((prev) => {
      const next = new Set(prev);
      next.add(fingerprint);
      return next;
    });
    logEvent({
      stage: "soft",
      kind: "derived.add",
      payload: { name: spec.column, formula: `${spec.column} = ${spec.formula}` },
    });
    const summary = buildChangeSummary(before, after);
    setOutcome({ kind: "ok", column: spec.column, summary });
  }, [fingerprint, dataset?.columns, dataset?.rows.length, transformLog]);

  const spec = "error" in parsed ? null : parsed;
  const formula = spec?.formula ?? "";
  const note = spec?.note;

  if (outcome.kind === "pending") {
    return <CardShell tone="neutral">load a dataset to transform this column…</CardShell>;
  }
  if (outcome.kind === "error") {
    return (
      <CardShell tone="error">
        could not transform column: {outcome.message}
        {formula && (
          <div className="mt-1 break-words text-fg-mute">
            <span className="text-fg-dim">formula:</span>{" "}
            <code className="break-all">{formula}</code>
          </div>
        )}
      </CardShell>
    );
  }
  if (outcome.kind === "applied") {
    return (
      <CardShell tone="ok">
        <span className="text-primary">✓</span> already transformed{" "}
        <code className="break-all text-fg">{outcome.column}</code> with{" "}
        <code className="break-all text-fg-mute">{formula}</code>.
      </CardShell>
    );
  }
  return (
    <CardShell tone="ok">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-primary">✓ transformed</span>
        <code className="break-all text-fg">{outcome.column}</code>
        <span className="text-fg-dim">in place</span>
      </div>
      <div className="mt-0.5 break-words text-fg-mute">
        <span className="text-fg-dim">{outcome.column} = </span>
        <code className="break-all text-fg-mute">{formula}</code>
      </div>
      <SummaryBlock summary={outcome.summary} kind="transform" />
      {note && <div className="mt-1 break-words text-fg-mute">{note}</div>}
    </CardShell>
  );
}
