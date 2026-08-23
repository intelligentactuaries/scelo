import numpy as np
import pandas as pd
import pytest

import scelo as sc


def test_table_carries_metadata_through_slicing():
    lt = sc.life_table()
    sub = lt[lt["age"] < 30]
    assert isinstance(sub, sc.Table) and sub.basis == lt.basis and sub.notes == lt.notes
    assert "ILLUSTRATIVE" in repr(lt)
    plain = lt.df
    assert type(plain) is pd.DataFrame


def test_hard_stamp_and_verify():
    t = sc.hard(sc.life_table(), assumptions={"i": 0.04})
    assert sc.verify(t) and t.provenance["assumptions"] == {"i": 0.04} and len(t.provenance["sha256"]) == 64
    t.loc[0, "qx"] = 0.5
    assert not sc.verify(t)


def test_report_and_export(tmp_path):
    md = sc.report(sc.life_table(), "## Note\n\ntext", title="Pack", summary="ok", to=tmp_path / "pack.md")
    assert (tmp_path / "pack.md").exists() and "# Pack" in md and "Audit trail" in md
    sc.report(sc.life_table(), to=tmp_path / "pack.html")
    assert "<table>" in (tmp_path / "pack.html").read_text()
    p = sc.export(sc.life_table(), tmp_path / "lt.csv")
    assert p.exists() and len(sc.load(p)) == 91
    sc.export(sc.life_table(), tmp_path / "lt.md")
    assert "Life table" in (tmp_path / "lt.md").read_text()


def test_audit_trail_records_tools():
    sc.clear_audit()
    sc.life_table()
    sc.describe(pd.DataFrame({"x": [1, 2, 3]}))
    a = sc.audit()
    assert list(a["fn"]) == ["life_table", "describe"] and a["out_shape"].iloc[0] == "91×8"
    sc.enable_audit(False)
    sc.life_table()
    assert len(sc.audit()) == 2
    sc.enable_audit(True)


def test_snapshot_restore(tmp_path, monkeypatch):
    monkeypatch.setenv("SCELO_HOME", str(tmp_path))
    df = sc.sample("claims")
    sc.snapshot(df, "claims0")
    back = sc.restore("claims0")
    assert back.shape == df.shape and "claims0" in sc.snapshots()["name"].tolist()


def test_combine_rules():
    a = pd.DataFrame({"policy_id": ["P1", "P2", "P3"], "premium": [1, 2, 3]})
    b = pd.DataFrame({"Policy_ID": ["P1", "P2", "P2", "P4"], "claims": [0, 1, 2, 3], "premium": [9, 9, 9, 9]})
    s = sc.suggest_combine(a, b).iloc[0]
    assert s["strategy"] == "join-left" and s["key"] == "policy_id"
    j = sc.join(a, b)
    assert len(j) == 3 and j["premium_2"].tolist()[:2] == [9, 9] and j["claims"].tolist()[:2] == [0, 1]  # first right match wins
    ap = sc.append(a, a.assign(premium=[1, 2, 5]))
    assert len(ap) == 4
    c = sc.combine(a, a.assign(premium=[1, 2, 5]))
    assert len(c) == 4
    d = sc.diff(a, a.assign(premium=[1, 2, 5]), key="policy_id")
    assert len(d) == 1 and d["delta"].iloc[0] == -2
    assert sc.tieout(1.0, 1.0 + 1e-9) and not sc.tieout(a, a.assign(premium=[1, 2, 5]))


def test_accessor_and_cli(capsys, tmp_path):
    df = sc.sample("claims")
    assert isinstance(df.sc.profile(), sc.Table)
    assert df.sc.triangle().shape == (7, 7)
    with pytest.raises(AttributeError):
        df.sc.nonexistent()
    from scelo.cli import main

    assert main(["version"]) == 0 and sc.__version__ in capsys.readouterr().out
    p = tmp_path / "c.csv"
    sc.save(df, p)
    assert main(["reserve", str(p)]) == 0 and "mack" in capsys.readouterr().out
    assert main(["clean", str(sc.io._DATA_DIR / "dirty.csv"), "--all", "-o", str(tmp_path / "out.csv")]) == 0
    assert (tmp_path / "out.csv").exists()


def test_workspace_recovers_real_drivers():
    ws = sc.sample("workspace-demo")
    drivers = [c for c in ws.columns if c not in ("annuity_60", "life_exp_60", "survival_to_80")]
    a = sc.active_subspace(ws, "annuity_60", drivers=drivers)
    assert a.attrs["surrogate_r2"] > 0.9 and 2 <= a.attrs["rank"] <= 5
    top = a["name"].iloc[0]
    assert "mortality trend" in top or "cohort effect" in top
    assert a["variance_share"].iloc[0] < 0.15  # decision-relevant is not max-variance
    b = sc.bottleneck(ws[drivers], r=3)
    assert (b.to_numpy() >= 0).all() and b.attrs["causal_alignment"] > 0.3


def test_climate_helpers():
    cl = sc.sample("climate")
    e = sc.ensemble(cl, "t2m")
    assert len(e) == 30 and (e["spread"] >= 0).all()
    rp = sc.return_period(np.random.default_rng(1).gumbel(100, 30, 40))
    assert rp["gumbel"].is_monotonic_increasing and pd.isna(rp["empirical"].iloc[-1])
    tr = sc.parametric_trigger(np.arange(1, 101))
    assert tr["trigger"] == 91 and tr["cap"] == 364
    assert sc.aal([10, 20, 30], years=3) == 20
    idx = pd.date_range("2020-01-01", periods=24, freq="MS")
    an = sc.anomaly(pd.Series(np.tile(np.arange(12), 2), index=idx))
    assert np.allclose(an, 0)


def test_lifelib_helpers_without_lifelib():
    assert len(sc.lifelib_models()) == 16
    assert sc.lifelib_provenance("ifrs17sim", "model").endswith("(legacy)")
    mp = sc.normalise_model_points(sc.sample("lifelib-mp"))
    assert mp.index.name == "policy_id" and set(mp["sex"]) <= {"M", "F"} and len(mp) == 100
    with pytest.raises(ValueError):
        sc.normalise_model_points(pd.DataFrame({"age": [1]}))


def test_experience_and_quick():
    e = sc.experience(pd.DataFrame({"age": np.repeat(np.arange(40, 80), 2), "deaths": np.tile([1, 2], 40), "exposure": 500.0}))
    assert "life_table" in e.attrs and e["age band"].iloc[-1] == "total"
    q = sc.quick(sc.sample("dirty"))
    assert "plan" in q.attrs and len(q.attrs["plan"]) > 5
