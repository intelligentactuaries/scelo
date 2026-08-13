// Categorical bar chart — the distributional counterpart to HalfDonut.
//
// A doughnut answers "what share of the whole"; a bar answers "how does this
// compare across categories", which is what every table it replaces was
// actually being read for. Eight rows of `age band | workdays lost` make you
// compare eight numbers by eye; eight bars put the comparison on the page.
//
// Same conventions as the rest of the IDE's charts: tree-shaken echarts/core,
// theme colours resolved before they reach the canvas (a canvas renderer
// cannot read `var(--consensus)`), JetBrains Mono throughout.

import { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart as EBarChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { colorsForTheme } from '../../shared/constants';
import { useTheme } from '../lib/theme';

echarts.use([EBarChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

const MONO = "'JetBrains Mono', ui-monospace, monospace";

export interface BarSeries {
  name: string;
  color: string;
  data: number[];
}

export function BarChart({
  categories,
  series,
  stacked = false,
  horizontal = false,
  height = 240,
  format = (v: number) => v.toLocaleString(),
}: {
  categories: string[];
  series: BarSeries[];
  /** Stack the series into one bar per category — for parts of a whole. */
  stacked?: boolean;
  /** Categories down the left instead of along the bottom. Right for long
   *  labels ("with comorbidities") and for a handful of categories. */
  horizontal?: boolean;
  height?: number;
  format?: (v: number) => string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const { resolved } = useTheme();
  const colors = colorsForTheme(resolved);

  const option = useMemo(() => {
    const catAxis = {
      type: 'category' as const,
      data: categories,
      axisLabel: { fontFamily: MONO, fontSize: 11, color: colors.fgMute },
      axisLine: { lineStyle: { color: colors.grid } },
      axisTick: { show: false },
    };
    const valAxis = {
      type: 'value' as const,
      axisLabel: { fontFamily: MONO, fontSize: 11, color: colors.fgMute, formatter: format },
      splitLine: { lineStyle: { color: colors.grid } },
      axisLine: { show: false },
    };
    return {
      backgroundColor: 'transparent',
      grid: { left: 6, right: 14, top: series.length > 1 ? 34 : 12, bottom: 4, containLabel: true },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        textStyle: { fontFamily: MONO, fontSize: 12 },
        valueFormatter: format,
      },
      // One series needs no legend — its name is the panel label above it.
      legend:
        series.length > 1
          ? {
              top: 0,
              left: 'center',
              icon: 'circle',
              itemWidth: 9,
              itemHeight: 9,
              textStyle: { fontFamily: MONO, fontSize: 11, color: colors.fg },
            }
          : { show: false },
      xAxis: horizontal ? valAxis : catAxis,
      // A horizontal category axis reads top-down only if it is inverted;
      // ECharts otherwise puts the first category at the bottom.
      yAxis: horizontal ? { ...catAxis, inverse: true } : valAxis,
      series: series.map((s) => ({
        name: s.name,
        type: 'bar' as const,
        stack: stacked ? 'total' : undefined,
        color: s.color,
        barMaxWidth: horizontal ? 26 : 42,
        itemStyle: { borderRadius: horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0] },
        emphasis: { focus: 'series' as const },
        data: s.data,
      })),
    };
  }, [categories, series, stacked, horizontal, format, colors.fg, colors.fgMute, colors.grid]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const inst = echarts.init(el, null, { renderer: 'canvas' });
    chartRef.current = inst;
    const ro = new ResizeObserver(() => inst.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      inst.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option as echarts.EChartsCoreOption, {
      notMerge: true,
      lazyUpdate: true,
    });
  }, [option]);

  // Only an absent axis is "no data". An all-zero distribution is a finding —
  // nobody lost a workday — and rendering flat bars against a zero axis says
  // so, where a "no data" placeholder would claim the run never measured it.
  if (categories.length === 0 || series.length === 0) {
    return <div className="donut-empty muted small">no data</div>;
  }
  return <div ref={ref} style={{ width: '100%', height }} />;
}
