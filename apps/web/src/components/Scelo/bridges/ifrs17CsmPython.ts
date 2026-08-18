// Optional Python delegation for the IFRS 17 CSM roll-forward.
//
// Pipes the model-point file as JSON to bundled CPython, which runs
// lifelib's `ifrs17sim` library — the CSM (General Measurement Model / BBA)
// simulated on top of the simplelife annual projection: initial recognition
// CSM(0) = max(0, PV future CF − RA), then per period interest accretion,
// fulfilment-cash-flow adjustment and coverage-units release
// (`TransServices`). Returns the CSM at issue, the aggregate CSM balance
// vector, the per-year release and the PV components.
//
// lifelib status (0.14.0): ifrs17sim is LEGACY — deprecated with simplelife
// in 0.12.0, still shipped, still runs. The active IFRS 17 engine is
// `ifrs17a`, but it is driven from nominal-cash-flow / data-node workbooks,
// not a model-point file, so for a model-point-shaped input ifrs17sim
// remains the library that answers this question. The card says so.
//
// Honesty notes baked into the output:
//   - ifrs17sim's RiskAdjustment(t) is a stub that returns 0 ("to be
//     implemented" in the library). We report exactly that — RA 0 with a
//     note — rather than inventing an 18 % loading in Python.
//   - The projection is per policy (0.15–0.3 s each), so the bridge runs
//     policies in file order under a wall-clock budget and reports how many
//     it covered; it never scales a partial answer up to the whole file.
//
// Same fail-soft pattern as the other bridges: outside Scelo IDE or when
// the bundled stack is missing, returns null and runModelAsync falls back
// to the in-browser TS port (and says why).

import { getRuntimeStatus, isDesktopIDE, runPython } from "../../../lib/sceloIDE";
import type { Dataset } from "../SoftDataWorkstation";
import { LIFELIB_PRELUDE } from "./lifelibPrelude";

export interface Ifrs17CsmPythonOutput {
  csm0: number; // Σ CSM at initial recognition
  pvProfit: number; // Σ PV(net cash flow) at t0 (PV_FutureCF)
  pvPremiums: number; // Σ PV premium income at t0
  pvBenefits: number; // Σ PV benefits at t0 (positive = outflow)
  pvExpenses: number; // Σ PV expenses at t0 (positive = outflow)
  riskAdjustment: number; // Σ RA at t0 — 0 in ifrs17sim (stub), see note
  riskAdjustmentNote: string;
  release: number[]; // Σ TransServices(t): CSM released for services, per year
  balance: number[]; // Σ CSM(t): balance at the start of each year
  insurRevenue: number[]; // Σ InsurRevenue(t) per year
  years: number;
  modelPointsTotal: number;
  modelPointsUsed: number;
  policySeconds: number; // wall time spent projecting policies
  lifelibVersion: string;
  modelxVersion: string;
  model: "ifrs17sim/OuterProj";
  libraryStatus: "legacy";
  successor: "ifrs17a";
  source: "ifrs17sim-python";
}

/** Wall-clock budget for the per-policy loop. Deterministic (file order),
 *  reported in the output as modelPointsUsed vs modelPointsTotal. */
export const IFRS17_TIME_BUDGET_S = 45;

export const IFRS17_SCRIPT = `${LIFELIB_PRELUDE}
TIME_BUDGET_S = float(os.environ.get("SCELO_LIFELIB_BUDGET_S", "${IFRS17_TIME_BUDGET_S}"))
try:
    payload = json.load(sys.stdin)
    mp, meta = scelo_model_points(payload.get("rows", []), payload.get("columns"))

    model = lifelib_model("ifrs17sim", "model")

    # simplelife-style PolicyData: a mapping keyed by (PolicyID, column).
    # Product from a product column when it is one of simplelife's three,
    # else TERM. Duration in years. PaymentMode / MaxPolicyTerm are read by
    # nothing in the projection but must exist.
    prods = mp["product"] if "product" in mp.columns else pd.Series("TERM", index=mp.index)
    prods = prods.where(prods.isin(["TERM", "WL", "ENDW"]), "TERM")
    ids = list(range(1, len(mp) + 1))
    labels = list(mp.index)
    custom = {}
    for pid, (_, r), prod in zip(ids, mp.iterrows(), prods):
        custom[(pid, "Product")] = str(prod)
        custom[(pid, "PolicyType")] = 1
        custom[(pid, "Gen")] = 1
        custom[(pid, "Channel")] = 1
        custom[(pid, "Duration")] = int(r["duration_mth"]) // 12
        custom[(pid, "Sex")] = str(r["sex"])
        custom[(pid, "IssueAge")] = int(r["age_at_entry"])
        custom[(pid, "PaymentMode")] = 1
        custom[(pid, "PremFreq")] = 12
        custom[(pid, "PolicyTerm")] = int(r["policy_term"])
        custom[(pid, "MaxPolicyTerm")] = max(int(r["policy_term"]), 65)
        custom[(pid, "PolicyCount")] = float(r["policy_count"])
        custom[(pid, "SumAssured")] = float(r["sum_assured"])
    model.Input.PolicyData = custom
    model.OuterProj.Policy.PolicyData = custom

    csm0 = 0.0; pv_prem = 0.0; pv_ben = 0.0; pv_exp = 0.0; pv_net = 0.0; ra0 = 0.0
    balance = {}; release = {}; revenue = {}
    used = 0
    t_start = time.time()
    for pid in ids:
        if used > 0 and (time.time() - t_start) > TIME_BUDGET_S:
            break
        p = model.OuterProj[pid]
        last = int(p.last_t())
        pv = p.InnerProj(0).PV(0)
        csm0 += float(p.CSM(0))
        ra0 += float(p.RiskAdjustment(0))
        pv_prem += float(pv.PV_PremIncome(0))
        pv_ben += -float(pv.PV_BenefitTotal(0))
        pv_exp += -float(pv.PV_ExpsTotal(0))
        pv_net += float(pv.PV_NetCashflow(0))
        # CSM(t) is defined through last_t (the balance runs off to 0);
        # TransServices / InsurRevenue are per-period flows for t < last_t
        # (at last_t there are no coverage units left to release against).
        for t in range(0, last + 1):
            balance[t] = balance.get(t, 0.0) + float(p.CSM(t))
        for t in range(0, last):
            release[t] = release.get(t, 0.0) + float(p.TransServices(t))
            revenue[t] = revenue.get(t, 0.0) + float(p.InsurRevenue(t))
        used += 1
    secs = time.time() - t_start
    years = max(balance) if balance else 0
    bal = [balance.get(t, 0.0) for t in range(years + 1)]
    rel = [release.get(t, 0.0) for t in range(years)]
    rev = [revenue.get(t, 0.0) for t in range(years)]

    emit({
        "csm0": csm0,
        "pvProfit": pv_net,
        "pvPremiums": pv_prem,
        "pvBenefits": pv_ben,
        "pvExpenses": pv_exp,
        "riskAdjustment": ra0,
        "riskAdjustmentNote": "ifrs17sim's RiskAdjustment(t) is unimplemented in the library (returns 0); CSM(0) = max(0, PV future CF).",
        "release": rel,
        "balance": bal,
        "insurRevenue": rev,
        "years": int(years),
        "modelPointsTotal": int(meta["rowsIn"]),
        "modelPointsUsed": int(used),
        "policySeconds": round(secs, 2),
        "model": "ifrs17sim/OuterProj",
        "libraryStatus": "legacy",
        "successor": "ifrs17a",
        "source": "ifrs17sim-python",
    })
except SystemExit:
    raise
except Exception as e:
    _fail(f"{type(e).__name__}: {e}")
`;

export async function runIfrs17CsmPython(dataset: Dataset): Promise<Ifrs17CsmPythonOutput | null> {
  if (!isDesktopIDE()) return null;
  const status = await getRuntimeStatus();
  if (!status.python) return null;
  const payload = JSON.stringify({
    name: dataset.name,
    columns: dataset.columns,
    rows: dataset.rows,
  });
  const res = await runPython(IFRS17_SCRIPT, { stdin: payload });
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.stdout.trim());
    if (parsed && "error" in parsed) return null;
    return parsed as Ifrs17CsmPythonOutput;
  } catch {
    return null;
  }
}
