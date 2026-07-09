// The workspace bottleneck: interpretable by design.
//
// A wide encoder compresses many drivers into a few sparse, nameable codes; a
// non-negative broadcast matrix B fans the codes out to many report heads. The
// linear rank-one case is exactly Lee-Carter; the linear non-negative case is
// exactly NMF, whose sparsity and non-negativity are what make its factors read
// as causes. We fit the codes as the low-rank workspace of the standardised
// data and the broadcast by non-negative, L1-sparse least squares, then check
// that the broadcast B matches the code-to-head slopes it advertises.

import type { Row } from "../SoftDataWorkstation";
import { inputCovariance, participationRatio } from "./activeSubspace";
import { type Vec, corr, jacobiEigen, mean } from "./linalg";
import { nameDirection } from "./names";
import type { BottleneckFit, DriverLoading } from "./types";

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : Number.NaN;
}

/** Non-negative L1-penalised least squares: min ||y - Z b||^2 + l1 * sum(b),
 *  b >= 0, by projected gradient descent. Z is n x k, y is n. */
function nnlsL1(Z: number[][], y: number[], l1: number, iters = 300): Vec {
  const n = y.length;
  const k = Z.length > 0 ? Z[0].length : 0;
  // Gram matrix G = Z^T Z and c = Z^T y.
  const G: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const c = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    const zi = Z[i];
    for (let a = 0; a < k; a++) {
      c[a] += zi[a] * y[i];
      for (let b = 0; b < k; b++) G[a][b] += zi[a] * zi[b];
    }
  }
  // Step size ~ 1 / largest eigenvalue, approximated by the trace.
  let tr = 0;
  for (let a = 0; a < k; a++) tr += G[a][a];
  const lr = tr > 1e-30 ? 1 / tr : 0.1;
  const b = new Array(k).fill(0);
  for (let it = 0; it < iters; it++) {
    // gradient = G b - c + l1
    for (let a = 0; a < k; a++) {
      let ga = -c[a] + l1;
      const Ga = G[a];
      for (let j = 0; j < k; j++) ga += Ga[j] * b[j];
      b[a] = Math.max(0, b[a] - lr * ga);
    }
  }
  return b;
}

export type BottleneckOpts = {
  /** Number of codes (workspace width). */
  r?: number;
  /** L1 penalty on the broadcast (sparsity of B). */
  l1?: number;
};

/**
 * Fit a workspace-bottleneck over the numeric `cols` of `rows`: a few
 * low-dimensional codes and a sparse non-negative broadcast that reconstructs
 * the columns. Returns the codes' driver loadings, the broadcast B, and the
 * causal-alignment and reconstruction quality.
 */
export function fitBottleneck(
  rows: Row[],
  cols: string[],
  opts: BottleneckOpts = {},
): BottleneckFit {
  const d = cols.length;
  const r = Math.max(1, Math.min(opts.r ?? 3, d));
  const l1 = opts.l1 ?? 1e-3;

  // Standardise columns.
  const mu = new Array(d).fill(0);
  const sd = new Array(d).fill(0);
  const raw: number[][] = rows
    .map((row) => cols.map((col) => num(row[col])))
    .filter((x) => x.every((v) => Number.isFinite(v)));
  const n = raw.length;
  for (const x of raw) for (let j = 0; j < d; j++) mu[j] += x[j];
  for (let j = 0; j < d; j++) mu[j] /= n || 1;
  for (const x of raw) for (let j = 0; j < d; j++) sd[j] += (x[j] - mu[j]) ** 2;
  for (let j = 0; j < d; j++) {
    sd[j] = Math.sqrt(sd[j] / Math.max(1, n - 1));
    if (!(sd[j] > 1e-9)) sd[j] = 1;
  }
  const X: Vec[] = raw.map((x) => x.map((v, j) => (v - mu[j]) / sd[j]));

  // Codes = top-r directions of the standardised data (the low-rank workspace).
  const Sigma = inputCovariance(X);
  const eig = jacobiEigen(Sigma);
  const V = eig.vectors.slice(0, r); // r code loadings (each length d)

  // Code scores Z (n x r), oriented so each code correlates positively with the
  // summed columns (keeps the non-negative broadcast interpretable).
  const colSum = X.map((x) => x.reduce((s, v) => s + v, 0));
  const oriented: Vec[] = V.map((w) => {
    const score = X.map((x) => w.reduce((s, v, j) => s + v * x[j], 0));
    return corr(score, colSum) < 0 ? w.map((v) => -v) : w;
  });
  const Z: number[][] = X.map((x) => oriented.map((w) => w.reduce((s, v, j) => s + v * x[j], 0)));

  // Broadcast B (d heads x r codes): non-negative L1 least squares per column.
  const B: number[][] = [];
  for (let c = 0; c < d; c++) {
    const yc = X.map((x) => x[c]);
    B.push(nnlsL1(Z, yc, l1));
  }

  // Reconstruction R^2 (averaged over heads).
  let reconAcc = 0;
  for (let c = 0; c < d; c++) {
    const yc = X.map((x) => x[c]);
    const yhat = Z.map((z) => z.reduce((s, zk, k) => s + B[c][k] * zk, 0));
    reconAcc += r2(yc, yhat);
  }
  const reconstructionR2 = reconAcc / d;

  // Causal alignment: does B[:,k] match the true code-to-head slopes? For each
  // code, compare its broadcast column against the marginal regression slopes.
  let alignAcc = 0;
  for (let k = 0; k < r; k++) {
    const zk = Z.map((z) => z[k]);
    const vk = variance(zk) || 1;
    const slopes = new Array(d);
    for (let c = 0; c < d; c++) {
      const yc = X.map((x) => x[c]);
      slopes[c] = cov(yc, zk) / vk;
    }
    const bCol = B.map((row) => row[k]);
    alignAcc += corr(bCol, slopes) ** 2;
  }
  const causalAlignment = r > 0 ? alignAcc / r : 0;

  // Sparsity of B.
  const flat = B.flat();
  const maxB = Math.max(...flat.map((v) => Math.abs(v)), 1e-9);
  const sparsity = flat.filter((v) => Math.abs(v) < 0.02 * maxB).length / (flat.length || 1);

  const codeLoadings: DriverLoading[][] = oriented.map((w) =>
    w
      .map((weight, j) => ({ col: cols[j], weight }))
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)),
  );
  const codeNames = codeLoadings.map((l) => nameDirection(l));

  return {
    codeNames,
    codeLoadings,
    broadcast: B,
    heads: cols,
    participationRatio: participationRatio(eig.values.slice(0, r)),
    sparsity,
    causalAlignment,
    reconstructionR2,
    n,
  };
}

function r2(y: number[], yhat: number[]): number {
  const m = mean(y);
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < y.length; i++) {
    ssRes += (y[i] - yhat[i]) ** 2;
    ssTot += (y[i] - m) ** 2;
  }
  return ssTot < 1e-30 ? 0 : Math.max(0, 1 - ssRes / ssTot);
}

function cov(a: number[], b: number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / Math.max(1, a.length - 1);
}

function variance(xs: number[]): number {
  const m = mean(xs);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, xs.length - 1);
}
