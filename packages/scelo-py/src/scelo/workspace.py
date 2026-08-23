"""Workspace: the Hard Data layer's "global workspace" diagnostics.

A port of the IDE's numpy bottleneck bridge (apps/web/.../bridges/
bottleneckPython.ts) and the active-subspace pieces around it: which few
directions in the drivers the report heads actually turn on, how sparse and
non-negative the broadcast from codes to heads is, and whether the codes are
causally aligned with the marginal slopes. The linear special case with one
code is exactly Lee–Carter; see Denewade (2026), "A Global Workspace for
Actuarial Models".
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence

import numpy as np
import pandas as pd

from ._alias import numeric_columns
from ._audit import tool
from ._table import Table

__all__ = ["bottleneck", "active_subspace", "participation_ratio"]


def participation_ratio(eigenvalues: Sequence[float]) -> float:
    """(Σλ)² / Σλ²: the effective number of directions."""
    w = np.asarray(eigenvalues, dtype=float)
    w = w[w > 0]
    return float(w.sum() ** 2 / np.sum(w ** 2)) if w.size else 0.0


def _name_code(loadings: np.ndarray, cols: Sequence[str]) -> str:
    order = np.argsort(-np.abs(loadings))
    top = abs(loadings[order[0]])
    parts = []
    for j in order[:3]:
        if abs(loadings[j]) >= 0.35 * top and top > 0:
            parts.append(f"{str(cols[j]).replace('_', ' ').replace('-', ' ')} {'up' if loadings[j] > 0 else 'down'}")
    return ", ".join(parts) if parts else "mixed"


@tool
def bottleneck(df: pd.DataFrame, columns: Optional[Sequence[str]] = None, r: int = 3, l1: float = 1e-3, max_rows: int = 20_000) -> Table:
    """Workspace bottleneck: r codes (top eigen-directions of the standardised drivers) broadcast non-negatively to every column.

    Returns the heads × codes broadcast matrix with the code names, and in
    ``attrs``: participation ratio, reconstruction R², causal alignment and
    sparsity (the IDE's four workspace metrics).
    """
    cols = list(columns) if columns is not None else numeric_columns(df)
    X = df[cols].apply(pd.to_numeric, errors="coerce").dropna()
    if len(X) > max_rows:
        X = X.iloc[:: max(1, len(X) // max_rows)]
    X = X.to_numpy(dtype=float)
    if X.shape[0] < 10 or X.shape[1] < 3:
        raise ValueError("need at least 10 complete rows and 3 numeric columns")
    r = max(1, min(r, X.shape[1] - 1))
    mu = X.mean(0)
    sd = X.std(0, ddof=1)
    sd[sd < 1e-9] = 1
    Z = (X - mu) / sd
    C = np.cov(Z, rowvar=False)
    w, V = np.linalg.eigh(C)
    order = np.argsort(w)[::-1]
    w, V = w[order], V[:, order]
    Vr = V[:, :r].copy()
    codes = Z @ Vr
    rowsum = Z.sum(1)
    for k in range(r):
        if rowsum.std() > 0 and codes[:, k].std() > 0 and np.corrcoef(codes[:, k], rowsum)[0, 1] < 0:
            Vr[:, k] *= -1
            codes[:, k] *= -1
    G = codes.T @ codes
    lr = 1 / (np.trace(G) + 1e-9)
    B = np.zeros((X.shape[1], r))
    for c in range(X.shape[1]):
        b = np.zeros(r)
        g = codes.T @ Z[:, c]
        for _ in range(300):
            b = np.maximum(0, b - lr * (G @ b - g + l1))
        B[c] = b
    recon = codes @ B.T
    ss_res = ((Z - recon) ** 2).sum(0)
    ss_tot = (Z ** 2).sum(0)
    r2 = float(np.mean(np.clip(1 - ss_res / np.where(ss_tot > 0, ss_tot, 1), 0, 1)))
    aligns = []
    for k in range(r):
        zk = codes[:, k]
        slopes = np.array([np.cov(Z[:, c], zk)[0, 1] / zk.var() if zk.var() > 0 else 0 for c in range(X.shape[1])])
        if B[:, k].std() > 0 and slopes.std() > 0:
            aligns.append(np.corrcoef(B[:, k], slopes)[0, 1] ** 2)
    align = float(np.mean(aligns)) if aligns else 0.0
    pr = participation_ratio(w[:r])
    sparsity = float(np.mean(np.abs(B) < 0.02 * np.abs(B).max())) if B.size and np.abs(B).max() > 0 else 1.0
    names = [_name_code(Vr[:, k], cols) for k in range(r)]
    out = pd.DataFrame(B, index=pd.Index(cols, name="head"), columns=[f"code {k + 1}: {n}" for k, n in enumerate(names)])
    t = Table(out, title=f"Workspace bottleneck · {r} codes · {X.shape[0]:,} rows", basis=f"PR {pr:.2f} · reconstruction R² {r2:.2f} · causal alignment {align:.2f} · sparsity {sparsity:.2f}", stage="hard", notes=[
        "Codes are the leading eigenvectors of the standardised driver covariance, oriented positively; the broadcast B ≥ 0 is fitted by projected gradient with an L1 penalty (300 steps).",
        "Participation ratio = effective number of codes; causal alignment = how well each code's broadcast matches the marginal slopes of the heads on that code.",
    ])
    t.attrs.update(participation_ratio=pr, reconstruction_r2=r2, causal_alignment=align, sparsity=sparsity, code_loadings=pd.DataFrame(Vr, index=cols, columns=names), eigenvalues=w)
    return t


@tool
def active_subspace(df: pd.DataFrame, readout: str, drivers: Optional[Sequence[str]] = None, *, max_rows: int = 20_000) -> Table:
    """Active subspace of a readout: eigen-directions of the gradient covariance C = E[∇f ∇fᵀ] of a linear-quadratic surrogate.

    Reports each direction's sensitivity share, input-variance share and
    named loadings: a direction can carry most of the decision and almost
    none of the variance (the workspace signature).
    """
    cols = list(drivers) if drivers is not None else [c for c in numeric_columns(df) if c != readout]
    d = df[cols + [readout]].apply(pd.to_numeric, errors="coerce").dropna()
    if len(d) > max_rows:
        d = d.iloc[:: max(1, len(d) // max_rows)]
    X = d[cols].to_numpy(dtype=float)
    y = d[readout].to_numpy(dtype=float)
    mu, sd = X.mean(0), X.std(0, ddof=1)
    sd[sd < 1e-9] = 1
    Z = (X - mu) / sd
    n, p = Z.shape
    # quadratic surrogate: y ~ b0 + Σ b_i z_i + Σ_{i<=j} c_ij z_i z_j
    feats = [np.ones(n)] + [Z[:, i] for i in range(p)] + [Z[:, i] * Z[:, j] for i in range(p) for j in range(i, p)]
    F = np.column_stack(feats)
    beta, *_ = np.linalg.lstsq(F, y, rcond=None)
    yhat = F @ beta
    r2 = float(1 - np.sum((y - yhat) ** 2) / np.sum((y - y.mean()) ** 2)) if y.var() > 0 else 0.0
    # gradient at every row
    lin = beta[1:1 + p]
    quad = np.zeros((p, p))
    idx = 1 + p
    for i in range(p):
        for j in range(i, p):
            quad[i, j] = beta[idx]
            idx += 1
    grads = np.tile(lin, (n, 1))
    for i in range(p):
        for j in range(i, p):
            if i == j:
                grads[:, i] += 2 * quad[i, j] * Z[:, i]
            else:
                grads[:, i] += quad[i, j] * Z[:, j]
                grads[:, j] += quad[i, j] * Z[:, i]
    Cf = grads.T @ grads / n
    w, V = np.linalg.eigh(Cf)
    order = np.argsort(w)[::-1]
    w, V = w[order], V[:, order]
    var_eig = np.sort(np.linalg.eigvalsh(np.cov(Z, rowvar=False)))[::-1]
    tau = 1e-3 * w[0] if w[0] > 0 else 0
    rank = int((w > tau).sum())
    rows = []
    for k in range(min(6, p)):
        vshare = float(V[:, k] @ np.cov(Z, rowvar=False) @ V[:, k] / var_eig.sum()) if var_eig.sum() > 0 else 0.0
        rows.append({"direction": k + 1, "eigenvalue": w[k], "sensitivity_share": w[k] / w.sum() if w.sum() > 0 else 0, "variance_share": vshare, "name": _name_code(V[:, k], cols),
                     "loadings": ", ".join(f"{c}:{V[j, k]:+.2f}" for j, c in enumerate(cols) if abs(V[j, k]) >= 0.2)})
    out = pd.DataFrame(rows)
    pr = participation_ratio(w)
    t = Table(out, title=f"Active subspace · {readout}", basis=f"{p} drivers · surrogate R² {r2:.2f} · rank {rank} · PR {pr:.2f}", stage="hard", notes=[
        "Directions are eigenvectors of C = E[∇f∇fᵀ] for a quadratic surrogate of the readout; sensitivity share is the share of C's trace, variance share the share of input variance the direction occupies.",
        f"Workspace variance fraction {sum(r_['variance_share'] for r_ in rows[:rank]):.3f} over the {rank} active directions.",
    ])
    t.attrs.update(rank=rank, participation_ratio=pr, surrogate_r2=r2, sensitivity_spectrum=w, variance_spectrum=var_eig, directions=V)
    return t
