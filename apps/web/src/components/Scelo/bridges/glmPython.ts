// Optional Python delegation for the pricing GLM tools.
//
// Pipes claims + covariate columns to bundled CPython, fits a
// statsmodels GLM (Poisson with offset(log(exposure)) for frequency;
// Gamma with log-link for severity), and returns the coefficient table
// (parameter, value, std-err, z, p) plus model-fit summary (AIC, Pearson
// chi², deviance). The in-browser TS port produces a grouped mean as a
// proxy; this is the real thing pricing actuaries actually run.
//
// Categorical covariates are pulled from the dataset's first few
// `line` / `state` / `sex` / `vehicle_class` columns; users with a
// richer schema should fall back to the notebook-export path.

import { isDesktopIDE, runPython, getRuntimeStatus } from "../../../lib/sceloIDE";
import type { Dataset } from "../SoftDataWorkstation";

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
}

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

function pickCovariates(dataset: Dataset): string[] {
  const preferred = ["line", "state", "sex", "vehicle_class", "region", "age_band"];
  return preferred.filter((c) => dataset.columns.includes(c)).slice(0, 3);
}

export async function runGlmPython(
  dataset: Dataset,
  kind: GlmKind,
): Promise<GlmPythonOutput | null> {
  if (!isDesktopIDE()) return null;
  const status = await getRuntimeStatus();
  if (!status.python) return null;
  const cov = pickCovariates(dataset);
  if (cov.length === 0) return null;
  // Frequency models claim count per row (1 if a row IS a claim, else 0)
  // unless an explicit "claim_count" column is present. Severity models
  // the paid amount per row.
  const hasCount = dataset.columns.includes("claim_count");
  const target = kind === "frequency"
    ? hasCount ? "claim_count" : "_freq_unit"
    : "paid";
  // For the unit-frequency case we synthesise a column locally so the
  // Python side gets a real frame.
  const rows = dataset.rows.map((r) => {
    if (target === "_freq_unit") return { ...r, [target]: 1 };
    return r;
  });
  const stdin = JSON.stringify({ kind, target, covariates: cov, rows });
  const res = await runPython(SCRIPT, { stdin });
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.stdout.trim());
    if (parsed && "error" in parsed) return null;
    return parsed as GlmPythonOutput;
  } catch {
    return null;
  }
}
