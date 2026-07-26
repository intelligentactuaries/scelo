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

import { delimiterFor } from "@/lib/csvParse";
import { streamParseCsv } from "@/lib/csvStream";
import { useTheme } from "@/lib/theme";
import { emitToast } from "@/lib/toastBus";
import { emitWorkspaceFact } from "@/lib/workspaceFactsBus";
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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { ChatInputPill } from "./ChatInputPill";
import { CombineDiagram } from "./CombineDiagram";
import { ExportButton } from "./ExportScreen";
import { ResizablePanel } from "./ResizablePanel";
import { SceloChatMarkdown } from "./SceloChatMarkdown";
import { SimulateScenarioModal } from "./SimulateScenarioModal";
import { SmartColumnDashboard } from "./SmartColumnDashboard";
import { type ChatAction, StageChatPanel } from "./StageChatPanel";
import { UploadIndicator, type UploadState, nextPaint, useMinVisible } from "./UploadIndicator";
import {
  AUTO_CLEAN_MAX_PASSES,
  type AutoCleanResult,
  type CleaningOpKey,
  type CleaningPlan,
  DATE_STYLE_LABEL,
  type DateStyle,
  analyseCleaning,
  applyCleaning,
  augmentDataset,
  autoCleanDataset,
  cleanColumnCells,
  clearNonDateCells,
  defaultEnabled,
  describeOp,
  detectDateColumns,
  reformatDateColumns,
} from "./cleaning";
import { buildColumnStageContext, placeholderHintFor } from "./columnChatHints";
import { getColumnMetas } from "./columnMetaCache";
import {
  type ColumnOpIntent,
  convertColumnToNumber,
  convertColumnToString,
  dropColumnFromDataset,
  fillMissingInColumn,
  parseColumnOpIntent,
  removeOutlierRows,
  resolveColumnsMentioned,
  roundColumnValues,
  transformColumnCase,
} from "./columnOps";
import type { CombinePreview } from "./combineData";
import {
  type CombineStats,
  type CombineStep,
  type CombineStrategy,
  type CombineSuggestion,
  combineAll,
  combinePair,
  previewCombine,
  suggestCombine,
} from "./combineData";
import { type ExportFormat, exportDataset } from "./exportDataset";
import { compileFormula, previewFormula, validateColumnName } from "./formulaEvaluator";
import { useScelo } from "./sceloContext";
import { useNodeChat } from "./useNodeChat";
import { columnRelevance, numericColumns as workspaceNumericColumns } from "./workspace";

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

// ─── dataset core ─────────────────────────────────────────────────────────
//
// Profiling, typing, coercion and filtering now live in @scelo/core. They
// were always pure; keeping them in this file meant 25 modules had to import
// from a .tsx to get a type, and nothing outside the browser build could use
// any of it.
//
// Re-exported here so the existing `from "./SoftDataWorkstation"` imports in
// the .tsx layer keep working — the pure .ts modules import the package
// directly.
import {
  type CellValue,
  type ColumnMeta,
  type ColumnType,
  type Dataset,
  type Filter,
  type Row,
  DEFAULT_IMPORT_ROW_CAP,
  applyFilters,
  coerceCsvCell,
  describeFilter,
  filterId,
  formatNumber,
  minMax,
  summarise,
  summariseDataset,
  SAMPLES as CORE_SAMPLES,
} from "@scelo/core";
import type { SampleKey } from "@scelo/core";

export type { CellValue, ColumnMeta, ColumnType, Dataset, Filter, Row };

/** How many extra datasets may be staged for combining. UI capacity, not
 *  dataset logic, so it stays with the component. */
const MAX_STAGED_DATASETS = 2;
export { applyFilters, coerceCsvCell, describeFilter, formatNumber, minMax, summariseDataset };

function rowsFromCsvCells(header: string[], cells: string[][]): Row[] {
  const out: Row[] = new Array(cells.length);
  for (let r = 0; r < cells.length; r++) {
    const src = cells[r];
    const row: Row = {};
    for (let c = 0; c < header.length; c++) {
      row[header[c]] = coerceCsvCell(src[c] ?? "");
    }
    out[r] = row;
  }
  return out;
}

// First-KB sniff for files that reach the CSV path without a trustworthy
// extension (.txt, or empty MIME with no extension): the bytes must look
// like printable text and at least one candidate delimiter must appear on
// every sampled line. Returns the winning delimiter, or null for binary /
// non-delimited content. Exported for tests.
export async function sniffDelimitedText(file: Blob): Promise<string | null> {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  if (head.length === 0) return null;
  let control = 0;
  for (const b of head) {
    if (b === 0) return null; // NUL byte — certainly binary
    if (b < 32 && b !== 9 && b !== 10 && b !== 13) control++;
  }
  if (control / head.length > 0.02) return null;
  const text = new TextDecoder("utf-8").decode(head);
  // Drop the last (possibly slice-truncated) line so its delimiter count
  // doesn't skew consistency; keep the whole head for one-line files.
  let lines = text.split(/\r?\n/);
  if (lines.length > 1) lines = lines.slice(0, -1);
  lines = lines.filter((l) => l.trim().length > 0).slice(0, 20);
  if (lines.length === 0) return null;
  let best: { delim: string; minCount: number } | null = null;
  for (const delim of [",", "\t", ";"]) {
    let minCount = Number.POSITIVE_INFINITY;
    for (const line of lines) {
      let n = 0;
      for (let i = 0; i < line.length; i++) if (line[i] === delim) n++;
      if (n < minCount) minCount = n;
    }
    if (minCount >= 1 && (best === null || minCount > best.minCount)) {
      best = { delim, minCount };
    }
  }
  return best?.delim ?? null;
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

async function parseParquet(file: File): Promise<{
  columns: string[];
  rows: Row[];
  sampled: boolean;
  sourceTotalRows: number;
  sampleKind?: "uniform" | "first";
}> {
  const buf = await file.arrayBuffer();
  // Schema gives us the canonical column order; data-key order from
  // parquetReadObjects can differ when projections happen.
  const meta = parquetMetadata(buf);
  const columns = meta.schema
    // index 0 is the root group element — skip it, take only leaf fields.
    .slice(1)
    .filter((s) => s.type !== undefined)
    .map((s) => s.name);

  // Parquet metadata carries the exact row count (as a bigint). Cap what we
  // materialise at the import row cap — rowStart/rowEnd stop hyparquet from
  // decoding past the cap, so a 10M-row file no longer allocates 10M row
  // objects. Unlike the CSV path this keeps the FIRST N rows in file order,
  // not a uniform sample; the sampling banner says so.
  const sourceTotalRows = Number(meta.num_rows);
  const capped = sourceTotalRows > DEFAULT_IMPORT_ROW_CAP;
  const objects = await parquetReadObjects({
    file: buf,
    metadata: meta,
    rowStart: 0,
    rowEnd: capped ? DEFAULT_IMPORT_ROW_CAP : undefined,
  });
  const rows: Row[] = objects.map((obj) => {
    const row: Row = {};
    for (const c of columns) {
      row[c] = coerceParquetValue(obj[c]);
    }
    return row;
  });
  return {
    columns,
    rows,
    sampled: capped,
    sourceTotalRows,
    sampleKind: capped ? "first" : undefined,
  };
}

// Registry of the in-app sample datasets the "load sample" picker offers.
// Adding a new sample is one entry here — the picker modal renders cards
// from this list and the load action dispatches by key.
export type { SampleKey } from "@scelo/core";

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

const SAMPLE_PRESENTATION: Record<SampleKey, { accent: SampleOption["accent"]; badge: string }> = {
  claims: { accent: "accent-2", badge: "claims" },
  climate: { accent: "warn", badge: "climate" },
  dirty: { accent: "error", badge: "dirty" },
  "wmtr-scenarios": { accent: "warn", badge: "wmtr" },
  "lifelib-mp": { accent: "accent-3", badge: "lifelib" },
  "workspace-demo": { accent: "accent-2", badge: "workspace" },
};

// The samples themselves live in @scelo/core (shared with the TUI — one
// definition or the two surfaces drift apart on what claims to be the same
// data). This registry is that list plus the card presentation only this
// app has a use for.
const SAMPLE_OPTIONS: SampleOption[] = CORE_SAMPLES.map((spec) => ({
  ...spec,
  ...SAMPLE_PRESENTATION[spec.key],
}));

// ── type detection + stats ───────────────────────────────────────────────────

// Row-count threshold beyond which per-column ORDER statistics (quantiles,
// histogram, top values) switch to a stride sample, and the target sample
// size once they do. Mirrors analyseCleaning's sampling in cleaning.ts so
// the profile and the plan agree on what "sampled" means. Exact scalars
// (count / missing / unique / min / max / mean) still come from a full pass
// — they're one comparison per cell.
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
            const outlierTotal = meta.outlierCount ?? outliers.length;
            const outlierNote =
              outlierTotal > outliers.length
                ? `outliers=${fmt(outlierTotal)} (showing ${outliers.length})`
                : `outliers=${outliers.length}`;
            const mixedNote = meta.mixedCount ? ` · mixed=${fmt(meta.mixedCount)}` : "";
            return [
              `<b>${meta.name}</b>${sparkline}`,
              `min ${fmt(lo)} · Q1 ${fmt(q1)} · med ${fmt(median)} · Q3 ${fmt(q3)} · max ${fmt(hi)}`,
              `<span style="opacity:0.6">n=${nValues} · ${outlierNote}${mixedNote}</span>`,
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

    // ── date: compact per-year bar histogram ──
    if (meta.type === "date" && meta.yearHistogram && meta.yearHistogram.length > 0) {
      const years = meta.yearHistogram;
      const nValues = meta.count - meta.missing;
      return {
        animation: false,
        grid: { left: 6, right: 6, top: 4, bottom: 4, containLabel: false },
        xAxis: { type: "category", show: false, data: years.map((y) => String(y.year)) },
        yAxis: { type: "value", show: false },
        tooltip: {
          trigger: "item",
          ...tooltipFrame(palette),
          formatter: (params: { name?: string; value?: unknown }) => {
            const count = Number(params.value);
            const est = meta.sampledStats ? " (est.)" : "";
            return [
              `<b>${meta.name}</b>`,
              `${params.name}: ${count.toLocaleString()} row${count === 1 ? "" : "s"}${est}`,
              `<span style="opacity:0.6">${meta.dateMin ?? "?"} → ${meta.dateMax ?? "?"} · n=${nValues}</span>`,
            ].join("<br/>");
          },
        },
        series: [
          {
            type: "bar",
            data: years.map((y) => y.count),
            barCategoryGap: "25%",
            itemStyle: { color: palette.primary, opacity: 0.85 },
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

// Clickable type badge for date-content columns: opens a small dropdown to set
// the display format (American / European / ISO). Replaces the plain TypeChip
// on columns we detect as dates so the format is changeable the traditional,
// button-driven way — the same engine the chat uses. Positioned fixed so it
// isn't clipped by the grid's overflow-auto.
const DATE_FORMAT_OPTIONS: Array<[DateStyle, string, string]> = [
  ["us", "American", "MM/DD/YYYY"],
  ["eu", "European", "DD/MM/YYYY"],
  ["iso", "ISO 8601", "YYYY-MM-DD"],
];

function ColumnFormatMenu({
  column,
  onPick,
}: {
  column: string;
  onPick: (style: DateStyle) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (btnRef.current) setRect(btnRef.current.getBoundingClientRect());
    setOpen((o) => !o);
  };

  const MENU_W = 210;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const left = rect ? Math.max(8, Math.min(rect.right - MENU_W, vw - MENU_W - 8)) : 0;
  const top = rect ? rect.bottom + 4 : 0;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        title={`Date column — click to set the display format for \`${column}\``}
        className="flex shrink-0 items-center gap-0.5 rounded border border-border bg-bg-2 px-1 py-0.5 font-mono text-[9px] uppercase tracking-wider text-accent-3 hover:border-primary hover:text-primary"
      >
        📅<span className="text-fg-dim">▾</span>
      </button>
      {open && rect && (
        <>
          {/* click-away backdrop */}
          <button
            type="button"
            aria-label="close menu"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-[59] cursor-default"
          />
          <div
            style={{ position: "fixed", left, top, width: MENU_W, zIndex: 60 }}
            className="overflow-hidden rounded-lg border border-border bg-bg-1 shadow-2xl"
          >
            <div className="truncate border-b border-border px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-fg-dim">
              date format · {column}
            </div>
            {DATE_FORMAT_OPTIONS.map(([style, label, pattern]) => (
              <button
                key={style}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  onPick(style);
                }}
                className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-[11px] text-fg-mute hover:bg-bg-2 hover:text-primary"
              >
                <span>{label}</span>
                <span className="font-mono text-[10px] text-fg-dim">{pattern}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
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
  dateColumns,
  onReformatColumnDates,
  onColumnCommand,
  onUndo,
  undoLabel,
}: {
  dataset: Dataset;
  rows: Row[];
  columnMetas: ColumnMeta[];
  filters: Filter[];
  onFilter: (f: Filter) => void;
  selectedColumn: string | null;
  onSelectColumn: (name: string) => void;
  derivedColumnNames: Set<string>;
  dateColumns: string[];
  onReformatColumnDates: (column: string, style: DateStyle) => void;
  onColumnCommand: (column: string, text: string) => string | null;
  /** Reverse the last dataset change. Returns the reply to show in the
   *  column chat transcript. */
  onUndo: () => string;
  /** Label of the step that would be undone, or null when there is none. */
  undoLabel: string | null;
}) {
  const metaByName = useMemo(() => {
    const map = new Map<string, ColumnMeta>();
    for (const m of columnMetas) map.set(m.name, m);
    return map;
  }, [columnMetas]);
  const dateColSet = useMemo(() => new Set(dateColumns), [dateColumns]);
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

  // Per-column chat — hovering a `<th>` opens a scoped popover; CLICKING the
  // header pins it. State lives at the grid level (rather than on each `<th>`)
  // so we share one close timer across all headers; moving from one column to
  // another cancels the pending close on the previous, giving a smooth slide
  // between popovers.
  //
  // The pin exists because hover-only chat was fragile: drift the pointer one
  // row too far mid-thought and the popover (and your draft) vanished.
  // Clicking IN a column — its header or any of its body cells — is the ONE
  // pin gesture: it locks the chat to that column, and clicking a different
  // column moves the pin there (old chat closes, new one opens, anchored to
  // the new column's header). While pinned, hover changes and mouse-leave
  // are ignored — release via ✕ / Esc / re-clicking the pinned header.
  const [hoveredCol, setHoveredCol] = useState<string | null>(null);
  const [lockedCol, setLockedCol] = useState<string | null>(null);
  const [hoverAnchor, setHoverAnchor] = useState<DOMRect | null>(null);
  const thRefs = useRef<Map<string, HTMLTableCellElement>>(new Map());
  const lockedRef = useRef<string | null>(null);
  useEffect(() => {
    lockedRef.current = lockedCol;
  }, [lockedCol]);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (!lockedRef.current) setHoveredCol(null);
    }, 220);
  }, [cancelClose]);
  useEffect(() => cancelClose, [cancelClose]);

  // A cleaning op or combine can rename the pinned column away — release.
  useEffect(() => {
    if (lockedCol && !dataset.columns.includes(lockedCol)) {
      setLockedCol(null);
      setHoveredCol(null);
    }
  }, [dataset.columns, lockedCol]);

  // Pin the chat to a column, anchored to that column's header cell. The
  // single entry point for both header and body-cell clicks, so "click in
  // column B" always closes the previous pin and opens B's chat.
  const pinColumnChat = useCallback((c: string, fallbackRect?: DOMRect) => {
    const rect = thRefs.current.get(c)?.getBoundingClientRect() ?? fallbackRect ?? null;
    setLockedCol(c);
    setHoveredCol(c);
    if (rect) setHoverAnchor(rect);
  }, []);

  const activeChatCol = lockedCol ?? hoveredCol;
  const hoveredMeta = activeChatCol ? (metaByName.get(activeChatCol) ?? null) : null;

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
                // The column whose scoped chat popover is open is "in play" —
                // frame the whole column in green so it's obvious which one
                // you're working on.
                const chatActive = activeChatCol === c;
                const pinnedThis = lockedCol === c;
                return (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: clicking anywhere in the header cell (mini chart, chips, padding) selects the column — the name button inside remains the keyboard-accessible path.
                  <th
                    key={c}
                    ref={(el) => {
                      if (el) thRefs.current.set(c, el);
                      else thRefs.current.delete(c);
                    }}
                    onClick={(e) => {
                      onSelectColumn(c);
                      // Interactive children (mini-chart filters, the date
                      // format menu) shouldn't toggle the chat pin.
                      if ((e.target as HTMLElement).closest("[data-chat-nolock]")) return;
                      if (lockedCol === c) {
                        setLockedCol(null);
                      } else {
                        pinColumnChat(c, e.currentTarget.getBoundingClientRect());
                      }
                    }}
                    onMouseEnter={(e) => {
                      if (lockedRef.current) return;
                      cancelClose();
                      setHoveredCol(c);
                      setHoverAnchor(e.currentTarget.getBoundingClientRect());
                    }}
                    onMouseLeave={scheduleClose}
                    title={
                      pinnedThis ? "chat pinned — click to unpin" : "click to pin the column chat"
                    }
                    className={`cursor-pointer p-0 text-left align-bottom ${
                      chatActive
                        ? "border-x-2 border-t-2 border-primary bg-primary/10"
                        : `border-b border-l border-border ${
                            filtered ? "bg-primary/10" : selectedColumn === c ? "bg-bg-2" : ""
                          }`
                    }`}
                    style={{ minWidth: 96 }}
                  >
                    <div className="flex flex-col">
                      {meta && (
                        <div data-chat-nolock className="border-b border-border/60 pt-1">
                          <MiniColumnChart
                            meta={meta}
                            activeFilter={activeFilter}
                            onFilter={onFilter}
                          />
                        </div>
                      )}
                      <div className="flex w-full items-center justify-between gap-1 px-2 py-1.5">
                        <button
                          type="button"
                          onClick={() => onSelectColumn(c)}
                          className={`flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left text-[10px] ${
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
                          {meta?.mixedCount ? (
                            <span
                              title={`${meta.mixedCount.toLocaleString()} non-numeric value${
                                meta.mixedCount === 1 ? "" : "s"
                              } in a numeric column (e.g. "6+") — the coerce-numeric cleaning op parses the numeric prefix and nulls the rest`}
                              className="shrink-0 rounded border border-warn/50 bg-warn/10 px-1 font-mono text-[8px] uppercase tracking-wider text-warn"
                            >
                              mixed
                            </span>
                          ) : null}
                        </button>
                        {meta && (
                          <span data-chat-nolock className="contents">
                            {dateColSet.has(c) ? (
                              <ColumnFormatMenu
                                column={c}
                                onPick={(style) => onReformatColumnDates(c, style)}
                              />
                            ) : (
                              <TypeChip type={meta.type} />
                            )}
                          </span>
                        )}
                      </div>
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
                  const chatActive = activeChatCol === c;
                  return (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: clicking a body cell selects its column for the summary panel — a convenience mirror of the header button, which remains the keyboard-accessible path.
                    <td
                      key={c}
                      onClick={() => {
                        onSelectColumn(c);
                        // Clicking in a column pins its chat there; a click in
                        // an already-pinned column keeps it pinned (no toggle —
                        // cell clicks are how you inspect values).
                        if (lockedCol !== c) pinColumnChat(c);
                      }}
                      className={`cursor-pointer px-2 py-1 ${
                        chatActive
                          ? "border-b border-x-2 border-primary bg-primary/[0.06]"
                          : "border-b border-l border-border"
                      } ${
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
          pinned={lockedCol !== null}
          onEnter={cancelClose}
          onLeave={scheduleClose}
          onClose={() => {
            setLockedCol(null);
            setHoveredCol(null);
          }}
          onPin={() => pinColumnChat(hoveredMeta.name)}
          onLocalCommand={(text) => onColumnCommand(hoveredMeta.name, text)}
          onUndo={onUndo}
          undoLabel={undoLabel}
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
  'Column ops (same family, scoped to ONE column — point the user at these by key): `coerce-numeric` (column) parses the numeric prefix of mixed cells in a number column ("6+" -> 6) and nulls what\'s left over — the fix for columns flagged with a `mixed` badge. `recode-value` (column, from, to) recodes one categorical label to another — the fix for typo categories like "Seperated" -> "Separated".',
  "Combining datasets: up to 3 OFFLINE files can be loaded at once (the active dataset + 2 staged) and combined via the '+ combine data' toolbar button — smart append (schema-aligned row stacking, optional exact-duplicate drop) or key join (left / inner on a shared id-like column). When the user asks to merge / join / concatenate / stack / combine another file with this one, point them at that button; its review panel suggests a strategy and key per staged file with match evidence before applying.",
  "",
  "Dataset-wide cleaning: when the user asks to run a banner op (drop duplicate ROWS, drop empty/constant columns, normalise missing markers, fix encoding, trim/collapse whitespace, parse numeric/date strings, standardise booleans, replace sentinel numerics, merge case-only duplicates, rename headers to snake_case), DO NOT just name it — EMIT a fenced `clean` block. The client runs the deterministic cleaning engine immediately and renders a real before/after card:",
  "```clean",
  '{"ops": ["<op-key>"]}',
  "```",
  'Valid op keys: trim, collapse-whitespace, fix-encoding, missing-tokens, parse-numeric, coerce-numeric, parse-dates, standardise-booleans, replace-numeric-sentinels, null-future-years, drop-duplicates, drop-empty-cols, drop-constant-cols, lowercase-categoricals, rename-snake-case. Or {"ops": "safe"} for all safe fixes, {"ops": "all"} for every applicable op.',
  "",
  "Derived columns: when the user asks for any per-row transformation (round, log, sqrt, abs, clip, cap, normalise, bin, extract, derive, compute, calculate, etc.), DO NOT describe the formula. EMIT a fenced `derive` block. The client compiles the formula and adds the new column to the dataset IMMEDIATELY, so the user sees the result without copy-pasting anything.",
  "",
  "Format:",
  "```derive",
  '{"name": "<new_column_name>", "formula": "<expression>"}',
  "```",
  "",
  'Grammar inside the formula. Reference columns by bare name (paid, incurred) or backticks if the name has spaces (`Joined Date`). DO NOT prefix functions with "Math.". The new name must be a fresh snake_case identifier.',
  "- arithmetic: + - * / % **",
  "- math: log log10 log2 exp sqrt abs min max floor ceil round pow sign sin cos tan",
  "- logic: if(cond, a, b), coalesce(a, b, ...), isnull(x), == != > >= < <= && ||",
  "- strings: lower(x) upper(x) trim(x) len(x) replace(x, 'find', 'repl') concat(a, b, ...) str(x)",
  "- dates (timezone-free): to_us_date(x) to_iso_date(x) to_eu_date(x) to_long_date(x) year(x) month(x) day(x) weekday(x)",
  "- column aggregates (whole-column constants, the basis for imputation): mean(`col`) median(`col`) mode(`col`) colmin(`col`) colmax(`col`) colsum(`col`) colcount(`col`) stdev(`col`) — each takes a column reference, e.g. mean(`age`).",
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
    if (m.outliers) parts.push(`outliers=${m.outlierCount ?? m.outliers.length}`);
    if (m.mixedCount) parts.push(`mixed_non_numeric=${m.mixedCount}`);
    return `numeric · ${parts.join(", ")}`;
  }
  if (m.type === "date") {
    const range = m.dateMin && m.dateMax ? ` · range ${m.dateMin} → ${m.dateMax}` : "";
    return `date · ${m.unique} unique${range}`;
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

  // When the loaded rows are a sample of a bigger source (capped import /
  // restored snapshot), say so — otherwise the model asserts row counts that
  // don't match the user's file.
  const sourceTotal = dataset.sourceTotalRows ?? dataset.rows.length;
  const sampleNote =
    sourceTotal > dataset.rows.length
      ? ` (a sample of ${sourceTotal.toLocaleString()} source rows)`
      : "";
  lines.push(
    `DATASET: \`${dataset.name}\` — ${dataset.rows.length} rows${sampleNote}, ${dataset.columns.length} columns.`,
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
// `onFile(file)` and closes. ESC + outside-click dismiss. While `busy`
// the drop zone is swapped for the shared UploadIndicator so the parse
// is visibly in flight *inside* the modal (the canvas indicator sits
// behind the backdrop); `error` surfaces parse failures here for the
// same reason.
function ImportFileModal({
  open,
  onFile,
  onDismiss,
  busy,
  error,
}: {
  open: boolean;
  onFile: (file: File) => void | Promise<void>;
  onDismiss: () => void;
  busy?: UploadState | null;
  error?: string | null;
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
          {busy ? (
            <UploadIndicator layout="lg" state={busy} accent="warn" />
          ) : (
            <div className="flex w-full max-w-2xl flex-col items-center">
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
                className={`flex w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-8 py-12 transition ${
                  dragging ? "border-fg-mute bg-bg/60" : "border-border bg-bg-1 hover:border-fg-dim"
                }`}
              >
                <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-dim">
                  {dragging ? "release to load" : "drag a file in"}
                </span>
                <span className="font-mono text-sm text-fg-mute">or click to browse</span>
                <span className="mt-2 font-mono text-[10px] text-fg-dim">
                  .csv · .tsv · .parquet — column types are detected automatically
                </span>
              </button>
              {error && (
                <p className="mt-3 w-full break-words rounded border border-error/50 bg-bg-1 px-3 py-2 font-mono text-[10px] leading-relaxed text-error/90">
                  {error}
                </p>
              )}
              <input
                ref={inputRef}
                type="file"
                accept=".csv,.tsv,text/csv,text/tab-separated-values,.parquet,application/parquet,application/x-parquet,application/octet-stream"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void onFile(file);
                  // Reset so the same file can be re-selected if needed.
                  e.target.value = "";
                }}
              />
            </div>
          )}
        </div>
      </ChatModalPanel>
    </ChatModalBackdrop>
  );
}

// Chat write-up for an autonomous clean. Reports pass by pass, because the
// whole point of the multi-pass loop is that later passes fix things the
// earlier ones exposed — collapsing it to one flat list would hide that. Row
// and column drops are called out separately: they're the destructive part,
// and the user needs to see them without reading the step list.
function formatAutoCleanReport(result: AutoCleanResult): string {
  const lines: string[] = [];
  const stepCount = result.passes.reduce((n, p) => n + p.opLabels.length, 0);

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
        "I re-scanned after the last pass and found nothing further — the dataset is clean.",
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
  return lines.join("\n");
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
    stagedDatasets,
    setStagedDatasets,
    logEvent,
    clearEvents,
    pushHistory,
    undo,
    undoLabel,
    canUndo,
    clearHistory,
  } = useScelo();

  // Snapshot-then-replace. Every dataset TRANSFORM goes through here so it
  // is reversible; loading or clearing a dataset deliberately does not (see
  // clearHistory at those sites) because undoing across a file swap would
  // resurrect the previous file.
  const commitDataset = useCallback(
    (label: string, next: Dataset) => {
      pushHistory(label);
      setDataset(next);
    },
    [pushHistory, setDataset],
  );

  /** Shared by both chat surfaces: reverse the last transform and report it
   *  in the transcript. */
  const runUndo = useCallback((): string => {
    const label = undo();
    if (label === null) {
      return "There's nothing to undo — no changes have been made to this dataset yet.";
    }
    logEvent({ stage: "soft", kind: "dataset.undo", payload: { label } });
    return `Undone — reversed **${label}**. The grid is back to how it was before that step.`;
  }, [undo, logEvent]);
  // Reset the derived-columns registry and in-place transform log whenever
  // a fresh dataset replaces the current one. A derived formula on the
  // old schema won't apply to the new columns and shouldn't appear in
  // the badge list; an in-place transform fingerprint from the old
  // dataset shouldn't suppress a fresh application on the new one.
  // The ref guards against firing on first mount — the effect would
  // otherwise wipe formulas + log just restored from the session snapshot.
  const datasetNameForReset = dataset?.name ?? "";
  const lastResetNameRef = useRef(datasetNameForReset);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only react to dataset identity changes.
  useEffect(() => {
    if (lastResetNameRef.current === datasetNameForReset) return;
    lastResetNameRef.current = datasetNameForReset;
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
        // rows → column aggregates (mean/colsum/...) fold to a constant.
        compiled = compileFormula(formula, dataset.columns, { rows: dataset.rows });
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      const newRows: Row[] = dataset.rows.map((r) => ({
        ...r,
        [name]: compiled.evaluate(r),
      }));
      pushHistory(`add derived column \`${name}\``);
      setDataset({
        name: dataset.name,
        columns: [...dataset.columns, name],
        rows: newRows,
      });
      setDerivedColumns((prev) => ({ ...prev, [name]: formula }));
      logEvent({ stage: "soft", kind: "derived.add", payload: { name, formula } });
      return { ok: true };
    },
    [dataset, setDataset, setDerivedColumns, logEvent, pushHistory],
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
  // Wrangler all do this.) Columns with no other-column filters resolve to
  // the shared cache: one profiling pass per dataset version, shared with
  // the cleaning plan below and every other pane profiling this dataset —
  // profiling used to run twice here alone.
  const columnMetas = useMemo<ColumnMeta[]>(() => {
    if (!dataset) return [];
    const unfiltered = getColumnMetas(dataset);
    if (filters.length === 0) return unfiltered;
    return dataset.columns.map((c, i) => {
      const others = filters.filter((f) => f.column !== c);
      if (others.length === 0) return unfiltered[i];
      return summarise(applyFilters(dataset.rows, others), c);
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
  // is a dataset-wide operation, not a slice operation. The shared cache
  // keys on dataset object identity, so this resolves to the same pass as
  // the unfiltered columnMetas above rather than a second full profile.
  const rawMetas = useMemo<ColumnMeta[]>(() => (dataset ? getColumnMetas(dataset) : []), [dataset]);
  const cleaningPlan: CleaningPlan | null = useMemo(() => {
    if (!dataset) return null;
    return analyseCleaning(dataset, rawMetas);
  }, [dataset, rawMetas]);
  // Date columns drive the date-format toolbar (the click-to-reformat path).
  const dateColumns = useMemo(() => (dataset ? detectDateColumns(dataset) : []), [dataset]);
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

  // Core apply path — takes the explicit op set so both the banner (current
  // selection) and the chat command ("clean my data" → recommended defaults)
  // can drive it. Returns the human-readable labels of what it ran.
  const applyCleaningOps = useCallback(
    (ops: Set<CleaningOpKey>): string[] => {
      if (!dataset || !cleaningPlan) return [];
      const cleaned = applyCleaning(dataset, cleaningPlan, ops);
      const opLabels = cleaningPlan.ops
        .filter((op) => ops.has(op.key))
        .map((op) => describeOp(op, cleaningPlan.sampled).title);
      commitDataset(
        opLabels.length === 1 ? opLabels[0] : `cleaning (${opLabels.length} steps)`,
        cleaned,
      );
      // Recompute happens automatically through the dataset dep. We close the
      // panel so the user immediately sees the cleaner state.
      setCleaningOpen(false);
      setCleaningDismissed(false);
      // Reset filters because column/row identity may have shifted.
      setFilters([]);
      logEvent({ stage: "soft", kind: "cleaning.apply", payload: { opLabels } });
      return opLabels;
    },
    [dataset, cleaningPlan, setFilters, logEvent, commitDataset],
  );

  // Banner "apply cleaning" button — runs whatever the user currently has
  // checked. (Wired to onClick, so it must stay argless: the click event must
  // not leak in as an op set.)
  const onApplyCleaning = useCallback(() => {
    applyCleaningOps(enabledOps);
  }, [applyCleaningOps, enabledOps]);

  // ── Autonomous clean ───────────────────────────────────────────────────
  // Hands the whole dataset to `autoCleanDataset`, which loops
  // analyse→apply until the analyser stops proposing work. Deliberately does
  // NOT go through `applyCleaningOps`: that closes over the memoised
  // `cleaningPlan`, which is a single pass computed from the CURRENT dataset
  // and would still be the pass-1 plan for every later iteration (React has
  // not re-rendered mid-loop). The loop re-derives its own plan each pass.
  const runAutoClean = useCallback((): string => {
    if (!dataset) return "Load a dataset first, then I can clean it end to end.";

    const result: AutoCleanResult = autoCleanDataset(dataset, getColumnMetas);

    if (result.outcome === "empty") {
      return "There's nothing to clean yet — the dataset has no rows.";
    }
    if (result.passes.length === 0) {
      // Reached the fixed point without applying anything: already clean.
      return "I went through the whole dataset and found nothing to fix — no whitespace, missing markers, mistyped columns, duplicate rows, or dead columns. It's already clean.";
    }

    commitDataset(`auto-clean (${result.passes.length} passes)`, result.dataset);
    setFilters([]);
    logEvent({
      stage: "soft",
      kind: "cleaning.auto",
      payload: {
        passes: result.passes.length,
        outcome: result.outcome,
        opLabels: result.passes.flatMap((p) => p.opLabels),
        rowsBefore: result.rowsBefore,
        rowsAfter: result.rowsAfter,
        columnsBefore: result.columnsBefore,
        columnsAfter: result.columnsAfter,
        droppedColumns: result.droppedColumns,
      },
    });
    return formatAutoCleanReport(result);
  }, [dataset, setFilters, logEvent, commitDataset]);

  // One-press affordances in the chat. Kept to the single action that is
  // genuinely tedious to phrase and has exactly one sensible execution.
  const softChatActions = useMemo<ChatAction[]>(
    () => [
      {
        id: "undo",
        label: undoLabel ? `Undo: ${undoLabel}` : "Undo",
        prompt: "Undo the last change.",
        hint: undoLabel
          ? `Reverse "${undoLabel}" and restore the dataset to how it was before that step.`
          : undefined,
        disabledReason: canUndo ? null : "Nothing to undo yet.",
        run: runUndo,
      },
      {
        id: "auto-clean",
        label: "Auto-clean dataset",
        prompt: "Go through the entire dataset and clean it until it's fully clean.",
        hint: dataset
          ? `Repeatedly scan and fix the whole dataset until nothing is left to fix (up to ${AUTO_CLEAN_MAX_PASSES} passes). Applies every fix it finds, including removing duplicate rows and dropping empty or single-valued columns. This rewrites the dataset and can't be undone.`
          : undefined,
        disabledReason: dataset ? null : "Load a dataset first.",
        run: runAutoClean,
      },
    ],
    [dataset, runAutoClean, runUndo, undoLabel, canUndo],
  );

  const toggleOp = useCallback((key: CleaningOpKey) => {
    setEnabledOps((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Rewrite the date column(s) into a chosen display style, in place. Used by
  // the chat ("make the dates american format") so the request actually
  // mutates the grid instead of just describing what to do.
  // Core reformatter — takes an explicit column list (one column for the
  // per-column badge/chat, all detected columns for the global toolbar/chat),
  // mutates the grid, logs, and returns a human-readable summary.
  const reformatColumnsTo = useCallback(
    (cols: string[], style: DateStyle): string => {
      if (!dataset) return "Load a dataset first, then ask me to reformat its dates.";
      if (cols.length === 0) {
        return "I couldn't find a date column to reformat — none of the columns look like dates. If a date column is stored oddly, tidy it first (try `clean my data`).";
      }
      const {
        dataset: next,
        changed,
        columns: colStats,
      } = reformatDateColumns(dataset, cols, style);
      if (changed === 0) {
        return `${cols.length === 1 ? `\`${cols[0]}\` is` : "Those date columns are"} already in ${DATE_STYLE_LABEL[style]} format — nothing to change.`;
      }
      commitDataset(`reformat dates to ${DATE_STYLE_LABEL[style]}`, next);
      setFilters([]);
      logEvent({
        stage: "soft",
        kind: "cleaning.reformat-dates",
        payload: { style, columns: cols, changed },
      });
      const named = colStats
        .filter((c) => c.changed > 0)
        .map((c) => `\`${c.name}\`${c.dayFirst ? " (read as day-first DD/MM)" : ""}`)
        .join(", ");
      const unparsed = colStats.reduce((n, c) => n + c.unparsed, 0);
      const caveat =
        unparsed > 0
          ? ` ${unparsed.toLocaleString()} cell${unparsed === 1 ? "" : "s"} weren't recognisable dates and were left unchanged.`
          : "";
      return `Done — reformatted ${named} to ${DATE_STYLE_LABEL[style]} (${changed.toLocaleString()} cell${
        changed === 1 ? "" : "s"
      }).${caveat} The data grid now shows the new format.`;
    },
    [dataset, setFilters, logEvent, commitDataset],
  );

  // Reformat every detected date column at once (global toolbar + soft chat).
  // Union the analyser's date columns with a robust direct scan — the scan
  // infers each column's format (incl. day-first / European), so it catches
  // mixed-format columns the plan's stricter detector can miss.
  const reformatDatesInDataset = useCallback(
    (style: DateStyle): string => {
      if (!dataset) return "Load a dataset first, then ask me to reformat its dates.";
      const planDateCols =
        cleaningPlan?.ops.flatMap((op) => (op.key === "parse-dates" ? op.columns : [])) ?? [];
      const dateCols = [...new Set([...detectDateColumns(dataset), ...planDateCols])];
      return reformatColumnsTo(dateCols, style);
    },
    [dataset, cleaningPlan, reformatColumnsTo],
  );

  // Single-column reformat for the badge dropdown — surfaces a toast since
  // there's no chat bubble to fill. (The grid badge is the only button path;
  // the bottom soft-chat still drives the all-columns reformat via text.)
  const onReformatColumnDates = useCallback(
    (column: string, style: DateStyle) => {
      const msg = reformatColumnsTo([column], style);
      emitToast(msg, /already in|couldn't find/.test(msg) ? "info" : "success");
    },
    [reformatColumnsTo],
  );

  // Execute a parsed column operation against the live dataset and narrate
  // what happened. Shared by the column hover-chat (hovered column) and the
  // soft stage chat (column resolved from the message text). Always returns a
  // reply — once an intent parses, the request must mutate the grid, never
  // fall through to the AI as advice.
  const runColumnOpIntent = useCallback(
    (column: string, intent: ColumnOpIntent): string => {
      if (!dataset) return "Load a dataset first.";
      const commit = (next: Dataset, action: string, affected: number, reply: string): string => {
        commitDataset(`${action} on \`${column}\``, next);
        setFilters([]);
        logEvent({ stage: "soft", kind: "cleaning.column", payload: { column, action, affected } });
        return reply;
      };
      const plural = (n: number) => (n === 1 ? "" : "s");
      switch (intent.kind) {
        case "to-string": {
          const { dataset: next, converted } = convertColumnToString(dataset, column);
          if (converted === 0) {
            return `\`${column}\` is already all text — no numeric cells to convert.`;
          }
          return commit(
            next,
            "converted to string",
            converted,
            `Done — converted ${converted.toLocaleString()} numeric cell${plural(converted)} in \`${column}\` to text. The column is now uniformly string-typed.`,
          );
        }
        case "to-number": {
          const {
            dataset: next,
            converted,
            nulled,
          } = convertColumnToNumber(dataset, column, intent.integer);
          if (converted === 0 && nulled === 0) {
            return `\`${column}\` is already fully numeric — nothing to convert.`;
          }
          const label = intent.integer ? "integer" : "numeric";
          const nulledNote =
            nulled > 0
              ? ` ${nulled.toLocaleString()} cell${plural(nulled)} had no usable number and became null.`
              : "";
          return commit(
            next,
            `coerced to ${label}`,
            converted + nulled,
            `Done — coerced ${converted.toLocaleString()} cell${plural(converted)} in \`${column}\` to ${label} values.${nulledNote}`,
          );
        }
        case "case": {
          const { dataset: next, changed } = transformColumnCase(dataset, column, intent.mode);
          const label =
            intent.mode === "lower"
              ? "lowercase"
              : intent.mode === "upper"
                ? "UPPERCASE"
                : "Title Case";
          if (changed === 0) return `\`${column}\` is already ${label} — nothing to change.`;
          return commit(
            next,
            `recased to ${label}`,
            changed,
            `Done — recased ${changed.toLocaleString()} cell${plural(changed)} in \`${column}\` to ${label}.`,
          );
        }
        case "round": {
          const { dataset: next, changed } = roundColumnValues(dataset, column, intent.decimals);
          const label =
            intent.decimals === 0
              ? "whole numbers"
              : `${intent.decimals} decimal place${plural(intent.decimals)}`;
          if (changed === 0) {
            return `Nothing to round in \`${column}\` — its numeric cells are already at ${label} (text cells are left alone).`;
          }
          return commit(
            next,
            `rounded to ${label}`,
            changed,
            `Done — rounded ${changed.toLocaleString()} cell${plural(changed)} in \`${column}\` to ${label}.`,
          );
        }
        case "fill-missing": {
          const {
            dataset: next,
            filled,
            fillValue,
          } = fillMissingInColumn(dataset, column, intent.filler);
          if (fillValue === null) {
            return `I can't compute a fill value for \`${column}\` — it has no usable non-missing cells to derive one from. Tell me the value: "fill missing with 0".`;
          }
          if (filled === 0) return `\`${column}\` has no missing cells — nothing to fill.`;
          const how =
            intent.filler === "auto"
              ? ` (auto-picked the column ${typeof fillValue === "number" ? "median" : "mode"})`
              : typeof intent.filler === "string" && intent.filler !== "zero"
                ? ` (the column ${intent.filler})`
                : "";
          return commit(
            next,
            `filled missing with ${String(fillValue)}`,
            filled,
            `Done — filled ${filled.toLocaleString()} missing cell${plural(filled)} in \`${column}\` with ${
              typeof fillValue === "string" ? `"${fillValue}"` : fillValue.toLocaleString()
            }${how}.`,
          );
        }
        case "remove-outliers": {
          const meta = rawMetas.find((m) => m.name === column);
          const res = removeOutlierRows(dataset, column, meta);
          if (res === null) {
            return `\`${column}\` isn't a numeric column with an outlier fence, so there are no outliers to remove here.`;
          }
          if (res.removed === 0) {
            return `No outliers in \`${column}\` — every value already sits inside the Tukey fences [${res.lo.toLocaleString()}, ${res.hi.toLocaleString()}].`;
          }
          return commit(
            res.dataset,
            "removed outlier rows",
            res.removed,
            `Done — removed ${res.removed.toLocaleString()} row${plural(res.removed)} where \`${column}\` fell outside the Tukey fences [${res.lo.toLocaleString()}, ${res.hi.toLocaleString()}]. The dataset now has ${res.dataset.rows.length.toLocaleString()} rows.`,
          );
        }
        case "drop-column": {
          if (dataset.columns.length <= 1) {
            return `\`${column}\` is the only column left — dropping it would empty the dataset, so I left it alone.`;
          }
          const { dataset: next } = dropColumnFromDataset(dataset, column);
          setDerivedColumns((prev) => {
            if (!(column in prev)) return prev;
            const { [column]: _omit, ...rest } = prev;
            return rest;
          });
          return commit(
            next,
            "dropped column",
            dataset.rows.length,
            `Done — dropped \`${column}\`. The dataset now has ${next.columns.length} columns.`,
          );
        }
        case "trim": {
          const { dataset: next, tidied, nulled } = cleanColumnCells(dataset, column);
          if (tidied === 0 && nulled === 0) {
            return `\`${column}\` has no stray whitespace or encoding junk — already tidy.`;
          }
          const nulledNote =
            nulled > 0
              ? ` and nulled ${nulled.toLocaleString()} missing-marker${plural(nulled)}`
              : "";
          return commit(
            next,
            "trimmed whitespace",
            tidied + nulled,
            `Done — trimmed / tidied ${tidied.toLocaleString()} cell${plural(tidied)} in \`${column}\`${nulledNote}.`,
          );
        }
      }
    },
    [dataset, rawMetas, setDerivedColumns, setFilters, logEvent, commitDataset],
  );

  // Per-column natural-language intent (the hover chat popover). Same date-style
  // detection as the soft chat, but scoped to the hovered column so "make this
  // american" / "change to ISO" affect only that column. Returns the assistant
  // reply, or null to fall through to the provider for anything else.
  const handleColumnChatCommand = useCallback(
    (column: string, text: string): string | null => {
      if (!dataset) return null;
      const t = text.toLowerCase().trim();
      const isDateCol = () =>
        dateColumns.includes(column) || detectDateColumns(dataset).includes(column);

      // ── undo ─────────────────────────────────────────────────────────────
      // Checked first: "undo that" must never be parsed as an operation to
      // APPLY to the column. Kept deliberately narrow — only an explicit
      // undo/revert/rollback verb, so "revert the codes to uppercase" (a
      // real transform request) still falls through to the parsers below.
      if (
        /^\s*(undo|revert|rollback|roll back|go back|take that back)\b/.test(t) ||
        /\b(undo|revert|roll ?back) (that|the )?(last |previous )?(change|step|edit|thing|one|it)?\s*$/.test(
          t,
        )
      ) {
        return runUndo();
      }

      // ── remove / clear non-date values ───────────────────────────────────
      const removeVerb = /\b(remove|clear|drop|delete|strip|null|blank|get rid of|discard)\b/.test(
        t,
      );
      const nonDateNoun = /\bnon[\s-]?dates?\b|\bnot? a? ?dates?\b|\binvalid dates?\b/.test(t);
      if (removeVerb && nonDateNoun) {
        if (!isDateCol()) {
          return `\`${column}\` doesn't look like a date column, so there are no non-date values to remove.`;
        }
        const { dataset: next, cleared } = clearNonDateCells(dataset, column);
        if (cleared === 0) {
          return `Every value in \`${column}\` already parses as a date — nothing to remove.`;
        }
        commitDataset(`clear non-dates in \`${column}\``, next);
        setFilters([]);
        logEvent({
          stage: "soft",
          kind: "cleaning.column",
          payload: { column, action: "cleared non-date values (set to null)", affected: cleared },
        });
        return `Done — cleared ${cleared.toLocaleString()} non-date value${
          cleared === 1 ? "" : "s"
        } in \`${column}\` (set to null). The column now holds only dates and blanks.`;
      }

      // ── date-format intent (american / european / iso) ───────────────────
      const wantsUs = /\b(american|america|u\.?s\.?a?|mm\/dd|mdy|month[\s-]?first)\b/.test(t);
      const wantsEu = /\b(european|europe|uk|british|dd\/mm|dmy|day[\s-]?first)\b/.test(t);
      const wantsIso = /\b(iso|iso[\s-]?8601|yyyy-mm-dd|standard)\b/.test(t);
      const stylePicked = wantsUs || wantsEu || wantsIso;
      const formatVerb =
        /\b(format|reformat|convert|display|style|show|standardi[sz]e|change|make|turn)\b/.test(t);
      const mentionsDate = /\bdates?\b/.test(t);
      if (stylePicked || (mentionsDate && formatVerb)) {
        if (!isDateCol()) {
          return `\`${column}\` doesn't look like a date column, so there's no date format to change here.`;
        }
        const style: DateStyle = wantsUs ? "us" : wantsEu ? "eu" : "iso";
        return reformatColumnsTo([column], style);
      }

      // ── generic column operations ────────────────────────────────────────
      // Type conversion, casing, rounding, fill-missing, outlier removal,
      // drop, trim — parsed deterministically so "convert this column to
      // string" mutates the grid instead of returning advice.
      const opIntent = parseColumnOpIntent(text);
      if (opIntent) return runColumnOpIntent(column, opIntent);

      // ── clean this column ────────────────────────────────────────────────
      // Trim, repair encoding, collapse whitespace, null missing-markers — and
      // for a date column, also clear leftover non-date junk.
      if (/\b(clean|cleanse|tidy|scrub|sanit[iy][sz]e)\b/.test(t)) {
        let working = dataset;
        const parts: string[] = [];
        const { dataset: tidiedDs, tidied, nulled } = cleanColumnCells(working, column);
        working = tidiedDs;
        if (tidied > 0)
          parts.push(`tidied ${tidied.toLocaleString()} cell${tidied === 1 ? "" : "s"}`);
        if (nulled > 0)
          parts.push(`nulled ${nulled.toLocaleString()} missing-marker${nulled === 1 ? "" : "s"}`);
        let clearedDates = 0;
        if (isDateCol()) {
          const res = clearNonDateCells(working, column);
          working = res.dataset;
          clearedDates = res.cleared;
          if (clearedDates > 0)
            parts.push(
              `cleared ${clearedDates.toLocaleString()} non-date value${clearedDates === 1 ? "" : "s"}`,
            );
        }
        if (parts.length === 0) {
          return `\`${column}\` already looks clean — no whitespace, encoding, missing-marker${
            isDateCol() ? ", or non-date" : ""
          } issues to fix.`;
        }
        commitDataset(`clean \`${column}\``, working);
        setFilters([]);
        logEvent({
          stage: "soft",
          kind: "cleaning.column",
          payload: { column, action: parts.join(", "), affected: tidied + nulled + clearedDates },
        });
        return `Done — cleaned \`${column}\`: ${parts.join(", ")}.`;
      }

      return null;
    },
    [
      dataset,
      dateColumns,
      reformatColumnsTo,
      runColumnOpIntent,
      setFilters,
      logEvent,
      commitDataset,
      runUndo,
    ],
  );

  // Deterministic chat intents handled client-side, so they work even though
  // the desktop IDE ships no chat backend. Two intents today:
  //   • date reformatting ("make the dates american format")  → reformat the
  //     date column(s) to the requested style and mutate the grid.
  //   • generic cleaning ("clean my data")                    → run the plan.
  // Returns the assistant reply, or null to let the message fall through to
  // the orchestrator / direct provider.
  const handleSoftChatCommand = useCallback(
    (text: string): string | null => {
      const t = text.toLowerCase().trim();

      // ── undo ─────────────────────────────────────────────────────────────
      // Checked first: "undo that" must never be parsed as an operation to
      // APPLY to the column. Kept deliberately narrow — only an explicit
      // undo/revert/rollback verb, so "revert the codes to uppercase" (a
      // real transform request) still falls through to the parsers below.
      if (
        /^\s*(undo|revert|rollback|roll back|go back|take that back)\b/.test(t) ||
        /\b(undo|revert|roll ?back) (that|the )?(last |previous )?(change|step|edit|thing|one|it)?\s*$/.test(
          t,
        )
      ) {
        return runUndo();
      }

      // ── data augmentation ────────────────────────────────────────────────
      // "add 1000 more rows through augmentation", "generate synthetic rows",
      // "bootstrap 500 records". Bootstrap-resamples + jitters numerics.
      const augmentation =
        /\b(augment|augmentation|synthetic|synthesi[sz]e|bootstrap)\b/.test(t) ||
        (/\b(add|generate|create|expand|inflate|duplicate)\b/.test(t) &&
          /\b(rows?|records?|samples?|observations?|data\s?points?)\b/.test(t));
      if (augmentation) {
        if (!dataset) return "Load a dataset first, then I can augment it.";
        if (dataset.rows.length === 0) {
          return "There's no data to augment yet — load some rows first.";
        }
        const numMatch = t.match(/\b(\d[\d,]*)\b/);
        const requested = numMatch ? Number.parseInt(numMatch[1].replace(/,/g, ""), 10) : 100;
        const usedDefault = !numMatch;
        const CAP = 500_000;
        const toAdd = Math.min(Math.max(1, requested), CAP);
        const { dataset: next, added } = augmentDataset(dataset, rawMetas, toAdd);
        if (added === 0) return "There's no data to augment yet — load some rows first.";
        commitDataset(`augment (+${added.toLocaleString()} rows)`, next);
        setFilters([]);
        logEvent({
          stage: "soft",
          kind: "data.augment",
          payload: { added, method: "bootstrap resample + Gaussian jitter" },
        });
        const capNote = toAdd < requested ? ` (capped from ${requested.toLocaleString()})` : "";
        const defNote = usedDefault ? " (you didn't give a number, so I added 100)" : "";
        return `Done — added ${added.toLocaleString()} synthetic row${
          added === 1 ? "" : "s"
        }${capNote}${defNote} by bootstrap-resampling real rows with light Gaussian jitter on numeric columns. Categoricals, dates, and ID-like columns are preserved. The dataset now has ${next.rows.length.toLocaleString()} rows.\n\nThis is a fast intake-stage augmentation — for correlation-preserving synthesis (SMOTE, copulas, CTGAN), use the modeling stage.`;
      }

      // ── date-format intent ───────────────────────────────────────────────
      // Fires when the user names a date style (american / european / iso) OR
      // says "date" together with a format verb. We deliberately DON'T require
      // the literal word "date": "format the dataset american style" clearly
      // means the dates, and we only act if date columns actually exist (the
      // reformatter says so otherwise). Checked before generic cleaning so a
      // style request reformats rather than canonicalising to ISO.
      const mentionsDate = /\bdates?\b/.test(t);
      const wantsUs = /\b(american|america|u\.?s\.?a?|mm\/dd|mdy|month[\s-]?first)\b/.test(t);
      const wantsEu = /\b(european|europe|uk|british|dd\/mm|dmy|day[\s-]?first)\b/.test(t);
      const wantsIso = /\b(iso|iso[\s-]?8601|yyyy-mm-dd|standard)\b/.test(t);
      const stylePicked = wantsUs || wantsEu || wantsIso;
      const formatVerb =
        /\b(format|reformat|convert|display|style|show|standardi[sz]e|change|make)\b/.test(t);
      const dataNoun = /\b(date|dates|dataset|data|column|columns|values?|everything|all)\b/.test(
        t,
      );
      if ((stylePicked && (formatVerb || dataNoun)) || (mentionsDate && formatVerb)) {
        const style: DateStyle = wantsUs ? "us" : wantsEu ? "eu" : "iso";
        return reformatDatesInDataset(style);
      }

      // ── column-scoped operations ("convert the airbags column to string") ──
      // Same deterministic parser as the hover chat; the target column is
      // resolved from the message text. Whole-dataset trim routes to the
      // cleaning plan's whitespace ops instead of demanding a column name.
      const opIntent = parseColumnOpIntent(text);
      if (opIntent) {
        if (!dataset) return "Load a dataset first, then I can transform its columns.";
        const cols = resolveColumnsMentioned(text, dataset.columns);
        if (cols.length === 1) return runColumnOpIntent(cols[0], opIntent);
        if (cols.length > 1) {
          return `You named ${cols.length} columns (${cols
            .map((c) => `\`${c}\``)
            .join(", ")}) — I apply these one column at a time. Which one first?`;
        }
        const wholeDataset = /\b(dataset|data|everything|all|entire|whole)\b/.test(t);
        if (opIntent.kind === "trim" && wholeDataset && cleaningPlan) {
          const wsOps = new Set<CleaningOpKey>(
            (["trim", "collapse-whitespace"] as const).filter((k) =>
              cleaningPlan.ops.some((op) => op.key === k),
            ),
          );
          if (wsOps.size === 0)
            return "No stray whitespace anywhere — the dataset is already tidy.";
          const applied = applyCleaningOps(wsOps);
          return `Done — ${applied.join(" and ")}. The grid now shows the trimmed data.`;
        }
        return `Which column should I apply that to? Name it — e.g. \`${dataset.columns[0]}\`.`;
      }

      const mentionsClean =
        /\b(clean|cleanse|cleaning|tidy|sanit[iy][sz]e|scrub|wrangle|preprocess|pre-process)\b/.test(
          t,
        );
      const cleanPhrase =
        /\b(initial clean|do the cleaning|run (the )?cleaning|fix (the |my )?data)\b/.test(t);
      if (!mentionsClean && !cleanPhrase) return null;

      // ── autonomous clean ─────────────────────────────────────────────────
      // Same loop the "Auto-clean dataset" chip runs. Checked BEFORE the
      // single-pass branch below so "clean the whole thing until it's done"
      // converges instead of applying one pass of the safe defaults. Requires
      // an explicit exhaustive/autonomous cue — a plain "clean my data" stays
      // on the conservative single-pass path, which doesn't drop rows or
      // columns.
      const wantsAutonomous =
        /\b(auto[\s-]?clean|automatically|autonomous(ly)?|by yourself|on your own|as you see fit|however you see fit|without me|no input|don'?t ask)\b/.test(
          t,
        ) ||
        /\b(fully|completely|entirely|thoroughly|properly|deep)\b.*\bclean\b/.test(t) ||
        /\bclean\b.*\b(fully|completely|entirely|thoroughly|properly|everything|all of it)\b/.test(
          t,
        ) ||
        /\b(until|till)\b.*\b(clean|done|nothing|finished|no more)\b/.test(t) ||
        /\b(entire|whole|all the)\b.*\bdataset\b.*\bclean/.test(t) ||
        /\bclean\b.*\b(entire|whole)\b.*\b(dataset|data|thing)\b/.test(t) ||
        /\b(repeat|keep|carry on|again and again)\b.*\bclean/.test(t);
      if (wantsAutonomous) {
        if (!dataset) return "Load a dataset first, then I can clean it end to end.";
        return runAutoClean();
      }

      if (!dataset) return "Load a dataset first, then ask me to clean it.";
      if (!cleaningPlan || cleaningPlan.ops.length === 0) {
        return "I scanned the dataset and found no cleaning steps to apply — it already looks tidy.";
      }

      // Use the user's current banner selection if they've made one; otherwise
      // run the recommended default set.
      const ops = enabledOps.size > 0 ? enabledOps : defaultEnabled(cleaningPlan);
      const applied = applyCleaningOps(ops);
      if (applied.length === 0) {
        return "No cleaning steps are selected right now, so I left the data unchanged. Open the cleaning banner above the grid to pick steps.";
      }
      const list = applied.map((a) => `- ${a}`).join("\n");
      return `Done — ran the initial cleaning (${applied.length} step${
        applied.length === 1 ? "" : "s"
      }):\n\n${list}\n\nThe data grid now reflects the cleaned dataset.`;
    },
    [
      dataset,
      cleaningPlan,
      enabledOps,
      applyCleaningOps,
      runAutoClean,
      reformatDatesInDataset,
      runColumnOpIntent,
      rawMetas,
      setFilters,
      logEvent,
      runUndo,
      commitDataset,
    ],
  );

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
  const [workspacePreviewOpen, setWorkspacePreviewOpen] = useState(false);
  const loadSample = useCallback(
    (key: SampleKey) => {
      const opt = SAMPLE_OPTIONS.find((o) => o.key === key);
      if (!opt) return;
      const ds = opt.build();
      // Loading a fresh dataset starts a new reproducibility session — wipe
      // the prior log so the new export doesn't replay events from the old
      // dataset that no longer exist.
      clearEvents();
      clearHistory();
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
    [clearEvents, setDataset, setFilters, logEvent, clearHistory],
  );

  // Status banner for slow / failed uploads. CSV parsing streams and reports
  // per-chunk progress (pct + rows seen); parquet is a single await. Either
  // way the user sees it's working, and decode errors surface cleanly
  // instead of failing silent.
  const [uploadState, setUploadState] = useState<
    | { kind: "idle" }
    | { kind: "loading"; name: string; pct?: number; rowsSeen?: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  // Which intake drove the current parse — selects the loading verb ("parsing"
  // vs "staging"). Set once per parse in the entry points; the streamer's
  // onProgress only ever writes pct/rowsSeen, so the verb stays stable.
  const [uploadOp, setUploadOp] = useState<"import" | "stage">("import");
  // combineAll() runs synchronously on the main thread; combineBusy drives a
  // dimmed overlay that paints (via an async tick) before the merge blocks. It
  // holds the total dataset count captured at trigger time (not live state,
  // which the merge clears to empty), so the "combining N datasets" label stays
  // correct for the whole overlay lifetime; null = not combining.
  const [combineBusy, setCombineBusy] = useState<number | null>(null);
  // Map the raw upload union into the loading primitive's shape, then hold it
  // on screen for a 350ms floor so a sub-100ms parse of a tiny file animates
  // instead of flashing. `heldUpload && !dataset` drives the big empty-state
  // card; `heldUpload && dataset` drives the inline header strip.
  const rawUpload: UploadState | null =
    uploadState.kind === "loading"
      ? {
          verb: /\.parquet$/i.test(uploadState.name)
            ? "decoding"
            : uploadOp === "stage"
              ? "staging"
              : "parsing",
          name: uploadState.name,
          pct: uploadState.pct,
          rowsSeen: uploadState.rowsSeen,
        }
      : null;
  const heldUpload = useMinVisible(rawUpload, 350);
  // Post-import advisory (malformed-row padding, combine summaries). Keyed to
  // the dataset name so it disappears once another dataset replaces the
  // import. `label` overrides the strip's default "import notice" tag.
  const [importNotice, setImportNotice] = useState<{
    dataset: string;
    label?: string;
    message: string;
  } | null>(null);
  // Sampling-banner dismissal is per dataset name — a new import gets a
  // fresh banner.
  const [sampleNoticeDismissed, setSampleNoticeDismissed] = useState<string | null>(null);

  // Core parser — turns a CSV / TSV / TXT / Parquet File into a Dataset
  // WITHOUT making it the active dataset. Shared by the normal import path
  // (onPickFileObject) and the combine staging path (onStageFileObject).
  // Streams CSV progress into the upload banner; throws on unsupported /
  // binary / empty files.
  const parseFileToDataset = useCallback(
    async (file: File): Promise<{ dataset: Dataset; malformedRows: number }> => {
      const name = file.name;
      const lower = name.toLowerCase();
      const isParquet = lower.endsWith(".parquet") || file.type === "application/parquet";
      const hasTextExt = /\.(csv|tsv|txt)$/.test(lower);
      const hasCsvMime =
        file.type === "text/csv" ||
        file.type === "application/csv" ||
        file.type === "text/tab-separated-values";
      let parsed: {
        columns: string[];
        rows: Row[];
        sampled?: boolean;
        sourceTotalRows?: number;
        sampleKind?: "uniform" | "first";
      };
      let malformedRows = 0;
      if (isParquet) {
        parsed = await parseParquet(file);
      } else if (hasTextExt || hasCsvMime || file.type === "") {
        // .csv / .tsv declare their delimiter; .txt and extension-less
        // unknown-MIME files must pass the first-KB sniff (printable
        // ratio + consistent delimiter) so a mislabelled binary never
        // reaches the row parser.
        let delimiter: string;
        if (lower.endsWith(".csv") || lower.endsWith(".tsv") || hasCsvMime) {
          delimiter = delimiterFor(lower);
        } else {
          const sniffed = await sniffDelimitedText(file);
          if (sniffed === null) {
            throw new Error(
              "This file doesn't look like delimited text (binary content, or no consistent delimiter in the first KB) — try .csv, .tsv, or .parquet.",
            );
          }
          delimiter = sniffed;
        }
        // Progress paints ~10×/sec; an unthrottled per-chunk setState
        // would re-render the workstation hundreds of times on a 300 MB
        // file for no visible benefit.
        let lastPaint = 0;
        const result = await streamParseCsv(file, {
          delimiter,
          maxRows: DEFAULT_IMPORT_ROW_CAP,
          onProgress: ({ bytesRead, totalBytes, rowsSeen }) => {
            const now = Date.now();
            if (now - lastPaint < 100) return;
            lastPaint = now;
            setUploadState({
              kind: "loading",
              name,
              pct: totalBytes > 0 ? Math.min(100, (100 * bytesRead) / totalBytes) : undefined,
              rowsSeen,
            });
          },
        });
        malformedRows = result.malformedRows;
        parsed = {
          columns: result.header,
          rows: rowsFromCsvCells(result.header, result.rows),
          sampled: result.sampled,
          sourceTotalRows: result.sampled ? result.totalDataRows : undefined,
          sampleKind: result.sampled ? "uniform" : undefined,
        };
      } else {
        throw new Error(`Unsupported file type: ${file.type || "unknown"} — try .csv or .parquet`);
      }
      if (parsed.columns.length === 0 || parsed.rows.length === 0) {
        throw new Error("The file parsed cleanly but produced no rows or columns.");
      }
      const ds: Dataset = { name, columns: parsed.columns, rows: parsed.rows };
      if (parsed.sampled && parsed.sourceTotalRows !== undefined) {
        ds.sampled = true;
        ds.sourceTotalRows = parsed.sourceTotalRows;
        ds.sampleKind = parsed.sampleKind;
      }
      return { dataset: ds, malformedRows };
    },
    [],
  );

  // Parse + load path. Accepts a File directly so both `<input type="file"
  // onChange>` and the import-modal drag/drop handler can share it without
  // each having to re-implement the dispatch.
  const onPickFileObject = useCallback(
    async (file: File) => {
      setUploadOp("import");
      setUploadState({ kind: "loading", name: file.name });
      setImportNotice(null);
      try {
        const { dataset: ds, malformedRows } = await parseFileToDataset(file);
        clearEvents();
        clearHistory();
        setDataset(ds);
        setSelected(ds.columns[0]);
        setFilters([]);
        setUploadState({ kind: "idle" });
        setImportModalOpen(false);
        if (malformedRows > 0) {
          setImportNotice({
            dataset: ds.name,
            message: `${malformedRows.toLocaleString()} malformed row${
              malformedRows === 1 ? " was" : "s were"
            } padded / truncated to the header's column count.`,
          });
        }
        logEvent({
          stage: "soft",
          kind: "dataset.load",
          payload: {
            name: ds.name,
            rows: ds.rows.length,
            cols: ds.columns.length,
            columns: ds.columns,
            source: "import",
            ...(ds.sourceTotalRows !== undefined
              ? { sampled: true, sourceTotalRows: ds.sourceTotalRows }
              : {}),
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error parsing file.";
        setUploadState({ kind: "error", message: msg });
      } finally {
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [parseFileToDataset, clearEvents, setDataset, setFilters, logEvent, clearHistory],
  );

  const onPickFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await onPickFileObject(file);
  };

  const [importModalOpen, setImportModalOpen] = useState(false);

  // ── multi-dataset combine ──────────────────────────────────────────────────
  // Extra offline imports staged next to the active dataset live in the Scelo
  // context (session-only); the per-staged step overrides + panel open state
  // are local. `combineModalOpen` mirrors `importModalOpen` — the same
  // ImportFileModal frame, routed at the staging handler instead.
  const [combineModalOpen, setCombineModalOpen] = useState(false);
  const [combineOpen, setCombineOpen] = useState(false);
  const [combineSteps, setCombineSteps] = useState<CombineStep[]>([]);

  // Smart per-pair suggestion for every staged dataset. NOTE: for the SECOND
  // staged dataset the true base at execution time is the RESULT of the first
  // step, but suggesting against the active dataset is acceptable — both
  // strategies preserve every base column, so a key picked here stays valid
  // in the intermediate result, and the evidence shown stays stable.
  const combineSuggestions = useMemo<CombineSuggestion[]>(
    () => (dataset ? stagedDatasets.map((s) => suggestCombine(dataset, s)) : []),
    [dataset, stagedDatasets],
  );

  // Keep the step overrides aligned with the staged list and valid against
  // the CURRENT active dataset: re-derive defaults on drift (remount with
  // files still staged in context, active dataset swapped, or a cleaning op
  // renamed the join key away).
  useEffect(() => {
    setCombineSteps((prev) => {
      if (!dataset) return prev.length === 0 ? prev : [];
      let changed = prev.length !== stagedDatasets.length;
      const next = stagedDatasets.map((ds, i) => {
        const fallback = combineSuggestions[i]?.step ?? { strategy: "append" as const };
        const cur = prev[i];
        if (!cur) {
          changed = true;
          return fallback;
        }
        if (cur.strategy !== "append") {
          const keyOk =
            cur.key !== undefined &&
            dataset.columns.includes(cur.key) &&
            (cur.rightKey === undefined || ds.columns.includes(cur.rightKey));
          if (!keyOk) {
            changed = true;
            return fallback;
          }
        }
        return cur;
      });
      return changed ? next : prev;
    });
  }, [dataset, stagedDatasets, combineSuggestions]);

  // Stage an additional offline file for combining. Same parser as the
  // normal import path, but the result joins the staging list instead of
  // replacing the active dataset. Offline files only by construction —
  // samples and simulations never route here.
  const onStageFileObject = useCallback(
    async (file: File) => {
      if (!dataset) {
        setUploadState({
          kind: "error",
          message: "Load a dataset first — staged files combine into the active dataset.",
        });
        return;
      }
      if (stagedDatasets.length >= MAX_STAGED_DATASETS) {
        setUploadState({
          kind: "error",
          message: "3 datasets loaded — combine or remove one first.",
        });
        return;
      }
      setUploadOp("stage");
      setUploadState({ kind: "loading", name: file.name });
      try {
        const { dataset: staged, malformedRows } = await parseFileToDataset(file);
        setStagedDatasets((prev) =>
          prev.length >= MAX_STAGED_DATASETS ? prev : [...prev, staged],
        );
        setCombineSteps((prev) => [...prev, suggestCombine(dataset, staged).step]);
        setCombineOpen(true);
        setUploadState({ kind: "idle" });
        setCombineModalOpen(false);
        if (malformedRows > 0) {
          setImportNotice({
            dataset: dataset.name,
            message: `${staged.name}: ${malformedRows.toLocaleString()} malformed row${
              malformedRows === 1 ? " was" : "s were"
            } padded / truncated to the header's column count.`,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error parsing file.";
        setUploadState({ kind: "error", message: msg });
      }
    },
    [dataset, stagedDatasets, parseFileToDataset, setStagedDatasets],
  );

  const updateCombineStep = useCallback((index: number, step: CombineStep) => {
    setCombineSteps((prev) => prev.map((s, i) => (i === index ? step : s)));
  }, []);

  const removeStagedDataset = useCallback(
    (index: number) => {
      setStagedDatasets((prev) => prev.filter((_, i) => i !== index));
      setCombineSteps((prev) => prev.filter((_, i) => i !== index));
    },
    [setStagedDatasets],
  );

  const cancelStaging = useCallback(() => {
    setStagedDatasets([]);
    setCombineSteps([]);
    setCombineOpen(false);
  }, [setStagedDatasets]);

  // Execute the staged combine plan. The result replaces the active dataset
  // and flows through the normal pipeline via setDataset — profiling,
  // cleaning analysis, and the picker's re-identify (name change) all fire
  // without extra wiring.
  const onCombineDatasets = useCallback(async () => {
    if (!dataset || stagedDatasets.length === 0) return;
    const others = stagedDatasets.map((ds, i) => ({
      dataset: ds,
      step: combineSteps[i] ?? combineSuggestions[i]?.step ?? { strategy: "append" as const },
    }));
    // combineAll is synchronous and blocks the main thread on big joins. Show
    // the overlay first: two rAFs guarantee the paint commits before the merge
    // starts, and a min-visible floor keeps it up long enough to read. Snapshot
    // the count now — the merge clears stagedDatasets before the floor elapses.
    setCombineBusy(others.length + 1);
    // nextPaint, not raw rAF — rAF never fires in hidden/occluded tabs and
    // would stall the merge until the tab is refocused.
    await nextPaint();
    const startedAt = performance.now();
    try {
      const result = combineAll(dataset, others, DEFAULT_IMPORT_ROW_CAP);
      commitDataset("combine datasets", result.dataset);
      setFilters([]);
      setStagedDatasets([]);
      setCombineSteps([]);
      setCombineOpen(false);
      const stepLines = result.stats.map((s, i) => describeCombineStat(s, others[i].dataset.name));
      const truncNote = result.truncated
        ? ` Result truncated to the first ${DEFAULT_IMPORT_ROW_CAP.toLocaleString()} of ${result.totalRows.toLocaleString()} rows (import row cap).`
        : "";
      setImportNotice({
        dataset: result.dataset.name,
        label: "combined",
        message: `${stepLines.join("; ")} — now ${result.dataset.rows.length.toLocaleString()} rows × ${result.dataset.columns.length} cols.${truncNote}`,
      });
      logEvent({
        stage: "soft",
        kind: "dataset.combine",
        payload: {
          name: result.dataset.name,
          steps: result.stats.map((s, i) => ({
            dataset: others[i].dataset.name,
            strategy: s.strategy,
            ...(s.key ? { key: s.key } : {}),
            matched: s.matched,
            unmatched: s.unmatched,
            duplicateRightKeys: s.duplicateRightKeys,
            outputRows: s.outputRows,
            outputColumns: s.outputColumns,
          })),
          rows: result.dataset.rows.length,
          cols: result.dataset.columns.length,
          truncated: result.truncated,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error combining datasets.";
      setUploadState({ kind: "error", message: `combine failed — ${msg}` });
    } finally {
      const remaining = 350 - (performance.now() - startedAt);
      if (remaining > 0) await new Promise<void>((r) => setTimeout(r, remaining));
      setCombineBusy(null);
    }
  }, [
    dataset,
    stagedDatasets,
    combineSteps,
    combineSuggestions,
    setFilters,
    setStagedDatasets,
    logEvent,
    commitDataset,
  ]);

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
          {dataset && (
            <button
              type="button"
              onClick={() => setCombineModalOpen(true)}
              disabled={
                uploadState.kind === "loading" || stagedDatasets.length >= MAX_STAGED_DATASETS
              }
              title={
                stagedDatasets.length >= MAX_STAGED_DATASETS
                  ? "3 datasets loaded — combine or remove one first"
                  : "Stage another CSV / Parquet file to combine with the active dataset (max 3 total)"
              }
              className="rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[11px] text-fg-mute hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              + combine data
              {stagedDatasets.length > 0 ? ` (${stagedDatasets.length + 1}/3)` : ""}
            </button>
          )}
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
            <button
              type="button"
              onClick={() => setWorkspacePreviewOpen(true)}
              title="preview which columns are decision-relevant vs merely high-variance (the workspace idea, at the data stage)"
              className="rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[11px] text-fg-mute hover:border-primary hover:text-primary"
            >
              ◈ workspace
            </button>
          )}
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
                pushHistory("clear dataset");
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
            accept=".csv,.tsv,text/csv,text/tab-separated-values,.parquet,application/parquet,application/x-parquet,application/octet-stream"
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

      {/* upload status — the inline strip only shows when a dataset is already
          on screen (the empty-state canvas below hosts the big card instead, so
          the two are mutually exclusive and never double up). */}
      {heldUpload && dataset && (
        <UploadIndicator layout="inline" state={heldUpload} accent="warn" />
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

      {/* import advisory — malformed rows padded / truncated, or a combine
          summary (label "combined") after staged datasets merged. */}
      {importNotice && dataset?.name === importNotice.dataset && (
        <div className="flex shrink-0 items-start gap-2 border-b border-warn/40 bg-warn/10 px-3 py-1.5 font-mono text-[10px] text-warn">
          <span className="shrink-0">{importNotice.label ?? "import notice"}</span>
          <span className="text-fg-dim">·</span>
          <span className="flex-1 break-words text-warn/90">{importNotice.message}</span>
          <button
            type="button"
            onClick={() => setImportNotice(null)}
            className="shrink-0 px-1 text-fg-dim hover:text-warn"
            aria-label="dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* sampling banner — the loaded rows are a subset of the source file
          (capped import or a truncated session-snapshot restore). Persistent
          per dataset until dismissed so the user can't mistake the sample
          for the full book. */}
      {dataset &&
        (dataset.sourceTotalRows ?? dataset.rows.length) > dataset.rows.length &&
        sampleNoticeDismissed !== dataset.name && (
          <div className="flex shrink-0 items-start gap-2 border-b border-accent-2/40 bg-accent-2/10 px-3 py-1.5 font-mono text-[10px] text-accent-2">
            <span className="shrink-0">sampled</span>
            <span className="text-fg-dim">·</span>
            <span className="flex-1 break-words">
              {dataset.sampleKind === "first"
                ? `Showing the first ${dataset.rows.length.toLocaleString()} rows of ${(
                    dataset.sourceTotalRows ?? 0
                  ).toLocaleString()} (parquet import keeps the leading rows, not a uniform sample) — re-import a trimmed file for full data.`
                : `Showing a ${dataset.rows.length.toLocaleString()}-row sample of ${(
                    dataset.sourceTotalRows ?? 0
                  ).toLocaleString()} rows (uniform sample at import / restored snapshot) — re-import the file for full data.`}
            </span>
            <button
              type="button"
              onClick={() => setSampleNoticeDismissed(dataset.name)}
              className="shrink-0 px-1 text-fg-dim hover:text-accent-2"
              aria-label="dismiss"
            >
              ×
            </button>
          </div>
        )}

      {/* combine review — staged offline imports waiting to merge into the
          active dataset. Hidden while a parse is in flight so the progress
          banner isn't crowded. */}
      {dataset && stagedDatasets.length > 0 && uploadState.kind !== "loading" && (
        <CombineBanner
          base={dataset}
          staged={stagedDatasets}
          suggestions={combineSuggestions}
          steps={combineSteps}
          open={combineOpen}
          onOpenChange={setCombineOpen}
          onUpdateStep={updateCombineStep}
          onRemove={removeStagedDataset}
          onCombine={onCombineDatasets}
          onCancel={cancelStaging}
        />
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
        <main className="relative min-w-0 flex-1 p-3">
          {dataset ? (
            // key on the dataset name so a fresh import / sample / combine
            // remounts and fades in (ia-materialize-in) — data always "arrives".
            <div key={dataset.name} className="ia-materialize-in h-full">
              <DataGrid
                dataset={dataset}
                rows={filteredRows}
                columnMetas={columnMetas}
                filters={filters}
                onFilter={toggleFilter}
                selectedColumn={selectedMeta?.name ?? null}
                onSelectColumn={setSelected}
                derivedColumnNames={derivedColumnNameSet}
                dateColumns={dateColumns}
                onReformatColumnDates={onReformatColumnDates}
                onColumnCommand={handleColumnChatCommand}
                onUndo={runUndo}
                undoLabel={undoLabel}
              />
            </div>
          ) : heldUpload ? (
            // no dataset yet + a parse in flight → the big reassuring card fills
            // the empty canvas (same flex-centered footprint as EmptyState, so
            // swapping one for the other is zero layout shift).
            <UploadIndicator layout="lg" state={heldUpload} accent="warn" />
          ) : (
            <EmptyState
              onLoadSample={() => setSamplePickerOpen(true)}
              onPickFile={() => setImportModalOpen(true)}
            />
          )}
          {combineBusy != null && (
            <UploadIndicator
              layout="overlay"
              accent="accent-2"
              state={{ verb: "combining", name: `${combineBusy} datasets` }}
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
          onLocalCommand={handleSoftChatCommand}
          actions={softChatActions}
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
        busy={heldUpload}
        error={uploadState.kind === "error" ? uploadState.message : null}
      />
      {/* same modal frame, routed to the staging handler — the picked file is
          parsed and queued for combining instead of replacing the dataset. */}
      <ImportFileModal
        open={combineModalOpen}
        onFile={onStageFileObject}
        onDismiss={() => setCombineModalOpen(false)}
        busy={heldUpload}
        error={uploadState.kind === "error" ? uploadState.message : null}
      />
      <SimulateScenarioModal
        open={simulateOpen}
        onClose={() => setSimulateOpen(false)}
        existingDataset={dataset}
        onDataset={(ds) => {
          clearEvents();
          clearHistory();
          setDataset(ds);
          setSelected(ds.columns[0]);
          setFilters([]);
        }}
      />
      {workspacePreviewOpen && dataset && (
        <WorkspacePreviewModal dataset={dataset} onClose={() => setWorkspacePreviewOpen(false)} />
      )}
    </div>
  );
}

// ── WorkspacePreviewModal · decision-relevant vs max-variance, at the data
// stage. Before any model, previews which columns a chosen readout actually
// turns on (gradient-sensitivity share) versus which merely carry the most
// input variance. The guardrail: dropping a low-variance column that is
// decision-relevant discards signal PCA would have thrown away too.

function WorkspacePreviewModal({
  dataset,
  onClose,
}: {
  dataset: Dataset;
  onClose: () => void;
}) {
  const { resolved } = useTheme();
  const numeric = useMemo(() => workspaceNumericColumns(dataset), [dataset]);
  const [target, setTarget] = useState<string>(() => numeric[numeric.length - 1] ?? "");
  const [scores, setScores] = useState<Record<string, { relevance: number; variance: number }>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setBusy(true);
    // Defer so the modal paints before the synchronous fit blocks the thread.
    const t = setTimeout(() => {
      try {
        const s = columnRelevance(dataset, target, { seed: 7 });
        if (!cancelled) setScores(s);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [dataset, target]);

  const rows = useMemo(
    () =>
      Object.entries(scores)
        .map(([col, s]) => ({ col, ...s }))
        .sort((a, b) => b.relevance - a.relevance),
    [scores],
  );
  // Low-variance but decision-relevant columns: exactly what a variance-based
  // reduction (PCA, "keep the big components") would wrongly discard.
  const atRisk = useMemo(
    () => rows.filter((r) => r.relevance > 0.08 && r.variance < 0.5 / Math.max(rows.length, 1)),
    [rows],
  );

  // Broadcast the dominant decision-relevant driver to the IDE-wide workspace
  // panel (a preview, so not yet causally validated).
  useEffect(() => {
    const top = rows[0];
    if (!top || top.relevance < 0.05 || !target) return;
    emitWorkspaceFact({
      id: `soft:relevance:${target}`,
      label: `${target} turns on ${top.col}`,
      surface: "soft",
      validated: false,
      detail: `decision-relevant drivers: ${rows
        .slice(0, 3)
        .map((r) => r.col)
        .join(", ")}`,
      createdAt: Date.now(),
    });
  }, [rows, target]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const light = resolved === "light";
  const accent = light ? "#3760cc" : "#7aa2f7";
  const warn = light ? "#ae6614" : "#ffb454";
  const ink = light ? "#6b6a67" : "#a8a29e";
  const grid = light ? "rgba(0,0,0,0.10)" : "rgba(255,255,255,0.12)";

  const option = useMemo(
    () => ({
      animation: false,
      grid: { left: 8, right: 12, top: 14, bottom: 30, containLabel: true },
      tooltip: {
        trigger: "item",
        formatter: (p: { data: { name: string; value: [number, number] } }) =>
          `${p.data.name}<br/>relevance ${(p.data.value[1] * 100).toFixed(0)}% · variance ${(p.data.value[0] * 100).toFixed(0)}%`,
      },
      xAxis: {
        type: "value",
        name: "input-variance share",
        nameLocation: "middle",
        nameGap: 20,
        nameTextStyle: { color: ink, fontSize: 10 },
        axisLabel: {
          color: ink,
          fontSize: 9,
          formatter: (v: number) => `${(v * 100).toFixed(0)}%`,
        },
        axisLine: { lineStyle: { color: grid } },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        name: "decision relevance",
        nameGap: 8,
        nameTextStyle: { color: ink, fontSize: 10 },
        axisLabel: {
          color: ink,
          fontSize: 9,
          formatter: (v: number) => `${(v * 100).toFixed(0)}%`,
        },
        axisLine: { lineStyle: { color: grid } },
        splitLine: { lineStyle: { color: grid } },
      },
      series: [
        {
          type: "scatter",
          symbolSize: 9,
          data: rows.map((r) => ({
            name: r.col,
            value: [r.variance, r.relevance],
            itemStyle: { color: r.relevance >= r.variance ? accent : warn, opacity: 0.85 },
          })),
          label: {
            show: true,
            position: "right",
            fontSize: 8,
            color: ink,
            formatter: (p: { data: { name: string } }) => p.data.name,
          },
        },
      ],
    }),
    [rows, accent, warn, ink, grid],
  );

  return (
    <ChatModalBackdrop onDismiss={onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation only; Escape is handled at the document level above. */}
      <div
        className="flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-wider text-fg-dim">
              workspace preview · decision-relevant vs max-variance
            </div>
            <p className="mt-0.5 text-[11px] text-fg-mute">
              Which columns a readout actually turns on, versus which merely carry the most
              variance.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border px-2 py-0.5 font-mono text-[11px] text-fg-mute hover:border-primary hover:text-primary"
          >
            esc
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-fg-dim">
              readout
            </span>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[11px] text-fg"
            >
              {numeric.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            {busy && <span className="text-[10px] italic text-fg-dim">scoring…</span>}
          </div>
          <div style={{ height: 260 }}>
            {rows.length > 0 && (
              <ReactECharts
                echarts={echarts}
                option={option}
                notMerge
                lazyUpdate
                style={{ height: "100%", width: "100%" }}
              />
            )}
          </div>
          <div className="mt-3 flex flex-col gap-2 text-[11px]">
            <div>
              <span
                className="font-mono text-[9px] uppercase tracking-wider"
                style={{ color: accent }}
              >
                decision-relevant
              </span>{" "}
              <span className="text-fg-mute">
                {rows
                  .filter((r) => r.relevance >= r.variance && r.relevance > 0.05)
                  .slice(0, 6)
                  .map((r) => r.col)
                  .join(", ") || "none stand out"}
              </span>
            </div>
            {atRisk.length > 0 && (
              <div className="rounded border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-fg-mute">
                <span className="font-medium text-warn">Guardrail:</span>{" "}
                {atRisk.map((r) => r.col).join(", ")} {atRisk.length === 1 ? "carries" : "carry"}{" "}
                little variance but drive the readout. A variance-based reduction (PCA, "keep the
                big components") would discard {atRisk.length === 1 ? "it" : "them"}.
              </div>
            )}
          </div>
        </div>
      </div>
    </ChatModalBackdrop>
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

// ── multi-dataset combine UI ─────────────────────────────────────────────────

type CombineKeyOption = { baseColumn: string; otherColumn: string; label: string };

// Join-key options for one staged dataset: the detector's ranked candidates
// first (with their match evidence), then every remaining case-insensitively
// shared column as a manual override.
function combineKeyOptions(
  base: Dataset,
  other: Dataset,
  suggestion: CombineSuggestion,
): CombineKeyOption[] {
  const out: CombineKeyOption[] = suggestion.keyCandidates.map((k) => ({
    baseColumn: k.baseColumn,
    otherColumn: k.otherColumn,
    label: `${k.baseColumn} ↔ ${k.otherColumn} · ${Math.round(k.overlap * 100)}% match`,
  }));
  const seen = new Set(out.map((o) => o.baseColumn.trim().toLowerCase()));
  const otherByNorm = new Map(other.columns.map((c) => [c.trim().toLowerCase(), c]));
  for (const c of base.columns) {
    const norm = c.trim().toLowerCase();
    if (seen.has(norm)) continue;
    const hit = otherByNorm.get(norm);
    if (!hit) continue;
    seen.add(norm);
    out.push({ baseColumn: c, otherColumn: hit, label: `${c} ↔ ${hit} · manual` });
  }
  return out;
}

// Confidence buckets for the suggestion chip — mirrors the spec's 0.7 / 0.4
// thresholds.
function combineConfidence(c: number): { label: string; cls: string } {
  if (c >= 0.7) return { label: "high", cls: "text-primary" };
  if (c >= 0.4) return { label: "medium", cls: "text-warn" };
  return { label: "low", cls: "text-error" };
}

// One human line per executed combine step, for the post-combine notice.
function describeCombineStat(s: CombineStats, otherName: string): string {
  const n = (count: number, word: string) =>
    `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
  if (s.strategy === "append") {
    const dropped = s.unmatched > 0 ? ` (${n(s.unmatched, "exact duplicate")} dropped)` : "";
    return `appended ${otherName} — ${n(s.matched, "row")} added${dropped}`;
  }
  const baseTotal = s.matched + s.unmatched;
  const notes: string[] = [];
  if (s.unmatched > 0) {
    notes.push(
      s.strategy === "join-left"
        ? `${n(s.unmatched, "row")} without a match kept with nulls`
        : `${n(s.unmatched, "unmatched row")} dropped`,
    );
  }
  if (s.duplicateRightKeys > 0) {
    notes.push(`${n(s.duplicateRightKeys, "duplicate key")} on the right side (first match wins)`);
  }
  if (s.renamedColumns.length > 0) {
    notes.push(`${n(s.renamedColumns.length, "colliding column")} renamed with _2`);
  }
  const noteStr = notes.length > 0 ? ` (${notes.join("; ")})` : "";
  const verb = s.strategy === "join-left" ? "left-joined" : "inner-joined";
  return `${verb} ${otherName} on ${s.key ?? "key"} — ${s.matched.toLocaleString()} of ${baseTotal.toLocaleString()} rows matched${noteStr}`;
}

// Combine review — shown while offline imports are staged next to the active
// dataset. Pattern-matches CleaningBanner: a one-line collapsed strip plus an
// expanded panel listing each staged dataset with the engine's suggested
// strategy (suggestCombine) and its evidence, overridable per step (strategy /
// join key / exact-duplicate drop). Execution goes through combineAll in the
// parent so the result replaces the active dataset.
function CombineBanner({
  base,
  staged,
  suggestions,
  steps,
  open,
  onOpenChange,
  onUpdateStep,
  onRemove,
  onCombine,
  onCancel,
}: {
  base: Dataset;
  staged: Dataset[];
  suggestions: CombineSuggestion[];
  steps: CombineStep[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdateStep: (index: number, step: CombineStep) => void;
  onRemove: (index: number) => void;
  onCombine: () => void;
  onCancel: () => void;
}) {
  // Key options per staged dataset — cheap to recompute at the engine's
  // 5k-row sample sizes.
  const keyOptions = useMemo(
    () =>
      staged.map((ds, i) => (suggestions[i] ? combineKeyOptions(base, ds, suggestions[i]) : [])),
    [base, staged, suggestions],
  );

  // Exact combine previews driving the per-file diagram. Unlike the sampled
  // suggestion heuristics these walk the full datasets, so the bar counts
  // equal what the combine will actually do. Steps run in order, so each
  // preview runs against the MATERIALISED result of the previous step —
  // previewing file 2 against the original dataset would report the wrong
  // result size (and wrong duplicate counts) whenever file 1 changes the
  // data. Bounded work: at most two staged files → one intermediate build.
  const previews = useMemo(() => {
    let current = base;
    let currentLabel = "current data";
    return staged.map((ds, i) => {
      const step = steps[i] ?? suggestions[i]?.step ?? { strategy: "append" as const };
      let preview: CombinePreview | null = null;
      try {
        preview = previewCombine(current, ds, step);
      } catch {
        preview = null; // join selected while the key is still unset
      }
      const entry = preview ? { preview, baseLabel: currentLabel } : null;
      if (i < staged.length - 1) {
        try {
          current = combinePair(current, ds, step).dataset;
          currentLabel = `result of step ${i + 1}`;
        } catch {
          /* keep previous base; the next preview will show against it */
        }
      }
      return entry;
    });
  }, [base, staged, steps, suggestions]);

  // A join step with no usable key can't run — disable combine and say why.
  const joinWithoutKey = steps.some(
    (s, i) => s.strategy !== "append" && ((keyOptions[i]?.length ?? 0) === 0 || !s.key),
  );

  const selectCls =
    "rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] normal-case tracking-normal text-fg focus:border-primary focus:outline-none";

  return (
    <div className="flex shrink-0 flex-col border-b border-accent-2/40 bg-accent-2/5">
      {/* collapsed strip — always visible while something is staged */}
      <div className="flex items-center gap-2 px-3 py-1.5 font-mono text-[11px] text-fg">
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full bg-accent-2"
          title="combine datasets"
        />
        <span className="text-accent-2">combine data</span>
        <span className="text-fg-dim">·</span>
        <span className="min-w-0 truncate text-fg-mute">
          {staged.length} dataset{staged.length === 1 ? "" : "s"} staged to combine with {base.name}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => onOpenChange(!open)}
          className="rounded border border-accent-2/40 bg-accent-2/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-accent-2 hover:border-accent-2"
        >
          {open ? "hide" : "review"}
          <span aria-hidden className="ml-1">
            {open ? "▴" : "▾"}
          </span>
        </button>
        <button
          type="button"
          onClick={onCancel}
          title="clear staged datasets without combining"
          aria-label="clear staged datasets"
          className="rounded border border-transparent px-1 text-fg-dim hover:border-border hover:text-fg-mute"
        >
          ×
        </button>
      </div>

      {/* expanded panel — per-staged suggestion + overrides + combine button */}
      {open && (
        <div className="border-t border-accent-2/30 px-3 pb-2.5 pt-2">
          <p className="mb-2 max-w-3xl font-mono text-[10px] text-fg-mute">
            Each staged file gets a suggested strategy from its schema + key evidence — review or
            override below, then click <span className="text-accent-2">combine datasets</span>.
            Joins never multiply rows (first right-side match wins); appends align columns
            case-insensitively and union the rest.
          </p>
          <ul className="flex flex-col gap-1">
            {staged.map((ds, i) => {
              const suggestion = suggestions[i];
              const step = steps[i] ?? suggestion?.step ?? { strategy: "append" as const };
              const options = keyOptions[i] ?? [];
              const conf = combineConfidence(suggestion?.confidence ?? 0);
              const isJoin = step.strategy !== "append";
              const keyIdxRaw = options.findIndex(
                (o) =>
                  o.baseColumn === step.key &&
                  (step.rightKey === undefined || o.otherColumn === step.rightKey),
              );
              const keyIdx = keyIdxRaw >= 0 ? keyIdxRaw : 0;
              return (
                <li
                  key={`${ds.name}-${i}`}
                  className="rounded border border-border bg-bg px-2 py-1.5"
                >
                  <div className="flex items-baseline gap-1.5">
                    <span className="truncate font-mono text-[11px] text-fg">{ds.name}</span>
                    <span className="shrink-0 font-mono text-[9px] text-fg-dim">
                      {ds.rows.length.toLocaleString()} rows × {ds.columns.length} cols
                    </span>
                    <span
                      className={`shrink-0 font-mono text-[9px] uppercase tracking-wider ${conf.cls}`}
                      title={`suggestion confidence ${Math.round((suggestion?.confidence ?? 0) * 100)}%`}
                    >
                      {conf.label} confidence
                    </span>
                    <div className="flex-1" />
                    <button
                      type="button"
                      onClick={() => onRemove(i)}
                      title="remove this staged dataset"
                      aria-label={`remove ${ds.name}`}
                      className="shrink-0 font-mono text-[10px] text-fg-dim hover:text-error"
                    >
                      ✕
                    </button>
                  </div>
                  {suggestion && (
                    <div className="mt-0.5 font-mono text-[10px] leading-snug text-fg-mute">
                      {suggestion.rationale}
                    </div>
                  )}
                  {previews[i] && (
                    <CombineDiagram
                      preview={previews[i].preview}
                      baseName={
                        previews[i].baseLabel === "current data" ? base.name : previews[i].baseLabel
                      }
                      otherName={ds.name}
                    />
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
                    <label className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-fg-dim">
                      strategy
                      <select
                        value={step.strategy}
                        onChange={(e) => {
                          const strategy = e.target.value as CombineStrategy;
                          if (strategy === "append") {
                            onUpdateStep(i, {
                              strategy: "append",
                              dedupeExact:
                                step.dedupeExact ?? suggestion?.step.dedupeExact ?? false,
                            });
                            return;
                          }
                          const opt = options.find((o) => o.baseColumn === step.key) ?? options[0];
                          onUpdateStep(
                            i,
                            opt
                              ? { strategy, key: opt.baseColumn, rightKey: opt.otherColumn }
                              : { strategy },
                          );
                        }}
                        className={selectCls}
                      >
                        <option value="append">append rows</option>
                        <option value="join-left" disabled={options.length === 0}>
                          left join
                        </option>
                        <option value="join-inner" disabled={options.length === 0}>
                          inner join
                        </option>
                      </select>
                    </label>
                    {isJoin && options.length > 0 && (
                      <label className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-fg-dim">
                        key
                        <select
                          value={String(keyIdx)}
                          onChange={(e) => {
                            const opt = options[Number(e.target.value)];
                            if (opt) {
                              onUpdateStep(i, {
                                ...step,
                                key: opt.baseColumn,
                                rightKey: opt.otherColumn,
                              });
                            }
                          }}
                          className={selectCls}
                        >
                          {options.map((o, oi) => (
                            <option key={`${o.baseColumn}→${o.otherColumn}`} value={String(oi)}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {isJoin && options.length === 0 && (
                      <span className="font-mono text-[10px] text-error">
                        no shared columns to join on — use append
                      </span>
                    )}
                    {!isJoin && (
                      <label className="flex cursor-pointer items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-fg-dim">
                        <input
                          type="checkbox"
                          checked={step.dedupeExact ?? false}
                          onChange={(e) =>
                            onUpdateStep(i, { ...step, dedupeExact: e.target.checked })
                          }
                          className="h-3 w-3 accent-primary"
                        />
                        drop exact duplicates
                      </label>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {staged.length > 1 && (
            <p className="mt-1.5 font-mono text-[9px] leading-snug text-fg-dim">
              steps run in order — the second staged file combines into the result of the first
            </p>
          )}
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={onCombine}
              disabled={joinWithoutKey}
              title={
                joinWithoutKey
                  ? "a join step has no usable key — switch it to append or pick a key"
                  : undefined
              }
              className="rounded border border-primary/60 bg-primary/10 px-2 py-1 font-mono text-[11px] text-primary hover:border-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:border-border disabled:bg-bg-2 disabled:text-fg-dim"
            >
              combine datasets
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[11px] text-fg-mute hover:border-fg-dim"
            >
              cancel
            </button>
            <div className="flex-1" />
            <span className="font-mono text-[10px] text-fg-dim">
              {staged.length + 1} of 3 datasets loaded
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
/** Pointer travel (px, Manhattan) before a header press counts as a drag
 *  rather than a click. */
const DRAG_THRESHOLD = 4;

function ColumnChatPopover({
  meta,
  anchor,
  pinned,
  onEnter,
  onLeave,
  onClose,
  onPin,
  onLocalCommand,
  onUndo,
  undoLabel,
}: {
  meta: ColumnMeta;
  anchor: DOMRect;
  /** True while the chat is click-locked to its column (clicking IN a
   *  column is the only pin gesture; clicking another column moves it). */
  pinned: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
  /** Pin the chat to its current column. Called when the user starts
   *  dragging: a panel they positioned by hand must not evaporate on the
   *  next hover-out. */
  onPin?: () => void;
  /** Deterministic per-column intent (e.g. "make this american") handled
   *  client-side. Returns a reply to answer locally, or null to fall through
   *  to the provider. */
  onLocalCommand?: (text: string) => string | null;
  /** Reverse the last dataset change; returns the reply for the transcript.
   *  Dataset history is global, not per-column — a column chat can undo an
   *  edit made from the stage chat and vice versa, which is what users
   *  expect from "undo". */
  onUndo?: () => string;
  undoLabel?: string | null;
}) {
  const { chatMemoryPrefix, project } = useScelo();
  const memoryKey = chatMemoryPrefix ? `${chatMemoryPrefix}:soft-col:${meta.name}` : undefined;
  const stageContext = useMemo(() => buildColumnStageContext(meta), [meta]);
  const placeholder = useMemo(() => placeholderHintFor(meta), [meta]);
  const { messages, isStreaming, send, sendLocal, stop } = useNodeChat(stageContext, {
    memoryKey,
    logLabel: `soft · column «${meta.name}»`,
    logProject: project?.name,
  });
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
    // Deterministic per-column intents (e.g. "make this american") answer
    // locally and never hit the provider.
    const localReply = onLocalCommand?.(text);
    if (localReply != null) {
      sendLocal(text, localReply);
      return;
    }
    void send(text);
  };

  // ── Placement ──────────────────────────────────────────────────────────
  //
  // Two modes. By default the popover is ANCHORED under its `<th>`; once the
  // user drags it, `pos` takes over and it stays exactly where they put it.
  //
  // The anchored path measures its own height (`panelH`) rather than
  // assuming one. The previous version reserved a flat 220px when deciding
  // whether to open downwards but then allowed the panel to grow to 60vh, so
  // any column header sitting more than ~220px above the fold opened a
  // popover that ran off the bottom of the window — and because the compose
  // box is the LAST child in the flex column, the input was the first thing
  // to disappear. Clamping against the real height is what fixes that.
  const POPOVER_W = 340;
  const GAP = 8;
  const viewportRight = typeof window !== "undefined" ? window.innerWidth : 1200;
  const viewportBottom = typeof window !== "undefined" ? window.innerHeight : 800;
  const POPOVER_MAX_H = Math.min(Math.round(viewportBottom * 0.6), viewportBottom - GAP * 2);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelH, setPanelH] = useState(0);
  /** Explicit top-left once dragged; null = follow the column anchor. */
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  /** Pointer is down on the header — may or may not become a drag. */
  const [armed, setArmed] = useState(false);
  /** The threshold has been crossed; this is a real drag. */
  const [dragging, setDragging] = useState(false);
  const movedRef = useRef(false);
  const pressRef = useRef<{ sx: number; sy: number; dx: number; dy: number } | null>(null);

  // Track the rendered height so the clamp below uses the truth, not a
  // guess. The panel grows as replies stream in, so this has to be live.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    setPanelH(el.offsetHeight);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setPanelH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const clampToViewport = useCallback(
    (x: number, y: number) => {
      // `||` not `??`: an unmeasured panel reports 0, which is not nullish
      // but is equally useless as a bound.
      const w = panelRef.current?.offsetWidth || POPOVER_W;
      const h = panelRef.current?.offsetHeight || panelH || 240;
      return {
        x: Math.min(Math.max(GAP, x), Math.max(GAP, window.innerWidth - w - GAP)),
        y: Math.min(Math.max(GAP, y), Math.max(GAP, window.innerHeight - h - GAP)),
      };
    },
    [panelH],
  );

  // Drag from the header. Pointer events (not mouse) so pen/touch work, and
  // listeners go on `window` so a fast drag that outruns the cursor doesn't
  // drop the gesture.
  //
  // A press only becomes a drag after the pointer travels DRAG_THRESHOLD px.
  // Without that, a stray click on the header would silently switch the
  // panel to manual positioning and pin it — surprising, and it would
  // surface the "reset" control for a gesture the user didn't make.
  useEffect(() => {
    if (!armed) return;
    const onMove = (e: PointerEvent) => {
      const start = pressRef.current;
      if (!start) return;
      if (!movedRef.current) {
        const travelled = Math.abs(e.clientX - start.sx) + Math.abs(e.clientY - start.sy);
        if (travelled < DRAG_THRESHOLD) return;
        movedRef.current = true;
        setDragging(true);
        // Moving it away from its column means the pointer leaves that
        // column, which would otherwise schedule a hover-close mid-drag.
        // Pin instead: a deliberately-placed panel should stay put.
        onEnter();
        onPin?.();
      }
      e.preventDefault();
      setPos(clampToViewport(e.clientX - start.dx, e.clientY - start.dy));
    };
    const onUp = () => {
      setArmed(false);
      setDragging(false);
      movedRef.current = false;
      pressRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [armed, clampToViewport, onEnter, onPin]);

  // A resize (or the IDE window being un-maximised) must not strand a
  // dragged popover off-screen.
  useEffect(() => {
    if (!pos) return;
    const onResize = () => setPos((p) => (p ? clampToViewport(p.x, p.y) : p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [pos, clampToViewport]);

  const startDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Offset is measured from the panel's CURRENT on-screen box, so the
    // switch from anchored to manual positioning never makes it jump.
    pressRef.current = {
      sx: e.clientX,
      sy: e.clientY,
      dx: e.clientX - r.left,
      dy: e.clientY - r.top,
    };
    movedRef.current = false;
    setArmed(true);
  };

  const anchoredHeight = panelH || 240;
  const spaceBelow = viewportBottom - anchor.bottom - GAP * 2;
  const spaceAbove = anchor.top - GAP * 2;
  const flowsDown = spaceBelow >= anchoredHeight || spaceBelow >= spaceAbove;
  const anchoredTop = flowsDown ? anchor.bottom + GAP : anchor.top - GAP - anchoredHeight;
  const style: React.CSSProperties = pos
    ? {
        position: "fixed",
        left: pos.x,
        top: pos.y,
        width: POPOVER_W,
        maxHeight: POPOVER_MAX_H,
        zIndex: 60,
      }
    : {
        position: "fixed",
        left: Math.max(GAP, Math.min(anchor.left, viewportRight - POPOVER_W - GAP)),
        // Final guard: whichever direction we chose, never let the panel
        // cross the bottom (or top) edge of the window.
        top: Math.min(
          Math.max(GAP, anchoredTop),
          Math.max(GAP, viewportBottom - anchoredHeight - GAP),
        ),
        width: POPOVER_W,
        maxHeight: POPOVER_MAX_H,
        zIndex: 60,
      };

  return (
    <div
      ref={panelRef}
      style={style}
      onMouseEnter={onEnter}
      onMouseLeave={dragging ? undefined : onLeave}
      className={`flex flex-col overflow-hidden rounded-lg border bg-bg-1 shadow-2xl ${
        pinned ? "border-primary/60" : "border-border"
      } ${dragging ? "select-none" : ""}`}
    >
      {/* Header doubles as the drag handle. */}
      <header
        onPointerDown={startDrag}
        className={`flex shrink-0 items-center justify-between gap-2 border-b border-border bg-bg-1 px-3 py-1.5 ${
          dragging ? "cursor-grabbing" : "cursor-grab"
        }`}
      >
        <div className="flex min-w-0 items-center gap-2">
          {/* Grip affordance — the only cue that the panel can be moved. */}
          <span
            aria-hidden
            title="drag to move"
            className="shrink-0 font-mono text-[10px] leading-none text-fg-dim"
          >
            ⠿
          </span>
          <TypeChip type={meta.type} />
          <span className="truncate font-mono text-xs text-fg">{meta.name}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onUndo && undoLabel && (
            <button
              type="button"
              // Pointer-down would start a drag on the header underneath.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => sendLocal("Undo the last change.", onUndo())}
              title={`Undo "${undoLabel}"`}
              className="font-mono text-[9px] uppercase tracking-wider text-warn hover:text-fg"
            >
              ↶ undo
            </button>
          )}
          {pos && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setPos(null)}
              title="snap back under the column header"
              className="font-mono text-[9px] uppercase tracking-wider text-fg-dim hover:text-fg"
            >
              reset
            </button>
          )}
          <span
            className={`font-mono text-[9px] uppercase tracking-wider ${
              pinned ? "text-primary" : "text-fg-dim"
            }`}
            title={
              pinned
                ? "pinned — stays open until ✕, Esc, or re-clicking this column's header; clicking another column moves it there"
                : "click anywhere in the column to pin"
            }
          >
            {pinned ? "pinned" : "hover"}
          </span>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onClose}
            aria-label="close"
            className="font-mono text-[10px] text-fg-dim hover:text-error"
          >
            ✕
          </button>
        </div>
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
