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

export type ClimateSampleRow = {
  /** ISO date (UTC). */
  date: string;
  /** Daily mean 2-m air temperature in °C. */
  t2m_era5: number;
  t2m_merra2: number;
  t2m_jra3q: number;
  /** Daily total precipitation in mm. */
  pr_era5: number;
  pr_merra2: number;
  pr_jra3q: number;
};

export const CLIMATE_SAMPLE: ClimateSampleRow[] = [
  {
    date: "2024-01-01",
    t2m_era5: 23.4,
    t2m_merra2: 23.1,
    t2m_jra3q: 23.7,
    pr_era5: 0.0,
    pr_merra2: 0.1,
    pr_jra3q: 0.0,
  },
  {
    date: "2024-01-02",
    t2m_era5: 24.8,
    t2m_merra2: 24.3,
    t2m_jra3q: 25.0,
    pr_era5: 0.0,
    pr_merra2: 0.0,
    pr_jra3q: 0.0,
  },
  {
    date: "2024-01-03",
    t2m_era5: 26.1,
    t2m_merra2: 25.7,
    t2m_jra3q: 26.4,
    pr_era5: 0.2,
    pr_merra2: 0.0,
    pr_jra3q: 0.1,
  },
  {
    date: "2024-01-04",
    t2m_era5: 27.5,
    t2m_merra2: 27.0,
    t2m_jra3q: 27.9,
    pr_era5: 1.4,
    pr_merra2: 0.7,
    pr_jra3q: 2.1,
  },
  {
    date: "2024-01-05",
    t2m_era5: 28.8,
    t2m_merra2: 28.4,
    t2m_jra3q: 29.3,
    pr_era5: 8.7,
    pr_merra2: 4.2,
    pr_jra3q: 11.3,
  },
  {
    date: "2024-01-06",
    t2m_era5: 26.4,
    t2m_merra2: 26.0,
    t2m_jra3q: 26.7,
    pr_era5: 15.2,
    pr_merra2: 9.8,
    pr_jra3q: 18.5,
  },
  {
    date: "2024-01-07",
    t2m_era5: 25.0,
    t2m_merra2: 24.6,
    t2m_jra3q: 25.3,
    pr_era5: 3.4,
    pr_merra2: 1.9,
    pr_jra3q: 5.0,
  },
  {
    date: "2024-01-08",
    t2m_era5: 27.2,
    t2m_merra2: 26.7,
    t2m_jra3q: 27.6,
    pr_era5: 0.0,
    pr_merra2: 0.0,
    pr_jra3q: 0.0,
  },
  {
    date: "2024-01-09",
    t2m_era5: 29.5,
    t2m_merra2: 29.0,
    t2m_jra3q: 30.1,
    pr_era5: 0.0,
    pr_merra2: 0.0,
    pr_jra3q: 0.0,
  },
  {
    date: "2024-01-10",
    t2m_era5: 31.2,
    t2m_merra2: 30.6,
    t2m_jra3q: 31.8,
    pr_era5: 0.0,
    pr_merra2: 0.0,
    pr_jra3q: 0.0,
  },
  {
    date: "2024-01-11",
    t2m_era5: 32.4,
    t2m_merra2: 31.9,
    t2m_jra3q: 33.0,
    pr_era5: 0.0,
    pr_merra2: 0.0,
    pr_jra3q: 0.0,
  },
  {
    date: "2024-01-12",
    t2m_era5: 33.8,
    t2m_merra2: 33.1,
    t2m_jra3q: 34.4,
    pr_era5: 0.0,
    pr_merra2: 0.0,
    pr_jra3q: 0.0,
  },
  {
    date: "2024-01-13",
    t2m_era5: 35.1,
    t2m_merra2: 34.5,
    t2m_jra3q: 35.6,
    pr_era5: 0.0,
    pr_merra2: 0.0,
    pr_jra3q: 0.0,
  },
  {
    date: "2024-01-14",
    t2m_era5: 35.9,
    t2m_merra2: 35.2,
    t2m_jra3q: 36.3,
    pr_era5: 0.0,
    pr_merra2: 0.0,
    pr_jra3q: 0.0,
  },
  {
    date: "2024-01-15",
    t2m_era5: 34.6,
    t2m_merra2: 34.0,
    t2m_jra3q: 34.9,
    pr_era5: 2.1,
    pr_merra2: 0.8,
    pr_jra3q: 3.5,
  },
  {
    date: "2024-01-16",
    t2m_era5: 30.2,
    t2m_merra2: 29.7,
    t2m_jra3q: 30.5,
    pr_era5: 12.8,
    pr_merra2: 7.4,
    pr_jra3q: 14.9,
  },
  {
    date: "2024-01-17",
    t2m_era5: 27.5,
    t2m_merra2: 27.0,
    t2m_jra3q: 27.8,
    pr_era5: 18.6,
    pr_merra2: 12.3,
    pr_jra3q: 22.1,
  },
  {
    date: "2024-01-18",
    t2m_era5: 25.4,
    t2m_merra2: 24.9,
    t2m_jra3q: 25.7,
    pr_era5: 9.7,
    pr_merra2: 5.8,
    pr_jra3q: 11.5,
  },
  {
    date: "2024-01-19",
    t2m_era5: 26.8,
    t2m_merra2: 26.3,
    t2m_jra3q: 27.1,
    pr_era5: 4.3,
    pr_merra2: 2.6,
    pr_jra3q: 5.2,
  },
  {
    date: "2024-01-20",
    t2m_era5: 28.6,
    t2m_merra2: 28.1,
    t2m_jra3q: 29.0,
    pr_era5: 1.1,
    pr_merra2: 0.5,
    pr_jra3q: 1.4,
  },
  {
    date: "2024-01-21",
    t2m_era5: 30.4,
    t2m_merra2: 29.9,
    t2m_jra3q: 30.9,
    pr_era5: 0.0,
    pr_merra2: 0.0,
    pr_jra3q: 0.0,
  },
  {
    date: "2024-01-22",
    t2m_era5: 31.8,
    t2m_merra2: 31.3,
    t2m_jra3q: 32.3,
    pr_era5: 0.0,
    pr_merra2: 0.0,
    pr_jra3q: 0.0,
  },
  {
    date: "2024-01-23",
    t2m_era5: 32.7,
    t2m_merra2: 32.1,
    t2m_jra3q: 33.2,
    pr_era5: 0.3,
    pr_merra2: 0.1,
    pr_jra3q: 0.5,
  },
  {
    date: "2024-01-24",
    t2m_era5: 29.1,
    t2m_merra2: 28.5,
    t2m_jra3q: 29.4,
    pr_era5: 14.5,
    pr_merra2: 9.1,
    pr_jra3q: 17.2,
  },
  {
    date: "2024-01-25",
    t2m_era5: 26.3,
    t2m_merra2: 25.8,
    t2m_jra3q: 26.6,
    pr_era5: 22.4,
    pr_merra2: 15.6,
    pr_jra3q: 26.0,
  },
  {
    date: "2024-01-26",
    t2m_era5: 24.7,
    t2m_merra2: 24.2,
    t2m_jra3q: 25.0,
    pr_era5: 8.9,
    pr_merra2: 5.4,
    pr_jra3q: 10.3,
  },
  {
    date: "2024-01-27",
    t2m_era5: 26.5,
    t2m_merra2: 26.0,
    t2m_jra3q: 26.8,
    pr_era5: 2.7,
    pr_merra2: 1.3,
    pr_jra3q: 3.4,
  },
  {
    date: "2024-01-28",
    t2m_era5: 28.2,
    t2m_merra2: 27.7,
    t2m_jra3q: 28.6,
    pr_era5: 0.5,
    pr_merra2: 0.2,
    pr_jra3q: 0.7,
  },
  {
    date: "2024-01-29",
    t2m_era5: 29.9,
    t2m_merra2: 29.4,
    t2m_jra3q: 30.3,
    pr_era5: 0.0,
    pr_merra2: 0.0,
    pr_jra3q: 0.0,
  },
  {
    date: "2024-01-30",
    t2m_era5: 31.4,
    t2m_merra2: 30.8,
    t2m_jra3q: 31.8,
    pr_era5: 0.0,
    pr_merra2: 0.0,
    pr_jra3q: 0.0,
  },
];

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
