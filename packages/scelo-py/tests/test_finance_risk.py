import math

import numpy as np
import pandas as pd
import pytest

import scelo as sc


def test_discount_curve_table():
    dc = sc.discount_curve(0.05, max_tenor=10)
    assert abs(dc["discount factor"].iloc[4] - 1.05 ** -5) < 1e-12
    assert abs(dc["1y forward"].iloc[3] - 0.05) < 1e-12
    assert abs(dc["annuity-certain a_n"].iloc[9] - (1 - 1.05 ** -10) / 0.05) < 1e-12
    dc2 = sc.discount_curve({1: 0.03, 5: 0.04, 10: 0.05}, max_tenor=12)
    assert abs(dc2["zero rate"].iloc[2] - 0.035) < 1e-12 and abs(dc2["zero rate"].iloc[11] - 0.05) < 1e-12
    dc3 = sc.discount_curve(pd.DataFrame({"tenor": [1, 2], "rate": [3.0, 4.0]}), max_tenor=2)  # percent values
    assert abs(dc3["zero rate"].iloc[0] - 0.03) < 1e-12


def test_fm_toolkit():
    assert abs(sc.annuity_certain(10, 0.05) - (1 - 1.05 ** -10) / 0.05) < 1e-12
    assert abs(sc.annuity_certain(10, 0.05, due=True) - (1 - 1.05 ** -10) / (0.05 / 1.05)) < 1e-12
    assert abs(sc.accumulation(10, 0.05) - ((1.05 ** 10 - 1) / 0.05)) < 1e-9
    assert abs(sc.irr([-100, 60, 60]) - 0.1306623862918075) < 1e-8
    assert abs(sc.pv([100] * 5, 0.05) - 100 * sc.annuity_certain(5, 0.05)) < 1e-9
    assert abs(sc.bond_price(100, 0.05, 10, 0.05) - 100) < 1e-9
    assert abs(sc.bond_yield(100, 100, 0.05, 10) - 0.05) < 1e-6
    assert 7 < sc.duration([5] * 9 + [105], 0.05) < 9
    assert sc.duration([5] * 9 + [105], 0.05, modified=True) < sc.duration([5] * 9 + [105], 0.05)
    z = sc.bootstrap_par([0.03, 0.035, 0.04])
    assert abs(z.iloc[0] - 0.03) < 1e-12 and z.iloc[2] > 0.04
    with pytest.raises(ValueError):
        sc.irr([100, 10])


def test_smith_wilson_fits_exactly_and_converges():
    t, r = [1, 2, 5, 10, 30], [0.032, 0.0325, 0.034, 0.035, 0.0344]
    sw = sc.smith_wilson(t, r, ufr=0.042, alpha=0.1, max_tenor=120)
    for tt, rr in zip(t, r):
        assert abs(sw.loc[sw["tenor"] == tt, "zero rate"].iloc[0] - rr) < 1e-9
    assert abs(sw["1y forward"].iloc[-1] - 0.042) < 2e-3


def test_nelson_siegel_and_nss():
    t = [1, 2, 3, 5, 7, 10, 20, 30]
    r = [0.02, 0.023, 0.025, 0.028, 0.03, 0.032, 0.035, 0.036]
    ns = sc.nelson_siegel(t, r)
    assert np.abs(ns.set_index("tenor").loc[t, "zero rate"].to_numpy() - np.array(r)).max() < 1e-3
    nss = sc.nss(t, r)
    assert np.abs(nss.set_index("tenor").loc[t, "zero rate"].to_numpy() - np.array(r)).max() < 1e-3


def test_hull_white_paths():
    hw = sc.hull_white(0.04, n_paths=500, horizon=3, seed=1)
    assert len(hw) == 36 and hw.attrs["paths"].shape == (36, 500)
    assert hw["mean df"].is_monotonic_decreasing


def test_var_tvar():
    x = np.arange(1, 1001, dtype=float)
    assert sc.var(x, 0.99) == np.quantile(x, 0.99)
    assert sc.tvar(x, 0.99) >= sc.var(x, 0.99)


def test_aggregate_loss_methods_agree_with_theory():
    lam, mu, sig = 5, 8, 1
    mean_theory = lam * math.exp(mu + sig ** 2 / 2)
    sd_theory = math.sqrt(lam * math.exp(2 * mu + 2 * sig ** 2))
    for method in ("panjer", "fft"):
        a = sc.aggregate_loss("poisson", "lognormal", lam=lam, mu=mu, sigma=sig, method=method)
        assert abs(a.attrs["mean"] / mean_theory - 1) < 2e-3 and abs(a.attrs["sd"] / sd_theory - 1) < 5e-3
    mc = sc.aggregate_loss("poisson", "lognormal", lam=lam, mu=mu, sigma=sig, method="mc", n_sims=50_000)
    assert abs(mc.attrs["mean"] / mean_theory - 1) < 0.03
    nb = sc.aggregate_loss("negbin", "gamma", r=3, beta=2, alpha=2, theta=1000)
    assert abs(nb.attrs["mean"] - 12000) < 20
    assert (nb["TVaR"] >= nb["VaR"]).all()


def test_fit_ranks_true_family_first():
    x = np.random.default_rng(2).lognormal(8, 1.2, 2000)
    f = sc.fit(x)
    assert f["distribution"].iloc[0] == "lognormal"
    assert abs(f["p_mu"].iloc[0] - 8) < 0.1 and abs(f["p_sigma"].iloc[0] - 1.2) < 0.1
    mu, s = sc.lognormal_params(1000, 500)
    assert abs(math.exp(mu + s * s / 2) - 1000) < 1e-9


def test_credibility_and_full_credibility():
    rng = np.random.default_rng(1)
    df = pd.DataFrame({"group": np.repeat(list("ABC"), [50, 30, 5]), "lr": np.concatenate([rng.normal(0.7, 0.1, 50), rng.normal(0.9, 0.1, 30), rng.normal(0.5, 0.1, 5)])})
    c = sc.credibility(df, "group", "lr")
    assert c.loc["A", "Z"] > c.loc["C", "Z"] > 0 and c.loc["A", "Z"] <= 1
    assert abs(c.loc["C", "credibility_premium"] - c.loc["C", "mean"]) > 0  # shrunk toward the collective
    assert round(sc.full_credibility(0.9, 0.05)) == 1082
    assert abs(sc.limited_fluctuation(270.5, p=0.9, k=0.05) - 0.5) < 1e-2


def test_aggregate_scr():
    t = sc.aggregate_scr({"mortality": 100, "longevity": 50, "lapse": 200, "expense": 80, "cat": 40})
    scr = t.loc["SCR", "charge"]
    assert 0 < scr < 470 and abs(t["marginal"].dropna().sum() - scr) < 1e-9
    ident = sc.aggregate_scr({"a": 3, "b": 4}, corr=pd.DataFrame(np.eye(2), index=["a", "b"], columns=["a", "b"]))
    assert abs(ident.loc["SCR", "charge"] - 5) < 1e-12


def test_rate_conversions_and_risk_margin():
    assert abs(sc.effective(sc.nominal(0.05, 12), 12) - 0.05) < 1e-12
    assert abs(sc.from_force(sc.force(0.05)) - 0.05) < 1e-12
    assert abs(sc.discount_rate(0.05) - 0.05 / 1.05) < 1e-12
    assert abs(sc.risk_margin([100, 80, 60], 0.04, 0.06) - 0.06 * (100 / 1.04 + 80 / 1.04 ** 2 + 60 / 1.04 ** 3)) < 1e-9
