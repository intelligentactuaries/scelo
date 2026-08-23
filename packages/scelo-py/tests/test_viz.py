import numpy as np
import pandas as pd
import pytest

import scelo as sc

matplotlib = pytest.importorskip("matplotlib")
matplotlib.use("Agg")


@pytest.fixture(scope="module")
def mp():
    return sc.sample("lifelib-mp")


def test_palette_is_the_validated_set():
    p = sc.palette()
    assert p["series"][:3] == ["#1F8F5C", "#345DCB", "#C4631F"] and len(p["sequential"]) == 5
    assert p["surface"] == "#FFFFFF"


def test_every_plot_returns_a_figure(mp, tmp_path):
    claims = sc.sample("claims").assign(settled=lambda d: (d.settled == "yes").astype(int))
    figs = {
        "bars": sc.plot_bars(sc.tab(claims, "line")["count"], title="Policies by line"),
        "bars_v": sc.plot_bars(sc.tab(claims, "line")["count"], horizontal=False, highlight=["motor"]),
        "rates": sc.plot_rates(claims, "line", "settled", title="Settlement rate"),
        "relativities": sc.plot_relativities(sc.glm(claims.assign(n=(claims.paid > 20000).astype(int)), "n ~ C(line) + C(sex) + age", "poisson", engine="numpy")),
        "projection": sc.plot_projection(sc.basicterm(mp)),
        "scr": sc.plot_scr(sc.scr_life(mp)),
        "csm": sc.plot_csm(sc.csm(mp, sc.BasicTermAssumptions(premium_mult=3.0), ra=0.05)),
        "lines": sc.plot_lines(sc.discount_curve(0.04, max_tenor=20), "tenor", ["discount factor", "1y forward"]),
        "triangle": sc.plot_triangle(sc.triangle(sc.sample("claims"))),
        "table": sc.plot_table(sc.life_table().head(5)),
    }
    for name, fig in figs.items():
        assert fig.axes, name
        p = sc.save_figure(fig, tmp_path / f"{name}.png")
        assert (tmp_path / f"{name}.png").stat().st_size > 1000, name
    with pytest.raises(ValueError):
        sc.plot_lines(pd.DataFrame({"x": [1, 2], **{f"y{i}": [1, 2] for i in range(6)}}), "x", [f"y{i}" for i in range(6)])


def test_relativities_names_the_base_level():
    claims = sc.sample("claims").assign(n=lambda d: (d.paid > 20000).astype(int))
    m = sc.glm(claims, "n ~ C(line)", "poisson", engine="numpy", base="first")
    assert m.base_levels == {"line": "engineering"}
    rel = m.relativities()
    assert rel["level"].iloc[0] == "engineering (base)"
