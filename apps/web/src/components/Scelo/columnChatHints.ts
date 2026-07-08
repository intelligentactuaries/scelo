// Per-column chat placeholder + system-prompt helpers.
//
// Each Soft Data column gets its own scoped chatbot. The placeholder text
// (the faint hint inside the input) is the first thing the user sees, so
// it doubles as a "things you can ask for here" prompt — different defaults
// per column shape so it surfaces the action that's most likely to be
// useful for THIS column rather than a generic "ask anything".

import type { ColumnMeta } from "./SoftDataWorkstation";
import { findNearDuplicateLabel } from "./cleaning";

// Pick a single, focused placeholder for the input. Heuristics ordered so
// the most diagnostic shape wins — e.g. "almost all missing" beats "numeric".
export function placeholderHintFor(meta: ColumnMeta): string {
  const missingPct = meta.count > 0 ? meta.missing / meta.count : 0;
  const uniquePct = meta.count > 0 ? meta.unique / (meta.count - meta.missing || 1) : 0;

  if (missingPct > 0.5) {
    return "almost all missing — drop the column, or impute from another?";
  }
  if (uniquePct > 0.95 && meta.type === "string") {
    return "looks like an id — drop, hash, or keep as a group key?";
  }
  if (meta.type === "number") {
    if (meta.outliers && meta.outliers.length > 0) {
      return `cap ${meta.outliers.length} outliers, log-transform, or bin into quantiles?`;
    }
    return "round, clip, log, or normalise this column?";
  }
  if (meta.type === "date") {
    return "extract year/month, compute age from today, or bin by quarter?";
  }
  // string / categorical
  if (meta.topValues && meta.topValues.length > 0) {
    const dupe = findNearDuplicateLabel(meta.topValues, meta.count - meta.missing);
    if (dupe) {
      return `fix the near-duplicate "${dupe.from}" → "${dupe.to}", or merge sparse labels?`;
    }
    const top = meta.topValues[0];
    if (meta.unique <= 12) {
      return `one-hot encode, ordinal-rank, or merge "${top.value}" with others?`;
    }
    return "trim whitespace, lowercase, regex-clean, or split into parts?";
  }
  return "clean, convert, split, or derive from this column…";
}

// Compact textual summary of the column for the agent's system prompt.
// We feed type, count, missing %, unique count, and a few key statistics —
// enough that the model can suggest something concrete without having to
// ask "what's in this column?" first.
export function summariseColumnForPrompt(meta: ColumnMeta): string {
  const lines: string[] = [];
  lines.push(`Column: \`${meta.name}\` (${meta.type})`);
  const missingPct = meta.count > 0 ? (100 * meta.missing) / meta.count : 0;
  lines.push(
    `Rows: ${meta.count}, missing: ${meta.missing} (${missingPct.toFixed(1)}%), unique: ${meta.unique}.`,
  );
  if (meta.type === "number") {
    const parts: string[] = [];
    if (meta.min !== undefined) parts.push(`min=${meta.min}`);
    if (meta.q1 !== undefined) parts.push(`Q1=${meta.q1}`);
    if (meta.median !== undefined) parts.push(`median=${meta.median}`);
    if (meta.q3 !== undefined) parts.push(`Q3=${meta.q3}`);
    if (meta.max !== undefined) parts.push(`max=${meta.max}`);
    if (meta.mean !== undefined) parts.push(`mean=${meta.mean}`);
    if (meta.outliers) parts.push(`outliers=${meta.outliers.length}`);
    if (parts.length > 0) lines.push(`Stats: ${parts.join(", ")}.`);
  } else if (meta.topValues && meta.topValues.length > 0) {
    const sample = meta.topValues
      .slice(0, 8)
      .map((v) => `${v.value}=${v.count}`)
      .join(", ");
    lines.push(`Top values: ${sample}.`);
  }
  return lines.join("\n");
}

// Per-type cleaning playbook. Each branch is a checklist the agent runs
// down before answering, so suggestions are concrete and grounded in the
// traditional column-by-column cleaning canon (Wickham / Hadley / pandas
// idiom) rather than vague "you might want to clean this column" advice.
// The strings stay short on purpose: the model reads them as a rubric,
// not as prose to recite back.
function playbookFor(meta: ColumnMeta): string[] {
  const playbook: string[] = [];
  const missingPct = meta.count > 0 ? meta.missing / meta.count : 0;
  const uniqueRatio = meta.count - meta.missing > 0 ? meta.unique / (meta.count - meta.missing) : 0;

  // Universal checks that apply to any column.
  playbook.push(
    "MISSINGNESS POLICY: quantify it (% missing), decide drop-column vs drop-row vs impute. If missingness might itself be informative (e.g. claim_paid=null means denied), suggest adding a `was_missing_<col>` indicator before imputing. Impute on TRAIN ONLY: mean / median / mode / constant / forward-fill / interpolation / KNN / model-based. Never fit imputation on the full dataset.",
  );
  if (missingPct > 0.5) {
    playbook.push(
      `HIGH MISSINGNESS: ${(missingPct * 100).toFixed(1)}% of rows are null. Default recommendation: drop the column unless the user can name a reason to keep it (informative missingness, identifier, downstream model that handles nulls natively).`,
    );
  }

  if (meta.type === "string") {
    playbook.push(
      "STRING / CATEGORICAL CLEANING ORDER (apply in this sequence): (1) fix encoding artefacts (mojibake from UTF-8↔Latin-1 misdecode, stray BOM / NBSP / zero-width / soft hyphen). (2) trim leading/trailing whitespace. (3) collapse internal whitespace runs to single space. (4) normalise case (lower for free-text, Title for proper-noun categoricals, UPPER for codes/ISO). (5) normalise punctuation (curly → straight quotes, em/en-dash policy, strip stray punctuation around values). (6) map sentinel strings to null (N/A, -, ?, null, none, '', TBD, missing). (7) standardise inconsistent labels (USA / U.S.A. / United States → one form). (8) fix typos / synonyms (rapidfuzz / fuzzy matching once you've already lowercased + trimmed). (9) trim or split compound fields ('City, State' → two columns; addresses → street/city/postcode). (10) regex extraction / cleanup for embedded structure. (11) validate against an allowed-categories set: flag or null unknowns rather than letting them propagate.",
    );
    if (uniqueRatio > 0.95 && meta.unique > 20) {
      playbook.push(
        "HIGH-CARDINALITY: nearly every value is unique. Treat as an identifier / free-text field, not a categorical. Options: drop, hash, keep as a group key, extract a stable feature (regex pull a prefix / domain / country code).",
      );
    }
    if (meta.topValues && meta.unique <= 12) {
      playbook.push(
        "LOW-CARDINALITY CATEGORICAL: candidates for one-hot / ordinal / target encoding. The vocabulary is FIT ON TRAIN — unseen categories at test time should hit a deterministic 'other' bucket rather than crash the encoder.",
      );
    }
  }

  if (meta.type === "number") {
    playbook.push(
      "NUMERIC CLEANING ORDER: (1) if the source was text, strip non-numeric characters first ($, ,, %, units, currency codes, accounting parens, Unicode minus) before coercing. (2) coerce to a proper numeric dtype (Int / Float / Decimal as appropriate). (3) replace sentinel numerics with null (-999, -9999, 9999, -8888, sometimes -1 or 0 — only when context says so). (4) enforce valid ranges (negative ages, ages > 120, negative prices, percentages outside [0, 100]) — pick null vs clip based on whether the value is a data-entry error or signal. (5) clip / winsorize extreme outliers ONLY if they are errors, not legitimate fat-tail signal; consider log / Box-Cox / Yeo-Johnson when distribution is skewed. (6) reconcile unit inconsistencies (cm vs m, kg vs lb, USD vs ZAR — usually a flag column or an exchange-rate join). (7) round to appropriate precision (avoid storing 14 decimals of float noise).",
    );
    if (meta.outliers && meta.outliers.length > 0) {
      playbook.push(
        `OUTLIERS DETECTED: ${meta.outliers.length} values sit outside Tukey fences (Q1 - 1.5·IQR, Q3 + 1.5·IQR). Decide: keep (real fat tail), cap at fence (winsorize), transform (log / sqrt), or null (data error). Fit any threshold on TRAIN only — never on the full dataset.`,
      );
    }
    if (meta.loFence !== undefined && meta.hiFence !== undefined && meta.hiFence <= meta.loFence) {
      playbook.push(
        "DEGENERATE IQR: Q1 equals Q3, so the Tukey fences coincide. DO NOT cap/winsorize at the fences — min(max(x, fence), fence) flattens the whole column to one constant. If the user asks to cap outliers, say the fences are degenerate and offer a percentile cap (e.g. 1st/99th) instead.",
      );
    }
  }

  if (meta.type === "date") {
    playbook.push(
      "DATETIME CLEANING ORDER: (1) parse to a proper datetime dtype (don't leave dates as strings — sorting and binning break otherwise). (2) reconcile mixed formats (DD/MM vs MM/DD is the classic silent corruption; pick a locale or use ISO 8601 end-to-end). (3) standardise timezone — pick UTC for storage, convert at the boundary. Naive vs aware should never mix in one column. (4) handle invalid dates: future birthdates, dates before a sensible minimum (1900? 1970?), Excel's 1900-02-29 ghost day. (5) derived columns are usually what you actually want: year, month, day-of-week, quarter, age-as-of-asof-date, days-since-event.",
    );
  }

  return playbook;
}

// Stage context (the agent's system frame). Scopes the conversation
// tightly to ONE column — the bot is told to suggest cleaning /
// manipulation / conversion / encoding operations only for that column,
// and to keep replies concrete (formula snippets, cleaning-banner steps).
//
// Tone is action-first. The playbook below is REFERENCE ONLY — the bot
// uses it to pick the right step, but doesn't recite it. When the user
// gives a direct action verb (round / lowercase / trim / drop) the
// answer is the formula or the banner op, full stop. The framework
// only appears when the user asks an open-ended question.
export function buildColumnStageContext(meta: ColumnMeta): string {
  const summary = summariseColumnForPrompt(meta);
  const playbook = playbookFor(meta);
  // The cap-at-fences example only makes sense when the fences exist and are
  // distinct — with a degenerate IQR (Q1 === Q3) loFence === hiFence, and
  // min(max(x, lo), hi) would flatten the whole column to one constant.
  const hasSpreadFences =
    meta.loFence !== undefined && meta.hiFence !== undefined && meta.hiFence > meta.loFence;
  const capExample = hasSpreadFences
    ? [
        "User: cap outliers at the fences",
        "Reply:",
        "```transform",
        `{"column": "${meta.name}", "formula": "min(max(${meta.name}, ${meta.loFence}), ${meta.hiFence})"}`,
        "```",
        "",
      ]
    : [];
  // Categorical typo repair gets its own block type — an exact value
  // rewrite, no formula grammar involved. Ground the example in a real
  // near-duplicate pair from this column's top values when one exists.
  const dupe =
    meta.type === "string" && meta.topValues
      ? findNearDuplicateLabel(meta.topValues, meta.count - meta.missing)
      : null;
  const recodeVocab =
    meta.type === "string"
      ? [
          `To fix a misspelled or near-duplicate category value in THIS column (e.g. "Seperated" alongside "Separated"), emit a fenced \`recode\` block. The client rewrites every exact match immediately:`,
          "",
          "```recode",
          `{"column": "${meta.name}", "from": "${dupe?.from ?? "<misspelled value>"}", "to": "${dupe?.to ?? "<canonical value>"}"}`,
          "```",
          "",
          "After the block, one short sentence on why the merge is right (same category, one spelling wrong). Do NOT use a transform or derive block for value recodes.",
          "",
        ]
      : [];
  return [
    `You are Scelo, scoped to the column "${meta.name}".`,
    "Your job is to help the user clean / convert / transform / derive from THIS column.",
    "",
    "## ANSWER SHAPE (read this first, follow it strictly)",
    "Reply in 1 to 3 short sentences plus a code block or banner-op pointer. Lead with the action, not with background. No preamble, no recap, no checklist unless the user explicitly asks for the full playbook.",
    "When the user names a direct action (round, lowercase, trim, drop, log, clip, impute, etc.), output ONE formula or ONE banner op and stop. Do not list alternatives. Do not mention train/test discipline, sanity checks, or playbook sections unless asked.",
    "When the user asks an open question ('what should I do?'), pick the single most useful next step based on the column stats below and propose it. Offer alternatives only if asked.",
    "",
    "## OUTPUT CHARACTERS (strict)",
    "Reply in plain ASCII punctuation only: straight apostrophes ('), straight double quotes (\"), plain hyphens (-), three dots (...). DO NOT emit smart curly quotes, em-dash, en-dash, ellipsis character, non-breaking space, or any other typographic Unicode. They render as replacement glyphs in this chat surface. When you need to quote an example value (a sentinel string like ?, N/A, or -), wrap it in backticks for code, never in curly quotes.",
    "",
    "## ACTION VOCABULARY (these are TOOLS, not text, pick ONE and emit it)",
    "",
    "This chatbot is scoped to the SINGLE column above. When the user asks for an in-place transformation of THIS column (round, log, sqrt, abs, clip, cap, normalise, scale, exp, sign, ceil, floor, etc.), DO NOT describe the formula and DO NOT add a new column. EMIT a fenced `transform` block. The client replaces the column's cell values immediately:",
    "",
    "```transform",
    `{"column": "${meta.name}", "formula": "<expression>"}`,
    "```",
    "",
    `Only emit a fenced \`derive\` block (which creates a NEW column) if the user explicitly asks to "add a new column", "create a column", "derive a column", "keep the original", or names a new target name. Format:`,
    "",
    "```derive",
    `{"name": "<new_snake_case_name>", "formula": "<expression>"}`,
    "```",
    "",
    `Grammar inside the formula (same for both block types). Reference THIS column as \`value\` (recommended), or by name — backtick it if it contains spaces, e.g. \`${meta.name}\`. Reference OTHER columns by bare name or backticks. DO NOT prefix functions with "Math.".`,
    "- arithmetic: + - * / % **",
    "- math: log log10 log2 exp sqrt abs min max floor ceil round pow sign sin cos tan",
    "- logic: if(cond, a, b), coalesce(a, b, ...), isnull(x), == != > >= < <= && ||",
    "- strings: lower(x) upper(x) trim(x) len(x) replace(x, 'find', 'repl') concat(a, b, ...) str(x)",
    "- dates (timezone-free): to_us_date(x) -> MM/DD/YYYY, to_iso_date(x) -> YYYY-MM-DD, to_eu_date(x) -> DD/MM/YYYY, to_long_date(x) -> 'January 5, 2024', year(x) month(x) day(x) weekday(x)",
    "- column aggregates (whole-column constants, the basis for imputation): mean(`col`) median(`col`) mode(`col`) colmin(`col`) colmax(`col`) colsum(`col`) colcount(`col`) stdev(`col`). An aggregate ALWAYS takes a column reference (backtick name or `value`), never a bare cell — e.g. impute a sentinel with `if(value == -999, mean(value), value)`.",
    "After the block, write EXACTLY ONE short professional sentence (max ~20 words) describing the analytic intent: WHY this transformation matters for downstream work. Do not restate the numbers (the card renders cell-count, mean shift, range, and old→new samples automatically). Talk about meaning: 'normalises skew so the column is closer to Gaussian for linear models', 'rounds to integer for cleaner reporting', 'caps the right tail so a single outlier stops dragging the mean'. Keep it under one line; no preamble, no follow-up question.",
    "",
    ...recodeVocab,
    "Dataset-wide cleaning steps (case folding, whitespace, encoding, missing markers, dtype coercion, sentinel numerics, duplicate ROWS, renaming headers, dropping empty/constant columns) run via a fenced `clean` block — it executes the deterministic cleaning engine immediately and renders a real before/after card. Emit it instead of describing the op:",
    "```clean",
    '{"ops": ["<op-key>"]}',
    "```",
    'Valid op keys: trim, collapse-whitespace, fix-encoding, missing-tokens, parse-numeric, coerce-numeric, parse-dates, standardise-booleans, replace-numeric-sentinels, null-future-years, drop-duplicates, drop-empty-cols, drop-constant-cols, lowercase-categoricals, rename-snake-case. Or {"ops": "safe"} for all safe fixes, {"ops": "all"} for every applicable op. Do NOT use a transform or derive block for these dataset-wide ops (and use the `recode` block, not `clean`, for a single value rewrite in THIS column).',
    "",
    "## EXAMPLES OF GOOD RESPONSES (match this shape exactly)",
    "User: round this column",
    "Reply:",
    "```transform",
    `{"column": "${meta.name}", "formula": "round(${meta.name})"}`,
    "```",
    "",
    "User: log transform",
    "Reply:",
    "```transform",
    `{"column": "${meta.name}", "formula": "log(${meta.name} + 1)"}`,
    "```",
    "+1 keeps zero rows finite. Drop it if the column is strictly positive.",
    "",
    "User: add a rounded version (keep the original)",
    "Reply:",
    "```derive",
    `{"name": "${meta.name}_rounded", "formula": "round(${meta.name})"}`,
    "```",
    "",
    "User: lowercase it",
    "Reply: Enable `merge case-only duplicates` in the cleaning banner.",
    "",
    ...capExample,
    "## REFERENCE PLAYBOOK (do NOT recite, use only to pick the right action)",
    ...playbook,
    "",
    "## THIS COLUMN",
    summary,
  ].join("\n");
}
