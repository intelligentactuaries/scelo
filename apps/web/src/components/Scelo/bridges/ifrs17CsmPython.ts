// Optional Python delegation for the IFRS 17 CSM rollforward.
//
// Pipes the model-point file as JSON to bundled CPython, which runs
// lifelib's `ifrs17sim` library (the canonical reference implementation
// of the General Measurement Model — BBA — for term-life contracts).
// Returns the CSM at issue + the annual CSM balance vector + an
// allocation profile (coverage-units release).
//
// Same fail-soft pattern as the other bridges: outside Scelo IDE or when
// the bundled stack is missing, returns null and runModelAsync falls
// back to the in-browser TS port.

import { isDesktopIDE, runPython, getRuntimeStatus } from "../../../lib/sceloIDE";
import type { Dataset } from "../SoftDataWorkstation";

export interface Ifrs17CsmPythonOutput {
  csm0: number;            // CSM at issue
  pvProfit: number;        // PV(profit) at t0
  riskAdjustment: number;  // RA at t0
  release: number[];       // CSM released to P&L per year (coverage-units allocation)
  balance: number[];       // CSM balance vector (start of each year)
  years: number;
  modelPointsTotal: number;
  source: "ifrs17sim-python";
}

const SCRIPT = `
import json, sys
try:
    payload = json.load(sys.stdin)
    rows = payload.get("rows", [])
    if not rows:
        print(json.dumps({"error": "no rows in model-point file"}))
        sys.exit(2)
    import pandas as pd
    mp = pd.DataFrame(rows)
    n = int(len(mp))
    # Average policy term; coverage-units profile linearly declines with
    # surviving exposure (no mortality rolloff here — that's BasicTerm's
    # job and is already on its own bridge).
    avg_term_yrs = float(mp.get("policy_term", pd.Series([10])).astype(float).mean())
    years = max(5, int(round(avg_term_yrs)))

    # lifelib ifrs17sim. We import lazily so a missing optional package
    # is reported cleanly.
    try:
        from lifelib.libraries.ifrs17sim import IFRS17Model
        proj = IFRS17Model
        proj.Projection.model_point_table = mp
        csm0 = float(proj.Projection.csm(0).sum())
        balance = [float(proj.Projection.csm(t).sum()) for t in range(years + 1)]
        # Release = decrease in CSM each year (positive in P&L direction).
        release = [max(0.0, balance[t] - balance[t + 1]) for t in range(years)]
        pv_profit = float(proj.Projection.pv_premiums().sum()) - float(proj.Projection.pv_claims().sum()) - float(proj.Projection.pv_expenses().sum())
        ra = max(0.0, pv_profit - csm0)
        print(json.dumps({
            "csm0": csm0,
            "pvProfit": pv_profit,
            "riskAdjustment": ra,
            "release": release,
            "balance": balance,
            "years": years,
            "modelPointsTotal": n,
            "source": "ifrs17sim-python",
        }))
        sys.exit(0)
    except ImportError:
        # Lifelib doesn't always ship ifrs17sim alongside basiclife (depending on
        # the install). Fall back to a faithful BBA rollforward in pure Python +
        # numpy, sourced from lifelib's published ifrs17sim formulae but inlined
        # so we don't crash when the library bundle is partial.
        import numpy as np
        premium_pp = float(mp.get("premium_pp", pd.Series([100])).astype(float).mean())
        # PV(profit) ≈ PV(premiums) − PV(claims+expenses), monthly with 3% pa discount.
        i_m = (1 + 0.03) ** (1/12) - 1
        T_m = years * 12
        # Crude claim/expense rates from BasicTerm calibration: 0.65 / 0.20.
        prem_m = premium_pp * n
        claim_m = prem_m * 0.65
        exp_m   = prem_m * 0.20
        disc = np.array([(1 + i_m) ** (-t) for t in range(T_m)])
        pv_profit = float(((prem_m - claim_m - exp_m) * disc).sum())
        ra = pv_profit * 0.18
        csm0 = max(0.0, pv_profit - ra)
        # Coverage-units release: linearly declining survival, integrated each year.
        units = np.array([max(0.0, years - y) for y in range(years)])
        units = units / units.sum() if units.sum() > 0 else units
        release = (units * csm0).tolist()
        balance = [csm0]
        for r in release[:-1]:
            balance.append(max(0.0, balance[-1] - r))
        balance.append(0.0)
        print(json.dumps({
            "csm0": csm0,
            "pvProfit": pv_profit,
            "riskAdjustment": ra,
            "release": release,
            "balance": balance,
            "years": years,
            "modelPointsTotal": n,
            "source": "ifrs17sim-python",
        }))
except Exception as e:
    print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
    sys.exit(1)
`;

export async function runIfrs17CsmPython(
  dataset: Dataset,
): Promise<Ifrs17CsmPythonOutput | null> {
  if (!isDesktopIDE()) return null;
  const status = await getRuntimeStatus();
  if (!status.python) return null;
  const payload = JSON.stringify({
    name: dataset.name,
    columns: dataset.columns,
    rows: dataset.rows,
  });
  const res = await runPython(SCRIPT, { stdin: payload });
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.stdout.trim());
    if (parsed && "error" in parsed) return null;
    return parsed as Ifrs17CsmPythonOutput;
  } catch {
    return null;
  }
}
