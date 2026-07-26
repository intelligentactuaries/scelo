// Bundled preview dataset for the climate-data lineage panel. 30 daily
// records over a single ERA5 grid-cell centred on Pretoria (lat -25.75°,
// lon 28.25°), 1–30 January 2024. Three reanalyses for the same cell so
// the user can see the ensemble agreement-and-disagreement at a glance.
//
// The numbers below are deterministic, plausible-shape values — they
// reflect the realistic Pretoria summer regime (warm days ~28–32 °C, hot
// extremes 33–36 °C, scattered convective rainfall) and the typical
// reanalysis spread (ERA5 vs MERRA-2 ≈ ±0.4 °C bias; ERA5 vs JRA-3Q
// ≈ ±0.6 °C; precipitation disagreement is the big one — sub-grid
// convection isn't well parameterised so daily totals can differ by 2-3×
// for the same date).
//
// For a real run you would replace this with a `cdsapi` / `xarray` pull;
// the schema below matches what those calls produce after `.to_pandas()`.

// The row type and the 30-day sample itself now live in @scelo/core so the
// TUI serves the same bundled data — re-exported here so this module stays
// the one import site for everything climate-sample-shaped.
export { type ClimateSampleRow, CLIMATE_SAMPLE } from "@scelo/core";

export const CLIMATE_SAMPLE_META = {
  location: "Pretoria, South Africa",
  lat: -25.75,
  lon: 28.25,
  window: "2024-01-01 → 2024-01-30",
  variables: ["2m air temperature (°C)", "total precipitation (mm/day)"],
  note: "Representative sample shaped to actual reanalysis output. In a real run, replace with `cdsapi.Client().retrieve(...)` or `xarray.open_zarr(...)` against the Planetary Computer / AWS / GCS mirrors.",
} as const;

// Quick ensemble stats helper. Used by the panel to show "mean ± spread"
// for a chosen variable — the spread between the three reanalyses is a
// useful actuarial proxy for reanalysis uncertainty when no ground-truth
// station record is available for the cell.
export function ensembleStats(values: number[]): {
  mean: number;
  range: number;
  cv_pct: number;
} {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const range = Math.max(...values) - Math.min(...values);
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
  const cv_pct = mean > 0 ? (sd / mean) * 100 : 0;
  return { mean, range, cv_pct };
}
