"""Finance: discount curves, present values, yield-curve models.

``discount_curve`` is the IDE's discount-curve table (linear interpolation
between quoted tenors, flat extrapolation); ``smith_wilson`` is the EIOPA
extrapolation to the UFR it points at; ``nelson_siegel`` / ``nss`` fit the
parametric curves; ``hull_white`` simulates short-rate paths. The scalar
helpers (``pv``, ``npv``, ``irr``, ``annuity_certain``, ``duration`` …) are
the Exam-FM toolkit in vectorised form.
"""

from __future__ import annotations

import math
from typing import Any, Dict, Optional, Sequence, Tuple, Union

import numpy as np
import pandas as pd

from ._alias import infer
from ._audit import tool
from ._table import Table

__all__ = [
    "discount_curve", "v", "pv", "npv", "irr", "annuity_certain", "accumulation", "duration", "convexity", "forward_rates",
    "zero_to_df", "df_to_zero", "bond_price", "bond_yield", "smith_wilson", "nelson_siegel", "nss", "hull_white", "bootstrap_par",
    "nominal", "effective", "force", "from_force", "discount_rate",
]

Curve = Union[float, pd.DataFrame, pd.Series, Sequence[Tuple[float, float]], Dict[float, float], None]


# ── scalar time-value helpers ──────────────────────────────────────────────

def v(i: float, t: Union[float, Sequence[float]] = 1.0) -> Union[float, np.ndarray]:
    """Discount factor vᵗ = (1+i)⁻ᵗ."""
    return (1 + i) ** -np.asarray(t, dtype=float) if not np.isscalar(t) else (1 + i) ** -float(t)


def nominal(i: float, m: int = 12) -> float:
    """Nominal rate i⁽ᵐ⁾ convertible m-thly from an effective annual rate: m·((1+i)^(1/m) − 1)."""
    return m * ((1 + i) ** (1 / m) - 1)


def effective(i_m: float, m: int = 12) -> float:
    """Effective annual rate from a nominal rate convertible m-thly: (1 + i⁽ᵐ⁾/m)^m − 1."""
    return (1 + i_m / m) ** m - 1


def force(i: float) -> float:
    """Force of interest δ = ln(1 + i)."""
    return math.log(1 + i)


def from_force(delta: float) -> float:
    """Effective annual rate from a force of interest: e^δ − 1."""
    return math.exp(delta) - 1


def discount_rate(i: float) -> float:
    """Annual discount rate d = i / (1 + i)."""
    return i / (1 + i)


def pv(cashflows: Sequence[float], rate: Curve, times: Optional[Sequence[float]] = None) -> float:
    """Present value of cash flows at ``times`` (default 1, 2, …) under a flat rate or a curve (zero rates by tenor)."""
    cf = np.asarray(cashflows, dtype=float)
    t = np.arange(1, cf.size + 1, dtype=float) if times is None else np.asarray(times, dtype=float)
    return float(np.sum(cf * zero_to_df(_zero_at(rate, t), t)))


def npv(rate: float, cashflows: Sequence[float], t0: bool = True) -> float:
    """Net present value of cash flows starting at time 0 (``t0=True``, Excel-unlike) or time 1."""
    cf = np.asarray(cashflows, dtype=float)
    t = np.arange(0 if t0 else 1, cf.size + (0 if t0 else 1), dtype=float)
    return float(np.sum(cf * (1 + rate) ** -t))


def irr(cashflows: Sequence[float], lo: float = -0.99, hi: float = 10.0, tol: float = 1e-10) -> float:
    """Internal rate of return by bisection on NPV(t0) = 0; raises when no sign change in [lo, hi]."""
    f_lo, f_hi = npv(lo, cashflows), npv(hi, cashflows)
    if f_lo * f_hi > 0:
        raise ValueError("IRR not bracketed: NPV has the same sign at both ends")
    for _ in range(200):
        mid = (lo + hi) / 2
        f_mid = npv(mid, cashflows)
        if abs(f_mid) < tol or (hi - lo) < tol:
            return mid
        if f_lo * f_mid < 0:
            hi, f_hi = mid, f_mid
        else:
            lo, f_lo = mid, f_mid
    return (lo + hi) / 2


def annuity_certain(n: float, i: float, due: bool = False, m: int = 1, increasing: bool = False) -> float:
    """a⁽ᵐ⁾_n (immediate) or ä_n (``due``); ``increasing`` gives (Ia)_n / (Iä)_n."""
    if i == 0:
        return n * (n + 1) / 2 if increasing else float(n)
    vv = 1 / (1 + i)
    if increasing:
        a_due = (1 - vv ** n) / (i / (1 + i))
        ia = (a_due - n * vv ** n) / i  # (Ia)_n immediate
        return ia * (1 + i) if due else ia
    i_m = m * ((1 + i) ** (1 / m) - 1)
    d_m = m * (1 - vv ** (1 / m))
    return (1 - vv ** n) / (d_m if due else i_m)


def accumulation(n: float, i: float, due: bool = False) -> float:
    """s_n (immediate) or s̈_n (``due``)."""
    return annuity_certain(n, i, due) * (1 + i) ** n


def duration(cashflows: Sequence[float], rate: float, times: Optional[Sequence[float]] = None, modified: bool = False) -> float:
    """Macaulay (or ``modified``) duration of a cash-flow stream at a flat annual rate."""
    cf = np.asarray(cashflows, dtype=float)
    t = np.arange(1, cf.size + 1, dtype=float) if times is None else np.asarray(times, dtype=float)
    disc = (1 + rate) ** -t
    p = np.sum(cf * disc)
    mac = float(np.sum(t * cf * disc) / p)
    return mac / (1 + rate) if modified else mac


def convexity(cashflows: Sequence[float], rate: float, times: Optional[Sequence[float]] = None) -> float:
    """Convexity Σ t(t+1)·CF·vᵗ⁺² / P."""
    cf = np.asarray(cashflows, dtype=float)
    t = np.arange(1, cf.size + 1, dtype=float) if times is None else np.asarray(times, dtype=float)
    p = np.sum(cf * (1 + rate) ** -t)
    return float(np.sum(t * (t + 1) * cf * (1 + rate) ** -(t + 2)) / p)


def bond_price(face: float, coupon: float, n: int, yield_: float, m: int = 1, redemption: Optional[float] = None) -> float:
    """Price of a bond paying coupon rate ``coupon`` ``m`` times a year for ``n`` years at nominal yield ``yield_`` (compounded m-thly)."""
    C = face * coupon / m
    j = yield_ / m
    N = n * m
    R = face if redemption is None else redemption
    return C * (1 - (1 + j) ** -N) / j + R * (1 + j) ** -N if j else C * N + R


def bond_yield(price: float, face: float, coupon: float, n: int, m: int = 1, redemption: Optional[float] = None) -> float:
    """Nominal yield (compounded m-thly) solving price = bond_price(yield)."""
    lo, hi = -0.5, 5.0
    for _ in range(200):
        mid = (lo + hi) / 2
        if bond_price(face, coupon, n, mid, m, redemption) > price:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


# ── curves ──────────────────────────────────────────────────────────────────

def _points(curve: Curve, df: Optional[pd.DataFrame] = None) -> Tuple[np.ndarray, np.ndarray, str]:
    if curve is None and df is None:
        return np.array([1.0]), np.array([0.04]), "flat 4 %"
    if isinstance(curve, (int, float)):
        return np.array([1.0]), np.array([float(curve)]), f"flat {curve * 100:g} %"
    if isinstance(curve, dict):
        t = np.array(sorted(curve), dtype=float)
        return t, np.array([curve[k] for k in sorted(curve)], dtype=float), f"{t.size} quoted tenors"
    if isinstance(curve, pd.Series):
        s = curve.sort_index()
        return s.index.to_numpy(dtype=float), s.to_numpy(dtype=float), f"{len(s)} quoted tenors"
    if isinstance(curve, pd.DataFrame) or df is not None:
        d = curve if isinstance(curve, pd.DataFrame) else df
        tc = infer(d, "tenor")
        rc = infer(d, "rate", exclude=[tc])
        g = pd.DataFrame({"t": pd.to_numeric(d[tc], errors="coerce"), "r": pd.to_numeric(d[rc], errors="coerce")}).dropna().groupby("t")["r"].mean()
        r = g.to_numpy(dtype=float)
        if r.max() > 1:
            r = r / 100
        return g.index.to_numpy(dtype=float), r, f"`{rc}` by `{tc}`"
    pts = sorted((float(a), float(b)) for a, b in curve)  # type: ignore[union-attr]
    t = np.array([p[0] for p in pts])
    r = np.array([p[1] for p in pts])
    if r.max() > 1:
        r = r / 100
    return t, r, f"{t.size} quoted tenors"


def _zero_at(curve: Curve, t: np.ndarray) -> np.ndarray:
    tt, rr, _ = _points(curve)
    if tt.size == 1:
        return np.full_like(t, rr[0], dtype=float)
    return np.interp(t, tt, rr)  # linear between, flat beyond (numpy clamps)


def zero_to_df(z: Union[float, np.ndarray], t: Union[float, np.ndarray]) -> np.ndarray:
    """Discount factor from an annual-compound zero rate: (1+z)⁻ᵗ."""
    return (1 + np.asarray(z, dtype=float)) ** -np.asarray(t, dtype=float)


def df_to_zero(p: Union[float, np.ndarray], t: Union[float, np.ndarray]) -> np.ndarray:
    """Annual-compound zero rate from a discount factor: p^(−1/t) − 1."""
    return np.asarray(p, dtype=float) ** (-1 / np.asarray(t, dtype=float)) - 1


@tool
def discount_curve(curve: Curve = None, df: Optional[pd.DataFrame] = None, *, max_tenor: Optional[int] = None) -> Table:
    """Discount-curve table: tenor, zero rate, discount factor, 1y forward, annuity-certain a_n, for t = 1 … max_tenor.

    ``curve`` is a flat rate, ``{tenor: rate}``, a Series by tenor, a list
    of (tenor, rate) or a DataFrame with tenor + rate columns (percent
    values are divided by 100). Linear interpolation between quoted tenors,
    flat extrapolation beyond the last (use ``smith_wilson`` for a UFR).
    """
    t, r, label = _points(curve, df)
    notes = []
    if t.size == 1 and (curve is None or isinstance(curve, (int, float))):
        notes.append(f"Flat {r[0] * 100:g} % curve: every tenor discounts at the same rate.")
    mt = max_tenor or int(max(30, np.round(t).max()))
    tenors = np.arange(1, mt + 1, dtype=float)
    z = _zero_at(curve if curve is not None else (df if df is not None else r[0]), tenors) if df is None else np.interp(tenors, t, r)
    if t.size == 1:
        z = np.full(mt, r[0])
    dfs = (1 + z) ** -tenors
    prev = np.concatenate([[1.0], dfs[:-1]])
    fwd = prev / dfs - 1
    ann = np.cumsum(dfs)
    out = pd.DataFrame({"tenor": tenors.astype(int), "zero rate": z, "discount factor": dfs, "1y forward": fwd, "annuity-certain a_n": ann})
    notes.append("Zero rates are annual-compound; linear interpolation between quoted tenors and flat extrapolation beyond the last one (use scelo.smith_wilson for a UFR extrapolation). v_t = (1+z_t)^−t; f(t−1,t) = v_{t−1}/v_t − 1; a_n = Σ v_t.")
    return Table(out, title=f"Discount curve · {label} · to {mt}y", basis=label, stage="hard", notes=notes)


def forward_rates(zeros: Union[pd.Series, Sequence[float]], tenors: Optional[Sequence[float]] = None) -> pd.Series:
    """One-period forward rates implied by annual-compound zero rates."""
    z = np.asarray(pd.Series(zeros, dtype=float))
    t = np.asarray(tenors, dtype=float) if tenors is not None else np.arange(1, z.size + 1, dtype=float)
    p = (1 + z) ** -t
    prev = np.concatenate([[1.0], p[:-1]])
    tprev = np.concatenate([[0.0], t[:-1]])
    f = (prev / p) ** (1 / (t - tprev)) - 1
    return pd.Series(f, index=t, name="forward")


def bootstrap_par(par: Union[pd.Series, Sequence[float]], tenors: Optional[Sequence[int]] = None) -> pd.Series:
    """Zero rates bootstrapped from annual par (swap / coupon) rates at integer tenors 1..n."""
    c = np.asarray(pd.Series(par, dtype=float))
    t = np.arange(1, c.size + 1) if tenors is None else np.asarray(tenors, dtype=int)
    dfs = []
    for k in range(c.size):
        ann = sum(dfs)
        d = (1 - c[k] * ann) / (1 + c[k])
        dfs.append(d)
    dfs = np.asarray(dfs)
    return pd.Series(dfs ** (-1 / t) - 1, index=t, name="zero")


# ── Smith–Wilson (EIOPA) ──────────────────────────────────────────────────

def _wilson(t: np.ndarray, u: np.ndarray, alpha: float, omega: float) -> np.ndarray:
    t = t[:, None]
    u = u[None, :]
    mn = np.minimum(t, u)
    mx = np.maximum(t, u)
    return np.exp(-omega * (t + u)) * (alpha * mn - 0.5 * np.exp(-alpha * mx) * (np.exp(alpha * mn) - np.exp(-alpha * mn)))


@tool
def smith_wilson(tenors: Sequence[float], rates: Sequence[float], *, ufr: float = 0.042, alpha: float = 0.1, max_tenor: int = 60,
                 zero_input: bool = True, compounding: str = "annual") -> Table:
    """EIOPA Smith–Wilson: fit the observed zero (or par) rates exactly and extrapolate to the ultimate forward rate.

    ``ufr`` is annual-compound (converted to continuous ω = ln(1+UFR)
    internally); ``alpha`` is the convergence speed. Returns tenor, zero
    rate, discount factor and forward for 1 … ``max_tenor``.
    """
    u = np.asarray(tenors, dtype=float)
    r = np.asarray(rates, dtype=float)
    if r.max() > 1:
        r = r / 100
    omega = math.log(1 + ufr)
    if zero_input:
        p_obs = (1 + r) ** -u
        C = np.eye(u.size)
        cf_times = u
    else:  # par (coupon) bonds paying annually
        n = int(np.round(u.max()))
        cf_times = np.arange(1, n + 1, dtype=float)
        C = np.zeros((u.size, n))
        for k, (mat, cpn) in enumerate(zip(u, r)):
            m = int(round(mat))
            C[k, :m] = cpn
            C[k, m - 1] += 1
        p_obs = np.ones(u.size)
    mu = np.exp(-omega * cf_times)
    W = _wilson(cf_times, cf_times, alpha, omega)
    A = C @ W @ C.T
    zeta = np.linalg.solve(A, p_obs - C @ mu)
    t = np.arange(1, max_tenor + 1, dtype=float)
    p = np.exp(-omega * t) + _wilson(t, cf_times, alpha, omega) @ (C.T @ zeta)
    z = p ** (-1 / t) - 1
    prev = np.concatenate([[1.0], p[:-1]])
    fwd = prev / p - 1
    out = pd.DataFrame({"tenor": t.astype(int), "zero rate": z, "discount factor": p, "1y forward": fwd})
    return Table(out, title=f"Smith–Wilson · UFR {ufr:.2%} · α {alpha:g} · to {max_tenor}y", basis=f"{u.size} {'zero' if zero_input else 'par'} rates · UFR {ufr:.2%} · α {alpha:g}", stage="hard", notes=[
        "P(t) = e^{−ωt} + Σ ζ_j W(t, u_j) with the Wilson kernel W(t,u) = e^{−ω(t+u)}(α·min(t,u) − ½e^{−α·max(t,u)}(e^{α·min} − e^{−α·min})); fits the observed prices exactly and converges to the UFR forward.",
        f"Last observed tenor {u.max():g}y; convergence speed α = {alpha:g} (EIOPA floor 0.05).",
    ])


# ── Nelson–Siegel / Svensson ─────────────────────────────────────────────

def _ns_design(t: np.ndarray, lam: float) -> np.ndarray:
    x = t * lam
    f1 = (1 - np.exp(-x)) / x
    f2 = f1 - np.exp(-x)
    return np.column_stack([np.ones_like(t), f1, f2])


def _nss_design(t: np.ndarray, l1: float, l2: float) -> np.ndarray:
    x1, x2 = t * l1, t * l2
    f1 = (1 - np.exp(-x1)) / x1
    f2 = f1 - np.exp(-x1)
    f3 = (1 - np.exp(-x2)) / x2 - np.exp(-x2)
    return np.column_stack([np.ones_like(t), f1, f2, f3])


@tool
def nelson_siegel(tenors: Sequence[float], rates: Sequence[float], *, lam: Optional[float] = None, max_tenor: int = 60) -> Table:
    """Nelson–Siegel fit z(t) = β₀ + β₁(1−e^{−λt})/(λt) + β₂((1−e^{−λt})/(λt) − e^{−λt}); λ by grid search unless given."""
    t = np.asarray(tenors, dtype=float)
    r = np.asarray(rates, dtype=float)
    if r.max() > 1:
        r = r / 100
    best = None
    grid = [lam] if lam else np.linspace(0.05, 2.0, 60)
    for L in grid:
        X = _ns_design(t, L)
        beta, res, *_ = np.linalg.lstsq(X, r, rcond=None)
        sse = float(np.sum((X @ beta - r) ** 2))
        if best is None or sse < best[0]:
            best = (sse, L, beta)
    sse, L, beta = best
    tt = np.arange(1, max_tenor + 1, dtype=float)
    z = _ns_design(tt, L) @ beta
    out = pd.DataFrame({"tenor": tt.astype(int), "zero rate": z, "discount factor": (1 + z) ** -tt})
    tbl = Table(out, title=f"Nelson–Siegel · λ {L:.3f}", basis=f"β = ({beta[0]:.4f}, {beta[1]:.4f}, {beta[2]:.4f}) · λ {L:.3f}", stage="hard", notes=[
        f"Level β₀ {beta[0]:.4%}, slope β₁ {beta[1]:.4%}, curvature β₂ {beta[2]:.4%}; RMSE {math.sqrt(sse / t.size):.2e} over {t.size} quotes.",
    ])
    tbl.attrs["beta"] = beta
    tbl.attrs["lam"] = L
    return tbl


@tool
def nss(tenors: Sequence[float], rates: Sequence[float], *, lam1: Optional[float] = None, lam2: Optional[float] = None, max_tenor: int = 60) -> Table:
    """Nelson–Siegel–Svensson (four β, two λ) by a coarse grid on (λ₁, λ₂) with linear β."""
    t = np.asarray(tenors, dtype=float)
    r = np.asarray(rates, dtype=float)
    if r.max() > 1:
        r = r / 100
    g1 = [lam1] if lam1 else np.linspace(0.05, 1.5, 25)
    g2 = [lam2] if lam2 else np.linspace(0.05, 3.0, 25)
    best = None
    for L1 in g1:
        for L2 in g2:
            if abs(L1 - L2) < 1e-6:
                continue
            X = _nss_design(t, L1, L2)
            beta, *_ = np.linalg.lstsq(X, r, rcond=None)
            sse = float(np.sum((X @ beta - r) ** 2))
            if best is None or sse < best[0]:
                best = (sse, L1, L2, beta)
    sse, L1, L2, beta = best
    tt = np.arange(1, max_tenor + 1, dtype=float)
    z = _nss_design(tt, L1, L2) @ beta
    out = pd.DataFrame({"tenor": tt.astype(int), "zero rate": z, "discount factor": (1 + z) ** -tt})
    tbl = Table(out, title=f"Nelson–Siegel–Svensson · λ₁ {L1:.3f} · λ₂ {L2:.3f}", basis=f"β = ({', '.join(f'{b:.4f}' for b in beta)})", stage="hard",
                notes=[f"RMSE {math.sqrt(sse / t.size):.2e} over {t.size} quotes."])
    tbl.attrs["beta"] = beta
    tbl.attrs["lam"] = (L1, L2)
    return tbl


# ── Hull–White short rate ─────────────────────────────────────────────────

@tool
def hull_white(r0: float = 0.04, *, a: float = 0.1, sigma: float = 0.01, theta: Union[float, Sequence[float], None] = None,
               horizon: int = 30, steps_per_year: int = 12, n_paths: int = 1000, seed: Optional[int] = 42) -> Table:
    """One-factor Hull–White / Vasicek short-rate paths: dr = (θ(t) − a·r)dt + σ dW, Euler on a monthly grid.

    ``theta`` defaults to a·r0 (mean-reverting to r0); a vector gives θ per
    year. Returns per-step mean / p5 / p95 short rate and the mean discount
    factor (the Monte-Carlo zero curve) in ``attrs["paths"]``.
    """
    rng = np.random.default_rng(seed)
    n = horizon * steps_per_year
    dt = 1 / steps_per_year
    th = np.full(n, a * r0) if theta is None else (np.full(n, float(theta)) if np.isscalar(theta) else np.repeat(np.asarray(theta, dtype=float), steps_per_year)[:n])
    r = np.full(n_paths, r0, dtype=float)
    rates = np.empty((n, n_paths))
    for k in range(n):
        r = r + (th[k] - a * r) * dt + sigma * math.sqrt(dt) * rng.standard_normal(n_paths)
        rates[k] = r
    integ = np.cumsum(rates, axis=0) * dt
    dfs = np.exp(-integ)
    t = (np.arange(1, n + 1) / steps_per_year)
    out = pd.DataFrame({"t": t, "mean": rates.mean(axis=1), "p5": np.quantile(rates, 0.05, axis=1), "p95": np.quantile(rates, 0.95, axis=1),
                        "mean df": dfs.mean(axis=1)})
    tbl = Table(out, title=f"Hull–White short rate · {n_paths:,} paths · {horizon}y", basis=f"r0 {r0:.2%} · a {a:g} · σ {sigma:g}", stage="hard", notes=[
        "Euler discretisation of dr = (θ − a·r)dt + σ dW; mean df = E[exp(−∫r)] is the model's zero-coupon price (Monte Carlo).",
    ])
    tbl.attrs["paths"] = rates
    return tbl
