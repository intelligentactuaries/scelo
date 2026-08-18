// Scelo dataset core — headless.
//
// Profiling, typing, coercion and filtering, with no React, no DOM and no
// charting. Extracted from apps/web SoftDataWorkstation.tsx, where this logic
// was already pure but lived inside a 5,000-line component: 25 modules had to
// import from a .tsx to get a type, and nothing outside the browser build
// could use any of it.
//
// The boundary is "does it touch React, the DOM, or ECharts". `usePalette`,
// `tooltipFrame` and `sniffDelimitedText` (which needs Blob) deliberately
// stay behind in the component; everything here runs under Bun or Node
// unchanged.

export type CellValue = number | string | null;
export type Row = Record<string, CellValue>;
export type ColumnType = "number" | "string" | "date";

export type ColumnMeta = {
  name: string;
  type: ColumnType;
  count: number;
  missing: number;
  unique: number;
  // numeric-only — basic descriptive stats
  min?: number;
  max?: number;
  mean?: number;
  // numeric-only — Tukey five-number summary + fences for outlier filtering
  q1?: number;
  median?: number;
  q3?: number;
  boxLo?: number; // whisker low (min within fences)
  boxHi?: number; // whisker high (max within fences)
  loFence?: number;
  hiFence?: number;
  // numeric-only — quintile cut points [p20, p40, p60, p80]: the four
  // boundaries that split the column into five equal-COUNT buckets (each
  // holding 20% of the values). Note these are not evenly spaced in value
  // unless the distribution is uniform — that spacing IS the signal.
  // Omitted below QUINTILE_MIN_N values, where fifths are meaningless.
  // Same stride sample and therefore the same `sampledStats` caveat as the
  // quartiles above.
  quintiles?: [number, number, number, number];
  // numeric-only — outlier values retained for the scatter display, capped
  // at OUTLIER_DISPLAY_CAP by a uniform thin. `outlierCount` keeps the true
  // (or stride-estimated) total when the cap kicked in.
  outliers?: number[];
  outlierCount?: number;
  // numeric-only — count of non-null cells that are NOT numeric ("6+",
  // "unknown") in a number-typed column. They're excluded from every
  // numeric stat, so without this they'd be invisible (missing stays 0).
  mixedCount?: number;
  // numeric-only — coarse-binned histogram shape for the in-tooltip
  // sparkline. 12 bins between min and max, value = row count per bin.
  // Kept short so we can ship it on every column without bloating meta.
  histogramBins?: number[];
  // categorical-only — top values by frequency
  topValues?: Array<{ value: string; count: number }>;
  // date-only — ISO-string range + compact per-year counts (replaces
  // topValues, which is useless for ~18k distinct dates)
  dateMin?: string;
  dateMax?: string;
  yearHistogram?: Array<{ year: number; count: number }>;
  // True when order statistics (quantiles / histogram / topValues /
  // yearHistogram) came from a stride sample rather than every row.
  // count / missing / unique / min / max / mean stay exact regardless.
  sampledStats?: boolean;
};

export type Dataset = {
  name: string;
  rows: Row[];
  columns: string[];
  /** True when `rows` holds a subset of a larger full-fidelity source. */
  sampled?: boolean;
  /** Row count of the full-fidelity source (import file / pre-snapshot data). */
  sourceTotalRows?: number;
  /** How the subset was taken: uniform reservoir (CSV import / snapshot
   *  restore) or the file's leading rows (parquet import). */
  sampleKind?: "uniform" | "first";
};

// Hard cap on rows retained at import. 250k rows × ~25 columns of interned
// cells measures ~170 MB live heap — comfortably inside the renderer's ~4 GB
// budget, where the old uncapped whole-file parse measured 4.26 GB on a
// 2M-row CSV and killed the window. Beyond the cap the CSV path keeps a
// uniform reservoir sample; parquet keeps the first N rows.
export const DEFAULT_IMPORT_ROW_CAP = 250_000;

// Combine staging cap: at most 2 staged datasets on top of the active one —
// the user-facing "combine no more than 3 datasets" rule. Mirrors the note on
// sceloContext's `stagedDatasets`.

// ── parsing + synthesis ──────────────────────────────────────────────────────
//
// The actual CSV state machine lives in lib/csvStream (streaming, RFC-4180,
// row-capped). This section owns only what happens to each cell after it
// comes back as a raw string: missing-token nulling and strict numeric
// coercion.

// Missing-value tokens nulled at parse time so `missing` counts are honest
// from the first profile — leaving literal "NULL" strings in place reported
// missing=0 on columns that were 14% empty. Deliberately a small,
// unambiguous set; cleaning.ts's missing-markers op handles the long tail
// ("?", "TBD", …) as an explicit user action. Do not import that set here —
// the two evolve independently.

const MISSING_CELL_TOKENS = new Set(["null", "na", "n/a", "nan", "none", "-"]);
// Strict numeric shape — plain int / decimal / scientific only. Number()'s
// looser coercions ("0x1f", "Infinity", whitespace) are exactly what we're
// avoiding.
const NUMERIC_STRING_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const PLAIN_INTEGER_RE = /^[+-]?\d+$/;

/** Coerce one raw CSV cell into our CellValue shape. Exported for tests. */
export function coerceCsvCell(raw: string): CellValue {
  const s = raw.trim();
  if (s === "") return null;
  // Length guard skips the toLowerCase allocation on the vast majority of
  // cells (longest token is 4 chars).
  if (s.length <= 4 && MISSING_CELL_TOKENS.has(s.toLowerCase())) return null;
  if (!NUMERIC_STRING_RE.test(s)) return s;
  // Id-like guards: leading-zero integers ("007") and integers that don't
  // survive the float round-trip (> 2^53) stay strings.
  if (PLAIN_INTEGER_RE.test(s)) {
    if (/^[+-]?0\d/.test(s)) return s;
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : s;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : s;
}

// Materialise streamed string cells into Row objects. Kept separate from
// streamParseCsv, which stays type-agnostic by design.

const SUMMARY_SAMPLE_THRESHOLD = 200_000;
const SUMMARY_SAMPLE_TARGET = 100_000;

// Outlier values retained on the meta for the scatter display. The true
// count lives in `outlierCount`; retaining every value turned discrete
// columns into hundreds of thousands of scatter dots.
const OUTLIER_DISPLAY_CAP = 500;

// Strict date shapes: ISO yyyy-MM-dd / yyyy/MM/dd, optionally followed by a
// time part. Deliberately excludes DD/MM vs MM/DD forms — those are
// ambiguous and stay with the cleaning banner's parse-dates op rather than
// silent type detection.
const DATE_SHAPE_RE = /^(\d{4})[-/](\d{2})[-/](\d{2})([T ]\S.*)?$/;
// Minimum matching values before a column may re-type to date — keeps a
// three-row toy column of coincidental matches from flipping type.
const DATE_PROBE_MIN = 8;
const DATE_PROBE_TARGET = 200;

// Year of a strictly date-shaped string (with a month/day sanity check so
// numeric codes like "2024-99-99" don't pass), or null when not a date.
export function dateShapeYear(s: string): number | null {
  const m = DATE_SHAPE_RE.exec(s);
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return Number(m[1]);
}

// Uniform thin of the (sorted) outlier list down to the display cap so the
// scatter keeps the tail's shape without drawing every point.
export function capOutliers(outliers: number[]): number[] {
  if (outliers.length <= OUTLIER_DISPLAY_CAP) return outliers;
  const step = outliers.length / OUTLIER_DISPLAY_CAP;
  const kept: number[] = new Array(OUTLIER_DISPLAY_CAP);
  for (let k = 0; k < OUTLIER_DISPLAY_CAP; k++) kept[k] = outliers[Math.floor(k * step)];
  return kept;
}


export function summariseDataset(dataset: Dataset): ColumnMeta[] {
  return dataset.columns.map((c) => summarise(dataset.rows, c));
}

export function summarise(rows: Row[], name: string): ColumnMeta {
  const total = rows.length;
  const sampledStats = total > SUMMARY_SAMPLE_THRESHOLD;
  const stride = sampledStats ? Math.ceil(total / SUMMARY_SAMPLE_TARGET) : 1;

  // Exact pass — every row, constant work per cell: presence, uniqueness,
  // numeric-vs-string tally, and exact numeric min / max / mean.
  let missing = 0;
  let numericCount = 0;
  const uniqueSet = new Set<string | number>();
  let mn = Number.POSITIVE_INFINITY;
  let mx = Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < total; i++) {
    const v = rows[i][name];
    if (v === null || v === "") {
      missing++;
      continue;
    }
    uniqueSet.add(v);
    if (typeof v === "number" && Number.isFinite(v)) {
      numericCount++;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      sum += v;
    }
  }
  const nonNullCount = total - missing;

  const meta: ColumnMeta = {
    name,
    type: "string",
    count: total,
    missing,
    unique: uniqueSet.size,
  };
  if (sampledStats) meta.sampledStats = true;

  if (nonNullCount > 0 && numericCount / nonNullCount >= 0.8) {
    meta.type = "number";
    // Mixed cells: present but non-numeric in a number-typed column ("6+").
    // They're excluded from every numeric stat below, so surface the count
    // instead of letting them vanish (missing stays 0 for them).
    const mixed = nonNullCount - numericCount;
    if (mixed > 0) meta.mixedCount = mixed;
    if (numericCount > 0) {
      meta.min = mn;
      meta.max = mx;
      meta.mean = sum / numericCount;
      // Order statistics from the stride sample.
      const nums: number[] = [];
      for (let i = 0; i < total; i += stride) {
        const v = rows[i][name];
        if (typeof v === "number" && Number.isFinite(v)) nums.push(v);
      }
      // Sorted once here and reused: `quantile` requires ascending order, and
      // boxStats' own defensive copy-sort degrades to ~linear on sorted input,
      // so the quintiles below cost no extra full sort.
      nums.sort((a, b) => a - b);
      if (nums.length >= QUINTILE_MIN_N) {
        meta.quintiles = [
          quantile(nums, 0.2),
          quantile(nums, 0.4),
          quantile(nums, 0.6),
          quantile(nums, 0.8),
        ];
      }
      const stats = boxStats(nums);
      if (stats) {
        const [lo, q1, median, q3, hi] = stats.stats;
        meta.boxLo = lo;
        meta.q1 = q1;
        meta.median = median;
        meta.q3 = q3;
        meta.boxHi = hi;
        const iqr = q3 - q1;
        meta.loFence = q1 - 1.5 * iqr;
        meta.hiFence = q3 + 1.5 * iqr;
        // True (stride-scaled when sampled) count, then cap what we retain.
        meta.outlierCount = stats.outliers.length * stride;
        meta.outliers = capOutliers(stats.outliers);
      }
      // Coarse-binned histogram for the tooltip sparkline. 12 equal-width
      // bins between min and max — wide enough that the shape reads, narrow
      // enough that the SVG stays compact. Skip degenerate single-value
      // columns (min === max) since a histogram of one bucket is uninformative.
      if (meta.min !== undefined && meta.max !== undefined && meta.max > meta.min) {
        const BINS = 12;
        const width = (meta.max - meta.min) / BINS;
        const bins = new Array<number>(BINS).fill(0);
        for (const v of nums) {
          let idx = Math.floor((v - meta.min) / width);
          if (idx === BINS) idx = BINS - 1;
          if (idx >= 0 && idx < BINS) bins[idx]++;
        }
        meta.histogramBins = bins;
      }
    }
    return meta;
  }

  // Date detection — conservative: probe up to DATE_PROBE_TARGET non-null
  // string values; ≥80% must match a strict unambiguous date shape (and at
  // least DATE_PROBE_MIN matches seen) before re-typing. Categorical codes
  // ("LIM", "GP") and mixed-format date columns fall through to categorical.
  let probed = 0;
  let dateShaped = 0;
  const probeStride = Math.max(1, Math.floor(total / DATE_PROBE_TARGET));
  for (let i = 0; i < total && probed < DATE_PROBE_TARGET; i += probeStride) {
    const v = rows[i][name];
    if (typeof v !== "string" || v === "") continue;
    probed++;
    if (dateShapeYear(v) !== null) dateShaped++;
  }
  if (probed >= DATE_PROBE_MIN && dateShaped / probed >= 0.8) {
    meta.type = "date";
    // Range + per-year counts from the stride sample. ISO strings sort
    // lexicographically, so string comparison IS date comparison.
    let dMin: string | undefined;
    let dMax: string | undefined;
    const yearCounts = new Map<number, number>();
    for (let i = 0; i < total; i += stride) {
      const v = rows[i][name];
      if (typeof v !== "string") continue;
      const year = dateShapeYear(v);
      if (year === null) continue;
      if (dMin === undefined || v < dMin) dMin = v;
      if (dMax === undefined || v > dMax) dMax = v;
      yearCounts.set(year, (yearCounts.get(year) ?? 0) + 1);
    }
    meta.dateMin = dMin;
    meta.dateMax = dMax;
    meta.yearHistogram = [...yearCounts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([year, count]) => ({ year, count: count * stride }));
    return meta;
  }

  // Categorical top values from the stride sample; counts are scaled back
  // to dataset scale so proportions against the exact non-null total stay
  // honest in the stacked header bar.
  const counts = new Map<string, number>();
  for (let i = 0; i < total; i += stride) {
    const v = rows[i][name];
    if (v === null || v === "") continue;
    const k = String(v);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  meta.topValues = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([value, count]) => ({ value, count: count * stride }));
  return meta;
}


// Stack-safe min/max for large arrays. `Math.min(...arr)` and
// `Math.max(...arr)` use call-site argument spread, which most JS engines
// implement by pushing each value onto the call stack — RangeError at
// ~100k elements. A real `.parquet` upload trivially exceeds that, so any
// numeric-summary path has to use a plain loop.
export function minMax(values: number[]): { min: number; max: number } | null {
  if (values.length === 0) return null;
  let mn = values[0];
  let mx = values[0];
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  return { min: mn, max: mx };
}

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 10000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (abs >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return n.toPrecision(3);
}


export type Filter =
  | { kind: "eq"; column: string; value: string | number }
  | { kind: "iqr"; column: string; min: number; max: number }
  | { kind: "outliers"; column: string; loFence: number; hiFence: number };

/** Fewest values for which reporting fifths is honest. Below five you have
 *  fewer data points than buckets, so every cut point is an interpolation
 *  artefact rather than a description of the data. */
const QUINTILE_MIN_N = 5;

export function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (sortedAsc.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

export function boxStats(values: number[]): {
  stats: [number, number, number, number, number];
  outliers: number[];
} | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const median = quantile(sorted, 0.5);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  // Degenerate spread (≥50% of values identical → IQR 0) collapses the
  // Tukey fences onto the quartiles and flags every other value as an
  // outlier — a discrete gears/airbags column would light up 25% of its
  // rows. No spread, no outlier classification: whiskers span the range.
  if (iqr === 0) {
    return {
      stats: [sorted[0], q1, median, q3, sorted[sorted.length - 1]],
      outliers: [],
    };
  }
  const loFence = q1 - 1.5 * iqr;
  const hiFence = q3 + 1.5 * iqr;
  const inFence = sorted.filter((v) => v >= loFence && v <= hiFence);
  const outliers = sorted.filter((v) => v < loFence || v > hiFence);
  const lo = inFence.length > 0 ? inFence[0] : sorted[0];
  const hi = inFence.length > 0 ? inFence[inFence.length - 1] : sorted[sorted.length - 1];
  return { stats: [lo, q1, median, q3, hi], outliers };
}

// ─── descriptive profile ──────────────────────────────────────────────────
//
// The ONE definition of "descriptive statistics" every Scelo surface uses —
// the IDE's descriptive report, the TUI's describe analysis, and anything
// else that summarises numeric columns. Lives here so the two can never
// print different medians for the same file.
//
// Conventions (chosen to match what statisticians / actuaries expect from
// R, numpy and SAS):
//   • quantiles — the shared `quantile` above: linear interpolation on
//     (n−1)p, i.e. R type 7 / numpy default.
//   • spread — sample sd with Bessel's correction (n−1).
//   • shape — adjusted Fisher–Pearson G1 / excess-kurtosis G2 (what R's
//     e1071 type 2, SAS and Excel report); null when n is too small or the
//     column is constant.
//   • Jarque–Bera — on the UNadjusted g1/g2 (the asymptotic form);
//     χ²(2) survival is exactly exp(−JB/2). Null below n = 8, where the
//     statistic is numerology.
//   • ranking — coefficient of variation (sd/|mean|), descending: unit-free,
//     so a premium column in cents can't outrank a loss ratio just by scale.
//     Columns with mean ≈ 0 (CV undefined) rank last, by sd among themselves.
export type NumericColumnProfile = {
  name: string;
  count: number;
  /** Cells that are null or non-numeric — invisible in `count` alone. */
  missing: number;
  missingPct: number;
  mean: number;
  sd: number;
  /** Standard error of the mean, sd/√n. */
  se: number;
  /** sd/|mean|; null when the mean is ≈ 0 and the ratio is undefined. */
  cv: number | null;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  iqr: number;
  /** Adjusted Fisher–Pearson skewness G1; null when n < 3 or sd = 0. */
  skewness: number | null;
  /** Adjusted excess kurtosis G2 (normal ≈ 0); null when n < 4 or sd = 0. */
  kurtosis: number | null;
  jarqueBera: { stat: number; p: number } | null;
};

export function profileNumericColumns(dataset: Dataset): NumericColumnProfile[] {
  const profiles: NumericColumnProfile[] = [];
  const totalRows = dataset.rows.length;
  for (const col of dataset.columns) {
    const values: number[] = [];
    for (const row of dataset.rows) {
      const v = row[col];
      if (typeof v === "number" && Number.isFinite(v)) values.push(v);
    }
    if (values.length === 0) continue;
    values.sort((a, b) => a - b);
    const n = values.length;
    const missing = totalRows - n;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    // Two-pass central moments: mean first, then deviations — stable, and
    // one loop gives m2..m4 for spread + shape + JB together.
    let m2 = 0;
    let m3 = 0;
    let m4 = 0;
    for (const v of values) {
      const dev = v - mean;
      const dev2 = dev * dev;
      m2 += dev2;
      m3 += dev2 * dev;
      m4 += dev2 * dev2;
    }
    m2 /= n;
    m3 /= n;
    m4 /= n;
    const sd = n > 1 ? Math.sqrt((m2 * n) / (n - 1)) : 0;
    const se = sd / Math.sqrt(n);
    const cv = Math.abs(mean) > 1e-12 ? sd / Math.abs(mean) : null;
    const g1 = m2 > 0 ? m3 / m2 ** 1.5 : null;
    const g2 = m2 > 0 ? m4 / (m2 * m2) - 3 : null;
    const skewness = g1 !== null && n > 2 ? (Math.sqrt(n * (n - 1)) / (n - 2)) * g1 : null;
    const kurtosis =
      g2 !== null && n > 3 ? ((n - 1) / ((n - 2) * (n - 3))) * ((n + 1) * g2 + 6) : null;
    let jarqueBera: NumericColumnProfile["jarqueBera"] = null;
    if (g1 !== null && g2 !== null && n >= 8) {
      const stat = (n / 6) * (g1 * g1 + (g2 * g2) / 4);
      jarqueBera = { stat, p: Math.exp(-stat / 2) };
    }
    const q1 = quantile(values, 0.25);
    const q3 = quantile(values, 0.75);
    profiles.push({
      name: col,
      count: n,
      missing,
      missingPct: totalRows > 0 ? missing / totalRows : 0,
      mean,
      sd,
      se,
      cv,
      min: values[0],
      q1,
      median: quantile(values, 0.5),
      q3,
      max: values[n - 1],
      iqr: q3 - q1,
      skewness,
      kurtosis,
      jarqueBera,
    });
  }
  profiles.sort((a, b) => {
    if (a.cv === null && b.cv !== null) return 1;
    if (b.cv === null && a.cv !== null) return -1;
    if (a.cv !== null && b.cv !== null && b.cv !== a.cv) return b.cv - a.cv;
    return b.sd - a.sd;
  });
  return profiles;
}

// ─── filters ──────────────────────────────────────────────────────────────

export function filterId(f: Filter): string {
  if (f.kind === "eq") return `${f.column}|eq|${String(f.value)}`;
  if (f.kind === "iqr") return `${f.column}|iqr`;
  return `${f.column}|outliers`;
}

export function describeFilter(f: Filter): string {
  if (f.kind === "eq") return `${f.column} = ${f.value}`;
  if (f.kind === "iqr") return `${f.column} ∈ IQR [${formatNumber(f.min)}, ${formatNumber(f.max)}]`;
  return `${f.column} outliers`;
}

export function matchesFilter(row: Row, f: Filter): boolean {
  const v = row[f.column];
  if (f.kind === "eq") return v === f.value;
  if (f.kind === "iqr") return typeof v === "number" && v >= f.min && v <= f.max;
  return typeof v === "number" && (v < f.loFence || v > f.hiFence);
}

export function applyFilters(rows: Row[], filters: Filter[]): Row[] {
  if (filters.length === 0) return rows;
  return rows.filter((row) => filters.every((f) => matchesFilter(row, f)));
}

// The bundled sample datasets — shared so the IDE and the TUI offer the
// same examples rather than drifting copies. See samples.ts.
export {
  SAMPLES,
  SAMPLE_BY_KEY,
  type SampleKey,
  type SampleSpec,
  type ClimateSampleRow,
  CLIMATE_SAMPLE,
  buildDirtySample,
  buildWorkspaceDemo,
  WORKSPACE_DEMO_READOUTS,
  WORKSPACE_DEMO_REFLEXIVE,
} from "./samples";

// lifelib manifest — the pinned lifelib / modelx versions and the life-family
// model → lifelib library mapping. See ./lifelib.ts.
export {
  LIFELIB_VERSION,
  MODELX_VERSION,
  LIFELIB_PYTHON_MIN,
  LIFELIB_PIP_REQUIREMENTS,
  LIFELIB_LIBRARIES,
  LIFELIB_TARGETS,
  lifelibLibrary,
  lifelibTargetFor,
  isLifelibModel,
  lifelibProvenance,
  type LifelibLibrary,
  type LifelibLibraryStatus,
  type LifelibTarget,
} from "./lifelib";

// Actuarial table generation, suggestion and prompt parsing (life tables,
// commutation functions, premium grids, run-off triangles, discount curves,
// A/E studies, model points). See ./actuarialTables.ts.
export {
  ACTUARIAL_TABLE_KINDS,
  COLUMN_ALIASES as TABLE_COLUMN_ALIASES,
  ILLUSTRATIVE_MAKEHAM,
  coerceTableSpec,
  describeTableSpec,
  detectTableSignals,
  findColumn,
  generateActuarialTable,
  parseTablePrompt,
  qxFromBasis,
  suggestActuarialTables,
  tableToCsv,
  type ActuarialTableKind,
  type ActuarialTableSpec,
  type AgeRange,
  type AnnuityAssuranceSpec,
  type CommutationSpec,
  type DiscountCurveSpec,
  type ExposureAeSpec,
  type GeneratedTable,
  type LifeTableSpec,
  type ModelPointsSpec,
  type MortalityBasis,
  type NetPremiumSpec,
  type RunoffTriangleSpec,
  type TableSuggestion,
} from "./actuarialTables";
