// Categorical breakdown — half-doughnut.
//
// Replaces the stacked proportion bar that used to render every categorical
// split in the IDE (treatment uptake, spending response, council trust,
// society sentiment). One component, every call site, so the four surfaces
// keep reading as one instrument.
//
// Geometry is the ECharts half-doughnut: radius ['40%','70%'], centred at
// ['50%','70%'] with startAngle 180 → endAngle 360, which draws the upper
// arch and leaves the lower half of the box empty. `endAngle` needs ECharts
// ≥ 5.5 (this repo is on 5.6).
//
// Labelling is width-driven rather than fixed, and the legend is the fallback
// rather than a fixture. The chart appears both in the wide two-up Simulation
// panel and in the narrow Society inspector: wide enough, and each slice
// labels itself with its own name and share; too narrow, and outside labels
// with leader lines overlap into a smear, so the legend carries the names
// instead. Exactly one of the two is ever on — running both showed every
// category twice. Measuring rather than taking a prop means the chart can move
// between surfaces without a caller having to remember to re-tune it.

import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { PieChart } from 'echarts/charts';
import { LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { colorsForTheme } from '../../shared/constants';
import { useTheme } from '../lib/theme';

echarts.use([PieChart, LegendComponent, TooltipComponent, CanvasRenderer]);

const MONO = "'JetBrains Mono', ui-monospace, monospace";

/** Below this the arch has no room for outside labels beside it. */
const LABEL_MIN_WIDTH = 340;

export interface DonutSlice {
  name: string;
  value: number;
  color: string;
}

/**
 * @param name  Series name — the tooltip's header.
 * @param data  Slices in display order. Zero-valued slices stay in the legend
 *              so a category at 0% is visibly 0, not silently absent.
 */
export function HalfDonut({ name, data }: { name: string; data: DonutSlice[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const [width, setWidth] = useState(0);
  const { resolved } = useTheme();
  const colors = colorsForTheme(resolved);
  const total = data.reduce((s, d) => s + (d.value || 0), 0);
  const showLabels = width >= LABEL_MIN_WIDTH;

  const option = useMemo(() => {
    const pct = (v: number) => (total > 0 ? Math.round((v / total) * 100) : 0);
    const byName = new Map(data.map((d) => [d.name, d]));
    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        textStyle: { fontFamily: MONO, fontSize: 12 },
        valueFormatter: (v: number) => `${v} (${pct(v)}%)`,
      },
      legend: {
        // Only when the slices cannot label themselves. With labels on, the
        // legend repeats every name and percentage already sitting on the
        // arch — two of the same reading, and the duplicate is the one that
        // costs vertical space.
        show: !showLabels,
        top: '5%',
        left: 'center',
        // Every category appears, including the ones sitting at zero.
        data: data.map((d) => d.name),
        icon: 'circle',
        itemWidth: 9,
        itemHeight: 9,
        textStyle: { fontFamily: MONO, fontSize: 12, color: colors.fg },
        formatter: (label: string) => `${label} ${pct(byName.get(label)?.value ?? 0)}%`,
      },
      series: [
        {
          name,
          type: 'pie',
          radius: ['40%', '70%'],
          center: ['50%', '70%'],
          // Draw the upper arch only.
          startAngle: 180,
          endAngle: 360,
          label: {
            show: showLabels,
            formatter: '{b}\n{d}%',
            fontFamily: MONO,
            fontSize: 12,
            color: colors.fg,
            lineHeight: 16,
          },
          labelLine: {
            show: showLabels,
            length: 14,
            length2: 16,
            lineStyle: { color: colors.muted },
          },
          itemStyle: { borderWidth: 0 },
          emphasis: { scaleSize: 6 },
          data: data
            .filter((d) => (d.value || 0) > 0)
            .map((d) => ({ name: d.name, value: d.value, itemStyle: { color: d.color } })),
        },
      ],
    };
  }, [name, data, total, showLabels, colors.fg, colors.muted]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const inst = echarts.init(el, null, { renderer: 'canvas' });
    chartRef.current = inst;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => {
      inst.resize();
      setWidth(el.clientWidth);
    });
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

  if (total <= 0) {
    return <div className="donut-empty muted small">no data</div>;
  }
  return <div ref={ref} className="donut-chart" />;
}
