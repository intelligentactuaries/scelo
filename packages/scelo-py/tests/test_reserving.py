import numpy as np
import pandas as pd
import pytest

import scelo as sc


def test_mack_raa_published_values(raa):
    m = sc.mack(raa)
    assert round(m.ibnr) == 52135 and round(m.ultimate) == 213122 and round(m.latest) == 160987
    assert round(m.se) == 26909 and abs(m.cv - 0.52) < 0.01  # Mack (1993), R ChainLadder est.sigma = "Mack"
    se = m.table["se"].drop("total").round().tolist()
    assert se == [0, 206, 623, 747, 1469, 2002, 2209, 5358, 6333, 24566]


def test_chain_ladder_raa_factors(raa):
    cl = sc.chain_ladder(raa)
    assert np.allclose(cl.factors[:3], [2.999, 1.624, 1.271], atol=1e-3)
    assert round(cl.ibnr) == 52135
    assert abs(sc.cdf(raa).iloc[0] - np.prod(cl.factors)) < 1e-9
    assert sc.ldf(raa).index[-1] == "tail"


def test_bf_and_cape_cod(raa):
    cl = sc.chain_ladder(raa)
    b = sc.bf(raa, apriori=cl)
    assert abs(b.ibnr - cl.ibnr) < 1e-6  # BF seeded with CL ultimates returns the CL reserve
    b2 = sc.bf(raa, apriori=10_000)  # a prior below every chain-ladder ultimate lowers the reserve
    assert b2.ibnr < b.ibnr
    b3 = sc.bf(raa, apriori=40_000)
    assert b3.ibnr > b.ibnr
    cc = sc.cape_cod(raa, premium=[40_000] * 10)
    assert 0 < cc.detail["elr"] < 2 and cc.ibnr > 0


def test_bootstrap_raa_distribution(raa):
    b = sc.bootstrap(raa, n=1000, seed=42)
    assert 50_000 < b.ibnr < 57_000 and 15_000 < b.se < 22_000  # England & Verrall ODP on RAA
    assert b.detail["p95"] > b.detail["p50"] > 0 and b.detail["totals"].size == 1000
    b2 = sc.bootstrap(raa, n=1000, seed=42)
    assert b2.ibnr == b.ibnr  # seeded


def test_triangle_from_long_file(claims):
    tri = sc.triangle(claims)
    assert tri.shape == (7, 7) and tri.index.name == "origin"
    assert np.isnan(tri.iloc[-1, 1]) and not np.isnan(tri.iloc[0, 6])  # future cells blank, diagonal filled
    assert sc.is_cumulative(tri) and not sc.is_cumulative(sc.to_incremental(tri))
    assert np.allclose(sc.to_cumulative(sc.to_incremental(tri)).to_numpy(), tri.to_numpy(), equal_nan=True)
    inc = sc.triangle(claims, cumulative=False)
    assert np.allclose(sc.to_cumulative(inc).to_numpy(), tri.to_numpy(), equal_nan=True)


def test_triangle_from_payment_period():
    df = pd.DataFrame({"accident_year": [2020, 2020, 2021, 2021, 2022], "calendar_year": [2020, 2021, 2021, 2022, 2022], "paid": [100, 50, 120, 60, 130]})
    tri = sc.triangle(df, payment="calendar_year")
    assert tri.loc[2020, 1] == 150 and np.isnan(tri.loc[2022, 1])


def test_wiring_like_ide_fixture():
    # apps/web modelRunner.test.ts reserving fixture: 3 origins × ≤3 devs
    df = pd.DataFrame({"origin_year": [2019, 2019, 2019, 2020, 2020, 2021], "dev_period": [0, 1, 2, 0, 1, 0], "paid": [100, 50, 25, 110, 50, 120]})
    tri = sc.triangle(df)
    m = sc.mack(tri)
    assert 0 < m.se < m.ibnr and 0 < m.cv < 1
    r = sc.reserve(df, n_boot=200)
    assert set(r.index) == {"chain-ladder", "mack", "bornhuetter-ferguson", "bootstrap"}


def test_tail_factor():
    f = [1.5, 1.2, 1.1, 1.05, 1.02]
    t = sc.tail(f)
    assert 1.0 < t < 1.1
    assert sc.tail([1.0, 1.0]) == 1.0
