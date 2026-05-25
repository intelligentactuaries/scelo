import type { ChartSpec } from "@/lib/api";

type ChartOption = ChartSpec["option"];
type PlainObject = Record<string, unknown>;

const COLORS = {
  bg: "#0d0d0d",
  fg: "#e8e8e8",
  fgMute: "#9a9a9a",
  fgDim: "#6c6c6c",
  border: "#2a2a2a",
};

const FONT_FAMILY = "'JetBrains Mono', monospace";

// Server-generated chart specs occasionally ship `tooltip.formatter`
// callbacks as JavaScript source strings (the FastAPI side ships JSON
// only, so functions can't survive the transport). ECharts treats string
// formatters as templates, so without this rehydration the tooltip would
// render the raw function source as literal text on hover (IA-174).
// Specs are produced exclusively by our trusted backend; using `Function`
// here is intentional and bounded.
const FUNCTION_STRING_RE = /^\s*function\s*\(/;

type EChartsFormatter = (
  params: unknown,
  ticket?: string,
  callback?: (ticket: string, html: string) => void,
) => string;

function rehydrateFormatter(value: unknown): unknown {
  if (typeof value !== "string" || !FUNCTION_STRING_RE.test(value)) return value;
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`return (${value})`)() as EChartsFormatter;
    return typeof fn === "function" ? fn : value;
  } catch {
    return value;
  }
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeDeep(base: PlainObject, override: PlainObject): PlainObject {
  const out: PlainObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? mergeDeep(existing, value) : value;
  }
  return out;
}

function normalizeOneAxis(axis: unknown): unknown {
  if (!isPlainObject(axis)) return axis;

  const type = axis.type === "value" || axis.type === "log" ? axis.type : "category";
  const showValueGrid = type === "value" || type === "log";
  const normalized = mergeDeep(
    {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: COLORS.fgDim, fontSize: 10 },
      splitLine: {
        show: showValueGrid,
        lineStyle: { color: COLORS.border, opacity: 0.28, width: 1 },
      },
      nameTextStyle: { color: COLORS.fgMute, fontSize: 11 },
    },
    axis,
  );

  return mergeDeep(normalized, {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: COLORS.fgDim, fontSize: 10 },
    nameTextStyle: { color: COLORS.fgMute, fontSize: 11 },
  });
}

function normalizeAxis(axis: unknown): unknown {
  if (Array.isArray(axis)) return axis.map(normalizeOneAxis);
  return normalizeOneAxis(axis);
}

function normalizeOneVisualMap(visualMap: unknown): unknown {
  if (!isPlainObject(visualMap)) return visualMap;
  const merged = mergeDeep(
    {
      textStyle: { color: COLORS.fgDim, fontSize: 10 },
      handleStyle: { color: COLORS.fgMute, borderColor: COLORS.border },
      borderColor: "transparent",
    },
    visualMap,
  );
  if ("formatter" in merged) {
    merged.formatter = rehydrateFormatter(merged.formatter);
  }
  return merged;
}

function normalizeVisualMap(visualMap: unknown): unknown {
  if (Array.isArray(visualMap)) return visualMap.map(normalizeOneVisualMap);
  return normalizeOneVisualMap(visualMap);
}

function normalizeOneSeries(series: unknown): unknown {
  if (!isPlainObject(series)) return series;

  const type = typeof series.type === "string" ? series.type : "";
  const defaultsByType: Record<string, PlainObject> = {
    line: {
      showSymbol: false,
      symbolSize: 4,
      lineStyle: { width: 2 },
      emphasis: { focus: "series" },
    },
    bar: {
      barMaxWidth: 34,
      itemStyle: { borderRadius: 2 },
      emphasis: { focus: "series" },
    },
    scatter: {
      symbolSize: 8,
      itemStyle: { opacity: 0.84 },
      emphasis: { scale: true, focus: "series" },
    },
    heatmap: {
      progressive: 1000,
      itemStyle: { borderWidth: 0 },
      emphasis: { itemStyle: { shadowBlur: 6, shadowColor: "rgba(0,214,143,0.35)" } },
    },
    tree: {
      symbolSize: 7,
      lineStyle: { color: COLORS.border, width: 1 },
      label: { color: COLORS.fg, fontSize: 11 },
      leaves: { label: { color: COLORS.fgMute, fontSize: 10 } },
      emphasis: { focus: "descendant" },
    },
  };

  return mergeDeep(defaultsByType[type] ?? {}, series);
}

function normalizeSeries(series: unknown): unknown {
  if (Array.isArray(series)) return series.map(normalizeOneSeries);
  return normalizeOneSeries(series);
}

export function prepareChartOption(option: ChartOption): ChartOption {
  const base = mergeDeep(
    {
      backgroundColor: COLORS.bg,
      color: ["#00d68f", "#ffb454", "#ff6b6b", "#7aa2f7", "#bb9af7"],
      textStyle: { color: COLORS.fg, fontFamily: FONT_FAMILY },
      title: {
        left: 12,
        top: 8,
        textStyle: { color: COLORS.fg, fontSize: 12, fontWeight: "normal" },
        subtextStyle: { color: COLORS.fgDim, fontSize: 10 },
        itemGap: 4,
      },
      legend: {
        type: "scroll",
        icon: "rect",
        itemWidth: 12,
        itemHeight: 8,
        itemGap: 14,
        pageIconColor: COLORS.fgMute,
        pageIconInactiveColor: COLORS.border,
        pageTextStyle: { color: COLORS.fgDim },
        textStyle: { color: COLORS.fgMute, fontSize: 11 },
      },
      tooltip: {
        confine: true,
        backgroundColor: "#161616",
        borderColor: COLORS.border,
        borderWidth: 1,
        padding: [8, 10],
        textStyle: { color: COLORS.fg, fontSize: 11 },
        extraCssText: "box-shadow:0 10px 24px rgba(0,0,0,0.32);",
      },
      grid: { left: 56, right: 24, top: 56, bottom: 48, containLabel: true },
    },
    option,
  );

  if ("xAxis" in base) base.xAxis = normalizeAxis(base.xAxis);
  if ("yAxis" in base) base.yAxis = normalizeAxis(base.yAxis);
  if ("visualMap" in base) base.visualMap = normalizeVisualMap(base.visualMap);
  if ("series" in base) base.series = normalizeSeries(base.series);
  if ("tooltip" in base && isPlainObject(base.tooltip) && "formatter" in base.tooltip) {
    base.tooltip = { ...base.tooltip, formatter: rehydrateFormatter(base.tooltip.formatter) };
  }
  if ("series" in base && Array.isArray(base.series)) {
    base.series = (base.series as unknown[]).map((s) => {
      if (!isPlainObject(s)) return s;
      const out: PlainObject = { ...s };
      if ("tooltip" in out && isPlainObject(out.tooltip) && "formatter" in out.tooltip) {
        out.tooltip = { ...out.tooltip, formatter: rehydrateFormatter(out.tooltip.formatter) };
      }
      if ("label" in out && isPlainObject(out.label) && "formatter" in out.label) {
        out.label = { ...out.label, formatter: rehydrateFormatter(out.label.formatter) };
      }
      return out;
    });
  }

  return base;
}
