// Reactive window.devicePixelRatio.
//
// The IDE's VS Code-style window zoom (Ctrl +/-/0) works via Electron's
// webContents.setZoomLevel, which multiplies the renderer's devicePixelRatio
// by 1.2^level. DOM text and SVG re-rasterize crisply on their own, but a
// <canvas> backing store is sized with whatever DPR its painter captured at
// init — zrender reads it ONCE at module load — so every ECharts canvas
// painted before a zoom change gets bitmap-upscaled afterwards and turns
// soft. Charts must therefore (a) pass an explicit devicePixelRatio at init
// and (b) re-init when it changes. This hook provides the live value;
// echarts-for-react's deep-compare on `opts` handles the re-init.
//
// Subscription trick: a `(resolution: Xdppx)` media query matches only at
// the exact DPR it was created with, so its "change" event fires precisely
// when the effective DPR moves (zoom step, monitor swap, OS scale change).
// Re-subscribing at the new value keeps the listener armed for the next one.

import { useEffect, useState } from "react";

export function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => setDpr(window.devicePixelRatio || 1);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [dpr]);
  return dpr;
}
