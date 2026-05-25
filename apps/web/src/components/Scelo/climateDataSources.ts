// Typed registry of the three atmospheric reanalyses Scelo's climate-actuarial
// models pull from. Reanalyses are the gold-standard input for climate
// hazard modelling — they assimilate every available observation (surface,
// upper-air, satellite, radiosonde) into a consistent numerical-weather-
// prediction model run forward through history. For an actuary they give
// you a globally complete, physically consistent record from which to
// derive event sets, return periods, and parametric trigger calibrations.
//
// The three sources differ on:
//   • spatial / temporal resolution
//   • coverage start year
//   • producing centre (ECMWF / NASA / JMA)
//   • licence + access model
//
// Best practice: pick ERA5 as the primary and corroborate with MERRA-2 and
// JRA-3Q as an ensemble of independent reanalyses for uncertainty
// quantification — the three centres use independent forecast models, data
// assimilation schemes, and observation pipelines, so their pairwise
// disagreement is a reasonable proxy for irreducible reanalysis error.

export type DataAccess = {
  /** Short label rendered in the UI ("CDS API", "AWS Open Data", …). */
  channel: string;
  /** Public URL; users can click through for the canonical landing page. */
  url: string;
  /** Friendly description — what to do once you're there. */
  note: string;
};

export type ClimateDataSource = {
  /** Stable id; reanalysis short-name in lowercase ("era5", "era5_land", …). */
  id: "era5" | "era5_land" | "merra2" | "jra3q";
  /** Display name as actuaries / climatologists know it. */
  name: string;
  /** Producing centre. */
  producer: string;
  /** One-line role in the ensemble. */
  role: string;
  /** Spatial resolution in degrees, written for human reading. */
  resolution_spatial: string;
  /** Temporal cadence. */
  resolution_temporal: string;
  /** ISO start year of coverage. */
  coverage_start: number;
  /** ISO end year ("present" → undefined, rendered as "present"). */
  coverage_end?: number;
  /** Licence — short SPDX-ish identifier where it exists. */
  license: string;
  /** Where to get it. Ordered fastest-first; first entry is the recommended path. */
  access: DataAccess[];
  /** Variables Scelo typically pulls; not exhaustive. */
  variables: string[];
  /** Actuarial use-cases this source is good for. */
  use_cases: string[];
  /** Known limitations that matter for actuarial work. */
  caveats: string[];
};

// Ordered: primary first, cross-check second, uncertainty third.
export const CLIMATE_DATA_SOURCES: ClimateDataSource[] = [
  {
    id: "era5",
    name: "ERA5",
    producer: "ECMWF Copernicus Climate Change Service (C3S)",
    role: "Primary / gold standard",
    resolution_spatial: "0.25° (≈ 28 km at the equator)",
    resolution_temporal: "Hourly",
    coverage_start: 1940,
    license: "CC-BY-4.0",
    access: [
      {
        channel: "Planetary Computer (Zarr)",
        url: "https://planetarycomputer.microsoft.com/dataset/era5-pds",
        note: "Pre-staged Zarr on Azure; fastest, no queue, no API key.",
      },
      {
        channel: "AWS Open Data",
        url: "https://registry.opendata.aws/ecmwf-era5/",
        note: "Free egress within AWS; NetCDF + Zarr mirrors.",
      },
      {
        channel: "Google Cloud Public Datasets",
        url: "https://cloud.google.com/storage/docs/public-datasets/era5",
        note: "Free egress within GCP.",
      },
      {
        channel: "Copernicus CDS (cdsapi)",
        url: "https://cds.climate.copernicus.eu/api-how-to",
        note: "Canonical source — needs a CDS account and the `cdsapi` Python package; jobs are queued.",
      },
    ],
    variables: [
      "2m_temperature",
      "total_precipitation",
      "10m_u_component_of_wind",
      "10m_v_component_of_wind",
      "mean_sea_level_pressure",
      "surface_solar_radiation",
    ],
    use_cases: [
      "Hazard event sets for TC / floods / heatwaves (CLIMADA + parametric)",
      "Return-period calibration (50y / 100y / 250y windspeed thresholds)",
      "Parametric trigger design — rainfall / temperature indices",
      "Climate-attributed exposure trend (1940 → present is the longest run)",
    ],
    caveats: [
      "Mountainous and coastal regions: 28 km grid smooths sharp gradients — pair with ERA5-Land for surface variables on land.",
      "Convective precipitation in the tropics is under-parameterised; the 1979→ HadISST-assimilated era is more reliable than 1940–1978 back-extension.",
    ],
  },
  {
    id: "era5_land",
    name: "ERA5-Land",
    producer: "ECMWF Copernicus Climate Change Service (C3S)",
    role: "Primary · high-resolution land surface",
    resolution_spatial: "0.1° (≈ 9 km at the equator)",
    resolution_temporal: "Hourly",
    coverage_start: 1950,
    license: "CC-BY-4.0",
    access: [
      {
        channel: "Planetary Computer (Zarr)",
        url: "https://planetarycomputer.microsoft.com/dataset/era5-land",
        note: "Pre-staged Zarr; fastest path for land-surface workloads.",
      },
      {
        channel: "Copernicus CDS (cdsapi)",
        url: "https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land",
        note: "Canonical land-surface reanalysis — same authentication as ERA5.",
      },
    ],
    variables: [
      "2m_temperature",
      "skin_temperature",
      "total_precipitation",
      "snow_depth",
      "soil_moisture_layer_1",
      "soil_moisture_layer_2",
      "evaporation",
      "runoff",
    ],
    use_cases: [
      "Crop / drought / agri-parametric indices (NDVI proxy via soil moisture)",
      "Property exposure at municipality-level resolution",
      "Wildfire fuel-moisture inputs",
    ],
    caveats: [
      "Land-only — there is no over-ocean coverage; pair with ERA5 atmospheric fields for cyclone or marine work.",
      "Driven by ERA5 atmospheric forcing, so it inherits ERA5's biases at the boundary.",
    ],
  },
  {
    id: "merra2",
    name: "MERRA-2",
    producer: "NASA GMAO",
    role: "Independent cross-check",
    resolution_spatial: "0.5° × 0.625° (≈ 55 km × 70 km)",
    resolution_temporal: "Hourly",
    coverage_start: 1980,
    license: "NASA — unrestricted, no commercial limitations",
    access: [
      {
        channel: "AWS Open Data",
        url: "https://registry.opendata.aws/nasa-merra2/",
        note: "Pre-staged Zarr on S3; no NASA Earthdata login.",
      },
      {
        channel: "NASA Earthdata GES DISC",
        url: "https://disc.gsfc.nasa.gov/datasets?keywords=MERRA-2",
        note: "Canonical source — needs an Earthdata Login. NetCDF.",
      },
      {
        channel: "Planetary Computer",
        url: "https://planetarycomputer.microsoft.com/dataset/group/nasa",
        note: "Subset of MERRA-2 variables available; check coverage before relying on it.",
      },
    ],
    variables: [
      "T2M (2m temperature)",
      "TPRECMAX (max precipitation)",
      "U10M / V10M (10m wind components)",
      "PS (surface pressure)",
      "QV2M (specific humidity)",
      "AODANA (aerosol optical depth)",
    ],
    use_cases: [
      "Independent corroboration of ERA5-derived event sets",
      "Cross-validation of parametric triggers across model bias",
      "Aerosol-driven perils (visibility, dust storms) — MERRA-2's aerosol module is best-in-class",
    ],
    caveats: [
      "Coarser grid than ERA5 — sub-50 km features will be smoothed.",
      "Starts in 1980; cannot extend back to the inter-war or post-WW2 reference periods.",
    ],
  },
  {
    id: "jra3q",
    name: "JRA-3Q",
    producer: "Japan Meteorological Agency (JMA)",
    role: "Third leg of the ensemble · uncertainty bound",
    resolution_spatial: "0.375° (≈ 40 km)",
    resolution_temporal: "3-hourly (with 6-hourly cycles)",
    coverage_start: 1947,
    license: "Free for research and operational use; redistribution conditions apply",
    access: [
      {
        channel: "DIAS / JMA Data Portal",
        url: "https://jra.kishou.go.jp/JRA-3Q/index_en.html",
        note: "Canonical source — registration required; pull GRIB2 or NetCDF.",
      },
      {
        channel: "ECMWF MARS mirror",
        url: "https://www.ecmwf.int/en/forecasts/dataset/jra-3q",
        note: "Some products mirrored at ECMWF for users with MARS access.",
      },
    ],
    variables: [
      "TMP_2maboveground",
      "TPRATE_surface",
      "UGRD_10maboveground",
      "VGRD_10maboveground",
      "PRES_surface",
      "RH_2maboveground",
    ],
    use_cases: [
      "Three-way ensemble for irreducible-error bounds on AAL and PMLs",
      "Asian-Pacific TC / monsoon perils — JMA's home region has the best observational density",
      "Inter-comparison against ERA5 + MERRA-2 to flag potential model bias",
    ],
    caveats: [
      "Lower temporal resolution than ERA5 / MERRA-2 — interpolate carefully for sub-3-hour peaks (e.g. squall lines).",
      "Slightly more cumbersome access than the cloud-mirrored ECMWF and NASA products.",
    ],
  },
];

// Pipeline canonical mapping: which reanalysis is "the primary" for each
// downstream actuarial workflow. Used by the model-detail panel to caption
// the example data sensibly.
export const CLIMATE_PIPELINE: {
  workflow: string;
  primary: ClimateDataSource["id"];
  cross_check: ClimateDataSource["id"][];
  notes: string;
}[] = [
  {
    workflow: "TC / hurricane hazard layer",
    primary: "era5",
    cross_check: ["merra2", "jra3q"],
    notes:
      "ERA5 wind + MSLP at 0.25°; corroborate the 50/100/250-y return-period winds against MERRA-2 and JRA-3Q to bound model uncertainty.",
  },
  {
    workflow: "Heatwave parametric trigger",
    primary: "era5_land",
    cross_check: ["era5", "merra2"],
    notes:
      "ERA5-Land 2m temperature at 0.1° resolves urban-rural gradient; primary trigger is consecutive-day-above-threshold count.",
  },
  {
    workflow: "Drought / agri-parametric (SPI, soil moisture)",
    primary: "era5_land",
    cross_check: ["era5"],
    notes:
      "ERA5-Land soil moisture + total precipitation feed standardised precipitation index (SPI-3, SPI-6); MERRA-2 is too coarse for crop-level work.",
  },
  {
    workflow: "Flood / pluvial event set",
    primary: "era5",
    cross_check: ["merra2", "jra3q"],
    notes:
      "Hourly precipitation; pair with terrain DEM and curve-number runoff. Use the ensemble for tail-event frequency uncertainty.",
  },
];
