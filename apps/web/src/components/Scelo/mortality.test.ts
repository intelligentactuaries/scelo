// The in-browser mortality engine: table detection, Lee–Carter and CBD fits
// on synthetic tables whose true parameters are known, and the life-
// contingency EPVs by hand.

import { describe, expect, test } from "bun:test";
import { type Dataset, type Row, buildWorkspaceDemo } from "@scelo/core";
import { detectMortalityTable, fitCBD, fitLeeCarter, lifeValues } from "./mortality";

const AGES = Array.from({ length: 41 }, (_, i) => 50 + i); // 50…90
const YEARS = Array.from({ length: 30 }, (_, i) => 1990 + i); // 1990…2019

/** log q = α_x + β_x κ_t exactly, κ falling 1.5 a year. */
function leeCarterTable(): { ds: Dataset; beta: number[]; drift: number } {
  const alpha = AGES.map((x) => -9.5 + 0.095 * x);
  const raw = AGES.map((x) => 1.5 - (x - 50) / 40); // older ages improve more slowly
  const s = raw.reduce((a, b) => a + b, 0);
  const beta = raw.map((b) => b / s);
  const drift = -1.5;
  const kappa = YEARS.map((_, t) => drift * (t - (YEARS.length - 1) / 2));
  const rows: Row[] = [];
  for (const [t, year] of YEARS.entries()) {
    for (const [a, age] of AGES.entries()) {
      rows.push({ year, age, qx: Math.exp(alpha[a] + beta[a] * kappa[t]) });
    }
  }
  return { ds: { name: "lc.csv", columns: ["year", "age", "qx"], rows }, beta, drift };
}

describe("detectMortalityTable", () => {
  test("the reported case: the workspace demo is not a mortality table", () => {
    const r = detectMortalityTable(buildWorkspaceDemo());
    expect("reason" in r).toBe(true);
    if ("reason" in r) expect(r.reason).toContain("has no `age` column");
  });

  test("an age column alone is not enough", () => {
    const ds: Dataset = {
      name: "claims.csv",
      columns: ["age", "paid"],
      rows: [{ age: 40, paid: 100 }],
    };
    const r = detectMortalityTable(ds);
    expect("reason" in r && r.reason).toContain("has `age` but no death rates");
  });

  test("deaths / exposure become q = 1 − exp(−D/E), pooled per cell", () => {
    const ds: Dataset = {
      name: "de.csv",
      columns: ["year", "age", "deaths", "exposure"],
      rows: [
        { year: 2020, age: 70, deaths: 10, exposure: 400 },
        { year: 2020, age: 70, deaths: 10, exposure: 600 }, // pooled: 20 / 1000
        { year: 2020, age: 71, deaths: 30, exposure: 1000 },
      ],
    };
    const r = detectMortalityTable(ds);
    if ("reason" in r) throw new Error(r.reason);
    expect(r.table.basis).toBe("deaths / exposure");
    expect(r.table.q[0][0]).toBeCloseTo(1 - Math.exp(-0.02), 12);
    expect(r.table.q[0][1]).toBeCloseTo(1 - Math.exp(-0.03), 12);
  });
});

describe("fitLeeCarter", () => {
  test("recovers β, the κ drift and the projection on an exact Lee–Carter table", () => {
    const { ds, beta, drift } = leeCarterTable();
    const found = detectMortalityTable(ds);
    if ("reason" in found) throw new Error(found.reason);
    const fit = fitLeeCarter(found.table);
    if ("reason" in fit) throw new Error(fit.reason);
    expect(fit.drift).toBeCloseTo(drift, 9);
    for (let a = 0; a < beta.length; a++) expect(fit.beta[a]).toBeCloseTo(beta[a], 9);
    expect(fit.explained).toBeCloseTo(1, 9); // rank-1 exactly
    expect(fit.headlineAge).toBe(65);
    expect(fit.projYears[0]).toBe(2020);
    expect(fit.projYears[9]).toBe(2029);
    // q(65) in 2029 follows α + β κ with κ carried on by the drift.
    const a65 = AGES.indexOf(65);
    const kappaLast = drift * (YEARS.length - 1 - (YEARS.length - 1) / 2);
    const expected = Math.exp(-9.5 + 0.095 * 65 + beta[a65] * (kappaLast + 10 * drift));
    expect(fit.qx[9]).toBeCloseTo(expected, 12);
    expect(fit.annualImprovement).toBeGreaterThan(0);
    expect(fit.sigma).toBeCloseTo(0, 9); // a straight-line κ has no innovations
  });

  test("refuses a single period — nothing to project", () => {
    const { ds } = leeCarterTable();
    const oneYear: Dataset = { ...ds, rows: ds.rows.filter((r) => r.year === 2019) };
    const found = detectMortalityTable(oneYear);
    if ("reason" in found) throw new Error(found.reason);
    const fit = fitLeeCarter(found.table);
    expect("reason" in fit && fit.reason).toContain("at least 3 years");
  });
});

describe("fitCBD", () => {
  test("recovers both period-factor drifts on an exact CBD table", () => {
    const xbar = 70;
    const rows: Row[] = [];
    for (const [t, year] of YEARS.entries()) {
      for (const age of AGES) {
        const z = -3.2 - 0.02 * t + (0.1 + 0.0005 * t) * (age - xbar);
        rows.push({ year, age, qx: 1 / (1 + Math.exp(-z)) });
      }
    }
    const found = detectMortalityTable({ name: "cbd.csv", columns: ["year", "age", "qx"], rows });
    if ("reason" in found) throw new Error(found.reason);
    const fit = fitCBD(found.table);
    if ("reason" in fit) throw new Error(fit.reason);
    expect(fit.xbar).toBe(xbar); // mean of 50…90
    expect(fit.drift1).toBeCloseTo(-0.02, 9);
    expect(fit.drift2).toBeCloseTo(0.0005, 9);
    const z = -3.2 - 0.02 * 39 + (0.1 + 0.0005 * 39) * (65 - xbar); // t = 29 + 10
    expect(fit.qx[9]).toBeCloseTo(1 / (1 + Math.exp(-z)), 12);
  });
});

describe("lifeValues", () => {
  test("annuity-due, term assurance and pure endowment by hand", () => {
    const v = 1 / 1.04;
    const r = lifeValues([0.1, 0.2], 0.04);
    expect(r.annuityDue).toBeCloseTo(1 + v * 0.9, 14);
    expect(r.termAssurance).toBeCloseTo(v * 0.1 + v * v * 0.9 * 0.2, 14);
    expect(r.pureEndowment).toBeCloseTo(v * v * 0.9 * 0.8, 14);
  });
});
