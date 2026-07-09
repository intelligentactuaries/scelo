// Causal-intervention validation: swap, ablate, and the selectivity
// double-dissociation. This is the evidential backbone the paper singles out
// as the single most valuable borrow: we do not merely correlate a direction
// with a name, we intervene on it and measure the counterfactual.

import { type Vec, meanVec, variance } from "./linalg";
import type { Surrogate } from "./surrogate";
import type { SelectivityRow, SwapPoint, SwapResult } from "./types";

/** Mean gradient (the corpus-averaged Jacobian) over the sample. */
export function meanGradient(surrogate: Surrogate, Xs: Vec[]): Vec {
  const d = Xs.length > 0 ? Xs[0].length : 0;
  const g = new Array(d).fill(0);
  for (const x of Xs) {
    const gx = surrogate.gradient(x);
    for (let j = 0; j < d; j++) g[j] += gx[j];
  }
  for (let j = 0; j < d; j++) g[j] /= Xs.length || 1;
  return g;
}

/** Ablate a subspace from z around the reference z0: remove all variation
 *  along `vectors` (orthonormal), keeping the complement. */
export function ablate(vectors: Vec[], z: Vec, z0: Vec): Vec {
  const out = z.slice();
  for (const w of vectors) {
    let c = 0;
    for (let i = 0; i < z.length; i++) c += w[i] * (z[i] - z0[i]);
    for (let i = 0; i < z.length; i++) out[i] -= c * w[i];
  }
  return out;
}

/** Capability retained after ablating `vectors` from the readout `surrogate`:
 *  1 minus Var[f(z) - f(ablate(z))] / Var[f(z)], clipped to [0, 1]. */
export function retention(surrogate: Surrogate, Zs: Vec[], vectors: Vec[], z0: Vec): number {
  const full = Zs.map((z) => surrogate.predict(z));
  const diffs = Zs.map((z, i) => full[i] - surrogate.predict(ablate(vectors, z, z0)));
  const vf = variance(full);
  if (vf < 1e-30) return 1;
  return Math.max(0, Math.min(1, 1 - variance(diffs) / vf));
}

/**
 * Swap-consistency validation. For each workspace direction and each swap
 * magnitude, compare the realised mean swap effect Delta(delta) = E[f(z+delta w)
 * - f(z)] against the first-order prediction delta * (w . mean-gradient). A high
 * in-band R^2 certifies the linear causal effect; the residual at large |delta|
 * estimates the curvature term that makes capital-scale swaps droop.
 */
export function swapConsistency(
  primary: Surrogate,
  Zs: Vec[],
  directions: Vec[],
  deltas: number[],
  inBand: number,
): SwapResult {
  const gbar = meanGradient(primary, Zs);
  const points: SwapPoint[] = [];

  for (let k = 0; k < directions.length; k++) {
    const w = directions[k];
    const gw = w.reduce((s, wi, i) => s + wi * gbar[i], 0);
    for (const delta of deltas) {
      let acc = 0;
      for (const z of Zs) {
        const zp = z.map((zi, i) => zi + delta * w[i]);
        acc += primary.predict(zp) - primary.predict(z);
      }
      const realized = acc / (Zs.length || 1);
      points.push({ direction: k, delta, realized, predicted: delta * gw });
    }
  }

  // In-band R^2 between realised and predicted (identity fit through 0).
  const band = points.filter((p) => Math.abs(p.delta) <= inBand + 1e-9);
  let ssRes = 0;
  let ssTot = 0;
  const rm = band.reduce((s, p) => s + p.realized, 0) / (band.length || 1);
  for (const p of band) {
    ssRes += (p.realized - p.predicted) * (p.realized - p.predicted);
    ssTot += (p.realized - rm) * (p.realized - rm);
  }
  const r2InBand = ssTot < 1e-30 ? 1 : Math.max(0, 1 - ssRes / ssTot);

  // Curvature estimate for the top direction from the largest symmetric pair:
  // realised(+d) + realised(-d) ~ d^2 * E[w^T H w] (linear terms cancel).
  const tailCurvature = estimateCurvature(points);

  return { points, r2InBand, inBand, tailCurvature };
}

function estimateCurvature(points: SwapPoint[]): number {
  const dir0 = points.filter((p) => p.direction === 0);
  let best = 0;
  let bestMag = 0;
  for (const p of dir0) {
    if (p.delta <= 0) continue;
    const neg = dir0.find((q) => Math.abs(q.delta + p.delta) < 1e-9);
    if (!neg) continue;
    if (p.delta > bestMag) {
      bestMag = p.delta;
      best = (p.realized + neg.realized) / (p.delta * p.delta);
    }
  }
  return best;
}

/**
 * Selectivity / double-dissociation. Ablating the flexible readout's own
 * workspace should destroy it while sparing the reflexive level, and vice
 * versa, with a matched high-variance control harming neither. `flexibleSub`
 * is S_F, `reflexiveSub` is S_R, `controlSub` is S_0.
 */
export function selectivityTable(
  flexible: Surrogate,
  reflexive: Surrogate,
  Zs: Vec[],
  flexibleSub: Vec[],
  reflexiveSub: Vec[],
  controlSub: Vec[],
): SelectivityRow[] {
  const z0 = meanVec(Zs);
  return [
    {
      readout: "flexible",
      workspace: retention(flexible, Zs, flexibleSub, z0),
      level: retention(flexible, Zs, reflexiveSub, z0),
      nuisance: retention(flexible, Zs, controlSub, z0),
    },
    {
      readout: "reflexive",
      workspace: retention(reflexive, Zs, flexibleSub, z0),
      level: retention(reflexive, Zs, reflexiveSub, z0),
      nuisance: retention(reflexive, Zs, controlSub, z0),
    },
  ];
}
