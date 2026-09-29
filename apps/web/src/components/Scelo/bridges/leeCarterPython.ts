// Optional Python delegation for the Lee-Carter mortality projection.
//
// Pipes a (year, age, qx) table to the bundled CPython runtime; numpy
// does the SVD (the classic Lee-Carter step that turns log(qx[t,x]) into
// α(x) + β(x)·κ(t)); statsmodels SARIMAX fits an ARIMA(0,1,0) random
// walk with drift on κ(t) and produces 10-year-ahead point forecasts +
// 95% CI. The in-browser engine (mortality.ts) fits the same model on the
// same table outside the IDE, and when this bridge fails (with the reason on
// the card).
//
// Same pattern as the other bridges: read JSON on stdin, write JSON on
// stdout. Error contract: null ONLY when the bridge does not apply (outside
// the IDE, or the dataset is not a mortality table — the in-browser runner
// then says what is missing); a missing runtime or a failed script THROWS
// with the reason. It used to return null for all of these, and the card
// could only say "lee-carter bridge produced no result (runtime missing,
// unsupported data shape, or script error)".

import {
  bridgeFailureReason,
  getRuntimeStatus,
  isDesktopIDE,
  runPython,
} from "../../../lib/sceloIDE";
import type { Dataset } from "../SoftDataWorkstation";
import { detectMortalityTable } from "../mortality";

export interface LeeCarterPythonOutput {
  /** Projection year labels — last historical year + 1 … + h. */
  years: number[];
  /** Same as `years` — the key a wired life-contingencies run reads. */
  projYears: number[];
  /** The fitted model, so a wired life-contingencies run can price the cohort. */
  ages: number[];
  alpha: number[];
  beta: number[];
  kappaForecast: number[];
  /** Point forecasts of q(x) at the headline age. */
  qx: number[];
  /** 95% lower / upper CI from the SARIMAX κ(t) forecast. */
  qxLower: number[];
  qxUpper: number[];
  headlineAge: number;
  /** Annual improvement rate inferred from κ(t)'s drift coefficient. */
  annualImprovement: number;
  /** κ(t) drift (mean of first differences of fitted κ). */
  kappaDrift: number;
  rowsUsed: number;
  source: "lee-carter-python";
}

const SCRIPT = `
import json, sys, math
try:
    import numpy as np
    import pandas as pd
    from statsmodels.tsa.statespace.sarimax import SARIMAX
    payload = json.load(sys.stdin)
    df = pd.DataFrame(payload["rows"])
    headline_age = int(payload.get("headlineAge", 65))
    horizon = int(payload.get("horizon", 10))
    # Pivot to a (year × age) log-rate matrix. Skip any non-finite cells.
    df = df[df["qx"] > 0].copy()
    df["log_qx"] = np.log(df["qx"].astype(float))
    pivot = df.pivot_table(index="year", columns="age", values="log_qx", aggfunc="mean").dropna(how="any")
    if pivot.empty or pivot.shape[0] < 3 or pivot.shape[1] < 2:
        print(json.dumps({"error": "Lee-Carter needs >=3 years × >=2 ages of (year, age, qx)"}))
        sys.exit(2)
    years = pivot.index.values.astype(int)
    ages = pivot.columns.values.astype(int)
    M = pivot.values                              # (T, A)
    alpha = M.mean(axis=0)                        # (A,)
    C = M - alpha[None, :]
    # Truncated SVD: keep the first singular component (the canonical LC step).
    U, S, Vt = np.linalg.svd(C, full_matrices=False)
    beta_raw = Vt[0, :]                           # (A,) age sensitivities
    kappa_raw = U[:, 0] * S[0]                    # (T,) time index
    # Normalise per Lee-Carter convention: sum(beta) = 1, mean(kappa) = 0.
    s = beta_raw.sum()
    if s == 0:
        print(json.dumps({"error": "Lee-Carter degenerate β = 0"}))
        sys.exit(2)
    beta = beta_raw / s
    kappa = kappa_raw * s
    kappa = kappa - kappa.mean()
    # ARIMA(0,1,0) with constant on κ — Lee-Carter's classic random walk
    # with drift. SARIMAX gives us the forecast intervals for free.
    model = SARIMAX(kappa, order=(0, 1, 0), trend="c")
    fit = model.fit(disp=False)
    fc = fit.get_forecast(steps=horizon)
    k_fc = fc.predicted_mean
    k_ci = fc.conf_int(alpha=0.05)
    drift = float(np.diff(kappa).mean())
    # Project q(x) at headline_age. Find the row in beta/alpha that matches.
    if headline_age not in ages:
        # Default to the closest available age.
        headline_age = int(ages[np.argmin(np.abs(ages - headline_age))])
    aix = int(np.where(ages == headline_age)[0][0])
    a_x = float(alpha[aix])
    b_x = float(beta[aix])
    proj_years = list(range(int(years.max()) + 1, int(years.max()) + 1 + horizon))
    qx_proj    = [float(math.exp(a_x + b_x * float(k_fc[i]))) for i in range(horizon)]
    qx_lower   = [float(math.exp(a_x + b_x * float(k_ci.iloc[i, 0]))) for i in range(horizon)]
    qx_upper   = [float(math.exp(a_x + b_x * float(k_ci.iloc[i, 1]))) for i in range(horizon)]
    # Annualised improvement = -(qx_proj[-1] / qx_now)^(1/horizon) + 1, with
    # qx_now = exp(alpha + beta * kappa_last).
    qx_now = float(math.exp(a_x + b_x * float(kappa[-1])))
    annual_imp = 1 - (qx_proj[-1] / qx_now) ** (1 / horizon) if qx_now > 0 else 0
    print(json.dumps({
        "years": proj_years,
        "projYears": proj_years,
        "ages": [int(a) for a in ages],
        "alpha": [float(a) for a in alpha],
        "beta": [float(b) for b in beta],
        "kappaForecast": [float(k) for k in k_fc],
        "qx": qx_proj,
        "qxLower": qx_lower,
        "qxUpper": qx_upper,
        "headlineAge": headline_age,
        "annualImprovement": annual_imp,
        "kappaDrift": drift,
        "rowsUsed": int(len(df)),
        "source": "lee-carter-python",
    }))
except Exception as e:
    print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
    sys.exit(1)
`;

interface BridgeInput {
  rows: Array<{ year: number; age: number; qx: number }>;
  headlineAge: number;
  horizon: number;
}

/** The (year, age, qx) cells of the dataset's mortality table — the SAME
 *  table the in-browser fit reads (qx, mx, or deaths / exposure), so both
 *  engines fit one thing. Null when there is no table Lee–Carter can use. */
function buildInput(dataset: Dataset): BridgeInput | null {
  const found = detectMortalityTable(dataset);
  if ("reason" in found) return null;
  const t = found.table;
  if (t.years.length < 3) return null; // a single period cannot be projected
  const rows: Array<{ year: number; age: number; qx: number }> = [];
  for (const [i, year] of t.years.entries()) {
    for (const [j, age] of t.ages.entries()) {
      const qx = t.q[i][j];
      if (Number.isFinite(qx) && qx > 0 && qx < 1) rows.push({ year, age, qx });
    }
  }
  if (rows.length === 0) return null;
  return { rows, headlineAge: 65, horizon: 10 };
}

export async function runLeeCarterPython(
  dataset: Dataset,
): Promise<LeeCarterPythonOutput | null> {
  if (!isDesktopIDE()) return null;
  // Shape before runtime: data that is not a mortality table is not a
  // bridge failure — the in-browser runner explains what is missing.
  const input = buildInput(dataset);
  if (!input) return null;
  const status = await getRuntimeStatus();
  if (!status.python) throw new Error("bundled Python runtime not detected");
  const res = await runPython(SCRIPT, { stdin: JSON.stringify(input) });
  if (!res.ok) throw new Error(bridgeFailureReason(res));
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout.trim());
  } catch {
    throw new Error("Lee-Carter bridge returned non-JSON output");
  }
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    throw new Error(String((parsed as { error: unknown }).error));
  }
  return parsed as LeeCarterPythonOutput;
}
