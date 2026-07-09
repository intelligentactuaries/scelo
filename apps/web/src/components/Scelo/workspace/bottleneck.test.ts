// The interpretable workspace bottleneck: a few codes and a sparse non-negative
// broadcast should reconstruct correlated report channels and advertise the
// broadcast effect they actually cause.

import { describe, expect, test } from "bun:test";
import { fitBottleneck } from "./bottleneck";
import { caseAData } from "./fixtures";

describe("workspace bottleneck", () => {
  const dataset = caseAData();
  const cols = ["trend", "cohort", "smoking", "annuity", "life_exp", "survival"];
  const fit = fitBottleneck(dataset.rows, cols, { r: 3 });

  test("a few codes reconstruct the correlated columns", () => {
    expect(fit.reconstructionR2).toBeGreaterThan(0.4);
  });

  test("the broadcast is non-negative", () => {
    for (const row of fit.broadcast) for (const b of row) expect(b).toBeGreaterThanOrEqual(0);
  });

  test("the broadcast matches the code-to-head slopes it advertises", () => {
    expect(fit.causalAlignment).toBeGreaterThan(0.3);
  });

  test("codes are named from their loadings", () => {
    expect(fit.codeNames.length).toBe(3);
    expect(fit.codeNames[0].length).toBeGreaterThan(0);
  });
});
