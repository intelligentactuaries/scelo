// Optional Python delegation for the pricing GLM tools.
//
// Pipes claims + covariate columns to bundled CPython, fits a
// statsmodels GLM (Poisson with offset(log(exposure)) for frequency;
// Gamma with log-link for severity), and returns the coefficient table
// (parameter, value, std-err, z, p) plus model-fit summary (AIC, Pearson
// chi², deviance). The in-browser TS port produces a grouped mean as a
// proxy; this is the real thing pricing actuaries actually run.
//
// Covariates and targets are detected from the dataset's own shape (see
// modelRunner's detect* helpers) — no hardcoded schema. Only the needed
// columns are serialised, and rows are capped: JSON.stringify of a full
// 2M-row dataset is a ~1 GB string, past V8's string limit.
//
// Error contract: returns null ONLY when the bridge is unavailable
// (browser build / no bundled Python). Anything else that stops a fit —
// no usable target, Python error, bad output — THROWS with the reason so
// the caller can surface it instead of silently substituting the mock.

import { isDesktopIDE, runPython, getRuntimeStatus } from "../../../lib/sceloIDE";
import type { Dataset } from "../SoftDataWorkstation";
import {
  detectCategoricalCovariates,
  detectFrequencyTarget,
  detectMonetaryColumn,
} from "../modelRunner";

export type GlmKind = "frequency" | "severity";

export interface GlmCoef {
  name: string;
  estimate: number;
  stdErr: number;
  z: number;
  pValue: number;
}

export interface GlmPythonOutput {
  kind: GlmKind;
  family: "Poisson" | "Gamma";
  link: "log";
  covariates: string[];
  coefficients: GlmCoef[];
  aic: number;
  deviance: number;
  pearsonChi2: number;
  nObservations: number;
  source: "statsmodels-python";
  // Serialisation cap bookkeeping (TS-side): how many rows were actually
  // piped to Python vs how many the dataset holds.
  rowsSent: number;
  rowsTotal: number;
}

// Hard cap on rows serialised to the Python child. statsmodels gains
// nothing past this for a handful of categorical covariates, and the JSON
// pipe stays comfortably under IPC / string limits.
const GLM_BRIDGE_ROW_CAP = 200_000;

// Design-matrix guard: 3-4 categorical covariates at ≤20 levels each is
// plenty for the bridge's coefficient table.
const GLM_BRIDGE_MAX_COVARIATES = 3;

const SCRIPT = `
import json, sys
try:
    import numpy as np
    import pandas as pd
    import statsmodels.api as sm
    import statsmodels.formula.api as smf
    payload = json.load(sys.stdin)
    kind = payload["kind"]
    target = payload["target"]              # column name to model
    covariates = payload["covariates"]      # list of column names
    rows = payload["rows"]
    df = pd.DataFrame(rows)
    # Drop rows missing any of the required columns.
    needed = [target] + covariates
    df = df.dropna(subset=needed)
    if len(df) < 5:
        print(json.dumps({"error": f"only {len(df)} usable rows; need >=5"}))
        sys.exit(2)
    # Build R-style formula: target ~ C(cov1) + C(cov2) + ...
    rhs = " + ".join(
        f"C({c})" if df[c].dtype == object else c
        for c in covariates
    )
    formula = f"{target} ~ {rhs}" if rhs else f"{target} ~ 1"
    if kind == "frequency":
        # Poisson log-link. Exposure offset if present.
        family = sm.families.Poisson(sm.families.links.Log())
        offset = None
        if "exposure" in df.columns:
            ex = df["exposure"].astype(float).clip(lower=1e-6)
            offset = np.log(ex.values)
        model = smf.glm(formula=formula, data=df, family=family, offset=offset)
        fam = "Poisson"
    else:
        # Severity: Gamma log-link. Filter to positive paid only.
        df = df[df[target].astype(float) > 0]
        if len(df) < 5:
            print(json.dumps({"error": "not enough positive-paid rows for severity"}))
            sys.exit(2)
        family = sm.families.Gamma(sm.families.links.Log())
        model = smf.glm(formula=formula, data=df, family=family)
        fam = "Gamma"
    fit = model.fit()
    coefs = []
    for name in fit.params.index:
        coefs.append({
            "name": str(name),
            "estimate": float(fit.params[name]),
            "stdErr": float(fit.bse.get(name, float("nan"))),
            "z": float(fit.tvalues.get(name, float("nan"))),
            "pValue": float(fit.pvalues.get(name, float("nan"))),
        })
    out = {
        "kind": kind,
        "family": fam,
        "link": "log",
        "covariates": covariates,
        "coefficients": coefs,
        "aic": float(fit.aic),
        "deviance": float(fit.deviance),
        "pearsonChi2": float(fit.pearson_chi2),
        "nObservations": int(fit.nobs),
        "source": "statsmodels-python",
    }
    print(json.dumps(out))
except Exception as e:
    print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
    sys.exit(1)
`;

export async function runGlmPython(
  dataset: Dataset,
  kind: GlmKind,
): Promise<GlmPythonOutput | null> {
  if (!isDesktopIDE()) return null;
  const status = await getRuntimeStatus();
  if (!status.python) return null;
  const cov = detectCategoricalCovariates(dataset).slice(0, GLM_BRIDGE_MAX_COVARIATES);
  if (cov.length === 0) {
    throw new Error("no categorical covariates detected (need string columns with 2-20 levels)");
  }
  // Frequency prefers an explicit count column (past_claims, claim_count…);
  // when the data is claims-level (one row per claim) we synthesise a unit
  // count so the Poisson still fits. Severity requires a monetary column.
  let target: string;
  if (kind === "frequency") {
    target = detectFrequencyTarget(dataset) ?? "_freq_unit";
  } else {
    const money = detectMonetaryColumn(dataset);
    if (!money) {
      throw new Error("no monetary severity column detected (paid / claim_amt / severity / loss)");
    }
    target = money;
  }
  // Project ONLY the columns the fit needs and cap rows with an even
  // stride so the sample spans the file. Sending whole rows at 2M-row
  // scale serialises hundreds of MB and blows V8's string length limit.
  const wanted = cov.slice();
  if (target !== "_freq_unit") wanted.push(target);
  if (dataset.columns.includes("exposure")) wanted.push("exposure");
  const rowsTotal = dataset.rows.length;
  const n = Math.min(rowsTotal, GLM_BRIDGE_ROW_CAP);
  const stride = rowsTotal > n ? rowsTotal / n : 1;
  const rows: Array<Record<string, unknown>> = new Array(n);
  for (let i = 0; i < n; i++) {
    const src = dataset.rows[Math.floor(i * stride)];
    const out: Record<string, unknown> = {};
    for (const c of wanted) out[c] = src[c];
    if (target === "_freq_unit") out[target] = 1;
    rows[i] = out;
  }
  const stdin = JSON.stringify({ kind, target, covariates: cov, rows });
  const res = await runPython(SCRIPT, { stdin });
  if (!res.ok) {
    throw new Error(res.stderr.trim().slice(-400) || `python exited with code ${res.exitCode}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout.trim());
  } catch {
    throw new Error("statsmodels bridge returned non-JSON output");
  }
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    throw new Error(String((parsed as { error: unknown }).error));
  }
  return {
    ...(parsed as Omit<GlmPythonOutput, "rowsSent" | "rowsTotal">),
    rowsSent: rows.length,
    rowsTotal,
  };
}
