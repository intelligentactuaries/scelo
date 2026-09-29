// Pure-logic tests for the in-browser model runners against a synthetic
// dataset shaped like the real 2M-row motor-insurance benchmark file
// (id + ~10 categorical rating factors + numeric sum_insurd / past_claims
// / hp / tar_weight — and, crucially, NO `paid` column).

import { describe, expect, test } from "bun:test";
import { type Dataset, type Row, buildWorkspaceDemo } from "@scelo/core";
import {
  BRIDGED_MODEL_IDS,
  type RunResult,
  comparableKey,
  detectCategoricalCovariates,
  detectFrequencyTarget,
  detectModelFeatures,
  detectModelTarget,
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

  test("severity headline is claim-weighted, not an average of group means", () => {
    // 9 claims of 100 in "a", 1 claim of 1,000 in "b": mean severity is
    // (900 + 1000) / 10 = 190. The old average-of-group-means said 550.
    const rows: Row[] = [
      ...Array.from({ length: 9 }, () => ({ segment: "a", paid: 100 })),
      { segment: "b", paid: 1000 },
    ];
    const ds: Dataset = { name: "sev.csv", columns: ["segment", "paid"], rows };
    const r = runModel("glm-severity", ds);
    expect(r.status).toBe("done");
    expect(r.headline.value).toBeCloseTo(190, 9);
  });
});

describe("GBM / SHAP · fitted, holdout-scored, exactly attributed", () => {
  test("GBM fits the claim count and reports an honest holdout metric", () => {
    // past_claims is pure noise in this fixture — a real model must NOT
    // manufacture skill from it (the old mock printed AUC 0.8 regardless).
    const r = runModel("gbm", makeMotorDataset());
    expect(r.status).toBe("done");
    expect(r.source).toBe("browser");
    expect(r.headline.label).toContain("(holdout)");
    expect(r.headline.label).toContain("past_claims");
    expect(r.detail?.targetKind).toBe("count");
    expect(Number.isFinite(r.headline.value)).toBe(true);
    expect(r.headline.value).toBeLessThan(0.1);
    const imp = r.detail?.importances as Array<{ feature: string; weight: number }>;
    expect(imp.length).toBeGreaterThan(0);
    expect(imp.reduce((s, i) => s + i.weight, 0)).toBeCloseTo(1, 9);
    expect(r.series?.x[0]).toBe("D1"); // holdout lift by predicted decile
  });

  test("the reported case: SHAP on the all-numeric workspace demo finds the real drivers", () => {
    // Screenshot 2026-09-29: SHAP errored ("need categorical columns") on
    // this sample, and GBM showed a made-up AUC 0.920. survival_to_80 is
    // 0.7·trend + 1.1·smoking − 0.3·trend² + noise — the attribution must say so.
    const demo = buildWorkspaceDemo();
    const gbm = runModel("gbm", demo);
    expect(gbm.status).toBe("done");
    expect(gbm.detail?.target).toBe("survival_to_80");
    expect(gbm.headline.label).toContain("R² (holdout)");
    expect(gbm.headline.value).toBeGreaterThan(0.9);
    const shap = runModel("shap", demo);
    expect(shap.status).toBe("done");
    const ranked = (shap.detail?.importances as Array<{ feature: string }>).map((i) => i.feature);
    expect(ranked.slice(0, 2).sort()).toEqual(["mortality_trend", "smoking_index"]);
    expect(shap.headline.label).toBe(`mean |SHAP| share · ${ranked[0]}`);
    expect(shap.secondary[0]?.label.startsWith(ranked[0])).toBe(true);
    // Ten high-variance nuisance columns carry next to nothing.
    const w = shap.detail?.importances as Array<{ feature: string; weight: number }>;
    const nuisance = w.filter((i) =>
      ["premium_band", "web_logins", "survey_score"].includes(i.feature),
    );
    for (const i of nuisance) expect(i.weight).toBeLessThan(0.02);
  });

  test("SHAP refuses, with the reason, when there is nothing to fit", () => {
    const numericOnly: Dataset = {
      name: "nums.csv",
      columns: ["a", "b"],
      rows: Array.from({ length: 30 }, (_, i) => ({ a: i, b: i * 2 })),
    };
    const r = runModel("shap", numericOnly);
    expect(r.status).toBe("error");
    expect(r.error).toContain("need at least 50");
  });
});

describe("GBM target + feature detection", () => {
  test("a monetary column wins; its claims siblings are dropped as leakage", () => {
    const motor = makeMotorDataset();
    const ds: Dataset = {
      ...motor,
      columns: [...motor.columns, "paid", "incurred"],
      rows: motor.rows.map((r, i) => ({ ...r, paid: 1000 + (i % 13) * 70, incurred: 1200 + i })),
    };
    const target = detectModelTarget(ds);
    expect(target?.column).toBe("paid");
    expect(target?.kind).toBe("continuous");
    const feats = detectModelFeatures(ds, target as NonNullable<typeof target>).map((f) => f.name);
    expect(feats).not.toContain("paid");
    expect(feats).not.toContain("incurred"); // incurred ≈ paid + case reserve
    expect(feats).not.toContain("past_claims");
    expect(feats).not.toContain("id");
    expect(feats).toContain("province");
    expect(feats).toContain("hp");
  });

  test("a 0/1 outcome column becomes a binary target", () => {
    const ds: Dataset = {
      name: "lapse.csv",
      columns: ["age", "premium_band", "lapsed"],
      rows: Array.from({ length: 80 }, (_, i) => ({
        age: 20 + (i % 50),
        premium_band: i % 4,
        lapsed: i % 3 === 0 ? 1 : 0,
      })),
    };
    expect(detectModelTarget(ds)).toMatchObject({ column: "lapsed", kind: "binary" });
  });

  test("otherwise the last numeric column, and the card says why", () => {
    const t = detectModelTarget(buildWorkspaceDemo());
    expect(t?.column).toBe("survival_to_80");
    expect(t?.reason).toContain("last numeric column");
    expect(t?.claimsOutcome).toBe(false);
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

describe("comparableKey · which runs share an estimates axis", () => {
  const run = (modelId: string, family: RunResult["family"], label: string): RunResult => ({
    modelId,
    family,
    status: "done",
    startedAt: 0,
    headline: { label, value: 1 },
    secondary: [],
    blurb: "",
  });

  test("every reserving reserve estimate groups together, whatever its label", () => {
    // In-browser labels AND the bridged ones — distinct strings, one quantity.
    const keys = [
      run("chain-ladder", "reserving", "IBNR"),
      run("mack", "reserving", "IBNR"),
      run("bornhuetter-ferguson", "reserving", "BF reserve"),
      run("bootstrap-ibnr", "reserving", "IBNR p50"),
      run("bootstrap-ibnr", "reserving", "IBNR mean"),
    ].map(comparableKey);
    expect(new Set(keys).size).toBe(1);
  });

  test("other families keep grouping by their own headline", () => {
    expect(comparableKey(run("lee-carter", "mortality", "q(65) in 2035"))).toBe("q(65) in 2035");
    expect(comparableKey(run("chain-ladder", "reserving", "IBNR"))).not.toBe(
      comparableKey(run("scr-standard", "capital", "SCR")),
    );
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

  test("Mack SE is a sane fraction of the reserve, not a blow-up", () => {
    // Regression: the pre-2026-08 SE formula mixed Mack's C-weighted σ_k
    // (√currency units) into a dimensionless ratio and re-scaled by IBNR,
    // producing SEs ~20× the reserve (a 2000% CV) that blew the forest
    // plot's axis to ±60m. The real Mack (1993) mse must keep the CV in a
    // plausible band on this well-behaved synthetic triangle.
    const mack = runModel("mack", triangle);
    expect(mack.status).toBe("done");
    const se = mack.detail?.se as number;
    const cv = mack.detail?.cv as number;
    const ibnr = mack.headline.value;
    expect(Number.isFinite(se)).toBe(true);
    expect(se).toBeGreaterThan(0);
    // SE must not exceed the reserve itself on clean synthetic data —
    // the broken formula produced se ≈ 20 × ibnr.
    expect(se).toBeLessThan(ibnr);
    expect(cv).toBeGreaterThan(0);
    expect(cv).toBeLessThan(1);
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

  test("SHAP explains the wired GBM's own fitted trees", () => {
    const gbm = runModel("gbm", motor);
    const importances = gbm.detail?.importances as Array<{ feature: string; weight: number }>;
    expect(Array.isArray(importances)).toBe(true);
    expect(importances.length).toBeGreaterThan(0);
    const shap = runModel("shap", motor, new Map([["gbm", gbm]]));
    expect(shap.wiredFrom?.[0]?.id).toBe("gbm");
    expect(shap.detail?.source).toBe("wired-gbm");
    expect(shap.secondary[0]?.label.startsWith(importances[0]?.feature ?? "?")).toBe(true);
    // Standalone SHAP refits the same deterministic model: same attribution,
    // only the provenance differs.
    const alone = runModel("shap", motor);
    expect(alone.wiredFrom).toBeUndefined();
    expect(alone.detail?.importances).toEqual(shap.detail?.importances);
  });

  test("the reported case: no mortality table → no Lee–Carter / CBD / annuity numbers", () => {
    // Screenshot 2026-09-29 23:05 — on the workspace demo the canvas showed
    // q(65) 0.00951 and a₆₅ 8.65 as completed results, from canned rates.
    const demo = buildWorkspaceDemo();
    const lc = runModel("lee-carter", demo);
    expect(lc.status).toBe("error");
    // Not applicable — its inputs are absent — which the canvas shows
    // neutrally, NOT as a failure.
    expect(lc.notApplicable).toBe(true);
    expect(lc.error?.startsWith("Needs a mortality table")).toBe(true);
    expect(runModel("cbd", demo).status).toBe("error");
    const annuity = runModel("lifecontingencies", demo, new Map([["lee-carter", lc]]));
    expect(annuity.status).toBe("error"); // a FAILED wired Lee–Carter feeds nothing
    expect(annuity.notApplicable).toBe(true);
    expect(annuity.error?.startsWith("Needs a mortality table")).toBe(true);
  });

  test("life contingencies price a real table, and the wired Lee–Carter COHORT", () => {
    // Gompertz-like table falling 1.5% a year: 1995–2019 × ages 40–100.
    const rows: Row[] = [];
    for (let year = 1995; year <= 2019; year++) {
      for (let age = 40; age <= 100; age++) {
        rows.push({
          year,
          age,
          qx: Math.min(0.9, 0.00005 * Math.exp(0.1 * age) * 0.985 ** (year - 1995)),
        });
      }
    }
    const table: Dataset = { name: "hmd.csv", columns: ["year", "age", "qx"], rows };
    const lc = runModel("lee-carter", table);
    expect(lc.status).toBe("done");
    expect(lc.headline.label).toBe("q(65) in 2029");
    const standalone = runModel("lifecontingencies", table);
    expect(standalone.status).toBe("done");
    expect(standalone.detail?.mortalitySource).toBe("table");
    expect(standalone.wiredFrom).toBeUndefined();
    const wired = runModel("lifecontingencies", table, new Map([["lee-carter", lc]]));
    expect(wired.detail?.mortalitySource).toBe("lee-carter");
    expect(wired.wiredFrom?.[0]?.id).toBe("lee-carter");
    // The projected cohort keeps improving, so it lives longer than the
    // 2019 period table says: a dearer annuity.
    expect(wired.headline.value).toBeGreaterThan(standalone.headline.value);
    // The cohort meets q(65) in 2020, q(66) in 2021, … — never one age's path.
    const q = wired.detail?.q as number[];
    expect(q.length).toBe(10);
    expect(q[9]).toBeGreaterThan(q[0]);
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
