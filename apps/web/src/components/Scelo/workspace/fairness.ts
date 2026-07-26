// Fair pricing and indirect discrimination: the protected-direction readout.
//
// Anti-discrimination law forbids not only pricing on a protected attribute but
// laundering it through a proxy. The workspace makes the laundered channel
// visible: the alignment of the model's decision-relevant variation with the
// protected direction, computable even when the protected attribute is absent
// from the model's inputs. Residualising the proxy against the protected
// attribute closes the channel while sparing legitimate risk signal (Case C).

import type { Row } from "../SoftDataWorkstation";
import { corr, mean, solveLinear } from "./linalg";
import type { FairnessReadout } from "./types";

function col(rows: Row[], name: string): number[] {
  return rows.map((r) => {
    const v = r[name];
    return typeof v === "number" && Number.isFinite(v) ? v : Number.NaN;
  });
}

/** Ordinary least squares with an intercept. Returns in-sample predictions and
 *  a coefficient vector [b0, b1, ...]. Small designs, ridge-free (guarded). */
function ols(features: number[][], y: number[]): { pred: number[]; coef: number[] } {
  const n = y.length;
  const k = features.length; // number of feature columns
  const p = k + 1; // + intercept
  const A: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  const rhs = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const x = [1, ...features.map((f) => f[i])];
    for (let a = 0; a < p; a++) {
      rhs[a] += x[a] * y[i];
      for (let b = 0; b < p; b++) A[a][b] += x[a] * x[b];
    }
  }
  for (let a = 0; a < p; a++) A[a][a] += 1e-8; // tiny guard
  const coef = solveLinear(A, rhs) ?? new Array(p).fill(0);
  const pred = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = coef[0];
    for (let j = 0; j < k; j++) s += coef[j + 1] * features[j][i];
    pred[i] = s;
  }
  return { pred, coef };
}

/** Residualise x against a single attribute a: x - OLS(x ~ a). */
function residualise(x: number[], a: number[]): number[] {
  const { pred } = ols([a], x);
  return x.map((xi, i) => xi - pred[i]);
}

/** Standardised group price gap of `p` split at the median of the protected
 *  attribute `a`. */
function disparity(p: number[], a: number[]): number {
  const med = median(a);
  const hi: number[] = [];
  const lo: number[] = [];
  for (let i = 0; i < p.length; i++) (a[i] > med ? hi : lo).push(p[i]);
  const sd = Math.sqrt(varOf(p)) || 1;
  return Math.abs(mean(hi) - mean(lo)) / sd;
}

function median(xs: number[]): number {
  const s = [...xs].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function varOf(xs: number[]): number {
  const m = mean(xs);
  return xs.reduce((s, x) => s + (x - m) * (x - m), 0) / Math.max(1, xs.length - 1);
}

export type FairnessInput = {
  rows: Row[];
  /** The protected attribute A (present in the data for the audit, not used by
   *  the model). */
  protectedCol: string;
  /** Legitimate, allowed risk factors L. */
  legitimateCols: string[];
  /** Features the model actually uses (may launder A through a proxy). */
  proxyCols: string[];
  /** The outcome the model is fit to (may carry a prohibited dependence). */
  targetCol: string;
};

/**
 * Audit a pricing model for indirect discrimination. Fits the model on its
 * proxy features, reads its sensitivity onto the protected direction (the share
 * of non-legitimate variation aligned with A), then residualises the proxies
 * against A and re-audits, reporting the alignment and group-disparity before
 * and after, plus the fit to the legitimate (fair) target.
 */
export function protectedReadout(input: FairnessInput): FairnessReadout {
  const { rows, protectedCol, legitimateCols, proxyCols, targetCol } = input;
  // Complete-case filter, consistent with col(): a cell counts only when it
  // IS a finite number. The old Number(v) coercion let nulls through
  // (Number(null) === 0) while col() mapped the same nulls to NaN — one
  // null anywhere poisoned the regression and every reported metric read
  // NaN. Legitimate columns were not filtered at all.
  const finite = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
  const needed = [protectedCol, targetCol, ...legitimateCols, ...proxyCols];
  const keep = rows.filter((r) => needed.every((c) => finite(r[c])));
  if (keep.length < 10) {
    throw new Error(
      `only ${keep.length} complete rows across the chosen columns — pick columns with fewer missing values`,
    );
  }
  const a = col(keep, protectedCol);
  const y = col(keep, targetCol);
  const legit = legitimateCols.map((c) => col(keep, c));
  const proxies = proxyCols.map((c) => col(keep, c));

  // Degenerate inputs produce meaningless (or NaN) audits — refuse loudly.
  if (varOf(a) < 1e-30) {
    throw new Error(`protected column \`${protectedCol}\` has no variation in the complete rows`);
  }
  if (varOf(col(keep, targetCol)) < 1e-30) {
    throw new Error(`target column \`${targetCol}\` has no variation in the complete rows`);
  }

  // The model: fit on proxy features only (never on A).
  const model = ols(proxies, y);
  const p = model.pred;

  // The fair target: the legitimate-only fit.
  const fair = ols(legit, y).pred;

  // The laundered channel: the share of the prediction's TOTAL variation that
  // is both non-legitimate and aligned with the protected direction. Measuring
  // it as a share of the whole prediction (not of the residual) keeps it well
  // behaved when the non-legitimate part collapses to zero after mitigation.
  const alignmentBefore = protectedShare(p, legit, a);
  const disparityBefore = disparity(p, a);
  const fitBefore = corr(p, fair) ** 2;

  // Mitigation: residualise each proxy against A, refit, re-audit.
  const proxiesR = proxies.map((x) => residualise(x, a));
  const modelR = ols(proxiesR, y);
  const pR = modelR.pred;
  const alignmentAfter = protectedShare(pR, legit, a);
  const disparityAfter = disparity(pR, a);
  const fitAfter = corr(pR, fair) ** 2;

  return {
    protectedCol,
    legitimateCols,
    alignmentBefore,
    alignmentAfter,
    disparityBefore,
    disparityAfter,
    fitBefore,
    fitAfter,
  };
}

/** The non-legitimate part of `p`: p minus its fit on the legitimate signal. */
function removeLegit(legit: number[][], p: number[]): number[] {
  const fit = ols(legit, p).pred;
  return p.map((pi, i) => pi - fit[i]);
}

/** Share of the prediction's total variance that is non-legitimate AND aligned
 *  with the protected attribute: corr(residual, A)^2 * var(residual) / var(p). */
function protectedShare(p: number[], legit: number[][], a: number[]): number {
  const resid = removeLegit(legit, p);
  const vp = varOf(p);
  if (vp < 1e-30) return 0;
  return (corr(resid, a) ** 2 * varOf(resid)) / vp;
}
