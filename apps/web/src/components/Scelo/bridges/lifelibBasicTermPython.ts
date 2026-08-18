// Optional Python delegation for the lifelib BasicTerm projection.
//
// Scelo ships a pure-TypeScript port of lifelib's basiclife/BasicTerm_ME
// (`lifelibBasicTerm.ts`) that runs in the browser. Inside the Scelo IDE
// desktop shell we can additionally delegate to the real lifelib package
// running on the bundled CPython interpreter — same model, same maths,
// but with the canonical implementation rather than a port.
//
// lifelib 0.14.0 / modelx 0.32.0 (see @scelo/core LIFELIB_VERSION): the
// model is loaded with `modelx.read_model(<basiclife copy>/BasicTerm_ME)`
// (see bridges/lifelibPrelude.ts for how the copy is made). BasicTerm_ME is
// the in-force variant — it honours `duration_mth`, which Scelo's MP shape
// carries; BasicTerm_M is the new-business special case. When the MP file
// has a `premium_pp` column the model's own premium table is replaced by
// that column (modelx lets us swap the `premium_pp` formula), so the user's
// premiums are projected rather than lifelib's sample rates.
//
// Pattern is intentionally generic so other Tools can copy it:
//   1. Build a self-contained Python script as a string.
//   2. Serialise the dataset slice the script needs as JSON on stdin.
//   3. Parse stdout JSON into the same RunResult-friendly shape the TS
//      runner produces, so the rest of Scelo doesn't care which path ran.

import { getRuntimeStatus, isDesktopIDE, runPython } from "../../../lib/sceloIDE";
import type { Dataset } from "../SoftDataWorkstation";
import { LIFELIB_PRELUDE } from "./lifelibPrelude";

export interface BasicTermPythonOutput {
  pvNetCf: number;
  totalPremiums: number;
  totalClaims: number;
  totalExpenses: number;
  totalCommissions: number;
  modelPointsTotal: number;
  modelPointsUsed: number;
  /** MPs whose (age_at_entry, policy_term) fell outside lifelib's premium
   *  table and had no premium_pp of their own — dropped, not guessed. */
  modelPointsUnpriced: number;
  premiumSource: "model-point-file" | "lifelib-premium-table";
  monthly: Array<{
    month: number;
    premium: number;
    claim: number;
    expense: number;
    commission: number;
    netCf: number;
  }>;
  breakEvenMonth: number | null;
  lifelibVersion: string;
  modelxVersion: string;
  model: "basiclife/BasicTerm_ME";
  source: "lifelib-python";
}

// Python script delegated to the bundled interpreter. Reads the model-
// point file as JSON on stdin, runs lifelib's BasicTerm_ME, returns the
// summary metrics as JSON on stdout. Designed to fail fast and verbose so
// the renderer can surface the stderr in the Tools detail view.
export const BASICTERM_SCRIPT = `${LIFELIB_PRELUDE}
try:
    data = json.load(sys.stdin)
    mp, meta = scelo_model_points(data.get("rows", []), data.get("columns"))

    model = lifelib_model("basiclife", "BasicTerm_ME")
    P = model.Projection

    table = mp[["age_at_entry", "sex", "policy_term", "policy_count", "sum_assured", "duration_mth"]].copy()
    unpriced = 0
    if meta["hasPremium"]:
        # Use the file's premiums: replace the premium_pp cells formula so it
        # reads the model-point column instead of lifelib's premium_table.
        table["premium_pp"] = mp["premium_pp"].fillna(0.0).astype(float)
        P.model_point_table = table
        P.premium_pp.formula = "def premium_pp():\\n    return model_point()['premium_pp']"
        premium_source = "model-point-file"
    else:
        # lifelib's premium_table only covers age 20-59 x term {10,15,20};
        # anything else prices to NaN. Drop those rows and say how many.
        P.model_point_table = table
        priced = P.premium_pp()
        bad = priced.isna()
        unpriced = int(bad.sum())
        if unpriced:
            table = table.loc[~bad.values]
            if len(table) == 0:
                _fail("no model point falls inside lifelib's premium table (age 20-59, term 10/15/20) and the file has no premium_pp column", 2)
            P.model_point_table = table
        premium_source = "lifelib-premium-table"

    pv = P.result_pv()          # per-policy PV Premiums / Claims / Expenses / Commissions / Net Cashflow
    cf = P.result_cf()          # aggregate monthly Premiums / Claims / Expenses / Commissions / Net Cashflow

    income = float(pv["PV Premiums"].sum())
    claims = float(pv["PV Claims"].sum())
    expenses = float(pv["PV Expenses"].sum())
    commissions = float(pv["PV Commissions"].sum())
    pv_net = float(pv["PV Net Cashflow"].sum())

    monthly = []
    break_even = None
    cum = 0.0
    for t, row in cf.iterrows():
        prem = float(row["Premiums"]); clm = float(row["Claims"])
        exp_ = float(row["Expenses"]); com = float(row["Commissions"])
        net = float(row["Net Cashflow"])
        cum += net
        if break_even is None and cum >= 0 and t > 0:
            break_even = int(t)
        monthly.append({"month": int(t), "premium": prem, "claim": clm, "expense": exp_,
                        "commission": com, "netCf": net})

    emit({
        "pvNetCf": pv_net,
        "totalPremiums": income,
        "totalClaims": claims,
        "totalExpenses": expenses,
        "totalCommissions": commissions,
        "modelPointsTotal": int(meta["rowsIn"]),
        "modelPointsUsed": int(len(table)),
        "modelPointsUnpriced": unpriced,
        "premiumSource": premium_source,
        "monthly": monthly,
        "breakEvenMonth": break_even,
        "model": "basiclife/BasicTerm_ME",
        "source": "lifelib-python",
    })
except SystemExit:
    raise
except Exception as e:
    _fail(f"{type(e).__name__}: {e}")
`;

/** Returns the BasicTerm projection from the bundled Python lifelib, or
 *  null if (a) we're not in the desktop IDE, (b) the bundled Python isn't
 *  available, or (c) lifelib failed for any reason. Callers should fall
 *  back to the in-browser TS port (`runBasicTermProjection`) in that case. */
export async function runBasicTermPython(dataset: Dataset): Promise<BasicTermPythonOutput | null> {
  if (!isDesktopIDE()) return null;
  const status = await getRuntimeStatus();
  if (!status.python) return null;

  const payload = JSON.stringify({
    name: dataset.name,
    columns: dataset.columns,
    rows: dataset.rows,
  });
  const res = await runPython(BASICTERM_SCRIPT, { stdin: payload });
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.stdout.trim());
    if (parsed && typeof parsed === "object" && "error" in parsed) return null;
    return parsed as BasicTermPythonOutput;
  } catch {
    return null;
  }
}
