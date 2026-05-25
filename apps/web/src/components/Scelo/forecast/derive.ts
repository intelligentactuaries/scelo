// Derive a WMTR forecast config either from free-text or from a Scelo
// result. Lifted from swarms/src/server/wmtr.ts with a small extension:
// `forecastConfigFor(result, scenario, family)` synthesizes a domain-
// flavoured scenario string from a Scelo result and feeds it through the
// same keyword heuristic, so the per-result "Forecast forward" affordance
// produces a config that's at least domain-aware.

import { DEFAULT_WMTR_SINGLE_PARAMS, type ShockEnvironment, type WmtrSingleParams } from "./wmtr";
import type { RunResult } from "../modelRunner";
import type { ModelFamily } from "../modelCatalog";

// ─── Heuristic config derivation from free text ───────────────────────────

const SCENARIO_HASH = (s: string): number => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) h = (h ^ s.charCodeAt(i)) * 16777619 >>> 0;
  return h >>> 0;
};

const KW = (s: string, words: string[]): boolean => {
  const lo = s.toLowerCase();
  return words.some((w) => lo.includes(w));
};

export function deriveConfigFromScenario(
  scenario: string,
  overrides: Partial<WmtrSingleParams> = {},
): WmtrSingleParams {
  const base = { ...DEFAULT_WMTR_SINGLE_PARAMS };

  // Shock severity
  let shock: ShockEnvironment = "moderate";
  if (
    KW(scenario, [
      "catastroph",
      "war",
      "pandemic",
      "famine",
      "collapse",
      "severe",
      "crisis",
      "depression",
      "shock",
      "downgrade",
      "cliff",
    ])
  )
    shock = "severe";
  else if (KW(scenario, ["mild", "calm", "stable", "benign", "orderly", "normal"]))
    shock = "mild";
  base.shock = shock;

  // Domain cues — finance / pension / life / etc. — bias the α decomposition
  // toward what reads naturally for that domain. Insurance books have higher
  // material weight (αM), pension scheme survival hinges on relational
  // (covenant) weight, etc.
  if (KW(scenario, ["pension", "scheme", "sponsor", "covenant", "db plan", "annuity book"])) {
    base.alphaM = 0.35;
    base.alphaT = 0.25;
    base.alphaR = 0.40;
  } else if (
    KW(scenario, ["life book", "life insurance", "term life", "ifrs 17", "csm", "solvency ii"])
  ) {
    base.alphaM = 0.50;
    base.alphaT = 0.20;
    base.alphaR = 0.30;
  } else if (KW(scenario, ["reserve", "ibnr", "triangle", "chain ladder", "bornhuetter"])) {
    base.alphaM = 0.55;
    base.alphaT = 0.30;
    base.alphaR = 0.15;
  } else if (KW(scenario, ["rural", "village", "subsistence", "agrarian", "farming"])) {
    base.alphaM = 0.30;
    base.alphaT = 0.30;
    base.alphaR = 0.40;
    base.wF = 0.50;
    base.wRel = 0.30;
    base.wS = 0.20;
    base.sqftPerResident = 800;
  } else if (KW(scenario, ["urban", "city", "metropol", "downtown"])) {
    base.alphaM = 0.50;
    base.alphaT = 0.30;
    base.alphaR = 0.20;
    base.sqftPerResident = 220;
  }

  // Long-horizon cues
  if (KW(scenario, ["century", "long-term", "multi-generational"])) base.horizon = 60;
  else if (KW(scenario, ["next year", "short term", "immediate"])) base.horizon = 10;

  base.seed = SCENARIO_HASH(scenario) % 9999;
  base.nPaths = 200;
  return { ...base, ...overrides };
}

// ─── Derive a forecast config from a Scelo result ─────────────────────────

/**
 * Synthesize a one-line scenario from a Scelo result + the source
 * scenario, then feed it through the keyword heuristic. This is the
 * bridge that lets the per-result "Forecast forward" CTA produce a
 * domain-faithful forecast config without asking the user any new
 * questions. The headline value and the run's family are the key cues
 * the heuristic uses.
 */
export function forecastConfigFor(
  result: RunResult,
  scenarioContext: string | null,
  family: ModelFamily,
): WmtrSingleParams {
  const headline = `${result.headline.label} ${result.headline.value}`;
  const familyHint = familyToHint(family);
  const synth = [scenarioContext, familyHint, headline].filter(Boolean).join(". ");
  return deriveConfigFromScenario(synth);
}

function familyToHint(family: ModelFamily): string {
  switch (family) {
    case "reserving":
      return "P&C reserving on an incomplete claims triangle";
    case "life":
      return "life insurance book";
    case "mortality":
      return "mortality cohort projection";
    case "pricing":
      return "personal-lines pricing book";
    case "climate":
      return "climate hazard exposure";
    case "capital":
      return "Solvency II capital position";
    case "pensions":
      return "pension scheme with sponsor covenant";
    case "forecast":
      return "community forecast";
    default:
      return "actuarial portfolio";
  }
}
