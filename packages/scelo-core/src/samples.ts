// The bundled sample datasets — one definition, served everywhere.
//
// These are the IDE's "load a sample" examples, moved here so the TUI can
// offer the SAME data: a sample that drifts between surfaces is worse than
// no sample, because the two apps would demonstrate different behavior on
// what claims to be the same book. The web app keeps its presentation
// (card accents, badges) locally; everything that defines the DATA — the
// builders, the seeded RNGs that make them stable, the descriptions — is
// here.
//
// Every builder is pure and deterministically seeded: the same sample
// loads byte-identical on every run, which is what makes "load the claims
// sample and follow along" a sentence that can appear in a tutorial.

import type { Dataset, Row } from "./index";

// Tiny seeded LCG so the synthetic dataset is stable across reloads.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

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

// Build the bundled climate reanalysis sample as a Dataset. The 30-day
// Pretoria ERA5 / MERRA-2 / JRA-3Q preview we use in the Hard Data
// model-detail panel doubles as a useful Soft Data workstation sample —
// the user can filter on a particular reanalysis, derive a heat-index
// column, or pipe the slice through the Tools workstation to pick a
// parametric model. We reuse the exact bundled rows so the numbers stay
// consistent with the climate-data lineage panel downstream.
function syntheticClimate(): Dataset {
  const rows: Row[] = CLIMATE_SAMPLE.map((r) => ({
    date: r.date,
    t2m_era5: r.t2m_era5,
    t2m_merra2: r.t2m_merra2,
    t2m_jra3q: r.t2m_jra3q,
    pr_era5: r.pr_era5,
    pr_merra2: r.pr_merra2,
    pr_jra3q: r.pr_jra3q,
  }));
  return {
    name: "climate_pretoria_jan2024 (era5 / merra-2 / jra-3q)",
    columns: ["date", "t2m_era5", "t2m_merra2", "t2m_jra3q", "pr_era5", "pr_merra2", "pr_jra3q"],
    rows,
  };
}

// WMTR forecast scenarios sample — 12 rows, one per actuarial entity
// type, parameterised with the W(M,T,R) Cobb-Douglas survival engine's
// α / w / shock columns. The picker recognises (α_M, α_T, α_R) as the
// `forecast` family signature and lands the user straight on
// wmtr-projection + wmtr-sensitivity in Tools.
function syntheticWmtrScenarios(): Dataset {
  const rows: Row[] = [
    // domain · αM · αT · αR · wF · wRel · wS · pProd · pFam · pRel · init_family · init_religion · shock · horizon
    {
      entity: "rural village",
      alpha_m: 0.3,
      alpha_t: 0.3,
      alpha_r: 0.4,
      w_f: 0.5,
      w_rel: 0.3,
      w_s: 0.2,
      init_family: 0.8,
      init_religion: 0.7,
      shock: "severe",
      horizon: 30,
    },
    {
      entity: "urban district",
      alpha_m: 0.5,
      alpha_t: 0.3,
      alpha_r: 0.2,
      w_f: 0.3,
      w_rel: 0.2,
      w_s: 0.5,
      init_family: 0.5,
      init_religion: 0.4,
      shock: "moderate",
      horizon: 30,
    },
    {
      entity: "coastal town",
      alpha_m: 0.4,
      alpha_t: 0.3,
      alpha_r: 0.3,
      w_f: 0.4,
      w_rel: 0.3,
      w_s: 0.3,
      init_family: 0.65,
      init_religion: 0.55,
      shock: "severe",
      horizon: 30,
    },
    {
      entity: "term life book",
      alpha_m: 0.55,
      alpha_t: 0.2,
      alpha_r: 0.25,
      w_f: 0.3,
      w_rel: 0.2,
      w_s: 0.5,
      init_family: 0.55,
      init_religion: 0.45,
      shock: "moderate",
      horizon: 20,
    },
    {
      entity: "annuity book",
      alpha_m: 0.45,
      alpha_t: 0.25,
      alpha_r: 0.3,
      w_f: 0.35,
      w_rel: 0.25,
      w_s: 0.4,
      init_family: 0.6,
      init_religion: 0.5,
      shock: "moderate",
      horizon: 40,
    },
    {
      entity: "DB pension scheme",
      alpha_m: 0.35,
      alpha_t: 0.25,
      alpha_r: 0.4,
      w_f: 0.45,
      w_rel: 0.25,
      w_s: 0.3,
      init_family: 0.7,
      init_religion: 0.5,
      shock: "moderate",
      horizon: 30,
    },
    {
      entity: "GI reserves · long-tail",
      alpha_m: 0.6,
      alpha_t: 0.3,
      alpha_r: 0.1,
      w_f: 0.2,
      w_rel: 0.1,
      w_s: 0.7,
      init_family: 0.4,
      init_religion: 0.3,
      shock: "moderate",
      horizon: 15,
    },
    {
      entity: "GI reserves · short-tail",
      alpha_m: 0.65,
      alpha_t: 0.25,
      alpha_r: 0.1,
      w_f: 0.2,
      w_rel: 0.1,
      w_s: 0.7,
      init_family: 0.45,
      init_religion: 0.3,
      shock: "mild",
      horizon: 5,
    },
    {
      entity: "health LTH book",
      alpha_m: 0.5,
      alpha_t: 0.3,
      alpha_r: 0.2,
      w_f: 0.3,
      w_rel: 0.3,
      w_s: 0.4,
      init_family: 0.55,
      init_religion: 0.45,
      shock: "severe",
      horizon: 20,
    },
    {
      entity: "agrarian community · drought",
      alpha_m: 0.25,
      alpha_t: 0.3,
      alpha_r: 0.45,
      w_f: 0.55,
      w_rel: 0.3,
      w_s: 0.15,
      init_family: 0.85,
      init_religion: 0.75,
      shock: "severe",
      horizon: 30,
    },
    {
      entity: "post-conflict town",
      alpha_m: 0.3,
      alpha_t: 0.3,
      alpha_r: 0.4,
      w_f: 0.45,
      w_rel: 0.25,
      w_s: 0.3,
      init_family: 0.55,
      init_religion: 0.45,
      shock: "severe",
      horizon: 30,
    },
    {
      entity: "stable urban hub",
      alpha_m: 0.5,
      alpha_t: 0.3,
      alpha_r: 0.2,
      w_f: 0.25,
      w_rel: 0.15,
      w_s: 0.6,
      init_family: 0.6,
      init_religion: 0.45,
      shock: "mild",
      horizon: 30,
    },
  ];
  return {
    name: "wmtr_scenarios (synthetic)",
    columns: [
      "entity",
      "alpha_m",
      "alpha_t",
      "alpha_r",
      "w_f",
      "w_rel",
      "w_s",
      "init_family",
      "init_religion",
      "shock",
      "horizon",
    ],
    rows,
  };
}

// Lifelib model-point sample. Structure mirrors
// github.com/lifelib-dev/lifelib · basiclife / basic_term_sample.xlsx so an
// actuary already using lifelib can drop their real MP file in and get the
// same projection. 100 policies spread across age 25-65, mixed sex, mixed
// term, with `duration_mth` non-zero on a third of the book so the
// projection starts mid-coverage on those rows.
function syntheticLifelibMP(): Dataset {
  const rand = lcg(0xbeefcafe);
  const rows: Row[] = [];
  for (let i = 0; i < 100; i++) {
    const age = 25 + Math.floor(rand() * 41); // 25-65
    const sex = rand() > 0.5 ? "M" : "F";
    const term = [10, 15, 20, 25, 30][Math.floor(rand() * 5)];
    const sa = Math.round((100_000 + rand() * 900_000) / 1000) * 1000;
    // ~1/3 of book already in force: duration up to half the term
    const inForce = rand() < 0.33;
    const durationMth = inForce ? Math.max(1, Math.floor(rand() * (term * 12) * 0.5)) : 0;
    // crude premium = SA * qx * loading / 12, with qx_male slightly higher
    const qx = 0.00022 + 2.7e-6 * Math.pow(1.124, age) * (sex === "M" ? 1.05 : 1.0);
    const monthly = Math.round(((sa * qx * 1.2) / 12) * 100) / 100;
    rows.push({
      policy_id: `MP${(10000 + i).toString()}`,
      age_at_entry: age,
      sex,
      sum_assured: sa,
      policy_term: term,
      duration_mth: durationMth,
      premium_pp: monthly,
    });
  }
  return {
    name: "lifelib_basic_term_mp (synthetic)",
    columns: [
      "policy_id",
      "age_at_entry",
      "sex",
      "sum_assured",
      "policy_term",
      "duration_mth",
      "premium_pp",
    ],
    rows,
  };
}

function syntheticClaims(): Dataset {
  const rand = lcg(0xdeadbeef);
  const states = ["GP", "WC", "KZN", "EC", "FS", "MP", "LP", "NW", "NC"];
  const lines = ["motor", "household", "liability", "engineering", "marine"];
  // Build a proper INCOMPLETE triangle: for each origin year, only emit
  // claim rows where (origin + dev) ≤ latest calendar period. The latest
  // origin gets only dev=0 (one diagonal of a real triangle), the earliest
  // origin gets the full development tail. Chain-ladder + Mack +
  // Bornhuetter-Ferguson all collapse to IBNR=0 on a square / fully-developed
  // triangle, so without this constraint the reserving runners report
  // misleading 0.00 headlines on Hard Data.
  const origins = [2018, 2019, 2020, 2021, 2022, 2023, 2024];
  const latestCal = origins[origins.length - 1]; // 2024
  const rows: Row[] = [];
  let i = 0;
  for (const origin of origins) {
    const maxDev = latestCal - origin; // 0..6
    for (let dev = 0; dev <= maxDev; dev++) {
      // 2-4 claim rows per (origin, dev) cell so each cell is non-trivial,
      // and the overall row count lands around ~70 — close to the prior
      // sample size for stable Soft Data stats.
      const cellRows = 2 + Math.floor(rand() * 3);
      for (let k = 0; k < cellRows; k++) {
        const sev = Math.exp(8 + rand() * 3) * (1 + dev * 0.1);
        const age = 18 + Math.floor(rand() * 60);
        const sex = rand() > 0.5 ? "M" : "F";
        const settled = dev >= 3 ? rand() > 0.15 : rand() > 0.6;
        const incurred = rand() < 0.05 ? null : Math.round(sev * (1.05 + rand() * 0.25));
        rows.push({
          policy_id: `P${10000 + i}`,
          origin_year: origin,
          dev_period: dev,
          line: lines[Math.floor(rand() * lines.length)],
          state: states[Math.floor(rand() * states.length)],
          age,
          sex,
          paid: Math.round(sev),
          incurred,
          settled: settled ? "yes" : "no",
        });
        i++;
      }
    }
  }
  return {
    name: "claims_sample (synthetic)",
    columns: [
      "policy_id",
      "origin_year",
      "dev_period",
      "line",
      "state",
      "age",
      "sex",
      "paid",
      "incurred",
      "settled",
    ],
    rows,
  };
}

const FIRST_NAMES = [
  "Jane",
  "  José", // leading whitespace + accented (real é, not mojibake)
  "JosÃ©", // mojibake: UTF-8 "é" misdecoded as Latin-1 → "Ã©"
  "Thandi",
  "Pieter",
  "﻿Acme", // BOM-prefixed
  "Lerato",
  "Naledi",
  "Sipho",
  "Ayanda",
];
const LAST_NAMES = [
  "Smith",
  "van der Merwe",
  "Mokoena ", // trailing whitespace
  "Naidoo",
  "Patel",
  "Dlamini",
  "Nkosi",
  "Williams",
];
const REGIONS = [
  "WEST",
  "west",
  "West",
  "EAST",
  "east",
  "East",
  "NORTH",
  "north",
  "SOUTH",
  "south",
];
const MISSING_TOKENS = ["N/A", "?", "-", "TBD", "null", "none", ""];
const BOOL_VARIANTS_TRUE = ["Y", "yes", "TRUE", "true", "1", "y"];
const BOOL_VARIANTS_FALSE = ["N", "no", "FALSE", "false", "0", "n"];

function maybeMissing<T extends string | number | null>(
  rand: () => number,
  v: T,
  missingRate: number,
): string | T {
  if (rand() < missingRate) {
    const i = Math.floor(rand() * MISSING_TOKENS.length);
    return MISSING_TOKENS[i];
  }
  return v;
}

// Format a number as a dirty currency-ish string — picks one of several
// dialects so parse-numeric has to deal with the full long tail.
function dirtyMoney(rand: () => number, value: number): string {
  const dialect = Math.floor(rand() * 5);
  const negative = value < 0;
  const abs = Math.abs(value);
  switch (dialect) {
    case 0: {
      const formatted = abs.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      return negative ? `($${formatted})` : `$${formatted}`;
    }
    case 1:
      // trailing currency code
      return `${abs.toFixed(2)} ZAR`;
    case 2:
      // thousand separator only
      return abs.toLocaleString("en-US", { maximumFractionDigits: 0 });
    case 3:
      // bare number with whitespace padding
      return ` ${abs.toFixed(2)} `;
    default:
      // accounting parens for negatives, plain otherwise
      return negative ? `(${abs.toFixed(2)})` : abs.toFixed(2);
  }
}

// Mixed date formats: ISO, slashed (DD/MM/YYYY), month-name, dashed
// non-ISO. parse-dates should snap all of them to YYYY-MM-DD.
function dirtyDate(rand: () => number, base: Date): string {
  const dialect = Math.floor(rand() * 4);
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth() + 1;
  const d = base.getUTCDate();
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  switch (dialect) {
    case 0:
      return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    case 1:
      return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
    case 2:
      return `${monthNames[m - 1]} ${d}, ${y}`;
    default:
      return `${String(d).padStart(2, "0")}-${String(m).padStart(2, "0")}-${y}`;
  }
}

export function buildDirtySample(): Dataset {
  const rand = lcg(0xc0ffee);
  const rows: Row[] = [];
  const startMs = Date.UTC(2024, 0, 1);
  const dayMs = 24 * 60 * 60 * 1000;

  for (let i = 0; i < 50; i++) {
    const first = FIRST_NAMES[Math.floor(rand() * FIRST_NAMES.length)];
    const last = LAST_NAMES[Math.floor(rand() * LAST_NAMES.length)];
    // Inject occasional double internal whitespace so collapse-whitespace
    // has something to find.
    const fullName = rand() < 0.2 ? `${first}  ${last}` : `${first} ${last}`;

    const email = rand() < 0.1 ? "" : `${first.trim().toLowerCase().replace(/\W/g, "")}@example.za`;

    const joined = new Date(startMs + Math.floor(rand() * 500) * dayMs);
    const joinedStr = dirtyDate(rand, joined);

    const region = REGIONS[Math.floor(rand() * REGIONS.length)];

    // Premium: realistic ZAR figures, occasional negative (refund), all
    // stored as messy strings.
    const premiumValue = Math.round((1000 + rand() * 9000) * 100) / 100;
    const signed = rand() < 0.08 ? -premiumValue : premiumValue;
    const premium = dirtyMoney(rand, signed);

    // Discount %: usually 0-25%, written as "10%" / "5%" etc.
    const discountPct = `${Math.floor(rand() * 25)}%`;

    // Age: usually 22-78, occasional -999 / 9999 sentinels (legacy
    // "missing" codes) — placed often enough to clear the analyser's
    // ≥3-occurrence threshold.
    let age: number | string;
    const roll = rand();
    if (roll < 0.1) age = -999;
    else if (roll < 0.16) age = 9999;
    else age = 22 + Math.floor(rand() * 56);

    // Active flag — rotates through every common boolean spelling.
    const activeBucket = i % 12;
    const active =
      activeBucket < 6
        ? BOOL_VARIANTS_TRUE[activeBucket]
        : BOOL_VARIANTS_FALSE[activeBucket - 6];

    // notes: 96% null, 4% short free-text. Triggers drop-empty-cols.
    const notes = rand() < 0.04 ? "VIP customer" : null;

    // internal_ref_v2: 100% null in this snapshot. Triggers drop-empty.
    const internalRef: string | null = null;

    rows.push({
      "Customer Name": maybeMissing(rand, fullName, 0.08),
      Email: email === "" ? "?" : email,
      "Joined Date": maybeMissing(rand, joinedStr, 0.06),
      Region: region,
      country: "ZA",
      premium_zar: maybeMissing(rand, premium, 0.04),
      discount_pct: discountPct,
      age,
      active,
      notes,
      internal_ref_v2: internalRef,
    });
  }

  // Inject duplicate rows so drop-duplicates fires (3 exact copies of
  // row 0, placed at the end so they survive the sample stride).
  if (rows.length > 0) {
    rows.push({ ...rows[0] });
    rows.push({ ...rows[0] });
    rows.push({ ...rows[0] });
  }

  // Inject an NBSP-corrupted region into the first row so fix-encoding
  // has at least one cell to repair.
  rows[1] = { ...rows[1], Region: "West Cape" };
  rows[2] = { ...rows[2], "Customer Name": "Cape Town Office" };
  // Zero-width space snuck into a free-text cell — a common Word
  // import artefact, invisible in most viewers but real for
  // downstream string comparisons.
  rows[3] = { ...rows[3], notes: "VIP​customer" };

  return {
    name: "messy_intake (dirty demo)",
    columns: [
      "Customer Name",
      "Email",
      "Joined Date",
      "Region",
      "country",
      "premium_zar",
      "discount_pct",
      "age",
      "active",
      "notes",
      "internal_ref_v2",
    ],
    rows,
  };
}

// Mulberry32 + Box-Muller for the workspace demo — private copies, but
// not duplication in the sense that matters: only THESE feed the sample,
// so the data cannot drift from the web app’s own linalg helpers.
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussStd(rand: () => number, mu = 0, sigma = 1): number {
  const u1 = Math.max(rand(), 1e-12);
  const u2 = rand();
  return mu + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** The report channels an actuary reads off this book (the workspace readout). */
export const WORKSPACE_DEMO_READOUTS = ["annuity_60", "life_exp_60", "survival_to_80"];
/** A directly readable level, for the selectivity dissociation. */
export const WORKSPACE_DEMO_REFLEXIVE = "crude_rate";

// High-variance, decision-irrelevant operational columns: plausible on a real
// extract, but nothing the mortality of the book actually turns on.
const NUISANCE = [
  "premium_band",
  "postcode_score",
  "tenure_months",
  "marketing_segment",
  "contact_recency",
  "web_logins",
  "paperless_score",
  "call_centre_index",
  "app_sessions",
  "survey_score",
];

export function buildWorkspaceDemo(n = 2000, seed = 7): Dataset {
  const rand = seededRng(seed);
  const columns = [
    "mortality_trend",
    "cohort_effect",
    "smoking_index",
    "crude_rate",
    ...NUISANCE,
    ...WORKSPACE_DEMO_READOUTS,
  ];
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    // Three genuine drivers, each O(1) and low variance.
    const trend = gaussStd(rand, 0, 1);
    const cohort = gaussStd(rand, 0, 1);
    const smoking = gaussStd(rand, 0, 1);
    // A directly readable crude-rate level with deliberately large variance.
    const crude = gaussStd(rand, 0, 5);

    const row: Row = {
      mortality_trend: round(trend, 4),
      cohort_effect: round(cohort, 4),
      smoking_index: round(smoking, 4),
      crude_rate: round(crude, 3),
    };
    // Nuisance: large variance, no bearing on the mortality readouts.
    for (const c of NUISANCE) row[c] = round(gaussStd(rand, 0, 8), 3);

    // Nonlinear report channels whose union spans the three real drivers.
    row.annuity_60 = round(
      1.2 * trend + 0.8 * cohort + 0.3 * trend * cohort + gaussStd(rand, 0, 0.04),
      4,
    );
    row.life_exp_60 = round(
      1.0 * cohort - 0.9 * smoking + 0.4 * smoking * smoking + gaussStd(rand, 0, 0.04),
      4,
    );
    row.survival_to_80 = round(
      0.7 * trend + 1.1 * smoking - 0.3 * trend * trend + gaussStd(rand, 0, 0.04),
      4,
    );
    rows.push(row);
  }
  return { name: "workspace-demo", columns, rows };
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

// ── the registry ──────────────────────────────────────────────────────────

export type SampleKey =
  | "claims"
  | "climate"
  | "dirty"
  | "lifelib-mp"
  | "wmtr-scenarios"
  | "workspace-demo";

export type SampleSpec = {
  key: SampleKey;
  title: string;
  subtitle: string;
  blurb: string;
  rows: number;
  cols: number;
  build: () => Dataset;
};

export const SAMPLES: SampleSpec[] = [
  {
    key: "claims",
    title: "Synthetic claims",
    subtitle: "P&C reserving / pricing demo",
    blurb:
      "~80-row mixed-type dataset shaped as a proper INCOMPLETE claims triangle (origins 2018–2024, dev periods truncated to the latest calendar period). Columns: policy_id, origin_year, dev_period, line, SA province, age, sex, paid, incurred, settled. Ideal for chain-ladder / Mack / BF + GLM models.",
    rows: 79,
    cols: 10,
    build: () => syntheticClaims(),
  },
  {
    key: "climate",
    title: "Climate reanalysis ensemble",
    subtitle: "ERA5 / MERRA-2 / JRA-3Q · Pretoria · Jan 2024",
    blurb:
      "30 daily records over a single grid-cell with 2-m temperature and total precipitation under all three reanalyses. Same data the Hard Data climate-lineage panel renders downstream; ready for parametric trigger calibration and CLIMADA-style work.",
    rows: 30,
    cols: 7,
    build: () => syntheticClimate(),
  },
  {
    key: "dirty",
    title: "Messy intake (dirty demo)",
    subtitle: "exercises every cleaning op in one sample",
    blurb:
      "53-row customer ledger with the full real-world mess: $/comma/parens currency strings, %-suffixed numbers, -999 / 9999 sentinel ages, mixed Y/N/yes/no/1/0 booleans, mixed date formats (ISO + DD/MM/YYYY + 'Jan 5, 2024'), case-only region duplicates (WEST/west/West), a constant `country` column, two near-empty columns, headers with spaces, mojibake (UTF-8↔Latin-1), BOM/NBSP/zero-width characters, missing markers (N/A, ?, -, TBD, null), and three exact duplicate rows. Load it and the cleaning banner lights up with every op.",
    rows: 53,
    cols: 11,
    build: () => buildDirtySample(),
  },
  {
    key: "wmtr-scenarios",
    title: "WMTR · forecast scenarios",
    subtitle: "domain-agnostic survival projection · α/w parameters",
    blurb:
      "12-row scenario table for the W(M, T, R) Monte Carlo forecast engine. Each row is a different actuarial entity (life book · pension scheme · reserve position · community) parameterised with α_M / α_T / α_R, relational weights, shock severity, and horizon. Picker routes straight to the `forecast` family.",
    rows: 12,
    cols: 11,
    build: () => syntheticWmtrScenarios(),
  },
  {
    key: "lifelib-mp",
    title: "Lifelib · model points",
    subtitle: "term life MP file · lifelib basiclife/BasicTerm_ME",
    blurb:
      "100-row in-force model-point file shaped like lifelib's basic_term_sample: policy_id, age_at_entry, sex, sum_assured, policy_term, duration_mth, premium_pp. Loads straight into the lifelib BasicTerm_ME projection (in-browser TS port; the real lifelib model inside Scelo IDE) and routes the AI picker to the `life` family. Same structure works for CashValue / IFRS17 / Solvency II life nodes.",
    rows: 100,
    cols: 7,
    build: () => syntheticLifelibMP(),
  },
  {
    key: "workspace-demo",
    title: "Workspace demo",
    subtitle: "decision-relevant is not max-variance · global workspace",
    blurb:
      "2,000-policy synthetic annuity book with three genuine low-variance drivers (mortality trend, cohort, smoking) acting through nonlinear channels on annuity_60 / life_exp_60 / survival_to_80, a directly readable crude_rate level, and ten high-variance but irrelevant operational columns (premium band, web logins, survey score, ...). Run a model, then the Hard-Data 'validate workspace' action to watch the active subspace recover the three real drivers while PCA chases the noise.",
    rows: 2000,
    cols: 17,
    build: () => buildWorkspaceDemo(),
  },
];

export const SAMPLE_BY_KEY: Map<SampleKey, SampleSpec> = new Map(SAMPLES.map((s) => [s.key, s]));
