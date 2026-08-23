"""lifelib: run the pinned lifelib models Scelo IDE ships, from Python.

Scelo's life family is rooted in lifelib (lifelib 0.14.0 / modelx 0.32.0,
the pair the IDE bundles and verifies). ``lifelib_models()`` lists the
libraries and their status; ``lifelib_run("basiclife", "BasicTerm_ME",
model_points)`` copies the library into ``$SCELO_LIFELIB_HOME`` (or
~/.cache/scelo/lifelib) the first time, reads the model with modelx, sets
the model-point table and returns the cash flows. Install with
``pip install scelo[life]``; without lifelib the functions explain how.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd

from ._audit import tool
from ._table import Table

__all__ = ["LIFELIB_VERSION", "MODELX_VERSION", "lifelib_models", "lifelib_run", "lifelib_home", "lifelib_provenance", "normalise_model_points"]

LIFELIB_VERSION = "0.14.0"
MODELX_VERSION = "0.32.0"

_LIBRARIES = [
    ("basiclife", "active", "BasicTerm_M, BasicTerm_ME, BasicTerm_S, BasicTerm_SE, BasicTerm_SC, BasicTermASL_ME", "Monthly / seriatim term-life projections on a model-point table."),
    ("savings", "active", "CashValue_ME, CashValue_ME_EX1, CashValue_ME_EX2, CashValue_ME_EX4, CashValue_SE", "Account-value roll-forward with crediting, COI, surrender charges."),
    ("annuallife", "active", "TradLife_A, TradLife_A_EX1, TradLife_A_mx30", "Per-policy annual traditional-life projection; EX1 adds Solvency II life SCR."),
    ("uslib", "draft", "term_life, whole_life, universal_life, … variable_annuity", "Twelve U.S. individual life & annuity reference models (draft in 0.14.0)."),
    ("ifrs17a", "active", "ifrs17 (package), template.py", "IFRS 17 measurement engine driven from nominal cash flows and yield curves."),
    ("smithwilson", "active", "model", "EIOPA Smith-Wilson risk-free curve extrapolation."),
    ("cluster", "active", "cluster_model_points.ipynb, BasicTerm_ME_for_Cluster", "k-means model-point compression preserving liability sensitivity."),
    ("economic", "active", "BasicHullWhite", "Hull-White short-rate Monte Carlo."),
    ("economic_curves", "active", "smith_wilson, NelsonSiegelSvensson, bisection_alpha, stationary_bootstrap", "Curve algorithms as standalone scripts."),
    ("appliedlife", "active", "IntegratedLife", "Multi-product projection model with a run-and-report harness."),
    ("assets", "active", "BasicBonds", "Bond-portfolio cash flows and valuation."),
    ("ifrs17sim", "legacy", "OuterProj, InnerProj", "CSM roll-forward on simplelife (deprecated 0.12.0; successor ifrs17a)."),
    ("solvency2", "legacy", "SCR_life", "Standard-formula life SCR on simplelife (deprecated 0.13.0; successor annuallife)."),
    ("nestedlife", "legacy", "OuterProj, InnerProj", "Nested projection on simplelife (deprecated 0.12.0)."),
    ("simplelife", "legacy", "Projection", "The original annual projection (deprecated 0.12.0; successor annuallife)."),
    ("fastlife", "legacy", "Projection", "Vectorised simplelife (deprecated 0.12.0)."),
]

_MP_ALIASES = {
    "policy_id": ["policy_id", "policyid", "policy", "id", "model_point_id", "mp_id", "point_id"],
    "age_at_entry": ["age_at_entry", "ageatentry", "issue_age", "issueage", "age"],
    "sex": ["sex", "gender"],
    "sum_assured": ["sum_assured", "sumassured", "sa", "face_amount", "face", "benefit", "sum_insured"],
    "policy_term": ["policy_term", "policyterm", "term", "term_years", "policy_term_years"],
    "duration_mth": ["duration_mth", "durationmth", "duration_months", "duration", "dur_mth", "elapsed_mth"],
    "premium_pp": ["premium_pp", "premiumpp", "premium", "monthly_premium", "prem", "annual_premium", "premium_pp_pa"],
    "policy_count": ["policy_count", "policycount", "count", "lives", "weight"],
    "account_value": ["account_value", "av", "av_pp_init", "acct_value", "fund_value"],
    "product": ["product", "product_type", "plan"],
}


def lifelib_models() -> pd.DataFrame:
    """The lifelib libraries Scelo targets, with status (active / legacy / draft) and headline models."""
    return pd.DataFrame(_LIBRARIES, columns=["library", "status", "models", "note"])


def lifelib_provenance(library: str, model: str) -> str:
    """"lifelib 0.14.0 · basiclife / BasicTerm_ME", the string the IDE prints on its result cards."""
    status = next((s for lib, s, *_ in _LIBRARIES if lib == library), None)
    return f"lifelib {LIFELIB_VERSION} · {library} / {model}" + (" (legacy)" if status == "legacy" else "")


def lifelib_home() -> Path:
    """Where lifelib libraries are copied: $SCELO_LIFELIB_HOME (the IDE sets it), else ~/.cache/scelo/lifelib."""
    base = os.environ.get("SCELO_LIFELIB_HOME")
    if not base:
        base = os.path.join(os.environ.get("LOCALAPPDATA", "") if sys.platform == "win32" else os.path.expanduser("~/.cache"), "scelo", "lifelib")
    return Path(base) / LIFELIB_VERSION


def normalise_model_points(df: pd.DataFrame) -> pd.DataFrame:
    """Map a policy file onto lifelib's model-point columns (policy_id index, age_at_entry, sex, sum_assured, policy_term, duration_mth, premium_pp, policy_count).

    Sex becomes M / F; duration defaults to 0 and policy_count to 1; rows
    missing age / sum assured / term are dropped.
    """
    lower = {str(c).lower(): c for c in df.columns}
    out = pd.DataFrame(index=df.index)
    for key, aliases in _MP_ALIASES.items():
        src = next((lower[a] for a in aliases if a in lower), None)
        if src is not None:
            out[key] = df[src]
    if "policy_id" not in out:
        out["policy_id"] = [f"MP{i + 1:05d}" for i in range(len(out))]
    for c in ("age_at_entry", "sum_assured", "policy_term", "duration_mth", "premium_pp", "policy_count", "account_value"):
        if c in out:
            out[c] = pd.to_numeric(out[c], errors="coerce")
    out["sex"] = out["sex"].map(lambda v: "F" if str(v).strip().lower() in ("f", "female", "w", "woman", "2") else "M") if "sex" in out else "M"
    out["duration_mth"] = out["duration_mth"].fillna(0).astype(int) if "duration_mth" in out else 0
    out["policy_count"] = out["policy_count"].fillna(1) if "policy_count" in out else 1
    need = [c for c in ("age_at_entry", "sum_assured", "policy_term") if c in out]
    if len(need) < 3:
        raise ValueError("a model-point file needs age_at_entry, sum_assured and policy_term columns")
    out = out.dropna(subset=need)
    out = out[(out["age_at_entry"] > 0) & (out["sum_assured"] > 0) & (out["policy_term"] > 0)]
    out["age_at_entry"] = out["age_at_entry"].astype(int)
    out["policy_term"] = out["policy_term"].astype(int)
    ids = out["policy_id"].astype(str)
    if ids.duplicated().any():
        ids = ids + ids.groupby(ids).cumcount().map(lambda k: f"#{k}" if k else "")
    out["policy_id"] = ids
    return out.set_index("policy_id")


def _require_lifelib():
    try:
        import lifelib  # type: ignore
        import modelx as mx  # type: ignore
    except ImportError:
        raise ImportError("lifelib / modelx are not installed: pip install scelo[life] (pins lifelib==0.14.0, modelx==0.32.0)") from None
    if getattr(lifelib, "__version__", "?") != LIFELIB_VERSION:
        import warnings
        warnings.warn(f"lifelib {getattr(lifelib, '__version__', '?')} installed, Scelo targets {LIFELIB_VERSION}")
    return lifelib, mx


def _library_dir(lifelib: Any, library: str) -> Path:
    home = lifelib_home()
    dest = home / library
    if dest.exists():
        return dest
    home.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=f"{library}-", dir=str(home)))
    target = tmp / library
    lifelib.create(library, str(target))
    os.replace(target, dest)
    try:
        tmp.rmdir()
    except OSError:
        pass
    return dest


@tool
def lifelib_run(library: str = "basiclife", model: str = "BasicTerm_ME", model_points: Optional[pd.DataFrame] = None, *, space: str = "Projection",
                premium_from_file: bool = True) -> Table:
    """Run a lifelib model on a model-point file: the aggregate cash flows (``result_cf``) with the per-policy PVs in ``attrs["pv"]``.

    Works for the model-point-driven models (basiclife BasicTerm_*, savings
    CashValue_*). For other libraries it reads the model and returns whatever
    ``space.result_cf()`` / ``result_pv()`` give, or raises with a pointer
    to the model's own API.
    """
    lifelib, mx = _require_lifelib()
    lib_dir = _library_dir(lifelib, library)
    for existing in list(mx.get_models().values()):  # re-reading a model renames the old one with a warning; close it instead
        if existing.name == model:
            existing.close()
    m = mx.read_model(str(lib_dir / model))
    P = getattr(m, space)
    meta: Dict[str, Any] = {"library": library, "model": model, "lifelib": lifelib.__version__, "modelx": mx.__version__}
    if model_points is not None:
        mp = normalise_model_points(model_points)
        cols = [c for c in ("age_at_entry", "sex", "policy_term", "policy_count", "sum_assured", "duration_mth") if c in mp.columns]
        table = mp[cols].copy()
        if "premium_pp" in mp.columns and premium_from_file:
            table["premium_pp"] = mp["premium_pp"].fillna(0.0).astype(float)
            P.model_point_table = table
            if hasattr(P, "premium_pp"):
                P.premium_pp.formula = "def premium_pp():\n    return model_point()['premium_pp']"
            meta["premium_source"] = "model-point file"
        else:
            P.model_point_table = table
            meta["premium_source"] = "lifelib premium table"
        meta["model_points"] = int(len(table))
    try:
        pv = P.result_pv()
        cf = P.result_cf()
    except AttributeError:
        raise RuntimeError(f"{library}/{model} space {space} has no result_cf()/result_pv(): drive it through modelx directly (m = mx.read_model(...))") from None
    cf = pd.DataFrame(cf)
    cf.index.name = "t"
    t = Table(cf.reset_index(), title=f"{library} / {model} · {meta.get('model_points', '?')} model points", basis=lifelib_provenance(library, model), stage="hard", notes=[
        f"lifelib {meta['lifelib']} · modelx {meta['modelx']} · premiums from {meta.get('premium_source', 'model')}.",
        next((f"PV net cash flow {float(pd.DataFrame(pv)[c].sum()):,.0f} (premiums {float(pd.DataFrame(pv)[p].sum()):,.0f}, claims {float(pd.DataFrame(pv)[k].sum()):,.0f})."
              for c, p, k in (("PV Net Cashflow", "PV Premiums", "PV Claims"), ("Net Cashflow", "Premiums", "Claims")) if c in pd.DataFrame(pv).columns),
             "See attrs['pv'] for the per-policy present values."),
    ])
    t.attrs.update(pv=pd.DataFrame(pv), meta=meta, library_dir=str(lib_dir / model))
    return t  # the live modelx model is not attached (pandas deep-copies attrs); re-open it with mx.read_model(attrs["library_dir"])
