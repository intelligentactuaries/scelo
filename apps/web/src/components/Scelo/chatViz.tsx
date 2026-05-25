// Chat-embedded visualisations.
//
// Scelo can answer "plot X" / "show me a table of Y" by emitting a fenced
// `viz` block in its markdown reply:
//
//   ```viz
//   { "type": "chart", "kind": "bar", "x": "state", "agg": "count",
//     "title": "Policies by province" }
//   ```
//
// The renderer below parses that JSON, computes the aggregation against the
// loaded dataset *client-side* (so the chart reflects real values rather
// than the LLM's guesses), and renders either an ECharts plot or a compact
// stat table. Malformed specs / unknown columns surface as inline errors
// instead of crashing the chat.

import { useTheme } from "@/lib/theme";
import ReactECharts from "echarts-for-react";
import {
  BarChart,
  HeatmapChart,
  LineChart,
  MapChart,
  PieChart,
  ScatterChart,
} from "echarts/charts";
import {
  GeoComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { memo, useMemo } from "react";
import { type CellValue, type Dataset, type Row, formatNumber } from "./SoftDataWorkstation";
// Importing `geoRegistry` for its side effect of registering "world" and "ZA"
// maps with ECharts. The named exports give the renderer the lookup
// utilities it needs to auto-pick the right map from the user's data.
import { detectMap, featureNamesFor, shortLabel, viewportFor } from "./geoRegistry";

echarts.use([
  TooltipComponent,
  GridComponent,
  LegendComponent,
  VisualMapComponent,
  GeoComponent,
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  HeatmapChart,
  MapChart,
  CanvasRenderer,
]);

type AggFn = "count" | "sum" | "mean" | "median" | "min" | "max" | "first";

export type ChartSpec = {
  type: "chart";
  kind: "bar" | "line" | "pie" | "scatter" | "heatmap" | "corr" | "map";
  // bar / line / pie / scatter / heatmap → category or numeric column for x
  x?: string;
  // heatmap requires `y` (second categorical). scatter requires `y` (numeric).
  // bar / line / pie use `y` as the value column when aggregating (e.g. sum).
  y?: string | null;
  // corr requires `columns` — pairwise Pearson correlation between them.
  columns?: string[];
  // For heatmaps, optional column whose `agg` value fills each cell. When
  // omitted, the heatmap value is the count of rows in the (x, y) bucket.
  valueCol?: string | null;
  agg?: AggFn;
  title?: string;
  limit?: number;
};

export type TableSpec = {
  type: "table";
  groupBy?: string | null;
  columns?: Array<{ col: string; agg?: AggFn; label?: string }>;
  title?: string;
  limit?: number;
};

export type VizSpec = ChartSpec | TableSpec;

// ── parsing ────────────────────────────────────────────────────────────────

// Aliases the LLM commonly produces — normalised before validation so the
// strict checks below only have to deal with the canonical kind names.
const KIND_ALIASES: Record<string, ChartSpec["kind"]> = {
  matrix: "corr",
  correlation: "corr",
  correlations: "corr",
  corrmatrix: "corr",
  "correlation-matrix": "corr",
  scatterplot: "scatter",
  scatter_plot: "scatter",
  crosstab: "heatmap",
  contingency: "heatmap",
  histogram: "bar",
  hist: "bar",
  // Geographic — many phrasings, one renderer.
  geo: "map",
  geomap: "map",
  "geo-map": "map",
  geographic: "map",
  choropleth: "map",
  "geo-bubbles": "map",
  province: "map",
  provinces: "map",
};

function safeParseSpec(raw: string): VizSpec | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Invalid JSON" };
  }
  if (!parsed || typeof parsed !== "object") return { error: "Expected an object" };
  const obj: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };

  // ── tolerant inference ──────────────────────────────────────────────
  // The LLM often skips `type` or misspells `kind`. Rather than rejecting,
  // we look at the spec's shape and pick the most likely interpretation.

  // Normalise kind alias even before checking type.
  if (typeof obj.kind === "string" && KIND_ALIASES[obj.kind.toLowerCase()]) {
    obj.kind = KIND_ALIASES[obj.kind.toLowerCase()];
  }

  if (obj.type !== "chart" && obj.type !== "table") {
    if (typeof obj.kind === "string") {
      // Has a chart `kind` → must be a chart.
      obj.type = "chart";
    } else if (Array.isArray(obj.columns) && obj.columns.length > 0) {
      const first = obj.columns[0];
      if (typeof first === "string") {
        // ["paid", "age", ...] → looks like a corr-matrix column list
        obj.type = "chart";
        obj.kind = "corr";
      } else if (first && typeof first === "object" && "col" in (first as object)) {
        // [{col: ..., agg: ...}] → table
        obj.type = "table";
      }
    } else if ("groupBy" in obj) {
      obj.type = "table";
    } else if (typeof obj.x === "string" && typeof obj.y === "string") {
      // Two columns named without explicit kind → most likely a scatter
      // (the user usually wants to SEE the relationship).
      obj.type = "chart";
      obj.kind = "scatter";
    } else if (typeof obj.x === "string") {
      obj.type = "chart";
      obj.kind = "bar";
    }
  }

  if (obj.type === "chart") {
    // Fill in a sensible default kind when still missing.
    if (typeof obj.kind !== "string") {
      if (Array.isArray(obj.columns) && typeof obj.columns[0] === "string") {
        obj.kind = "corr";
      } else if (typeof obj.x === "string" && typeof obj.y === "string") {
        obj.kind = "scatter";
      } else if (typeof obj.x === "string") {
        obj.kind = "bar";
      }
    }
    const kind = obj.kind;
    const valid = ["bar", "line", "pie", "scatter", "heatmap", "corr", "map"];
    if (typeof kind !== "string" || !valid.includes(kind)) {
      return { error: `chart \`kind\` must be ${valid.join(" | ")}` };
    }
    if (kind === "corr") {
      if (!Array.isArray(obj.columns) || obj.columns.length < 2) {
        return { error: "corr requires `columns` (≥2 numeric column names)" };
      }
    } else if (kind === "heatmap") {
      if (typeof obj.x !== "string" || typeof obj.y !== "string") {
        return { error: "heatmap requires both `x` and `y` column names" };
      }
    } else if (kind === "map") {
      // `x` is the geographic column (e.g. province codes). `y` is optional
      // — when present it's the numeric column we aggregate per region.
      if (typeof obj.x !== "string") {
        return { error: "map requires `x` (the geographic / province column)" };
      }
    } else if (typeof obj.x !== "string") {
      return { error: `chart kind \`${kind}\` requires \`x\` column name` };
    }
    return obj as unknown as ChartSpec;
  }
  if (obj.type === "table") {
    return obj as unknown as TableSpec;
  }
  return { error: "could not figure out spec — needs `type` or a recognisable shape" };
}

// ── aggregation ────────────────────────────────────────────────────────────

function asNumber(v: CellValue): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function aggregate(values: CellValue[], fn: AggFn): CellValue {
  if (fn === "count") return values.filter((v) => v !== null && v !== "").length;
  if (fn === "first") return values.find((v) => v !== null && v !== "") ?? null;
  const nums = values.map(asNumber).filter((v): v is number => v !== null);
  if (nums.length === 0) return null;
  if (fn === "sum") return nums.reduce((a, b) => a + b, 0);
  if (fn === "mean") return nums.reduce((a, b) => a + b, 0) / nums.length;
  if (fn === "min") {
    let mn = nums[0];
    for (const x of nums) if (x < mn) mn = x;
    return mn;
  }
  if (fn === "max") {
    let mx = nums[0];
    for (const x of nums) if (x > mx) mx = x;
    return mx;
  }
  if (fn === "median") {
    const s = [...nums].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }
  return null;
}

function groupByColumn(rows: Row[], key: string): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const v = r[key];
    if (v === null || v === "") continue;
    const k = typeof v === "number" ? String(v) : v;
    const arr = groups.get(k) ?? [];
    arr.push(r);
    groups.set(k, arr);
  }
  return groups;
}

// ── chart renderer ─────────────────────────────────────────────────────────

// ── label-contrast helpers ─────────────────────────────────────────────────
// Heatmap-style cells render against varying background colours; a fixed
// label colour either disappears on saturated cells or fights with the grid
// on neutral ones. We compute each cell's interpolated colour and pick the
// label tone via WCAG relative luminance: bright background → near-black,
// dark background → white. Result is "the text is always readable, no
// matter where the value lands on the colour ramp".

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  let s = hex.startsWith("#") ? hex.slice(1) : hex;
  // Strip an alpha suffix if present — luminance is computed from RGB only.
  if (s.length === 8) s = s.slice(0, 6);
  if (s.length === 3)
    s = s
      .split("")
      .map((c) => c + c)
      .join("");
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return {
    r: Number.parseInt(s.slice(0, 2), 16),
    g: Number.parseInt(s.slice(2, 4), 16),
    b: Number.parseInt(s.slice(4, 6), 16),
  };
}

function lerpHex(a: string, b: string, t: number): string {
  const A = parseHex(a) ?? { r: 0, g: 0, b: 0 };
  const B = parseHex(b) ?? { r: 0, g: 0, b: 0 };
  const r = Math.round(A.r + (B.r - A.r) * t);
  const g = Math.round(A.g + (B.g - A.g) * t);
  const bl = Math.round(A.b + (B.b - A.b) * t);
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(bl)}`;
}

// Three-stop interpolation, hard-coded mid-stop at t = 0.5. Used for the
// diverging corr palette: red → grey → primary.
function lerpHex3(a: string, b: string, c: string, t: number): string {
  if (t < 0.5) return lerpHex(a, b, t * 2);
  return lerpHex(b, c, (t - 0.5) * 2);
}

// Returns "#ffffff" or "#0f0f0f" based on WCAG relative luminance of `hex`.
// Threshold of 0.55 (slightly above 0.5) biases towards white text — at
// the mid-grey crossover, white-on-grey reads marginally better than black.
function contrastText(hex: string): string {
  const rgb = parseHex(hex);
  if (!rgb) return "#ffffff";
  const toLin = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * toLin(rgb.r) + 0.7152 * toLin(rgb.g) + 0.0722 * toLin(rgb.b);
  return L > 0.55 ? "#0f0f0f" : "#ffffff";
}

// Pearson correlation. Returns null when undefined (constant column, n<2).
function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  if (denom === 0) return null;
  return num / denom;
}

function chartOption(
  spec: ChartSpec,
  dataset: Dataset,
  palette: { primary: string; grid: string; textDim: string; textMute: string; cats: string[] },
): { option: object | null; error?: string } {
  // ── corr ──────────────────────────────────────────────────────────────
  // Numeric Pearson correlation matrix between the listed columns. Renders
  // as a heatmap with a diverging −1 → 0 → +1 colour scale. This is the
  // right pick when the user asks for a "correlation matrix" of numeric
  // columns (e.g. paid vs incurred vs age).
  if (spec.kind === "corr") {
    const cols = spec.columns ?? [];
    for (const c of cols) {
      if (!dataset.columns.includes(c)) {
        return { option: null, error: `column "${c}" not found` };
      }
    }
    const n = cols.length;
    // Heatmap data: [xIdx, yIdx, value], with value ∈ [-1, 1] or NaN→null.
    const cells: Array<[number, number, number | null]> = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) {
          cells.push([i, j, 1]);
          continue;
        }
        const xs: number[] = [];
        const ys: number[] = [];
        for (const r of dataset.rows) {
          const xv = asNumber(r[cols[i]]);
          const yv = asNumber(r[cols[j]]);
          if (xv !== null && yv !== null) {
            xs.push(xv);
            ys.push(yv);
          }
        }
        cells.push([i, j, pearson(xs, ys)]);
      }
    }
    // Same palette anchors used in the visualMap below — kept as constants so
    // the per-cell label-contrast pass interpolates against EXACTLY the same
    // colour ramp ECharts uses to fill cells. Drift between the two would
    // give "looked fine to the eye but luminance check said otherwise".
    const corrLow = "#ff6b6b";
    const corrMid = "#9a9a9a";
    const corrHigh = palette.primary;
    return {
      option: {
        animation: false,
        title: spec.title
          ? { text: spec.title, textStyle: { fontSize: 12, color: palette.textMute } }
          : undefined,
        grid: { left: 8, right: 8, top: spec.title ? 32 : 16, bottom: 56, containLabel: true },
        tooltip: {
          trigger: "item",
          formatter: (p: { data: [number, number, number | null] }) => {
            const v = p.data[2];
            return `${cols[p.data[0]]} ↔ ${cols[p.data[1]]}<br/>r = ${
              v === null ? "—" : v.toFixed(3)
            }`;
          },
        },
        xAxis: {
          type: "category",
          data: cols,
          axisLabel: {
            color: palette.textDim,
            fontSize: 9,
            rotate: cols.length > 4 ? -30 : 0,
            hideOverlap: true,
          },
          axisTick: { show: false },
          splitArea: { show: true },
        },
        yAxis: {
          type: "category",
          data: cols,
          inverse: true,
          axisLabel: { color: palette.textDim, fontSize: 9 },
          axisTick: { show: false },
          splitArea: { show: true },
        },
        visualMap: {
          min: -1,
          max: 1,
          calculable: true,
          orient: "horizontal",
          left: "center",
          bottom: 0,
          itemWidth: 12,
          itemHeight: 80,
          textStyle: { color: palette.textDim, fontSize: 9 },
          // Diverging palette: negative correlations red, neutral grey,
          // positive correlations primary green — matches the rest of the app.
          inRange: { color: [corrLow, corrMid, corrHigh] },
        },
        series: [
          {
            type: "heatmap",
            // Each cell carries its own label override — colour picked by
            // luminance of the interpolated fill so saturated cells get
            // white text and the neutral midband gets dark text.
            data: cells.map(([x, y, v]) => {
              const rounded = v === null ? null : Number(v.toFixed(3));
              const t = v === null ? 0.5 : Math.max(0, Math.min(1, (v + 1) / 2));
              const fill = lerpHex3(corrLow, corrMid, corrHigh, t);
              return {
                value: [x, y, rounded],
                label: { color: contrastText(fill) },
              };
            }),
            label: {
              show: cols.length <= 8,
              fontSize: 9,
              formatter: (p: { data: { value: [number, number, number | null] } }) => {
                const v = p.data.value[2];
                return v === null ? "—" : v.toFixed(2);
              },
            },
            itemStyle: { borderColor: palette.grid, borderWidth: 1 },
          },
        ],
      },
    };
  }

  // ── heatmap (2-categorical crosstab) ──────────────────────────────────
  // ── map (real choropleth, auto-detected region) ──────────────────────
  // Renders ECharts `series.type: "map"`. The geo registry holds multiple
  // pre-registered maps (today: "world" countries + "ZA" provinces); we
  // sample the user's data column to decide which one fits, resolve every
  // row's value to the canonical feature name, aggregate per region, and
  // zero-fill the absent ones so every polygon on the map still renders.
  if (spec.kind === "map") {
    const geoCol = spec.x;
    if (typeof geoCol !== "string") {
      return { option: null, error: "map requires the geographic column as `x`" };
    }
    if (!dataset.columns.includes(geoCol)) {
      return { option: null, error: `column "${geoCol}" not found` };
    }
    if (spec.y && !dataset.columns.includes(spec.y)) {
      return { option: null, error: `column "${spec.y}" not found` };
    }
    const mapAgg: AggFn = spec.agg ?? (spec.y ? "sum" : "count");

    // Pluck the column values; the registry's `detectMap` decides between
    // the available maps using a sample, then hands back the right resolver.
    const rawValues: string[] = [];
    for (const r of dataset.rows) {
      const v = r[geoCol];
      if (v === null || v === "") continue;
      rawValues.push(String(v));
    }
    const { mapKey, resolve } = detectMap(rawValues);

    const buckets = new Map<string, CellValue[]>();
    let unmatched = 0;
    for (const r of dataset.rows) {
      const v = r[geoCol];
      if (v === null || v === "") continue;
      const canonical = resolve(String(v));
      if (!canonical) {
        unmatched++;
        continue;
      }
      const arr = buckets.get(canonical) ?? [];
      if (spec.y) arr.push(r[spec.y]);
      else arr.push(1);
      buckets.set(canonical, arr);
    }
    if (buckets.size === 0) {
      const tail = unmatched > 0 ? ` (${unmatched} rows had unrecognised values)` : "";
      return {
        option: null,
        error: `no rows matched a known region in "${geoCol}"${tail}`,
      };
    }

    // Zero-fill so every polygon on the map shows up — the unfilled grid
    // colour reads as "we know about this region, it just isn't in the data".
    type MapDatum = { name: string; value: number };
    const data: MapDatum[] = featureNamesFor(mapKey).map((name) => {
      const v = aggregate(buckets.get(name) ?? [], mapAgg);
      return { name, value: typeof v === "number" && Number.isFinite(v) ? v : 0 };
    });
    const maxVal = Math.max(1, ...data.map((d) => d.value));
    const viewport = viewportFor(mapKey);
    const regionLabel =
      mapKey === "US" ? "US states" : mapKey === "ZA" ? "ZA provinces" : "world countries";
    const titleText = spec.title
      ? unmatched > 0
        ? `${spec.title} · (${unmatched} unmapped)`
        : spec.title
      : `${mapAgg}${spec.y ? `(${spec.y})` : ""} by ${geoCol} — ${regionLabel}`;

    return {
      option: {
        animation: false,
        title: { text: titleText, textStyle: { fontSize: 12, color: palette.textMute } },
        tooltip: {
          trigger: "item",
          formatter: (p: { name?: string; value?: number }) =>
            `<b>${p.name ?? ""}</b><br/>${mapAgg}${
              spec.y ? `(${spec.y})` : ""
            }: ${formatNumber(typeof p.value === "number" ? p.value : 0)}`,
        },
        visualMap: {
          min: 0,
          max: maxVal,
          calculable: true,
          orient: "horizontal",
          left: "center",
          bottom: 0,
          itemWidth: 12,
          itemHeight: 80,
          textStyle: { color: palette.textDim, fontSize: 9 },
          inRange: { color: [palette.grid, palette.primary] },
        },
        series: [
          {
            type: "map",
            map: mapKey,
            // Pan/zoom on for both world and US — many small polygons need
            // exploration. We could disable for tighter custom regions if
            // we add country-specific maps later.
            roam: true,
            center: viewport.center,
            zoom: viewport.zoom,
            aspectScale: viewport.aspectScale,
            label: {
              // Labels are compact codes on US (2-letter) and ZA (2-3 letter),
              // so we show them. The world map has 177 polygons — labels
              // would crowd; rely on hover tooltip there.
              show: mapKey === "US" || mapKey === "ZA",
              fontSize: 9,
              fontFamily: "'JetBrains Mono', monospace",
              color: "#ffffff",
              formatter: (p: { name?: string }) => (p.name ? shortLabel(mapKey, p.name) : ""),
            },
            emphasis: {
              label: { show: true, color: "#ffffff", fontWeight: "bold" as const },
              itemStyle: { areaColor: palette.primary },
            },
            itemStyle: {
              borderColor: "rgb(var(--rgb-bg-1))",
              borderWidth: mapKey === "world" ? 0.4 : 0.8,
              areaColor: palette.grid,
            },
            data,
          },
        ],
      },
    };
  }

  // Bucket rows by (x, y); cell value is either a count or an aggregation
  // of `valueCol`. This is what "correlation matrix between two categoricals"
  // actually means — a contingency table rendered as a heatmap.
  if (spec.kind === "heatmap") {
    const x = spec.x;
    const y = spec.y;
    if (typeof x !== "string" || typeof y !== "string") {
      return { option: null, error: "heatmap requires both `x` and `y`" };
    }
    if (!dataset.columns.includes(x)) return { option: null, error: `column "${x}" not found` };
    if (!dataset.columns.includes(y)) return { option: null, error: `column "${y}" not found` };
    if (spec.valueCol && !dataset.columns.includes(spec.valueCol)) {
      return { option: null, error: `valueCol "${spec.valueCol}" not found` };
    }
    const heatAgg: AggFn = spec.agg ?? (spec.valueCol ? "sum" : "count");
    // Build the (x, y) -> CellValue[] map in one pass.
    const buckets = new Map<string, CellValue[]>();
    const xSet = new Set<string>();
    const ySet = new Set<string>();
    for (const r of dataset.rows) {
      const xv = r[x];
      const yv = r[y];
      if (xv === null || xv === "" || yv === null || yv === "") continue;
      const xk = typeof xv === "number" ? String(xv) : xv;
      const yk = typeof yv === "number" ? String(yv) : yv;
      xSet.add(xk);
      ySet.add(yk);
      const key = `${xk} ${yk}`;
      const arr = buckets.get(key) ?? [];
      if (spec.valueCol) arr.push(r[spec.valueCol]);
      else arr.push(1);
      buckets.set(key, arr);
    }
    const xs = [...xSet].sort();
    const ys = [...ySet].sort();
    let vMin = Number.POSITIVE_INFINITY;
    let vMax = Number.NEGATIVE_INFINITY;
    const cells: Array<[number, number, number]> = [];
    for (let i = 0; i < xs.length; i++) {
      for (let j = 0; j < ys.length; j++) {
        const key = `${xs[i]} ${ys[j]}`;
        const vals = buckets.get(key) ?? [];
        const v = aggregate(vals, heatAgg);
        if (typeof v === "number" && Number.isFinite(v)) {
          cells.push([i, j, v]);
          if (v < vMin) vMin = v;
          if (v > vMax) vMax = v;
        } else {
          cells.push([i, j, 0]);
          if (0 < vMin) vMin = 0;
        }
      }
    }
    if (vMin === Number.POSITIVE_INFINITY) vMin = 0;
    if (vMax === Number.NEGATIVE_INFINITY) vMax = 1;
    // Solid endpoints (no alpha) so per-cell luminance is deterministic.
    // Pulled from the palette so light/dark themes both stay calibrated.
    const heatLow = palette.grid;
    const heatHigh = palette.primary;
    return {
      option: {
        animation: false,
        title: spec.title
          ? { text: spec.title, textStyle: { fontSize: 12, color: palette.textMute } }
          : undefined,
        grid: { left: 8, right: 8, top: spec.title ? 32 : 16, bottom: 56, containLabel: true },
        tooltip: {
          trigger: "item",
          formatter: (p: { data: { value: [number, number, number] } }) => {
            const d = p.data.value;
            return `${x}: ${xs[d[0]]}<br/>${y}: ${ys[d[1]]}<br/>${heatAgg}${
              spec.valueCol ? `(${spec.valueCol})` : ""
            }: ${formatNumber(d[2])}`;
          },
        },
        xAxis: {
          type: "category",
          data: xs,
          axisLabel: {
            color: palette.textDim,
            fontSize: 9,
            rotate: xs.length > 6 ? -30 : 0,
            hideOverlap: true,
          },
          axisTick: { show: false },
          splitArea: { show: true },
        },
        yAxis: {
          type: "category",
          data: ys,
          inverse: true,
          axisLabel: { color: palette.textDim, fontSize: 9 },
          axisTick: { show: false },
          splitArea: { show: true },
        },
        visualMap: {
          min: vMin,
          max: vMax,
          calculable: true,
          orient: "horizontal",
          left: "center",
          bottom: 0,
          itemWidth: 12,
          itemHeight: 80,
          textStyle: { color: palette.textDim, fontSize: 9 },
          inRange: { color: [heatLow, heatHigh] },
        },
        series: [
          {
            type: "heatmap",
            data: cells.map(([cx, cy, v]) => {
              const span = vMax - vMin || 1;
              const t = Math.max(0, Math.min(1, (v - vMin) / span));
              const fill = lerpHex(heatLow, heatHigh, t);
              return {
                value: [cx, cy, v],
                label: { color: contrastText(fill) },
              };
            }),
            label: {
              show: xs.length * ys.length <= 64,
              fontSize: 9,
              formatter: (p: { data: { value: [number, number, number] } }) =>
                formatNumber(p.data.value[2]),
            },
            itemStyle: { borderColor: palette.grid, borderWidth: 1 },
          },
        ],
      },
    };
  }

  // ── bar / line / pie / scatter need spec.x ───────────────────────────
  if (typeof spec.x !== "string") {
    return { option: null, error: `chart kind \`${spec.kind}\` requires an x column` };
  }
  if (!dataset.columns.includes(spec.x)) {
    return { option: null, error: `column "${spec.x}" not found` };
  }
  if (spec.y && !dataset.columns.includes(spec.y)) {
    return { option: null, error: `column "${spec.y}" not found` };
  }
  const agg: AggFn = spec.agg ?? (spec.y ? "sum" : "count");

  // Special-case: scatter doesn't aggregate — it plots raw (x, y) pairs.
  // We also compute Pearson r over the plotted pairs and surface it as a
  // small corner label, so "correlation between paid and age" gets both the
  // shape AND the magnitude in one chart.
  if (spec.kind === "scatter") {
    if (!spec.y) return { option: null, error: "scatter requires a `y` column" };
    const xs: number[] = [];
    const ys: number[] = [];
    for (const r of dataset.rows) {
      const xv = asNumber(r[spec.x]);
      const yv = asNumber(r[spec.y]);
      if (xv !== null && yv !== null) {
        xs.push(xv);
        ys.push(yv);
      }
    }
    const limit = spec.limit ?? 5000;
    const data: Array<[number, number]> = [];
    for (let i = 0; i < xs.length && data.length < limit; i++) data.push([xs[i], ys[i]]);
    const r = pearson(xs, ys);
    const rLabel = r === null ? "r — undefined" : `r = ${r.toFixed(3)}  ·  n = ${xs.length}`;
    return {
      option: {
        animation: false,
        title: spec.title
          ? { text: spec.title, textStyle: { fontSize: 12, color: palette.textMute } }
          : undefined,
        grid: { left: 8, right: 8, top: spec.title ? 32 : 26, bottom: 26, containLabel: true },
        tooltip: {
          trigger: "item",
          formatter: (p: { data: [number, number] }) =>
            `${spec.x}: ${formatNumber(p.data[0])}<br/>${spec.y}: ${formatNumber(p.data[1])}`,
        },
        // Anchored r/n badge in the top-right of the plot. Using `graphic`
        // keeps it floating regardless of zoom / pan.
        graphic: [
          {
            type: "text",
            right: 12,
            top: spec.title ? 26 : 4,
            style: {
              text: rLabel,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              fill: palette.textMute,
            },
          },
        ],
        xAxis: {
          type: "value",
          name: spec.x,
          nameLocation: "middle",
          nameGap: 20,
          nameTextStyle: { fontSize: 10, color: palette.textDim },
          axisLabel: { color: palette.textDim, fontSize: 9 },
          splitLine: { lineStyle: { color: palette.grid, opacity: 0.3 } },
        },
        yAxis: {
          type: "value",
          name: spec.y,
          nameLocation: "middle",
          nameGap: 32,
          nameTextStyle: { fontSize: 10, color: palette.textDim },
          axisLabel: { color: palette.textDim, fontSize: 9 },
          splitLine: { lineStyle: { color: palette.grid, opacity: 0.3 } },
        },
        series: [
          {
            type: "scatter",
            data,
            symbolSize: 5,
            itemStyle: { color: palette.primary, opacity: 0.6 },
          },
        ],
      },
    };
  }

  // bar / line / pie all aggregate by `x`.
  const groups = groupByColumn(dataset.rows, spec.x);
  let aggregated: Array<{ key: string; value: number }> = [];
  for (const [k, group] of groups) {
    const vals = spec.y ? group.map((r) => r[spec.y as string]) : group.map(() => 1 as CellValue);
    const v = aggregate(vals, agg);
    if (typeof v === "number" && Number.isFinite(v)) aggregated.push({ key: k, value: v });
  }
  // Sort categorical x by frequency for bar/pie; preserve numeric/year order
  // for line charts so trajectories read left-to-right.
  if (spec.kind === "line") {
    aggregated.sort((a, b) => {
      const an = Number(a.key);
      const bn = Number(b.key);
      if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
      return a.key.localeCompare(b.key);
    });
  } else {
    aggregated.sort((a, b) => b.value - a.value);
  }
  const limit = spec.limit ?? (spec.kind === "pie" ? 8 : 20);
  if (aggregated.length > limit) aggregated = aggregated.slice(0, limit);

  const titleBlock = spec.title
    ? { text: spec.title, textStyle: { fontSize: 12, color: palette.textMute } }
    : undefined;

  if (spec.kind === "pie") {
    return {
      option: {
        animation: false,
        title: titleBlock,
        tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
        legend: {
          orient: "horizontal",
          bottom: 0,
          textStyle: { color: palette.textMute, fontSize: 10 },
          itemWidth: 8,
          itemHeight: 8,
        },
        series: [
          {
            type: "pie",
            radius: ["35%", "60%"],
            center: ["50%", "45%"],
            data: aggregated.map((d, i) => ({
              name: d.key,
              value: d.value,
              itemStyle: { color: palette.cats[i % palette.cats.length] },
            })),
            label: { fontSize: 10, color: palette.textMute },
            labelLine: { lineStyle: { color: palette.grid } },
          },
        ],
      },
    };
  }

  // bar | line — categorical x, numeric y
  const isLine = spec.kind === "line";
  return {
    option: {
      animation: false,
      title: titleBlock,
      grid: { left: 8, right: 12, top: titleBlock ? 28 : 12, bottom: 32, containLabel: true },
      tooltip: {
        trigger: "axis",
        axisPointer: isLine ? { type: "line" } : { type: "shadow" },
        formatter: (params: Array<{ axisValue: string; data: number }>) => {
          if (!Array.isArray(params) || params.length === 0) return "";
          const p = params[0];
          return `<b>${p.axisValue}</b><br/>${spec.y ?? "count"}: ${formatNumber(Number(p.data))}`;
        },
      },
      xAxis: {
        type: "category",
        data: aggregated.map((d) => d.key),
        axisLabel: {
          color: palette.textDim,
          fontSize: 9,
          hideOverlap: true,
          rotate: aggregated.length > 8 ? -25 : 0,
        },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: palette.grid } },
      },
      yAxis: {
        type: "value",
        axisLabel: {
          color: palette.textDim,
          fontSize: 9,
          formatter: (v: number) => formatNumber(v),
        },
        splitLine: { lineStyle: { color: palette.grid, type: "dashed", opacity: 0.4 } },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      series: [
        {
          type: isLine ? "line" : "bar",
          data: aggregated.map((d) => d.value),
          smooth: isLine,
          itemStyle: { color: palette.primary, borderRadius: isLine ? 0 : [2, 2, 0, 0] },
          lineStyle: isLine ? { color: palette.primary, width: 1.5 } : undefined,
          areaStyle: isLine ? { color: palette.primary, opacity: 0.15 } : undefined,
          symbol: isLine ? "circle" : "none",
          symbolSize: 4,
          barWidth: "70%",
        },
      ],
    },
  };
}

// ── table renderer ─────────────────────────────────────────────────────────

type TableRow = { cells: Array<{ raw: CellValue; display: string }> };

function tableData(
  spec: TableSpec,
  dataset: Dataset,
): { headers: string[]; rows: TableRow[]; error?: string } {
  const limit = spec.limit ?? 20;

  // No grouping — slice the first N rows of the requested columns (or all).
  if (!spec.groupBy) {
    const cols =
      spec.columns && spec.columns.length > 0 ? spec.columns.map((c) => c.col) : dataset.columns;
    for (const c of cols) {
      if (!dataset.columns.includes(c)) {
        return { headers: [], rows: [], error: `column "${c}" not found` };
      }
    }
    const headers = cols;
    const rows = dataset.rows.slice(0, limit).map((r) => ({
      cells: cols.map((c) => ({ raw: r[c], display: formatCell(r[c]) })),
    }));
    return { headers, rows };
  }

  // Grouped — `groupBy` becomes the first column; each requested column gets
  // its aggregation applied per group.
  if (!dataset.columns.includes(spec.groupBy)) {
    return { headers: [], rows: [], error: `groupBy "${spec.groupBy}" not found` };
  }
  const cols = spec.columns ?? [];
  for (const c of cols) {
    if (!dataset.columns.includes(c.col)) {
      return { headers: [], rows: [], error: `column "${c.col}" not found` };
    }
  }
  const headers = [spec.groupBy, ...cols.map((c) => c.label ?? `${c.agg ?? "first"}(${c.col})`)];
  const groups = groupByColumn(dataset.rows, spec.groupBy);
  const aggregated: Array<{ key: string; values: CellValue[] }> = [];
  for (const [k, group] of groups) {
    const values: CellValue[] = cols.map((c) =>
      aggregate(
        group.map((r) => r[c.col]),
        c.agg ?? "first",
      ),
    );
    aggregated.push({ key: k, values });
  }
  // Sort by the first aggregation column when present, otherwise by key.
  aggregated.sort((a, b) => {
    const an = asNumber(a.values[0]);
    const bn = asNumber(b.values[0]);
    if (an !== null && bn !== null) return bn - an;
    return a.key.localeCompare(b.key);
  });
  return {
    headers,
    rows: aggregated.slice(0, limit).map((g) => ({
      cells: [
        { raw: g.key, display: g.key },
        ...g.values.map((v) => ({ raw: v, display: formatCell(v) })),
      ],
    })),
  };
}

function formatCell(v: CellValue): string {
  if (v === null) return "—";
  if (typeof v === "number") return formatNumber(v);
  return String(v);
}

// ── React renderers ────────────────────────────────────────────────────────

function VizError({ message }: { message: string }) {
  return (
    <div className="my-2 rounded border border-error/40 bg-error/5 px-2.5 py-1.5 font-mono text-[11px] text-error">
      viz error · {message}
    </div>
  );
}

function ChartView({ spec, dataset }: { spec: ChartSpec; dataset: Dataset | null }) {
  const { resolved } = useTheme();
  const palette = useMemo(
    () => ({
      primary: resolved === "light" ? "#009669" : "#00d68f",
      grid: resolved === "light" ? "#e6e4df" : "#2a2a2a",
      textDim: resolved === "light" ? "#8a8a86" : "#6a6a66",
      textMute: resolved === "light" ? "#5a5a56" : "#9a9a96",
      cats:
        resolved === "light"
          ? ["#009669", "#3760cc", "#7649c7", "#ae6614", "#b73a3a", "#0d8e7f", "#5c5c5a"]
          : ["#00d68f", "#7aa2f7", "#bb9af7", "#ffb454", "#ff6b6b", "#73daca", "#9a9a9a"],
    }),
    [resolved],
  );
  if (!dataset) return <VizError message="no dataset loaded — upload data first" />;
  const { option, error } = chartOption(spec, dataset, palette);
  if (error || !option) return <VizError message={error ?? "could not build chart"} />;

  // Chart kinds where horizontal stretching distorts the read get a square
  // container, centred and capped at a comfortable size.
  //   • pie / corr / heatmap — inherently 2-axis-symmetric, a non-square box
  //     skews proportions or cell shapes
  //   • scatter — distorting x:y silently changes how the eye reads
  //     correlation strength; 1:1 keeps "slope of 1 = slope of 1"
  // Bar / line stay rectangular — they read better with extra width for
  // category labels and time-axis tick density.
  const isSquare = ["pie", "scatter", "heatmap", "corr", "map"].includes(spec.kind);
  return (
    <div
      className={`my-2 overflow-hidden rounded border border-border bg-bg p-2 ${
        isSquare ? "mx-auto aspect-square w-full max-w-md" : ""
      }`}
    >
      <ReactECharts
        option={option}
        notMerge
        lazyUpdate
        style={isSquare ? { height: "100%", width: "100%" } : { height: 260, width: "100%" }}
        opts={{ renderer: "canvas" }}
      />
    </div>
  );
}

function TableView({ spec, dataset }: { spec: TableSpec; dataset: Dataset | null }) {
  if (!dataset) return <VizError message="no dataset loaded — upload data first" />;
  const { headers, rows, error } = tableData(spec, dataset);
  if (error) return <VizError message={error} />;
  return (
    <div className="my-2 overflow-hidden rounded border border-border bg-bg">
      {spec.title && (
        <div className="border-b border-border bg-bg-1 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-fg-mute">
          {spec.title}
        </div>
      )}
      <div className="max-h-72 overflow-auto">
        <table className="w-full border-collapse font-mono text-[11px]">
          <thead className="sticky top-0 bg-bg-1">
            <tr>
              {headers.map((h) => (
                <th
                  key={h}
                  className="border-b border-border px-2 py-1.5 text-left font-mono text-[10px] uppercase tracking-wider text-fg-dim"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              // Use the first cell's value as a stable row key when possible;
              // fall back to a positional prefix so collisions on duplicate
              // group keys (rare but possible) don't clash.
              const rowKey = `${i}:${r.cells[0]?.display ?? ""}`;
              return (
                <tr key={rowKey} className="odd:bg-bg-1/40">
                  {r.cells.map((c, j) => (
                    <td
                      // Header text is stable across renders → safe key.
                      key={`${rowKey}:${headers[j] ?? j}`}
                      className={`border-b border-border/40 px-2 py-1 ${
                        typeof c.raw === "number"
                          ? "text-right tabular-nums text-fg"
                          : "text-fg-mute"
                      }`}
                    >
                      {c.display}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <div className="px-2.5 py-2 text-center text-[11px] text-fg-dim">No matching rows.</div>
      )}
    </div>
  );
}

// Memoised — when the user types into the chat draft textarea, the parent
// tree re-renders on every keystroke. Without memo, every existing chart
// runs `safeParseSpec` + `chartOption` + a full ReactECharts cycle per
// keystroke, which surfaces as a visible flicker on the canvas. The props
// (`raw` string + `dataset` reference) only change when a new viz block is
// emitted or the user uploads a new file.
function ChatVizImpl({ raw, dataset }: { raw: string; dataset: Dataset | null }) {
  const parsed = useMemo(() => safeParseSpec(raw), [raw]);
  if ("error" in parsed) return <VizError message={parsed.error} />;
  if (parsed.type === "chart") return <ChartView spec={parsed} dataset={dataset} />;
  return <TableView spec={parsed} dataset={dataset} />;
}

export const ChatViz = memo(ChatVizImpl);
