// Multi-dataset combine engine for the Soft Data workstation.
//
// Up to three offline imports can be loaded at once (the active dataset plus
// two staged ones); this module decides HOW they fit together and executes
// the combination:
//
//   * append      — same (or near-same) schema: stack rows. Column names
//                   match case-insensitively against the base's spelling;
//                   columns missing on one side fill with null; brand-new
//                   columns join the schema (union). Optional exact-duplicate
//                   drop for overlapping batch exports.
//   * join-left   — a shared high-uniqueness key (id-like): every base row
//                   kept, matching columns from the other side attached.
//   * join-inner  — same, but unmatched base rows drop.
//
// `suggestCombine` is the "smart" part: it profiles both datasets and ranks
// what a data engineer would do — join when a key column lines up with high
// uniqueness and value overlap, append when the schemas mirror each other
// and keys DON'T overlap (two batches of the same extract), union-append as
// the fallback for partial schema overlap. The UI shows the suggestion with
// its evidence and lets the user override every part of it.
//
// Joins never multiply rows: a duplicated right-side key attaches its first
// match and reports the duplication instead of exploding a 250k-row base
// into millions (m:n cartesian blowups are the classic silent killer here).

import type { CellValue, Dataset, Row } from "./SoftDataWorkstation";

export type CombineStrategy = "append" | "join-left" | "join-inner";

export interface CombineStep {
  strategy: CombineStrategy;
  /** Base-side key column (join strategies only). */
  key?: string;
  /** Other-side key column — defaults to `key` matched case-insensitively. */
  rightKey?: string;
  /** append only: drop rows that duplicate an existing row exactly. */
  dedupeExact?: boolean;
}

export interface KeyCandidate {
  baseColumn: string;
  otherColumn: string;
  /** Share of sampled base key values found in the other dataset (0..1). */
  overlap: number;
  /** max(uniqueness in base, uniqueness in other) — a real key is ~1 on at
   *  least one side (the dimension side of a fact/dimension pair). */
  uniqueness: number;
  idLikeName: boolean;
  score: number;
}

export interface CombineSuggestion {
  step: CombineStep;
  /** 0..1 — how confident the heuristic is that this is the right move. */
  confidence: number;
  rationale: string;
  keyCandidates: KeyCandidate[];
  /** Share of column names the two datasets have in common (of the union). */
  schemaOverlap: number;
}

export interface CombineStats {
  strategy: CombineStrategy;
  key?: string;
  outputRows: number;
  outputColumns: number;
  /** join: base rows that found a match. append: rows appended. */
  matched: number;
  /** join-left: base rows with no match (kept, nulls attached).
   *  join-inner: base rows dropped. append: duplicate rows dropped. */
  unmatched: number;
  /** Right-side rows sharing a key with another right-side row — their
   *  first occurrence wins; a big number means the "other" side wasn't
   *  really one-row-per-key. */
  duplicateRightKeys: number;
  /** Non-key columns that existed on both sides and were suffixed `_2`. */
  renamedColumns: string[];
}

const SAMPLE_LIMIT = 5000;

const norm = (c: string) => c.trim().toLowerCase();

const ID_LIKE = /(^|_)(id|key|number|no|policy|claim|member|customer|client)s?($|_)/i;

/** Map other-dataset column names to the base's canonical spelling. */
function columnAliases(base: Dataset, other: Dataset): Map<string, string> {
  const byNorm = new Map(base.columns.map((c) => [norm(c), c]));
  const aliases = new Map<string, string>();
  for (const c of other.columns) {
    const hit = byNorm.get(norm(c));
    if (hit) aliases.set(c, hit);
  }
  return aliases;
}

function uniqueness(rows: Row[], column: string): number {
  const seen = new Set<string>();
  let nonNull = 0;
  const limit = Math.min(rows.length, SAMPLE_LIMIT);
  for (let i = 0; i < limit; i++) {
    const v = rows[i][column];
    if (v === null || v === "") continue;
    nonNull++;
    seen.add(String(v));
  }
  return nonNull === 0 ? 0 : seen.size / nonNull;
}

function valueOverlap(base: Dataset, baseCol: string, other: Dataset, otherCol: string): number {
  const otherVals = new Set<string>();
  const oLimit = Math.min(other.rows.length, SAMPLE_LIMIT);
  for (let i = 0; i < oLimit; i++) {
    const v = other.rows[i][otherCol];
    if (v !== null && v !== "") otherVals.add(String(v));
  }
  if (otherVals.size === 0) return 0;
  let hits = 0;
  let checked = 0;
  const bLimit = Math.min(base.rows.length, SAMPLE_LIMIT);
  for (let i = 0; i < bLimit; i++) {
    const v = base.rows[i][baseCol];
    if (v === null || v === "") continue;
    checked++;
    if (otherVals.has(String(v))) hits++;
  }
  return checked === 0 ? 0 : hits / checked;
}

export function detectJoinKeys(base: Dataset, other: Dataset): KeyCandidate[] {
  const aliases = columnAliases(base, other);
  const out: KeyCandidate[] = [];
  for (const [otherCol, baseCol] of aliases) {
    const uBase = uniqueness(base.rows, baseCol);
    const uOther = uniqueness(other.rows, otherCol);
    const u = Math.max(uBase, uOther);
    if (u < 0.9) continue; // neither side is one-row-per-key — not a key
    const overlap = valueOverlap(base, baseCol, other, otherCol);
    if (overlap < 0.3) continue; // shared name but the values don't line up
    const idLikeName = ID_LIKE.test(baseCol);
    out.push({
      baseColumn: baseCol,
      otherColumn: otherCol,
      overlap,
      uniqueness: u,
      idLikeName,
      score: overlap * u + (idLikeName ? 0.15 : 0),
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

export function suggestCombine(base: Dataset, other: Dataset): CombineSuggestion {
  const aliases = columnAliases(base, other);
  const unionCount = base.columns.length + other.columns.length - aliases.size;
  const schemaOverlap = unionCount === 0 ? 0 : aliases.size / unionCount;
  const keys = detectJoinKeys(base, other);
  const best = keys[0];

  // Identical (or near-identical) schemas read as "another batch of the same
  // extract" — append — UNLESS the id values overlap heavily, which means
  // the second file re-describes the same records rather than adding new
  // ones (then a join dedupes into columns instead of doubling rows).
  if (schemaOverlap >= 0.8) {
    if (best && best.overlap >= 0.7 && other.columns.length > aliases.size) {
      return {
        step: { strategy: "join-left", key: best.baseColumn, rightKey: best.otherColumn },
        confidence: 0.75,
        rationale: `Schemas mostly match but ${Math.round(best.overlap * 100)}% of ${best.baseColumn} values re-appear — joining attaches the new columns instead of duplicating rows.`,
        keyCandidates: keys,
        schemaOverlap,
      };
    }
    return {
      step: { strategy: "append", dedupeExact: true },
      confidence: best && best.overlap >= 0.7 ? 0.6 : 0.9,
      rationale:
        `${Math.round(schemaOverlap * 100)}% of columns line up — stacking rows` +
        (best && best.overlap >= 0.7
          ? `, but note ${Math.round(best.overlap * 100)}% of ${best.baseColumn} values overlap; exact duplicates will be dropped.`
          : " (batch append)."),
      keyCandidates: keys,
      schemaOverlap,
    };
  }

  // Different schemas with a solid key → enrichment join.
  if (best && best.overlap >= 0.5) {
    return {
      step: { strategy: "join-left", key: best.baseColumn, rightKey: best.otherColumn },
      confidence: Math.min(0.95, best.score),
      rationale: `${best.baseColumn} is ${Math.round(best.uniqueness * 100)}% unique and ${Math.round(best.overlap * 100)}% of values match — left join brings in ${other.columns.length - aliases.size} new column${other.columns.length - aliases.size === 1 ? "" : "s"}.`,
      keyCandidates: keys,
      schemaOverlap,
    };
  }

  // Partial schema overlap, no key — union-append is the safe default.
  return {
    step: { strategy: "append", dedupeExact: false },
    confidence: schemaOverlap >= 0.5 ? 0.5 : 0.25,
    rationale:
      schemaOverlap > 0
        ? `Only ${Math.round(schemaOverlap * 100)}% of columns match and no reliable key was found — union-append keeps every column, filling gaps with nulls.`
        : "No columns or keys in common — union-append will stack the datasets side-by-side with nulls; check this is really what you want.",
    keyCandidates: keys,
    schemaOverlap,
  };
}

// ── preview ──────────────────────────────────────────────────────────────────
//
// Exact pre-flight accounting for the review panel's combine diagram: the
// same key/lookup/fingerprint logic as combinePair, but counting instead of
// materialising rows. Unlike suggestCombine's 5k-row sampled heuristics,
// these numbers are exact — they must equal the stats the real combine
// reports afterwards (locked in by tests).

export interface CombinePreview {
  strategy: CombineStrategy;
  baseRows: number;
  otherRows: number;
  /** Columns the other side contributes (post-rename spelling). */
  newColumns: string[];
  /** Column names the two schemas share (case-insensitive). */
  sharedColumns: number;
  resultRows: number;
  resultColumns: number;
  join?: {
    key: string;
    rightKey: string;
    /** Base rows whose key found a right-side match. */
    matched: number;
    /** Base rows with a non-null key and no match. */
    baseOnly: number;
    /** Base rows whose key is null/empty — can never match. */
    baseNullKey: number;
    /** Distinct right-side keys no base row uses (ignored by the join). */
    otherOnlyKeys: number;
    duplicateRightKeys: number;
  };
  append?: {
    appended: number;
    /** Exact duplicates dropped (0 unless dedupeExact). */
    duplicatesDropped: number;
  };
}

export function previewCombine(base: Dataset, other: Dataset, step: CombineStep): CombinePreview {
  const aliases = columnAliases(base, other);

  if (step.strategy === "append") {
    const newColumns = other.columns.filter((c) => !aliases.has(c));
    const columns = [...base.columns, ...newColumns];
    let duplicatesDropped = 0;
    let appended = other.rows.length;
    if (step.dedupeExact) {
      const seen = new Set<string>();
      for (const r of base.rows) {
        const padded: Row = newColumns.length === 0 ? r : { ...r };
        for (const c of newColumns) padded[c] = null;
        seen.add(rowFingerprint(padded, columns));
      }
      appended = 0;
      for (const r of other.rows) {
        const mapped: Row = {};
        for (const c of columns) mapped[c] = null;
        for (const [otherCol, baseCol] of aliases) mapped[baseCol] = r[otherCol];
        for (const c of newColumns) mapped[c] = r[c];
        const fp = rowFingerprint(mapped, columns);
        if (seen.has(fp)) {
          duplicatesDropped++;
        } else {
          seen.add(fp);
          appended++;
        }
      }
    }
    return {
      strategy: "append",
      baseRows: base.rows.length,
      otherRows: other.rows.length,
      newColumns,
      sharedColumns: aliases.size,
      resultRows: base.rows.length + appended,
      resultColumns: columns.length,
      append: { appended, duplicatesDropped },
    };
  }

  const key = step.key;
  if (!key) throw new Error("join requires a key column");
  const rightKey = step.rightKey ?? other.columns.find((c) => norm(c) === norm(key)) ?? key;
  if (!base.columns.includes(key)) throw new Error(`key ${key} not in base dataset`);
  if (!other.columns.includes(rightKey)) throw new Error(`key ${rightKey} not in second dataset`);

  // Same rename walk as combinePair so newColumns reflects the final spelling.
  const baseSet = new Set(base.columns.map(norm));
  const newColumns: string[] = [];
  for (const c of other.columns) {
    if (c === rightKey) continue;
    if (baseSet.has(norm(c))) {
      let candidate = `${c}_2`;
      let n = 2;
      while (baseSet.has(norm(candidate))) candidate = `${c}_${++n}`;
      newColumns.push(candidate);
      baseSet.add(norm(candidate));
    } else {
      newColumns.push(c);
      baseSet.add(norm(c));
    }
  }

  const rightKeys = new Set<string>();
  let duplicateRightKeys = 0;
  for (const r of other.rows) {
    const v = r[rightKey];
    if (v === null || v === "") continue;
    const k = String(v);
    if (rightKeys.has(k)) duplicateRightKeys++;
    else rightKeys.add(k);
  }

  let matched = 0;
  let baseOnly = 0;
  let baseNullKey = 0;
  const usedKeys = new Set<string>();
  for (const r of base.rows) {
    const v = r[key];
    if (v === null || v === "") {
      baseNullKey++;
      continue;
    }
    const k = String(v);
    if (rightKeys.has(k)) {
      matched++;
      usedKeys.add(k);
    } else {
      baseOnly++;
    }
  }

  return {
    strategy: step.strategy,
    baseRows: base.rows.length,
    otherRows: other.rows.length,
    newColumns,
    sharedColumns: aliases.size,
    resultRows: step.strategy === "join-inner" ? matched : base.rows.length,
    resultColumns: base.columns.length + newColumns.length,
    join: {
      key,
      rightKey,
      matched,
      baseOnly,
      baseNullKey,
      otherOnlyKeys: rightKeys.size - usedKeys.size,
      duplicateRightKeys,
    },
  };
}

// ── execution ────────────────────────────────────────────────────────────────

function rowFingerprint(row: Row, columns: string[]): string {
  const parts: string[] = [];
  for (const c of columns) {
    const v = row[c];
    parts.push(v === null ? "∅" : typeof v === "number" ? `n:${v}` : `s:${v}`);
  }
  return parts.join("");
}

export function combinePair(
  base: Dataset,
  other: Dataset,
  step: CombineStep,
): { dataset: Dataset; stats: CombineStats } {
  const aliases = columnAliases(base, other);

  if (step.strategy === "append") {
    const newColumns = other.columns.filter((c) => !aliases.has(c));
    const columns = [...base.columns, ...newColumns];
    const rows: Row[] = base.rows.map((r) => {
      if (newColumns.length === 0) return r;
      const padded: Row = { ...r };
      for (const c of newColumns) padded[c] = null;
      return padded;
    });
    const seen = step.dedupeExact ? new Set(rows.map((r) => rowFingerprint(r, columns))) : null;
    let appended = 0;
    let dropped = 0;
    for (const r of other.rows) {
      const mapped: Row = {};
      for (const c of columns) mapped[c] = null;
      for (const [otherCol, baseCol] of aliases) mapped[baseCol] = r[otherCol];
      for (const c of newColumns) mapped[c] = r[c];
      if (seen) {
        const fp = rowFingerprint(mapped, columns);
        if (seen.has(fp)) {
          dropped++;
          continue;
        }
        seen.add(fp);
      }
      rows.push(mapped);
      appended++;
    }
    return {
      dataset: { name: base.name, columns, rows },
      stats: {
        strategy: "append",
        outputRows: rows.length,
        outputColumns: columns.length,
        matched: appended,
        unmatched: dropped,
        duplicateRightKeys: 0,
        renamedColumns: [],
      },
    };
  }

  // join
  const key = step.key;
  if (!key) throw new Error("join requires a key column");
  const rightKey = step.rightKey ?? other.columns.find((c) => norm(c) === norm(key)) ?? key;
  if (!base.columns.includes(key)) throw new Error(`key ${key} not in base dataset`);
  if (!other.columns.includes(rightKey)) {
    throw new Error(`key ${rightKey} not in second dataset`);
  }

  // Incoming columns: everything except the right key. Collisions with base
  // columns get a `_2` suffix so nothing is silently overwritten.
  const baseSet = new Set(base.columns.map(norm));
  const incoming: Array<{ from: string; to: string }> = [];
  const renamedColumns: string[] = [];
  for (const c of other.columns) {
    if (c === rightKey) continue;
    if (baseSet.has(norm(c))) {
      let candidate = `${c}_2`;
      let n = 2;
      while (baseSet.has(norm(candidate))) candidate = `${c}_${++n}`;
      incoming.push({ from: c, to: candidate });
      renamedColumns.push(candidate);
      baseSet.add(norm(candidate));
    } else {
      incoming.push({ from: c, to: c });
      baseSet.add(norm(c));
    }
  }

  const lookup = new Map<string, Row>();
  let duplicateRightKeys = 0;
  for (const r of other.rows) {
    const v = r[rightKey];
    if (v === null || v === "") continue;
    const k = String(v);
    if (lookup.has(k)) duplicateRightKeys++;
    else lookup.set(k, r);
  }

  const columns = [...base.columns, ...incoming.map((c) => c.to)];
  const rows: Row[] = [];
  let matched = 0;
  let unmatched = 0;
  for (const r of base.rows) {
    const v = r[key];
    const hit = v === null || v === "" ? undefined : lookup.get(String(v));
    if (!hit) {
      unmatched++;
      if (step.strategy === "join-inner") continue;
    } else {
      matched++;
    }
    const out: Row = { ...r };
    for (const { from, to } of incoming) out[to] = hit ? (hit[from] as CellValue) : null;
    rows.push(out);
  }

  return {
    dataset: { name: base.name, columns, rows },
    stats: {
      strategy: step.strategy,
      key,
      outputRows: rows.length,
      outputColumns: columns.length,
      matched,
      unmatched,
      duplicateRightKeys,
      renamedColumns,
    },
  };
}

/** Combine the base with up to two staged datasets, sequentially. The cap
 *  keeps the result inside the same renderer budget as imports. */
export function combineAll(
  base: Dataset,
  others: Array<{ dataset: Dataset; step: CombineStep }>,
  rowCap: number,
): { dataset: Dataset; stats: CombineStats[]; truncated: boolean; totalRows: number } {
  let current = base;
  const stats: CombineStats[] = [];
  for (const { dataset, step } of others) {
    const { dataset: next, stats: s } = combinePair(current, dataset, step);
    current = next;
    stats.push(s);
  }
  const totalRows = current.rows.length;
  const truncated = totalRows > rowCap;
  const rows = truncated ? current.rows.slice(0, rowCap) : current.rows;
  const name = [base.name, ...others.map((o) => o.dataset.name)].join(" + ");
  return {
    dataset: {
      name,
      columns: current.columns,
      rows,
      ...(truncated
        ? { sampled: true, sampleKind: "first" as const, sourceTotalRows: totalRows }
        : {}),
    },
    stats,
    truncated,
    totalRows,
  };
}
