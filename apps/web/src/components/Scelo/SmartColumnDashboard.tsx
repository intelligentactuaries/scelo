// Right-panel "smart" dashboard for the focused column.
//
// On mount (and whenever the column / filter slice / regenerate seed
// changes) we ask the orchestrator: here's the column shape, top values,
// slice, and whether it looks geographic — pick 1-3 plots from a fixed
// menu and return JSON. We parse the JSON and render. If the call fails
// or routes to a specialist tool, a heuristic fallback picks a sensible
// default mix so the panel is never empty.
//
// Plot menu:
//   histogram     — continuous numeric distribution
//   boxplot       — five-number summary + outliers
//   donut         — top categories as proportions (≤ 8 unique)
//   bar           — sorted bar of value counts
//   treemap       — high-cardinality value counts
//   geo-map       — real 2D choropleth (auto-picks world / US / ZA)
//   stats-card    — descriptive stats only, no chart
//   date-timeline    — volume over time, auto-binned  (date columns only)
//   date-calendar    — coverage + density heatmap     (date columns only)
//   date-seasonality — month + weekday cycles         (date columns only)
//
// Date columns route to their own plot family. They used to fall through to
// the high-cardinality categorical mix — a treemap of every distinct day
// plus a bar chart ranking individual dates by row count — which is visually
// busy and says nothing. See dateProfile.ts.
//
// If the column is detected as geographic — by SHAPE, not by name (the
// `detectMap` resolver from geoRegistry matches against country names,
// US states, and SA provinces) — the LLM is told the first plot MUST be
// "geo-map", and the heuristic fallback honours the same rule. A choropleth
// is ALWAYS shown for geographic columns; we never fall back to a scatter
// or bubble overlay for these.

import ReactECharts from "@/components/ReactEChartsCrisp";
import { streamOrchestrator } from "@/lib/api";
import {
  BarChart,
  BoxplotChart,
  HeatmapChart,
  LineChart,
  MapChart,
  PieChart,
  ScatterChart,
  TreemapChart,
} from "echarts/charts";
import {
  CalendarComponent,
  GeoComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ColumnMeta,
  type ColumnType,
  type Filter,
  type Palette,
  type Row,
  applyFilters,
  describeFilter,
  formatNumber,
  minMax,
  tooltipFrame,
  usePalette,
} from "./SoftDataWorkstation";
import {
  MONTH_LABELS,
  WEEKDAY_LABELS,
  binSeries,
  collectDates,
  dateSummary,
  describeSpan,
  monthProfile,
  weekdayProfile,
  yearMonthGrid,
} from "./dateProfile";
// `geoRegistry` is imported for its side-effect of registering the "world",
// "US", and "ZA" maps with the shared ECharts instance — plus its detection
// + lookup utilities. Without this import, `series.type: "map"` below would
// fail with "map not found".
import {
  type MapRegistryKey,
  detectMap,
  featureNamesFor,
  shortLabel,
  viewportFor,
} from "./geoRegistry";

echarts.use([
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  VisualMapComponent,
  GeoComponent,
  CalendarComponent,
  BarChart,
  BoxplotChart,
  PieChart,
  ScatterChart,
  TreemapChart,
  MapChart,
  LineChart,
  HeatmapChart,
  CanvasRenderer,
]);

// ── geographic detection ─────────────────────────────────────────────────────
//
// Detection is SHAPE-driven, not name-driven. We hand the column's top values
// to the shared `detectMap` resolver from geoRegistry — the same one the chat
// uses when the LLM asks for a map — which sniffs against three registered
// atlases (world countries, US states, SA provinces) and reports the best
// fit. A column qualifies as geographic if a meaningful share of its top
// values map to known features; the resolver alone always returns *some*
// mapKey, so we apply our own match threshold here.

type GeoKind = MapRegistryKey;

function detectGeoKind(meta: ColumnMeta): GeoKind | null {
  if (meta.type !== "string") return null;
  if (!meta.topValues || meta.topValues.length === 0) return null;
  const sample = meta.topValues.map((v) => v.value);
  const { mapKey, resolve } = detectMap(sample);
  let matched = 0;
  for (const v of sample) if (resolve(v)) matched++;
  // Need at least half of the top values (capped at 3) to resolve. This
  // catches "state" with SA codes (WC, GP, …) and "country" with country
  // names, but rejects an "industry" column whose values just happen to
  // collide with one or two place names.
  const threshold = Math.min(3, Math.ceil(sample.length / 2));
  return matched >= threshold ? mapKey : null;
}

// ── plot model ───────────────────────────────────────────────────────────────

export type PlotType =
  | "histogram"
  | "boxplot"
  | "donut"
  | "bar"
  | "treemap"
  | "geo-map"
  | "stats-card"
  // date-only — see dateProfile.ts for why a date column can't be treated
  // as a categorical one.
  | "date-timeline"
  | "date-calendar"
  | "date-seasonality";

export type PlotSpec = {
  type: PlotType;
  title: string;
};

export type DashboardSpec = {
  plots: PlotSpec[];
  rationale?: string;
};

const VALID_PLOT_TYPES = new Set<PlotType>([
  "histogram",
  "boxplot",
  "donut",
  "bar",
  "treemap",
  "geo-map",
  "stats-card",
  "date-timeline",
  "date-calendar",
  "date-seasonality",
]);

/** Plot types that only make sense on a date column. Offering these for a
 *  numeric or categorical column would render an empty frame. */
const DATE_ONLY_PLOTS = new Set<PlotType>(["date-timeline", "date-calendar", "date-seasonality"]);

// ── heuristic fallback ──────────────────────────────────────────────────────
//
// Each column "kind" has a small library of mixes. heuristicDashboard picks
// one by `variant % library.length`, so when the LLM is unreachable, the
// regenerate button still cycles through visibly different dashboards
// instead of returning the same answer.
//
// Every entry has EXACTLY 3 plots and at least one chart (not a stats-card).
// enforceDashboardShape reapplies the invariant to whatever the LLM returns
// later in the pipeline.

type HeuristicLibrary = Array<DashboardSpec>;

// Geographic columns get a 2D choropleth as the lead plot every time —
// regardless of the underlying region (world / US / ZA), the map renderer
// picks the right atlas itself. Other slots rotate between counts (bar),
// proportions (donut), and volume layouts (treemap) so regenerate cycles
// through visibly different mixes.
const LIB_GEO: HeuristicLibrary = [
  {
    plots: [
      { type: "geo-map", title: "Geographic spread" },
      { type: "bar", title: "Counts by region" },
      { type: "stats-card", title: "Coverage" },
    ],
    rationale: "2D choropleth for shape, ranked bar for absolute counts.",
  },
  {
    plots: [
      { type: "geo-map", title: "Spatial concentration" },
      { type: "donut", title: "Regional mix" },
      { type: "stats-card", title: "Coverage" },
    ],
    rationale: "Choropleth for shape, donut for proportional mix.",
  },
  {
    plots: [
      { type: "geo-map", title: "Regional footprint" },
      { type: "treemap", title: "Volume per region" },
      { type: "bar", title: "Top regions" },
    ],
    rationale: "Map, treemap, and ranked bar — three takes on regional volume.",
  },
];

const LIB_CONSTANT: HeuristicLibrary = [
  {
    plots: [
      { type: "stats-card", title: "Constant column" },
      { type: "bar", title: "One value, all rows" },
      { type: "donut", title: "Single slice" },
    ],
    rationale: "Constant — degenerate column, all rows share one value.",
  },
  {
    plots: [
      { type: "stats-card", title: "Single value" },
      { type: "donut", title: "All-in" },
      { type: "bar", title: "Universal" },
    ],
    rationale: "Constant — flipped order of the same three angles.",
  },
];

const LIB_IDLIKE: HeuristicLibrary = [
  {
    plots: [
      { type: "stats-card", title: "id-like — all unique" },
      { type: "treemap", title: "Value layout" },
      { type: "bar", title: "First values" },
    ],
    rationale: "id-like — treemap shows uniformity, bar samples the head.",
  },
  {
    plots: [
      { type: "treemap", title: "Cardinality grid" },
      { type: "stats-card", title: "Uniqueness" },
      { type: "bar", title: "Sample" },
    ],
    rationale: "Lead with the treemap; sample bar; stats trailing.",
  },
];

const LIB_NUMERIC: HeuristicLibrary = [
  {
    plots: [
      { type: "histogram", title: "Distribution" },
      { type: "boxplot", title: "Five-number summary" },
      { type: "stats-card", title: "Descriptive stats" },
    ],
    rationale: "Shape (histogram) + spread (boxplot) + headline stats.",
  },
  {
    plots: [
      { type: "boxplot", title: "Spread + outliers" },
      { type: "stats-card", title: "Headline stats" },
      { type: "histogram", title: "Shape" },
    ],
    rationale: "Lead with boxplot for outliers, stats next, shape last.",
  },
  {
    plots: [
      { type: "histogram", title: "Shape" },
      { type: "stats-card", title: "Stats" },
      { type: "boxplot", title: "Outliers" },
    ],
    rationale: "Shape first, then stats, then outliers.",
  },
];

const LIB_LOWCAT: HeuristicLibrary = [
  {
    plots: [
      { type: "donut", title: "Composition" },
      { type: "bar", title: "Counts" },
      { type: "stats-card", title: "Stats" },
    ],
    rationale: "Donut for proportions, bar for ranking, stats for headline.",
  },
  {
    plots: [
      { type: "bar", title: "Ranked counts" },
      { type: "donut", title: "Share" },
      { type: "stats-card", title: "Coverage" },
    ],
    rationale: "Lead with the ranked bar; donut for share; stats trailing.",
  },
  {
    plots: [
      { type: "donut", title: "Mix" },
      { type: "treemap", title: "Volume" },
      { type: "bar", title: "Top" },
    ],
    rationale: "Donut + treemap + bar — three lenses on the same composition.",
  },
];

const LIB_HIGHCAT: HeuristicLibrary = [
  {
    plots: [
      { type: "treemap", title: "Value counts" },
      { type: "bar", title: "Top values" },
      { type: "stats-card", title: "Cardinality" },
    ],
    rationale: "Treemap for the overview, bar for the head, stats trailing.",
  },
  {
    plots: [
      { type: "bar", title: "Top values" },
      { type: "treemap", title: "Long tail" },
      { type: "stats-card", title: "Uniqueness" },
    ],
    rationale: "Bar leads with the head; treemap shows the tail; stats trailing.",
  },
  {
    plots: [
      { type: "treemap", title: "Volume" },
      { type: "donut", title: "Top-N mix" },
      { type: "bar", title: "Rank" },
    ],
    rationale: "Treemap + donut + bar — three angles on a long-tail categorical.",
  },
];

// Dates get their own library. Before this existed a date column fell
// through to LIB_HIGHCAT and was drawn as a treemap of a few thousand
// distinct days plus a bar chart ranking individual dates by count —
// visually busy and analytically empty. The three views here answer the
// questions a date column actually raises: WHEN (timeline), WHERE ARE THE
// GAPS AND CYCLES (calendar), and WHAT REPEATS (seasonality).
const LIB_DATE: HeuristicLibrary = [
  {
    plots: [
      { type: "date-timeline", title: "Volume over time" },
      { type: "date-calendar", title: "Coverage + density" },
      { type: "stats-card", title: "Range" },
    ],
    rationale: "Timeline for trend, calendar for coverage and gaps, stats for the range.",
  },
  {
    plots: [
      { type: "date-calendar", title: "Coverage + density" },
      { type: "date-seasonality", title: "Month + weekday cycles" },
      { type: "stats-card", title: "Range" },
    ],
    rationale: "Lead with coverage, then the repeating cycles, stats trailing.",
  },
  {
    plots: [
      { type: "date-timeline", title: "Volume over time" },
      { type: "date-seasonality", title: "Month + weekday cycles" },
      { type: "stats-card", title: "Range" },
    ],
    rationale: "Trend first, then seasonality, then the headline range.",
  },
];

function pickLibrary(meta: ColumnMeta, geoKind: GeoKind | null): HeuristicLibrary {
  // Any geographic column — world / US / ZA — gets the choropleth-led mix.
  if (geoKind !== null) return LIB_GEO;
  if (meta.unique <= 1) return LIB_CONSTANT;
  // Checked before the id-like and cardinality rules: a date column is
  // near-unique by nature, and neither "id-like" nor "high cardinality"
  // describes anything useful about it.
  if (meta.type === "date") return LIB_DATE;
  if (meta.type === "string" && meta.count > 0 && meta.unique / meta.count > 0.8) {
    return LIB_IDLIKE;
  }
  if (meta.type === "number") return LIB_NUMERIC;
  if (meta.unique <= 8) return LIB_LOWCAT;
  return LIB_HIGHCAT;
}

function heuristicDashboard(meta: ColumnMeta, geoKind: GeoKind | null, variant = 0): DashboardSpec {
  const lib = pickLibrary(meta, geoKind);
  // Clone so the caller can mutate without corrupting the library entry.
  const choice = lib[((variant % lib.length) + lib.length) % lib.length];
  return { plots: choice.plots.map((p) => ({ ...p })), rationale: choice.rationale };
}

const TARGET_PLOTS = 3;

// Take whatever the LLM returned and force three constraints:
//   1. exactly 3 plots in the array
//   2. at least one of them is a chart (not stats-card)
//   3. if the column is geographic, a real 2D map ("geo-map") MUST appear
//      AS THE FIRST plot — non-negotiable. We also strip any incorrect
//      bubble/scatter overlay the LLM may have tried to use for geography.
//
// We pad from the heuristic dashboard so the additions are sensible for
// the column's type, never random.
function enforceDashboardShape(
  spec: DashboardSpec,
  meta: ColumnMeta,
  geoKind: GeoKind | null,
  variant = 0,
): DashboardSpec {
  const heuristic = heuristicDashboard(meta, geoKind, variant);
  // 4. type sanity — a date-only plot on a numeric column (or a histogram /
  //    boxplot on a date column) renders an empty frame, so drop those
  //    before the padding step below refills the slots correctly.
  let plots = spec.plots
    .filter((p) => (meta.type === "date" ? true : !DATE_ONLY_PLOTS.has(p.type)))
    .filter((p) => (meta.type === "date" ? p.type !== "histogram" && p.type !== "boxplot" : true))
    .slice(0, TARGET_PLOTS);

  // 3. geographic rule — a 2D choropleth MUST lead the dashboard. If the
  //    LLM didn't include one, prepend; if it included one but elsewhere,
  //    move it to the front.
  if (geoKind) {
    const existingGeoIdx = plots.findIndex((p) => p.type === "geo-map");
    if (existingGeoIdx === -1) {
      const geo: PlotSpec = { type: "geo-map", title: "Geographic spread" };
      plots = [geo, ...plots].slice(0, TARGET_PLOTS);
    } else if (existingGeoIdx > 0) {
      const [geo] = plots.splice(existingGeoIdx, 1);
      plots = [geo, ...plots];
    }
  }

  // 2. at least one chart — if everything is a stats-card, replace the last
  //    one with the heuristic's primary chart.
  if (!plots.some((p) => p.type !== "stats-card")) {
    const chart = heuristic.plots.find((p) => p.type !== "stats-card");
    if (chart) {
      plots[Math.max(0, plots.length - 1)] = chart;
    }
  }

  // 1. pad to 3 — pull complementary plots from the heuristic (different
  //    type from what's already there), falling back to a stats-card.
  while (plots.length < TARGET_PLOTS) {
    const existingTypes = new Set(plots.map((p) => p.type));
    const candidate =
      heuristic.plots.find((p) => !existingTypes.has(p.type)) ??
      ({ type: "stats-card", title: "Stats" } as PlotSpec);
    plots.push(candidate);
  }

  return { ...spec, plots };
}

// ── LLM call ────────────────────────────────────────────────────────────────

function describeMetaForLLM(meta: ColumnMeta): string {
  const lines = [
    `name: ${meta.name}`,
    `type: ${meta.type}`,
    `count: ${meta.count}, missing: ${meta.missing}, unique: ${meta.unique}`,
  ];
  if (meta.type === "number") {
    const parts: string[] = [];
    if (meta.min !== undefined) parts.push(`min=${formatNumber(meta.min)}`);
    if (meta.mean !== undefined) parts.push(`mean=${formatNumber(meta.mean)}`);
    if (meta.median !== undefined) parts.push(`median=${formatNumber(meta.median)}`);
    if (meta.max !== undefined) parts.push(`max=${formatNumber(meta.max)}`);
    if (meta.q1 !== undefined && meta.q3 !== undefined) {
      parts.push(`IQR=[${formatNumber(meta.q1)},${formatNumber(meta.q3)}]`);
    }
    if (meta.quintiles) {
      parts.push(`quintiles(p20/p40/p60/p80)=[${meta.quintiles.map(formatNumber).join(",")}]`);
    }
    if (meta.outliers) parts.push(`outliers=${meta.outliers.length}`);
    lines.push(`numeric stats: ${parts.join(", ")}`);
  } else if (meta.type === "date") {
    // Range, not top values — the profiler deliberately omits topValues for
    // dates, and handing the model a list of individual days invites exactly
    // the categorical treatment the date plots exist to replace.
    lines.push(`date range: ${meta.dateMin ?? "?"} → ${meta.dateMax ?? "?"}`);
    if (meta.yearHistogram && meta.yearHistogram.length > 0) {
      lines.push(
        `rows per year: ${meta.yearHistogram.map((y) => `${y.year}=${y.count}`).join(", ")}`,
      );
    }
  } else if (meta.topValues) {
    lines.push(
      `top values: ${meta.topValues
        .slice(0, 8)
        .map((v) => `${v.value}=${v.count}`)
        .join(", ")}`,
    );
  }
  return lines.join("\n");
}

function buildPickerPrompt(args: {
  meta: ColumnMeta;
  geoKind: GeoKind | null;
  filters: Filter[];
  sliceRows: number;
  totalRows: number;
  variant: number;
  previousTypes: PlotType[];
}): string {
  const { meta, geoKind, filters, sliceRows, totalRows, variant, previousTypes } = args;

  const filterDesc =
    filters.length > 0
      ? filters.map((f) => `  • ${describeFilter(f)}`).join("\n")
      : "  (no filters)";

  // Stateless LLM — it has no memory of its prior pick, so on regenerate we
  // explicitly hand it the previous plot types and forbid reuse. Without
  // this, "pick a different mix" is a no-op and the user sees the same
  // dashboard every time they hit regenerate.
  const variantNudge =
    variant > 0
      ? `\nREGENERATION attempt #${variant + 1}. Your previous pick was: [${previousTypes.join(", ") || "?"}]. Change at least ONE of the three plot TYPES this time. If multiple alternative mixes exist for this column, choose one you have NOT picked before. Vary the titles even where the types must repeat.`
      : "";

  // The opening line is load-bearing — the orchestrator's rule-based router
  // will hijack this prompt into a specialist tool (documentation, reserving,
  // etc.) if the chat-task framing isn't anchored at the very top. Keep the
  // "DO NOT CALL ANY TOOL" line first.
  return `CRITICAL: DO NOT CALL ANY TOOL. DO NOT dispatch documentation.predict, reserving.predict, or any specialist. This is a pure JSON-generation task answered as a chat reply.

Task: pick 1-3 visualisation types from the fixed menu below and return JSON only.

MENU:
- "histogram": continuous numeric distribution (12-15 bins)
- "boxplot": five-number summary + outliers
- "donut": top categories as proportions, best for ≤ 8 unique
- "bar": sorted bar chart of category counts (any cardinality)
- "treemap": nested rectangles for high-cardinality categoricals (> 8 unique)
- "geo-map": real 2D choropleth (world / US / ZA, auto-picked); ALWAYS use this for geographic columns — NEVER substitute a scatter, bubble, treemap, or bar for geography
- "stats-card": descriptive stats card, no chart
- "date-timeline": volume over time, auto-binned day/week/month/quarter/year — DATE COLUMNS ONLY
- "date-calendar": calendar heatmap of coverage and density; falls back to a year × month grid on long spans — DATE COLUMNS ONLY
- "date-seasonality": month-of-year and day-of-week profiles, for repeating cycles — DATE COLUMNS ONLY

For a DATE column pick from the three date plots (plus optionally "stats-card").
A date column is not a categorical one: NEVER use "bar", "treemap", or "donut"
for dates — ranking individual calendar days by row count is noise, and a
treemap of thousands of distinct days is unreadable. "histogram" and "boxplot"
are numeric-only and will render empty for a date.

COLUMN
${describeMetaForLLM(meta)}

GEOGRAPHIC: ${geoKind ?? "false"}

SLICE CONTEXT
filtered slice: ${sliceRows} of ${totalRows} rows
active filters:
${filterDesc}

RULES
- Pick EXACTLY 3 plots — no fewer, no more.
- At least ONE of the 3 plots MUST be a chart (NOT "stats-card"). It's fine to have one stats-card alongside two charts.
- The 3 plots must show DIFFERENT angles — do not pick the same type twice.
- If GEOGRAPHIC is set (not "false"), the FIRST plot MUST be "geo-map" — a real 2D choropleth. Do NOT substitute "bar", "donut", "treemap", or any scatter-style plot for the lead geography view. The choropleth is non-negotiable for any column with place names, ISO country names, US state codes/names, or SA province codes/names — even if the column is called something generic like "state", "region", or "loc".
- For id-like columns (every row distinct), pair "stats-card" with "treemap" and "bar".
- For constant columns (unique = 1), pair "stats-card" with "bar" and "donut".${variantNudge}

Reply with ONLY this JSON object — no prose, no code fences, no tool calls:
{"plots":[{"type":"<one of menu>","title":"<short ≤ 4 words>"},{"type":"...","title":"..."},{"type":"...","title":"..."}],"rationale":"<one sentence>"}`;
}

function extractFirstJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  // direct parse
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  // strip code fences
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fall through */
    }
  }
  // first {...} block
  const block = trimmed.match(/\{[\s\S]*\}/);
  if (block) {
    try {
      return JSON.parse(block[0]);
    } catch {
      /* fall through */
    }
  }
  return null;
}

function coerceDashboardSpec(raw: unknown): DashboardSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { plots?: unknown; rationale?: unknown };
  if (!Array.isArray(r.plots)) return null;
  const plots: PlotSpec[] = [];
  for (const p of r.plots) {
    if (!p || typeof p !== "object") continue;
    const pp = p as { type?: unknown; title?: unknown };
    if (typeof pp.type !== "string") continue;
    // Accept a few common aliases the LLM tends to emit despite the menu —
    // map them to the canonical plot types before validating.
    const aliases: Record<string, PlotType> = {
      "summary-card": "stats-card",
      pie: "donut",
      column: "bar",
      "geo-bubbles": "geo-map",
      "geo-bubble": "geo-map",
      "bubble-map": "geo-map",
      map: "geo-map",
      choropleth: "geo-map",
    };
    const t = (aliases[pp.type] ?? pp.type) as PlotType;
    if (!VALID_PLOT_TYPES.has(t)) continue;
    const title = typeof pp.title === "string" && pp.title.length > 0 ? pp.title : t;
    plots.push({ type: t, title });
    if (plots.length >= 3) break;
  }
  if (plots.length === 0) return null;
  return {
    plots,
    rationale: typeof r.rationale === "string" ? r.rationale : undefined,
  };
}

async function fetchDashboard(args: {
  meta: ColumnMeta;
  geoKind: GeoKind | null;
  filters: Filter[];
  sliceRows: number;
  totalRows: number;
  variant: number;
  previousTypes: PlotType[];
  signal: AbortSignal;
}): Promise<DashboardSpec> {
  const prompt = buildPickerPrompt(args);
  let buffer = "";
  let streamError: string | null = null;
  await streamOrchestrator(
    prompt,
    [],
    {
      onEvent: (e) => {
        if (e.kind === "message") buffer += e.payload.text;
        else if (e.kind === "error") streamError = e.payload.message;
      },
      onError: (e) => {
        streamError = e.message;
      },
    },
    { signal: args.signal },
  );
  if (args.signal.aborted) throw new Error("aborted");
  if (streamError) throw new Error(streamError);
  const parsed = extractFirstJson(buffer);
  const coerced = coerceDashboardSpec(parsed);
  if (!coerced) {
    throw new Error("could not parse a dashboard spec from the model reply");
  }
  // Force the contract: 3 plots, at least one chart, geo-map first if
  // geographic. enforceDashboardShape uses the heuristic to fill gaps so
  // the additions remain sensible for this column's type. Variant feeds
  // the heuristic's library rotation so any gap-fill on regenerate also
  // changes between attempts.
  return enforceDashboardShape(coerced, args.meta, args.geoKind, args.variant);
}

// ── plot renderers ──────────────────────────────────────────────────────────

const PLOT_HEIGHT = 150;

/** Span above which a day-per-cell calendar stops being readable in a
 *  150px-tall panel and we switch to the year × month grid. ~3 years. */
const CALENDAR_MAX_DAYS = 1100;

function categoricalCounts(meta: ColumnMeta, rows: Row[]): Array<{ value: string; count: number }> {
  // Prefer the precomputed top values from meta when present; otherwise
  // build counts from the rows (rare: meta with no topValues but rows).
  if (meta.topValues && meta.topValues.length > 0) return meta.topValues;
  const counts = new Map<string, number>();
  for (const r of rows) {
    const v = r[meta.name];
    if (v === null || v === "") continue;
    const k = String(v);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ value, count }));
}

function histogramBins(rows: Row[], col: string, nBins = 14): { x: string[]; y: number[] } {
  const nums = rows
    .map((r) => r[col])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return { x: [], y: [] };
  const mm = minMax(nums);
  if (!mm) return { x: [], y: [] };
  const { min, max } = mm;
  if (min === max) return { x: [formatNumber(min)], y: [nums.length] };
  const width = (max - min) / nBins;
  const counts = Array.from({ length: nBins }, () => 0);
  for (const v of nums) {
    let idx = Math.floor((v - min) / width);
    if (idx === nBins) idx = nBins - 1;
    counts[idx]++;
  }
  const x = Array.from({ length: nBins }, (_, i) => formatNumber(min + i * width));
  return { x, y: counts };
}

function PlotFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-border bg-bg p-2">
      <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-fg-dim">{title}</div>
      {children}
    </div>
  );
}

function HistogramPlot({
  meta,
  rows,
  palette,
}: {
  meta: ColumnMeta;
  rows: Row[];
  palette: Palette;
}) {
  const bins = useMemo(() => histogramBins(rows, meta.name, 14), [rows, meta.name]);
  const option = useMemo(
    () => ({
      animation: false,
      grid: { left: 30, right: 8, top: 8, bottom: 24 },
      xAxis: {
        type: "category",
        data: bins.x,
        axisLabel: { color: palette.fgMute, fontSize: 9, rotate: 30, interval: 1 },
        axisLine: { lineStyle: { color: palette.border } },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: palette.fgMute, fontSize: 9 },
        splitLine: { lineStyle: { color: palette.border } },
      },
      tooltip: { trigger: "axis", ...tooltipFrame(palette) },
      series: [
        {
          type: "bar",
          data: bins.y,
          itemStyle: { color: palette.primary },
          barCategoryGap: "20%",
        },
      ],
    }),
    [bins, palette],
  );
  return (
    <ReactECharts
      echarts={echarts}
      option={option}
      notMerge
      lazyUpdate
      style={{ height: PLOT_HEIGHT, width: "100%" }}
    />
  );
}

function BoxplotPlot({ meta, palette }: { meta: ColumnMeta; palette: Palette }) {
  const option = useMemo(() => {
    if (
      meta.q1 === undefined ||
      meta.q3 === undefined ||
      meta.median === undefined ||
      meta.boxLo === undefined ||
      meta.boxHi === undefined
    ) {
      return null;
    }
    const outliers = meta.outliers ?? [];
    // Loop over outliers instead of spreading — outlier counts scale with N.
    let xMin = meta.boxLo;
    let xMax = meta.boxHi;
    for (const v of outliers) {
      if (v < xMin) xMin = v;
      if (v > xMax) xMax = v;
    }
    const pad = (xMax - xMin) * 0.04 || 1;
    return {
      animation: false,
      grid: { left: 8, right: 8, top: 12, bottom: 20 },
      xAxis: {
        type: "value",
        min: xMin - pad,
        max: xMax + pad,
        axisLabel: { color: palette.fgMute, fontSize: 9 },
        axisLine: { lineStyle: { color: palette.border } },
        splitLine: { show: false },
      },
      yAxis: { type: "category", show: false, data: [""] },
      tooltip: { trigger: "item", ...tooltipFrame(palette) },
      series: [
        {
          type: "boxplot",
          data: [[meta.boxLo, meta.q1, meta.median, meta.q3, meta.boxHi]],
          itemStyle: {
            color: palette.primary,
            borderColor: palette.primary,
            borderWidth: 1,
          },
          boxWidth: ["50%", "70%"],
        },
        {
          name: "outliers",
          type: "scatter",
          data: outliers.map((v) => [v, 0]),
          symbolSize: 6,
          itemStyle: { color: palette.accent2, opacity: 0.85 },
        },
      ],
    };
  }, [meta, palette]);
  if (!option) {
    return <div className="text-[11px] text-fg-dim">no numeric values</div>;
  }
  return (
    <ReactECharts
      echarts={echarts}
      option={option}
      notMerge
      lazyUpdate
      style={{ height: PLOT_HEIGHT, width: "100%" }}
    />
  );
}

function DonutPlot({
  meta,
  rows,
  palette,
}: {
  meta: ColumnMeta;
  rows: Row[];
  palette: Palette;
}) {
  const counts = useMemo(() => categoricalCounts(meta, rows).slice(0, 8), [meta, rows]);
  const option = useMemo(
    () => ({
      animation: false,
      tooltip: {
        trigger: "item",
        ...tooltipFrame(palette),
        formatter: (params: { name?: string; value?: number; percent?: number }) =>
          `<b>${params.name}</b><br/>${params.value} (${(params.percent ?? 0).toFixed(1)}%)`,
      },
      legend: {
        type: "scroll",
        bottom: 0,
        textStyle: {
          color: palette.fgMute,
          fontSize: 9,
          fontFamily: "'SN Pro', 'Inter', sans-serif",
        },
        itemWidth: 8,
        itemHeight: 8,
      },
      series: [
        {
          type: "pie",
          radius: ["45%", "70%"],
          center: ["50%", "45%"],
          avoidLabelOverlap: true,
          itemStyle: { borderColor: palette.border, borderWidth: 1 },
          label: { show: false },
          data: counts.map((c, i) => ({
            name: c.value,
            value: c.count,
            itemStyle: { color: palette.categorical[i % palette.categorical.length] },
          })),
        },
      ],
    }),
    [counts, palette],
  );
  return (
    <ReactECharts
      echarts={echarts}
      option={option}
      notMerge
      lazyUpdate
      style={{ height: PLOT_HEIGHT, width: "100%" }}
    />
  );
}

function BarPlot({ meta, rows, palette }: { meta: ColumnMeta; rows: Row[]; palette: Palette }) {
  const counts = useMemo(() => categoricalCounts(meta, rows).slice(0, 8), [meta, rows]);
  // Reverse so the tallest bar is at the top of the y-axis (reads top-down).
  const reversed = useMemo(() => [...counts].reverse(), [counts]);
  const option = useMemo(
    () => ({
      animation: false,
      grid: { left: 8, right: 14, top: 4, bottom: 18, containLabel: true },
      xAxis: {
        type: "value",
        axisLabel: { color: palette.fgMute, fontSize: 9 },
        splitLine: { lineStyle: { color: palette.border } },
      },
      yAxis: {
        type: "category",
        data: reversed.map((c) => c.value),
        axisLabel: { color: palette.fgMute, fontSize: 10 },
        axisLine: { lineStyle: { color: palette.border } },
      },
      tooltip: { trigger: "axis", ...tooltipFrame(palette) },
      series: [
        {
          type: "bar",
          data: reversed.map((c) => c.count),
          itemStyle: { color: palette.primary },
          barWidth: "60%",
        },
      ],
    }),
    [reversed, palette],
  );
  return (
    <ReactECharts
      echarts={echarts}
      option={option}
      notMerge
      lazyUpdate
      style={{ height: PLOT_HEIGHT, width: "100%" }}
    />
  );
}

// ── date plots ──────────────────────────────────────────────────────────────

/** Volume over time, auto-binned (day → week → month → quarter → year) so the
 *  shape reads at any span. Gap-filled, so a period with no rows shows as a
 *  zero rather than being silently skipped — invisible gaps are exactly the
 *  kind of data problem this panel exists to surface. */
function DateTimelinePlot({
  meta,
  rows,
  palette,
}: { meta: ColumnMeta; rows: Row[]; palette: Palette }) {
  const { series, bin } = useMemo(() => {
    const { points } = collectDates(rows, meta.name);
    const summary = dateSummary(points);
    const b = summary ? summary.bin : "month";
    return { series: binSeries(points, b), bin: b };
  }, [meta.name, rows]);

  const option = useMemo(
    () => ({
      animation: false,
      grid: { left: 8, right: 12, top: 10, bottom: 18, containLabel: true },
      xAxis: {
        type: "category",
        data: series.map((s) => s.key),
        axisLabel: { color: palette.fgMute, fontSize: 9, hideOverlap: true },
        axisLine: { lineStyle: { color: palette.border } },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: palette.fgMute, fontSize: 9 },
        splitLine: { lineStyle: { color: palette.border } },
      },
      tooltip: {
        trigger: "axis",
        ...tooltipFrame(palette),
        formatter: (ps: Array<{ name?: string; value?: number }>) => {
          const p = ps[0];
          return `<b>${p?.name}</b><br/>${p?.value ?? 0} rows (per ${bin})`;
        },
      },
      series: [
        {
          type: "line",
          data: series.map((s) => s.count),
          smooth: false,
          symbol: series.length <= 60 ? "circle" : "none",
          symbolSize: 4,
          lineStyle: { color: palette.primary, width: 1.5 },
          itemStyle: { color: palette.primary },
          areaStyle: { color: palette.primary, opacity: 0.14 },
        },
      ],
    }),
    [series, bin, palette],
  );
  if (series.length === 0) return <EmptyPlotNote text="No parseable dates in this slice." />;
  return (
    <ReactECharts
      echarts={echarts}
      option={option}
      notMerge
      lazyUpdate
      style={{ height: PLOT_HEIGHT, width: "100%" }}
    />
  );
}

/** Coverage + density. Two renderings of the same idea, chosen by span:
 *   • ≤ ~3 years  → a true daily calendar heatmap (weekday structure and
 *     single-day gaps are visible at this resolution).
 *   • longer      → a year × month grid, which stays legible over decades
 *     where a daily calendar would be an unreadable ribbon. */
function DateCalendarPlot({
  meta,
  rows,
  palette,
}: { meta: ColumnMeta; rows: Row[]; palette: Palette }) {
  const model = useMemo(() => {
    const { points } = collectDates(rows, meta.name);
    const summary = dateSummary(points);
    if (!summary) return null;
    const daily = summary.spanDays <= CALENDAR_MAX_DAYS;
    return { points, summary, daily, grid: daily ? null : yearMonthGrid(points) };
  }, [meta.name, rows]);

  const option = useMemo(() => {
    if (!model) return null;
    const { summary } = model;
    if (model.daily) {
      const days = binSeries(model.points, "day");
      const max = days.reduce((m, d) => Math.max(m, d.count), 0);
      return {
        animation: false,
        tooltip: {
          ...tooltipFrame(palette),
          formatter: (p: { value?: [string, number] }) =>
            `<b>${p.value?.[0]}</b><br/>${p.value?.[1] ?? 0} rows`,
        },
        visualMap: {
          min: 0,
          max: Math.max(1, max),
          calculable: false,
          show: false,
          inRange: { color: [palette.border, palette.primary] },
        },
        calendar: {
          top: 18,
          left: 26,
          right: 8,
          cellSize: ["auto", 11],
          range: [summary.first, summary.last],
          itemStyle: { color: "transparent", borderColor: palette.border, borderWidth: 0.5 },
          splitLine: { lineStyle: { color: palette.border } },
          yearLabel: { show: true, color: palette.fgMute, fontSize: 9 },
          monthLabel: { color: palette.fgMute, fontSize: 9 },
          dayLabel: { color: palette.fgMute, fontSize: 8 },
        },
        series: [
          {
            type: "heatmap",
            coordinateSystem: "calendar",
            data: days.map((d) => [d.key, d.count]),
          },
        ],
      };
    }
    const grid = model.grid;
    if (!grid) return null;
    return {
      animation: false,
      grid: { left: 8, right: 12, top: 8, bottom: 18, containLabel: true },
      xAxis: {
        type: "category",
        data: MONTH_LABELS,
        axisLabel: { color: palette.fgMute, fontSize: 9 },
        axisLine: { lineStyle: { color: palette.border } },
        splitArea: { show: false },
      },
      yAxis: {
        type: "category",
        // Most recent year at the top, so the eye starts at "now".
        data: [...grid.years].reverse().map(String),
        axisLabel: { color: palette.fgMute, fontSize: 9 },
        axisLine: { lineStyle: { color: palette.border } },
      },
      visualMap: {
        min: 0,
        max: Math.max(1, grid.max),
        show: false,
        inRange: { color: [palette.border, palette.primary] },
      },
      tooltip: {
        ...tooltipFrame(palette),
        formatter: (p: { value?: [number, number, number] }) => {
          const v = p.value;
          if (!v) return "";
          const years = [...grid.years].reverse();
          return `<b>${MONTH_LABELS[v[0]]} ${years[v[1]]}</b><br/>${v[2]} rows`;
        },
      },
      series: [
        {
          type: "heatmap",
          data: grid.cells.map((c) => [
            c.month - 1,
            [...grid.years].reverse().indexOf(c.year),
            c.count,
          ]),
          itemStyle: { borderColor: palette.border, borderWidth: 0.5 },
          label: { show: false },
        },
      ],
    };
  }, [model, palette]);

  if (!option) return <EmptyPlotNote text="No parseable dates in this slice." />;
  return (
    <ReactECharts
      echarts={echarts}
      option={option}
      notMerge
      lazyUpdate
      style={{ height: PLOT_HEIGHT, width: "100%" }}
    />
  );
}

/** What repeats: month-of-year and day-of-week profiles side by side. These
 *  are invisible in a timeline — a column that only ever lands on weekdays,
 *  or spikes every January, looks unremarkable until the cycle is folded. */
function DateSeasonalityPlot({
  meta,
  rows,
  palette,
}: {
  meta: ColumnMeta;
  rows: Row[];
  palette: Palette;
}) {
  const { months, weekdays, total } = useMemo(() => {
    const { points } = collectDates(rows, meta.name);
    return {
      months: monthProfile(points),
      weekdays: weekdayProfile(points),
      total: points.length,
    };
  }, [meta.name, rows]);

  const option = useMemo(
    () => ({
      animation: false,
      // Two independent grids: months on the left, weekdays on the right.
      grid: [
        { left: 6, right: "54%", top: 18, bottom: 18, containLabel: true },
        { left: "52%", right: 8, top: 18, bottom: 18, containLabel: true },
      ],
      title: [
        {
          text: "by month",
          left: 6,
          top: 0,
          textStyle: { color: palette.fgMute, fontSize: 9, fontWeight: "normal" },
        },
        {
          text: "by weekday",
          left: "52%",
          top: 0,
          textStyle: { color: palette.fgMute, fontSize: 9, fontWeight: "normal" },
        },
      ],
      xAxis: [
        {
          gridIndex: 0,
          type: "category",
          data: MONTH_LABELS,
          axisLabel: { color: palette.fgMute, fontSize: 8, interval: 1 },
          axisLine: { lineStyle: { color: palette.border } },
        },
        {
          gridIndex: 1,
          type: "category",
          data: WEEKDAY_LABELS,
          axisLabel: { color: palette.fgMute, fontSize: 8, interval: 0 },
          axisLine: { lineStyle: { color: palette.border } },
        },
      ],
      yAxis: [
        {
          gridIndex: 0,
          type: "value",
          axisLabel: { color: palette.fgMute, fontSize: 8 },
          splitLine: { lineStyle: { color: palette.border } },
        },
        {
          gridIndex: 1,
          type: "value",
          axisLabel: { color: palette.fgMute, fontSize: 8 },
          splitLine: { lineStyle: { color: palette.border } },
        },
      ],
      tooltip: {
        trigger: "item",
        ...tooltipFrame(palette),
        formatter: (p: { name?: string; value?: number }) => {
          const pct = total > 0 ? ((100 * (p.value ?? 0)) / total).toFixed(1) : "0.0";
          return `<b>${p.name}</b><br/>${p.value ?? 0} rows (${pct}%)`;
        },
      },
      series: [
        {
          type: "bar",
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: months,
          itemStyle: { color: palette.primary },
          barWidth: "70%",
        },
        {
          type: "bar",
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: weekdays,
          itemStyle: { color: palette.accent2 },
          barWidth: "70%",
        },
      ],
    }),
    [months, weekdays, total, palette],
  );
  if (total === 0) return <EmptyPlotNote text="No parseable dates in this slice." />;
  return (
    <ReactECharts
      echarts={echarts}
      option={option}
      notMerge
      lazyUpdate
      style={{ height: PLOT_HEIGHT, width: "100%" }}
    />
  );
}

function EmptyPlotNote({ text }: { text: string }) {
  return (
    <div
      className="flex items-center justify-center text-[11px] text-fg-dim"
      style={{ height: PLOT_HEIGHT }}
    >
      {text}
    </div>
  );
}

function TreemapPlot({
  meta,
  rows,
  palette,
}: {
  meta: ColumnMeta;
  rows: Row[];
  palette: Palette;
}) {
  const counts = useMemo(() => categoricalCounts(meta, rows), [meta, rows]);
  const option = useMemo(
    () => ({
      animation: false,
      tooltip: {
        trigger: "item",
        ...tooltipFrame(palette),
        formatter: (params: { name?: string; value?: number }) =>
          `<b>${params.name}</b><br/>${params.value} rows`,
      },
      series: [
        {
          type: "treemap",
          roam: false,
          nodeClick: false,
          breadcrumb: { show: false },
          itemStyle: { borderColor: palette.border, borderWidth: 1, gapWidth: 1 },
          label: {
            show: true,
            color: palette.fg,
            fontSize: 10,
            fontFamily: "'SN Pro', 'Inter', sans-serif",
          },
          data: counts.map((c, i) => ({
            name: c.value,
            value: c.count,
            itemStyle: { color: palette.categorical[i % palette.categorical.length] },
          })),
        },
      ],
    }),
    [counts, palette],
  );
  return (
    <ReactECharts
      echarts={echarts}
      option={option}
      notMerge
      lazyUpdate
      style={{ height: PLOT_HEIGHT, width: "100%" }}
    />
  );
}

// Real 2D choropleth for any geographic column. Auto-detects which
// registered atlas to use (world / US / ZA) from the column's values via
// the same `detectMap` resolver as the chat's map renderer, aggregates row
// counts per canonical feature name, zero-fills the missing regions so
// every polygon still draws, then renders ECharts `series.type: "map"`.
function GeoMapPlot({
  meta,
  rows,
  palette,
}: {
  meta: ColumnMeta;
  rows: Row[];
  palette: Palette;
}) {
  const { mapKey, data, maxVal, unmatched } = useMemo(() => {
    // Sniff the registry against the raw values to pick the right atlas.
    const raw: string[] = [];
    for (const r of rows) {
      const v = r[meta.name];
      if (v === null || v === "") continue;
      raw.push(String(v));
    }
    const { mapKey, resolve } = detectMap(raw);

    const counts = new Map<string, number>();
    let unmatched = 0;
    for (const r of rows) {
      const v = r[meta.name];
      if (v === null || v === "") continue;
      const canonical = resolve(String(v));
      if (!canonical) {
        unmatched++;
        continue;
      }
      counts.set(canonical, (counts.get(canonical) ?? 0) + 1);
    }
    const data = featureNamesFor(mapKey).map((name) => ({
      name,
      value: counts.get(name) ?? 0,
    }));
    const maxVal = Math.max(1, ...data.map((d) => d.value));
    return { mapKey, data, maxVal, unmatched };
  }, [meta.name, rows]);

  const totalRows = rows.length;
  const option = useMemo(() => {
    const viewport = viewportFor(mapKey);
    return {
      animation: false,
      tooltip: {
        trigger: "item" as const,
        ...tooltipFrame(palette),
        formatter: (p: { name?: string; value?: number }) => {
          const v = typeof p.value === "number" ? p.value : 0;
          const pct = totalRows > 0 ? (100 * v) / totalRows : 0;
          return `<b>${p.name ?? ""}</b><br/>${v} rows (${pct.toFixed(1)}%)`;
        },
      },
      visualMap: {
        min: 0,
        max: maxVal,
        calculable: true,
        orient: "horizontal" as const,
        left: "center" as const,
        bottom: 0,
        itemWidth: 10,
        itemHeight: 60,
        textStyle: { color: palette.fgMute, fontSize: 9 },
        inRange: { color: [palette.border, palette.primary] },
      },
      series: [
        {
          type: "map" as const,
          map: mapKey,
          roam: true,
          center: viewport.center,
          zoom: viewport.zoom,
          aspectScale: viewport.aspectScale,
          label: {
            // 2-3 letter codes for US/ZA fit inside the polygon; world is
            // too crowded for labels — tooltip carries the name there.
            show: mapKey === "US" || mapKey === "ZA",
            fontSize: 9,
            fontFamily: "'SN Pro', 'Inter', sans-serif",
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
            areaColor: palette.border,
          },
          data,
        },
      ],
    };
  }, [mapKey, data, maxVal, palette, totalRows]);

  return (
    <div className="flex flex-col">
      <ReactECharts
        echarts={echarts}
        option={option}
        notMerge
        lazyUpdate
        style={{ height: PLOT_HEIGHT + 60, width: "100%" }}
      />
      {unmatched > 0 && (
        <p className="mt-1 px-1 font-mono text-[9px] text-fg-dim">
          {unmatched} row{unmatched === 1 ? "" : "s"} with unrecognised region — skipped.
        </p>
      )}
    </div>
  );
}

// Accent palette mirrors the Tools / Hard Data stat tiles so colours mean the
// same thing across the three workstations:
//   primary  → counts / foundation (rows, unique)
//   accent-2 → numeric data (numeric type badge, min/mean/median/max)
//   accent-3 → categorical data (string type badge, most-common value)
//   warn     → date columns; intermediate missing levels
//   error    → high missing
const STAT_ACCENTS = {
  primary: { wrap: "border-primary/60", bar: "bg-primary", label: "text-primary" },
  "accent-2": { wrap: "border-accent-2/60", bar: "bg-accent-2", label: "text-accent-2" },
  "accent-3": { wrap: "border-accent-3/60", bar: "bg-accent-3", label: "text-accent-3" },
  warn: { wrap: "border-warn/60", bar: "bg-warn", label: "text-warn" },
  error: { wrap: "border-error/60", bar: "bg-error", label: "text-error" },
} as const;
type StatAccent = keyof typeof STAT_ACCENTS;

function typeAccent(t: ColumnType): StatAccent {
  if (t === "number") return "accent-2";
  if (t === "date") return "warn";
  return "accent-3";
}

function missingAccent(pct: number): StatAccent {
  if (pct > 5) return "error";
  if (pct > 1) return "warn";
  return "primary";
}

function SummaryCard({ meta, rows = [] }: { meta: ColumnMeta; rows?: Row[] }) {
  const missingPct = meta.count > 0 ? (100 * meta.missing) / meta.count : 0;
  // Date columns previously showed only type/rows/unique/missing here —
  // every numeric tile below is number-guarded, so the headline card for a
  // date said nothing about WHEN the data covers.
  const dateStats = useMemo(
    () => (meta.type === "date" ? dateSummary(collectDates(rows, meta.name).points) : null),
    [meta.type, meta.name, rows],
  );
  return (
    <div className="flex flex-col gap-2 font-mono text-[11px]">
      <div className="grid grid-cols-2 gap-1">
        <Stat label="type" value={meta.type} accent={typeAccent(meta.type)} />
        <Stat label="rows" value={String(meta.count)} accent="primary" />
        <Stat label="unique" value={String(meta.unique)} accent="primary" />
        <Stat
          label="missing"
          value={`${meta.missing} (${missingPct.toFixed(1)}%)`}
          accent={missingAccent(missingPct)}
        />
        {meta.type === "number" && meta.min !== undefined && (
          <>
            <Stat label="min" value={formatNumber(meta.min)} accent="accent-2" />
            <Stat
              label="mean"
              value={meta.mean !== undefined ? formatNumber(meta.mean) : "—"}
              accent="accent-2"
            />
            <Stat
              label="median"
              value={meta.median !== undefined ? formatNumber(meta.median) : "—"}
              accent="accent-2"
            />
            <Stat
              label="max"
              value={meta.max !== undefined ? formatNumber(meta.max) : "—"}
              accent="accent-2"
            />
          </>
        )}
        {meta.type === "date" && dateStats && (
          <>
            <Stat label="first" value={dateStats.first} accent="warn" />
            <Stat label="last" value={dateStats.last} accent="warn" />
            <Stat label="span" value={describeSpan(dateStats.spanDays)} accent="warn" />
            <Stat
              label="busiest"
              value={`${dateStats.busiestKey} (${dateStats.busiestCount})`}
              accent="warn"
            />
            <Stat label="days covered" value={String(dateStats.uniqueDays)} accent="warn" />
            <Stat
              label="days with no rows"
              value={`${dateStats.emptyDays} (${
                dateStats.spanDays > 0
                  ? ((100 * dateStats.emptyDays) / dateStats.spanDays).toFixed(0)
                  : "0"
              }%)`}
              accent={dateStats.emptyDays > dateStats.uniqueDays ? "warn" : "primary"}
            />
          </>
        )}
        {meta.type === "string" && meta.topValues && meta.topValues.length > 0 && (
          <Stat
            label="most common"
            value={`${meta.topValues[0].value} (${meta.topValues[0].count})`}
            accent="accent-3"
          />
        )}
      </div>
      <QuintileStrip meta={meta} />
    </div>
  );
}

/** Quintile cut points, as their own block rather than four more tiles in the
 *  grid above. They answer a different question from the headline stats —
 *  "where does each fifth of the data end", not "what is this column" — and
 *  reading them left-to-right as a rising sequence is the point, which a
 *  two-column tile grid would break up. */
function QuintileStrip({ meta }: { meta: ColumnMeta }) {
  if (meta.type !== "number" || !meta.quintiles) return null;
  const [p20, p40, p60, p80] = meta.quintiles;
  const cuts: Array<{ label: string; value: number }> = [
    { label: "p20", value: p20 },
    { label: "p40", value: p40 },
    { label: "p60", value: p60 },
    { label: "p80", value: p80 },
  ];
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[9px] uppercase tracking-wider text-accent-2">quintiles</span>
        <span className="text-[9px] text-fg-dim" title="each cut point ends one fifth of the rows">
          cut points · 20% per bucket
        </span>
      </div>
      <div className="grid grid-cols-4 gap-1">
        {cuts.map((c) => (
          <div
            key={c.label}
            className="relative flex flex-col overflow-hidden rounded border border-accent-2/60 bg-bg-1 px-2 py-1 pl-2.5"
          >
            <span className="absolute inset-y-0 left-0 w-[3px] bg-accent-2" />
            <span className="text-[9px] uppercase tracking-wider text-accent-2">{c.label}</span>
            <span className="truncate text-fg">{formatNumber(c.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: StatAccent }) {
  const tone = accent ? STAT_ACCENTS[accent] : null;
  const wrapCls = tone ? tone.wrap : "border-border";
  const barCls = tone ? tone.bar : "bg-border";
  const labelCls = tone ? tone.label : "text-fg-dim";
  return (
    <div
      className={`relative flex flex-col overflow-hidden rounded border ${wrapCls} bg-bg-1 px-2 py-1 pl-2.5`}
    >
      <span className={`absolute inset-y-0 left-0 w-[3px] ${barCls}`} />
      <span className={`text-[9px] uppercase tracking-wider ${labelCls}`}>{label}</span>
      <span className="truncate text-fg">{value}</span>
    </div>
  );
}

function renderPlot({
  spec,
  meta,
  rows,
  palette,
}: {
  spec: PlotSpec;
  meta: ColumnMeta;
  rows: Row[];
  palette: Palette;
}) {
  switch (spec.type) {
    case "histogram":
      return <HistogramPlot meta={meta} rows={rows} palette={palette} />;
    case "boxplot":
      return <BoxplotPlot meta={meta} palette={palette} />;
    case "donut":
      return <DonutPlot meta={meta} rows={rows} palette={palette} />;
    case "bar":
      return <BarPlot meta={meta} rows={rows} palette={palette} />;
    case "treemap":
      return <TreemapPlot meta={meta} rows={rows} palette={palette} />;
    case "geo-map":
      return <GeoMapPlot meta={meta} rows={rows} palette={palette} />;
    case "stats-card":
      return <SummaryCard meta={meta} rows={rows} />;
    case "date-timeline":
      return <DateTimelinePlot meta={meta} rows={rows} palette={palette} />;
    case "date-calendar":
      return <DateCalendarPlot meta={meta} rows={rows} palette={palette} />;
    case "date-seasonality":
      return <DateSeasonalityPlot meta={meta} rows={rows} palette={palette} />;
    default:
      return null;
  }
}

// ── main component ──────────────────────────────────────────────────────────

export function SmartColumnDashboard({
  meta,
  rows,
  filters,
  totalRows,
}: {
  meta: ColumnMeta;
  rows: Row[]; // rows of the current filter slice
  filters: Filter[];
  totalRows: number;
}) {
  const palette = usePalette();
  const geoKind = useMemo(() => detectGeoKind(meta), [meta]);

  const [regenSeed, setRegenSeed] = useState(0);

  // Fallback rotates by regenSeed too, so even if the LLM is unreachable the
  // user sees a visibly different mix when they hit regenerate.
  const fallback = useMemo(
    () =>
      enforceDashboardShape(heuristicDashboard(meta, geoKind, regenSeed), meta, geoKind, regenSeed),
    [meta, geoKind, regenSeed],
  );

  const [spec, setSpec] = useState<DashboardSpec>(fallback);
  const [fromAI, setFromAI] = useState<boolean>(false);
  const [status, setStatus] = useState<"loading" | "ready" | "fallback">("loading");

  // The LLM is stateless, so we tell it explicitly what it picked last time
  // and forbid reuse. Reset when the column changes (each column gets its
  // own regenerate trail).
  const previousTypesRef = useRef<PlotType[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — reset only when column identity changes.
  useEffect(() => {
    previousTypesRef.current = [];
    setRegenSeed(0);
  }, [meta.name]);

  // Stable filter signature so the effect re-fires only when filters change
  // in a meaningful way (not on render-identity churn).
  const filtersSig = useMemo(() => filters.map((f) => describeFilter(f)).join("|"), [filters]);

  // Row count for the slice that the LLM should reason about. We pass the
  // rows filtered by OTHER columns (so the column's own filter doesn't
  // collapse its own picture), mirroring the chart-meta convention.
  const sliceRows = useMemo(() => {
    const others = filters.filter((f) => f.column !== meta.name);
    return others.length === 0 ? totalRows : applyFilters(rows, others).length;
    // We deliberately use rows.length (already-filtered) — applyFilters
    // narrows again to be safe but the caller passes the slice already.
  }, [filters, meta.name, totalRows, rows]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: filters identity captured via signature; previousTypes is a ref intentionally not in deps.
  useEffect(() => {
    const ac = new AbortController();
    setStatus("loading");
    fetchDashboard({
      meta,
      geoKind,
      filters,
      sliceRows,
      totalRows,
      variant: regenSeed,
      previousTypes: previousTypesRef.current,
      signal: ac.signal,
    })
      .then((s) => {
        if (ac.signal.aborted) return;
        setSpec(s);
        setFromAI(true);
        setStatus("ready");
        previousTypesRef.current = s.plots.map((p) => p.type);
      })
      .catch(() => {
        if (ac.signal.aborted) return;
        setSpec(fallback);
        setFromAI(false);
        setStatus("fallback");
        previousTypesRef.current = fallback.plots.map((p) => p.type);
      });
    return () => ac.abort();
  }, [meta.name, filtersSig, regenSeed, geoKind, fallback, sliceRows, totalRows]);

  const regenerate = useCallback(() => setRegenSeed((s) => s + 1), []);

  const missingPct = meta.count > 0 ? (100 * meta.missing) / meta.count : 0;

  return (
    // shrink-0: this is a flex item of the panel's scrolling column, and a
    // flex column shrinks its items before the container scrolls. Without it
    // the dashboard (and anything inside it that hides overflow) can be
    // compressed instead of scrolled — the same trap that used to slice the
    // header above in half.
    <div className="flex shrink-0 flex-col gap-3 p-3">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[9px] uppercase tracking-wider text-fg-dim">
              {meta.type}
            </span>
            <span className="truncate font-mono text-sm text-fg">{meta.name}</span>
            {geoKind && (
              <span className="rounded border border-accent-3/40 px-1 font-mono text-[9px] text-accent-3">
                geo
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-fg-mute">
            {meta.count - meta.missing} of {meta.count} rows · {meta.unique} unique
            {missingPct > 0 ? ` · ${missingPct.toFixed(1)}% missing` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={regenerate}
          disabled={status === "loading"}
          className="shrink-0 rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[10px] text-fg-mute hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
          title="Ask the model for a different mix of plots"
        >
          {status === "loading" ? "studying…" : "regenerate"}
        </button>
      </header>

      <div className="flex flex-col gap-2">
        {spec.plots.map((p, i) => (
          <PlotFrame key={`${p.type}-${i}-${meta.name}`} title={p.title}>
            {renderPlot({ spec: p, meta, rows, palette })}
          </PlotFrame>
        ))}
      </div>

      {spec.rationale && (
        <div className="rounded border border-border bg-bg-1 px-2 py-1.5">
          <div className="font-mono text-[9px] uppercase tracking-wider text-fg-dim">
            {fromAI ? "ai rationale" : "fallback rationale"}
          </div>
          <p className="text-[11px] text-fg-mute">{spec.rationale}</p>
          {!fromAI && status === "fallback" && (
            <p className="mt-1 text-[10px] text-fg-dim">
              The model didn't return a usable spec; using a local heuristic. Try regenerate.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
