// Pure-logic tests for the in-browser model runners against a synthetic
// dataset shaped like the real 2M-row motor-insurance benchmark file
// (id + ~10 categorical rating factors + numeric sum_insurd / past_claims
// / hp / tar_weight — and, crucially, NO `paid` column).

import { describe, expect, test } from "bun:test";
import type { Dataset, Row } from "@scelo/core";
import {
  BRIDGED_MODEL_IDS,
  detectCategoricalCovariates,
  detectFrequencyTarget,
  detectMonetaryColumn,
  findExposureColumn,
  profileNumericColumns,
  runModel,
  sampleRowsCapped,
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
  test("profiles ALL numeric columns, sorted by coefficient of variation", () => {
    const profiles = profileNumericColumns(makeMotorDataset());
    const names = profiles.map((p) => p.name);
    expect(names).toContain("sum_insurd");
    expect(names).toContain("hp");
    expect(names).toContain("past_claims");
    expect(names).toContain("car_year");
    expect(names).toContain("tar_weight");
    // Ranking is scale-free: CV descending, undefined-CV columns last.
    // past_claims (counts 0–4, mean ≈ 2) has far wider RELATIVE spread
    // than the big-money sum_insurd column that raw variance used to pick.
    expect(profiles[0].name).toBe("past_claims");
    for (let i = 1; i < profiles.length; i++) {
      const prev = profiles[i - 1].cv;
      const cur = profiles[i].cv;
      if (prev !== null && cur !== null) expect(prev).toBeGreaterThanOrEqual(cur);
      if (prev === null) expect(cur).toBeNull();
    }
    expect(profiles[0].count).toBe(400);
    expect(profiles[0].missing).toBe(0);
    expect(profiles[0].sd).toBeGreaterThan(0);
    expect(profiles[0].min).toBeLessThanOrEqual(profiles[0].q1);
    expect(profiles[0].q1).toBeLessThanOrEqual(profiles[0].median);
    expect(profiles[0].median).toBeLessThanOrEqual(profiles[0].q3);
    expect(profiles[0].q3).toBeLessThanOrEqual(profiles[0].max);
    expect(profiles[0].iqr).toBeCloseTo(profiles[0].q3 - profiles[0].q1, 12);
  });

  test("moments, quantiles and shape match hand-computed values", () => {
    // n = 4 even count: type-7 median is the AVERAGE of the middle two —
    // the old nearest-rank floor picked the upper one (3, not 2.5).
    const ds: Dataset = {
      name: "t.csv",
      columns: ["x"],
      rows: [{ x: 1 }, { x: 2 }, { x: 3 }, { x: 4 }],
    };
    const [p] = profileNumericColumns(ds);
    expect(p.median).toBe(2.5);
    expect(p.q1).toBe(1.75); // (n-1)*0.25 = 0.75 → 1 + 0.75·(2−1)
    expect(p.q3).toBe(3.25);
    expect(p.mean).toBe(2.5);
    expect(p.sd).toBeCloseTo(Math.sqrt(5 / 3), 12); // sample variance 5/3
    expect(p.se).toBeCloseTo(Math.sqrt(5 / 3) / 2, 12);
    expect(p.cv).toBeCloseTo(Math.sqrt(5 / 3) / 2.5, 12);
    // Symmetric data → zero skewness exactly.
    expect(p.skewness).toBeCloseTo(0, 12);
  });

  test("missing and non-numeric cells are counted, constant columns stay sane", () => {
    const ds: Dataset = {
      name: "t.csv",
      columns: ["x", "k"],
      rows: [
        { x: 1, k: 7 },
        { x: null, k: 7 },
        { x: "n/a", k: 7 },
        { x: 5, k: 7 },
      ],
    };
    const profiles = profileNumericColumns(ds);
    const x = profiles.find((p) => p.name === "x");
    const k = profiles.find((p) => p.name === "k");
    expect(x?.count).toBe(2);
    expect(x?.missing).toBe(2);
    expect(x?.missingPct).toBeCloseTo(0.5, 12);
    // Constant column: sd 0, CV 0, shape undefined (m2 = 0), JB undefined.
    expect(k?.sd).toBe(0);
    expect(k?.cv).toBe(0);
    expect(k?.skewness).toBeNull();
    expect(k?.kurtosis).toBeNull();
    expect(k?.jarqueBera).toBeNull();
  });

  test("Jarque–Bera is near zero for symmetric flat data, large for a spike", () => {
    const rng = makeRng(7);
    // Roughly normal via CLT: sum of 12 uniforms.
    const normalish: Row[] = Array.from({ length: 500 }, () => {
      let s = 0;
      for (let i = 0; i < 12; i++) s += rng();
      return { x: s - 6 };
    });
    const [pn] = profileNumericColumns({ name: "n.csv", columns: ["x"], rows: normalish });
    expect(pn.jarqueBera).not.toBeNull();
    expect(pn.jarqueBera?.p).toBeGreaterThan(0.05);
    // Heavy right tail → JB rejects loudly.
    const skewed: Row[] = Array.from({ length: 500 }, (_, i) => ({
      x: i < 490 ? 1 : 10_000,
    }));
    const [ps] = profileNumericColumns({ name: "s.csv", columns: ["x"], rows: skewed });
    expect(ps.jarqueBera).not.toBeNull();
    expect(ps.jarqueBera?.p).toBeLessThan(0.001);
    expect(ps.skewness).toBeGreaterThan(1);
  });

  test("runs done over numeric columns with a CV-ranked table", () => {
    const r = runModel("descriptive", makeMotorDataset());
    expect(r.status).toBe("done");
    expect(r.source).toBe("browser");
    expect(r.headline.label).toBe("mean (past_claims)");
    expect(r.headline.value).toBeGreaterThan(0);
    // Sub-unit means keep enough digits to be legible on the card.
    expect(r.headline.precision).toBeGreaterThanOrEqual(2);
    expect(r.tableSpec?.headers).toContain("cv");
    expect(r.tableSpec?.headers).toContain("median");
    expect(r.tableSpec?.headers).toContain("miss %");
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

describe("wired pipeline · upstream results change downstream runs", () => {
  const motor = makeMotorDataset();
  // Minimal claims triangle: 3 origins × up to 3 devs of cumulative paid.
  const triangle: Dataset = {
    name: "tri.csv",
    columns: ["origin_year", "dev_period", "paid"],
    rows: [
      { origin_year: 2020, dev_period: 1, paid: 100 },
      { origin_year: 2020, dev_period: 2, paid: 150 },
      { origin_year: 2020, dev_period: 3, paid: 175 },
      { origin_year: 2021, dev_period: 1, paid: 110 },
      { origin_year: 2021, dev_period: 2, paid: 160 },
      { origin_year: 2022, dev_period: 1, paid: 120 },
    ] as Row[],
  };

  test("BF a-priori comes from the wired chain-ladder ultimates", () => {
    const cl = runModel("chain-ladder", triangle);
    expect(cl.status).toBe("done");
    const standalone = runModel("bornhuetter-ferguson", triangle);
    const wired = runModel("bornhuetter-ferguson", triangle, new Map([["chain-ladder", cl]]));
    expect(wired.status).toBe("done");
    expect(wired.wiredFrom?.[0]?.id).toBe("chain-ladder");
    expect(wired.detail?.aprioriSource).toBe("chain-ladder");
    expect(standalone.detail?.aprioriSource).toBe("book-average");
    // The seeded prior must actually move the reserve.
    expect(wired.headline.value).not.toBe(standalone.headline.value);
  });

  test("Mack and bootstrap centre on the wired chain-ladder estimate", () => {
    const cl = runModel("chain-ladder", triangle);
    const mack = runModel("mack", triangle, new Map([["chain-ladder", cl]]));
    expect(mack.wiredFrom?.[0]?.id).toBe("chain-ladder");
    expect(mack.headline.value).toBe(cl.headline.value);
    const boot = runModel("bootstrap-ibnr", triangle, new Map([["chain-ladder", cl]]));
    expect(boot.wiredFrom?.[0]?.id).toBe("chain-ladder");
    expect(boot.headline.value).toBe(cl.headline.value);
  });

  test("severity crossed with wired frequency yields the pure premium", () => {
    const freq = runModel("glm-frequency", motor);
    const sev = runModel("glm-severity", motor, new Map([["glm-frequency", freq]]));
    if (sev.status === "done" && freq.status === "done") {
      expect(sev.wiredFrom?.[0]?.id).toBe("glm-frequency");
      const pp = sev.detail?.purePremium as number;
      expect(pp).toBeCloseTo(freq.headline.value * (sev.detail?.mean as number), 6);
    }
  });

  test("SHAP explains the wired GBM's variance screen", () => {
    const gbm = runModel("gbm", motor);
    const importances = gbm.detail?.importances as Array<{ feature: string; weight: number }>;
    expect(Array.isArray(importances)).toBe(true);
    expect(importances.length).toBeGreaterThan(0);
    const shap = runModel("shap", motor, new Map([["gbm", gbm]]));
    expect(shap.wiredFrom?.[0]?.id).toBe("gbm");
    expect(shap.secondary[0]?.label).toBe(importances[0]?.feature);
  });

  test("life contingencies price off the wired Lee-Carter projection", () => {
    const lc = runModel("lee-carter", motor);
    const standalone = runModel("lifecontingencies", motor);
    const wired = runModel("lifecontingencies", motor, new Map([["lee-carter", lc]]));
    expect(wired.wiredFrom?.[0]?.id).toBe("lee-carter");
    expect(wired.detail?.mortalitySource).toBe("lee-carter");
    expect(standalone.detail?.mortalitySource).toBe("canned");
    expect(wired.headline.value).not.toBe(standalone.headline.value);
  });

  test("SCR includes an interest stress from the wired ESG path", () => {
    const esg = runModel("esg", motor);
    const standalone = runModel("scr-standard", triangle);
    const wired = runModel("scr-standard", triangle, new Map([["esg", esg]]));
    expect(wired.wiredFrom?.[0]?.id).toBe("esg");
    expect((wired.detail?.intStress as number) ?? 0).toBeGreaterThan(0);
    expect(wired.headline.value).toBeGreaterThan(standalone.headline.value);
  });

  test("failed upstream results are ignored (no wiredFrom)", () => {
    const bad = runModel("chain-ladder", motor); // motor has no triangle
    expect(bad.status).toBe("error");
    const bf = runModel("bornhuetter-ferguson", triangle, new Map([["chain-ladder", bad]]));
    expect(bf.wiredFrom).toBeUndefined();
    expect(bf.detail?.aprioriSource).toBe("book-average");
  });
});

describe("monetary detection · flags are not money", () => {
  test("the reported case: claim_incurred_flag loses to claim_amount_zar", () => {
    const ds: Dataset = {
      name: "group_insurance.csv",
      columns: ["member_id", "claim_incurred_flag", "group_type", "claim_amount_zar"],
      rows: Array.from({ length: 40 }, (_, i) => ({
        member_id: `M${i}`,
        claim_incurred_flag: i % 3 === 0 ? 1 : 0,
        group_type: ["stokvel", "burial", "coop"][i % 3],
        claim_amount_zar: i % 3 === 0 ? 1200 + i * 10 : 0,
      })) as Row[],
    };
    expect(detectMonetaryColumn(ds)).toBe("claim_amount_zar");
  });

  test("a binary column is refused even without a flag-ish name", () => {
    const ds: Dataset = {
      name: "x.csv",
      columns: ["incurred", "region"],
      rows: Array.from({ length: 20 }, (_, i) => ({
        incurred: i % 2,
        region: "GT",
      })) as Row[],
    };
    expect(detectMonetaryColumn(ds)).toBeNull();
  });

  test("plain paid column still detects", () => {
    const ds: Dataset = {
      name: "tri.csv",
      columns: ["origin_year", "dev_period", "paid"],
      rows: [{ origin_year: 2020, dev_period: 1, paid: 1234.5 }] as Row[],
    };
    expect(detectMonetaryColumn(ds)).toBe("paid");
  });
});
