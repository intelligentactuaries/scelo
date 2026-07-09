// Case A, in miniature: the workspace engine should recover the three planted
// signal drivers, show they occupy almost none of the input variance, validate
// them by swap, and dissociate flexible from reflexive readouts, exactly the
// five properties the paper reproduces in an actuarial model.

import { describe, expect, test } from "bun:test";
import { computeWorkspace } from "./engine";
import { caseAData } from "./fixtures";

const SIGNALS = new Set(["trend", "cohort", "smoking"]);

describe("workspace engine · Case A recovery", () => {
  const dataset = caseAData();
  const report = computeWorkspace(dataset, {
    readouts: ["annuity", "life_exp", "survival"],
    reflexiveReadout: "level",
    seed: 1,
  });

  test("the surrogate fits the report channels", () => {
    expect(report.surrogateR2).toBeGreaterThan(0.7);
  });

  test("the workspace is low-dimensional (rank ~ 3)", () => {
    expect(report.rank).toBeGreaterThanOrEqual(2);
    expect(report.rank).toBeLessThanOrEqual(5);
  });

  test("the top directions load on the planted signals, not the nuisance", () => {
    const top = report.directions.slice(0, 3);
    let share = 0;
    for (const dir of top) {
      let sig = 0;
      for (const l of dir.loadings) if (SIGNALS.has(l.col)) sig += l.weight * l.weight;
      share += sig;
    }
    share /= top.length;
    expect(share).toBeGreaterThan(0.8);
  });

  test("the workspace occupies almost none of the input variance", () => {
    // Signals carry tiny variance; nuisance carries almost all of it.
    expect(report.varianceFraction).toBeLessThan(0.1);
  });

  test("decision-relevant beats max-variance in the reduction curve", () => {
    const atThree = report.reduction.find((p) => p.k === 3);
    expect(atThree).toBeDefined();
    if (atThree) {
      expect(atThree.active).toBeGreaterThan(0.7);
      expect(atThree.active).toBeGreaterThan(atThree.pca + 0.3);
    }
  });

  test("the named directions survive the swap test in-band", () => {
    expect(report.swap).toBeDefined();
    expect(report.swap?.r2InBand ?? 0).toBeGreaterThan(0.85);
  });

  test("the workspace is selective (double dissociation)", () => {
    expect(report.selectivity).toBeDefined();
    const rows = report.selectivity ?? [];
    const flex = rows.find((r) => r.readout === "flexible");
    const refl = rows.find((r) => r.readout === "reflexive");
    expect(flex).toBeDefined();
    expect(refl).toBeDefined();
    if (flex && refl) {
      // Ablating the flexible workspace destroys the flexible output but spares
      // the reflexive level, and vice versa; the control harms neither.
      expect(flex.workspace).toBeLessThan(0.3);
      expect(flex.level).toBeGreaterThan(0.7);
      expect(refl.level).toBeLessThan(0.3);
      expect(refl.workspace).toBeGreaterThan(0.7);
      expect(flex.nuisance).toBeGreaterThan(0.7);
      expect(refl.nuisance).toBeGreaterThan(0.7);
    }
  });

  test("directions carry human-readable names", () => {
    expect(report.directions[0].name).not.toBe("mixed");
    expect(report.directions[0].name.length).toBeGreaterThan(0);
  });
});
