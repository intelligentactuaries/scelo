// Workspace demo sample — reproduces the paper's Case A in-app.
//
// A synthetic annuity/mortality book with three genuine, low-variance risk
// drivers (a mortality-improvement trend, a cohort effect, a smoking index)
// acting through nonlinear channels on four report quantities, plus a directly
// readable crude-rate level and ten high-variance-but-irrelevant operational
// columns. Loading it and running the Hard-Data "validate workspace" action
// recovers the three true drivers even though they occupy almost none of the
// input variance, the exact "decision-relevant is not max-variance" result.

import type { Dataset, Row } from "./SoftDataWorkstation";
import { gaussStd, seededRng } from "./workspace/linalg";

/** The report channels an actuary reads off this book (the workspace readout). */
export const WORKSPACE_DEMO_READOUTS = ["annuity_60", "life_exp_60", "survival_to_80"];
/** A directly readable level, for the selectivity dissociation. */
export const WORKSPACE_DEMO_REFLEXIVE = "crude_rate";

// High-variance, decision-irrelevant operational columns: plausible on a real
// extract, but nothing the mortality of the book actually turns on.
const NUISANCE = [
  "premium_band",
  "postcode_score",
  "tenure_months",
  "marketing_segment",
  "contact_recency",
  "web_logins",
  "paperless_score",
  "call_centre_index",
  "app_sessions",
  "survey_score",
];

export function buildWorkspaceDemo(n = 2000, seed = 7): Dataset {
  const rand = seededRng(seed);
  const columns = [
    "mortality_trend",
    "cohort_effect",
    "smoking_index",
    "crude_rate",
    ...NUISANCE,
    ...WORKSPACE_DEMO_READOUTS,
  ];
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    // Three genuine drivers, each O(1) and low variance.
    const trend = gaussStd(rand, 0, 1);
    const cohort = gaussStd(rand, 0, 1);
    const smoking = gaussStd(rand, 0, 1);
    // A directly readable crude-rate level with deliberately large variance.
    const crude = gaussStd(rand, 0, 5);

    const row: Row = {
      mortality_trend: round(trend, 4),
      cohort_effect: round(cohort, 4),
      smoking_index: round(smoking, 4),
      crude_rate: round(crude, 3),
    };
    // Nuisance: large variance, no bearing on the mortality readouts.
    for (const c of NUISANCE) row[c] = round(gaussStd(rand, 0, 8), 3);

    // Nonlinear report channels whose union spans the three real drivers.
    row.annuity_60 = round(
      1.2 * trend + 0.8 * cohort + 0.3 * trend * cohort + gaussStd(rand, 0, 0.04),
      4,
    );
    row.life_exp_60 = round(
      1.0 * cohort - 0.9 * smoking + 0.4 * smoking * smoking + gaussStd(rand, 0, 0.04),
      4,
    );
    row.survival_to_80 = round(
      0.7 * trend + 1.1 * smoking - 0.3 * trend * trend + gaussStd(rand, 0, 0.04),
      4,
    );
    rows.push(row);
  }
  return { name: "workspace-demo", columns, rows };
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}
