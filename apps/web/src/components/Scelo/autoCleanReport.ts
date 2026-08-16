// Chat write-up for an autonomous clean, and the audit that keeps it honest.
//
// Pure text assembly over an `AutoCleanResult` — no React, so the wording the
// user reads is directly testable. It lived in SoftDataWorkstation.tsx, which
// is where the bug it exists to fix was written.

import type { ColumnMeta } from "@scelo/core";
import {
  AUTO_CLEAN_MAX_PASSES,
  type AutoCleanResult,
  type CleaningOp,
  type CleaningOpKey,
  capDecision,
  describeOp,
  imputeDecision,
} from "./cleaning";

// ── Auditing the clean against what was actually asked ──────────────────────
//
// The chat router recognises an autonomous-clean request from a couple of
// phrases ("clean the entire dataset"). That means an instruction as specific
// as "impute missing values, handle outliers, make formatting consistent" is
// matched on three of its words and the rest of the sentence reaches nothing
// — and the report then signed off with "the dataset is clean", which was
// true in the engine's own terms and false against the request. Every ask the
// user spells out is checked against the FINISHED dataset here, and anything
// still outstanding is named together with the reason the engine itself used
// to leave it alone (`imputeDecision` / `capDecision`, so the explanation
// can't drift from the behaviour).
type RequestCheck = {
  label: string;
  test: RegExp;
  /** Ops that answer this ask. */
  keys: CleaningOpKey[];
  /** What the finished dataset still has outstanding — only meaningful for
   *  asks with a residual form. "Formatting" has none: there is no such
   *  thing as a column that is still unformatted. */
  residual?: (metas: ColumnMeta[]) => Array<{ column: string; detail: string }>;
};

const REQUEST_CHECKS: RequestCheck[] = [
  {
    label: "Impute missing values",
    test: /\b(imput\w*|fill(ing)?\s+(in\s+)?(the\s+)?(missing|nulls?|blanks?|gaps?)|missing values?)\b/,
    keys: ["impute-missing"],
    residual: (metas) =>
      metas
        .filter((m) => m.missing > 0)
        .map((m) => {
          const d = imputeDecision(m);
          return {
            column: m.name,
            detail: `${m.missing.toLocaleString()} still empty — ${
              d.kind === "skip" ? d.reason : "queued for a further pass"
            }`,
          };
        }),
  },
  {
    label: "Handle outliers",
    test: /\b(outlier\w*|winsor\w+|extreme values?|fat tails?|cap(ping)? the tails?)\b/,
    keys: ["cap-outliers", "replace-numeric-sentinels"],
    residual: (metas) =>
      metas
        .filter((m) => (m.outlierCount ?? 0) > 0)
        .map((m) => {
          const d = capDecision(m);
          return {
            column: m.name,
            detail: `${(m.outlierCount ?? 0).toLocaleString()} beyond the fences — ${
              d.kind === "skip" ? d.reason : "queued for a further pass"
            }`,
          };
        }),
  },
  {
    label: "Make formatting consistent",
    test: /\b(format\w*|consistent\w*|consistency|standardi[sz]\w+|normali[sz]\w+|uniform)\b/,
    keys: [
      "trim",
      "collapse-whitespace",
      "fix-encoding",
      "missing-tokens",
      "parse-numeric",
      "coerce-numeric",
      "parse-dates",
      "standardise-booleans",
      "lowercase-categoricals",
      "recode-value",
      "rename-snake-case",
    ],
  },
  {
    label: "Remove duplicate rows",
    test: /\b(duplicate\w*|dedup\w*|de-duplicat\w+)\b/,
    keys: ["drop-duplicates"],
  },
];

// Counts read better than op titles for the two learned ops — "12,480 cells
// filled" is the thing the user wants to check, where "impute missing values
// in 2 columns" just repeats the request back at them.
function summariseOps(ops: CleaningOp[]): string {
  let filled = 0;
  let capped = 0;
  const other: string[] = [];
  for (const op of ops) {
    if (op.key === "impute-missing") filled += op.cells;
    else if (op.key === "cap-outliers") capped += op.cells;
    else other.push(describeOp(op).title);
  }
  const parts: string[] = [];
  if (filled > 0) parts.push(`${Math.round(filled).toLocaleString()} cells filled`);
  if (capped > 0) {
    parts.push(`${Math.round(capped).toLocaleString()} values clamped to the Tukey fences`);
  }
  if (other.length > 0) parts.push([...new Set(other)].join(", "));
  return parts.join("; ");
}

export function auditRequest(
  request: string,
  ops: CleaningOp[],
  metas: ColumnMeta[],
): { lines: string[]; outstanding: boolean } {
  const t = request.toLowerCase();
  const asked = REQUEST_CHECKS.filter((c) => c.test.test(t));
  if (asked.length === 0) return { lines: [], outstanding: false };

  const lines = ["**Against your request**"];
  let outstanding = false;
  for (const check of asked) {
    const hits = ops.filter((o) => check.keys.includes(o.key));
    const left = check.residual ? check.residual(metas) : [];
    if (left.length === 0) {
      lines.push(
        hits.length > 0
          ? `- ${check.label} — done: ${summariseOps(hits)}.`
          : `- ${check.label} — nothing in the dataset needed it.`,
      );
      continue;
    }
    outstanding = true;
    const shown = left
      .slice(0, 4)
      .map((o) => `\`${o.column}\` (${o.detail})`)
      .join("; ");
    const more = left.length > 4 ? `; +${left.length - 4} more` : "";
    lines.push(
      hits.length > 0
        ? `- ${check.label} — partly done: ${summariseOps(hits)}. Still outstanding: ${shown}${more}.`
        : `- ${check.label} — **not done**: ${shown}${more}.`,
    );
  }
  return { lines, outstanding };
}

// Chat write-up for an autonomous clean. Reports pass by pass, because the
// whole point of the multi-pass loop is that later passes fix things the
// earlier ones exposed — collapsing it to one flat list would hide that. Row
// and column drops are called out separately: they're the destructive part,
// and the user needs to see them without reading the step list. `request` is
// the user's own words when the clean came from chat (the chip has none), and
// drives the audit above.
export function formatAutoCleanReport(
  result: AutoCleanResult,
  request: string | undefined,
  finalMetas: ColumnMeta[],
): string {
  const lines: string[] = [];
  const stepCount = result.passes.reduce((n, p) => n + p.opLabels.length, 0);
  const audit = request
    ? auditRequest(
        request,
        result.passes.flatMap((p) => p.ops),
        finalMetas,
      )
    : { lines: [], outstanding: false };

  lines.push(
    `Went through the entire dataset and cleaned it — ${stepCount} step${
      stepCount === 1 ? "" : "s"
    } over ${result.passes.length} pass${result.passes.length === 1 ? "" : "es"}.`,
  );
  lines.push("");
  for (const pass of result.passes) {
    lines.push(`**Pass ${pass.pass}**`);
    for (const label of pass.opLabels) lines.push(`- ${label}`);
    lines.push("");
  }

  const rowsDropped = result.rowsBefore - result.rowsAfter;
  const shape: string[] = [];
  if (rowsDropped > 0) {
    shape.push(
      `${rowsDropped.toLocaleString()} row${rowsDropped === 1 ? "" : "s"} removed (duplicates), ${result.rowsAfter.toLocaleString()} remain`,
    );
  }
  if (result.droppedColumns.length > 0) {
    shape.push(
      `${result.droppedColumns.length} column${
        result.droppedColumns.length === 1 ? "" : "s"
      } dropped as empty or single-valued (${result.droppedColumns.map((c) => `\`${c}\``).join(", ")})`,
    );
  }
  if (shape.length > 0) lines.push(`Shape: ${shape.join("; ")}.`, "");

  switch (result.outcome) {
    case "clean":
      lines.push(
        audit.outstanding
          ? "I re-scanned after the last pass and my cleaning rules found nothing further to do. That is not the same as your whole request being met — see below."
          : "I re-scanned after the last pass and found nothing further — the dataset is clean.",
      );
      break;
    case "stalled":
      lines.push(
        `I stopped early: the last pass detected the same issues again without resolving them, so repeating it wouldn't help. Still outstanding: ${result.remaining.join(", ")}. These need a decision rather than a rule — tell me how you'd like them handled.`,
      );
      break;
    case "exhausted":
      lines.push(
        `I hit the ${AUTO_CLEAN_MAX_PASSES}-pass ceiling with work still outstanding: ${result.remaining.join(", ")}. Press it again to keep going.`,
      );
      break;
    default:
      break;
  }
  if (audit.lines.length > 0) lines.push("", ...audit.lines);
  return lines.join("\n");
}
