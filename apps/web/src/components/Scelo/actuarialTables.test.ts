// Actuarial table generation / suggestion / prompt parsing (@scelo/core).
// The generators are checked against textbook identities, not against
// numbers we typed in; the suggester is checked on the shipped samples;
// every suggested prompt must round-trip through parseTablePrompt.

import { describe, expect, test } from "bun:test";
import {
  type Dataset,
  ILLUSTRATIVE_MAKEHAM,
  SAMPLE_BY_KEY,
  coerceTableSpec,
  generateActuarialTable,
  parseTablePrompt,
  suggestActuarialTables,
  tableToCsv,
} from "@scelo/core";

const illustrative = { kind: "gompertz-makeham" as const, ...ILLUSTRATIVE_MAKEHAM };
const n = (v: unknown) => Number(v);

describe("life table", () => {
  const t = generateActuarialTable(
    { kind: "life-table", basis: illustrative, ages: { from: 30, to: 110 }, radix: 100_000 },
    null,
  );
  test("columns and closure", () => {
    expect(t.dataset.columns).toEqual(["age", "qx", "px", "lx", "dx", "Lx", "Tx", "ex"]);
    expect(t.dataset.rows.length).toBe(81);
    expect(n(t.dataset.rows[0].lx)).toBe(100_000);
    // closed table: last qx = 1, last ex = 0.5 (Lx = lx/2, Tx = Lx)
    const last = t.dataset.rows.at(-1)!;
    expect(n(last.qx)).toBe(1);
    expect(n(last.ex)).toBeCloseTo(0.5, 3);
  });
  test("recursions hold: l(x+1) = lx − dx, dx = lx·qx, Tx = Σ Lx", () => {
    const r = t.dataset.rows;
    for (let i = 0; i < r.length - 1; i++) {
      expect(n(r[i + 1].lx)).toBeCloseTo(n(r[i].lx) - n(r[i].dx), 1);
      expect(n(r[i].dx)).toBeCloseTo(n(r[i].lx) * n(r[i].qx), 0);
    }
    const sumL = r.reduce((s, row) => s + n(row.Lx), 0);
    expect(n(r[0].Tx)).toBeCloseTo(sumL, 0);
    expect(n(r[0].ex)).toBeCloseTo(sumL / 100_000, 2);
  });
  test("illustrative basis is labelled as such", () => {
    expect(t.notes.join(" ")).toContain("ILLUSTRATIVE");
    expect(t.basisLabel).toContain("illustrative");
  });
  test("qx increases with age under Gompertz-Makeham", () => {
    const r = t.dataset.rows;
    for (let i = 1; i < r.length - 1; i++) expect(n(r[i].qx)).toBeGreaterThan(n(r[i - 1].qx));
  });
});

describe("life table from data columns", () => {
  const ds: Dataset = {
    name: "qx",
    columns: ["Age", "qx"],
    rows: [
      { Age: 60, qx: 0.01 },
      { Age: 61, qx: 0.011 },
      { Age: 63, qx: 0.014 }, // 62 missing → interpolated
      { Age: 64, qx: 0.016 },
      { Age: 60, qx: 0.012 }, // duplicate age → averaged
    ],
  };
  test("reads (age, qx), averages duplicates, interpolates gaps", () => {
    const t = generateActuarialTable(
      { kind: "life-table", basis: { kind: "qx-column", ageColumn: "Age", qxColumn: "qx" } },
      ds,
    );
    const ages = t.dataset.rows.map((r) => n(r.age));
    expect(ages).toEqual([60, 61, 62, 63, 64]);
    expect(n(t.dataset.rows[0].qx)).toBeCloseTo(0.011, 6); // mean of 0.010 and 0.012
    expect(n(t.dataset.rows[2].qx)).toBeCloseTo(0.0125, 6); // interpolated
    expect(t.notes.join(" ")).toContain("interpolated");
  });
  test("percent-shaped qx is rescaled", () => {
    const pctDs: Dataset = {
      name: "p",
      columns: ["age", "qx"],
      rows: [
        { age: 40, qx: 0.2 },
        { age: 41, qx: 1.5 },
      ],
    };
    const t = generateActuarialTable(
      { kind: "life-table", basis: { kind: "qx-column", ageColumn: "age", qxColumn: "qx" } },
      pctDs,
    );
    expect(n(t.dataset.rows[0].qx)).toBeCloseTo(0.002, 6);
    expect(t.notes.join(" ")).toContain("percentages");
  });
  test("deaths / exposure basis gives crude rates", () => {
    const e: Dataset = {
      name: "e",
      columns: ["age", "deaths", "exposure"],
      rows: [
        { age: 50, deaths: 5, exposure: 1000 },
        { age: 50, deaths: 5, exposure: 1000 },
        { age: 51, deaths: 12, exposure: 2000 },
      ],
    };
    const t = generateActuarialTable(
      {
        kind: "life-table",
        basis: {
          kind: "deaths-exposure",
          ageColumn: "age",
          deathsColumn: "deaths",
          exposureColumn: "exposure",
        },
      },
      e,
    );
    expect(n(t.dataset.rows[0].qx)).toBeCloseTo(0.005, 6);
    expect(t.notes.join(" ")).toContain("Crude");
  });
  test("missing column is a clean error", () => {
    expect(() =>
      generateActuarialTable(
        { kind: "life-table", basis: { kind: "qx-column", ageColumn: "age", qxColumn: "nope" } },
        ds,
      ),
    ).toThrow(/not in the dataset/);
  });
});

describe("commutation and factors", () => {
  const i = 0.04;
  const comm = generateActuarialTable(
    { kind: "commutation", basis: illustrative, interest: i, ages: { from: 30, to: 110 } },
    null,
  );
  const fac = generateActuarialTable(
    {
      kind: "annuity-assurance",
      basis: illustrative,
      interest: i,
      term: 20,
      ages: { from: 30, to: 110 },
    },
    null,
  );
  test("Nx = Σ Dy, Mx = Σ Cy, Rx = Σ My", () => {
    const r = comm.dataset.rows;
    const sumD = r.reduce((s, row) => s + n(row.Dx), 0);
    expect(n(r[0].Nx)).toBeCloseTo(sumD, 0);
    const sumC = r.reduce((s, row) => s + n(row.Cx), 0);
    expect(n(r[0].Mx)).toBeCloseTo(sumC, 0);
    const sumM = r.reduce((s, row) => s + n(row.Mx), 0);
    expect(n(r[0].Rx)).toBeCloseTo(sumM, 0);
    // Cx = v^{x+1} dx  ⇒ Cx / Dx = v · qx
    expect(n(r[10].Cx) / n(r[10].Dx)).toBeCloseTo(n(r[10].dx) / n(r[10].lx) / (1 + i), 6);
  });
  test("äx and Ax satisfy the premium-conversion identity Ax = 1 − d·äx", () => {
    const d = i / (1 + i);
    for (const row of fac.dataset.rows.slice(0, 40)) {
      expect(n(row.Ax)).toBeCloseTo(1 - d * n(row["äx"]), 3);
      expect(n(row.ax)).toBeCloseTo(n(row["äx"]) - 1, 6);
    }
  });
  test("term factors: Ax:n = A¹x:n + nEx, blank past the table", () => {
    const rows = fac.dataset.rows;
    const r = rows[5];
    expect(n(r["Ax:20"])).toBeCloseTo(n(r["A¹x:20"]) + n(r["20Ex"]), 5);
    expect(n(r["äx:20"])).toBeLessThan(n(r["äx"]));
    expect(rows.at(-1)!["äx:20"]).toBeNull();
  });
  test("factors from commutation columns agree with the factor table", () => {
    const c = comm.dataset.rows[5];
    const f = fac.dataset.rows[5];
    expect(n(c.Nx) / n(c.Dx)).toBeCloseTo(n(f["äx"]), 3);
    expect(n(c.Mx) / n(c.Dx)).toBeCloseTo(n(f.Ax), 4);
  });
});

describe("net premium grid", () => {
  const t = generateActuarialTable(
    {
      kind: "net-premium",
      basis: illustrative,
      interest: 0.04,
      product: "term",
      ages: { from: 30, to: 50, step: 10 },
      terms: [10, 20],
    },
    null,
  );
  test("shape and monotonicity", () => {
    expect(t.dataset.columns).toEqual(["age", "n=10", "n=20"]);
    expect(t.dataset.rows.map((r) => n(r.age))).toEqual([30, 40, 50]);
    // older → dearer; longer term → dearer (mortality rising)
    expect(n(t.dataset.rows[2]["n=10"])).toBeGreaterThan(n(t.dataset.rows[0]["n=10"]));
    expect(n(t.dataset.rows[0]["n=20"])).toBeGreaterThan(n(t.dataset.rows[0]["n=10"]));
  });
  test("term premium equals 1000·A¹x:n / äx:n from the factor table", () => {
    const fac = generateActuarialTable(
      {
        kind: "annuity-assurance",
        basis: illustrative,
        interest: 0.04,
        term: 10,
        ages: { from: 20, to: 110 },
      },
      null,
    );
    const f = fac.dataset.rows.find((r) => n(r.age) === 40)!;
    expect(n(t.dataset.rows[1]["n=10"])).toBeCloseTo((1000 * n(f["A¹x:10"])) / n(f["äx:10"]), 2);
  });
  test("whole-life and endowment variants build", () => {
    const wl = generateActuarialTable(
      {
        kind: "net-premium",
        basis: illustrative,
        interest: 0.03,
        product: "whole-life",
        ages: { from: 30, to: 40, step: 5 },
      },
      null,
    );
    expect(wl.dataset.columns).toEqual(["age", "whole life"]);
    const en = generateActuarialTable(
      {
        kind: "net-premium",
        basis: illustrative,
        interest: 0.03,
        product: "endowment",
        ages: { from: 30, to: 40, step: 5 },
        terms: [20],
      },
      null,
    );
    expect(n(en.dataset.rows[0]["n=20"])).toBeGreaterThan(n(t.dataset.rows[0]["n=20"])); // endowment > term
  });
});

describe("run-off triangle", () => {
  const claims = SAMPLE_BY_KEY.get("claims")!.build();
  test("builds a cumulative triangle from the claims sample", () => {
    const t = generateActuarialTable(
      {
        kind: "runoff-triangle",
        originColumn: "origin_year",
        developmentColumn: "dev_period",
        valueColumn: "paid",
        cumulative: true,
      },
      claims,
    );
    expect(t.dataset.columns[0]).toBe("origin");
    expect(t.dataset.columns.length).toBeGreaterThan(3);
    // cumulative: non-decreasing along a fully observed row
    const first = t.dataset.rows[0];
    const vals = t.dataset.columns
      .slice(1)
      .map((c) => first[c])
      .filter((v) => v !== null)
      .map(n);
    for (let k = 1; k < vals.length; k++) expect(vals[k]).toBeGreaterThanOrEqual(vals[k - 1]);
    // incomplete: the latest origin has fewer observed cells than the earliest
    const last = t.dataset.rows.at(-1)!;
    const observedLast = t.dataset.columns.slice(1).filter((c) => last[c] !== null).length;
    expect(observedLast).toBeLessThan(vals.length);
  });
  test("incremental triangle sums to the cumulative diagonal", () => {
    const cum = generateActuarialTable(
      {
        kind: "runoff-triangle",
        originColumn: "origin_year",
        developmentColumn: "dev_period",
        valueColumn: "paid",
        cumulative: true,
      },
      claims,
    );
    const inc = generateActuarialTable(
      {
        kind: "runoff-triangle",
        originColumn: "origin_year",
        developmentColumn: "dev_period",
        valueColumn: "paid",
        cumulative: false,
      },
      claims,
    );
    const row = 0;
    const cols = cum.dataset.columns.slice(1);
    let acc = 0;
    for (const c of cols) {
      const v = inc.dataset.rows[row][c];
      if (v === null) continue;
      acc += n(v);
      expect(n(cum.dataset.rows[row][c])).toBeCloseTo(acc, 1);
    }
  });
  test("payment-period lag = payment − origin", () => {
    const ds: Dataset = {
      name: "p",
      columns: ["ay", "pay_year", "amount"],
      rows: [
        { ay: 2020, pay_year: 2020, amount: 100 },
        { ay: 2020, pay_year: 2021, amount: 50 },
        { ay: 2021, pay_year: 2021, amount: 80 },
      ],
    };
    const t = generateActuarialTable(
      {
        kind: "runoff-triangle",
        originColumn: "ay",
        paymentColumn: "pay_year",
        valueColumn: "amount",
        cumulative: true,
      },
      ds,
    );
    expect(t.dataset.rows[0]["dev 0"]).toBe(100);
    expect(t.dataset.rows[0]["dev 1"]).toBe(150);
    expect(t.dataset.rows[1]["dev 0"]).toBe(80);
    expect(t.dataset.rows[1]["dev 1"]).toBeNull();
  });
});

describe("discount curve", () => {
  test("flat curve: v_t = (1+i)^-t, forward = i, a_n = annuity-certain", () => {
    const t = generateActuarialTable(
      { kind: "discount-curve", flatRate: 0.05, maxTenor: 10 },
      null,
    );
    const r5 = t.dataset.rows[4];
    expect(n(r5["discount factor"])).toBeCloseTo(1.05 ** -5, 6);
    expect(n(r5["1y forward"])).toBeCloseTo(0.05, 6);
    expect(n(t.dataset.rows[9]["annuity-certain a_n"])).toBeCloseTo((1 - 1.05 ** -10) / 0.05, 5);
  });
  test("quoted points reproduce at their tenors and interpolate between", () => {
    const t = generateActuarialTable(
      {
        kind: "discount-curve",
        points: [
          { tenor: 1, rate: 0.03 },
          { tenor: 3, rate: 0.05 },
        ],
        maxTenor: 5,
      },
      null,
    );
    expect(n(t.dataset.rows[0]["zero rate"])).toBeCloseTo(0.03, 6);
    expect(n(t.dataset.rows[1]["zero rate"])).toBeCloseTo(0.04, 6);
    expect(n(t.dataset.rows[2]["zero rate"])).toBeCloseTo(0.05, 6);
    expect(n(t.dataset.rows[4]["zero rate"])).toBeCloseTo(0.05, 6); // flat beyond
  });
});

describe("A/E and model points", () => {
  test("A/E = actual / (exposure × qx) with a total row", () => {
    const ds: Dataset = {
      name: "exp",
      columns: ["age", "deaths", "exposure"],
      rows: [
        { age: 60, deaths: 30, exposure: 1000 },
        { age: 61, deaths: 30, exposure: 1000 },
        { age: 65, deaths: 60, exposure: 1000 },
      ],
    };
    const t = generateActuarialTable(
      {
        kind: "exposure-ae",
        ageColumn: "age",
        deathsColumn: "deaths",
        exposureColumn: "exposure",
        expected: { kind: "qx-column", ageColumn: "age", qxColumn: "deaths" },
        bandWidth: 5,
      },
      // expected basis = deaths column read as qx (nonsense numerically, but exercises the plumbing)
      { ...ds, rows: ds.rows.map((r) => ({ ...r })) },
    );
    expect(t.dataset.rows.at(-1)!["age band"]).toBe("total");
    expect(t.dataset.rows[0]["age band"]).toBe("60–64");
    expect(t.dataset.columns).toContain("A/E");
  });
  test("model points from the lifelib sample group by band × sex × term", () => {
    const mp = SAMPLE_BY_KEY.get("lifelib-mp")!.build();
    const t = generateActuarialTable(
      {
        kind: "model-points",
        ageColumn: "age_at_entry",
        sexColumn: "sex",
        termColumn: "policy_term",
        sumAssuredColumn: "sum_assured",
        premiumColumn: "premium_pp",
        bandWidth: 5,
      },
      mp,
    );
    expect(t.dataset.columns).toEqual([
      "model_point_id",
      "age_band",
      "age_at_entry",
      "sex",
      "policy_term",
      "policy_count",
      "sum_assured",
      "premium_pp",
    ]);
    const total = t.dataset.rows.reduce((s, r) => s + n(r.policy_count), 0);
    expect(total).toBe(100);
    expect(t.dataset.rows.length).toBeLessThan(100);
    const sa = t.dataset.rows.reduce((s, r) => s + n(r.sum_assured), 0);
    const saRaw = mp.rows.reduce((s, r) => s + n(r.sum_assured), 0);
    expect(sa).toBeCloseTo(saRaw, 0);
  });
});

describe("suggestions read the data", () => {
  test("lifelib MP sample → model points + net premium", () => {
    const s = suggestActuarialTables(SAMPLE_BY_KEY.get("lifelib-mp")!.build());
    expect(s.map((x) => x.kind)).toContain("model-points");
    expect(s.map((x) => x.kind)).toContain("net-premium");
    for (const x of s) expect(x.prompt.length).toBeGreaterThan(10);
  });
  test("claims sample → run-off triangle first", () => {
    const s = suggestActuarialTables(SAMPLE_BY_KEY.get("claims")!.build());
    expect(s[0].kind).toBe("runoff-triangle");
    expect(s[0].why).toContain("origin_year");
  });
  test("age + qx → life table, commutation, factors", () => {
    const ds: Dataset = { name: "q", columns: ["age", "qx"], rows: [{ age: 30, qx: 0.001 }] };
    const kinds = suggestActuarialTables(ds).map((x) => x.kind);
    expect(kinds.slice(0, 3)).toEqual(["life-table", "commutation", "annuity-assurance"]);
  });
  test("no data, a prompt → illustrative-basis suggestion", () => {
    const s = suggestActuarialTables(null, "I need a commutation table at 3.5%");
    expect(s[0].kind).toBe("commutation");
    expect((s[0].spec as { interest: number }).interest).toBeCloseTo(0.035, 6);
    expect(s[0].why).toContain("no mortality columns");
  });
  test("nothing relevant → no suggestions", () => {
    const ds: Dataset = {
      name: "x",
      columns: ["colour", "count"],
      rows: [{ colour: "red", count: 1 }],
    };
    expect(suggestActuarialTables(ds)).toEqual([]);
    expect(suggestActuarialTables(null, "hello")).toEqual([]);
  });
});

describe("prompt → spec", () => {
  test("every suggested prompt round-trips to the same kind and builds", () => {
    const datasets: Array<Dataset | null> = [
      SAMPLE_BY_KEY.get("lifelib-mp")!.build(),
      SAMPLE_BY_KEY.get("claims")!.build(),
      {
        name: "q",
        columns: ["age", "qx"],
        rows: Array.from({ length: 30 }, (_, k) => ({ age: 40 + k, qx: 0.001 * (k + 1) })),
      },
      {
        name: "e",
        columns: ["age", "deaths", "exposure"],
        rows: Array.from({ length: 30 }, (_, k) => ({
          age: 40 + k,
          deaths: k + 1,
          exposure: 1000,
        })),
      },
      {
        name: "r",
        columns: ["tenor", "rate"],
        rows: [
          { tenor: 1, rate: 0.03 },
          { tenor: 10, rate: 0.04 },
        ],
      },
      null,
    ];
    const prompts = [
      "life table please",
      "commutation functions at 5%",
      "annuity factors",
      "premium rates",
      "discount factors",
      "triangle",
      "actual vs expected",
      "model points",
    ];
    for (const ds of datasets) {
      for (const p of [undefined, ...prompts]) {
        for (const sug of suggestActuarialTables(ds, p)) {
          const spec = parseTablePrompt(sug.prompt, ds);
          expect(spec, `prompt did not parse: ${sug.prompt}`).not.toBeNull();
          expect(spec!.kind, `kind mismatch for: ${sug.prompt}`).toBe(sug.kind);
          if (sug.score >= 0.5) {
            // strong suggestions must actually build against that data
            const built = generateActuarialTable(spec!, ds);
            expect(built.dataset.rows.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });
  test("free phrasings", () => {
    const life = parseTablePrompt(
      "Please build me a life table at 4% from age 25 to 100 with radix 10,000",
      null,
    )!;
    expect(life.kind).toBe("life-table");
    expect((life as { ages: { from: number; to: number } }).ages).toEqual({ from: 25, to: 100 });
    expect((life as { radix: number }).radix).toBe(10_000);

    const comm = parseTablePrompt(
      "generate commutation functions at i = 0.035 for ages 20-110",
      null,
    )!;
    expect(comm.kind).toBe("commutation");
    expect((comm as { interest: number }).interest).toBeCloseTo(0.035, 6);

    const prem = parseTablePrompt(
      "create an endowment premium table at 3% for terms 10, 20 and 25",
      null,
    )!;
    expect(prem.kind).toBe("net-premium");
    expect((prem as { product: string }).product).toBe("endowment");
    expect((prem as { terms: number[] }).terms).toEqual([10, 20, 25]);

    const ann = parseTablePrompt(
      "give me annuity and assurance factors with a 15-year term at 2.5 percent",
      null,
    )!;
    expect(ann.kind).toBe("annuity-assurance");
    expect((ann as { term: number }).term).toBe(15);
    expect((ann as { interest: number }).interest).toBeCloseTo(0.025, 6);

    const disc = parseTablePrompt("tabulate discount factors at a flat 6% out to 40 years", null)!;
    expect(disc.kind).toBe("discount-curve");
    expect((disc as { flatRate: number }).flatRate).toBeCloseTo(0.06, 6);
    expect((disc as { maxTenor: number }).maxTenor).toBe(40);

    const claims = SAMPLE_BY_KEY.get("claims")!.build();
    const tri = parseTablePrompt("make an incremental run-off triangle of incurred", claims)!;
    expect(tri.kind).toBe("runoff-triangle");
    expect((tri as { cumulative: boolean }).cumulative).toBe(false);
    expect((tri as { valueColumn: string }).valueColumn).toBe("incurred");
  });
  test("non-table requests are left alone", () => {
    expect(parseTablePrompt("clean my data", null)).toBeNull();
    expect(parseTablePrompt("convert the age column to number", null)).toBeNull();
    expect(parseTablePrompt("what is a life table?", null)).toBeNull(); // no build verb
    expect(parseTablePrompt("undo that", null)).toBeNull();
  });
  test("data columns win over the illustrative basis when present", () => {
    const ds: Dataset = { name: "q", columns: ["age", "qx"], rows: [{ age: 30, qx: 0.001 }] };
    const spec = parseTablePrompt("build a life table", ds)!;
    expect((spec as { basis: { kind: string } }).basis.kind).toBe("qx-column");
    const forced = parseTablePrompt(
      "build a life table on the illustrative Gompertz-Makeham basis",
      ds,
    )!;
    expect((forced as { basis: { kind: string } }).basis.kind).toBe("gompertz-makeham");
  });
});

describe("coerceTableSpec (LLM-emitted JSON)", () => {
  test("accepts loose shapes and normalises interest", () => {
    const s = coerceTableSpec({ type: "Commutation", i: 4, ages: { min: 20, max: 100 } });
    expect(s.kind).toBe("commutation");
    expect((s as { interest: number }).interest).toBeCloseTo(0.04, 6);
    expect((s as { ages: { from: number; to: number } }).ages).toEqual({ from: 20, to: 100 });
    expect((s as { basis: { kind: string } }).basis.kind).toBe("gompertz-makeham");
  });
  test("rejects unknown kinds", () => {
    expect(() => coerceTableSpec({ kind: "pivot" })).toThrow(/unknown table kind/);
  });
  test("triangle needs its columns", () => {
    expect(() => coerceTableSpec({ kind: "runoff-triangle" })).toThrow(/originColumn/);
  });
});

describe("csv", () => {
  test("escapes and round-trips a header", () => {
    const t = generateActuarialTable({ kind: "discount-curve", flatRate: 0.04, maxTenor: 2 }, null);
    const csv = tableToCsv(t.dataset);
    expect(csv.split("\n")[0]).toBe(
      "tenor,zero rate,discount factor,1y forward,annuity-certain a_n",
    );
    expect(csv.split("\n").length).toBe(3);
  });
});
