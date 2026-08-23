"""Climate: reanalysis ensembles, return periods, parametric triggers.

The IDE's climate family works on multi-reanalysis daily series (ERA5 /
MERRA-2 / JRA-3Q, the bundled ``climate`` sample) and on loss files. These
are the deterministic pieces: ensemble agreement, empirical and fitted
return periods, a parametric trigger at a loss quantile, and the AAL of an
event set.
"""

from __future__ import annotations

import math
import re
from typing import Any, Dict, List, Optional, Sequence

import numpy as np
import pandas as pd

from ._alias import infer, numeric_columns
from ._audit import tool
from ._table import Table

__all__ = ["ensemble", "return_period", "parametric_trigger", "aal", "anomaly"]

_REANALYSIS_RE = re.compile(r"(era5|merra[-_]?2|jra[-_]?3?q?|ncep|cfsr|nora)", re.I)


@tool
def ensemble(df: pd.DataFrame, variable: Optional[str] = None, members: Optional[Sequence[str]] = None, *, date: Optional[str] = None) -> Table:
    """Per-date ensemble mean, spread (sd) and range across reanalysis members (columns matched by ``variable`` prefix or given)."""
    d = infer(df, "date", date, required=False)
    if members is None:
        cands = [c for c in numeric_columns(df) if _REANALYSIS_RE.search(str(c))]
        if variable:
            cands = [c for c in cands if str(c).lower().startswith(variable.lower())]
        if not cands:
            raise KeyError("no reanalysis member columns found (era5 / merra2 / jra3q …); pass members=[…]")
        members = cands
    M = df[list(members)].apply(pd.to_numeric, errors="coerce")
    out = pd.DataFrame({"mean": M.mean(axis=1), "spread": M.std(axis=1, ddof=1), "min": M.min(axis=1), "max": M.max(axis=1)})
    if d:
        out.insert(0, d, df[d])
    agree = float((M.std(axis=1, ddof=1) / M.mean(axis=1).abs().replace(0, np.nan)).median())
    return Table(out, title=f"Ensemble · {len(members)} members", basis=", ".join(map(str, members)), stage="hard", notes=[
        f"Median member CV {agree:.3f}: the reanalyses {'agree closely' if agree < 0.05 else 'disagree materially' if agree > 0.2 else 'broadly agree'} on this variable.",
    ])


@tool
def return_period(losses: Sequence[float], years: Optional[float] = None, periods: Sequence[float] = (2, 5, 10, 25, 50, 100, 200, 250, 500)) -> Table:
    """Return-period losses from annual maxima or an event set: empirical (Weibull plotting position) and Gumbel-fitted.

    ``losses`` = one value per year (annual maxima / annual totals), or an
    event set with ``years`` = the length of record (events / year ratio).
    """
    x = np.sort(np.asarray(pd.Series(losses, dtype=float).dropna()))[::-1]
    n = x.size
    T = float(years) if years else float(n)
    rank = np.arange(1, n + 1)
    rp_emp = (T + 1) / rank
    # Gumbel by moments
    m, s = x.mean(), x.std(ddof=1)
    beta = s * math.sqrt(6) / math.pi
    mu = m - 0.5772156649 * beta
    rows = []
    for p in periods:
        emp = float(np.interp(math.log(p), np.log(rp_emp[::-1]), x[::-1])) if p <= rp_emp.max() else np.nan
        gum = mu - beta * math.log(-math.log(1 - 1 / p)) if years is None else np.nan
        rows.append({"return_period": p, "empirical": emp, "gumbel": gum})
    out = pd.DataFrame(rows)
    return Table(out, title="Return periods", basis=f"{n} values over {T:g} years", stage="hard", notes=[
        "Empirical: Weibull plotting position (T+1)/rank with log-linear interpolation, blank beyond the record; Gumbel: method-of-moments fit to annual maxima (only when losses are one-per-year).",
    ])


def parametric_trigger(losses: Sequence[float], p: float = 0.9, cap_multiple: float = 4.0) -> Dict[str, float]:
    """The IDE's parametric design: trigger at the p-quantile of the loss column, payout cap = cap_multiple × trigger."""
    x = np.sort(np.asarray(pd.Series(losses, dtype=float).dropna()))
    if x.size == 0:
        raise ValueError("no losses")
    trig = float(x[min(int(math.floor(p * x.size)), x.size - 1)])
    return {"trigger": trig, "cap": cap_multiple * trig, "attachment_probability": float((x >= trig).mean())}


def aal(event_losses: Sequence[float], frequencies: Optional[Sequence[float]] = None, years: Optional[float] = None) -> float:
    """Average annual loss: Σ f_e × L_e for an event set with annual frequencies, or Σ L / years for a history."""
    L = np.asarray(pd.Series(event_losses, dtype=float).dropna())
    if frequencies is not None:
        return float(np.sum(np.asarray(frequencies, dtype=float) * L))
    if years is None:
        raise ValueError("give frequencies per event or the number of years of record")
    return float(L.sum() / years)


def anomaly(series: pd.Series, baseline: Optional[pd.Series] = None, by: str = "month") -> pd.Series:
    """Anomaly vs a seasonal baseline (monthly or daily-of-year climatology from ``baseline`` or the series itself)."""
    s = pd.Series(series, dtype=float)
    idx = pd.to_datetime(s.index)
    base = pd.Series(baseline, dtype=float) if baseline is not None else s
    bidx = pd.to_datetime(base.index)
    key = idx.month if by == "month" else idx.dayofyear
    bkey = bidx.month if by == "month" else bidx.dayofyear
    clim = base.groupby(bkey).mean()
    return pd.Series(s.to_numpy() - clim.reindex(key).to_numpy(), index=s.index, name="anomaly")
