// Run a WMTR forecast and shape the output for Scelo's Hard Data card.
// The engine math (runSingleCommunity) is identical to the swarms app's
// canonical implementation; the runner here adds domain-aware labelling
// and a compact ForecastResult shape that fits next to a Scelo RunResult.

import {
  type WmtrSingleParams,
  type WmtrSingleResult,
  type Outcome,
  OUTCOME_COLOR,
  runSingleCommunity,
} from "./wmtr";
import { type DomainLabels, domainLabelsFor } from "./domainLabels";
import { type ModelFamily } from "../modelCatalog";

export type ForecastResult = {
  config: WmtrSingleParams;
  result: WmtrSingleResult;
  dominantOutcome: Outcome;
  /** Domain-aware labels (M / T / R / shock vocabulary). */
  labels: DomainLabels;
  /** Which of M, T, R is the dominant final-period component. */
  driver: "M" | "T" | "R";
};

function dominantDriver(r: WmtrSingleResult): "M" | "T" | "R" {
  const i = r.meanM.length - 1;
  const m = r.meanM[i] ?? 0;
  const t = r.meanT[i] ?? 0;
  const rr = r.meanR[i] ?? 0;
  if (m >= t && m >= rr) return "M";
  if (t >= m && t >= rr) return "T";
  return "R";
}

export function runForecast(
  config: WmtrSingleParams,
  family: ModelFamily,
): ForecastResult {
  const result = runSingleCommunity(config);
  return {
    config,
    result,
    dominantOutcome: result.dominant,
    labels: domainLabelsFor(family),
    driver: dominantDriver(result),
  };
}

/**
 * Sweep one shock-severity-equivalent parameter across {mild, moderate,
 * severe} and report outcome distributions for each. The sensitivity
 * model's main job is to show "how would the trajectory shift if the
 * shock were worse / milder", so we sweep just on `shock` for the first
 * pass; future versions can sweep arbitrary parameters.
 */
export type SensitivityResult = {
  rows: Array<{
    shock: "mild" | "moderate" | "severe";
    config: WmtrSingleParams;
    result: WmtrSingleResult;
  }>;
  labels: DomainLabels;
};

export function runSensitivity(
  base: WmtrSingleParams,
  family: ModelFamily,
): SensitivityResult {
  const shocks = ["mild", "moderate", "severe"] as const;
  const rows = shocks.map((s) => {
    const config = { ...base, shock: s };
    const result = runSingleCommunity(config);
    return { shock: s, config, result };
  });
  return { rows, labels: domainLabelsFor(family) };
}

export { OUTCOME_COLOR };
