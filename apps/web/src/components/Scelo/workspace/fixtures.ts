// Synthetic fixtures for the workspace tests. These reproduce, in miniature,
// the paper's Case A (a neural Lee-Carter mortality model whose workspace is a
// handful of nameable drivers buried under high-variance nuisance) and Case C
// (a pricing model that launders a protected attribute through a proxy). All
// data are generated from a known model with a fixed seed.

import type { Dataset } from "../SoftDataWorkstation";
import { gaussStd, seededRng } from "./linalg";

/**
 * Case A: three low-variance signal drivers (trend, cohort, smoking) act on
 * three nonlinear report channels; a high-variance `level` driver is a directly
 * readable reflexive level; ten high-variance nuisance drivers are
 * decision-irrelevant. The workspace should recover the three signals despite
 * occupying almost none of the input variance.
 */
export function caseAData(n = 4000, seed = 7): Dataset {
  const rand = seededRng(seed);
  const nuisance = Array.from({ length: 10 }, (_, i) => `nuisance_${i}`);
  const columns = [
    "trend",
    "cohort",
    "smoking",
    "level",
    ...nuisance,
    "annuity",
    "life_exp",
    "survival",
  ];
  const rows = [];
  for (let i = 0; i < n; i++) {
    const trend = gaussStd(rand, 0, 1);
    const cohort = gaussStd(rand, 0, 1);
    const smoking = gaussStd(rand, 0, 1);
    const level = gaussStd(rand, 0, 5); // high-variance readable level
    const row: Record<string, number> = { trend, cohort, smoking, level };
    for (const nz of nuisance) row[nz] = gaussStd(rand, 0, 8); // large, irrelevant

    // Three nonlinear report channels whose union spans the three signals.
    row.annuity = 1.2 * trend + 0.8 * cohort + 0.3 * trend * cohort + gaussStd(rand, 0, 0.04);
    row.life_exp = 1.0 * cohort - 0.9 * smoking + 0.4 * smoking * smoking + gaussStd(rand, 0, 0.04);
    row.survival = 0.7 * trend + 1.1 * smoking - 0.3 * trend * trend + gaussStd(rand, 0, 0.04);
    rows.push(row);
  }
  return { name: "case-a", columns, rows };
}

/**
 * Case C: a protected attribute A, a proxy P = 1.4 A + noise correlated with it,
 * a legitimate risk factor L, and a historical cost that carries a prohibited
 * dependence on A in addition to the legitimate signal. A model trained on (P, L)
 * only must launder A through P.
 */
export function caseCData(n = 6000, seed = 23): Dataset {
  const rand = seededRng(seed);
  const columns = ["protected", "proxy", "legit", "cost"];
  const rows = [];
  for (let i = 0; i < n; i++) {
    const protectedA = gaussStd(rand, 0, 1);
    const proxy = 1.4 * protectedA + gaussStd(rand, 0, 0.6);
    const legit = gaussStd(rand, 0, 1);
    // Prohibited dependence gamma = 0.8 on A, plus the legitimate signal.
    const cost = 0.8 * protectedA + 1.0 * legit + gaussStd(rand, 0, 0.3);
    rows.push({ protected: protectedA, proxy, legit, cost });
  }
  return { name: "case-c", columns, rows };
}
