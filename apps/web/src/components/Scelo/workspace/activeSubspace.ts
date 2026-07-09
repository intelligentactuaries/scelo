// The active subspace: the workspace operator C_f = E[J_f^T J_f].
//
// Its top eigenvectors are the directions the model is, on average, most poised
// to move its report along. These are decision-relevant, not max-variance, and
// (Prop) can be orthogonal to what PCA keeps. Everything here works in the
// surrogate's standardised (z) driver space so loadings and PCA are comparable.

import type { Row } from "../SoftDataWorkstation";
import {
  type Eigen,
  type Mat,
  type Vec,
  accumulateOuter,
  jacobiEigen,
  mean,
  meanVec,
  zeroMat,
} from "./linalg";
import type { Surrogate } from "./surrogate";

/** Stride-subsample raw driver vectors from the rows. */
export function sampleX(surrogate: Surrogate, rows: Row[], maxSamples = 1500): Vec[] {
  const stride = Math.max(1, Math.floor(rows.length / maxSamples));
  const out: Vec[] = [];
  for (let i = 0; i < rows.length; i += stride) out.push(surrogate.toX(rows[i]));
  return out;
}

/** Gradient covariance C = (1/N) sum_i sum_channels g g^T, averaged over the
 *  sample and summed over report channels (the multi-output workspace op). */
export function gradientCovariance(surrogates: Surrogate[], Xs: Vec[]): Mat {
  const d = Xs.length > 0 ? Xs[0].length : 0;
  const C = zeroMat(d, d);
  for (const x of Xs) {
    for (const s of surrogates) accumulateOuter(C, s.gradient(x));
  }
  const k = Xs.length || 1;
  for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) C[i][j] /= k;
  return C;
}

/** Input covariance of the standardised drivers (approximately the correlation
 *  matrix); the reference for the "share of input variance" the workspace
 *  occupies and for the PCA (max-variance) contrast. */
export function inputCovariance(Zs: Vec[]): Mat {
  const n = Zs.length;
  const d = n > 0 ? Zs[0].length : 0;
  const mu = new Array(d).fill(0);
  for (const z of Zs) for (let j = 0; j < d; j++) mu[j] += z[j];
  for (let j = 0; j < d; j++) mu[j] /= n || 1;
  const S = zeroMat(d, d);
  for (const z of Zs) {
    for (let i = 0; i < d; i++) {
      const di = z[i] - mu[i];
      for (let j = i; j < d; j++) S[i][j] += di * (z[j] - mu[j]);
    }
  }
  const denom = Math.max(1, n - 1);
  for (let i = 0; i < d; i++) {
    for (let j = i; j < d; j++) {
      S[i][j] /= denom;
      S[j][i] = S[i][j];
    }
  }
  return S;
}

/** Participation ratio (sum lambda)^2 / sum lambda^2: the effective dimension,
 *  1 when one eigenvalue dominates, r when r are equal. */
export function participationRatio(values: number[]): number {
  let s1 = 0;
  let s2 = 0;
  for (const v of values) {
    const p = Math.max(v, 0);
    s1 += p;
    s2 += p * p;
  }
  return s2 > 1e-30 ? (s1 * s1) / s2 : 0;
}

export function trace(M: Mat): number {
  let t = 0;
  for (let i = 0; i < M.length; i++) t += M[i][i];
  return t;
}

/** Fraction of input variance occupied by a subspace: sum_k w_k^T Sigma w_k / Tr(Sigma). */
export function varianceFractionOf(vectors: Vec[], Sigma: Mat): number {
  const tr = trace(Sigma);
  if (tr < 1e-30) return 0;
  let s = 0;
  for (const w of vectors) {
    // w^T Sigma w
    let q = 0;
    for (let i = 0; i < w.length; i++) {
      let row = 0;
      const Si = Sigma[i];
      for (let j = 0; j < w.length; j++) row += Si[j] * w[j];
      q += w[i] * row;
    }
    s += q;
  }
  return s / tr;
}

/** Project z onto the subspace spanned by orthonormal `vectors`, around a
 *  reference z0: z0 + sum_k (w_k . (z - z0)) w_k. */
export function projectOnto(vectors: Vec[], z: Vec, z0: Vec): Vec {
  const out = z0.slice();
  for (const w of vectors) {
    let c = 0;
    for (let i = 0; i < z.length; i++) c += w[i] * (z[i] - z0[i]);
    for (let i = 0; i < z.length; i++) out[i] += c * w[i];
  }
  return out;
}

/** How much of the readout's variation a subspace rebuilds: 1 minus the
 *  variance of f(z) - f(project(z)) over the variance of f(z). This is the
 *  Case-A "variance rebuilt by k coordinates" metric. */
export function rebuiltShare(surrogate: Surrogate, Zs: Vec[], vectors: Vec[], z0: Vec): number {
  const full = Zs.map((z) => surrogate.predict(z));
  const proj = Zs.map((z) => surrogate.predict(projectOnto(vectors, z, z0)));
  const mf = mean(full);
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < full.length; i++) {
    ssRes += (full[i] - proj[i]) * (full[i] - proj[i]);
    ssTot += (full[i] - mf) * (full[i] - mf);
  }
  if (ssTot < 1e-30) return 1;
  return Math.max(0, Math.min(1, 1 - ssRes / ssTot));
}

export type ReductionCurve = { k: number; active: number; pca: number }[];

/** The workspace-vs-PCA reduction curve: readout variation rebuilt by the top-k
 *  active (decision-relevant) subspace vs the top-k PCA (max-variance) subspace,
 *  for k = 1..kMax, using `primary` as the readout to score against. */
export function reductionCurve(
  primary: Surrogate,
  Zs: Vec[],
  activeVecs: Vec[],
  pcaVecs: Vec[],
  kMax: number,
): ReductionCurve {
  const z0 = meanVec(Zs); // ablate/project around the sample mean (raw space)
  const out: ReductionCurve = [];
  const K = Math.min(kMax, activeVecs.length, pcaVecs.length);
  for (let k = 1; k <= K; k++) {
    out.push({
      k,
      active: rebuiltShare(primary, Zs, activeVecs.slice(0, k), z0),
      pca: rebuiltShare(primary, Zs, pcaVecs.slice(0, k), z0),
    });
  }
  return out;
}

export type ActiveSubspace = {
  C: Mat;
  eigen: Eigen;
  participationRatio: number;
  Sigma: Mat;
  pcaEigen: Eigen;
};

/** Assemble the active subspace (gradient covariance eigendecomposition) and
 *  the PCA (input covariance eigendecomposition) side by side. */
export function activeSubspace(surrogates: Surrogate[], Zs: Vec[]): ActiveSubspace {
  const C = gradientCovariance(surrogates, Zs);
  const eigen = jacobiEigen(C);
  const Sigma = inputCovariance(Zs);
  const pcaEigen = jacobiEigen(Sigma);
  return { C, eigen, participationRatio: participationRatio(eigen.values), Sigma, pcaEigen };
}
