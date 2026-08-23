"""Fairness: group metrics and the IDE's protected-direction audit.

``fairness(df, y, pred, group)`` gives the standard group metrics
(demographic parity, disparate impact / four-fifths, equal opportunity,
equalised odds, calibration by group). ``fairness_audit`` is the Hard
Data layer's indirect-discrimination readout (workspace/fairness.ts):
residualise a prediction on the legitimate factors, measure how much of the
rest aligns with the protected attribute, and show the same numbers after
mitigation.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

import numpy as np
import pandas as pd

from ._audit import tool
from ._table import Table

__all__ = ["fairness", "disparate_impact", "fairness_audit", "parity"]


def _binary(s: pd.Series) -> np.ndarray:
    if pd.api.types.is_bool_dtype(s):
        return s.to_numpy(dtype=float)
    v = pd.to_numeric(s, errors="coerce")
    if v.notna().all():
        return v.to_numpy(dtype=float)
    return s.map(lambda x: 1.0 if str(x).strip().lower() in ("1", "true", "yes", "y", "t") else 0.0).to_numpy()


@tool
def fairness(df: pd.DataFrame, y: str, pred: str, group: str, *, threshold: float = 0.5) -> Table:
    """Group fairness metrics per level of ``group``: selection rate, disparate impact, TPR / FPR, calibration, and the gaps.

    ``pred`` may be a probability / score (thresholded at ``threshold``) or
    a 0/1 decision; ``y`` a 0/1 outcome. Disparate impact is each group's
    selection rate over the best-off group's (the four-fifths rule flags < 0.8).
    """
    yy = _binary(df[y])
    pp = pd.to_numeric(df[pred], errors="coerce").to_numpy(dtype=float)
    dec = (pp >= threshold).astype(float) if np.nanmax(pp) > 1 or ((pp > 0) & (pp < 1)).any() else pp
    g = df[group].astype(str).to_numpy()
    rows = []
    for lv in pd.unique(g):
        m = g == lv
        sel = dec[m].mean()
        pos = yy[m] == 1
        neg = yy[m] == 0
        tpr = dec[m][pos].mean() if pos.any() else np.nan
        fpr = dec[m][neg].mean() if neg.any() else np.nan
        cal = yy[m][dec[m] == 1].mean() if (dec[m] == 1).any() else np.nan
        rows.append({group: lv, "n": int(m.sum()), "base_rate": yy[m].mean(), "selection_rate": sel, "tpr": tpr, "fpr": fpr, "precision": cal,
                     "mean_score": float(np.nanmean(pp[m]))})
    out = pd.DataFrame(rows)
    out["disparate_impact"] = out["selection_rate"] / out["selection_rate"].max()
    notes = [
        f"Demographic parity gap {out['selection_rate'].max() - out['selection_rate'].min():.3f}; disparate impact min {out['disparate_impact'].min():.3f}"
        + (" (below the four-fifths rule)" if out["disparate_impact"].min() < 0.8 else " (passes the four-fifths rule)") + ".",
        f"Equal-opportunity gap (TPR) {np.nanmax(out['tpr']) - np.nanmin(out['tpr']):.3f}; equalised-odds FPR gap {np.nanmax(out['fpr']) - np.nanmin(out['fpr']):.3f}.",
    ]
    return Table(out, title=f"Fairness · {pred} vs {y} by {group}", basis=f"threshold {threshold}", stage="hard", notes=notes)


def disparate_impact(df: pd.DataFrame, pred: str, group: str, threshold: float = 0.5) -> pd.Series:
    """Selection rate of each group relative to the best-off group."""
    pp = pd.to_numeric(df[pred], errors="coerce").to_numpy(dtype=float)
    dec = (pp >= threshold).astype(float) if ((pp > 0) & (pp < 1)).any() else pp
    s = pd.Series(dec).groupby(df[group].astype(str).to_numpy()).mean()
    return s / s.max()


parity = disparate_impact


def _ols(X: np.ndarray, y: np.ndarray) -> np.ndarray:
    Xi = np.column_stack([np.ones(len(y)), X])
    beta, *_ = np.linalg.lstsq(Xi, y, rcond=None)
    return Xi @ beta


@tool
def fairness_audit(df: pd.DataFrame, pred: str, protected: str, legitimate: Sequence[str]) -> Table:
    """Protected-direction audit: how much of a prediction's variation beyond the legitimate factors aligns with a protected attribute.

    Residualise ``pred`` on ``legitimate`` (OLS); ``alignment`` = corr(residual,
    protected)² × var(residual) / var(pred); ``disparity`` = standardised
    mean gap in ``pred`` between the protected median split. The mitigated
    row replaces ``pred`` with its legitimate fit plus the residual
    orthogonalised to the protected attribute.
    """
    cols = [pred, protected, *legitimate]
    d = df[cols].apply(pd.to_numeric, errors="coerce").dropna()
    if len(d) < 10:
        raise ValueError("need at least 10 complete rows")
    p = d[pred].to_numpy(dtype=float)
    A = d[protected].to_numpy(dtype=float)
    L = d[list(legitimate)].to_numpy(dtype=float)
    fit = _ols(L, p)
    resid = p - fit

    def alignment(r: np.ndarray) -> float:
        if r.std() == 0 or A.std() == 0:
            return 0.0
        return float(np.corrcoef(r, A)[0, 1] ** 2 * r.var() / p.var())

    def disparity(x: np.ndarray) -> float:
        hi = A >= np.median(A)
        if hi.all() or not hi.any():
            hi = A > np.median(A)
        if hi.all() or not hi.any():
            return 0.0
        return float(abs(x[hi].mean() - x[~hi].mean()) / (x.std() if x.std() else 1))

    def r2(x: np.ndarray) -> float:
        target = _ols(L, p)
        return float(1 - np.sum((x - target) ** 2) / np.sum((target - target.mean()) ** 2)) if target.var() else 0.0

    resid_clean = resid - _ols(A[:, None], resid) + resid.mean()
    p_after = fit + resid_clean
    out = pd.DataFrame([
        {"stage": "before", "alignment": alignment(resid), "disparity": disparity(p), "fit_to_legitimate": r2(p)},
        {"stage": "after", "alignment": alignment(p_after - fit), "disparity": disparity(p_after), "fit_to_legitimate": r2(p_after)},
    ])
    t = Table(out, title=f"Protected-direction audit · {pred} vs {protected}", basis=f"legitimate: {', '.join(legitimate)} · n = {len(d):,}", stage="hard", notes=[
        "alignment = share of the prediction's non-legitimate variation aligned with the protected attribute; disparity = |mean gap| / sd across the protected median split. Mitigation orthogonalises the residual to the protected attribute and keeps the legitimate fit.",
    ])
    t.attrs["mitigated"] = pd.Series(p_after, index=d.index, name=f"{pred}_mitigated")
    return t
