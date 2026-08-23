import math

import numpy as np
import pandas as pd
import pytest

import scelo as sc


def test_life_table_invariants():
    lt = sc.life_table()
    assert len(lt) == 91 and lt["lx"].iloc[0] == 100_000 and lt["qx"].iloc[-1] == 1 and abs(lt["ex"].iloc[-1] - 0.5) < 1e-9
    assert np.allclose(lt["lx"].iloc[1:].to_numpy(), (lt["lx"] - lt["dx"]).iloc[:-1].to_numpy())
    assert np.allclose(lt["dx"], lt["lx"] * lt["qx"])
    assert abs(lt["Tx"].iloc[0] - lt["Lx"].sum()) < 1e-6 and abs(lt["ex"].iloc[0] - lt["Lx"].sum() / 100_000) < 1e-9
    assert lt["qx"].iloc[:-1].is_monotonic_increasing
    assert any("ILLUSTRATIVE" in n for n in lt.notes)


def test_qx_from_columns():
    q = sc.qx(pd.DataFrame({"age": [30, 30, 31, 33], "qx": [1.0, 1.2, 1.3, 1.5]}))  # percent-shaped, with a gap
    assert abs(q.qx[0] - 0.011) < 1e-12 and abs(q.qx[2] - 0.014) < 1e-12 and 32 in q.ages
    q2 = sc.qx(pd.DataFrame({"age": [40, 40, 41], "deaths": [1, 1, 3], "exposure": [200, 200, 600]}))
    assert abs(q2.qx[0] - 0.005) < 1e-12 and "ungraduated" in q2.notes[0]
    q3 = sc.qx(pd.DataFrame({"age": [50, 51, 52], "lx": [1000, 990, 975]}))
    assert abs(q3.qx[0] - 0.01) < 1e-12
    with pytest.raises(KeyError):
        sc.qx(pd.DataFrame({"foo": [1]}))


def test_commutation_and_factor_identities():
    cm = sc.commutation(i=0.04)
    assert abs(cm["Nx"].iloc[0] - cm["Dx"].sum()) < 1e-6 and abs(cm["Mx"].iloc[0] - cm["Cx"].sum()) < 1e-6
    assert abs(cm["Rx"].iloc[0] - cm["Mx"].sum()) < 1e-6 and abs(cm["Sx"].iloc[0] - cm["Nx"].sum()) < 1e-6
    assert np.allclose(cm["Cx"] / cm["Dx"], (cm["dx"] / cm["lx"]) / 1.04)
    f = sc.factors(i=0.04, n=10)
    d = 0.04 / 1.04
    assert np.allclose(f["Ax"], 1 - d * f["äx"])
    assert np.allclose(f["ax"], f["äx"] - 1)
    ok = f["Ax:10"].notna()
    assert np.allclose(f.loc[ok, "Ax:10"], f.loc[ok, "A¹x:10"] + f.loc[ok, "10Ex"])
    assert f["Ax:10"].isna().sum() == 10  # blank where x + n runs past the table


def test_premium_grid():
    p = sc.premium(i=0.04, product="term")
    e = sc.premium(i=0.04, product="endowment")
    f = sc.factors(i=0.04, n=10)
    row = f[f["age"] == 30].iloc[0]
    assert abs(p[p["age"] == 30]["n=10"].iloc[0] - 1000 * row["A¹x:10"] / row["äx:10"]) < 1e-9
    assert (e["n=10"] > p["n=10"]).all()
    w = sc.premium(i=0.04, product="whole-life")
    assert "whole life" in w.columns
    assert abs(sc.annuity(65, i=0.04) - f[f["age"] == 65]["äx"].iloc[0]) < 1e-12


def test_ae_and_model_points():
    exp_df = pd.DataFrame({"age": np.repeat(np.arange(60, 70), 3), "deaths": np.tile([1, 0, 2], 10), "exposure": 100.0})
    a = sc.ae(exp_df)
    assert list(a["age band"]) == ["60–64", "65–69", "total"]
    assert abs(a["actual deaths"].iloc[-1] - 30) < 1e-9
    mp = sc.model_points(sc.sample("lifelib-mp"))
    assert mp["policy_count"].sum() == 100 and abs(mp["sum_assured"].sum() - sc.sample("lifelib-mp")["sum_assured"].sum()) < 1e-6


def test_survival_helpers():
    q = pd.Series([0.1, 0.2, 1.0])
    s = sc.survival(q)
    assert abs(s.iloc[1] - 0.9) < 1e-12 and abs(s.iloc[2] - 0.72) < 1e-12 and s.iloc[3] == 0
    assert abs(sc.life_expectancy(q, curtate=True) - (0.9 + 0.72)) < 1e-12
    assert sc.close_table(pd.Series([0.1, 0.2, 0.3], index=[60, 61, 62])).iloc[-1] == 1.0


def test_graduate_smooths():
    rng = np.random.default_rng(1)
    true = sc.makeham(range(30, 90))
    crude = true * np.exp(rng.normal(0, 0.15, 60))
    g = sc.graduate(crude, h=100)
    assert np.abs(np.log(g["graduated"].to_numpy()) - np.log(true.to_numpy())).mean() < np.abs(np.log(crude.to_numpy()) - np.log(true.to_numpy())).mean()
    assert (g["graduated"] > 0).all()


def test_lee_carter_recovers_drift():
    years, ages = np.arange(1990, 2020), np.arange(50, 91)
    rows = [{"year": y, "age": a, "qx": math.exp(-9 + 0.09 * a - 0.015 * (y - 1990))} for y in years for a in ages]
    lc = sc.lee_carter(pd.DataFrame(rows), horizon=5)
    assert abs(lc.bx.sum() - 1) < 1e-9 and abs(lc.kt.mean()) < 1e-9
    assert lc.explained > 0.99
    imp = 1 - (lc.forecast["rate@65"].iloc[-1] / lc.forecast["rate@65"].iloc[0]) ** (1 / 4)
    assert abs(imp - (1 - math.exp(-0.015))) < 1e-3


def test_kaplan_meier_textbook():
    km = sc.kaplan_meier(pd.DataFrame({"time": [1, 2, 2, 3, 5, 8, 8, 9], "status": [1, 1, 0, 1, 0, 1, 1, 0]}))
    assert np.allclose(km["S"], [0.875, 0.75, 0.6, 0.2])
    assert km["at_risk"].tolist() == [8, 7, 5, 3]


def test_exposure_splits_at_birthdays():
    ex = sc.exposure(pd.DataFrame({"start": ["2020-01-01"], "end": ["2022-01-01"], "age": [40.5], "died": [1]}), "start", "end", event="died")
    e = ex.set_index("age")["exposure"]
    assert abs(e[40] - 0.5) < 1e-6 and abs(e[41] - 1.0) < 1e-6 and abs(e[42] - 0.5) < 2e-3  # 2020 is a leap year
    assert ex.set_index("age")["deaths"][42] == 1


def test_basicterm_projection_matches_ide_expectations():
    bt = sc.basicterm(sc.sample("lifelib-mp"))
    pv = bt.attrs["pv"]
    assert pv["net"] < 0 and pv["premiums"] < pv["claims"]  # the IDE's live test: this sample is under-priced
    assert len(bt) > 120 and "model-point file" in bt.basis
    no_prem = sc.basicterm(sc.sample("lifelib-mp").drop(columns=["premium_pp"]))
    assert "loading" in no_prem.basis


def test_mx_qx_epv_ae_test():
    q = sc.mx_to_qx([0.01, 0.02])
    assert abs(q.iloc[0] - 0.01 / 1.005) < 1e-12
    assert np.allclose(sc.qx_to_mx(q), [0.01, 0.02])
    assert abs(sc.mx_to_qx([0.01], "constant").iloc[0] - (1 - math.exp(-0.01))) < 1e-12
    f = sc.factors(i=0.04)
    a65 = f[f["age"] == 65]["äx"].iloc[0]
    assert abs(sc.epv([1.0] * 200, 65, i=0.04) - a65) < 1e-6          # annuity-due of 1 = äx
    A65 = f[f["age"] == 65]["Ax"].iloc[0]
    assert abs(sc.epv([1.0] * 200, 65, i=0.04, on_death=True) - A65) < 1e-6  # whole-life assurance = Ax
    t = sc.ae_test(120, 100)
    assert abs(t["ae"] - 1.2) < 1e-12 and t["p_value"] < 0.05 and t["lower95"] < 1.2 < t["upper95"]
