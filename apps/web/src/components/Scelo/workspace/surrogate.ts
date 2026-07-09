// A cheap, differentiable surrogate over the numeric drivers.
//
// A fitted Scelo model is not a live differentiable function of the raw
// drivers, so, exactly as in Case A of the paper ("fit a multi-output neural
// surrogate to play the role of a black-box model whose workspace we must
// recover"), we fit a smooth surrogate g(x) ~ readout and read the workspace
// off ITS gradient. Ridge regression with random Fourier features gives a
// smooth model with an analytic gradient and no native dependencies.

import type { Row } from "../SoftDataWorkstation";
import { type Vec, dot, mean, r2Score, seededRng, solveLinear } from "./linalg";

export type Surrogate = {
  driverCols: string[];
  /** Per-driver standardisation (used internally for conditioning). The public
   *  predict/gradient operate in the raw driver space so the active subspace
   *  and its input-variance share match the paper (nuisance drivers carry large
   *  raw variance, signal drivers small). */
  mu: number[];
  sigma: number[];
  /** Predict the readout from a raw driver vector x. */
  predict: (x: Vec) => number;
  /** Gradient d(predict)/dx in raw driver space. */
  gradient: (x: Vec) => Vec;
  /** Map a raw dataset row to a raw driver vector (missing cells imputed to the
   *  column mean). */
  toX: (row: Row) => Vec;
  /** In-sample fit quality (0..1). */
  r2: number;
};

export type SurrogateOpts = {
  /** Number of random Fourier features (0 = a plain ridge-linear surrogate). */
  features?: number;
  /** RFF frequency scale on standardised inputs. */
  bandwidth?: number;
  /** Ridge penalty on the feature weights. */
  ridge?: number;
  seed?: number;
  /** Cap the fit sample (stride-subsampled) so large uploads stay sub-second. */
  maxRows?: number;
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : Number.NaN;
}

/**
 * Fit a differentiable surrogate mapping the numeric `driverCols` of `rows` to
 * `readout` (a column name or a per-row function). Returns a Surrogate whose
 * `predict`/`gradient` operate in the raw driver space.
 */
export function fitSurrogate(
  rows: Row[],
  driverCols: string[],
  readout: string | ((row: Row) => number),
  opts: SurrogateOpts = {},
): Surrogate {
  const d = driverCols.length;
  const maxRows = opts.maxRows ?? 2000;
  const readoutFn: (row: Row) => number =
    typeof readout === "function" ? readout : (row) => num(row[readout]);

  // Stride-subsample so a big upload stays cheap; the fit is representative.
  const stride = Math.max(1, Math.floor(rows.length / maxRows));
  const sample: Row[] = [];
  for (let i = 0; i < rows.length; i += stride) sample.push(rows[i]);

  // Column means (for missing-cell imputation) and standard deviations.
  const mu = new Array(d).fill(0);
  const counts = new Array(d).fill(0);
  for (const row of sample) {
    for (let j = 0; j < d; j++) {
      const v = num(row[driverCols[j]]);
      if (Number.isFinite(v)) {
        mu[j] += v;
        counts[j]++;
      }
    }
  }
  for (let j = 0; j < d; j++) mu[j] = counts[j] > 0 ? mu[j] / counts[j] : 0;

  const sigma = new Array(d).fill(0);
  for (const row of sample) {
    for (let j = 0; j < d; j++) {
      const v = num(row[driverCols[j]]);
      const x = Number.isFinite(v) ? v : mu[j];
      sigma[j] += (x - mu[j]) * (x - mu[j]);
    }
  }
  for (let j = 0; j < d; j++) {
    sigma[j] = Math.sqrt(sigma[j] / Math.max(1, sample.length - 1));
    if (!(sigma[j] > 1e-9)) sigma[j] = 1; // constant driver: leave it in z=0
  }

  const toX = (row: Row): Vec => {
    const x = new Array(d);
    for (let j = 0; j < d; j++) {
      const v = num(row[driverCols[j]]);
      x[j] = Number.isFinite(v) ? v : mu[j];
    }
    return x;
  };
  const standardize = (x: Vec): Vec => x.map((xi, j) => (xi - mu[j]) / sigma[j]);

  // Build the standardised design (only rows with a finite readout).
  const Z: Vec[] = [];
  const y: number[] = [];
  for (const row of sample) {
    const yi = readoutFn(row);
    if (!Number.isFinite(yi)) continue;
    Z.push(standardize(toX(row)));
    y.push(yi);
  }
  const n = Z.length;

  // Random Fourier features approximate a smooth (Gaussian-kernel) map:
  //   phi_k(z) = sqrt(2/D) cos(omega_k . z + b_k),  omega_k ~ N(0, bandwidth^2).
  const D = n >= 40 ? (opts.features ?? 128) : 0; // too few rows: stay linear
  const bandwidth = opts.bandwidth ?? 0.6;
  const ridge = opts.ridge ?? 1e-2;
  const rffScale = D > 0 ? Math.sqrt(2 / D) : 0;
  const rand = seededRng(opts.seed ?? 20260708);
  const omega: Vec[] = [];
  const bias: number[] = [];
  for (let k = 0; k < D; k++) {
    const w = new Array(d);
    for (let j = 0; j < d; j++) {
      // Box-Muller normal, scaled by the bandwidth.
      const u1 = Math.max(rand(), 1e-12);
      const u2 = rand();
      w[j] = bandwidth * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }
    omega.push(w);
    bias.push(rand() * 2 * Math.PI);
  }

  // Feature map phi(z) = [1, z_1..z_d, rff_1..rff_D], length p.
  const p = 1 + d + D;
  const phi = (z: Vec): Vec => {
    const f = new Array(p);
    f[0] = 1;
    for (let j = 0; j < d; j++) f[1 + j] = z[j];
    for (let k = 0; k < D; k++) f[1 + d + k] = rffScale * Math.cos(dot(omega[k], z) + bias[k]);
    return f;
  };

  // Ridge normal equations: (Phi^T Phi + lambda I) w = Phi^T y.
  const A: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  const rhs = new Array(p).fill(0);
  if (n === 0) {
    // Degenerate: return a constant-zero surrogate.
    return {
      driverCols,
      mu,
      sigma,
      toX,
      predict: () => 0,
      gradient: () => new Array(d).fill(0),
      r2: 0,
    };
  }
  const ym = mean(y);
  for (let i = 0; i < n; i++) {
    const f = phi(Z[i]);
    const yc = y[i] - ym; // centre so the bias column soaks up the mean cleanly
    for (let a = 0; a < p; a++) {
      rhs[a] += f[a] * yc;
      const row = A[a];
      for (let b2 = a; b2 < p; b2++) row[b2] += f[a] * f[b2];
    }
  }
  for (let a = 0; a < p; a++) {
    for (let b2 = 0; b2 < a; b2++) A[a][b2] = A[b2][a]; // symmetrise
    if (a > 0) A[a][a] += ridge; // do not penalise the intercept
  }
  const w = solveLinear(A, rhs) ?? new Array(p).fill(0);

  // Internal z-space predict / gradient (the model lives in standardised space).
  const predictZ = (z: Vec): number => {
    let s = ym + w[0];
    for (let j = 0; j < d; j++) s += w[1 + j] * z[j];
    for (let k = 0; k < D; k++) s += w[1 + d + k] * rffScale * Math.cos(dot(omega[k], z) + bias[k]);
    return s;
  };
  const gradientZ = (z: Vec): Vec => {
    const g = new Array(d).fill(0);
    for (let j = 0; j < d; j++) g[j] = w[1 + j];
    for (let k = 0; k < D; k++) {
      const wk = w[1 + d + k];
      if (wk === 0) continue;
      const s = -rffScale * wk * Math.sin(dot(omega[k], z) + bias[k]);
      const ok = omega[k];
      for (let j = 0; j < d; j++) g[j] += s * ok[j];
    }
    return g;
  };

  const yhat = Z.map((z) => predictZ(z));
  const r2 = r2Score(y, yhat);

  // Public raw-space interface: standardise on the way in, and rescale the
  // gradient by 1/sigma on the way out (chain rule dz/dx = 1/sigma).
  const predict = (x: Vec): number => predictZ(standardize(x));
  const gradient = (x: Vec): Vec => {
    const gz = gradientZ(standardize(x));
    return gz.map((g, j) => g / sigma[j]);
  };
  return { driverCols, mu, sigma, toX, predict, gradient, r2 };
}
