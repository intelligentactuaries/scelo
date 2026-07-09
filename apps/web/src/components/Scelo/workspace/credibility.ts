// Corpus marginalisation is credibility.
//
// The de-noising that makes the J-lens clean in a transformer relies on an
// effectively unbounded corpus; an actuary's data are finite and thin. The
// profession's own cure is Buhlmann credibility: shrink a data-poor segment's
// gradient toward the collective gradient by an amount governed by the ratio of
// within- to between-segment variability.

import type { Vec } from "./linalg";

export type Segment = {
  /** Segment-conditional mean gradient (the workspace direction estimate). */
  gradient: Vec;
  /** Number of observations behind the estimate. */
  n: number;
  /** Optional within-segment sampling variance of the gradient (e.g. from a
   *  bootstrap). When absent it is approximated from the pooled spread. */
  withinVar?: number;
};

export type CredibilityResult = {
  /** The collective (corpus-averaged) gradient. */
  collective: Vec;
  /** Per-segment credibility-shrunk gradient. */
  shrunk: Vec[];
  /** Per-segment credibility factor Z_s = n_s / (n_s + kappa). */
  Z: number[];
  /** The credibility constant kappa = within / between. */
  kappa: number;
};

function sumSq(v: Vec): number {
  let s = 0;
  for (const x of v) s += x * x;
  return s;
}

/**
 * Buhlmann-credibility-stabilise a set of segment gradient estimates. The
 * collective gradient is the n-weighted mean; each segment shrinks toward it by
 * Z_s = n_s / (n_s + kappa), where kappa is the ratio of within- to
 * between-segment gradient variability.
 */
export function buhlmannShrink(segments: Segment[]): CredibilityResult {
  const S = segments.length;
  const d = S > 0 ? segments[0].gradient.length : 0;
  const totalN = segments.reduce((s, seg) => s + Math.max(seg.n, 0), 0) || 1;

  const collective = new Array(d).fill(0);
  for (const seg of segments) {
    const w = Math.max(seg.n, 0) / totalN;
    for (let j = 0; j < d; j++) collective[j] += w * seg.gradient[j];
  }

  // Between-segment variability: n-weighted mean squared deviation of segment
  // gradients from the collective.
  let between = 0;
  for (const seg of segments) {
    const w = Math.max(seg.n, 0) / totalN;
    const dev = seg.gradient.map((g, j) => g - collective[j]);
    between += w * sumSq(dev);
  }
  between = Math.max(between, 1e-12);

  // Within-segment variability: mean of the supplied within-variances, or a
  // fallback tied to the between-spread scaled by segment thinness.
  const provided = segments.filter((s) => typeof s.withinVar === "number");
  const within =
    provided.length > 0
      ? provided.reduce((s, seg) => s + (seg.withinVar ?? 0), 0) / provided.length
      : between; // neutral fallback: kappa ~ 1, Z = n/(n+1)

  const kappa = within / between;
  const Z: number[] = [];
  const shrunk: Vec[] = [];
  for (const seg of segments) {
    const z = seg.n / (seg.n + kappa);
    Z.push(z);
    shrunk.push(seg.gradient.map((g, j) => z * g + (1 - z) * collective[j]));
  }
  return { collective, shrunk, Z, kappa };
}
