// Optional Python delegation for the workspace bottleneck.
//
// Pipes the numeric columns to the bundled CPython runtime; numpy standardises
// them, eigendecomposes the covariance for the low-rank codes, and fits the
// non-negative broadcast B by projected-gradient non-negative least squares,
// then reports reconstruction and causal-alignment quality. Mirrors the
// in-browser TS engine (components/Scelo/workspace/bottleneck.ts) so the numbers
// agree; falls back to it outside the IDE or when numpy is unavailable.
//
// Same contract as the other bridges: JSON on stdin, one JSON line on stdout,
// null on any failure (silent browser fallback).

import { getRuntimeStatus, isDesktopIDE, runPython } from "../../../lib/sceloIDE";
import type { Dataset } from "../SoftDataWorkstation";
import { numericColumns } from "../workspace";

export interface BottleneckPythonOutput {
  codeNames: string[];
  heads: string[];
  /** Non-negative broadcast: heads x codes. */
  broadcast: number[][];
  participationRatio: number;
  reconstructionR2: number;
  causalAlignment: number;
  sparsity: number;
  rowsUsed: number;
  source: "workspace-bottleneck-python";
}

const SCRIPT = `
import json, sys
try:
    import numpy as np
    payload = json.load(sys.stdin)
    cols = payload["columns"]
    X = np.asarray(payload["rows"], dtype=float)   # (n, d)
    r = int(payload.get("r", 3))
    n, d = X.shape
    if n < 10 or d < 3:
        print(json.dumps({"error": "bottleneck needs >=10 rows and >=3 numeric columns"})); sys.exit(2)
    r = max(1, min(r, d - 1))
    mu = X.mean(axis=0); sd = X.std(axis=0, ddof=1); sd[sd < 1e-9] = 1.0
    Z = (X - mu) / sd                              # standardised columns
    # Codes = top-r eigenvectors of the covariance (the low-rank workspace).
    C = np.cov(Z, rowvar=False)
    w, V = np.linalg.eigh(C)                       # ascending
    order = np.argsort(w)[::-1]
    w = w[order]; V = V[:, order]
    Vr = V[:, :r]                                  # (d, r)
    colsum = Z.sum(axis=1)
    codes = Z @ Vr                                 # (n, r)
    for k in range(r):
        if np.corrcoef(codes[:, k], colsum)[0, 1] < 0:
            Vr[:, k] *= -1; codes[:, k] *= -1
    # Non-negative L1 least squares per head column (projected gradient).
    G = codes.T @ codes
    lr = 1.0 / (np.trace(G) + 1e-9)
    l1 = 1e-3
    B = np.zeros((d, r))
    for c in range(d):
        y = Z[:, c]; cvec = codes.T @ y; b = np.zeros(r)
        for _ in range(300):
            grad = G @ b - cvec + l1
            b = np.maximum(0.0, b - lr * grad)
        B[c] = b
    recon = codes @ B.T                            # (n, d)
    ss_res = ((Z - recon) ** 2).sum(axis=0)
    ss_tot = ((Z - Z.mean(axis=0)) ** 2).sum(axis=0); ss_tot[ss_tot < 1e-30] = 1.0
    reconstructionR2 = float(np.clip(1 - ss_res / ss_tot, 0, 1).mean())
    # Causal alignment: does B[:,k] match the true code-to-head slopes?
    align = []
    for k in range(r):
        zk = codes[:, k]; vk = zk.var(ddof=1) or 1.0
        slopes = np.array([np.cov(Z[:, c], zk, ddof=1)[0, 1] / vk for c in range(d)])
        bcol = B[:, k]
        if bcol.std() < 1e-12 or slopes.std() < 1e-12:
            align.append(0.0)
        else:
            align.append(float(np.corrcoef(bcol, slopes)[0, 1] ** 2))
    causalAlignment = float(np.mean(align)) if align else 0.0
    wr = np.maximum(w[:r], 0.0)
    pr = float((wr.sum() ** 2) / (wr ** 2).sum()) if (wr ** 2).sum() > 0 else 0.0
    maxB = max(float(np.abs(B).max()), 1e-9)
    sparsity = float((np.abs(B) < 0.02 * maxB).mean())
    def name_code(loadings):
        idx = np.argsort(-np.abs(loadings))
        top = loadings[idx[0]]
        if abs(top) < 1e-9: return "mixed"
        floor = 0.35 * abs(top)
        terms = [f"{cols[i].replace('_',' ').replace('-',' ')} {'up' if loadings[i] >= 0 else 'down'}"
                 for i in idx[:3] if abs(loadings[i]) >= floor]
        return ", ".join(terms)
    codeNames = [name_code(Vr[:, k]) for k in range(r)]
    print(json.dumps({
        "codeNames": codeNames,
        "heads": cols,
        "broadcast": B.tolist(),
        "participationRatio": pr,
        "reconstructionR2": reconstructionR2,
        "causalAlignment": causalAlignment,
        "sparsity": sparsity,
        "rowsUsed": int(n),
        "source": "workspace-bottleneck-python",
    }))
except Exception as e:
    print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
    sys.exit(1)
`;

export async function runBottleneckPython(
  dataset: Dataset,
  r = 3,
): Promise<BottleneckPythonOutput | null> {
  if (!isDesktopIDE()) return null;
  const status = await getRuntimeStatus();
  if (!status.python) return null;
  const cols = numericColumns(dataset);
  if (cols.length < 3) return null;

  // Row-capped, complete-case numeric matrix.
  const cap = 20_000;
  const stride = Math.max(1, Math.floor(dataset.rows.length / cap));
  const matrix: number[][] = [];
  for (let i = 0; i < dataset.rows.length; i += stride) {
    const row = cols.map((c) => {
      const v = dataset.rows[i][c];
      return typeof v === "number" && Number.isFinite(v) ? v : Number.NaN;
    });
    if (row.every((v) => Number.isFinite(v))) matrix.push(row);
  }
  if (matrix.length < 10) return null;

  const stdin = JSON.stringify({ columns: cols, rows: matrix, r });
  const res = await runPython(SCRIPT, { stdin });
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.stdout.trim());
    if (parsed && typeof parsed === "object" && "error" in parsed) return null;
    return parsed as BottleneckPythonOutput;
  } catch {
    return null;
  }
}
