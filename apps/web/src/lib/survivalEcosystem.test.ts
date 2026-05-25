import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SURVIVAL_PARAMS,
  SURVIVAL_SPECIES,
  annuityPresentValues,
  createSurvivalEcosystemState,
  populationShares,
  runSurvivalEcosystemSteps,
  survivalCurves,
} from "./survivalEcosystem";

describe("survival ecosystem simulation", () => {
  test("initial state is a normalised age-year model field", () => {
    const state = createSurvivalEcosystemState();
    expect(state.ages[0]).toBe(50);
    expect(state.years[0]).toBe(2026);
    expect(state.weights.length).toBe(SURVIVAL_SPECIES.length);
    expect(state.dominant.length).toBe(state.ages.length * state.years.length);

    const shares = populationShares(state);
    expect(shares.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 5);
    for (const share of shares) expect(share).toBeGreaterThan(0);
  });

  test("stepping updates finite live metrics", () => {
    const state = runSurvivalEcosystemSteps(
      createSurvivalEcosystemState(),
      DEFAULT_SURVIVAL_PARAMS,
      12,
    );
    const latest = state.history[state.history.length - 1];
    expect(state.step).toBe(12);
    expect(latest.diversity).toBeGreaterThanOrEqual(0);
    expect(latest.diversity).toBeLessThanOrEqual(1);
    expect(latest.calibrationLoss).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(latest.annuityPv)).toBe(true);
    expect(Number.isFinite(latest.capitalStrain)).toBe(true);
  });

  test("survival and annuity outputs are actuarially shaped", () => {
    const state = runSurvivalEcosystemSteps(
      createSurvivalEcosystemState(),
      { ...DEFAULT_SURVIVAL_PARAMS, selectedAge: 65 },
      4,
    );
    const curves = survivalCurves(state, DEFAULT_SURVIVAL_PARAMS, 20);
    const target = curves.find((curve) => curve.name === "target");
    expect(target).toBeDefined();
    expect(target?.points[0]).toEqual([0, 1]);
    expect(target?.points.at(-1)?.[1]).toBeLessThan(1);

    const pv = annuityPresentValues(state, DEFAULT_SURVIVAL_PARAMS);
    expect(pv.map((row) => row.name)).toContain("ecosystem");
    for (const row of pv) expect(row.value).toBeGreaterThan(0);
  });
});
