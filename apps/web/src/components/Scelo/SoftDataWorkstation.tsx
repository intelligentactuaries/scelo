// Soft Data drill-in. Layout cribbed from VS Code's Data Wrangler:
//   ┌──────────────────────────────────────────────────────────────┐
//   │ ← macro · soft data · workstation     [import csv | sample]  │
//   ├──────────────┬────────────────────────────┬──────────────────┤
//   │ columns      │ rows (grid)                │ column · summary │
//   │ (click to    │ paginated, sticky header   │ type, missing,   │
//   │  inspect)    │                            │ unique, hist     │
//   ├──────────────┴────────────────────────────┴──────────────────┤
//   │ Scelo · soft-data chatbot (scoped intake context)             │
//   └──────────────────────────────────────────────────────────────┘
//
// We compute column types + stats once per dataset change. The grid is a
// plain table for now — virtualisation can come later if a user actually
// drops a 100k-row file. The histogram is rendered with ECharts directly
// so we don't have to round-trip a synthetic ChartSpec through the API
// layer.

import { useTheme } from "@/lib/theme";
import ReactECharts from "echarts-for-react";
import { BarChart, BoxplotChart, ScatterChart } from "echarts/charts";
import { GridComponent, TitleComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { ChatInputPill } from "./ChatInputPill";
import { ExportButton } from "./ExportScreen";
import { ResizablePanel } from "./ResizablePanel";
import { SceloChatMarkdown } from "./SceloChatMarkdown";
import { SimulateScenarioModal } from "./SimulateScenarioModal";
import { SmartColumnDashboard } from "./SmartColumnDashboard";
import { StageChatPanel } from "./StageChatPanel";
import {
  type CleaningOpKey,
  type CleaningPlan,
  analyseCleaning,
  applyCleaning,
  defaultEnabled,
  describeOp,
} from "./cleaning";
import { CLIMATE_SAMPLE } from "./climateSampleData";
import { buildDirtySample } from "./dirtySampleData";
import { buildColumnStageContext, placeholderHintFor } from "./columnChatHints";
import { type ExportFormat, exportDataset } from "./exportDataset";
import { compileFormula, previewFormula, validateColumnName } from "./formulaEvaluator";
import { useScelo } from "./sceloContext";
import { useNodeChat } from "./useNodeChat";

echarts.use([
  TitleComponent,
  TooltipComponent,
  GridComponent,
  BarChart,
  BoxplotChart,
  ScatterChart,
  CanvasRenderer,
]);

// ── data model ───────────────────────────────────────────────────────────────

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
  outliers?: number[];
  // numeric-only — coarse-binned histogram shape for the in-tooltip
  // sparkline. 12 bins between min and max, value = row count per bin.
  // Kept short so we can ship it on every column without bloating meta.
  histogramBins?: number[];
  // categorical-only — top values by frequency
  topValues?: Array<{ value: string; count: number }>;
};

export type Dataset = {
  name: string;
  rows: Row[];
  columns: string[];
};

// ── parsing + synthesis ──────────────────────────────────────────────────────

function parseCsv(text: string): { columns: string[]; rows: Row[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { columns: [], rows: [] };
  const header = lines[0].split(",").map((h) => h.trim());
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const row: Row = {};
    for (let c = 0; c < header.length; c++) {
      const raw = (cells[c] ?? "").trim();
      if (raw === "") {
        row[header[c]] = null;
        continue;
      }
      const asNum = Number(raw);
      row[header[c]] = Number.isFinite(asNum) && raw !== "" ? asNum : raw;
    }
    rows.push(row);
  }
  return { columns: header, rows };
}

// Coerce a single parquet cell into our flat CellValue shape. Parquet types
// span the full Apache Arrow zoo; for the workstation we only need them
// reduced to `number | string | null` so the downstream summariser /
// histogram code keeps working. Numeric coercions happen here too — BigInt
// for INT64 columns is the main one a user is likely to hit.
function coerceParquetValue(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") {
    const n = Number(v);
    return Number.isFinite(n) ? n : v.toString();
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "string") return v;
  // Fallback for arrays/objects — keeps the column visible but flagged as
  // structured rather than throwing.
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

async function parseParquet(file: File): Promise<{ columns: string[]; rows: Row[] }> {
  const buf = await file.arrayBuffer();
  // Schema gives us the canonical column order; data-key order from
  // parquetReadObjects can differ when projections happen.
  const meta = parquetMetadata(buf);
  const columns = meta.schema
    // index 0 is the root group element — skip it, take only leaf fields.
    .slice(1)
    .filter((s) => s.type !== undefined)
    .map((s) => s.name);

  const objects = await parquetReadObjects({ file: buf });
  const rows: Row[] = objects.map((obj) => {
    const row: Row = {};
    for (const c of columns) {
      row[c] = coerceParquetValue(obj[c]);
    }
    return row;
  });
  return { columns, rows };
}

// Tiny seeded LCG so the synthetic dataset is stable across reloads.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

// Build the bundled climate reanalysis sample as a Dataset. The 30-day
// Pretoria ERA5 / MERRA-2 / JRA-3Q preview we use in the Hard Data
// model-detail panel doubles as a useful Soft Data workstation sample —
// the user can filter on a particular reanalysis, derive a heat-index
// column, or pipe the slice through the Tools workstation to pick a
// parametric model. We reuse the exact bundled rows so the numbers stay
// consistent with the climate-data lineage panel downstream.
function syntheticClimate(): Dataset {
  const rows: Row[] = CLIMATE_SAMPLE.map((r) => ({
    date: r.date,
    t2m_era5: r.t2m_era5,
    t2m_merra2: r.t2m_merra2,
    t2m_jra3q: r.t2m_jra3q,
    pr_era5: r.pr_era5,
    pr_merra2: r.pr_merra2,
    pr_jra3q: r.pr_jra3q,
  }));
  return {
    name: "climate_pretoria_jan2024 (era5 / merra-2 / jra-3q)",
    columns: ["date", "t2m_era5", "t2m_merra2", "t2m_jra3q", "pr_era5", "pr_merra2", "pr_jra3q"],
    rows,
  };
}

// Registry of the in-app sample datasets the "load sample" picker offers.
// Adding a new sample is one entry here — the picker modal renders cards
// from this list and the load action dispatches by key.
export type SampleKey = "claims" | "climate" | "dirty" | "lifelib-mp" | "wmtr-scenarios";

export type SampleOption = {
  key: SampleKey;
  build: () => Dataset;
  title: string;
  subtitle: string;
  blurb: string;
  rows: number;
  cols: number;
  accent: "accent-2" | "warn" | "error" | "accent-3";
  badge: string;
};

export const SAMPLE_OPTIONS_LIST = (): SampleOption[] => SAMPLE_OPTIONS;

const SAMPLE_OPTIONS: Array<{
  key: SampleKey;
  build: () => Dataset;
  title: string;
  subtitle: string;
  blurb: string;
  rows: number;
  cols: number;
  accent: "accent-2" | "warn" | "error" | "accent-3";
  badge: string;
}> = [
  {
    key: "claims",
    build: () => syntheticClaims(),
    title: "Synthetic claims",
    subtitle: "P&C reserving / pricing demo",
    blurb:
      "~80-row mixed-type dataset shaped as a proper INCOMPLETE claims triangle (origins 2018–2024, dev periods truncated to the latest calendar period). Columns: policy_id, origin_year, dev_period, line, SA province, age, sex, paid, incurred, settled. Ideal for chain-ladder / Mack / BF + GLM models.",
    rows: 80,
    cols: 10,
    accent: "accent-2",
    badge: "claims",
  },
  {
    key: "climate",
    build: () => syntheticClimate(),
    title: "Climate reanalysis ensemble",
    subtitle: "ERA5 / MERRA-2 / JRA-3Q · Pretoria · Jan 2024",
    blurb:
      "30 daily records over a single grid-cell with 2-m temperature and total precipitation under all three reanalyses. Same data the Hard Data climate-lineage panel renders downstream; ready for parametric trigger calibration and CLIMADA-style work.",
    rows: 30,
    cols: 7,
    accent: "warn",
    badge: "climate",
  },
  {
    key: "dirty",
    build: () => buildDirtySample(),
    title: "Messy intake (dirty demo)",
    subtitle: "exercises every cleaning op in one sample",
    blurb:
      "53-row customer ledger with the full real-world mess: $/comma/parens currency strings, %-suffixed numbers, -999 / 9999 sentinel ages, mixed Y/N/yes/no/1/0 booleans, mixed date formats (ISO + DD/MM/YYYY + 'Jan 5, 2024'), case-only region duplicates (WEST/west/West), a constant `country` column, two near-empty columns, headers with spaces, mojibake (UTF-8↔Latin-1), BOM/NBSP/zero-width characters, missing markers (N/A, ?, -, TBD, null), and three exact duplicate rows. Load it and the cleaning banner lights up with every op.",
    rows: 53,
    cols: 11,
    accent: "error",
    badge: "dirty",
  },
  {
    key: "wmtr-scenarios",
    build: () => syntheticWmtrScenarios(),
    title: "WMTR · forecast scenarios",
    subtitle: "domain-agnostic survival projection · α/w parameters",
    blurb:
      "12-row scenario table for the W(M, T, R) Monte Carlo forecast engine. Each row is a different actuarial entity (life book · pension scheme · reserve position · community) parameterised with α_M / α_T / α_R, relational weights, shock severity, and horizon. Picker routes straight to the `forecast` family.",
    rows: 12,
    cols: 12,
    accent: "warn",
    badge: "wmtr",
  },
  {
    key: "lifelib-mp",
    build: () => syntheticLifelibMP(),
    title: "Lifelib · model points",
    subtitle: "term life MP file · lifelib basiclife/BasicTerm_M",
    blurb:
      "100-row in-force model-point file shaped like lifelib's basic_term_sample: policy_id, age_at_entry, sex, sum_assured, policy_term, duration_mth, premium_pp. Loads straight into the lifelib BasicTerm_M projection (in-browser TS port) and routes the AI picker to the `life` family. Same structure works for CashValue / IFRS17 / Solvency II life nodes.",
    rows: 100,
    cols: 7,
    accent: "accent-3",
    badge: "lifelib",
  },
];

// WMTR forecast scenarios sample — 12 rows, one per actuarial entity
// type, parameterised with the W(M,T,R) Cobb-Douglas survival engine's
// α / w / shock columns. The picker recognises (α_M, α_T, α_R) as the
// `forecast` family signature and lands the user straight on
// wmtr-projection + wmtr-sensitivity in Tools.
function syntheticWmtrScenarios(): Dataset {
  const rows: Row[] = [
    // domain · αM · αT · αR · wF · wRel · wS · pProd · pFam · pRel · init_family · init_religion · shock · horizon
    { entity: "rural village", alpha_m: 0.30, alpha_t: 0.30, alpha_r: 0.40, w_f: 0.50, w_rel: 0.30, w_s: 0.20, init_family: 0.80, init_religion: 0.70, shock: "severe", horizon: 30 },
    { entity: "urban district", alpha_m: 0.50, alpha_t: 0.30, alpha_r: 0.20, w_f: 0.30, w_rel: 0.20, w_s: 0.50, init_family: 0.50, init_religion: 0.40, shock: "moderate", horizon: 30 },
    { entity: "coastal town", alpha_m: 0.40, alpha_t: 0.30, alpha_r: 0.30, w_f: 0.40, w_rel: 0.30, w_s: 0.30, init_family: 0.65, init_religion: 0.55, shock: "severe", horizon: 30 },
    { entity: "term life book", alpha_m: 0.55, alpha_t: 0.20, alpha_r: 0.25, w_f: 0.30, w_rel: 0.20, w_s: 0.50, init_family: 0.55, init_religion: 0.45, shock: "moderate", horizon: 20 },
    { entity: "annuity book",   alpha_m: 0.45, alpha_t: 0.25, alpha_r: 0.30, w_f: 0.35, w_rel: 0.25, w_s: 0.40, init_family: 0.60, init_religion: 0.50, shock: "moderate", horizon: 40 },
    { entity: "DB pension scheme", alpha_m: 0.35, alpha_t: 0.25, alpha_r: 0.40, w_f: 0.45, w_rel: 0.25, w_s: 0.30, init_family: 0.70, init_religion: 0.50, shock: "moderate", horizon: 30 },
    { entity: "GI reserves · long-tail", alpha_m: 0.60, alpha_t: 0.30, alpha_r: 0.10, w_f: 0.20, w_rel: 0.10, w_s: 0.70, init_family: 0.40, init_religion: 0.30, shock: "moderate", horizon: 15 },
    { entity: "GI reserves · short-tail", alpha_m: 0.65, alpha_t: 0.25, alpha_r: 0.10, w_f: 0.20, w_rel: 0.10, w_s: 0.70, init_family: 0.45, init_religion: 0.30, shock: "mild", horizon: 5 },
    { entity: "health LTH book", alpha_m: 0.50, alpha_t: 0.30, alpha_r: 0.20, w_f: 0.30, w_rel: 0.30, w_s: 0.40, init_family: 0.55, init_religion: 0.45, shock: "severe", horizon: 20 },
    { entity: "agrarian community · drought", alpha_m: 0.25, alpha_t: 0.30, alpha_r: 0.45, w_f: 0.55, w_rel: 0.30, w_s: 0.15, init_family: 0.85, init_religion: 0.75, shock: "severe", horizon: 30 },
    { entity: "post-conflict town", alpha_m: 0.30, alpha_t: 0.30, alpha_r: 0.40, w_f: 0.45, w_rel: 0.25, w_s: 0.30, init_family: 0.55, init_religion: 0.45, shock: "severe", horizon: 30 },
    { entity: "stable urban hub", alpha_m: 0.50, alpha_t: 0.30, alpha_r: 0.20, w_f: 0.25, w_rel: 0.15, w_s: 0.60, init_family: 0.60, init_religion: 0.45, shock: "mild", horizon: 30 },
  ];
  return {
    name: "wmtr_scenarios (synthetic)",
    columns: [
      "entity",
      "alpha_m",
      "alpha_t",
      "alpha_r",
      "w_f",
      "w_rel",
      "w_s",
      "init_family",
      "init_religion",
      "shock",
      "horizon",
    ],
    rows,
  };
}

// Lifelib model-point sample. Structure mirrors
// github.com/lifelib-dev/lifelib · basiclife / basic_term_sample.xlsx so an
// actuary already using lifelib can drop their real MP file in and get the
// same projection. 100 policies spread across age 25-65, mixed sex, mixed
// term, with `duration_mth` non-zero on a third of the book so the
// projection starts mid-coverage on those rows.
function syntheticLifelibMP(): Dataset {
  const rand = lcg(0xbeefcafe);
  const rows: Row[] = [];
  for (let i = 0; i < 100; i++) {
    const age = 25 + Math.floor(rand() * 41); // 25-65
    const sex = rand() > 0.5 ? "M" : "F";
    const term = [10, 15, 20, 25, 30][Math.floor(rand() * 5)];
    const sa = Math.round((100_000 + rand() * 900_000) / 1000) * 1000;
    // ~1/3 of book already in force: duration up to half the term
    const inForce = rand() < 0.33;
    const durationMth = inForce
      ? Math.max(1, Math.floor(rand() * (term * 12) * 0.5))
      : 0;
    // crude premium = SA * qx * loading / 12, with qx_male slightly higher
    const qx = 0.00022 + 2.7e-6 * Math.pow(1.124, age) * (sex === "M" ? 1.05 : 1.0);
    const monthly = Math.round(sa * qx * 1.20 / 12 * 100) / 100;
    rows.push({
      policy_id: `MP${(10000 + i).toString()}`,
      age_at_entry: age,
      sex,
      sum_assured: sa,
      policy_term: term,
      duration_mth: durationMth,
      premium_pp: monthly,
    });
  }
  return {
    name: "lifelib_basic_term_mp (synthetic)",
    columns: [
      "policy_id",
      "age_at_entry",
      "sex",
      "sum_assured",
      "policy_term",
      "duration_mth",
      "premium_pp",
    ],
    rows,
  };
}

function syntheticClaims(): Dataset {
  const rand = lcg(0xdeadbeef);
  const states = ["GP", "WC", "KZN", "EC", "FS", "MP", "LP", "NW", "NC"];
  const lines = ["motor", "household", "liability", "engineering", "marine"];
  // Build a proper INCOMPLETE triangle: for each origin year, only emit
  // claim rows where (origin + dev) ≤ latest calendar period. The latest
  // origin gets only dev=0 (one diagonal of a real triangle), the earliest
  // origin gets the full development tail. Chain-ladder + Mack +
  // Bornhuetter-Ferguson all collapse to IBNR=0 on a square / fully-developed
  // triangle, so without this constraint the reserving runners report
  // misleading 0.00 headlines on Hard Data.
  const origins = [2018, 2019, 2020, 2021, 2022, 2023, 2024];
  const latestCal = origins[origins.length - 1]; // 2024
  const rows: Row[] = [];
  let i = 0;
  for (const origin of origins) {
    const maxDev = latestCal - origin; // 0..6
    for (let dev = 0; dev <= maxDev; dev++) {
      // 2-4 claim rows per (origin, dev) cell so each cell is non-trivial,
      // and the overall row count lands around ~70 — close to the prior
      // sample size for stable Soft Data stats.
      const cellRows = 2 + Math.floor(rand() * 3);
      for (let k = 0; k < cellRows; k++) {
        const sev = Math.exp(8 + rand() * 3) * (1 + dev * 0.1);
        const age = 18 + Math.floor(rand() * 60);
        const sex = rand() > 0.5 ? "M" : "F";
        const settled = dev >= 3 ? rand() > 0.15 : rand() > 0.6;
        const incurred = rand() < 0.05 ? null : Math.round(sev * (1.05 + rand() * 0.25));
        rows.push({
          policy_id: `P${10000 + i}`,
          origin_year: origin,
          dev_period: dev,
          line: lines[Math.floor(rand() * lines.length)],
          state: states[Math.floor(rand() * states.length)],
          age,
          sex,
          paid: Math.round(sev),
          incurred,
          settled: settled ? "yes" : "no",
        });
        i++;
      }
    }
  }
  return {
    name: "claims_sample (synthetic)",
    columns: [
      "policy_id",
      "origin_year",
      "dev_period",
      "line",
      "state",
      "age",
      "sex",
      "paid",
      "incurred",
      "settled",
    ],
    rows,
  };
}

// ── type detection + stats ───────────────────────────────────────────────────

function detectType(values: CellValue[]): ColumnType {
  let numeric = 0;
  let nonNull = 0;
  for (const v of values) {
    if (v === null || v === "") continue;
    nonNull++;
    if (typeof v === "number" && Number.isFinite(v)) numeric++;
  }
  if (nonNull === 0) return "string";
  return numeric / nonNull >= 0.8 ? "number" : "string";
}

export function summariseDataset(dataset: Dataset): ColumnMeta[] {
  return dataset.columns.map((c) => summarise(dataset.rows, c));
}

function summarise(rows: Row[], name: string): ColumnMeta {
  const values = rows.map((r) => r[name]);
  const type = detectType(values);
  const nonNull = values.filter((v): v is number | string => v !== null && v !== "");
  const missing = rows.length - nonNull.length;
  const uniqueSet = new Set<string | number>();
  for (const v of nonNull) uniqueSet.add(v);

  const meta: ColumnMeta = {
    name,
    type,
    count: rows.length,
    missing,
    unique: uniqueSet.size,
  };

  if (type === "number") {
    const nums = nonNull.filter((v): v is number => typeof v === "number");
    if (nums.length > 0) {
      const mm = minMax(nums);
      if (mm) {
        meta.min = mm.min;
        meta.max = mm.max;
      }
      meta.mean = nums.reduce((a, b) => a + b, 0) / nums.length;
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
        meta.outliers = stats.outliers;
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
  } else {
    const counts = new Map<string, number>();
    for (const v of nonNull) {
      const k = String(v);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    meta.topValues = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([value, count]) => ({ value, count }));
  }
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

function fmtCell(v: CellValue): string {
  if (v === null) return "";
  if (typeof v === "number") return formatNumber(v);
  return String(v);
}

// ── filter model ─────────────────────────────────────────────────────────────
//
// Three filter kinds power the header click-to-filter:
//   eq        — `column = value`           (click a categorical segment)
//   iqr       — `column ∈ [Q1, Q3]`        (click the boxplot body)
//   outliers  — `column outside whiskers`  (click an outlier dot)
//
// At most one filter per column; clicking the same selection twice toggles
// it off, clicking a different selection on the same column replaces.

export type Filter =
  | { kind: "eq"; column: string; value: string | number }
  | { kind: "iqr"; column: string; min: number; max: number }
  | { kind: "outliers"; column: string; loFence: number; hiFence: number };

function filterId(f: Filter): string {
  if (f.kind === "eq") return `${f.column}|eq|${String(f.value)}`;
  if (f.kind === "iqr") return `${f.column}|iqr`;
  return `${f.column}|outliers`;
}

export function describeFilter(f: Filter): string {
  if (f.kind === "eq") return `${f.column} = ${f.value}`;
  if (f.kind === "iqr") return `${f.column} ∈ IQR [${formatNumber(f.min)}, ${formatNumber(f.max)}]`;
  return `${f.column} outliers`;
}

function matchesFilter(row: Row, f: Filter): boolean {
  const v = row[f.column];
  if (f.kind === "eq") return v === f.value;
  if (f.kind === "iqr") return typeof v === "number" && v >= f.min && v <= f.max;
  return typeof v === "number" && (v < f.loFence || v > f.hiFence);
}

export function applyFilters(rows: Row[], filters: Filter[]): Row[] {
  if (filters.length === 0) return rows;
  return rows.filter((row) => filters.every((f) => matchesFilter(row, f)));
}

// ── UI ───────────────────────────────────────────────────────────────────────

// ── per-column header chart ──────────────────────────────────────────────────
//
// Deliberately not the usual Data Wrangler picks. Each column gets the chart
// that says the most about its shape in ~36px of vertical space:
//
//   numeric (continuous)       → horizontal boxplot + jittered outlier dots
//                                (five-number summary at a glance + tail dots)
//   categorical (≤ 5 unique)   → stacked horizontal bar, one segment per
//                                category, palette-coloured (proportions are
//                                instantly readable on a single row)
//   categorical (> 5 unique)   → stacked bar of top 5 + "other" rollup
//   high-cardinality (id-like) → "id-like · N unique" label
//   constant (single value)    → "constant" label
//
// Tooltips are themed (font, colours match the rest of the app) and the
// whole header is clickable — clicks bubble through ECharts to select the
// column.

const MINI_CHART_HEIGHT = 40;

// Categorical palette — distinct enough at small widths that a 5-segment
// stacked bar is readable. Ordered cool → warm so the bar reads like a
// gradient when categories happen to sort by frequency.
const CATEGORICAL_PALETTE_DARK = [
  "#00d68f", // primary (greenish)
  "#7aa2f7", // accent-2 (blue)
  "#bb9af7", // accent-3 (violet)
  "#ffb454", // warn (amber)
  "#ff6b6b", // error (red)
];
const CATEGORICAL_PALETTE_LIGHT = ["#009669", "#3760cc", "#7649c7", "#ae6614", "#b73a3a"];
const OTHER_COLOR_DARK = "#5a5a5a";
const OTHER_COLOR_LIGHT = "#a8a8a4";

function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (sortedAsc.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

function boxStats(values: number[]): {
  stats: [number, number, number, number, number];
  outliers: number[];
} | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const median = quantile(sorted, 0.5);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const loFence = q1 - 1.5 * iqr;
  const hiFence = q3 + 1.5 * iqr;
  const inFence = sorted.filter((v) => v >= loFence && v <= hiFence);
  const outliers = sorted.filter((v) => v < loFence || v > hiFence);
  const lo = inFence.length > 0 ? inFence[0] : sorted[0];
  const hi = inFence.length > 0 ? inFence[inFence.length - 1] : sorted[sorted.length - 1];
  return { stats: [lo, q1, median, q3, hi], outliers };
}

export type Palette = {
  primary: string;
  accent2: string;
  fg: string;
  fgMute: string;
  border: string;
  tooltipBg: string;
  categorical: string[];
  other: string;
};

export function usePalette(): Palette {
  const { resolved } = useTheme();
  if (resolved === "light") {
    return {
      primary: "#009669",
      accent2: "#3760cc",
      fg: "#181818",
      fgMute: "#5c5c5a",
      border: "#dcdad5",
      tooltipBg: "#ffffff",
      categorical: CATEGORICAL_PALETTE_LIGHT,
      other: OTHER_COLOR_LIGHT,
    };
  }
  return {
    primary: "#00d68f",
    accent2: "#7aa2f7",
    fg: "#e8e8e8",
    fgMute: "#9a9a9a",
    border: "#2a2a2a",
    tooltipBg: "#1a1a1a",
    categorical: CATEGORICAL_PALETTE_DARK,
    other: OTHER_COLOR_DARK,
  };
}

// Inline-SVG sparkline for the tooltip body. Renders a 12-bin histogram of
// the column's distribution as a row of bars so the user sees the *shape*
// alongside the five-number summary. ECharts tooltips accept arbitrary HTML
// in formatter output; an <svg> with explicit width / height is the cleanest
// way to ship a one-shot plot without a second ECharts instance.
function miniHistogramSvg(bins: number[], color: string): string {
  if (!bins || bins.length === 0) return "";
  let max = 0;
  for (const v of bins) if (v > max) max = v;
  if (max === 0) return "";
  const W = 240;
  const H = 32;
  const gap = 1;
  const barW = (W - (bins.length - 1) * gap) / bins.length;
  let bars = "";
  for (let i = 0; i < bins.length; i++) {
    // Min height of 1 so empty bins still get a visible tick rather than
    // disappearing — preserves the "where does the data live" gestalt.
    const h = bins[i] === 0 ? 1 : Math.max(2, (bins[i] / max) * H);
    const x = i * (barW + gap);
    const y = H - h;
    const opacity = bins[i] === 0 ? 0.18 : 0.85;
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" opacity="${opacity}"/>`;
  }
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" style="display:block;margin:4px 0">${bars}</svg>`;
}

// Tiny escape so user-supplied category labels can't inject markup into the
// tooltip. (Same family of concern as XSS — even though the data is local
// and never leaves the browser, well-named categories with stray < / > / &
// would break the SVG.)
function escapeForSvg(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Inline-SVG mini bar chart of a categorical column's top values. One row
// per value, label on the left, bar in the middle, count on the right.
// Used by the stacked-categorical tooltip so the user can compare top
// categories at a glance without scanning the segmented stack bar.
function miniTopValuesSvg(
  top: Array<{ value: string; count: number }>,
  color: string,
  textColor: string,
  total: number,
): string {
  if (!top || top.length === 0) return "";
  const rows = top.slice(0, 4);
  const W = 240;
  const rowH = 14;
  const gap = 3;
  const labelW = 80;
  const countW = 36;
  const barTrack = W - labelW - countW - 8;
  const H = rows.length * (rowH + gap) - gap;
  let body = "";
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const y = i * (rowH + gap);
    const frac = total > 0 ? r.count / total : 0;
    const barW = Math.max(2, frac * barTrack);
    const label = escapeForSvg(r.value.length > 12 ? `${r.value.slice(0, 11)}…` : r.value);
    body += `<text x="0" y="${y + rowH * 0.78}" font-size="10" fill="${textColor}" font-family="'SN Pro', 'Inter', sans-serif">${label}</text>`;
    body += `<rect x="${labelW}" y="${y + 3}" width="${barW.toFixed(1)}" height="${rowH - 6}" fill="${color}" opacity="0.85"/>`;
    body += `<text x="${labelW + barTrack + 4}" y="${y + rowH * 0.78}" font-size="10" fill="${textColor}" font-family="'SN Pro', 'Inter', sans-serif" text-anchor="start">${r.count}</text>`;
  }
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" style="display:block;margin:4px 0">${body}</svg>`;
}

export function tooltipFrame(p: Palette) {
  return {
    // Render the tooltip to <body> so it escapes the table's `overflow-auto`
    // and the 40px header cell — otherwise the tooltip element exists but
    // gets clipped to the chart's tiny container and you see nothing.
    appendToBody: true,
    confine: false,
    // ECharts auto-positions, but with our tooltip including a 32px SVG
    // sparkline the body can be ~110px tall. When the chart sits near the
    // top of the table scroll area, ECharts can choose to place the tooltip
    // *above* the chart and the top of the tooltip is then occluded by the
    // workstation's banner row(s) that sit visually above. A custom
    // position callback keeps the tooltip's top below the chart's top — so
    // it always paints downward into clear table-body space — while
    // remaining horizontally centred on the cursor and clamped inside the
    // chart's bounding box.
    position: (
      point: number[],
      _params: unknown,
      _dom: HTMLElement,
      _rect: unknown,
      size: { contentSize: number[]; viewSize: number[] },
    ): number[] => {
      const [w] = size.contentSize;
      const [chartW, chartH] = size.viewSize;
      let x = point[0] - w / 2;
      if (x < 0) x = 0;
      if (x + w > chartW) x = Math.max(0, chartW - w);
      // Anchor the tooltip's top just below the chart's bottom edge so its
      // body opens into the table body rather than into the banner stack.
      return [x, chartH + 4];
    },
    backgroundColor: p.tooltipBg,
    borderColor: p.border,
    borderWidth: 1,
    textStyle: { color: p.fg, fontSize: 11, fontFamily: "'SN Pro', 'Inter', sans-serif" },
    // max-width keeps long category labels from blowing out the tooltip.
    // white-space:normal lets content wrap inside that width. line-height
    // tightens row spacing so the SVG + 3 text rows stay compact.
    // z-index is intentionally very high — the page has a sticky workstation
    // header (z-10), a top-app header (z-20) and modals up to z-50; the
    // body-appended tooltip needs to clear all of them by a clear margin.
    extraCssText:
      "box-shadow: 0 2px 8px rgba(0,0,0,0.18); border-radius: 4px; z-index: 9999; max-width: 280px; white-space: normal; line-height: 1.45;",
  } as const;
}

function useMiniChartOption(meta: ColumnMeta, activeFilter: Filter | null) {
  const palette = usePalette();

  return useMemo(() => {
    // ── numeric: horizontal boxplot + outlier scatter ──
    if (
      meta.type === "number" &&
      meta.q1 !== undefined &&
      meta.q3 !== undefined &&
      meta.median !== undefined &&
      meta.boxLo !== undefined &&
      meta.boxHi !== undefined
    ) {
      const lo = meta.boxLo;
      const q1 = meta.q1;
      const median = meta.median;
      const q3 = meta.q3;
      const hi = meta.boxHi;
      const outliers = meta.outliers ?? [];
      const fmt = formatNumber;
      const nValues = meta.count - meta.missing;

      // Pad x-axis so outliers + whiskers aren't flush against the edge.
      // Build via loop instead of spread — `outliers` can be huge on real
      // parquet uploads and would otherwise blow the call stack.
      let xMin = lo;
      let xMax = hi;
      for (const v of outliers) {
        if (v < xMin) xMin = v;
        if (v > xMax) xMax = v;
      }
      const pad = (xMax - xMin) * 0.04 || 1;

      // Dim whichever artefact isn't the active selection.
      const iqrActive = activeFilter?.kind === "iqr";
      const outliersActive = activeFilter?.kind === "outliers";
      const boxOpacity = outliersActive ? 0.3 : 1;
      const outlierOpacity = iqrActive ? 0.25 : 0.9;

      return {
        animation: false,
        grid: { left: 6, right: 6, top: 4, bottom: 4, containLabel: false },
        xAxis: { type: "value", show: false, min: xMin - pad, max: xMax + pad },
        yAxis: { type: "category", show: false, data: [""] },
        tooltip: {
          trigger: "item",
          ...tooltipFrame(palette),
          formatter: (params: { seriesName?: string; data?: unknown }) => {
            if (params.seriesName === "outliers") {
              const v = Array.isArray(params.data) ? Number(params.data[0]) : Number(params.data);
              return `<b>outlier</b> · ${fmt(v)}<br/><span style="opacity:0.6">click to filter to outliers</span>`;
            }
            // Compact layout: header → mini histogram → five-number summary
            // → counts → click hint. The SVG is block-level (margin-top/
            // bottom built in) so we don't wrap it in a <br/>.
            const sparkline = miniHistogramSvg(meta.histogramBins ?? [], palette.primary);
            return [
              `<b>${meta.name}</b>${sparkline}`,
              `min ${fmt(lo)} · Q1 ${fmt(q1)} · med ${fmt(median)} · Q3 ${fmt(q3)} · max ${fmt(hi)}`,
              `<span style="opacity:0.6">n=${nValues} · outliers=${outliers.length}</span>`,
              `<span style="opacity:0.6">click to filter to IQR</span>`,
            ].join("<br/>");
          },
        },
        series: [
          {
            type: "boxplot",
            data: [[lo, q1, median, q3, hi]],
            itemStyle: {
              color: palette.primary,
              borderColor: palette.primary,
              borderWidth: 1,
              opacity: boxOpacity,
            },
            boxWidth: ["60%", "75%"],
            emphasis: { itemStyle: { borderColor: palette.fg, borderWidth: 1.5, opacity: 1 } },
          },
          {
            name: "outliers",
            type: "scatter",
            data: outliers.map((v) => [v, 0]),
            symbolSize: 5,
            itemStyle: { color: palette.accent2, opacity: outlierOpacity },
            emphasis: { itemStyle: { color: palette.accent2, opacity: 1 } },
          },
        ],
      };
    }

    // ── categorical: stacked horizontal bar (top 5 + other) ──
    if (meta.topValues && meta.topValues.length > 0) {
      const total = meta.count - meta.missing;
      const cap = 5;
      const top = meta.topValues.slice(0, cap);
      const topSum = top.reduce((s, v) => s + v.count, 0);
      const otherCount = Math.max(0, total - topSum);
      const segments: Array<{ name: string; count: number; color: string }> = top.map((v, i) => ({
        name: v.value,
        count: v.count,
        color: palette.categorical[i % palette.categorical.length],
      }));
      if (otherCount > 0 && meta.topValues.length > cap) {
        segments.push({ name: "other", count: otherCount, color: palette.other });
      }
      const activeValue = activeFilter?.kind === "eq" ? String(activeFilter.value) : null;

      return {
        animation: false,
        grid: { left: 6, right: 6, top: 6, bottom: 6, containLabel: false },
        xAxis: { type: "value", show: false, max: total },
        yAxis: { type: "category", show: false, data: [""] },
        tooltip: {
          trigger: "item",
          ...tooltipFrame(palette),
          formatter: (params: { seriesName?: string; value?: unknown }) => {
            const name = params.seriesName ?? "";
            const v = Array.isArray(params.value) ? Number(params.value[0]) : Number(params.value);
            const pct = total > 0 ? (100 * v) / total : 0;
            const hint =
              name === "other"
                ? "(roll-up; not click-filterable)"
                : "click to filter to this value";
            // Same layout as the numeric tooltip: header → mini plot →
            // hovered value → counts → hint. The mini plot lists the top
            // 4 categories side-by-side so the user can see how this
            // segment ranks even without leaving the column header.
            const sparkline = miniTopValuesSvg(
              meta.topValues ?? [],
              palette.primary,
              palette.fgMute,
              total,
            );
            return [
              `<b>${meta.name}</b>${sparkline}`,
              `${escapeForSvg(name)}: ${v} (${pct.toFixed(1)}%)`,
              `<span style="opacity:0.6">n=${total}</span>`,
              `<span style="opacity:0.6">${hint}</span>`,
            ].join("<br/>");
          },
        },
        // Build one bar series per segment so each is hover-able / clickable
        // and gets its own tooltip — sharing a single series with multiple
        // data points collapses all hovers onto the same tooltip.
        series: segments.map((s) => ({
          name: s.name,
          type: "bar",
          stack: "all",
          data: [s.count],
          barWidth: "60%",
          itemStyle: {
            color: s.color,
            // Dim non-selected segments when an `eq` filter is active.
            opacity: activeValue === null || activeValue === s.name ? 1 : 0.25,
          },
          emphasis: { focus: "series", itemStyle: { color: s.color, opacity: 1 } },
        })),
      };
    }
    return null;
  }, [meta, activeFilter, palette]);
}

type EChartsClickParams = {
  seriesType?: string;
  seriesName?: string;
  data?: unknown;
  value?: unknown;
};

function MiniColumnChart({
  meta,
  activeFilter,
  onFilter,
}: {
  meta: ColumnMeta;
  activeFilter: Filter | null;
  onFilter: (f: Filter) => void;
}) {
  const option = useMiniChartOption(meta, activeFilter);
  const uniquePct = meta.count > 0 ? meta.unique / meta.count : 0;

  const onChartClick = useMemo(
    () => (params: EChartsClickParams) => {
      if (meta.type === "number") {
        if (params.seriesType === "boxplot" && meta.q1 !== undefined && meta.q3 !== undefined) {
          onFilter({ kind: "iqr", column: meta.name, min: meta.q1, max: meta.q3 });
        } else if (
          params.seriesType === "scatter" &&
          meta.loFence !== undefined &&
          meta.hiFence !== undefined
        ) {
          onFilter({
            kind: "outliers",
            column: meta.name,
            loFence: meta.loFence,
            hiFence: meta.hiFence,
          });
        }
      } else {
        const name = params.seriesName;
        if (name && name !== "other") {
          // Recover the original-typed value from topValues so we don't end
          // up with `eq` filters on stringified numbers when the column is
          // numeric-coded categorical (e.g. origin_year-as-bucket).
          const original = meta.topValues?.find((v) => v.value === name)?.value ?? name;
          onFilter({ kind: "eq", column: meta.name, value: original });
        }
      }
    },
    [meta, onFilter],
  );

  // Degenerate cases — show a tiny label instead of an empty plot.
  if (meta.unique <= 1) {
    return (
      <div
        className="flex items-center justify-center font-mono text-[9px] text-fg-dim"
        style={{ height: MINI_CHART_HEIGHT }}
        title="constant column — all rows have the same value"
      >
        constant
      </div>
    );
  }
  if (meta.type === "string" && uniquePct >= 0.8) {
    return (
      <div
        className="flex items-center justify-center font-mono text-[9px] text-fg-dim"
        style={{ height: MINI_CHART_HEIGHT }}
        title={`id-like column — ${meta.unique} of ${meta.count} rows are unique`}
      >
        id-like · {meta.unique} unique
      </div>
    );
  }
  if (!option) {
    return <div style={{ height: MINI_CHART_HEIGHT }} />;
  }

  return (
    <div className="px-1" style={{ height: MINI_CHART_HEIGHT, width: "100%" }}>
      <ReactECharts
        echarts={echarts}
        option={option}
        notMerge
        lazyUpdate
        onEvents={{ click: onChartClick }}
        style={{ height: MINI_CHART_HEIGHT, width: "100%" }}
      />
    </div>
  );
}

function TypeChip({ type }: { type: ColumnType }) {
  const label = type === "number" ? "123" : type === "date" ? "📅" : "abc";
  const cls =
    type === "number" ? "text-accent-2" : type === "date" ? "text-accent-3" : "text-fg-mute";
  return <span className={`font-mono text-[9px] uppercase tracking-wider ${cls}`}>{label}</span>;
}

// Wraps the list-item button with a hover region that anchors a small
// chat popover. Each column gets its own thread (memory-keyed when a
// project is active). The popover has a hover-bridge close behaviour:
// staying open while the mouse is over either the row OR the popover
// itself, and while the input has focus. ~200 ms close delay so
// brushing past the row doesn't dismiss it.
const PAGE_SIZE = 50;

function DataGrid({
  dataset,
  rows,
  columnMetas,
  filters,
  onFilter,
  selectedColumn,
  onSelectColumn,
  derivedColumnNames,
}: {
  dataset: Dataset;
  rows: Row[];
  columnMetas: ColumnMeta[];
  filters: Filter[];
  onFilter: (f: Filter) => void;
  selectedColumn: string | null;
  onSelectColumn: (name: string) => void;
  derivedColumnNames: Set<string>;
}) {
  const metaByName = useMemo(() => {
    const map = new Map<string, ColumnMeta>();
    for (const m of columnMetas) map.set(m.name, m);
    return map;
  }, [columnMetas]);
  const filterByColumn = useMemo(() => {
    const map = new Map<string, Filter>();
    for (const f of filters) map.set(f.column, f);
    return map;
  }, [filters]);
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const start = safePage * PAGE_SIZE;
  const slice = rows.slice(start, start + PAGE_SIZE);

  // Reset to page 0 when the dataset identity changes (load sample / import).
  // biome-ignore lint/correctness/useExhaustiveDependencies: only dataset.name should retrigger this; row-count changes from filter narrowing are handled below.
  useEffect(() => {
    setPage(0);
  }, [dataset.name]);
  // If the active page has fallen off the end because filters shrank the
  // dataset, snap back to the last valid page.
  useEffect(() => {
    setPage((p) => Math.min(p, Math.max(0, totalPages - 1)));
  }, [totalPages]);

  // Per-column hover chat — hovering the `<th>` opens a scoped popover. State
  // lives at the grid level (rather than on each `<th>`) so we share one close
  // timer across all headers; moving from one column to another cancels the
  // pending close on the previous, giving a smooth slide between popovers.
  const [hoveredCol, setHoveredCol] = useState<string | null>(null);
  const [hoverAnchor, setHoverAnchor] = useState<DOMRect | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setHoveredCol(null), 220);
  }, [cancelClose]);
  useEffect(() => cancelClose, [cancelClose]);

  const hoveredMeta = hoveredCol ? (metaByName.get(hoveredCol) ?? null) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto rounded border border-border bg-bg">
        <table className="w-full border-collapse font-mono text-xs">
          <thead className="sticky top-0 z-10 bg-bg-1">
            <tr>
              <th className="border-b border-border px-2 py-1.5 text-right text-[10px] text-fg-dim">
                #
              </th>
              {dataset.columns.map((c) => {
                const meta = metaByName.get(c);
                const activeFilter = filterByColumn.get(c) ?? null;
                const filtered = activeFilter !== null;
                const isDerived = derivedColumnNames.has(c);
                return (
                  <th
                    key={c}
                    onMouseEnter={(e) => {
                      cancelClose();
                      setHoveredCol(c);
                      setHoverAnchor(e.currentTarget.getBoundingClientRect());
                    }}
                    onMouseLeave={scheduleClose}
                    className={`border-b border-l border-border p-0 text-left align-bottom ${
                      filtered ? "bg-primary/10" : selectedColumn === c ? "bg-bg-2" : ""
                    }`}
                    style={{ minWidth: 96 }}
                  >
                    <div className="flex flex-col">
                      {meta && (
                        <div className="border-b border-border/60 pt-1">
                          <MiniColumnChart
                            meta={meta}
                            activeFilter={activeFilter}
                            onFilter={onFilter}
                          />
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => onSelectColumn(c)}
                        className={`flex w-full cursor-pointer items-center justify-between gap-1 px-2 py-1.5 text-left text-[10px] ${
                          filtered
                            ? "text-primary"
                            : selectedColumn === c
                              ? "text-primary"
                              : "text-fg-mute hover:bg-bg-2"
                        }`}
                        title={
                          activeFilter
                            ? `filter active: ${describeFilter(activeFilter)}`
                            : undefined
                        }
                      >
                        <span className="flex min-w-0 items-center gap-1 truncate">
                          {filtered && (
                            <span
                              aria-hidden
                              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                            />
                          )}
                          <span className="truncate">{c}</span>
                          {isDerived && (
                            <span
                              title="derived column (added via a formula)"
                              className="shrink-0 font-mono text-[10px] italic text-primary"
                            >
                              ƒ
                            </span>
                          )}
                        </span>
                        {meta && <TypeChip type={meta.type} />}
                      </button>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {slice.map((row, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional in an immutable paginated slice; there's no primary key to use.
              <tr key={start + i} className="odd:bg-bg even:bg-bg-1">
                <td className="border-b border-border px-2 py-1 text-right text-[10px] text-fg-dim">
                  {start + i + 1}
                </td>
                {dataset.columns.map((c) => {
                  const v = row[c];
                  return (
                    <td
                      key={c}
                      className={`border-b border-l border-border px-2 py-1 ${
                        v === null
                          ? "text-error/70 italic"
                          : selectedColumn === c
                            ? "text-fg"
                            : "text-fg-mute"
                      } ${typeof v === "number" ? "text-right" : "text-left"}`}
                    >
                      {v === null ? "null" : fmtCell(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex shrink-0 items-center justify-between border-t border-border bg-bg-1 px-2 py-1 font-mono text-[10px] text-fg-mute">
        <span>
          {rows.length === 0
            ? "no rows match current filters"
            : `rows ${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} of ${rows.length}`}
          {filters.length > 0 && (
            <span className="text-fg-dim"> · filtered from {dataset.rows.length}</span>
          )}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={safePage === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="rounded border border-border px-1.5 py-0.5 hover:border-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            prev
          </button>
          <span>
            {safePage + 1} / {totalPages}
          </span>
          <button
            type="button"
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            className="rounded border border-border px-1.5 py-0.5 hover:border-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            next
          </button>
        </div>
      </div>
      {hoveredMeta && hoverAnchor && (
        <ColumnChatPopover
          meta={hoveredMeta}
          anchor={hoverAnchor}
          onEnter={cancelClose}
          onLeave={scheduleClose}
          onClose={() => setHoveredCol(null)}
        />
      )}
    </div>
  );
}

// Per-stage chatbot context. The static role frame stays constant; the
// dataset + filter situation is appended by `buildStageContext` so the LLM
// answers in the user's current slice rather than the abstract.
//
// The frame embeds the traditional column-by-column cleaning playbook as
// SILENT BACKGROUND KNOWLEDGE the bot consults to pick the right step.
// It is not for recitation: when the user names a direct action, the bot
// answers with one banner op or one formula and stops. The playbook only
// surfaces explicitly when the user asks an open-ended question.
const SOFT_STAGE_FRAME = [
  "You are Scelo at the SOFT DATA stage. Help the user describe, validate, and clean their dataset.",
  "Stay focused on intake. Do not jump ahead to model choice or final results.",
  "When the user references 'this slice' or 'this view', interpret it as the dataset filtered by the FILTERS block below.",
  "",
  "## ANSWER SHAPE (read this first, follow it strictly)",
  "Reply in 1 to 4 short sentences plus a code block, banner-op pointer, or viz block as needed. Lead with the action, not with background. No preamble, no recap, no checklist unless the user explicitly asks for the cleaning playbook.",
  "When the user names a direct action (round, lowercase, trim, drop, log, clip, impute, parse, encode, etc.), name ONE banner op or ONE formula and stop. Do not list alternatives. Do not mention train/test discipline, sanity checks, or playbook sections unless asked.",
  "When the user asks an open question ('what's wrong with my data?', 'where should I start?'), pick the SINGLE most useful next step from the cleaning-banner suggestions or the column stats and propose it. Offer the full playbook only if asked.",
  "",
  "## OUTPUT CHARACTERS (strict)",
  "Reply in plain ASCII punctuation only: straight apostrophes ('), straight double quotes (\"), plain hyphens (-), three dots (...). DO NOT emit smart curly quotes, em-dash, en-dash, ellipsis character, non-breaking space, or any other typographic Unicode. They render as replacement glyphs in this chat surface. When you need to quote an example value (a sentinel string like ?, N/A, or -), wrap it in backticks for code, never in curly quotes.",
  "",
  "## SHARED VOCABULARY (these are TOOLS, not text, pick one and emit it)",
  "Banner ops (string match these exactly): trim whitespace · collapse internal whitespace · fix encoding artefacts · normalise missing markers · parse numeric strings · parse date strings · standardise booleans · replace sentinel numerics · merge case-only duplicates · rename to snake_case · drop near-empty columns · drop constant columns · drop duplicate rows.",
  "",
  "Derived columns: when the user asks for any per-row transformation (round, log, sqrt, abs, clip, cap, normalise, bin, extract, derive, compute, calculate, etc.), DO NOT describe the formula. EMIT a fenced `derive` block. The client compiles the formula and adds the new column to the dataset IMMEDIATELY, so the user sees the result without copy-pasting anything.",
  "",
  "Format:",
  "```derive",
  '{"name": "<new_column_name>", "formula": "<expression>"}',
  "```",
  "",
  "Grammar inside the formula: bare arithmetic (+, -, *, /, %, **), bare function names log / log10 / log2 / exp / sqrt / abs / min / max / floor / ceil / round / pow / sign, plus if(cond, a, b) and coalesce(a, b, ...). Reference columns as bare identifiers (paid, incurred). DO NOT prefix functions with \"Math.\" and DO NOT wrap column names in backticks: the parser only accepts the bare form. The new name must be a fresh snake_case identifier.",
  "After the block, write at most ONE short sentence of context.",
  "",
  "## EXAMPLES (match this shape exactly)",
  "User: round the paid column",
  "Reply:",
  "```derive",
  '{"name": "paid_rounded", "formula": "round(paid)"}',
  "```",
  "",
  "User: drop empties",
  "Reply: Enable `drop near-empty columns` in the cleaning banner.",
  "",
  "User: log-transform incurred",
  "Reply:",
  "```derive",
  '{"name": "incurred_log", "formula": "log(incurred + 1)"}',
  "```",
  "+1 keeps zero rows finite.",
  "",
  "User: what should I clean first?",
  "Reply: Pick the top suggestion from the banner. If the banner is empty, the dataset is already in decent shape, move on to Tools.",
  "",
  "## REFERENCE PLAYBOOK (silent background knowledge, do NOT recite)",
  "STRUCTURAL: drop irrelevant cols · rename to snake_case · cast right dtype · set right index.",
  "STRING: fix-encoding → trim → collapse-ws → normalise case → normalise punctuation → null sentinel strings → standardise labels → fix typos (fuzzy, after lowercasing) → split compound fields → regex cleanup → validate allowed set.",
  "NUMERIC: strip non-numeric chars → coerce dtype → null sentinel numerics (-999 etc) → enforce valid ranges → clip/winsorize errors (not signal) → unit consistency → round precision.",
  "DATETIME: parse to datetime → reconcile mixed DD/MM vs MM/DD → standardise timezone (UTC) → handle invalid dates → ISO 8601.",
  "BOOLEAN: Y/N · yes/no · 1/0 · on/off → true/false.",
  "MISSING: quantify → drop-column vs drop-row vs impute → pick imputer (mean/median/mode/constant/ffill/interp/KNN/model) → consider was_missing indicator when informative.",
  "OUTLIERS: detect (IQR / z-score / domain rule) → keep / cap / transform / null.",
  "ROW-LEVEL: drop exact duplicates · drop near-duplicates after normalisation · drop rows with critical fields missing.",
  "SANITY (run AFTER cleaning): dtypes, isna().sum(), nunique(), describe(), value_counts(), row-count delta, manual spot-check.",
  "DISCIPLINE: clean before splitting only for row-local deterministic ops. Anything that LEARNS from data (imputation values, outlier thresholds, encoder vocabs, scaler stats) must be FIT ON TRAIN ONLY. Mention this only when the user asks about modelling or splitting.",
].join("\n");

// Instructs Scelo to emit machine-readable viz specs in fenced ```viz blocks
// when the user asks for a plot, chart, or table. The actual values are
// computed client-side from the dataset (`chatViz.tsx`), so the LLM only
// needs to pick the right columns and aggregation — it doesn't have to
// hallucinate numbers. The grammar is intentionally tiny.
const VIZ_INSTRUCTIONS = `
RENDERING CHARTS AND TABLES
When the user asks for a plot / chart / graph / visualisation, OR for a table / breakdown / value counts, you MUST emit a fenced \`\`\`viz block with one of the JSON specs below. Do NOT ask for confirmation if a sensible column choice is obvious from the dataset and the user's wording — just pick it and emit the spec. You can include a one-line preamble before the spec but keep it short.

Chart spec (one of seven kinds — pick by data type, NOT default to bar):
\`\`\`viz
{"type":"chart","kind":"bar"|"line"|"pie"|"scatter"|"heatmap"|"corr"|"map","x":"<col>","y":"<col>"|null,"columns":["<col>","<col>",...],"agg":"count"|"sum"|"mean"|"median","valueCol":"<col>"|null,"title":"<title>","limit":20}
\`\`\`

Picking the right \`kind\` (BY DATA TYPE, NOT BY USER WORDING):
- categorical breakdown (counts / shares per category)            → "bar"     · uses x; agg defaults to count
- numeric column ordered by time / index                          → "line"    · uses x (year/order), y (value)
- share-of-total with ≤8 categories                               → "pie"     · uses x
- relationship between TWO NUMERIC columns                        → "scatter" · uses x, y (both numeric); the renderer adds the Pearson r in the corner automatically
- crosstab / contingency of TWO CATEGORICAL columns               → "heatmap" · uses x and y (both categorical); cell=count by default
- Pearson correlation matrix between ≥2 NUMERIC columns           → "corr"    · uses \`columns\` (list of ≥2 numeric col names)
- 2D MAP of a GEOGRAPHIC column (provinces / states / regions)    → "map"     · uses x=<geographic column>; y optional (numeric column to aggregate per region)

CORRELATION REQUESTS — disambiguate by the columns involved, NEVER refuse:
- "correlation between paid and age" (two numeric cols)           → scatter (x="age", y="paid"). The r value is shown automatically — do NOT use "corr" for just two columns.
- "correlation matrix" (no columns specified)                     → corr with ALL numeric columns from COLUMNS below.
- "correlation matrix of paid, incurred, age" (3+ numeric)        → corr with columns=["paid","incurred","age"].
- "correlation between gender and province" (two categorical)     → heatmap with x=sex, y=state (this is a contingency table, not Pearson — Pearson is undefined for categoricals).
- "correlation between paid and region" (numeric × categorical)   → bar with x=region, y=paid, agg=mean (group-mean comparison is the meaningful analogue).

GEOGRAPHIC REQUESTS — TREAT THESE AS "kind":"map" UNLESS THE USER EXPLICITLY ASKS FOR A "bar chart" OR "table":
The renderer is backed by Natural Earth data and picks between THREE pre-registered maps by inspecting the data:
  • "world" — 177 country polygons (Natural Earth 1:110m). Triggered when values are country names ("United States", "Kenya"…) or ISO 2/3-letter codes (US/USA, KE/KEN).
  • "US"    — 51 US states + DC (Natural Earth 1:110m). Triggered when values are US state codes (CA, NY, TX…) or full state names.
  • "ZA"    — 9 SA provinces (Natural Earth 1:50m admin1). Triggered when values are SA province codes (WC/NC/EC/FS/KZN/NW/GP/MP/LP) or full names ("Western Cape", "Gauteng", …).

You do NOT pick the region — emit \`kind: "map"\` and the renderer auto-detects. Anything the user phrases as "on a map", "as a map", "2D map", "flat map", "geographic plot", "show on the map", "plot countries / states / provinces", "by region geographically", etc. MUST use \`kind: "map"\`. Do NOT fall back to "bar" for geographic requests.
- "plot countries by claim count on a map"                                   → {"type":"chart","kind":"map","x":"country"}  (count is the default)
- "plot total paid by country on a map"                                      → {"type":"chart","kind":"map","x":"country","y":"paid","agg":"sum"}
- "claims by US state on a map"                                              → {"type":"chart","kind":"map","x":"state","y":"paid","agg":"sum"}
- "plot the SA provinces on a map" / "frequency of claims by province"       → {"type":"chart","kind":"map","x":"state"}  — renders the 9 SA provinces with real Natural Earth polygons, coloured by row count

The renderer canonicalises every input (country name, ISO 2/3-letter code, US state code/name, SA province code/name) before drawing.

Other examples:
- "claims by year" → line with x=origin_year, y=paid (or omit y for count)
- "share by line of business" → pie with x=line
- "paid vs incurred" → scatter with x=incurred, y=paid

ALWAYS emit a complete spec with \`type\` AND \`kind\`. Do not omit \`type\`. Do not invent kinds (e.g. "matrix", "histogram") — they will be normalised but you should use the canonical names listed above.

Table spec (grouped):
\`\`\`viz
{"type":"table","groupBy":"<col>","columns":[{"col":"<col>","agg":"count"|"sum"|"mean"|"median","label":"<label>"}],"title":"<title>","limit":20}
\`\`\`

Table spec (raw rows):
\`\`\`viz
{"type":"table","columns":[{"col":"<col>"}],"title":"<title>","limit":20}
\`\`\`

Use ONLY column names from the COLUMNS list below. The user word "provinces" → the column named like \`state\`/\`province\`/\`region\`. The user word "year(s)" → \`origin_year\` / \`year\`. The user word "gender" → \`sex\`/\`gender\`. Do not invent columns.
`.trim();

function describeColumnForLLM(m: ColumnMeta): string {
  const fmt = formatNumber;
  if (m.type === "number") {
    const parts: string[] = [];
    if (m.min !== undefined) parts.push(`min=${fmt(m.min)}`);
    if (m.mean !== undefined) parts.push(`mean=${fmt(m.mean)}`);
    if (m.median !== undefined) parts.push(`median=${fmt(m.median)}`);
    if (m.max !== undefined) parts.push(`max=${fmt(m.max)}`);
    if (m.q1 !== undefined && m.q3 !== undefined) {
      parts.push(`IQR=[${fmt(m.q1)}, ${fmt(m.q3)}]`);
    }
    if (m.outliers) parts.push(`outliers=${m.outliers.length}`);
    return `numeric · ${parts.join(", ")}`;
  }
  if (m.topValues && m.topValues.length > 0) {
    const top = m.topValues
      .slice(0, 5)
      .map((v) => `${v.value}=${v.count}`)
      .join(", ");
    return `categorical · ${m.unique} unique · top: ${top}`;
  }
  return `${m.type}`;
}

function buildStageContext(args: {
  dataset: Dataset | null;
  filters: Filter[];
  filteredRows: Row[];
  selectedMeta: ColumnMeta | null;
}): string {
  const { dataset, filters, filteredRows, selectedMeta } = args;
  const lines: string[] = [SOFT_STAGE_FRAME, ""];

  if (!dataset) {
    lines.push("CURRENT STATE: no dataset is loaded.");
    return lines.join("\n");
  }

  lines.push(
    `DATASET: \`${dataset.name}\` — ${dataset.rows.length} rows, ${dataset.columns.length} columns.`,
  );
  lines.push(`COLUMNS: ${dataset.columns.join(", ")}.`);

  if (filters.length === 0) {
    lines.push("FILTERS: none — viewing the full dataset.");
  } else {
    lines.push(`FILTERS (AND'ed, ${filters.length} active):`);
    for (const f of filters) lines.push(`  • ${describeFilter(f)}`);
    const pct = dataset.rows.length > 0 ? (100 * filteredRows.length) / dataset.rows.length : 0;
    lines.push(
      `FILTERED SLICE: ${filteredRows.length} of ${dataset.rows.length} rows (${pct.toFixed(1)}%).`,
    );
  }

  if (selectedMeta) {
    const m = selectedMeta;
    const summary = describeColumnForLLM(m);
    const missing =
      m.missing > 0
        ? ` · missing ${m.missing}/${m.count} (${((100 * m.missing) / m.count).toFixed(1)}%)`
        : "";
    lines.push(
      `RIGHT PANEL FOCUS: \`${m.name}\` (${summary})${missing}. Stats reflect the current slice.`,
    );
  }

  lines.push("", VIZ_INSTRUCTIONS);
  return lines.join("\n");
}

// Thin wrappers for the two divs that previously tripped the a11y linter:
//   • Backdrop captures click-outside-to-dismiss. Keyboard dismiss is via the
//     document-level Escape handler in StageChatbar, so a key handler here
//     would just be redundant.
//   • Panel stops click propagation so taps inside the dialog don't close it.
// Pulling these out lets the targeted biome-ignore comments live next to the
// JSX they refer to, without polluting the parent.
function ChatModalBackdrop({
  onDismiss,
  children,
}: {
  onDismiss: () => void;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard dismissal is handled at the document level via Escape in StageChatbar.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/30 backdrop-blur-md"
      onClick={onDismiss}
    >
      {children}
    </div>
  );
}

function ChatModalPanel({ children }: { children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation only — no user-visible action.
    <div
      className="flex h-[80vh] w-[80vw] max-w-5xl flex-col overflow-hidden rounded-lg border border-border bg-bg-1 shadow-2xl"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

// Sample-dataset picker. Opens when the user clicks "load sample" in the
// toolbar (or "Load sample" on the empty-state screen). Shows one card per
// entry in `SAMPLE_OPTIONS` — currently the synthetic claims set and the
// climate reanalysis ensemble — so the user can pick which kind of work
// they want to demo without us hard-coding one default. Matches the chat
// modal's backdrop-blur + 80×80 frame so the modal family stays consistent.
function SampleLibraryModal({
  open,
  onPick,
  onDismiss,
}: {
  open: boolean;
  onPick: (key: SampleKey) => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onDismiss]);

  if (!open) return null;

  return (
    <ChatModalBackdrop onDismiss={onDismiss}>
      <ChatModalPanel>
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-bg-1 px-5 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-accent-2">
              <span
                aria-hidden
                className="inline-block h-1 w-1 rounded-full bg-current opacity-70"
              />
              <span>sample library</span>
            </div>
            <h2 className="mt-1 text-base font-medium text-fg">
              Pick a dataset to load into the workstation
            </h2>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="close sample picker"
            className="flex shrink-0 items-center gap-1.5 rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-fg-mute hover:border-error hover:text-error"
          >
            close
            <span className="rounded border border-border bg-bg px-1 text-[9px] text-fg-dim">
              esc
            </span>
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {SAMPLE_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => onPick(opt.key)}
                className={`group rounded-2xl border border-border bg-bg-1 p-5 text-left transition hover:border-fg-dim focus:outline-none ${
                  opt.accent === "accent-2"
                    ? "focus:border-accent-2"
                    : opt.accent === "warn"
                      ? "focus:border-warn"
                      : opt.accent === "accent-3"
                        ? "focus:border-accent-3"
                        : "focus:border-error"
                }`}
              >
                <div
                  className={`flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] ${
                    opt.accent === "accent-2"
                      ? "text-accent-2"
                      : opt.accent === "warn"
                        ? "text-warn"
                        : opt.accent === "accent-3"
                          ? "text-accent-3"
                          : "text-error"
                  }`}
                >
                  <span
                    aria-hidden
                    className="inline-block h-1 w-1 rounded-full bg-current opacity-70"
                  />
                  <span>{opt.badge}</span>
                </div>
                <h3 className="mt-3 text-lg font-medium leading-tight text-fg">{opt.title}</h3>
                <p className="mt-1 text-xs leading-relaxed text-fg-mute">{opt.subtitle}</p>
                <p className="mt-4 text-[12px] leading-relaxed text-fg-mute">{opt.blurb}</p>
                <div className="mt-5 flex items-baseline justify-between">
                  <span className="font-mono text-[10px] tracking-wider text-fg-dim">
                    {opt.rows} rows · {opt.cols} cols
                  </span>
                  <span
                    aria-hidden
                    className="font-mono text-[11px] text-fg-dim transition group-hover:text-fg"
                  >
                    load →
                  </span>
                </div>
              </button>
            ))}
          </div>
          <p className="mt-4 font-mono text-[10px] leading-relaxed text-fg-dim">
            More samples can be added by extending the `SAMPLE_OPTIONS` array in
            `SoftDataWorkstation.tsx`. Real CSV / Parquet files load via the toolbar's
            <span className="text-fg-mute"> "import csv / parquet"</span> button.
          </p>
        </div>
      </ChatModalPanel>
    </ChatModalBackdrop>
  );
}

// Drag-and-drop file picker. Same modal frame as SampleLibraryModal so
// the two intake paths feel like siblings. Drop a file onto the dashed
// canvas, or click it to open the OS file picker — either path calls
// `onFile(file)` and closes. ESC + outside-click dismiss.
function ImportFileModal({
  open,
  onFile,
  onDismiss,
}: {
  open: boolean;
  onFile: (file: File) => void | Promise<void>;
  onDismiss: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onDismiss]);

  // Reset transient drag state whenever the modal opens — otherwise the
  // dashed highlight can stick on if the user dismissed mid-hover.
  useEffect(() => {
    if (open) setDragging(false);
  }, [open]);

  if (!open) return null;

  const handleDrop = (e: React.DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void onFile(file);
  };

  return (
    <ChatModalBackdrop onDismiss={onDismiss}>
      <ChatModalPanel>
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-bg-1 px-5 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-accent-2">
              <span
                aria-hidden
                className="inline-block h-1 w-1 rounded-full bg-current opacity-70"
              />
              <span>import file</span>
            </div>
            <h2 className="mt-1 text-base font-medium text-fg">
              Drop a CSV or Parquet file, or browse for one
            </h2>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="close import picker"
            className="flex shrink-0 items-center gap-1.5 rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-fg-mute hover:border-error hover:text-error"
          >
            close
            <span className="rounded border border-border bg-bg px-1 text-[9px] text-fg-dim">
              esc
            </span>
          </button>
        </header>
        <div className="flex min-h-0 flex-1 items-center justify-center px-5 py-6">
          {/* The drop zone is a button so click-to-browse and drop-to-load
              share one element; we lean on `<input type=file>` hidden
              behind it for the file dialog. */}
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={`flex w-full max-w-2xl flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-8 py-12 transition ${
              dragging ? "border-fg-mute bg-bg/60" : "border-border bg-bg-1 hover:border-fg-dim"
            }`}
          >
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-dim">
              {dragging ? "release to load" : "drag a file in"}
            </span>
            <span className="font-mono text-sm text-fg-mute">or click to browse</span>
            <span className="mt-2 font-mono text-[10px] text-fg-dim">
              .csv · .parquet — column types are detected automatically
            </span>
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv,.parquet,application/parquet,application/x-parquet,application/octet-stream"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onFile(file);
              // Reset so the same file can be re-selected if needed.
              e.target.value = "";
            }}
          />
        </div>
      </ChatModalPanel>
    </ChatModalBackdrop>
  );
}

// ── top-level workstation ────────────────────────────────────────────────────

export function SoftDataWorkstation() {
  const navigate = useNavigate();
  // Dataset + filters live in the Scelo-wide context so Tools / Hard can
  // read them after the user has loaded data here.
  const {
    dataset,
    setDataset,
    filters,
    setFilters,
    derivedColumns,
    setDerivedColumns,
    setTransformLog,
    logEvent,
    clearEvents,
  } = useScelo();
  // Reset the derived-columns registry and in-place transform log whenever
  // a fresh dataset replaces the current one. A derived formula on the
  // old schema won't apply to the new columns and shouldn't appear in
  // the badge list; an in-place transform fingerprint from the old
  // dataset shouldn't suppress a fresh application on the new one.
  const datasetNameForReset = dataset?.name ?? "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: only react to dataset identity changes.
  useEffect(() => {
    setDerivedColumns({});
    setTransformLog(new Set());
  }, [datasetNameForReset]);

  const addDerivedColumn = useCallback(
    (name: string, formula: string): { ok: true } | { ok: false; error: string } => {
      if (!dataset) return { ok: false, error: "No dataset loaded." };
      const nameError = validateColumnName(name, dataset.columns);
      if (nameError) return { ok: false, error: nameError };
      let compiled: ReturnType<typeof compileFormula>;
      try {
        compiled = compileFormula(formula, dataset.columns);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      const newRows: Row[] = dataset.rows.map((r) => ({
        ...r,
        [name]: compiled.evaluate(r),
      }));
      setDataset({
        name: dataset.name,
        columns: [...dataset.columns, name],
        rows: newRows,
      });
      setDerivedColumns((prev) => ({ ...prev, [name]: formula }));
      logEvent({ stage: "soft", kind: "derived.add", payload: { name, formula } });
      return { ok: true };
    },
    [dataset, setDataset, setDerivedColumns, logEvent],
  );
  // No auto-load on first mount — the empty state shows two centred
  // buttons ("import csv / parquet" + "load sample") so the user picks a
  // dataset deliberately. If a dataset is already in the shared Scelo
  // context (e.g. the user came back from /tools or /hard), it stays.
  const [selected, setSelected] = useState<string | null>(null);
  // Keep `selected` in sync when the dataset changes (auto-load, import, clear).
  useEffect(() => {
    if (!dataset) {
      setSelected(null);
    } else if (!selected || !dataset.columns.includes(selected)) {
      setSelected(dataset.columns[0] ?? null);
    }
  }, [dataset, selected]);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // All filters applied — used for the data grid body, the chatbar context,
  // and the right-panel summary so the user sees their drilled-down slice.
  const filteredRows = useMemo(
    () => (dataset ? applyFilters(dataset.rows, filters) : []),
    [dataset, filters],
  );

  // Per-column header charts compute against rows filtered by OTHER columns'
  // filters — not the column's own filter — so the filtering column still
  // shows the full distribution with the active selection highlighted, while
  // other columns reflect the drilled-down slice. (Tableau / Looker / Data
  // Wrangler all do this.)
  const columnMetas = useMemo<ColumnMeta[]>(() => {
    if (!dataset) return [];
    return dataset.columns.map((c) => {
      const others = filters.filter((f) => f.column !== c);
      const rowsForCol = others.length === 0 ? dataset.rows : applyFilters(dataset.rows, others);
      return summarise(rowsForCol, c);
    });
  }, [dataset, filters]);

  const selectedMeta = useMemo(
    () => columnMetas.find((m) => m.name === selected) ?? columnMetas[0] ?? null,
    [columnMetas, selected],
  );

  // Stable Set of derived-column names so the grid can flag them with a ƒ
  // badge in the column header without re-deriving from the object on every
  // render of every header cell.
  const derivedColumnNameSet = useMemo(
    () => new Set(Object.keys(derivedColumns)),
    [derivedColumns],
  );

  // ── cleaning ─────────────────────────────────────────────────────────────
  // Plan is re-derived from the *raw* (unfiltered) dataset, because cleaning
  // is a dataset-wide operation, not a slice operation. We compute against
  // raw metas, which we summarise separately so the plan doesn't shift when
  // the user toggles a filter on/off.
  const rawMetas = useMemo<ColumnMeta[]>(() => {
    if (!dataset) return [];
    return dataset.columns.map((c) => summarise(dataset.rows, c));
  }, [dataset]);
  const cleaningPlan: CleaningPlan | null = useMemo(() => {
    if (!dataset) return null;
    return analyseCleaning(dataset, rawMetas);
  }, [dataset, rawMetas]);
  const [cleaningOpen, setCleaningOpen] = useState(false);
  const [cleaningDismissed, setCleaningDismissed] = useState(false);
  const [enabledOps, setEnabledOps] = useState<Set<CleaningOpKey>>(() => new Set());
  // Reset selection + dismissed state when the plan identity changes (i.e. a
  // new dataset is loaded, or cleaning has just been applied).
  // biome-ignore lint/correctness/useExhaustiveDependencies: ops identity is the trigger; we don't want to refire on every selection toggle.
  useEffect(() => {
    if (cleaningPlan) {
      setEnabledOps(defaultEnabled(cleaningPlan));
      setCleaningDismissed(false);
      setCleaningOpen(false);
    } else {
      setEnabledOps(new Set());
    }
  }, [cleaningPlan?.ops]);

  const onApplyCleaning = useCallback(() => {
    if (!dataset || !cleaningPlan) return;
    const cleaned = applyCleaning(dataset, cleaningPlan, enabledOps);
    const opLabels = cleaningPlan.ops
      .filter((op) => enabledOps.has(op.key))
      .map((op) => describeOp(op, cleaningPlan.sampled).title);
    setDataset(cleaned);
    // Recompute happens automatically through the dataset dep. We close the
    // panel so the user immediately sees the cleaner state.
    setCleaningOpen(false);
    setCleaningDismissed(false);
    // Reset filters because column/row identity may have shifted.
    setFilters([]);
    logEvent({ stage: "soft", kind: "cleaning.apply", payload: { opLabels } });
  }, [dataset, cleaningPlan, enabledOps, setDataset, setFilters, logEvent]);

  const toggleOp = useCallback((key: CleaningOpKey) => {
    setEnabledOps((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleFilter = useCallback(
    (f: Filter) => {
      setFilters((prev) => {
        const sameIdx = prev.findIndex((p) => filterId(p) === filterId(f));
        if (sameIdx >= 0) {
          logEvent({
            stage: "soft",
            kind: "filter.remove",
            payload: { description: describeFilter(f), column: f.column },
          });
          return prev.filter((_, i) => i !== sameIdx);
        }
        const colIdx = prev.findIndex((p) => p.column === f.column);
        logEvent({
          stage: "soft",
          kind: "filter.add",
          payload: { description: describeFilter(f), column: f.column, spec: f },
        });
        if (colIdx >= 0) {
          const next = [...prev];
          next[colIdx] = f;
          return next;
        }
        return [...prev, f];
      });
    },
    [setFilters, logEvent],
  );

  const clearFilter = useCallback(
    (f: Filter) => {
      logEvent({
        stage: "soft",
        kind: "filter.remove",
        payload: { description: describeFilter(f), column: f.column },
      });
      setFilters((prev) => prev.filter((p) => filterId(p) !== filterId(f)));
    },
    [setFilters, logEvent],
  );

  const clearAllFilters = useCallback(() => {
    logEvent({ stage: "soft", kind: "filters.clearAll", payload: {} });
    setFilters([]);
  }, [setFilters, logEvent]);

  // Pipe the current dataset shape + active filters + selected column into
  // the chatbar's stage context so questions like "why is age skewed in this
  // slice?" resolve against the user's actual filter stack.
  const chatStageContext = useMemo(
    () => buildStageContext({ dataset, filters, filteredRows, selectedMeta }),
    [dataset, filters, filteredRows, selectedMeta],
  );

  const chatPlaceholder = useMemo(() => {
    if (!dataset) return "load a dataset to chat with scelo…";
    if (filters.length === 0) return "ask scelo about this dataset…";
    const slice = `${filteredRows.length}-row slice (${filters.length} filter${filters.length > 1 ? "s" : ""})`;
    return `ask scelo about this ${slice}…`;
  }, [dataset, filters, filteredRows.length]);

  const [samplePickerOpen, setSamplePickerOpen] = useState(false);
  const [simulateOpen, setSimulateOpen] = useState(false);
  const loadSample = useCallback(
    (key: SampleKey) => {
      const opt = SAMPLE_OPTIONS.find((o) => o.key === key);
      if (!opt) return;
      const ds = opt.build();
      // Loading a fresh dataset starts a new reproducibility session — wipe
      // the prior log so the new export doesn't replay events from the old
      // dataset that no longer exist.
      clearEvents();
      setDataset(ds);
      setSelected(ds.columns[0]);
      setFilters([]);
      logEvent({
        stage: "soft",
        kind: "dataset.load",
        payload: {
          name: ds.name,
          rows: ds.rows.length,
          cols: ds.columns.length,
          columns: ds.columns,
          source: "sample",
        },
      });
      setSamplePickerOpen(false);
    },
    [clearEvents, setDataset, setFilters, logEvent],
  );

  // Status banner for slow / failed uploads. Parquet parsing is async and
  // can take a second or two on a real file; we want the user to see it's
  // working and to surface decode errors cleanly instead of failing silent.
  const [uploadState, setUploadState] = useState<
    { kind: "idle" } | { kind: "loading"; name: string } | { kind: "error"; message: string }
  >({ kind: "idle" });

  // Core parse + load path. Accepts a File directly so both `<input
  // type="file" onChange>` and the import-modal drag/drop handler can
  // share it without each having to re-implement the dispatch.
  const onPickFileObject = useCallback(
    async (file: File) => {
      const name = file.name;
      const lower = name.toLowerCase();
      const isParquet = lower.endsWith(".parquet") || file.type === "application/parquet";
      const isCsv =
        lower.endsWith(".csv") || file.type === "text/csv" || file.type === "application/csv";
      setUploadState({ kind: "loading", name });
      try {
        let parsed: { columns: string[]; rows: Row[] };
        if (isParquet) {
          parsed = await parseParquet(file);
        } else if (isCsv || file.type === "" /* empty MIME = trust the extension fallback */) {
          const text = await file.text();
          parsed = parseCsv(text);
        } else {
          throw new Error(
            `Unsupported file type: ${file.type || "unknown"} — try .csv or .parquet`,
          );
        }
        if (parsed.columns.length === 0 || parsed.rows.length === 0) {
          throw new Error("The file parsed cleanly but produced no rows or columns.");
        }
        clearEvents();
        setDataset({ name, ...parsed });
        setSelected(parsed.columns[0]);
        setFilters([]);
        setUploadState({ kind: "idle" });
        setImportModalOpen(false);
        logEvent({
          stage: "soft",
          kind: "dataset.load",
          payload: {
            name,
            rows: parsed.rows.length,
            cols: parsed.columns.length,
            columns: parsed.columns,
            source: "import",
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error parsing file.";
        setUploadState({ kind: "error", message: msg });
      } finally {
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [clearEvents, setDataset, setFilters, logEvent],
  );

  const onPickFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await onPickFileObject(file);
  };

  const [importModalOpen, setImportModalOpen] = useState(false);

  return (
    <div className="flex h-full flex-col">
      {/* top toolbar */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-bg-1 px-3 py-2">
        <button
          type="button"
          onClick={() => navigate("/dashboards/scelo")}
          className="font-mono text-xs text-fg-mute hover:text-primary"
        >
          ← macro view
        </button>
        <div className="h-4 w-px bg-border" />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-accent-2">
            <span aria-hidden className="inline-block h-1 w-1 rounded-full bg-current opacity-70" />
            <span>soft</span>
          </div>
          <h1 className="truncate text-sm text-fg">
            {dataset ? dataset.name : "no dataset loaded"}
            {dataset && (
              <span className="ml-2 font-mono text-[10px] text-fg-dim">
                {dataset.rows.length} rows · {dataset.columns.length} cols
              </span>
            )}
          </h1>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setImportModalOpen(true)}
            disabled={uploadState.kind === "loading"}
            title="Import a CSV or Parquet file"
            className="rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[11px] text-fg-mute hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {uploadState.kind === "loading" ? "parsing…" : "import csv / parquet"}
          </button>
          <button
            type="button"
            onClick={() => setSamplePickerOpen(true)}
            className="rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[11px] text-fg-mute hover:border-primary hover:text-primary"
          >
            load sample
          </button>
          <button
            type="button"
            onClick={() => setSimulateOpen(true)}
            title={
              dataset
                ? "augment this dataset with simulated per-row outcomes under a scenario, OR generate a new synthetic dataset"
                : "generate a synthetic dataset by simulating a population's response to a scenario (swarm @ :3010)"
            }
            className="rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[11px] text-fg-mute hover:border-primary hover:text-primary"
          >
            ▷ simulate
          </button>
          {dataset && (
            <DerivedColumnButton
              dataset={dataset}
              onAdd={addDerivedColumn}
              derivedCount={Object.keys(derivedColumns).length}
            />
          )}
          {dataset && <ExportMenu dataset={dataset} />}
          <ExportButton stage="soft" />
          {dataset && (
            <button
              type="button"
              onClick={() => {
                setDataset(null);
                setSelected(null);
                logEvent({ stage: "soft", kind: "dataset.clear", payload: {} });
              }}
              className="rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[11px] text-fg-mute hover:border-error hover:text-error"
            >
              clear
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv,.parquet,application/parquet,application/x-parquet,application/octet-stream"
            className="hidden"
            onChange={onPickFile}
          />
          <div className="ml-1 h-4 w-px bg-border" />
          <button
            type="button"
            onClick={() => navigate("/dashboards/scelo/tools")}
            disabled={!dataset}
            title={
              dataset
                ? "Skip the macro view — go straight to model selection."
                : "Load a dataset first."
            }
            className="rounded border border-primary/60 bg-primary/10 px-2 py-1 font-mono text-[11px] text-primary hover:border-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:border-border disabled:bg-bg-2 disabled:text-fg-dim"
          >
            next: tools →
          </button>
        </div>
      </header>

      {/* upload status banner — loading / error feedback */}
      {uploadState.kind === "loading" && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-1 px-3 py-1 font-mono text-[10px] text-fg-mute">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warn" />
          <span>parsing</span>
          <span className="text-fg-dim">·</span>
          <span className="truncate">{uploadState.name}</span>
        </div>
      )}
      {uploadState.kind === "error" && (
        <div className="flex shrink-0 items-start gap-2 border-b border-error/40 bg-error/10 px-3 py-1.5 font-mono text-[10px] text-error">
          <span className="shrink-0">upload failed</span>
          <span className="text-fg-dim">·</span>
          <span className="flex-1 break-words text-error/90">{uploadState.message}</span>
          <button
            type="button"
            onClick={() => setUploadState({ kind: "idle" })}
            className="shrink-0 px-1 text-fg-dim hover:text-error"
            aria-label="dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* cleaning suggestion — only rendered when issues are detected and the
          user hasn't dismissed the banner for the current dataset. */}
      {cleaningPlan &&
        cleaningPlan.ops.length > 0 &&
        !cleaningDismissed &&
        uploadState.kind !== "loading" && (
          <CleaningBanner
            plan={cleaningPlan}
            open={cleaningOpen}
            enabled={enabledOps}
            onToggleOp={toggleOp}
            onOpenChange={setCleaningOpen}
            onDismiss={() => setCleaningDismissed(true)}
            onApply={onApplyCleaning}
          />
        )}

      {/* filter chip strip — only rendered when filters exist */}
      {filters.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-bg-1 px-3 py-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-fg-dim">
            filters
          </span>
          {filters.map((f) => (
            <button
              key={filterId(f)}
              type="button"
              onClick={() => clearFilter(f)}
              title={`click to remove · ${describeFilter(f)}`}
              className="group flex items-center gap-1 rounded border border-primary/40 bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary hover:border-primary"
            >
              <span>{describeFilter(f)}</span>
              <span aria-hidden className="text-fg-mute group-hover:text-error">
                ×
              </span>
            </button>
          ))}
          {filters.length > 1 && (
            <button
              type="button"
              onClick={clearAllFilters}
              className="rounded border border-border bg-bg-2 px-2 py-0.5 font-mono text-[10px] text-fg-mute hover:border-error hover:text-error"
            >
              clear all
            </button>
          )}
          <span className="ml-auto font-mono text-[10px] text-fg-dim">
            {filteredRows.length}/{dataset?.rows.length ?? 0} rows
          </span>
        </div>
      )}

      {/* body: 2-pane (column-list aside removed; column actions live on the
          table header itself — click selects, hover opens the per-column
          chat popover). */}
      <div className="flex min-h-0 flex-1">
        {/* center: grid */}
        <main className="min-w-0 flex-1 p-3">
          {dataset ? (
            <DataGrid
              dataset={dataset}
              rows={filteredRows}
              columnMetas={columnMetas}
              filters={filters}
              onFilter={toggleFilter}
              selectedColumn={selectedMeta?.name ?? null}
              onSelectColumn={setSelected}
              derivedColumnNames={derivedColumnNameSet}
            />
          ) : (
            <EmptyState
              onLoadSample={() => setSamplePickerOpen(true)}
              onPickFile={() => setImportModalOpen(true)}
            />
          )}
        </main>

        {/* right: column summary */}
        <ResizablePanel
          side="right"
          defaultWidth={288}
          badge="soft · column"
          accentClass="text-accent-2"
          innerClassName="overflow-auto"
        >
          <ColumnSummaryHeader meta={selectedMeta} />
          {selectedMeta && dataset ? (
            <SmartColumnDashboard
              meta={selectedMeta}
              rows={filteredRows}
              filters={filters}
              totalRows={dataset.rows.length}
            />
          ) : (
            <p className="px-3 py-3 text-[11px] text-fg-dim">
              Click a column header in the table to see its type, missing/unique counts, and an
              AI-picked summary dashboard. Hover the header to open a chatbot scoped to that one
              column.
            </p>
          )}
        </ResizablePanel>

        {/* far right: persistent Scelo chat panel — slightly wider than
            the column-summary aside so the conversation reads as the
            primary affordance, not an afterthought. */}
        <StageChatPanel
          stageContext={chatStageContext}
          placeholder={chatPlaceholder}
          chatId="soft-stage"
          title={chatPlaceholder}
          badge="soft · chat"
          dataset={dataset}
        />
      </div>

      <SampleLibraryModal
        open={samplePickerOpen}
        onPick={loadSample}
        onDismiss={() => setSamplePickerOpen(false)}
      />
      <ImportFileModal
        open={importModalOpen}
        onFile={onPickFileObject}
        onDismiss={() => setImportModalOpen(false)}
      />
      <SimulateScenarioModal
        open={simulateOpen}
        onClose={() => setSimulateOpen(false)}
        existingDataset={dataset}
        onDataset={(ds) => {
          clearEvents();
          setDataset(ds);
          setSelected(ds.columns[0]);
          setFilters([]);
        }}
      />
    </div>
  );
}

// Right-panel header. When a column is focused, the bar + label pick up that
// column's type colour — same accent palette used by the stat tiles below and
// by the Tools / Hard Data left panels. Without a selection the header stays
// neutral so the empty-state text doesn't fight for attention.
const HEADER_ACCENTS = {
  "accent-2": { wrap: "border-accent-2/60", bar: "bg-accent-2", label: "text-accent-2" },
  "accent-3": { wrap: "border-accent-3/60", bar: "bg-accent-3", label: "text-accent-3" },
  warn: { wrap: "border-warn/60", bar: "bg-warn", label: "text-warn" },
} as const;

function ColumnSummaryHeader({ meta }: { meta: ColumnMeta | null }) {
  // Left padding has to clear the ResizablePanel collapse chevron, which
  // sits in the panel's inner top-left corner from ~6 px to ~26 px. We
  // use `pl-8` (32 px) so the header text starts cleanly to the right of
  // it. The 3 px accent bar lives at `left: 0` and is rendered through
  // the negative left-margin trick below, since the chevron occupies the
  // area immediately to the right of it.
  if (!meta) {
    return (
      <div className="relative border-b border-border px-3 py-1.5 pl-8 font-mono text-[10px] uppercase tracking-wider text-fg-dim">
        column · summary
      </div>
    );
  }
  const accent: keyof typeof HEADER_ACCENTS =
    meta.type === "number" ? "accent-2" : meta.type === "date" ? "warn" : "accent-3";
  const tone = HEADER_ACCENTS[accent];
  return (
    <div className={`relative overflow-hidden border-b ${tone.wrap} bg-bg-1 px-3 py-1.5 pl-8`}>
      <span className={`absolute inset-y-0 left-0 w-[3px] ${tone.bar}`} />
      <div className="flex items-baseline justify-between gap-2">
        <span className={`font-mono text-[10px] uppercase tracking-wider ${tone.label}`}>
          column · summary
        </span>
        <span
          className={`shrink-0 rounded border ${tone.wrap} px-1 font-mono text-[9px] uppercase tracking-wider ${tone.label}`}
        >
          {meta.type}
        </span>
      </div>
      <div className="mt-0.5 truncate font-mono text-[12px] text-fg" title={meta.name}>
        {meta.name}
      </div>
    </div>
  );
}

// Cleaning suggestion — shown when the analyser finds at least one fixable
// issue. Collapsed state is a one-line strip; expanded state lists every
// suggested operation with a checkbox so the user can opt in/out before
// running cleaning. Sits between the upload status and the filter chips.
function CleaningBanner({
  plan,
  open,
  enabled,
  onToggleOp,
  onOpenChange,
  onDismiss,
  onApply,
}: {
  plan: CleaningPlan;
  open: boolean;
  enabled: Set<CleaningOpKey>;
  onToggleOp: (key: CleaningOpKey) => void;
  onOpenChange: (open: boolean) => void;
  onDismiss: () => void;
  onApply: () => void;
}) {
  const safeCount = plan.ops.filter((o) => o.safe).length;
  const totalCount = plan.ops.length;
  const summary =
    safeCount === totalCount
      ? `${totalCount} cleaning suggestion${totalCount === 1 ? "" : "s"}`
      : `${totalCount} cleaning suggestion${totalCount === 1 ? "" : "s"} · ${safeCount} pre-selected`;
  const anyEnabled = enabled.size > 0;

  return (
    <div className="flex shrink-0 flex-col border-b border-warn/40 bg-warn/5">
      {/* collapsed strip — always visible */}
      <div className="flex items-center gap-2 px-3 py-1.5 font-mono text-[11px] text-fg">
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full bg-warn"
          title="data quality"
        />
        <span className="text-warn">cleaning available</span>
        <span className="text-fg-dim">·</span>
        <span className="text-fg-mute">{summary}</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => onOpenChange(!open)}
          className="rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-warn hover:border-warn"
        >
          {open ? "hide" : "review"}
          <span aria-hidden className="ml-1">
            {open ? "▴" : "▾"}
          </span>
        </button>
        <button
          type="button"
          onClick={onDismiss}
          title="dismiss without cleaning"
          aria-label="dismiss"
          className="rounded border border-transparent px-1 text-fg-dim hover:border-border hover:text-fg-mute"
        >
          ×
        </button>
      </div>

      {/* expanded preview — ops list + apply button */}
      {open && (
        <div className="border-t border-warn/30 px-3 pb-2.5 pt-2">
          <p className="mb-2 max-w-3xl font-mono text-[10px] text-fg-mute">
            Cleaning runs once you click <span className="text-warn">apply</span>. Each step is
            reviewed below — safe steps (whitespace, missing markers, numeric / boolean parsing) are
            pre-selected; destructive steps (dropping rows / columns) are opt-in.
            {plan.sampled && (
              <>
                {" "}
                <span className="text-fg-dim">
                  Counts are estimates from a {plan.sampleSize.toLocaleString()}-row sample of{" "}
                  {plan.rowCount.toLocaleString()} (apply runs at full fidelity).
                </span>
              </>
            )}
          </p>
          <ul className="flex flex-col gap-1">
            {plan.ops.map((op) => {
              const isOn = enabled.has(op.key);
              const meta = describeOp(op, plan.sampled);
              return (
                <li key={op.key}>
                  <label
                    className={`flex cursor-pointer items-start gap-2 rounded border px-2 py-1.5 transition ${
                      isOn
                        ? op.safe
                          ? "border-primary/40 bg-primary/5"
                          : "border-warn/40 bg-warn/10"
                        : "border-border bg-bg hover:border-fg-dim"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isOn}
                      onChange={() => onToggleOp(op.key)}
                      className="mt-0.5 h-3 w-3 accent-primary"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-1.5">
                        <span
                          className={`font-mono text-[11px] ${
                            op.safe ? "text-primary" : "text-warn"
                          }`}
                        >
                          {meta.title}
                        </span>
                        <span className="font-mono text-[9px] uppercase tracking-wider text-fg-dim">
                          {op.safe ? "safe" : "destructive"}
                        </span>
                      </div>
                      <div className="font-mono text-[10px] leading-snug text-fg-mute">
                        {meta.detail}
                      </div>
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={onApply}
              disabled={!anyEnabled}
              className="rounded border border-primary/60 bg-primary/10 px-2 py-1 font-mono text-[11px] text-primary hover:border-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:border-border disabled:bg-bg-2 disabled:text-fg-dim"
            >
              apply cleaning
            </button>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[11px] text-fg-mute hover:border-fg-dim"
            >
              cancel
            </button>
            <div className="flex-1" />
            <span className="font-mono text-[10px] text-fg-dim">
              {enabled.size} of {plan.ops.length} step{plan.ops.length === 1 ? "" : "s"} selected
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// Floating per-column chat popover. Renders to the right of the hovered
// column-list row (or below if there isn't enough horizontal room), using
// `position: fixed` so it escapes the aside's scroll container. Sole
// purpose: clean / manipulate / convert / encode / derive this ONE
// column. Memory-keyed per (project, column name) so each column carries
// its own thread.
function ColumnChatPopover({
  meta,
  anchor,
  onEnter,
  onLeave,
  onClose,
}: {
  meta: ColumnMeta;
  anchor: DOMRect;
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  const { chatMemoryPrefix } = useScelo();
  const memoryKey = chatMemoryPrefix ? `${chatMemoryPrefix}:soft-col:${meta.name}` : undefined;
  const stageContext = useMemo(() => buildColumnStageContext(meta), [meta]);
  const placeholder = useMemo(() => placeholderHintFor(meta), [meta]);
  const { messages, isStreaming, send, stop } = useNodeChat(stageContext, { memoryKey });
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Autofocus the input on open so the user can start typing immediately.
  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Auto-scroll on new messages.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every message change.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = () => {
    const text = draft.trim();
    if (!text || isStreaming) return;
    setDraft("");
    void send(text);
  };

  // Position below the anchor (a `<th>` cell) by default — column headers
  // are narrow so right-of-anchor would leave the popover off-screen for
  // most columns. We clamp horizontally to keep it on-screen and flip up
  // when the popover would crash through the bottom edge.
  const POPOVER_W = 340;
  const GAP = 8;
  const POPOVER_MAX_H = Math.round(typeof window !== "undefined" ? window.innerHeight * 0.6 : 480);
  const viewportRight = typeof window !== "undefined" ? window.innerWidth : 1200;
  const viewportBottom = typeof window !== "undefined" ? window.innerHeight : 800;
  const flowsDown = anchor.bottom + GAP + 220 <= viewportBottom;
  const left = Math.max(GAP, Math.min(anchor.left, viewportRight - POPOVER_W - GAP));
  const style: React.CSSProperties = flowsDown
    ? {
        position: "fixed",
        left,
        top: anchor.bottom + GAP,
        width: POPOVER_W,
        maxHeight: POPOVER_MAX_H,
        zIndex: 60,
      }
    : {
        position: "fixed",
        left,
        bottom: Math.max(GAP, viewportBottom - anchor.top + GAP),
        width: POPOVER_W,
        maxHeight: POPOVER_MAX_H,
        zIndex: 60,
      };

  return (
    <div
      style={style}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="flex max-h-[60vh] flex-col overflow-hidden rounded-lg border border-border bg-bg-1 shadow-2xl"
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-bg-1 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <TypeChip type={meta.type} />
          <span className="truncate font-mono text-xs text-fg">{meta.name}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="close"
          className="font-mono text-[10px] text-fg-dim hover:text-error"
        >
          ✕
        </button>
      </header>
      {messages.length > 0 && (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-3 py-2">
          <ul className="flex flex-col gap-2">
            {messages.map((m, idx) => {
              const isUser = m.role === "user";
              const isLast = idx === messages.length - 1;
              const streamingThis = !isUser && isLast && isStreaming;
              return (
                <li key={m.id} className="flex min-w-0 flex-col gap-0.5">
                  <span
                    className={`font-mono text-[9px] uppercase tracking-wider ${
                      isUser ? "text-fg-dim" : "text-accent-2"
                    }`}
                  >
                    {isUser ? "you" : "scelo"}
                  </span>
                  {isUser ? (
                    <div className="break-words whitespace-pre-wrap text-[11px] leading-snug text-fg">
                      {m.content}
                    </div>
                  ) : m.content ? (
                    <div className="min-w-0 overflow-hidden">
                      <SceloChatMarkdown streaming={streamingThis} dataset={null}>
                        {m.content}
                      </SceloChatMarkdown>
                    </div>
                  ) : streamingThis ? (
                    <span className="text-fg-dim">…</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="shrink-0 border-t border-border bg-bg-1 px-3 py-2">
        <ChatInputPill
          draft={draft}
          onDraftChange={setDraft}
          onSubmit={submit}
          onStop={stop}
          isStreaming={isStreaming}
          placeholder={placeholder}
          rows={2}
          size="xs"
          textareaRef={inputRef}
        />
      </div>
    </div>
  );
}

// Toolbar trigger + popover for adding a derived column. Click the trigger
// → opens a panel anchored below the button with name + formula textarea +
// live sample preview. Validation happens inline (name format, uniqueness,
// formula compile errors) so the user sees feedback before hitting apply.
// Outside-click and ESC close.
function DerivedColumnButton({
  dataset,
  onAdd,
  derivedCount,
}: {
  dataset: Dataset;
  onAdd: (name: string, formula: string) => { ok: true } | { ok: false; error: string };
  derivedCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [formula, setFormula] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) requestAnimationFrame(() => nameInputRef.current?.focus());
  }, [open]);

  // Close on outside click. Listen on mousedown so the click that triggers
  // close doesn't also fire onClick handlers inside the popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // ESC closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const preview = useMemo(() => {
    if (!open || formula.trim() === "") return null;
    return previewFormula(formula, dataset.columns, dataset.rows, 3);
  }, [open, formula, dataset.columns, dataset.rows]);

  const nameError = name.trim() === "" ? null : validateColumnName(name, dataset.columns);

  const reset = () => {
    setName("");
    setFormula("");
    setSubmitError(null);
  };

  const submit = () => {
    const result = onAdd(name, formula);
    if (result.ok) {
      reset();
      setOpen(false);
    } else {
      setSubmitError(result.error);
    }
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Add a derived column from a formula"
        className={`flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-[11px] ${
          open
            ? "border-primary bg-primary/10 text-primary"
            : "border-border bg-bg-2 text-fg-mute hover:border-primary hover:text-primary"
        }`}
      >
        <span>+ ƒ derived</span>
        {derivedCount > 0 && (
          <span className="rounded bg-primary/15 px-1 font-mono text-[9px] text-primary">
            {derivedCount}
          </span>
        )}
      </button>
      {open && (
        <div
          ref={popoverRef}
          className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-border bg-bg-1 p-2 shadow-2xl"
        >
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="font-mono text-[9px] uppercase tracking-wider text-fg-dim">
              new derived column
            </span>
            <button
              type="button"
              onClick={() => {
                reset();
                setOpen(false);
              }}
              aria-label="close"
              className="font-mono text-[10px] text-fg-dim hover:text-error"
            >
              ✕
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            <input
              ref={nameInputRef}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSubmitError(null);
              }}
              placeholder="name (e.g. loss_ratio)"
              className="w-full rounded border border-border bg-bg px-2 py-1 font-mono text-[11px] text-fg placeholder:text-fg-dim focus:border-primary focus:outline-none"
            />
            {nameError && <p className="font-mono text-[10px] text-error">{nameError}</p>}
            <textarea
              value={formula}
              onChange={(e) => {
                setFormula(e.target.value);
                setSubmitError(null);
              }}
              placeholder="formula  (e.g. paid / premium)"
              rows={3}
              className="w-full resize-none rounded border border-border bg-bg px-2 py-1 font-mono text-[11px] text-fg placeholder:text-fg-dim focus:border-primary focus:outline-none"
            />
            {preview && (
              <div className="rounded border border-border bg-bg px-2 py-1 font-mono text-[10px] leading-snug">
                {preview.error ? (
                  <span className="text-error">⚠ {preview.error}</span>
                ) : (
                  <span className="text-fg-mute">
                    preview:{" "}
                    <span className="text-fg">
                      {preview.samples
                        .map((s) =>
                          s === null ? "∅" : typeof s === "number" ? formatNumber(s) : String(s),
                        )
                        .join(", ")}
                      {dataset.rows.length > preview.samples.length && ", …"}
                    </span>
                  </span>
                )}
              </div>
            )}
            {submitError && <p className="font-mono text-[10px] text-error">{submitError}</p>}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={submit}
                disabled={!name.trim() || !formula.trim() || nameError !== null}
                className="flex-1 rounded border border-primary/60 bg-primary/10 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-primary hover:border-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:border-border disabled:bg-bg-2 disabled:text-fg-dim"
              >
                apply
              </button>
              <button
                type="button"
                onClick={reset}
                className="rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-fg-mute hover:border-fg-dim"
              >
                clear
              </button>
            </div>
            <p className="font-mono text-[9px] leading-snug text-fg-dim">
              use column names directly · arithmetic, parens, Math.log/exp/sqrt/abs/min/max,
              if(cond, a, b), coalesce(a, b, …)
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// Small dropdown export menu. Click the trigger button → shows CSV / JSON
// options. Closes on outside click or after selection. No second-level
// portal — we keep it inline since the menu has at most 3 items today.
function ExportMenu({ dataset }: { dataset: Dataset }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const doExport = (fmt: ExportFormat) => {
    exportDataset(dataset, fmt);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Download the current dataset"
        className="flex items-center gap-1 rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[11px] text-fg-mute hover:border-primary hover:text-primary"
      >
        export
        <span aria-hidden className="text-[8px]">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-44 overflow-hidden rounded border border-border bg-bg-1 shadow-lg">
          <button
            type="button"
            onClick={() => doExport("csv")}
            className="flex w-full items-center justify-between px-2.5 py-1.5 text-left font-mono text-[11px] text-fg hover:bg-bg-2"
          >
            <span>CSV</span>
            <span className="font-mono text-[9px] uppercase tracking-wider text-fg-dim">.csv</span>
          </button>
          <button
            type="button"
            onClick={() => doExport("json")}
            className="flex w-full items-center justify-between border-t border-border px-2.5 py-1.5 text-left font-mono text-[11px] text-fg hover:bg-bg-2"
          >
            <span>JSON</span>
            <span className="font-mono text-[9px] uppercase tracking-wider text-fg-dim">.json</span>
          </button>
          <div className="border-t border-border bg-bg-2/40 px-2.5 py-1 font-mono text-[9px] uppercase tracking-wider text-fg-dim">
            {dataset.rows.length.toLocaleString()} rows · {dataset.columns.length} cols
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyState({
  onLoadSample,
  onPickFile,
}: {
  onLoadSample: () => void;
  onPickFile: () => void;
}) {
  // Both buttons share the same restrained styling — muted ink on a
  // recessed surface, no accent colour. `inline-flex items-center
  // justify-center` + `leading-none` keeps the uppercase glyphs
  // vertically centred in the pill (without `leading-none`, font
  // metrics push uppercase text slightly above centre because there
  // are no descenders carrying the line-height baseline).
  const buttonClass =
    "inline-flex items-center justify-center rounded-2xl border border-border bg-bg-1 px-6 py-3 font-mono text-[11px] leading-none uppercase tracking-[0.15em] text-fg-dim transition hover:border-fg-dim hover:text-fg-mute";
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex items-center gap-3">
        <button type="button" onClick={onPickFile} className={buttonClass}>
          import csv / parquet
        </button>
        <button type="button" onClick={onLoadSample} className={buttonClass}>
          load sample
        </button>
      </div>
    </div>
  );
}
