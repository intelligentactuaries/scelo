"""``df.sc``: the pandas accessor, for people who chain.

    df.sc.profile()         df.sc.clean("all")       df.sc.triangle().sc.mack()

Every Scelo function that takes a frame first is available as a method;
the frame is passed as the first argument.
"""

from __future__ import annotations

from typing import Any

import pandas as pd

import importlib

_clean = importlib.import_module("scelo.clean")
_combine = importlib.import_module("scelo.combine")
_fairness = importlib.import_module("scelo.fairness")
_life = importlib.import_module("scelo.life")
_pricing = importlib.import_module("scelo.pricing")
_profile = importlib.import_module("scelo.profile")
_reserving = importlib.import_module("scelo.reserving")
_workspace = importlib.import_module("scelo.workspace")
_hard = importlib.import_module("scelo.hard").hard

_METHODS = {
    "profile": _profile.profile, "describe": _profile.describe, "types": _profile.types, "missing": _profile.missing, "tab": _profile.tab,
    "corr": _profile.corr, "outliers": _profile.outliers, "inliers": _profile.inliers,
    "suggest": _clean.suggest, "clean": _clean.clean, "dedupe": _clean.dedupe, "snake_names": _clean.snake_names, "impute": _clean.impute,
    "cap_outliers": _clean.cap_outliers, "parse_dates": _clean.parse_dates, "parse_numbers": _clean.parse_numbers,
    "triangle": _reserving.triangle, "chain_ladder": _reserving.chain_ladder, "mack": _reserving.mack, "bf": _reserving.bf,
    "bootstrap": _reserving.bootstrap, "reserve": _reserving.reserve, "ldf": _reserving.ldf, "cdf": _reserving.cdf, "ata": _reserving.ata,
    "life_table": lambda df, **kw: _life.life_table(None, df, **kw), "commutation": lambda df, **kw: _life.commutation(None, df, **kw),
    "factors": lambda df, **kw: _life.factors(None, df, **kw), "ae": _life.ae, "model_points": _life.model_points, "graduate": _life.graduate,
    "lee_carter": _life.lee_carter, "kaplan_meier": _life.kaplan_meier, "basicterm": _life.basicterm,
    "glm": _pricing.glm, "freq_sev": _pricing.freq_sev, "loss_ratio": _pricing.loss_ratio,
    "fairness": _fairness.fairness, "fairness_audit": _fairness.fairness_audit,
    "join": _combine.join, "append": _combine.append, "combine": _combine.combine, "diff": _combine.diff,
    "bottleneck": _workspace.bottleneck, "active_subspace": _workspace.active_subspace,
    "hard": _hard,
}


@pd.api.extensions.register_dataframe_accessor("sc")
class SceloAccessor:
    """``df.sc.<function>(...)`` for every frame-first Scelo function."""

    def __init__(self, obj: pd.DataFrame) -> None:
        self._obj = obj

    def __getattr__(self, name: str) -> Any:
        fn = _METHODS.get(name)
        if fn is None:
            raise AttributeError(f"df.sc has no method {name!r}; available: {', '.join(sorted(_METHODS))}")
        return lambda *a, **kw: fn(self._obj, *a, **kw)

    def __dir__(self):  # pragma: no cover
        return sorted(_METHODS)
