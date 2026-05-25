// Bun's test runner. We test the chart spec contract (the React component
// itself needs a DOM and is exercised manually in dev — Phase 1 doesn't
// install jsdom).

import { describe, expect, test } from "bun:test";
import type { ChartSpec } from "@/lib/api";
import { prepareChartOption } from "@/lib/echarts/options";

describe("ChartSpec contract", () => {
  test("a valid spec carries the IA wrapper fields", () => {
    const spec: ChartSpec = {
      $id: "test.v1",
      $version: 1,
      title: "test",
      data_hash: "sha256-deadbeef",
      option: { series: [] },
    };
    expect(spec.$version).toBe(1);
    expect(spec.$id).toMatch(/\.v\d+$/);
    expect(spec.data_hash.startsWith("sha256-")).toBe(true);
  });

  test("render options get minimal professional defaults", () => {
    const option = prepareChartOption({
      xAxis: { type: "category", data: ["A"], axisLabel: { rotate: 20 } },
      yAxis: { type: "value", axisLabel: { formatter: "{value}%" } },
      series: [
        { type: "line", data: [1, 2, 3], showSymbol: true },
        { type: "bar", data: [1, 2, 3] },
      ],
    });

    expect(option.backgroundColor).toBe("#0d0d0d");
    expect((option.xAxis as Record<string, unknown>).axisLine).toEqual({ show: false });
    expect((option.yAxis as Record<string, unknown>).axisTick).toEqual({ show: false });
    expect(
      ((option.xAxis as Record<string, unknown>).axisLabel as Record<string, unknown>).rotate,
    ).toBe(20);
    expect(
      ((option.series as Record<string, unknown>[])[0] as Record<string, unknown>).showSymbol,
    ).toBe(true);
    expect(
      (
        ((option.series as Record<string, unknown>[])[1] as Record<string, unknown>)
          .itemStyle as Record<string, unknown>
      ).borderRadius,
    ).toBe(2);
  });

  // IA-174: server-side ChartSpecs ship `tooltip.formatter` as JS source
  // strings (FastAPI can't serialize functions over JSON). Without
  // rehydration ECharts treats them as templates and the function source
  // appears as raw text on hover.
  test("tooltip.formatter strings are rehydrated to callable functions", () => {
    const option = prepareChartOption({
      tooltip: {
        formatter: "function(p) { return 'value=' + p.value[2]; }",
      },
      series: [{ type: "heatmap", data: [[0, 0, 42]] }],
    });
    const tooltip = option.tooltip as Record<string, unknown>;
    expect(typeof tooltip.formatter).toBe("function");
    const fn = tooltip.formatter as (p: { value: number[] }) => string;
    expect(fn({ value: [0, 0, 42] })).toBe("value=42");
  });

  test("tooltip template strings are left untouched", () => {
    const option = prepareChartOption({
      tooltip: { formatter: "{a}: {c}" },
      series: [{ type: "line", data: [1, 2, 3] }],
    });
    const tooltip = option.tooltip as Record<string, unknown>;
    expect(tooltip.formatter).toBe("{a}: {c}");
  });

  test("series-level tooltip and label formatters are rehydrated", () => {
    const option = prepareChartOption({
      series: [
        {
          type: "scatter",
          data: [[1, 2]],
          tooltip: { formatter: "function(p) { return 'pt:' + p.value[0]; }" },
          label: { formatter: "function(p) { return String(p.value[1]); }" },
        },
      ],
    });
    const series = (option.series as Record<string, unknown>[])[0];
    const tooltip = series.tooltip as Record<string, unknown>;
    const label = series.label as Record<string, unknown>;
    expect(typeof tooltip.formatter).toBe("function");
    expect(typeof label.formatter).toBe("function");
  });

  test("malformed function-strings degrade to the original string (no throw)", () => {
    const option = prepareChartOption({
      tooltip: { formatter: "function(p) { syntax error here ;;; ;" },
      series: [{ type: "line", data: [1] }],
    });
    const tooltip = option.tooltip as Record<string, unknown>;
    expect(typeof tooltip.formatter).toBe("string");
  });
});
