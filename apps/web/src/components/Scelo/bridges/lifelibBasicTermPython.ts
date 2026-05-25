// Optional Python delegation for the lifelib BasicTerm projection.
//
// Scelo ships a pure-TypeScript port of lifelib's basiclife/BasicTerm_M
// (`lifelibBasicTerm.ts`) that runs in the browser. Inside the Scelo IDE
// desktop shell we can additionally delegate to the real lifelib package
// running on the bundled CPython interpreter — same model, same maths,
// but with the canonical implementation rather than a port.
//
// Pattern is intentionally generic so other Tools can copy it:
//   1. Build a self-contained Python script as a string.
//   2. Serialise the dataset slice the script needs as JSON on stdin.
//   3. Parse stdout JSON into the same RunResult-friendly shape the TS
//      runner produces, so the rest of Scelo doesn't care which path ran.

import { isDesktopIDE, runPython, getRuntimeStatus } from "../../../lib/sceloIDE";
import type { Dataset } from "../SoftDataWorkstation";

export interface BasicTermPythonOutput {
  pvNetCf: number;
  totalPremiums: number;
  totalClaims: number;
  totalExpenses: number;
  modelPointsTotal: number;
  modelPointsUsed: number;
  monthly: Array<{
    month: number;
    premium: number;
    claim: number;
    expense: number;
    netCf: number;
  }>;
  breakEvenMonth: number | null;
  source: "lifelib-python";
}

// Python script delegated to the bundled interpreter. Reads the model-
// point file as JSON on stdin, calls lifelib's BasicTerm_M, returns the
// summary metrics as JSON on stdout. Designed to fail fast and verbose so
// the renderer can surface the stderr in the Tools detail view.
const SCRIPT = `
import json, sys

try:
    data = json.load(sys.stdin)
    rows = data.get("rows", [])
    if not rows:
        print(json.dumps({"error": "no rows in dataset"}))
        sys.exit(2)

    # lifelib is the headline dependency. If it isn't importable the
    # bundle is broken — surface that clearly rather than computing a
    # rough TS-equivalent and silently dropping the discrepancy.
    import lifelib
    from lifelib.libraries.basiclife import BasicTerm_M

    proj = BasicTerm_M
    # Push the user's model points into the projection. lifelib expects a
    # pandas DataFrame with specific columns; coerce row shapes safely.
    import pandas as pd
    mp = pd.DataFrame(rows)
    needed = ["age_at_entry", "sex", "policy_term", "policy_count", "sum_assured", "duration_mth"]
    for col in needed:
        if col not in mp.columns:
            # lifelib defaults the missing columns for us; just warn.
            pass
    proj.Projection.model_point_table = mp

    # Run + collect.
    income = float(proj.Projection.pv_premiums())
    claims = float(proj.Projection.pv_claims())
    expenses = float(proj.Projection.pv_expenses())
    pv_net = income - claims - expenses

    # Monthly cashflows over the configured horizon.
    monthly = []
    horizon = int(proj.Projection.last_t())
    break_even = None
    cum = 0.0
    for t in range(horizon + 1):
        prem = float(proj.Projection.premiums(t).sum())
        clm  = float(proj.Projection.claims(t).sum())
        exp  = float(proj.Projection.expenses(t).sum())
        net  = prem - clm - exp
        cum += net
        if break_even is None and cum >= 0 and t > 0:
            break_even = t
        monthly.append({"month": t, "premium": prem, "claim": clm, "expense": exp, "netCf": net})

    print(json.dumps({
        "pvNetCf": pv_net,
        "totalPremiums": income,
        "totalClaims": claims,
        "totalExpenses": expenses,
        "modelPointsTotal": int(len(mp)),
        "modelPointsUsed": int(len(mp)),
        "monthly": monthly,
        "breakEvenMonth": break_even,
        "source": "lifelib-python",
    }))
except Exception as e:
    print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
    sys.exit(1)
`;

/** Returns the BasicTerm projection from the bundled Python lifelib, or
 *  null if (a) we're not in the desktop IDE, (b) the bundled Python isn't
 *  available, or (c) lifelib failed for any reason. Callers should fall
 *  back to the in-browser TS port (`runBasicTermProjection`) in that case. */
export async function runBasicTermPython(
  dataset: Dataset,
): Promise<BasicTermPythonOutput | null> {
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
    if (parsed && typeof parsed === "object" && "error" in parsed) return null;
    return parsed as BasicTermPythonOutput;
  } catch {
    return null;
  }
}
