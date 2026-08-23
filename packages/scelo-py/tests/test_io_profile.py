import math

import numpy as np
import pandas as pd
import pytest

import scelo as sc


def test_coerce_cell_rules():
    assert sc.coerce_cell(" 42 ") == 42
    assert sc.coerce_cell("007") == "007"          # id-like: leading zero stays a string
    assert sc.coerce_cell("NA") is None and sc.coerce_cell("-") is None and sc.coerce_cell("") is None
    assert sc.coerce_cell("1e3") == 1000.0
    assert sc.coerce_cell("0x1f") == "0x1f" and sc.coerce_cell("Infinity") == "Infinity"
    assert sc.coerce_cell("9007199254740993") == "9007199254740993"  # > 2^53 stays a string
    assert sc.coerce_cell("TBD") == "TBD"          # the long tail belongs to the cleaning layer


def test_samples_load_with_expected_shapes():
    shapes = {"claims": (79, 10), "climate": (30, 7), "dirty": (53, 11), "wmtr-scenarios": (12, 11), "lifelib-mp": (100, 7), "workspace-demo": (2000, 17)}
    for k, shape in shapes.items():
        df = sc.sample(k)
        assert df.shape == shape, k
    assert set(sc.samples()["key"]) == set(shapes)


def test_sniff_and_load(tmp_path):
    p = tmp_path / "x.txt"
    p.write_text("a;b;c\n1;2;3\n4;5;6\n")
    assert sc.sniff(p) == ";"
    df = sc.load(p)
    assert list(df.columns) == ["a", "b", "c"] and df["a"].tolist() == [1, 4]
    (tmp_path / "bin.txt").write_bytes(b"\x00\x01\x02" * 100)
    assert sc.sniff(tmp_path / "bin.txt") is None


def test_reservoir_keeps_order_and_stamps():
    df = pd.DataFrame({"x": range(1000)})
    s = sc.reservoir(df, 100, seed=1)
    assert len(s) == 100 and s["x"].is_monotonic_increasing and s.attrs["source_total_rows"] == 1000


def test_describe_golden_values():
    # hand-computed in apps/web modelRunner.test.ts: x = [1,2,3,4]
    d = sc.describe(pd.DataFrame({"x": [1, 2, 3, 4]}))
    r = d.iloc[0]
    assert r["median"] == 2.5 and r["q1"] == 1.75 and r["q3"] == 3.25 and r["mean"] == 2.5
    assert math.isclose(r["sd"], math.sqrt(5 / 3)) and math.isclose(r["se"], math.sqrt(5 / 3) / 2) and math.isclose(r["cv"], math.sqrt(5 / 3) / 2.5)
    assert r["skewness"] == 0


def test_describe_ranks_by_cv_and_missing():
    df = pd.DataFrame({"big": [1000, 1100, 1050, 1000], "ratio": [0.5, 2.0, 0.1, 1.0], "const": [3, 3, 3, None]})
    d = sc.describe(df)
    assert d["column"].iloc[0] == "ratio"
    assert d.set_index("column").loc["const", "missing"] == 1
    assert pd.isna(d.set_index("column").loc["const", "cv"]) is False or d.set_index("column").loc["const", "sd"] == 0


def test_jarque_bera_normal_vs_spike():
    rng = np.random.default_rng(0)
    normal = rng.normal(size=5000)
    assert sc.jarque_bera(normal)[1] > 0.05
    spike = np.concatenate([np.zeros(100), [50.0] * 3])
    assert sc.jarque_bera(spike)[1] < 0.001 and sc.skew(spike) > 1


def test_profile_types_and_fences(dirty):
    p = sc.profile(dirty).set_index("column")
    assert p.loc["age", "type"] == "number"
    assert p.loc["Region", "type"] == "string"
    assert p.loc["premium_zar", "type"] == "string"  # money strings are not numbers yet
    b = sc.box([1, 2, 3, 4, 100])
    assert b["q1"] == 2 and b["q3"] == 4 and b["hi_fence"] == 7 and list(b["outliers"]) == [100]
    assert sc.box([5, 5, 5, 5, 9])["outliers"].size == 0  # IQR = 0: no outlier classification


def test_column_type_date_probe():
    s = pd.Series([f"2024-01-{d:02d}" for d in range(1, 13)], dtype=object)
    assert sc.column_type(s) == "date"
    assert sc.column_type(pd.Series(["01/02/2024"] * 12, dtype=object)) == "string"  # ambiguous forms are not silently dated
    assert sc.column_type(pd.Series(["2024-01-01"] * 5, dtype=object)) == "string"  # fewer than 8 probes


def test_tab_corr_outliers(claims):
    t = sc.tab(claims, "line")
    assert abs(t["pct"].sum() - 100) < 1e-9
    assert sc.tab(claims, "line", "sex").loc["All", "All"] == 79
    assert sc.corr(claims).shape[0] >= 3
    assert len(sc.outliers(claims, "paid")) + len(sc.inliers(claims, "paid")) == len(claims)
