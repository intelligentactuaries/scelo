import numpy as np
import pandas as pd

import scelo as sc


def test_parse_number_rules():
    assert sc.parse_number("R 1,234.50") == 1234.5
    assert sc.parse_number("(1,200)") == -1200
    assert sc.parse_number("85%") == 85
    assert sc.parse_number("1 200 ZAR") == 1200
    assert sc.parse_number("$-3") == -3
    assert sc.parse_number("abc") is None and sc.parse_number("-") is None and sc.parse_number("") is None
    assert sc.parse_number("−5") == -5  # unicode minus


def test_parse_date_rules():
    assert sc.parse_date("2024-01-05").date().isoformat() == "2024-01-05"
    assert sc.parse_date("13/02/2024").date().isoformat() == "2024-02-13"  # a > 12 forces day-first
    assert sc.parse_date("02/13/2024").date().isoformat() == "2024-02-13"  # b > 12 forces month-first
    assert sc.parse_date("13/13/2024") is None
    assert sc.parse_date("05/06/2024").date().isoformat() == "2024-05-06"  # ambiguous: month-first by default
    assert sc.parse_date("05/06/2024", day_first=True).date().isoformat() == "2024-06-05"
    assert sc.parse_date("Jan 5, 2024").date().isoformat() == "2024-01-05"
    assert sc.parse_date("5 Jan 24").date().isoformat() == "2024-01-05"
    assert sc.parse_date("31/02/2024") is None and sc.parse_date("2024-13-01") is None and sc.parse_date("1650-01-01") is None
    assert sc.parse_date("2024-01-05 10:30:00").hour == 10
    assert sc.infer_day_first(["13/01/2024", "14/01/2024", "05/06/2024"]) is True
    assert sc.infer_day_first(["01/13/2024", "05/06/2024"]) is False


def test_snake_case():
    assert sc.snake_case("Customer Name") == "customer_name"
    assert sc.snake_case("camelCaseHeader") == "camel_case_header"
    assert sc.snake_case("already_snake") is None
    assert sc.snake_case("  ") is None


def test_suggest_on_dirty_sample(dirty):
    plan = sc.suggest(dirty)
    ops = set(plan["op"])
    for expected in ("fix-encoding", "missing-tokens", "parse-numeric", "parse-dates", "standardise-booleans", "replace-numeric-sentinels",
                     "drop-duplicates", "drop-empty-cols", "drop-constant-cols", "lowercase-categoricals", "rename-snake-case"):
        assert expected in ops, expected
    row = plan.set_index("op")
    assert row.loc["drop-duplicates", "cells"] == 3
    assert "notes" in row.loc["drop-empty-cols", "columns"] and "internal_ref_v2" in row.loc["drop-empty-cols", "columns"]
    assert row.loc["drop-constant-cols", "columns"] == "country"
    assert bool(row.loc["parse-numeric", "safe"]) and not bool(row.loc["drop-duplicates", "safe"])


def test_clean_safe_then_all(dirty):
    c = sc.clean(dirty)
    assert len(c) == 53 and c.shape[1] == 11  # safe ops never drop rows or columns
    assert str(c["premium_zar"].dtype).startswith("float") and str(c["Joined Date"].dtype).startswith("datetime")
    assert str(c["active"].dtype) == "boolean"
    assert (c["age"] < 0).sum() == 0  # -999 sentinels nulled
    c2 = sc.clean(dirty, "all")
    assert len(c2) == 50 and "country" not in c2.columns and "customer_name" in c2.columns
    assert any("clean" in n for n in c2.notes)


def test_individual_ops():
    df = pd.DataFrame({"Name": ["  Ann  ", "Bob  Jr", "N/A", "Ã©lan"], "v": ["1", "2", "x", "4"]})
    assert sc.trim(df)["Name"][0] == "Ann"
    assert sc.collapse_ws(df)["Name"][1] == "Bob Jr"
    assert pd.isna(sc.missing_tokens(df)["Name"][2])
    assert sc.fix_encoding(df)["Name"][3] == "élan"
    assert sc.snake_names(df).columns.tolist() == ["name", "v"]
    num = sc.coerce_numeric(pd.DataFrame({"n": ["1", "2", "6+", "7", "8", "9", "10", "11", "12", "x"]}))  # ≥ 80 % numeric: a number column with residue
    assert num["n"].tolist()[:5] == [1, 2, 6, 7, 8] and np.isnan(num["n"].tolist()[9])
    untouched = sc.coerce_numeric(pd.DataFrame({"n": ["1", "2", "6+", "7", "8", "x"]}))  # 67 % numeric: still a string column
    assert untouched["n"].tolist() == ["1", "2", "6+", "7", "8", "x"]


def test_impute_rules_and_indicator():
    df = pd.DataFrame({"x": [1.0, 2.0, 3.0, 4.0, None, 100.0], "cat": ["a", "a", "a", "b", None, "a"], "id": [1, 2, 3, 4, 5, None]})
    out = sc.impute(df, ["x", "cat"])
    assert out["x"][4] == 3.0 and out["cat"][4] == "a"  # median of [1, 2, 3, 4, 100]
    assert out["was_missing_x"].sum() == 1 and list(out.columns).index("was_missing_x") == 1
    dates = pd.DataFrame({"d": pd.to_datetime(["2024-01-01", None, "2024-01-03", "2024-01-04", "2024-01-05"])})
    assert sc.impute(dates)["d"].isna().sum() == 1  # dates are never filled in auto mode


def test_cap_outliers_and_sentinels():
    df = pd.DataFrame({"x": [1, 2, 3, 4, 5, 6, 7, 8, 9, 100], "year": [2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027, 2028, 9999]})
    c = sc.cap_outliers(df)
    assert c["x"].max() < 100 and c["year"].max() == 9999  # year columns are never winsorised
    ages = list(range(25, 65))
    s = pd.DataFrame({"age": ages + [-999, -999, -999]})
    assert sc.sentinels(s)["age"].isna().sum() == 3
    two = pd.DataFrame({"age": ages + [-999, -999]})
    assert sc.sentinels(two)["age"].isna().sum() == 0  # fewer than 3 occurrences: not a sentinel
    heavy = pd.DataFrame({"age": [30, 31, 32, 33, 34, -999, -999, -999, 35, 36]})
    assert sc.sentinels(heavy)["age"].isna().sum() == 0  # 30 % sentinels pull the fences: the IDE leaves them too


def test_clean_is_idempotent_on_clean_data(claims):
    once = sc.clean(claims, "all")
    twice = sc.clean(once, "all")
    assert twice.shape == once.shape and "Nothing to clean." in twice.notes


def test_vectorised_parsers_match_scalar_rules():
    from scelo.clean import date_shaped_vec, parse_date_vec, parse_number_vec, _is_date_shaped

    bag = ["R 1,234.50", "(1,200)", "85%", "1 200 ZAR", "$-3", "abc", "−5", "1_000", "", "-", "+", "1e3", "nan", "inf", "0x1f", " 42 ", "3.5%",
           "(abc)", "USD 12", "12 usd", "£1,000.00", "1.2.3", ".5", "5.", "+7"]
    vec = parse_number_vec(pd.Series(bag)).tolist()
    for raw, v in zip(bag, vec):
        ref = sc.parse_number(raw)
        assert (ref is None and np.isnan(v)) or (ref is not None and abs(ref - v) < 1e-12), raw
    dates = ["2024-01-05", "13/02/2024", "02/13/2024", "13/13/2024", "05/06/2024", "Jan 5, 2024", "5 Jan 24", "31/02/2024", "2024-13-01", "1650-01-01",
             "2024-01-05 10:30:00", "2024/03/04", "2024-1-5", "07.08.21", "x", "2024-01-05T10:30:00Z", "2024-01-05T10:30:00+02:00", "5 Sept 2024",
             "not a date at all really", None, "2024-02-29", "2023-02-29", "2024-01-05T25:00:00"]
    s = pd.Series(dates, dtype=object)
    vd = parse_date_vec(s).tolist()
    for raw, v in zip(dates, vd):
        ref = sc.parse_date(raw)
        assert (ref is None and pd.isna(v)) or (ref is not None and pd.Timestamp(ref) == v), raw
    shaped = date_shaped_vec(s).tolist()
    for raw, v in zip(dates, shaped):
        assert v == (_is_date_shaped(raw) if isinstance(raw, str) else False), raw
    for df_first in (True, False):
        assert parse_date_vec(pd.Series(["05/06/2024"]), df_first).iloc[0] == pd.Timestamp(sc.parse_date("05/06/2024", df_first))


def test_clean_matches_the_cross_language_golden():
    """The same numbers the R package is tested against (tests/testthat/fixtures/py_golden.json)."""
    import json
    from pathlib import Path

    path = Path(__file__).resolve().parents[2] / "scelo-r" / "tests" / "testthat" / "fixtures" / "py_golden.json"
    if not path.exists():
        pytest.skip("R golden fixture not checked out")
    g = json.loads(path.read_text())
    c = sc.clean(sc.sample("dirty"))
    assert list(c.shape) == g["clean_dirty_safe"]["shape"]
    assert abs(float(c["premium_zar"].sum()) - g["clean_dirty_safe"]["premium_sum"]) < 1e-6
    assert int(c["age"].isna().sum()) == g["clean_dirty_safe"]["age_null"]
    assert int(c["active"].sum()) == g["clean_dirty_safe"]["active_true"]
    assert int(c["Joined Date"].notna().sum()) == g["clean_dirty_safe"]["dates_parsed"]
    c2 = sc.clean(sc.sample("dirty"), "all")
    assert list(c2.shape) == g["clean_dirty_all"]["shape"] and list(map(str, c2.columns)) == g["clean_dirty_all"]["columns"]
    plan = sc.suggest(sc.sample("dirty"))
    gold = g["suggest_dirty"]
    cols = gold["columns"]
    rows = [dict(zip(cols, r)) for r in gold["data"]]
    assert list(plan["op"]) == [r["op"] for r in rows]
    assert list(plan["cells"]) == [r["cells"] for r in rows]
    assert list(plan["columns"]) == [r["columns"] for r in rows]


def test_parse_numbers_keeps_typed_cells_on_mixed_columns():
    df = pd.DataFrame({"x": pd.Series([1.5, "R 2,000", 3, "(50)", "n/a"], dtype=object)})
    out = sc.parse_numbers(df, ["x"])
    assert out["x"].tolist()[:4] == [1.5, 2000.0, 3.0, -50.0] and np.isnan(out["x"].iloc[4])
