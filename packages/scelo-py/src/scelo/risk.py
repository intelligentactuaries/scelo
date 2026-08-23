"""Risk: tail measures, aggregate loss, distribution fitting, credibility, capital aggregation.

``var`` / ``tvar`` on any sample; ``aggregate_loss`` by Panjer recursion,
FFT or Monte Carlo for a frequency × severity model; ``fit`` maximum-
likelihood fits of the usual severity families with a numpy fallback when
scipy is absent; Bühlmann / Bühlmann–Straub credibility; limited-fluctuation
standards; and ``aggregate_scr`` for a Solvency-II-style square-root
aggregation with the standard-formula life correlation matrix as default.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

import numpy as np
import pandas as pd

from ._alias import infer
from ._audit import tool
from ._table import Table

__all__ = [
    "var", "tvar", "es", "aggregate_loss", "panjer", "fit", "credibility", "buhlmann", "limited_fluctuation", "full_credibility",
    "aggregate_scr", "SII_LIFE_CORR", "SII_NONLIFE_CORR", "SII_BSCR_CORR", "simulate_losses", "lognormal_params", "risk_margin",
]


# ── tail measures ──────────────────────────────────────────────────────────

def var(x: Sequence[float], p: float = 0.995) -> float:
    """Value at risk: the p-quantile (type 7) of a loss sample."""
    arr = np.asarray(pd.Series(x, dtype=float).dropna())
    return float(np.quantile(arr, p))


def tvar(x: Sequence[float], p: float = 0.995) -> float:
    """Tail VaR / expected shortfall: mean of the sample above its p-quantile."""
    arr = np.asarray(pd.Series(x, dtype=float).dropna())
    q = np.quantile(arr, p)
    tail = arr[arr >= q]
    return float(tail.mean()) if tail.size else float(q)


es = tvar


# ── aggregate loss ────────────────────────────────────────────────────────

def _freq_pmf(dist: str, n_max: int, **kw: float) -> np.ndarray:
    """Frequency pmf on 0..n_max for poisson / negbin / binomial."""
    k = np.arange(n_max + 1)
    if dist == "poisson":
        lam = float(kw["lam"])
        logp = -lam + k * math.log(lam) - np.array([math.lgamma(i + 1) for i in k]) if lam > 0 else np.where(k == 0, 0.0, -np.inf)
        return np.exp(logp)
    if dist in ("negbin", "nbinom", "negative-binomial"):
        r, beta = float(kw["r"]), float(kw["beta"])
        p = 1 / (1 + beta)
        logp = np.array([math.lgamma(i + r) - math.lgamma(r) - math.lgamma(i + 1) for i in k]) + r * math.log(p) + k * math.log(1 - p)
        return np.exp(logp)
    if dist == "binomial":
        m, q = int(kw["m"]), float(kw["q"])
        out = np.zeros(n_max + 1)
        for i in range(min(m, n_max) + 1):
            out[i] = math.comb(m, i) * q ** i * (1 - q) ** (m - i)
        return out
    raise ValueError("frequency must be poisson, negbin or binomial")


def _discretise(sev: Union[str, Sequence[float], Dict[str, Any]], h: float, n: int, **kw: float) -> np.ndarray:
    """Severity pmf on the lattice 0, h, 2h, … (rounding method) from a named distribution or an empirical sample."""
    x = np.arange(n) * h
    if isinstance(sev, str):
        cdf = _cdf(sev, kw)
        up = cdf(x + h / 2)
        lo = np.concatenate([[0.0], up[:-1]])
        f = up - lo
        f[-1] += max(0.0, 1 - up[-1])
        return f
    arr = np.asarray(sev, dtype=float)
    idx = np.clip(np.round(arr / h).astype(int), 0, n - 1)
    return np.bincount(idx, minlength=n) / arr.size


def _cdf(name: str, kw: Dict[str, float]):
    name = name.lower()
    if name == "lognormal":
        mu, s = float(kw["mu"]), float(kw["sigma"])
        return lambda x: np.where(x > 0, 0.5 * (1 + _erf((np.log(np.maximum(x, 1e-300)) - mu) / (s * math.sqrt(2)))), 0.0)
    if name == "exponential":
        th = float(kw.get("theta", 1 / kw.get("rate", 1.0)))
        return lambda x: np.where(x > 0, 1 - np.exp(-x / th), 0.0)
    if name == "gamma":
        a, th = float(kw["alpha"]), float(kw["theta"])
        return lambda x: np.where(x > 0, _gammainc(a, np.maximum(x, 0) / th), 0.0)
    if name == "pareto":
        a, th = float(kw["alpha"]), float(kw["theta"])
        return lambda x: np.where(x > 0, 1 - (th / (th + np.maximum(x, 0))) ** a, 0.0)
    if name == "weibull":
        k, lam = float(kw["shape"]), float(kw["scale"])
        return lambda x: np.where(x > 0, 1 - np.exp(-(np.maximum(x, 0) / lam) ** k), 0.0)
    raise ValueError("severity must be lognormal, exponential, gamma, pareto or weibull")


def _erf(x: np.ndarray) -> np.ndarray:
    try:
        from scipy.special import erf  # type: ignore
        return erf(x)
    except ImportError:
        return np.vectorize(math.erf)(x)


def _gammainc(a: float, x: np.ndarray) -> np.ndarray:
    try:
        from scipy.special import gammainc  # type: ignore
        return gammainc(a, x)
    except ImportError:
        # series / continued fraction (Numerical Recipes) — adequate for moderate a
        def one(v: float) -> float:
            if v <= 0:
                return 0.0
            if v < a + 1:
                s = term = 1 / a
                n = a
                for _ in range(500):
                    n += 1
                    term *= v / n
                    s += term
                    if abs(term) < abs(s) * 1e-14:
                        break
                return s * math.exp(-v + a * math.log(v) - math.lgamma(a))
            b = v + 1 - a
            c = 1e300
            d = 1 / b
            hh = d
            for i in range(1, 500):
                an = -i * (i - a)
                b += 2
                d = an * d + b
                d = 1e-300 if abs(d) < 1e-300 else d
                c = b + an / c
                c = 1e-300 if abs(c) < 1e-300 else c
                d = 1 / d
                delta = d * c
                hh *= delta
                if abs(delta - 1) < 1e-14:
                    break
            return 1 - math.exp(-v + a * math.log(v) - math.lgamma(a)) * hh
        return np.vectorize(one)(x)


def panjer(freq_pmf_or_dist: Union[str, Sequence[float]], severity_pmf: Sequence[float], **freq_kw: float) -> np.ndarray:
    """Panjer recursion for the aggregate pmf on the severity lattice (poisson / negbin / binomial frequency)."""
    f = np.asarray(severity_pmf, dtype=float)
    n = f.size
    if isinstance(freq_pmf_or_dist, str):
        dist = freq_pmf_or_dist.lower()
        if dist == "poisson":
            a, b, lam = 0.0, float(freq_kw["lam"]), float(freq_kw["lam"])
            p0 = math.exp(-lam * (1 - f[0]))
        elif dist in ("negbin", "nbinom", "negative-binomial"):
            r, beta = float(freq_kw["r"]), float(freq_kw["beta"])
            a, b = beta / (1 + beta), (r - 1) * beta / (1 + beta)
            p0 = (1 + beta * (1 - f[0])) ** -r
        elif dist == "binomial":
            m, q = int(freq_kw["m"]), float(freq_kw["q"])
            a, b = -q / (1 - q), (m + 1) * q / (1 - q)
            p0 = (1 + q * (f[0] - 1)) ** m
        else:
            raise ValueError("Panjer frequency must be poisson, negbin or binomial")
        g = np.zeros(n)
        g[0] = p0
        for s in range(1, n):
            j = np.arange(1, s + 1)
            g[s] = np.sum((a + b * j / s) * f[j] * g[s - j]) / (1 - a * f[0])
        return g
    raise TypeError("pass a frequency name (poisson / negbin / binomial) with its parameters")


@tool
def aggregate_loss(frequency: str = "poisson", severity: Union[str, Sequence[float]] = "lognormal", *, method: str = "panjer",
                   h: Optional[float] = None, n: int = 4096, n_sims: int = 100_000, seed: Optional[int] = 42,
                   quantiles: Sequence[float] = (0.5, 0.75, 0.9, 0.95, 0.99, 0.995), **params: float) -> Table:
    """Aggregate loss distribution S = X₁ + … + X_N: mean, sd, VaR / TVaR at the quantiles.

    ``frequency``: poisson(lam) / negbin(r, beta) / binomial(m, q).
    ``severity``: lognormal(mu, sigma) / gamma(alpha, theta) / pareto(alpha, theta)
    / exponential(theta) / weibull(shape, scale), or an empirical sample.
    ``method``: panjer (exact on a lattice of step ``h``), fft (same lattice,
    any frequency), or mc (Monte Carlo with ``n_sims``).
    """
    fk = {k: v for k, v in params.items() if k in ("lam", "r", "beta", "m", "q")}
    sk = {k: v for k, v in params.items() if k in ("mu", "sigma", "alpha", "theta", "shape", "scale", "rate")}
    if method == "mc":
        rng = np.random.default_rng(seed)
        N = _sample_freq(frequency, fk, n_sims, rng)
        tot = N.sum()
        X = _sample_sev(severity, sk, int(tot), rng)
        S = np.zeros(n_sims)
        np.add.at(S, np.repeat(np.arange(n_sims), N), X)
        mean, sd = float(S.mean()), float(S.std(ddof=1))
        qs = np.quantile(S, quantiles)
        tv = [float(S[S >= q].mean()) if (S >= q).any() else float(q) for q in qs]
        basis = f"Monte Carlo · {n_sims:,} simulations"
    else:
        if h is None:
            mean_sev = _mean_sev(severity, sk)
            mean_n = _mean_freq(frequency, fk)
            h = max(mean_sev * mean_n * 20 / n, 1e-9)
        f = _discretise(severity, h, n, **sk)
        if method == "panjer":
            g = panjer(frequency, f, **fk)
        else:
            pn = _freq_pmf(frequency, n, **fk)
            phi = np.fft.fft(f)
            pgf = np.zeros_like(phi)
            # P_N(z) via the pmf: Σ p_n z^n evaluated at phi (Horner)
            for p_ in pn[::-1]:
                pgf = pgf * phi + p_
            g = np.real(np.fft.ifft(pgf))
            g = np.clip(g, 0, None)
            g /= g.sum()
        x = np.arange(n) * h
        mean = float(np.sum(x * g))
        sd = float(math.sqrt(max(np.sum(x * x * g) - mean ** 2, 0)))
        cdf = np.cumsum(g)
        qs = np.array([x[min(int(np.searchsorted(cdf, q)), n - 1)] for q in quantiles])
        tv = []
        for q in qs:
            m = x >= q
            tv.append(float(np.sum(x[m] * g[m]) / g[m].sum()) if g[m].sum() > 0 else float(q))
        basis = f"{method} · lattice h = {h:g} × {n}"
        if cdf[-1] < 0.999:
            basis += " · WARNING lattice too short"
    out = pd.DataFrame({"p": list(quantiles), "VaR": qs, "TVaR": tv})
    t = Table(out, title=f"Aggregate loss · {frequency}({', '.join(f'{k}={v:g}' for k, v in fk.items())}) × {severity if isinstance(severity, str) else 'empirical'}",
              basis=basis, stage="hard", notes=[f"Mean {mean:,.2f} · sd {sd:,.2f} · CV {sd / mean if mean else float('nan'):.3f}."])
    t.attrs.update(mean=mean, sd=sd)
    return t


def _mean_freq(dist: str, kw: Dict[str, float]) -> float:
    d = dist.lower()
    if d == "poisson":
        return float(kw["lam"])
    if d in ("negbin", "nbinom", "negative-binomial"):
        return float(kw["r"] * kw["beta"])
    return float(kw["m"] * kw["q"])


def _mean_sev(sev: Any, kw: Dict[str, float]) -> float:
    if not isinstance(sev, str):
        return float(np.mean(sev))
    s = sev.lower()
    if s == "lognormal":
        return math.exp(kw["mu"] + kw["sigma"] ** 2 / 2)
    if s == "exponential":
        return float(kw.get("theta", 1 / kw.get("rate", 1.0)))
    if s == "gamma":
        return float(kw["alpha"] * kw["theta"])
    if s == "pareto":
        return float(kw["theta"] / (kw["alpha"] - 1)) if kw["alpha"] > 1 else float("inf")
    if s == "weibull":
        return float(kw["scale"] * math.gamma(1 + 1 / kw["shape"]))
    raise ValueError(sev)


def _sample_freq(dist: str, kw: Dict[str, float], n: int, rng: np.random.Generator) -> np.ndarray:
    d = dist.lower()
    if d == "poisson":
        return rng.poisson(kw["lam"], n)
    if d in ("negbin", "nbinom", "negative-binomial"):
        return rng.negative_binomial(kw["r"], 1 / (1 + kw["beta"]), n)
    return rng.binomial(int(kw["m"]), kw["q"], n)


def _sample_sev(sev: Any, kw: Dict[str, float], n: int, rng: np.random.Generator) -> np.ndarray:
    if not isinstance(sev, str):
        return rng.choice(np.asarray(sev, dtype=float), size=n, replace=True)
    s = sev.lower()
    if s == "lognormal":
        return rng.lognormal(kw["mu"], kw["sigma"], n)
    if s == "exponential":
        return rng.exponential(kw.get("theta", 1 / kw.get("rate", 1.0)), n)
    if s == "gamma":
        return rng.gamma(kw["alpha"], kw["theta"], n)
    if s == "pareto":
        return kw["theta"] * ((1 - rng.random(n)) ** (-1 / kw["alpha"]) - 1)
    if s == "weibull":
        return kw["scale"] * rng.weibull(kw["shape"], n)
    raise ValueError(sev)


def simulate_losses(frequency: str = "poisson", severity: str = "lognormal", *, n_sims: int = 10_000, seed: Optional[int] = 42, **params: float) -> np.ndarray:
    """Simulated aggregate annual losses (array of length ``n_sims``)."""
    rng = np.random.default_rng(seed)
    fk = {k: v for k, v in params.items() if k in ("lam", "r", "beta", "m", "q")}
    sk = {k: v for k, v in params.items() if k in ("mu", "sigma", "alpha", "theta", "shape", "scale", "rate")}
    N = _sample_freq(frequency, fk, n_sims, rng)
    X = _sample_sev(severity, sk, int(N.sum()), rng)
    S = np.zeros(n_sims)
    np.add.at(S, np.repeat(np.arange(n_sims), N), X)
    return S


# ── distribution fitting ──────────────────────────────────────────────────

def lognormal_params(mean: float, sd: float) -> Tuple[float, float]:
    """(μ, σ) of the lognormal with the given mean and sd."""
    s2 = math.log(1 + (sd / mean) ** 2)
    return math.log(mean) - s2 / 2, math.sqrt(s2)


@tool
def fit(x: Sequence[float], dists: Sequence[str] = ("lognormal", "gamma", "pareto", "weibull", "exponential")) -> Table:
    """Maximum-likelihood fits of severity distributions to a positive sample, ranked by AIC (scipy when available, numpy fallback).

    Returns parameters in Loss-Models notation (lognormal μ σ, gamma α θ,
    pareto α θ, weibull shape scale, exponential θ) with log-likelihood,
    AIC and a Kolmogorov–Smirnov distance.
    """
    arr = np.asarray(pd.Series(x, dtype=float).dropna())
    arr = arr[arr > 0]
    n = arr.size
    if n < 5:
        raise ValueError("need at least 5 positive observations")
    rows = []
    for d in dists:
        try:
            params, ll = _mle(d, arr)
        except Exception as exc:  # pragma: no cover
            rows.append({"distribution": d, "params": f"failed: {exc}", "loglik": np.nan, "aic": np.nan, "ks": np.nan})
            continue
        k = len(params)
        cdf = _cdf(d, params)
        xs = np.sort(arr)
        F = cdf(xs)
        emp_hi = np.arange(1, n + 1) / n
        emp_lo = np.arange(0, n) / n
        ks = float(max(np.max(np.abs(emp_hi - F)), np.max(np.abs(F - emp_lo))))
        rows.append({"distribution": d, "params": ", ".join(f"{kk}={vv:.6g}" for kk, vv in params.items()), "loglik": ll, "aic": 2 * k - 2 * ll, "ks": ks, **{f"p_{kk}": vv for kk, vv in params.items()}})
    out = pd.DataFrame(rows).sort_values("aic").reset_index(drop=True)
    return Table(out, title=f"Severity fits · n = {n:,}", basis="maximum likelihood", stage="hard", notes=[
        "Ranked by AIC (lower is better); KS is the empirical-vs-fitted sup distance. Lognormal / exponential / pareto are closed-form MLEs; gamma and weibull are numerical.",
    ])


def _mle(dist: str, x: np.ndarray) -> Tuple[Dict[str, float], float]:
    n = x.size
    lx = np.log(x)
    if dist == "lognormal":
        mu, s = float(lx.mean()), float(lx.std(ddof=0))
        ll = float(np.sum(-lx - math.log(s * math.sqrt(2 * math.pi)) - (lx - mu) ** 2 / (2 * s * s)))
        return {"mu": mu, "sigma": s}, ll
    if dist == "exponential":
        th = float(x.mean())
        return {"theta": th}, float(-n * math.log(th) - x.sum() / th)
    if dist == "pareto":
        # Lomax (Pareto type II) with θ profiled over a grid around the data scale, α closed-form given θ
        best = None
        for th in np.geomspace(x.min() / 10, x.max() * 10, 200):
            a = n / np.sum(np.log1p(x / th))
            ll = float(n * math.log(a) + n * a * math.log(th) - (a + 1) * np.sum(np.log(x + th)))
            if best is None or ll > best[1]:
                best = ({"alpha": float(a), "theta": float(th)}, ll)
        return best  # type: ignore[return-value]
    if dist == "gamma":
        try:
            from scipy import stats  # type: ignore
            a, _, th = stats.gamma.fit(x, floc=0)
            ll = float(np.sum(stats.gamma.logpdf(x, a, scale=th)))
            return {"alpha": float(a), "theta": float(th)}, ll
        except ImportError:
            s = math.log(x.mean()) - lx.mean()
            a = (3 - s + math.sqrt((s - 3) ** 2 + 24 * s)) / (12 * s)
            for _ in range(50):  # Newton on the profile likelihood
                a = a - (math.log(a) - _digamma(a) - s) / (1 / a - _trigamma(a))
            th = x.mean() / a
            ll = float(np.sum((a - 1) * lx - x / th - a * math.log(th) - math.lgamma(a)))
            return {"alpha": float(a), "theta": float(th)}, ll
    if dist == "weibull":
        try:
            from scipy import stats  # type: ignore
            k, _, lam = stats.weibull_min.fit(x, floc=0)
            ll = float(np.sum(stats.weibull_min.logpdf(x, k, scale=lam)))
            return {"shape": float(k), "scale": float(lam)}, ll
        except ImportError:
            k = 1.0
            for _ in range(100):  # fixed-point iteration for the shape
                xk = x ** k
                g = np.sum(xk * lx) / np.sum(xk) - 1 / k - lx.mean()
                gp = (np.sum(xk * lx * lx) * np.sum(xk) - np.sum(xk * lx) ** 2) / np.sum(xk) ** 2 + 1 / k ** 2
                k_new = k - g / gp
                if abs(k_new - k) < 1e-10:
                    k = k_new
                    break
                k = max(k_new, 1e-3)
            lam = (np.sum(x ** k) / n) ** (1 / k)
            ll = float(np.sum(math.log(k) - k * math.log(lam) + (k - 1) * lx - (x / lam) ** k))
            return {"shape": float(k), "scale": float(lam)}, ll
    raise ValueError(f"unknown distribution {dist}")


def _digamma(a: float) -> float:
    r = 0.0
    while a < 6:
        r -= 1 / a
        a += 1
    f = 1 / (a * a)
    return r + math.log(a) - 0.5 / a - f * (1 / 12 - f * (1 / 120 - f * (1 / 252 - f * (1 / 240 - f / 132))))


def _trigamma(a: float) -> float:
    r = 0.0
    while a < 6:
        r += 1 / (a * a)
        a += 1
    f = 1 / (a * a)
    return r + 1 / a + f / 2 + f / a * (1 / 6 - f * (1 / 30 - f * (1 / 42 - f / 30)))


# ── credibility ───────────────────────────────────────────────────────────

@tool
def credibility(df: pd.DataFrame, group: Optional[str] = None, value: Optional[str] = None, weight: Optional[str] = None) -> Table:
    """Bühlmann–Straub credibility by group: Z = n/(n+K), K = EPV / VHM, credibility premium Z·x̄_g + (1 − Z)·μ.

    ``value`` is the per-record observation (loss ratio, claim count …),
    ``weight`` the exposure (1 when absent → plain Bühlmann). Groups with
    one record get Z from the collective K like the rest.
    """
    g = infer(df, "group", group)
    vcol = value or next((c for c in df.columns if c != g and pd.api.types.is_numeric_dtype(df[c]) and c != weight), None)
    if vcol is None:
        raise KeyError("pass value=<numeric column>")
    w = pd.to_numeric(df[weight], errors="coerce") if weight else pd.Series(1.0, index=df.index)
    x = pd.to_numeric(df[vcol], errors="coerce")
    d = pd.DataFrame({"g": df[g], "x": x, "w": w}).dropna()
    grp = d.groupby("g")
    m_g = grp.apply(lambda s: np.average(s["x"], weights=s["w"]), include_groups=False) if hasattr(pd.DataFrame, "groupby") else None
    w_g = grp["w"].sum()
    n_g = grp.size()
    mu = float(np.average(d["x"], weights=d["w"]))
    # EPV (within) and VHM (between), Bühlmann–Straub estimators
    within = 0.0
    dof = 0
    for key, s in grp:
        if len(s) > 1:
            within += float(np.sum(s["w"] * (s["x"] - m_g[key]) ** 2))
            dof += len(s) - 1
    epv = within / dof if dof > 0 else 0.0
    W = float(w_g.sum())
    between_num = float(np.sum(w_g * (m_g - mu) ** 2)) - epv * (len(w_g) - 1)
    between_den = W - float(np.sum(w_g ** 2)) / W
    vhm = max(between_num / between_den, 0.0) if between_den > 0 else 0.0
    K = epv / vhm if vhm > 0 else float("inf")
    Z = w_g / (w_g + K) if np.isfinite(K) else pd.Series(0.0, index=w_g.index)
    prem = Z * m_g + (1 - Z) * mu
    out = pd.DataFrame({"n": n_g, "weight": w_g, "mean": m_g, "Z": Z, "credibility_premium": prem}).sort_values("weight", ascending=False)
    out.index.name = g
    return Table(out, title=f"Bühlmann–Straub credibility · {vcol} by {g}", basis=f"μ {mu:.4g} · EPV {epv:.4g} · VHM {vhm:.4g} · K {K:.4g}", stage="hard", notes=[
        "Z = w/(w + K) with K = EPV/VHM; the credibility premium shrinks each group's mean toward the collective mean μ. VHM ≤ 0 gives K = ∞ and Z = 0: the groups are not distinguishable from noise.",
    ])


buhlmann = credibility


def limited_fluctuation(n: float, *, p: float = 0.9, k: float = 0.05, cv: Optional[float] = None, partial: bool = True) -> float:
    """Classical credibility: full-credibility standard n₀ = (z/k)²·(1 + cv²) claims; Z = min(1, √(n/n₀)) when ``partial``."""
    z = _norm_ppf((1 + p) / 2)
    n0 = (z / k) ** 2 * (1 + (cv or 0.0) ** 2)
    return min(1.0, math.sqrt(n / n0)) if partial else n0


def full_credibility(p: float = 0.9, k: float = 0.05, cv: Optional[float] = None) -> float:
    """Number of claims for full credibility at probability p within ±k (severity CV optional)."""
    return limited_fluctuation(0, p=p, k=k, cv=cv, partial=False)


def _norm_ppf(q: float) -> float:
    try:
        from scipy.stats import norm  # type: ignore
        return float(norm.ppf(q))
    except ImportError:  # Acklam's rational approximation
        a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
        b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01]
        c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
        d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]
        if q < 0.02425:
            t = math.sqrt(-2 * math.log(q))
            return (((((c[0] * t + c[1]) * t + c[2]) * t + c[3]) * t + c[4]) * t + c[5]) / ((((d[0] * t + d[1]) * t + d[2]) * t + d[3]) * t + 1)
        if q > 1 - 0.02425:
            t = math.sqrt(-2 * math.log(1 - q))
            return -(((((c[0] * t + c[1]) * t + c[2]) * t + c[3]) * t + c[4]) * t + c[5]) / ((((d[0] * t + d[1]) * t + d[2]) * t + d[3]) * t + 1)
        t = q - 0.5
        r = t * t
        return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * t / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)


# ── capital aggregation ───────────────────────────────────────────────────

SII_LIFE_CORR = pd.DataFrame(
    [[1, -0.25, 0.25, 0, 0.25, 0, 0.25],
     [-0.25, 1, 0, 0.25, 0.25, 0.25, 0],
     [0.25, 0, 1, 0, 0.5, 0, 0.25],
     [0, 0.25, 0, 1, 0.5, 0, 0.25],
     [0.25, 0.25, 0.5, 0.5, 1, 0.5, 0.25],
     [0, 0.25, 0, 0, 0.5, 1, 0],
     [0.25, 0, 0.25, 0.25, 0.25, 0, 1]],
    index=["mortality", "longevity", "disability", "lapse", "expense", "revision", "cat"],
    columns=["mortality", "longevity", "disability", "lapse", "expense", "revision", "cat"],
)
"""Solvency II standard-formula life underwriting correlation matrix (Delegated Regulation Annex IV)."""

SII_NONLIFE_CORR = pd.DataFrame([[1, 0, 0.25], [0, 1, 0.25], [0.25, 0.25, 1]], index=["premium_reserve", "lapse", "cat"], columns=["premium_reserve", "lapse", "cat"])
"""Solvency II non-life underwriting sub-module correlations."""

SII_BSCR_CORR = pd.DataFrame(
    [[1, 0.25, 0.25, 0.25, 0.25], [0.25, 1, 0.25, 0.25, 0.5], [0.25, 0.25, 1, 0.25, 0], [0.25, 0.25, 0.25, 1, 0], [0.25, 0.5, 0, 0, 1]],
    index=["market", "default", "life", "health", "non_life"], columns=["market", "default", "life", "health", "non_life"],
)
"""Solvency II BSCR top-level correlations (market, counterparty default, life, health, non-life)."""


@tool
def aggregate_scr(modules: Union[Dict[str, float], pd.Series], corr: Optional[pd.DataFrame] = None) -> Table:
    """Square-root aggregation SCR = √(vᵀ ρ v) of module capital charges with a correlation matrix (default: SII life).

    Modules absent from the matrix are treated as uncorrelated with the
    rest (ρ = 0); the table shows each module's charge, its marginal
    contribution (v_i · (ρv)_i / SCR) and the diversification benefit.
    """
    s = pd.Series(modules, dtype=float)
    rho = SII_LIFE_CORR if corr is None else corr
    names = list(s.index)
    R = pd.DataFrame(np.eye(len(names)), index=names, columns=names)
    for a in names:
        for b in names:
            if a in rho.index and b in rho.columns:
                R.loc[a, b] = rho.loc[a, b]
    vv = s.to_numpy()
    Rv = R.to_numpy() @ vv
    scr = math.sqrt(max(float(vv @ Rv), 0.0))
    contrib = vv * Rv / scr if scr > 0 else np.zeros_like(vv)
    out = pd.DataFrame({"charge": vv, "marginal": contrib, "share": contrib / scr if scr else np.nan}, index=names)
    out.loc["sum"] = [vv.sum(), np.nan, np.nan]
    out.loc["SCR"] = [scr, np.nan, np.nan]
    out.loc["diversification"] = [scr - vv.sum(), np.nan, np.nan]
    return Table(out, title="Capital aggregation", basis=("SII life correlation matrix" if corr is None else "given correlation matrix"), stage="hard", notes=[
        f"SCR = √(vᵀρv) = {scr:,.0f} vs undiversified sum {vv.sum():,.0f} ({(1 - scr / vv.sum()) if vv.sum() else 0:.1%} diversification). Marginal contributions (Euler) sum to the SCR.",
    ])


def risk_margin(scr: Sequence[float], rate: Union[float, Sequence[float]] = 0.04, coc: float = 0.06) -> float:
    """Cost-of-capital risk margin RM = CoC · Σ_t SCR_t · v^{t+1} for a projected SCR run-off (t = 0, 1, …), at a flat rate or a zero curve by year."""
    s = np.asarray(scr, dtype=float)
    t = np.arange(1, s.size + 1, dtype=float)
    z = np.full(s.size, float(rate)) if np.isscalar(rate) else np.asarray(rate, dtype=float)[: s.size]
    return float(coc * np.sum(s * (1 + z) ** -t))
