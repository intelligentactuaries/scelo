// IA chart themes — registered once at app boot. <EChart> picks the right
// theme name based on the resolved app theme.

import * as echarts from "echarts/core";

export const IA_DARK_NAME = "ia-dark";
export const IA_LIGHT_NAME = "ia-light";

const PALETTE_DARK = ["#00d68f", "#ffb454", "#ff6b6b", "#7aa2f7", "#bb9af7"];
const PALETTE_LIGHT = ["#009669", "#a86614", "#b73a3a", "#3760cc", "#7649c7"];

type ThemeColors = {
  bg: string;
  fg: string;
  fgMute: string;
  fgDim: string;
  border: string;
  splitOpacity: number;
  shadow: string;
};

const DARK: ThemeColors = {
  bg: "#0d0d0d",
  fg: "#e8e8e8",
  fgMute: "#9a9a9a",
  fgDim: "#6c6c6c",
  border: "#2a2a2a",
  splitOpacity: 0.28,
  shadow: "0 10px 24px rgba(0,0,0,0.32)",
};

const LIGHT: ThemeColors = {
  bg: "#ffffff",
  fg: "#181818",
  fgMute: "#5c5c5a",
  fgDim: "#8a8a86",
  border: "#dcdad5",
  splitOpacity: 0.6,
  shadow: "0 6px 18px rgba(0,0,0,0.06)",
};

function buildTheme(palette: string[], c: ThemeColors): Record<string, unknown> {
  return {
    color: palette,
    backgroundColor: c.bg,
    textStyle: { color: c.fg, fontFamily: "'JetBrains Mono', monospace" },
    title: {
      left: 12,
      top: 8,
      itemGap: 4,
      textStyle: { color: c.fg, fontSize: 12, fontWeight: "normal" },
      subtextStyle: { color: c.fgDim, fontSize: 10 },
    },
    line: {
      itemStyle: { borderWidth: 0 },
      lineStyle: { width: 2 },
      symbolSize: 4,
      showSymbol: false,
    },
    bar: { itemStyle: { borderWidth: 0, borderRadius: 2 }, barMaxWidth: 34 },
    scatter: { itemStyle: { opacity: 0.84 }, symbolSize: 8 },
    heatmap: { itemStyle: { borderWidth: 0 } },
    legend: {
      icon: "rect",
      itemWidth: 12,
      itemHeight: 8,
      itemGap: 14,
      textStyle: { color: c.fgMute, fontSize: 11 },
    },
    tooltip: {
      confine: true,
      backgroundColor: c.bg,
      borderColor: c.border,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: c.fg, fontSize: 11 },
      extraCssText: `box-shadow:${c.shadow};`,
    },
    categoryAxis: {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: c.fgDim, fontSize: 10 },
      splitLine: { show: false },
      nameTextStyle: { color: c.fgMute, fontSize: 11 },
    },
    valueAxis: {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: c.fgDim, fontSize: 10 },
      splitLine: {
        show: true,
        lineStyle: { color: c.border, opacity: c.splitOpacity, width: 1 },
      },
      nameTextStyle: { color: c.fgMute, fontSize: 11 },
    },
    logAxis: {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: c.fgDim, fontSize: 10 },
      splitLine: {
        show: true,
        lineStyle: { color: c.border, opacity: c.splitOpacity, width: 1 },
      },
      nameTextStyle: { color: c.fgMute, fontSize: 11 },
    },
  };
}

export function registerIATheme(): void {
  echarts.registerTheme(IA_DARK_NAME, buildTheme(PALETTE_DARK, DARK));
  echarts.registerTheme(IA_LIGHT_NAME, buildTheme(PALETTE_LIGHT, LIGHT));
}
