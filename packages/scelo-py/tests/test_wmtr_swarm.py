import json
import os
from pathlib import Path

import numpy as np
import pytest

import scelo as sc

FIXTURE = json.loads((Path(__file__).parent / "wmtr_fixture.json").read_text())


def _params(cfg):
    cfg = dict(cfg)
    th = cfg.pop("thresholds")
    return sc.WmtrParams(**{**cfg, "collapse": th["collapse"], "recovery": th["recovery"], "growth": th["growth"], "stability": th["stability"]})


def test_mulberry32_bit_exact():
    r = sc.mulberry32(42)
    assert [r() for _ in range(8)] == FIXTURE["rng42"]


@pytest.mark.parametrize("case", ["default", "severe", "mild_long", "rural", "pension"])
def test_engine_matches_typescript(case):
    fx = FIXTURE[case]
    res = sc.run_wmtr(_params(fx["config"]))
    for col, key in [("mean_W", "meanW"), ("p10_W", "p10W"), ("p90_W", "p90W"), ("survival", "meanSurv"), ("mean_M", "meanM"), ("mean_T", "meanT"), ("mean_R", "meanR")]:
        assert np.max(np.abs(res.table[col].to_numpy() - np.array(fx[key]))) < 1e-9, col
    assert res.outcome_fractions == fx["outcomeFractions"] and res.dominant == fx["dominant"]
    for k in "MTR":
        assert abs(res.drivers[k] - fx["drivers"][k]) < 1e-9


def test_derive_config_matches_ide():
    p = sc.derive_config("rural village facing a severe drought")
    assert p.shock == "severe" and p.alphaM == 0.3 and p.seed == FIXTURE["rural"]["config"]["seed"]
    p2 = sc.derive_config("pension scheme with a weakening sponsor covenant, long-term")
    assert p2.alphaR == 0.4 and p2.horizon == 60 and p2.seed == FIXTURE["pension"]["config"]["seed"]
    # word-bounded cues: "software"/"warranty"/"award"/"forward" must not read as "war"
    assert sc.derive_config("software warranty award forward normalising").shock == "moderate"
    assert sc.derive_config("motor_reserving_triangle_2024").alphaM == 0.55


def test_driver_identity_and_classification():
    res = sc.wmtr(shock="moderate", nPaths=50, seed=3)
    d = res.drivers
    assert abs(d["M"] + d["T"] + d["R"] - d["net"]) < 1e-12
    for pth in res.paths:
        w0 = pth["w"][0]
        wT = pth["w"][-1]
        o = pth["outcome"]
        if o == "grew":
            assert wT > w0 * 1.2
        if o == "declined":
            assert wT < w0 * 0.9
    assert sc.classify([1, 1, 0.1, 0.1, 0.1, 0.1, 0.1, 1.5], 1.0) == "collapsed"
    assert sc.classify([1, 1.3], 1.0) == "grew" and sc.classify([1, 0.95], 1.0) == "stabilized" and sc.classify([1, 0.8], 1.0) == "declined"


def test_wmtr_from_row_and_intervention():
    res = sc.wmtr(sc.sample("wmtr-scenarios"), nPaths=10)
    assert res.params.shock == "severe" and res.params.alphaR == 0.4
    p = sc.apply_intervention(res.params, "shock", "decrease")
    assert p.shock == "moderate"
    p2 = sc.apply_intervention(res.params, "pFamily", "increase", "large")
    assert abs(p2.pFamily - min(1, res.params.pFamily + 0.2)) < 1e-12
    s = sc.sensitivity(shock="moderate", nPaths=20, seed=1)
    assert list(s["shock"]) == ["mild", "moderate", "severe"]


def _swarm_up():
    try:
        return sc.swarm_status()["ok"]
    except sc.SwarmError:
        return False


@pytest.mark.skipif(not _swarm_up(), reason="swarm not running on 127.0.0.1:3010")
def test_swarm_wmtr_matches_local_engine():
    remote = sc.swarm_wmtr("rural village facing a severe drought")
    local = sc.run_wmtr(_params(remote["config"]))
    assert np.max(np.abs(local.table["mean_W"].to_numpy() - np.array(remote["result"]["meanW"]))) < 1e-9
    assert local.outcome_fractions == remote["result"]["outcomeFractions"]


def test_swarm_error_when_unreachable(monkeypatch):
    sc.connect("http://127.0.0.1:1")
    try:
        with pytest.raises(sc.SwarmError):
            sc.swarm_status()
    finally:
        sc.connect(None)
