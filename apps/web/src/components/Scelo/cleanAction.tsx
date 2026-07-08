// Chat-embedded cleaning action.
//
// A fenced ```clean block in a chat reply runs the deterministic cleaning
// engine (cleaning.ts) against the active dataset — the same engine the
// cleaning banner drives, just invoked from chat:
//
//   ```clean
//   {"ops": ["drop-duplicates", "missing-tokens"]}
//   ```
//   {"ops": "safe"}   → every safe op the analyser found
//   {"ops": "all"}    → every op the analyser found (safe + structural)
//
// Why this exists: before it, the assistant could only TALK about cleaning
// (or point at the banner) — it had no way to actually clean, so prompts
// like "remove the duplicates" produced prose that claimed work that never
// happened. This block performs the work, and the card below renders a
// DETERMINISTIC summary computed from the real before/after dataset. That
// summary is the source of truth; the model's prose is only context. If the
// requested ops don't apply to the current data, the card says so plainly
// rather than letting the model imply something changed.
//
// Idempotency note (public-repo port): the monorepo tracked applied `clean`
// blocks in a dedicated `cleanLog` Set on SceloContext. This repo already has
// a `transformLog` Set with the exact behaviours we need (cleared with the
// dataset, persisted, snapshot-aware), so we reuse it. Clean fingerprints are
// namespaced `clean::…` and transform fingerprints are `(column+formula)`, so
// the two can never collide.

import { type ReactNode, useEffect, useRef, useState } from "react";

import { summariseDataset } from "./SoftDataWorkstation";
import {
  type CleaningOp,
  type CleaningOpKey,
  analyseCleaning,
  applyCleaning,
  describeOp,
} from "./cleaning";
import { useScelo } from "./sceloContext";

// Canonical op keys, in the order the banner lists them.
const KNOWN_OPS: CleaningOpKey[] = [
  "trim",
  "collapse-whitespace",
  "fix-encoding",
  "missing-tokens",
  "parse-numeric",
  "coerce-numeric",
  "parse-dates",
  "standardise-booleans",
  "replace-numeric-sentinels",
  "null-future-years",
  "drop-duplicates",
  "drop-empty-cols",
  "drop-constant-cols",
  "lowercase-categoricals",
  "rename-snake-case",
];
const KNOWN_OP_SET = new Set<string>(KNOWN_OPS);

// Natural-language aliases the model reliably reaches for instead of the
// exact key. Resolving these is what keeps "remove duplicates",
// "fix missing values", "snake case the headers" etc. from silently
// matching nothing.
const OP_ALIASES: Record<string, CleaningOpKey> = {
  // trim / whitespace
  whitespace: "collapse-whitespace",
  "collapse whitespace": "collapse-whitespace",
  "collapse-internal-whitespace": "collapse-whitespace",
  trimwhitespace: "trim",
  // encoding
  encoding: "fix-encoding",
  "fix encoding": "fix-encoding",
  mojibake: "fix-encoding",
  // missing
  missing: "missing-tokens",
  "missing-values": "missing-tokens",
  "missing values": "missing-tokens",
  "missing-markers": "missing-tokens",
  nulls: "missing-tokens",
  na: "missing-tokens",
  // numeric / dates
  numeric: "parse-numeric",
  "parse-numbers": "parse-numeric",
  numbers: "parse-numeric",
  "coerce-numbers": "coerce-numeric",
  dates: "parse-dates",
  "parse-dates-strings": "parse-dates",
  datetime: "parse-dates",
  "future-years": "null-future-years",
  "null-future": "null-future-years",
  // booleans
  booleans: "standardise-booleans",
  boolean: "standardise-booleans",
  bools: "standardise-booleans",
  // sentinels
  sentinels: "replace-numeric-sentinels",
  "numeric-sentinels": "replace-numeric-sentinels",
  "sentinel-numerics": "replace-numeric-sentinels",
  // duplicates
  duplicates: "drop-duplicates",
  "drop-duplicate-rows": "drop-duplicates",
  dedupe: "drop-duplicates",
  dedup: "drop-duplicates",
  "remove-duplicates": "drop-duplicates",
  // empty / constant cols
  empty: "drop-empty-cols",
  "empty-cols": "drop-empty-cols",
  "empty-columns": "drop-empty-cols",
  "near-empty": "drop-empty-cols",
  "drop-empties": "drop-empty-cols",
  constant: "drop-constant-cols",
  "constant-cols": "drop-constant-cols",
  "constant-columns": "drop-constant-cols",
  // case folding
  lowercase: "lowercase-categoricals",
  "lower-case": "lowercase-categoricals",
  "merge-case": "lowercase-categoricals",
  "case-duplicates": "lowercase-categoricals",
  // headers
  "snake-case": "rename-snake-case",
  snakecase: "rename-snake-case",
  snake_case: "rename-snake-case",
  rename: "rename-snake-case",
  headers: "rename-snake-case",
};

function normaliseKey(s: string): string {
  return s.trim().toLowerCase().replace(/_/g, "-");
}

function resolveOp(token: string): CleaningOpKey | null {
  const k = normaliseKey(token);
  if (KNOWN_OP_SET.has(k)) return k as CleaningOpKey;
  if (OP_ALIASES[k]) return OP_ALIASES[k];
  // also try the un-hyphenated alias table (e.g. "missing values")
  const spaced = token.trim().toLowerCase();
  if (OP_ALIASES[spaced]) return OP_ALIASES[spaced];
  return null;
}

// Same balanced-object extractor used by chatDerive — pulls the first JSON
// object out of a reply that may have trailing prose.
function extractFirstJsonObject(s: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inString) {
      if (c === "\\") esc = true;
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
      if (depth === 0 && start >= 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

type CleanSpec = {
  // "safe" | "all" | explicit list of resolved op keys
  mode: "safe" | "all" | "list";
  ops: CleaningOpKey[];
  // Tokens we could not resolve to a known op — surfaced so the card can
  // be honest about what it ignored instead of silently dropping them.
  unknown: string[];
};

function parseCleanSpec(raw: string): CleanSpec | { error: string } {
  const json = extractFirstJsonObject(raw) ?? raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Invalid JSON" };
  }
  if (!parsed || typeof parsed !== "object") return { error: "Spec must be an object." };
  const obj = parsed as Record<string, unknown>;
  // Accept `ops`, `operations`, or `op` as the field name.
  const rawOps = obj.ops ?? obj.operations ?? obj.op;

  if (typeof rawOps === "string") {
    const lower = rawOps.trim().toLowerCase();
    if (lower === "safe" || lower === "default" || lower === "recommended") {
      return { mode: "safe", ops: [], unknown: [] };
    }
    if (lower === "all" || lower === "everything" || lower === "*") {
      return { mode: "all", ops: [], unknown: [] };
    }
    // A single op name as a bare string.
    const resolved = resolveOp(rawOps);
    if (resolved) return { mode: "list", ops: [resolved], unknown: [] };
    return { mode: "list", ops: [], unknown: [rawOps] };
  }

  if (Array.isArray(rawOps)) {
    const ops: CleaningOpKey[] = [];
    const unknown: string[] = [];
    for (const item of rawOps) {
      if (typeof item !== "string") continue;
      const resolved = resolveOp(item);
      if (resolved) {
        if (!ops.includes(resolved)) ops.push(resolved);
      } else {
        unknown.push(item);
      }
    }
    return { mode: "list", ops, unknown };
  }

  return { error: 'Missing `ops` (a list of operations, or "safe" / "all").' };
}

// ─── card chrome (kept visually identical to chatDerive's CardShell) ─────────

function CardShell({
  tone,
  children,
}: {
  tone: "ok" | "neutral" | "error";
  children: ReactNode;
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

// ─── component ───────────────────────────────────────────────────────────────

type AppliedSummary = {
  titles: string[]; // describeOp titles, in plan order
  details: string[]; // describeOp details, in plan order
  rowsBefore: number;
  rowsAfter: number;
  colsBefore: number;
  colsAfter: number;
};

type Outcome =
  | { kind: "pending" }
  | { kind: "error"; message: string }
  | { kind: "nothing"; requested: string[]; unknown: string[] }
  | { kind: "applied" } // re-render of an already-applied block (post-remount)
  | { kind: "ok"; summary: AppliedSummary; unknown: string[] };

export function ChatClean({ raw }: { raw: string }) {
  // Reuses `transformLog`/`setTransformLog` for clean-block idempotency — see
  // the file header. Clean fingerprints are namespaced `clean::…`.
  const { dataset, setDataset, setFilters, transformLog, setTransformLog, logEvent } = useScelo();
  const [outcome, setOutcome] = useState<Outcome>({ kind: "pending" });
  // Once this instance has resolved to a terminal outcome we stop re-running,
  // so the rich summary isn't downgraded to the compact "already applied"
  // card when applying the clean mutates the dataset (which would otherwise
  // re-fire the effect). A fresh mount (scrolling history back into view)
  // starts false again and falls through to the log check → compact card.
  const resolvedRef = useRef(false);
  const fingerprint = `clean::${raw}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-run on spec / dataset identity changes.
  useEffect(() => {
    if (resolvedRef.current) return;

    const spec = parseCleanSpec(raw);
    if ("error" in spec) {
      // Do NOT mark resolved: during streaming the JSON arrives in pieces and
      // parses as an error until the block completes. Leaving resolvedRef
      // false lets the effect re-run on the next `raw` update and recover.
      setOutcome({ kind: "error", message: spec.error });
      return;
    }
    if (!dataset) {
      // Wait for a dataset — don't mark resolved, so we retry when one loads.
      setOutcome({ kind: "pending" });
      return;
    }

    // Already applied in a previous render/instance → compact acknowledgement.
    if (transformLog.has(fingerprint)) {
      resolvedRef.current = true;
      setOutcome({ kind: "applied" });
      return;
    }

    // Rebuild the exact same plan the banner would compute for this dataset.
    const metas = summariseDataset(dataset);
    const plan = analyseCleaning(dataset, metas);
    const planKeys = new Set<CleaningOpKey>(plan.ops.map((o) => o.key));

    // Resolve the requested ops against what's actually applicable now.
    let enabled: Set<CleaningOpKey>;
    if (spec.mode === "safe") {
      enabled = new Set(plan.ops.filter((o) => o.safe).map((o) => o.key));
    } else if (spec.mode === "all") {
      enabled = new Set(plan.ops.map((o) => o.key));
    } else {
      enabled = new Set(spec.ops.filter((k) => planKeys.has(k)));
    }

    if (enabled.size === 0) {
      // Honest dead-end: nothing the user asked for actually applies to the
      // current data. Never imply a change happened.
      resolvedRef.current = true;
      const requested = spec.mode === "list" ? spec.ops : spec.mode === "safe" ? ["safe"] : ["all"];
      setOutcome({ kind: "nothing", requested, unknown: spec.unknown });
      return;
    }

    // Apply, then summarise from the REAL before/after dataset.
    const rowsBefore = dataset.rows.length;
    const colsBefore = dataset.columns.length;
    const cleaned = applyCleaning(dataset, plan, enabled);

    const appliedOps: CleaningOp[] = plan.ops.filter((o) => enabled.has(o.key));
    const titles: string[] = [];
    const details: string[] = [];
    for (const op of appliedOps) {
      const d = describeOp(op, plan.sampled);
      titles.push(d.title);
      details.push(d.detail);
    }

    setDataset(cleaned);
    // Cleaning can drop/rename columns and drop rows, so any active filter may
    // now reference a column that no longer exists — clear them, matching the
    // banner's apply behaviour.
    setFilters([]);
    setTransformLog((prev) => {
      const next = new Set(prev);
      next.add(fingerprint);
      return next;
    });
    logEvent({ stage: "soft", kind: "cleaning.apply", payload: { opLabels: titles } });

    resolvedRef.current = true;
    setOutcome({
      kind: "ok",
      unknown: spec.unknown,
      summary: {
        titles,
        details,
        rowsBefore,
        rowsAfter: cleaned.rows.length,
        colsBefore,
        colsAfter: cleaned.columns.length,
      },
    });
  }, [raw, dataset?.columns, dataset?.rows.length, transformLog]);

  if (outcome.kind === "pending") {
    return <CardShell tone="neutral">load a dataset to run this cleaning step…</CardShell>;
  }
  if (outcome.kind === "error") {
    return <CardShell tone="error">could not run cleaning: {outcome.message}</CardShell>;
  }
  if (outcome.kind === "applied") {
    return (
      <CardShell tone="ok">
        <span className="text-primary">✓</span> cleaning already applied for this step.
      </CardShell>
    );
  }
  if (outcome.kind === "nothing") {
    return (
      <CardShell tone="neutral">
        <div className="break-words">
          nothing to apply: the requested cleaning ({outcome.requested.join(", ")}) found no
          matching issues in the current dataset. It is already clean on that front.
        </div>
        {outcome.unknown.length > 0 && (
          <div className="mt-1 text-fg-dim break-words">
            unrecognised ops ignored: {outcome.unknown.join(", ")}
          </div>
        )}
      </CardShell>
    );
  }

  // ok
  const s = outcome.summary;
  const rowsDropped = s.rowsBefore - s.rowsAfter;
  const colsDropped = s.colsBefore - s.colsAfter;
  return (
    <CardShell tone="ok">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-primary">✓ applied cleaning</span>
        <span className="text-fg-mute">
          {s.titles.length} op{s.titles.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="mt-1 space-y-0.5">
        {s.titles.map((t, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable plan order.
          <li key={i} className="break-words text-fg-mute">
            <span className="text-primary">·</span> <span className="text-fg">{t}</span>
            {s.details[i] ? <span className="text-fg-dim"> — {s.details[i]}</span> : null}
          </li>
        ))}
      </ul>
      <div className="mt-1.5 break-words text-fg-mute">
        rows: {s.rowsBefore.toLocaleString()} → {s.rowsAfter.toLocaleString()}
        {rowsDropped > 0 ? ` (-${rowsDropped.toLocaleString()})` : " (unchanged)"} · columns:{" "}
        {s.colsBefore.toLocaleString()} → {s.colsAfter.toLocaleString()}
        {colsDropped > 0 ? ` (-${colsDropped.toLocaleString()})` : " (unchanged)"}
      </div>
      {outcome.unknown.length > 0 && (
        <div className="mt-1 text-fg-dim break-words">
          unrecognised ops ignored: {outcome.unknown.join(", ")}
        </div>
      )}
    </CardShell>
  );
}
