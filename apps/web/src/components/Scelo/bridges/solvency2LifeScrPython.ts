// Optional Python delegation for the Solvency II life-underwriting SCR.
//
// Pipes the model-point file as JSON to bundled CPython, which runs
// lifelib's `annuallife / TradLife_A_EX1` (lifelib 0.13.0+): a per-policy
// annual traditional-life projection whose `Projection[idx]` space carries
// the standard-formula life stresses as inner projections —
// `risk_life_sub(t, risk)` = max(PV net CF base − PV net CF stressed, 0)
// for mortality, longevity, disability, lapse (worst of up / down / mass),
// expense, revision and CAT, and `risk_life(t)` aggregating them through
// the prescribed life correlation matrix (`Assumptions.life_corr`).
//
// This is the successor to lifelib's `solvency2` project (deprecated in
// 0.13.0), which the in-browser proxy in modelRunner.ts still imitates with
// toy shock factors and a flat 0.25 cross-correlation. When this bridge
// returns, the card shows the real thing and says which library ran.
//
// Portfolio aggregation: sub-risk charges are summed across policies (each
// policy's charge is floored at 0 by the library, so this is a per-policy
// floor rather than a portfolio-level one — stated on the card), then
// combined with the model's own correlation matrix. `risk_life` per policy
// is also summed and reported separately for reference.
//
// Cost: TradLife_A_EX1 is a scalar per-policy model — 0.1–0.5 s per policy
// for the t=0 stresses on term business, far more for whole-life — so the
// bridge runs policies in file order under a wall-clock budget and reports
// how many it covered. It never scales a partial answer up.
//
// Fail-soft like the other bridges: outside Scelo IDE, without the bundled
// stack, or on any script error, returns null and runModelAsync keeps the
// in-browser proxy — flagged with the reason.

import { getRuntimeStatus, isDesktopIDE, runPython } from "../../../lib/sceloIDE";
import type { Dataset } from "../SoftDataWorkstation";
import { LIFELIB_PRELUDE } from "./lifelibPrelude";

export const SCR_SUB_RISKS = [
  "mortality",
  "longevity",
  "disability",
  "lapse",
  "expense",
  "revision",
  "cat",
] as const;
export type ScrSubRisk = (typeof SCR_SUB_RISKS)[number];

export interface Solvency2LifeScrPythonOutput {
  /** Portfolio life SCR: Σ_ij corr_ij · S_i · S_j over summed sub-risks. */
  scrLife: number;
  /** Σ over policies of the model's own per-policy risk_life(0). */
  scrLifePolicySum: number;
  /** Summed sub-risk charges at t=0. */
  subs: Record<ScrSubRisk, number>;
  /** The correlation matrix the model used, in SCR_SUB_RISKS order. */
  correlation: number[][];
  pvNetCf: number; // Σ pv_net_cf(0) — value of in-force, base
  pvPremiums: number; // Σ pv_premiums(0)
  pvClaims: number; // Σ pv_claims(0)
  modelPointsTotal: number;
  modelPointsUsed: number;
  policySeconds: number;
  lifelibVersion: string;
  modelxVersion: string;
  model: "annuallife/TradLife_A_EX1";
  source: "tradlife-a-ex1-python";
}

export const SCR_TIME_BUDGET_S = 45;

export const SCR_SCRIPT = `${LIFELIB_PRELUDE}
TIME_BUDGET_S = float(os.environ.get("SCELO_LIFELIB_BUDGET_S", "${SCR_TIME_BUDGET_S}"))
try:
    payload = json.load(sys.stdin)
    mp, meta = scelo_model_points(payload.get("rows", []), payload.get("columns"))

    model = lifelib_model("annuallife", "TradLife_A_EX1")

    # TradLife_A reads its policies from InputData.policy_data() (a named
    # range in input.xlsx). Swap that cells' formula for one that returns
    # our frame; every dependent is cleared by modelx automatically.
    prods = mp["product"] if "product" in mp.columns else pd.Series("TERM", index=mp.index)
    prods = prods.where(prods.isin(["TERM", "WL", "ENDW"]), "TERM")
    n = len(mp)
    pol = pd.DataFrame({
        "Product": prods.values,
        "PolType": 1,
        "Gen": 1,
        "Channel": np.nan,
        "Duration": (mp["duration_mth"] // 12).astype(int).values,
        "Sex": mp["sex"].values,
        "IssueAge": mp["age_at_entry"].astype(int).values,
        "PaymentMode": 1,
        "PremFreq": 12,
        "PolicyTerm": mp["policy_term"].astype(int).values,
        "MaxPolicyTerm": np.maximum(mp["policy_term"].astype(int).values, 65),
        "PolicyCount": mp["policy_count"].astype(float).values,
        "SumAssured": mp["sum_assured"].astype(float).values,
    }, index=pd.Index(range(1, n + 1), name="Policy"))
    model.InputData.scelo_policy_data = pol
    model.InputData.policy_data.formula = "def policy_data():\\n    return scelo_policy_data"

    R = model.Enums.LifeRiskID
    RISKS = [("mortality", R.MORT), ("longevity", R.LONGV), ("disability", R.DISAB),
             ("lapse", R.LAPSE), ("expense", R.EXPS), ("revision", R.REV), ("cat", R.CAT)]
    corr = [[float(model.Assumptions.life_corr(a, b)) for _, b in RISKS] for _, a in RISKS]

    subs = {k: 0.0 for k, _ in RISKS}
    scr_sum = 0.0; pv_net = 0.0; pv_prem = 0.0; pv_clm = 0.0
    used = 0
    t_start = time.time()
    for idx in range(n):
        if used > 0 and (time.time() - t_start) > TIME_BUDGET_S:
            break
        p = model.Projection[idx]
        for k, code in RISKS:
            subs[k] += float(p.risk_life_sub(0, code))
        scr_sum += float(p.risk_life(0))
        pv_net += float(p.pv_net_cf(0))
        pv_prem += float(p.pv_premiums(0))
        pv_clm += float(p.pv_claims(0))
        used += 1
    secs = time.time() - t_start

    vals = [subs[k] for k, _ in RISKS]
    scr = math.sqrt(max(0.0, sum(corr[i][j] * vals[i] * vals[j]
                                 for i in range(len(vals)) for j in range(len(vals)))))

    emit({
        "scrLife": scr,
        "scrLifePolicySum": scr_sum,
        "subs": subs,
        "correlation": corr,
        "pvNetCf": pv_net,
        "pvPremiums": pv_prem,
        "pvClaims": pv_clm,
        "modelPointsTotal": int(meta["rowsIn"]),
        "modelPointsUsed": int(used),
        "policySeconds": round(secs, 2),
        "model": "annuallife/TradLife_A_EX1",
        "source": "tradlife-a-ex1-python",
    })
except SystemExit:
    raise
except Exception as e:
    _fail(f"{type(e).__name__}: {e}")
`;

export async function runSolvency2LifeScrPython(
  dataset: Dataset,
): Promise<Solvency2LifeScrPythonOutput | null> {
  if (!isDesktopIDE()) return null;
  const status = await getRuntimeStatus();
  if (!status.python) return null;
  const payload = JSON.stringify({
    name: dataset.name,
    columns: dataset.columns,
    rows: dataset.rows,
  });
  const res = await runPython(SCR_SCRIPT, { stdin: payload });
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.stdout.trim());
    if (parsed && "error" in parsed) return null;
    return parsed as Solvency2LifeScrPythonOutput;
  } catch {
    return null;
  }
}
