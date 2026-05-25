// The single chart component. All charts on the web side go through this.
// Imports `echarts/core` plus the chart/component/renderer registries we
// actually use, so the bundle stays small.

import type { ChartSpec } from "@/lib/api";
import { prepareChartOption } from "@/lib/echarts/options";
import { IA_DARK_NAME, IA_LIGHT_NAME } from "@/lib/echarts/theme";
import { useTheme } from "@/lib/theme";
import ReactECharts from "echarts-for-react";
import {
  BarChart,
  GaugeChart,
  HeatmapChart,
  LineChart,
  PieChart,
  ScatterChart,
  TreeChart,
} from "echarts/charts";
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { type ReactNode, useEffect, useState } from "react";

echarts.use([
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  VisualMapComponent,
  DataZoomComponent,
  BarChart,
  GaugeChart,
  LineChart,
  PieChart,
  HeatmapChart,
  ScatterChart,
  TreeChart,
  CanvasRenderer,
]);

type Props = {
  spec: ChartSpec;
  expandedSpec?: ChartSpec;
  overlay?: ReactNode;
  className?: string;
};

export function EChart({ spec, expandedSpec, overlay, className }: Props) {
  const { resolved } = useTheme();
  const themeName = resolved === "light" ? IA_LIGHT_NAME : IA_DARK_NAME;
  const [expanded, setExpanded] = useState(false);
  const fullSpec = expandedSpec ?? spec;

  useEffect(() => {
    if (!expanded) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setExpanded(false);
    }
    document.addEventListener("keydown", onKey);
    // Lock background scroll while the fullscreen overlay is open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [expanded]);

  const chart = (
    <ReactECharts
      // The `key` forces ECharts to re-mount when the theme switches —
      // theme can't be changed on a live instance, so a remount is the
      // simplest way to apply the new colours.
      key={themeName}
      echarts={echarts}
      theme={themeName}
      option={prepareChartOption(spec.option)}
      notMerge
      lazyUpdate
      style={{ height: "100%", width: "100%" }}
    />
  );

  return (
    <div className={`relative group ${className ?? ""}`}>
      {chart}
      {overlay && <div className="pointer-events-none absolute inset-0">{overlay}</div>}
      <button
        type="button"
        aria-label="Expand chart"
        title="Expand chart"
        onClick={() => setExpanded(true)}
        className="absolute top-2 right-2 z-10 flex h-7 w-7 items-center justify-center rounded border border-border bg-bg-1/80 text-fg-mute opacity-0 backdrop-blur-sm transition-opacity hover:bg-bg-2 hover:text-fg group-hover:opacity-100 focus:opacity-100"
      >
        <ExpandIcon />
      </button>

      {expanded && (
        <div
          aria-label={fullSpec.title ?? "Expanded chart"}
          className="fixed inset-0 z-50 flex flex-col bg-bg/95 backdrop-blur-sm"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <span className="truncate text-sm text-fg-mute">{fullSpec.title ?? "Chart"}</span>
            <button
              type="button"
              aria-label="Close expanded chart"
              title="Close (Esc)"
              onClick={() => setExpanded(false)}
              className="flex h-8 w-8 items-center justify-center rounded border border-border text-fg-mute hover:bg-bg-2 hover:text-fg"
            >
              <CloseIcon />
            </button>
          </div>
          <div className="flex-1 p-4">
            <ReactECharts
              key={`${themeName}-expanded`}
              echarts={echarts}
              theme={themeName}
              option={prepareChartOption(fullSpec.option)}
              notMerge
              lazyUpdate
              style={{ height: "100%", width: "100%" }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ExpandIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="M21 3l-7 7" />
      <path d="M3 21l7-7" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6L6 18" />
      <path d="M6 6l12 12" />
    </svg>
  );
}
