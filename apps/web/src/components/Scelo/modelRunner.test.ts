// Pure-logic tests for the in-browser model runners against a synthetic
// dataset shaped like the real 2M-row motor-insurance benchmark file
// (id + ~10 categorical rating factors + numeric sum_insurd / past_claims
// / hp / tar_weight — and, crucially, NO `paid` column).

import { describe, expect, test } from "bun:test";
import type { Dataset, Row } from "./SoftDataWorkstation";
import {
  detectCategoricalCovariates,
  detectFrequencyTarget,
  detectMonetaryColumn,
  findExposureColumn,
  profileNumericColumns,
  runModel,
  sampleRowsCapped,
  BRIDGED_MODEL_IDS,
} from "./modelRunner";

// Small deterministic LCG so the fixture is stable across runs.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const PROVINCES = ["GT", "WC", "KZN", "EC", "LIM", "MP", "NW", "FS", "NC"];
const MAKES = ["toyota", "vw", "ford", "bmw", "hyundai", "kia", "nissan", "honda"];
const MARITAL = ["Married", "Single", "Divorced", "Widowed", "Seperated"];

function makeMotorDataset(n = 400, overrides?: Partial<Dataset>): Dataset {
  const rng = makeRng(42);
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      id: `pol-${i}`,
      acq_chan: rng() < 0.5 ? "broker" : "direct",
      province: PROVINCES[Math.floor(rng() * PROVINCES.length)],
      gender: rng() < 0.5 ? "M" : "F",
      car_make: MAKES[Math.floor(rng() * MAKES.length)],
      marital_st: MARITAL[Math.floor(rng() * MARITAL.length)],
      new_used: rng() < 0.3 ? "new" : "used",
      past_ins: rng() < 0.1 ? "NULL" : rng() < 0.5 ? "yes" : "no",
      car_year: 2005 + Math.floor(rng() * 20),
      hp: 60 + Math.floor(rng() * 200),
      tar_weight: 900 + Math.floor(rng() * 1400),
      past_claims: Math.floor(rng() * 5),
      sum_insurd: 50_000 + Math.floor(rng() * 900_000),
    });
  }
  return {
    name: "motor-synthetic.csv",
    columns: [
      "id",
      "acq_chan",
      "province",
      "gender",
      "car_make",
      "marital_st",
      "new_used",
      "past_ins",
      "car_year",
      "hp",
      "tar_weight",
      "past_claims",
      "sum_insurd",
    ],
    rows,
    ...overrides,
  };
}

function stringsOnlyDataset(): Dataset {
  const rows: Row[] = Array.from({ length: 50 }, (_, i) => ({
    note: `row ${i}`,
    flag: i % 2 === 0 ? "a" : "b",
  }));
  return { name: "strings.csv", columns: ["note", "flag"], rows };
}

describe("detection helpers", () => {
  test("detectCategoricalCovariates finds rating factors and skips ids / numerics", () => {
    const covs = detectCategoricalCovariates(makeMotorDataset());
    expect(covs).toContain("province");
    expect(covs).toContain("gender");
    expect(covs).toContain("marital_st");
    expect(covs).toContain("car_make");
    expect(covs).not.toContain("id"); // id-like name AND unique ≈ rows
    expect(covs).not.toContain("hp"); // numeric
    expect(covs).not.toContain("sum_insurd");
  });

  test("detectFrequencyTarget picks past_claims (small non-negative integers)", () => {
    expect(detectFrequencyTarget(makeMotorDataset())).toBe("past_claims");
    expect(detectFrequencyTarget(stringsOnlyDataset())).toBeNull();
  });

  test("detectMonetaryColumn: none on the motor shape, found when paid exists", () => {
    const motor = makeMotorDataset();
    expect(detectMonetaryColumn(motor)).toBeNull();
    const withPaid: Dataset = {
      ...motor,
      columns: [...motor.columns, "paid"],
      rows: motor.rows.map((r, i) => ({ ...r, paid: 1000 + i })),
    };
    expect(detectMonetaryColumn(withPaid)).toBe("paid");
  });

  test("findExposureColumn fuzzy-matches the truncated sum_insurd header", () => {
    expect(findExposureColumn(makeMotorDataset())).toBe("sum_insurd");
    expect(findExposureColumn(stringsOnlyDataset())).toBeNull();
  });

  test("sampleRowsCapped strides evenly and flags the cap", () => {
    const rows: Row[] = Array.from({ length: 1000 }, (_, i) => ({ i }));
    const capped = sampleRowsCapped(rows, 100);
    expect(capped.sampled).toBe(true);
    expect(capped.rows.length).toBe(100);
    expect(capped.rows[0].i).toBe(0);
    expect((capped.rows[99].i as number) > 900).toBe(true);
    const uncapped = sampleRowsCapped(rows, 5000);
    expect(uncapped.sampled).toBe(false);
    expect(uncapped.rows.length).toBe(1000);
  });
});

describe("descriptive runner", () => {
  test("profiles ALL numeric columns, sorted by variance", () => {
    const profiles = profileNumericColumns(makeMotorDataset());
    const names = profiles.map((p) => p.name);
    expect(names).toContain("sum_insurd");
    expect(names).toContain("hp");
    expect(names).toContain("past_claims");
    expect(names).toContain("car_year");
    expect(names).toContain("tar_weight");
    // sum_insurd has by far the widest spread → first
    expect(profiles[0].name).toBe("sum_insurd");
    expect(profiles[0].count).toBe(400);
    expect(profiles[0].sd).toBeGreaterThan(0);
    expect(profiles[0].min).toBeLessThanOrEqual(profiles[0].q1);
    expect(profiles[0].q1).toBeLessThanOrEqual(profiles[0].median);
    expect(profiles[0].median).toBeLessThanOrEqual(profiles[0].q3);
    expect(profiles[0].q3).toBeLessThanOrEqual(profiles[0].max);
  });

  test("runs done over numeric columns with a top-variance table", () => {
    const r = runModel("descriptive", makeMotorDataset());
    expect(r.status).toBe("done");
    expect(r.source).toBe("browser");
    expect(r.headline.label).toBe("mean (sum_insurd)");
    expect(r.headline.value).toBeGreaterThan(0);
    expect(r.tableSpec?.rows.length).toBeLessThanOrEqual(5);
    // nothing silently dropped: remaining numerics are listed by name
    const also = r.secondary.find((s) => s.label === "also numeric");
    const tableCols = (r.tableSpec?.rows ?? []).map((row) => row[0]);
    if (also) {
      for (const name of ["car_year", "hp", "tar_weight", "past_claims", "sum_insurd"]) {
        expect(tableCols.includes(name) || also.value.includes(name)).toBe(true);
      }
    }
  });

  test("unsupported when no numeric values exist", () => {
    const r = runModel("descriptive", stringsOnlyDataset());
    expect(r.status).toBe("error");
    expect(r.error).toContain("numeric");
  });

  test("row count honours the importer's sampled / sourceTotalRows contract", () => {
    const sampled = {
      ...makeMotorDataset(),
      sampled: true,
      sourceTotalRows: 2_000_000,
    } as Dataset;
    const r = runModel("descriptive", sampled);
    expect(r.secondary.find((s) => s.label === "rows")?.value).toBe("400 sampled of 2,000,000");
  });
});

describe("GLM runners", () => {
  test("frequency detects covariates + past_claims target, labels the approximation", () => {
    const r = runModel("glm-frequency", makeMotorDataset());
    expect(r.status).toBe("done");
    expect(r.headline.label).toContain("(in-browser approximation)");
    expect(r.headline.label).toContain("past_claims");
    expect(r.detail?.target).toBe("past_claims");
    // mean of uniform ints 0..4 ≈ 2
    expect(r.headline.value).toBeGreaterThan(1);
    expect(r.headline.value).toBeLessThan(3);
  });

  test("frequency unsupported without a count-like target", () => {
    const motor = makeMotorDataset();
    const noCounts: Dataset = {
      ...motor,
      columns: motor.columns.filter((c) => c !== "past_claims"),
      rows: motor.rows.map(({ past_claims: _drop, ...rest }) => rest),
    };
    const r = runModel("glm-frequency", noCounts);
    expect(r.status).toBe("error");
    expect(r.error).toContain("count-like");
  });

  test("severity unsupported without a monetary column, done with one", () => {
    const motor = makeMotorDataset();
    const r = runModel("glm-severity", motor);
    expect(r.status).toBe("error");
    expect(r.error).toContain("monetary");
    const withPaid: Dataset = {
      ...motor,
      columns: [...motor.columns, "paid"],
      rows: motor.rows.map((row, i) => ({ ...row, paid: 500 + (i % 7) * 250 })),
    };
    const done = runModel("glm-severity", withPaid);
    expect(done.status).toBe("done");
    expect(done.headline.label).toContain("(in-browser approximation)");
    expect(done.headline.value).toBeGreaterThan(0);
  });
});

describe("GBM / SHAP approximations", () => {
  test("GBM headline is labelled as an approximation", () => {
    const r = runModel("gbm", makeMotorDataset());
    expect(r.status).toBe("done");
    expect(r.headline.label).toContain("(in-browser approximation)");
  });

  test("SHAP uses the dataset's own factors and labels the approximation", () => {
    const r = runModel("shap", makeMotorDataset());
    expect(r.status).toBe("done");
    expect(r.headline.label).toContain("(in-browser approximation)");
    expect(r.series?.x.length).toBeGreaterThan(0);
  });

  test("SHAP unsupported when no candidate columns match", () => {
    const numericOnly: Dataset = {
      name: "nums.csv",
      columns: ["a", "b"],
      rows: Array.from({ length: 30 }, (_, i) => ({ a: i, b: i * 2 })),
    };
    const r = runModel("shap", numericOnly);
    expect(r.status).toBe("error");
    expect(r.error).toContain("No candidate feature columns");
  });
});

describe("climate runners", () => {
  test("climada falls back to sum_insurd exposure", () => {
    const r = runModel("climada", makeMotorDataset());
    expect(r.status).toBe("done");
    expect(r.headline.label).toContain("AAL");
    expect(r.headline.value).toBeGreaterThan(0);
    expect(r.secondary.find((s) => s.label === "exposure column")?.value).toBe("sum_insurd");
  });

  test("climada unsupported when the exposure sum is zero or absent", () => {
    const motor = makeMotorDataset();
    const zeroed: Dataset = {
      ...motor,
      rows: motor.rows.map((row) => ({ ...row, sum_insurd: 0 })),
    };
    const rZero = runModel("climada", zeroed);
    expect(rZero.status).toBe("error");
    expect(rZero.error).toContain("zero");
    const rNone = runModel("climada", stringsOnlyDataset());
    expect(rNone.status).toBe("error");
    expect(rNone.error).toContain("exposure");
  });

  test("parametric-design refuses to fabricate a trigger without a loss column", () => {
    const r = runModel("parametric-design", makeMotorDataset());
    expect(r.status).toBe("error");
    expect(r.error).toContain("loss column");
    const motor = makeMotorDataset();
    const withPaid: Dataset = {
      ...motor,
      columns: [...motor.columns, "paid"],
      rows: motor.rows.map((row, i) => ({ ...row, paid: 100 + i })),
    };
    const done = runModel("parametric-design", withPaid);
    expect(done.status).toBe("done");
    expect(done.secondary.find((s) => s.label === "method")?.value).toBe("p90 of paid");
  });
});

describe("dispatcher provenance", () => {
  test("runModel tags every result as in-browser", () => {
    for (const id of ["descriptive", "gbm", "climada", "glm-frequency"]) {
      expect(runModel(id, makeMotorDataset()).source).toBe("browser");
    }
  });

  test("bridged model ids cover the wired bridges", () => {
    for (const id of ["climada", "glm-frequency", "glm-severity", "bootstrap-ibnr"]) {
      expect(BRIDGED_MODEL_IDS.has(id)).toBe(true);
    }
    expect(BRIDGED_MODEL_IDS.has("gbm")).toBe(false);
  });
});
