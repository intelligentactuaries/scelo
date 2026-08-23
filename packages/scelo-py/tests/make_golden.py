"""Regenerate the cross-language golden fixture the R tests read.

    python tests/make_golden.py            # writes ../scelo-r/tests/testthat/fixtures/py_golden.json

Every block is a value computed by the Python package; the R package is
tested against it. Re-run whenever a function's semantics change, and
commit both the Python change and the regenerated fixture together.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

import scelo as sc

OUT = Path(__file__).resolve().parents[2] / "scelo-r" / "tests" / "testthat" / "fixtures" / "py_golden.json"

RAA = [
    [5012, 8269, 10907, 11805, 13539, 16181, 18009, 18608, 18662, 18834],
    [106, 4285, 5396, 10666, 13782, 15599, 15496, 16169, 16704, None],
    [3410, 8992, 13873, 16141, 18735, 22214, 22863, 23466, None, None],
    [5655, 11555, 15766, 21266, 23425, 26083, 27067, None, None, None],
    [1092, 9565, 15836, 22169, 25955, 26180, None, None, None, None],
    [1513, 6445, 11702, 12935, 15852, None, None, None, None, None],
    [557, 4020, 10946, 12314, None, None, None, None, None, None],
    [1351, 6947, 13112, None, None, None, None, None, None, None],
    [3133, 5395, None, None, None, None, None, None, None, None],
    [2063, None, None, None, None, None, None, None, None, None],
]


def rows(t, cols=None):
    d = pd.DataFrame(t)
    if cols:
        d = d[cols]
    return json.loads(d.to_json(orient="split", double_precision=15))


def main() -> int:
    out = {}
    out["life_table_makeham"] = rows(sc.life_table())
    out["commutation_4pct"] = rows(sc.commutation(i=0.04))
    out["factors_4pct_n10"] = rows(sc.factors(i=0.04, n=10))
    out["premium_term_4pct"] = rows(sc.premium(i=0.04, product="term"))
    out["premium_endow_4pct"] = rows(sc.premium(i=0.04, product="endowment"))
    q = sc.qx(pd.DataFrame({"age": [30, 30, 31, 33], "qx": [1.0, 1.2, 1.3, 1.5]}))
    out["qx_interp"] = {"ages": q.ages.tolist(), "qx": q.qx.tolist()}
    exp_df = pd.DataFrame({"age": np.repeat(np.arange(60, 70), 3), "deaths": np.tile([1, 0, 2], 10), "exposure": 100.0})
    out["ae"] = rows(sc.ae(exp_df))
    out["model_points"] = rows(sc.model_points(sc.sample("lifelib-mp")))
    bt = sc.basicterm(sc.sample("lifelib-mp"))
    out["basicterm"] = {"pv": bt.attrs["pv"], "months": int(len(bt)), "first": rows(bt.head(3)[["month", "premiums", "claims", "expenses", "net_cf", "discount", "pv_net_cf"]])}
    crude = sc.makeham(range(30, 90)) * np.exp(np.random.default_rng(1).normal(0, 0.15, 60))
    g = sc.graduate(crude, h=100)
    out["graduate"] = {"ages": g["age"].tolist(), "crude": g["crude"].tolist(), "graduated": g["graduated"].tolist()}
    years, ages = np.arange(1990, 2020), np.arange(50, 91)
    lcdf = pd.DataFrame([{"year": int(y), "age": int(a), "qx": math.exp(-9 + 0.09 * a - 0.015 * (y - 1990) + 0.01 * math.sin(a * y))} for y in years for a in ages])
    lc = sc.lee_carter(lcdf, horizon=5)
    out["lee_carter"] = {"data": rows(lcdf), "ax": lc.ax.tolist(), "bx": lc.bx.tolist(), "kt": lc.kt.tolist(), "drift": lc.drift, "drift_se": lc.drift_se, "forecast": rows(lc.forecast)}
    out["km"] = rows(sc.kaplan_meier(pd.DataFrame({"time": [1, 2, 2, 3, 5, 8, 8, 9], "status": [1, 1, 0, 1, 0, 1, 1, 0]})))
    arr = np.array([[np.nan if v is None else v for v in r] for r in RAA], dtype=float)
    tri = sc.from_wide(arr, origins=list(range(1981, 1991)))
    m = sc.mack(tri)
    cl = sc.chain_ladder(tri)
    cc = sc.cape_cod(tri, premium=[40000] * 10)
    out["raa"] = {"triangle": RAA, "factors": cl.factors.tolist(), "cdf": cl.cdf.tolist(), "sigma2": m.detail["sigma2"].tolist(), "mack": rows(m.table.reset_index()),
                  "bf_apriori_10000": rows(sc.bf(tri, apriori=10000).table.reset_index()), "cape_cod_40000": {"elr": cc.detail["elr"], "ibnr": cc.ibnr},
                  "tail_exp": sc.tail([1.5, 1.2, 1.1, 1.05, 1.02])}
    claims = sc.sample("claims")
    out["claims_triangle"] = rows(sc.triangle(claims).reset_index())
    out["claims_triangle_inc"] = rows(sc.triangle(claims, cumulative=False).reset_index())
    out["discount_curve_flat5"] = rows(sc.discount_curve(0.05, max_tenor=10))
    out["discount_curve_pts"] = rows(sc.discount_curve({1: 0.03, 5: 0.04, 10: 0.05}, max_tenor=12))
    out["smith_wilson"] = rows(sc.smith_wilson([1, 2, 5, 10, 30], [0.032, 0.0325, 0.034, 0.035, 0.0344], ufr=0.042, alpha=0.1, max_tenor=60))
    tn, rt = [1, 2, 3, 5, 7, 10, 20, 30], [0.02, 0.023, 0.025, 0.028, 0.03, 0.032, 0.035, 0.036]
    out["nelson_siegel"] = {"tenors": tn, "rates": rt, "curve": rows(sc.nelson_siegel(tn, rt, lam=0.5, max_tenor=30))}
    out["fm"] = {"annuity_10_5": sc.annuity_certain(10, 0.05), "annuity_due": sc.annuity_certain(10, 0.05, due=True), "Ia": sc.annuity_certain(10, 0.05, increasing=True),
                 "irr": sc.irr([-100, 60, 60]), "duration": sc.duration([5] * 9 + [105], 0.05), "convexity": sc.convexity([5] * 9 + [105], 0.05),
                 "bond_yield": sc.bond_yield(95, 100, 0.05, 10), "bootstrap_par": sc.bootstrap_par([0.03, 0.035, 0.04]).tolist()}
    ag = sc.aggregate_loss("poisson", "lognormal", lam=5, mu=8, sigma=1, method="panjer", h=100, n=4096)
    out["panjer"] = {"table": rows(ag), "mean": ag.attrs["mean"], "sd": ag.attrs["sd"]}
    ag2 = sc.aggregate_loss("negbin", "gamma", r=3, beta=2, alpha=2, theta=1000, method="panjer", h=50, n=4096)
    out["panjer_nb"] = {"mean": ag2.attrs["mean"], "sd": ag2.attrs["sd"], "var995": float(ag2[ag2.p == 0.995].VaR.iloc[0])}
    out["full_credibility"] = sc.full_credibility(0.9, 0.05)
    rng = np.random.default_rng(1)
    cdf = pd.DataFrame({"group": np.repeat(list("ABC"), [50, 30, 5]), "lr": np.concatenate([rng.normal(0.7, 0.1, 50), rng.normal(0.9, 0.1, 30), rng.normal(0.5, 0.1, 5)])})
    cr = sc.credibility(cdf, "group", "lr")
    out["credibility"] = {"data": rows(cdf), "table": rows(cr.reset_index()), "basis": cr.basis}
    out["scr"] = rows(sc.aggregate_scr({"mortality": 100, "longevity": 50, "lapse": 200, "expense": 80, "cat": 40}).reset_index())
    out["describe_1234"] = rows(sc.describe(pd.DataFrame({"x": [1, 2, 3, 4]})))
    out["describe_claims"] = rows(sc.describe(claims))
    out["profile_claims"] = rows(sc.profile(claims)[["column", "type", "count", "missing", "unique", "min", "q1", "median", "mean", "q3", "max", "lo_fence", "hi_fence", "outliers"]])
    out["suggest_dirty"] = rows(sc.suggest(sc.sample("dirty")))
    c = sc.clean(sc.sample("dirty"))
    out["clean_dirty_safe"] = {"shape": list(c.shape), "premium_sum": float(c["premium_zar"].sum()), "age_null": int(c["age"].isna().sum()), "active_true": int(c["active"].sum()), "dates_parsed": int(c["Joined Date"].notna().sum())}
    c2 = sc.clean(sc.sample("dirty"), "all")
    out["clean_dirty_all"] = {"shape": list(c2.shape), "columns": list(map(str, c2.columns))}
    out["parse_number"] = {s: sc.parse_number(s) for s in ["R 1,234.50", "(1,200)", "85%", "1 200 ZAR", "$-3", "abc", "−5", "1_000"]}
    out["parse_date"] = {s: (sc.parse_date(s).strftime("%Y-%m-%d") if sc.parse_date(s) else None) for s in ["2024-01-05", "13/02/2024", "02/13/2024", "13/13/2024", "05/06/2024", "Jan 5, 2024", "5 Jan 24", "31/02/2024", "2024-13-01", "1650-01-01"]}
    n = 4000
    rng = np.random.default_rng(5)
    motor = pd.DataFrame({"region": rng.choice(["GP", "WC", "KZN"], n, p=[.5, .3, .2]), "age": rng.integers(18, 70, n), "exposure": rng.uniform(0.2, 1, n)})
    mu = np.exp(-2 + np.where(motor.region == "WC", 0.3, np.where(motor.region == "KZN", -0.2, 0)) + 0.01 * (motor.age - 40)) * motor.exposure
    motor["claims"] = rng.poisson(mu)
    motor["sev"] = rng.gamma(2, np.exp(7 + 0.02 * (motor.age - 40)))
    gm = sc.glm(motor, "claims ~ C(region) + age", "poisson", offset="exposure", engine="numpy")
    gg = sc.glm(motor, "sev ~ age + C(region)", "gamma", engine="numpy")
    gf = sc.glm(motor, "claims ~ C(region) + age", "poisson", offset="exposure", engine="numpy", base="first")
    out["glm"] = {"data": rows(motor), "poisson": {"params": gm.params.to_dict(), "deviance": gm.deviance, "null_deviance": gm.null_deviance, "aic": gm.aic},
                  "gamma": {"params": gg.params.to_dict(), "dispersion": gg.dispersion, "deviance": gg.deviance}, "gini": sc.gini(motor.claims, gm.fitted),
                  "lift": rows(sc.lift(motor.claims, gm.fitted, bins=5, exposure=motor.exposure)), "poisson_base_first": {"params": gf.params.to_dict()}}
    out["freq_sev"] = rows(sc.freq_sev(motor, "region", count="claims", amount="sev", exposure="exposure"))
    rng = np.random.default_rng(1)
    n = 2000
    fdf = pd.DataFrame({"age": rng.integers(18, 70, n)})
    fdf["prot"] = (rng.random(n) < 0.3).astype(int)
    fdf["score"] = 0.02 * fdf.age + 0.5 * fdf.prot + rng.normal(0, 0.1, n)
    out["fairness_audit"] = {"data": rows(fdf), "table": rows(sc.fairness_audit(fdf, "score", "prot", ["age"]))}
    out["ensemble_t2m"] = rows(sc.ensemble(sc.sample("climate"), "t2m"))
    out["return_period"] = {"x": rng.gumbel(100, 30, 40).tolist()}
    out["return_period"]["table"] = rows(sc.return_period(out["return_period"]["x"]))
    out["parametric_trigger"] = sc.parametric_trigger(np.arange(1, 101))
    ws = sc.sample("workspace-demo")
    drivers = [c for c in ws.columns if c not in ("annuity_60", "life_exp_60", "survival_to_80")]
    bn = sc.bottleneck(ws[drivers], r=3)
    out["bottleneck"] = {"metrics": {k: bn.attrs[k] for k in ("participation_ratio", "reconstruction_r2", "causal_alignment", "sparsity")}, "B": bn.to_numpy().tolist(), "heads": list(map(str, bn.index))}
    asub = sc.active_subspace(ws, "annuity_60", drivers=drivers)
    out["active_subspace"] = {"rank": asub.attrs["rank"], "pr": asub.attrs["participation_ratio"], "r2": asub.attrs["surrogate_r2"], "sens": asub["sensitivity_share"].tolist(), "var": asub["variance_share"].tolist(), "names": asub["name"].tolist()}
    a = pd.DataFrame({"policy_id": ["P1", "P2", "P3"], "premium": [1, 2, 3]})
    b2 = pd.DataFrame({"Policy_ID": ["P1", "P2", "P2", "P4"], "claims": [0, 1, 2, 3], "premium": [9, 9, 9, 9]})
    out["combine"] = {"suggest": rows(sc.suggest_combine(a, b2)), "join": rows(sc.join(a, b2)), "append": rows(sc.append(a, a.assign(premium=[1, 2, 5])))}
    # SCR / CSM on the BasicTerm projection (shock dials)
    mp = sc.sample("lifelib-mp")
    s = sc.scr_life(mp)
    out["scr_life"] = {"scr": s.attrs["scr"], "bel": s.attrs["bel"], "charges": s.attrs["charges"], "lapse": s.attrs["lapse"]}
    cm = sc.csm(mp, sc.BasicTermAssumptions(premium_mult=3.0), ra=0.05)
    out["csm"] = {"csm0": cm.attrs["csm0"], "ra": cm.attrs["ra"], "fcf": cm.attrs["fcf"], "table": rows(cm)}
    shocked = sc.basicterm(mp, sc.BasicTermAssumptions(mort_mult=1.15, lapse_mult=0.5, expense_mult=1.1, expense_inflation=0.01, cat_add=0.0015, mass_lapse=0.1))
    out["basicterm_shocked"] = {"pv": shocked.attrs["pv"], "inforce_sa_12": float(shocked["inforce_sum_assured"].iloc[12])}
    OUT.write_text(json.dumps(out))
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB, {len(out)} blocks)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
