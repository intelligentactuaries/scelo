// Small, dependency-free linear algebra for the workspace engine.
//
// The workspace lives in a driver space of at most a few dozen dimensions
// (columns are capped upstream), so a classic cyclic-Jacobi eigensolver and
// Gaussian elimination are plenty: robust, exact enough, and no native deps.

export type Vec = number[];
export type Mat = number[][];

export function seededRng(seed: number): () => number {
  // Mulberry32 — the same reproducible RNG the forecast engine uses.
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussStd(rand: () => number, mu = 0, sigma = 1): number {
  const u1 = Math.max(rand(), 1e-12);
  const u2 = rand();
  return mu + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function variance(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s / (n - 1);
}

/** Componentwise mean of a set of equal-length vectors. */
export function meanVec(vs: Vec[]): Vec {
  const d = vs.length > 0 ? vs[0].length : 0;
  const out = new Array(d).fill(0);
  for (const v of vs) for (let j = 0; j < d; j++) out[j] += v[j];
  const n = vs.length || 1;
  for (let j = 0; j < d; j++) out[j] /= n;
  return out;
}

export function dot(a: Vec, b: Vec): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function norm(a: Vec): number {
  return Math.sqrt(dot(a, a));
}

export function scale(a: Vec, k: number): Vec {
  return a.map((x) => x * k);
}

export function addScaled(a: Vec, b: Vec, k: number): Vec {
  // a + k*b
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + k * b[i];
  return out;
}

export function zeros(n: number): Vec {
  return new Array(n).fill(0);
}

export function zeroMat(rows: number, cols: number): Mat {
  return Array.from({ length: rows }, () => new Array(cols).fill(0));
}

export function identity(n: number): Mat {
  const m = zeroMat(n, n);
  for (let i = 0; i < n; i++) m[i][i] = 1;
  return m;
}

/** Matrix-vector product. */
export function matVec(A: Mat, x: Vec): Vec {
  const out = new Array(A.length).fill(0);
  for (let i = 0; i < A.length; i++) {
    const row = A[i];
    let s = 0;
    for (let j = 0; j < row.length; j++) s += row[j] * x[j];
    out[i] = s;
  }
  return out;
}

/** Accumulate the outer product g g^T into C (in place): C += w * g g^T. */
export function accumulateOuter(C: Mat, g: Vec, w = 1): void {
  const n = g.length;
  for (let i = 0; i < n; i++) {
    const gi = g[i] * w;
    const row = C[i];
    for (let j = 0; j < n; j++) row[j] += gi * g[j];
  }
}

export type Eigen = { values: number[]; vectors: Vec[] };

/**
 * Symmetric eigendecomposition by cyclic Jacobi rotations. Returns eigenvalues
 * in descending order and their eigenvectors (unit length). `vectors[k]` is the
 * eigenvector for `values[k]`. Robust for the small, symmetric PSD matrices the
 * workspace produces (gradient covariance, input covariance).
 */
export function jacobiEigen(input: Mat, maxSweeps = 100, tol = 1e-14): Eigen {
  const n = input.length;
  if (n === 0) return { values: [], vectors: [] };
  if (n === 1) return { values: [input[0][0]], vectors: [[1]] };

  // Work on a symmetrised copy so tiny asymmetries in the estimate don't break
  // the rotation invariants.
  const A: Mat = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => 0.5 * (input[i][j] + input[j][i])),
  );
  const V = identity(n);

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
    if (off < tol) break;

    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = A[p][q];
        if (Math.abs(apq) < 1e-300) continue;
        const app = A[p][p];
        const aqq = A[q][q];
        // Classic stable rotation: theta = (aqq - app) / (2 apq).
        const theta = (aqq - app) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        // Rotate rows/cols p and q of A: A <- J^T A J.
        for (let i = 0; i < n; i++) {
          const aip = A[i][p];
          const aiq = A[i][q];
          A[i][p] = c * aip - s * aiq;
          A[i][q] = s * aip + c * aiq;
        }
        for (let i = 0; i < n; i++) {
          const api = A[p][i];
          const aqi = A[q][i];
          A[p][i] = c * api - s * aqi;
          A[q][i] = s * api + c * aqi;
        }
        A[p][q] = 0;
        A[q][p] = 0;

        // Accumulate the rotation into V.
        for (let i = 0; i < n; i++) {
          const vip = V[i][p];
          const viq = V[i][q];
          V[i][p] = c * vip - s * viq;
          V[i][q] = s * vip + c * viq;
        }
      }
    }
  }

  const raw = A.map((row, i) => row[i]);
  const order = raw.map((_, i) => i).sort((a, b) => raw[b] - raw[a]);
  const values = order.map((i) => raw[i]);
  const vectors = order.map((i) => {
    const v = V.map((row) => row[i]);
    const nrm = norm(v) || 1;
    // Fix a sign convention (largest-magnitude entry positive) so names and
    // loadings are stable across runs.
    let mi = 0;
    for (let k = 1; k < v.length; k++) if (Math.abs(v[k]) > Math.abs(v[mi])) mi = k;
    const sign = v[mi] < 0 ? -1 : 1;
    return v.map((x) => (x * sign) / nrm);
  });
  return { values, vectors };
}

/** Solve A x = b for a square A by Gaussian elimination with partial
 *  pivoting. Returns null if A is singular. Used for the ridge normal
 *  equations, where A is small and well-conditioned by the ridge term. */
export function solveLinear(Ain: Mat, bin: Vec): Vec | null {
  const n = Ain.length;
  const A = Ain.map((row, i) => [...row, bin[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) return null;
    if (piv !== col) [A[col], A[piv]] = [A[piv], A[col]];
    const pivVal = A[col][col];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col] / pivVal;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) A[r][c] -= f * A[col][c];
    }
  }
  // Full Gauss-Jordan above leaves A diagonal, so x[i] = A[i][n] / A[i][i].
  return A.map((row, i) => row[n] / row[i]);
}

/** Coefficient of determination between observed y and prediction yhat. */
export function r2Score(y: number[], yhat: number[]): number {
  const m = mean(y);
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < y.length; i++) {
    ssRes += (y[i] - yhat[i]) * (y[i] - yhat[i]);
    ssTot += (y[i] - m) * (y[i] - m);
  }
  if (ssTot < 1e-30) return 0;
  return 1 - ssRes / ssTot;
}

/** Pearson correlation. */
export function corr(a: number[], b: number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  const den = Math.sqrt(saa * sbb);
  return den < 1e-30 ? 0 : sab / den;
}
