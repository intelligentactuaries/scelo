// Drop-in `echarts-for-react` with a zoom-crisp canvas.
//
// Every chart in the app renders through this wrapper instead of importing
// `echarts-for-react` directly. It merges the LIVE devicePixelRatio into
// `opts`, so when the IDE's window zoom (Ctrl +/-/0) changes the effective
// DPR, echarts-for-react's deep-compare on `opts` disposes and re-inits the
// chart — rebuilding the canvas backing store at the new resolution instead
// of letting the compositor stretch a stale bitmap into a blur. Without
// this, zrender captures devicePixelRatio once at module load and every
// canvas chart goes permanently soft after the first zoom step.
//
// SVG-renderer instances (`opts={{ renderer: "svg" }}`) are unaffected by
// DPR but pass through unharmed.

import ReactECharts, { type EChartsReactProps } from "echarts-for-react";
import { useMemo } from "react";

import { useDevicePixelRatio } from "@/lib/useDevicePixelRatio";

export default function ReactEChartsCrisp(props: EChartsReactProps) {
  const dpr = useDevicePixelRatio();
  const opts = useMemo(() => ({ ...props.opts, devicePixelRatio: dpr }), [props.opts, dpr]);
  return <ReactECharts {...props} opts={opts} />;
}
