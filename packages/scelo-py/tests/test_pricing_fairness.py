import numpy as np
import pandas as pd
import pytest

import scelo as sc

statsmodels = pytest.importorskip("statsmodels", reason="parity test needs statsmodels")


@pytest.fixture(scope="module")
def motor():
    rng = np.random.default_rng(5)
    n = 4000
    df = pd.DataFrame({"region": rng.choice(["GP", "WC", "KZN"], n, p=[0.5, 0.3, 0.2]), "age": rng.integers(18, 70, n), "exposure": rng.uniform(0.2, 1, n)})
    mu = np.exp(-2 + np.where(df.region == "WC", 0.3, np.where(df.region == "KZN", -0.2, 0)) + 0.01 * (df.age - 40)) * df.exposure
    df["claims"] = rng.poisson(mu)
    df["sev"] = rng.gamma(2, np.exp(7 + 0.02 * (df.age - 40)))
    df["y"] = (rng.random(n) < 1 / (1 + np.exp(-(-1 + 0.03 * (df.age - 40))))).astype(int)
    return df


@pytest.mark.parametrize("family,formula,kw", [
    ("poisson", "claims ~ C(region) + age", {"offset": "exposure"}),
    ("gamma", "sev ~ age + C(region)", {}),
    ("binomial", "y ~ age", {}),
    ("tweedie", "sev ~ age", {"power": 1.5}),
    ("gaussian", "sev ~ age", {}),
])
def test_numpy_irls_matches_statsmodels(motor, family, formula, kw):
    a = sc.glm(motor, formula, family, engine="numpy", **kw)
    b = sc.glm(motor, formula, family, engine="statsmodels", **kw)
    assert np.allclose(a.params.to_numpy(), b.params.to_numpy(), atol=1e-5)
    assert np.allclose(a.coef["std_err"].to_numpy(), b.coef["std_err"].to_numpy(), rtol=1e-3)
    assert abs(a.deviance - b.deviance) < 1e-4 * max(1, abs(b.deviance))


def test_relativities_predict_lift(motor):
    m = sc.glm(motor, "claims ~ C(region) + age", "poisson", offset="exposure", engine="numpy")
    rel = m.relativities()
    assert rel[rel["level"].str.endswith("(base)")]["relativity"].tolist() == [1.0]
    assert abs(rel[rel["level"] == "WC"]["relativity"].iloc[0] - np.exp(0.3)) < 0.15
    pred = m.predict(motor.head(5))
    assert np.allclose(pred, m.fitted[:5])
    lift = sc.lift(motor.claims, m.fitted, bins=5, exposure=motor.exposure)
    assert len(lift) == 5 and lift["actual"].iloc[-1] > lift["actual"].iloc[0]
    assert 0 < sc.gini(motor.claims, m.fitted) < 1
    assert sc.rate_table(m).loc["GP (base)"].notna().any()


def test_freq_sev_loss_ratio(motor):
    fs = sc.freq_sev(motor, "region", count="claims", amount="sev", exposure="exposure")
    tot = fs[fs["region"] == "total"].iloc[0]
    assert abs(tot["claims"] - motor.claims.sum()) < 1e-9 and abs(tot["pure_premium"] - tot["frequency"] * tot["severity"]) < 1e-6
    lr = sc.loss_ratio(pd.DataFrame({"paid": [100, 50, 30], "premium": [200, 100, 100], "line": ["a", "a", "b"]}), "line")
    assert lr.set_index("line").loc["total", "loss_ratio"] == 0.45
    bc = sc.burning_cost(pd.DataFrame({"loss": [100, 200], "exposure": [10, 10], "year": [2020, 2021]}), trend=0.1, years="year", to_year=2021)
    assert abs(bc - (110 + 200) / 20) < 1e-9


def test_price_pipeline(motor):
    t = sc.price(motor, "claims ~ C(region) + age", offset="exposure", severity="sev")
    assert "pure_premium" in t.columns and t.attrs["severity"] is not None


def test_fairness_metrics():
    rng = np.random.default_rng(3)
    n = 3000
    g = rng.choice(["a", "b"], n)
    y = (rng.random(n) < 0.3).astype(int)
    score = np.where(g == "a", 0.6, 0.4) + rng.normal(0, 0.05, n)
    df = pd.DataFrame({"g": g, "y": y, "score": score})
    f = sc.fairness(df, "y", "score", "g")
    assert set(f["g"]) == {"a", "b"} and f["disparate_impact"].min() < 0.8
    di = sc.disparate_impact(df, "score", "g")
    assert abs(di.max() - 1) < 1e-12


def test_fairness_audit_removes_alignment():
    rng = np.random.default_rng(1)
    n = 2000
    df = pd.DataFrame({"age": rng.integers(18, 70, n)})
    df["prot"] = (rng.random(n) < 0.3).astype(int)
    df["score"] = 0.02 * df.age + 0.5 * df.prot + rng.normal(0, 0.1, n)
    t = sc.fairness_audit(df, "score", "prot", ["age"]).set_index("stage")
    assert t.loc["before", "alignment"] > 0.1 and t.loc["after", "alignment"] < 0.05
    assert t.loc["after", "disparity"] < t.loc["before", "disparity"]
    assert t.loc["after", "fit_to_legitimate"] >= t.loc["before", "fit_to_legitimate"] - 0.05
