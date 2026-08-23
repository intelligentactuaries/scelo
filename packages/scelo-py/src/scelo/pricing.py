"""Pricing: GLMs, relativities, frequency / severity, loss ratios, lift.

``glm(df, "claims ~ C(region) + age", family="poisson", offset="exposure")``
fits with statsmodels when it is installed (the IDE's canonical engine) and
otherwise with a numpy IRLS that supports the same families and links, so a
pricing model runs on the bundled numpy + pandas alone. The formula is the
small subset actuaries use: ``y ~ a + C(b) + c``; ``C()`` marks a
categorical (first level is the base), numeric terms enter linearly.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

import numpy as np
import pandas as pd

from ._alias import infer
from ._audit import tool
from ._table import Table

__all__ = ["glm", "relativities", "freq_sev", "loss_ratio", "burning_cost", "lift", "gini", "GLMResult", "design_matrix", "rate_table"]


# ── formula → design matrix ───────────────────────────────────────────────

_TERM_RE = re.compile(r"^C\((.+)\)$")


def design_matrix(df: pd.DataFrame, formula: str, *, drop_first: bool = True) -> Tuple[pd.Series, pd.DataFrame, List[str]]:
    """Parse ``y ~ a + C(b) + c`` into (y, X with intercept, term names). Categoricals are one-hot with the first level dropped."""
    if "~" not in formula:
        raise ValueError('formula must look like "y ~ x1 + C(x2)"')
    lhs, rhs = (s.strip() for s in formula.split("~", 1))
    terms = [t.strip() for t in rhs.split("+") if t.strip() and t.strip() != "1"]
    y = pd.to_numeric(df[lhs], errors="coerce")
    cols: Dict[str, np.ndarray] = {"Intercept": np.ones(len(df))}
    names: List[str] = []
    for t in terms:
        m = _TERM_RE.match(t)
        is_cat = bool(m)
        name = m.group(1).strip() if m else t
        if name not in df.columns:
            raise KeyError(f"column {name!r} is not in the data")
        col = df[name]
        if is_cat or not pd.api.types.is_numeric_dtype(col) or pd.api.types.is_bool_dtype(col):
            levels = pd.Series(col.astype(str)).value_counts().index.tolist()
            levels = sorted(levels, key=lambda v: (-(col.astype(str) == v).sum(), v))  # most common level first = base
            for lv in (levels[1:] if drop_first else levels):
                cols[f"{name}[{lv}]"] = (col.astype(str) == lv).to_numpy(dtype=float)
            names.append(name)
        else:
            cols[name] = pd.to_numeric(col, errors="coerce").to_numpy(dtype=float)
            names.append(name)
    X = pd.DataFrame(cols, index=df.index)
    return y, X, names


# ── families ─────────────────────────────────────────────────────────────

_FAMILIES = {
    "poisson": {"link": "log", "var": lambda mu: mu, "dev": lambda y, mu: 2 * (np.where(y > 0, y * np.log(np.where(y > 0, y, 1) / mu), 0) - (y - mu))},
    "gamma": {"link": "log", "var": lambda mu: mu ** 2, "dev": lambda y, mu: 2 * (-np.log(y / mu) + (y - mu) / mu)},
    "gaussian": {"link": "identity", "var": lambda mu: np.ones_like(mu), "dev": lambda y, mu: (y - mu) ** 2},
    "binomial": {"link": "logit", "var": lambda mu: mu * (1 - mu), "dev": lambda y, mu: 2 * (np.where(y > 0, y * np.log(np.where(y > 0, y, 1) / mu), 0) + np.where(y < 1, (1 - y) * np.log(np.where(y < 1, 1 - y, 1) / (1 - mu)), 0))},
    "tweedie": {"link": "log", "var": None, "dev": None},
    "inverse_gaussian": {"link": "log", "var": lambda mu: mu ** 3, "dev": lambda y, mu: (y - mu) ** 2 / (mu ** 2 * y)},
}


def _link_funcs(link: str):
    if link == "log":
        return np.log, np.exp, lambda mu: 1 / mu
    if link == "identity":
        return (lambda x: x), (lambda x: x), (lambda mu: np.ones_like(mu))
    if link == "logit":
        return (lambda mu: np.log(mu / (1 - mu))), (lambda e: 1 / (1 + np.exp(-e))), (lambda mu: 1 / (mu * (1 - mu)))
    raise ValueError(f"unsupported link {link}")


@dataclass
class GLMResult:
    """A fitted GLM: coefficient table, deviance, AIC, fitted values; ``predict(df)`` and ``relativities()``."""

    family: str
    link: str
    formula: str
    coef: Table
    params: pd.Series
    cov: np.ndarray
    deviance: float
    null_deviance: float
    aic: Optional[float]
    n: int
    df_resid: int
    dispersion: float
    fitted: np.ndarray
    engine: str
    offset_col: Optional[str] = None
    weights_col: Optional[str] = None
    terms: List[str] = field(default_factory=list)
    power: Optional[float] = None

    def __repr__(self) -> str:  # pragma: no cover
        head = (f"GLM {self.family} ({self.link}) · {self.formula} · n = {self.n:,} · deviance {self.deviance:,.2f}"
                f" (null {self.null_deviance:,.2f}) · dispersion {self.dispersion:.4g}" + (f" · AIC {self.aic:,.1f}" if self.aic is not None else "") + f" · {self.engine}")
        return head + "\n" + repr(self.coef)

    def predict(self, df: pd.DataFrame, offset: Optional[Union[str, Sequence[float]]] = None) -> np.ndarray:
        """Predicted means for new data (offset column by name, or a sequence of exposures)."""
        _, X, _ = design_matrix(df.assign(**{self.formula.split("~")[0].strip(): 0}), self.formula)
        X = X.reindex(columns=self.params.index, fill_value=0.0)
        eta = X.to_numpy() @ self.params.to_numpy()
        off = offset if offset is not None else self.offset_col
        if off is not None:
            vals = pd.to_numeric(df[off], errors="coerce").to_numpy(dtype=float) if isinstance(off, str) else np.asarray(off, dtype=float)
            eta = eta + np.log(np.clip(vals, 1e-12, None))
        _, inv, _ = _link_funcs(self.link)
        return inv(eta)

    def relativities(self) -> Table:
        """exp(β) per level (log link): the rating relativities, base level = 1."""
        return relativities(self)

    def summary(self) -> Table:
        return self.coef


def _irls(y: np.ndarray, X: np.ndarray, family: str, link: str, offset: np.ndarray, weights: np.ndarray, power: float = 1.5,
          max_iter: int = 100, tol: float = 1e-9) -> Tuple[np.ndarray, np.ndarray, np.ndarray, int]:
    fam = _FAMILIES[family]
    var = fam["var"] if family != "tweedie" else (lambda mu: mu ** power)
    _, inv, dlink = _link_funcs(link)
    # starting values
    mu = np.clip(y + 0.1 * (y.mean() if y.mean() > 0 else 1), 1e-8, None) if link != "logit" else np.clip((y + 0.5) / 2, 1e-6, 1 - 1e-6)
    if link == "identity":
        mu = y.astype(float) + 0.0
    eta = (np.log(mu) if link == "log" else (np.log(mu / (1 - mu)) if link == "logit" else mu)) - offset
    beta = np.zeros(X.shape[1])
    for it in range(max_iter):
        d = dlink(mu)
        z = eta + (y - mu) * d
        w = weights / (var(mu) * d * d)
        WX = X * w[:, None]
        beta_new = np.linalg.solve(X.T @ WX + 1e-12 * np.eye(X.shape[1]), WX.T @ z)
        eta = X @ beta_new
        mu = inv(eta + offset)
        if link == "logit":
            mu = np.clip(mu, 1e-10, 1 - 1e-10)
        else:
            mu = np.clip(mu, 1e-12, None)
        if np.max(np.abs(beta_new - beta)) < tol * (1 + np.max(np.abs(beta_new))):
            beta = beta_new
            break
        beta = beta_new
    d = dlink(mu)
    w = weights / (var(mu) * d * d)
    cov_unscaled = np.linalg.inv(X.T @ (X * w[:, None]))
    return beta, mu, cov_unscaled, it + 1


@tool
def glm(df: pd.DataFrame, formula: str, family: str = "poisson", *, offset: Optional[str] = None, weights: Optional[str] = None,
        link: Optional[str] = None, power: float = 1.5, engine: str = "auto") -> GLMResult:
    """Fit a GLM: ``glm(df, "claims ~ C(region) + age", "poisson", offset="exposure")``.

    Families: poisson, gamma, gaussian, binomial, tweedie (``power``),
    inverse_gaussian; default links log / log / identity / logit / log /
    log. ``offset`` is a column entering as log(offset) (exposure);
    ``weights`` prior weights. ``engine``: auto (statsmodels if importable,
    else numpy), "statsmodels" or "numpy".
    """
    family = family.lower()
    if family not in _FAMILIES:
        raise ValueError(f"family must be one of {', '.join(_FAMILIES)}")
    link = link or _FAMILIES[family]["link"]
    y, X, terms = design_matrix(df, formula)
    keep = y.notna() & X.notna().all(axis=1)
    if offset:
        off_vals = pd.to_numeric(df[offset], errors="coerce")
        keep &= off_vals.notna() & (off_vals > 0)
    if weights:
        keep &= pd.to_numeric(df[weights], errors="coerce").notna()
    if family == "gamma" or family == "inverse_gaussian":
        keep &= y > 0
    y_ = y[keep].to_numpy(dtype=float)
    X_ = X[keep]
    n = int(keep.sum())
    if n < X_.shape[1] + 1:
        raise ValueError(f"only {n} usable rows for {X_.shape[1]} parameters")
    off = np.log(pd.to_numeric(df.loc[keep, offset], errors="coerce").to_numpy(dtype=float)) if offset else np.zeros(n)
    wts = pd.to_numeric(df.loc[keep, weights], errors="coerce").to_numpy(dtype=float) if weights else np.ones(n)
    use_sm = engine in ("auto", "statsmodels")
    if use_sm:
        try:
            import statsmodels.api as sm  # type: ignore
        except ImportError:
            if engine == "statsmodels":
                raise ImportError("statsmodels is not installed: pip install scelo[stats], or pass engine='numpy'")
            use_sm = False
    if use_sm:
        links = {"log": sm.families.links.Log(), "identity": sm.families.links.Identity(), "logit": sm.families.links.Logit()}
        fam_obj = {
            "poisson": lambda: sm.families.Poisson(links[link]), "gamma": lambda: sm.families.Gamma(links[link]),
            "gaussian": lambda: sm.families.Gaussian(links[link]), "binomial": lambda: sm.families.Binomial(links[link]),
            "tweedie": lambda: sm.families.Tweedie(links[link], var_power=power), "inverse_gaussian": lambda: sm.families.InverseGaussian(links[link]),
        }[family]()
        model = sm.GLM(y_, X_.to_numpy(), family=fam_obj, offset=off, freq_weights=wts)
        res = model.fit()
        params = pd.Series(res.params, index=X_.columns)
        se = np.asarray(res.bse)
        cov = np.asarray(res.cov_params())
        dev, null_dev = float(res.deviance), float(res.null_deviance)
        aic = float(res.aic) if np.isfinite(res.aic) else None
        disp = float(res.scale)
        fitted = np.asarray(res.fittedvalues)
        eng = f"statsmodels {getattr(__import__('statsmodels'), '__version__', '')}".strip()
        df_resid = int(res.df_resid)
    else:
        beta, mu, cov_u, iters = _irls(y_, X_.to_numpy(dtype=float), family, link, off, wts, power)
        fam = _FAMILIES[family]
        df_resid = n - X_.shape[1]
        if family == "tweedie":
            pearson = np.sum(wts * (y_ - mu) ** 2 / mu ** power)
            dev = float(np.sum(wts * 2 * (y_ ** (2 - power) / ((1 - power) * (2 - power)) - y_ * mu ** (1 - power) / (1 - power) + mu ** (2 - power) / (2 - power)))) if power not in (1, 2) else float("nan")
            mu0 = np.average(y_, weights=wts)
            null_dev = float(np.sum(wts * 2 * (y_ ** (2 - power) / ((1 - power) * (2 - power)) - y_ * mu0 ** (1 - power) / (1 - power) + mu0 ** (2 - power) / (2 - power)))) if power not in (1, 2) else float("nan")
        else:
            pearson = np.sum(wts * (y_ - mu) ** 2 / fam["var"](mu))
            dev = float(np.sum(wts * fam["dev"](y_, mu)))
            mu0 = np.full_like(mu, np.average(y_, weights=wts))
            if offset:
                mu0 = np.exp(off + math.log(np.sum(wts * y_) / np.sum(wts * np.exp(off)))) if link == "log" else mu0
            null_dev = float(np.sum(wts * fam["dev"](y_, mu0)))
        disp = 1.0 if family in ("poisson", "binomial") else float(pearson / df_resid)
        cov = cov_u * disp
        se = np.sqrt(np.diag(cov))
        params = pd.Series(beta, index=X_.columns)
        fitted = mu
        aic = None
        if family == "poisson":
            ll = float(np.sum(wts * (y_ * np.log(mu) - mu - np.array([math.lgamma(v + 1) for v in y_]))))
            aic = 2 * X_.shape[1] - 2 * ll
        elif family == "gaussian":
            s2 = dev / n
            ll = -n / 2 * (math.log(2 * math.pi * s2) + 1)
            aic = 2 * (X_.shape[1] + 1) - 2 * ll
        elif family == "binomial":
            ll = float(np.sum(wts * (y_ * np.log(mu) + (1 - y_) * np.log(1 - mu))))
            aic = 2 * X_.shape[1] - 2 * ll
        elif family == "gamma":
            a = 1 / disp
            ll = float(np.sum(wts * (a * np.log(a * y_ / mu) - a * y_ / mu - np.log(y_) - math.lgamma(a))))
            aic = 2 * (X_.shape[1] + 1) - 2 * ll
        eng = f"numpy IRLS ({iters} iterations)"
    z = params.to_numpy() / np.where(se > 0, se, np.nan)
    pval = 2 * (1 - _norm_cdf(np.abs(z)))
    coef = pd.DataFrame({"term": params.index, "estimate": params.to_numpy(), "std_err": se, "z": z, "p_value": pval})
    if link == "log":
        coef["exp"] = np.exp(coef["estimate"])
    t = Table(coef, title=f"GLM · {family} · {formula}", basis=f"{family} / {link} · {eng}" + (f" · offset log({offset})" if offset else ""), stage="hard", notes=[
        f"n = {n:,}, deviance {dev:,.2f} on {df_resid} df (null {null_dev:,.2f}), dispersion {disp:.4g}" + (f", AIC {aic:,.1f}" if aic is not None else "") + ".",
        "Categorical base levels are the most frequent level; with a log link, exp(estimate) is the multiplicative relativity.",
    ])
    return GLMResult(family, link, formula, t, params, cov, dev, null_dev, aic, n, df_resid, disp, fitted, eng, offset, weights, terms, power if family == "tweedie" else None)


def _norm_cdf(z: np.ndarray) -> np.ndarray:
    try:
        from scipy.special import ndtr  # type: ignore
        return ndtr(z)
    except ImportError:
        return 0.5 * (1 + np.vectorize(math.erf)(z / math.sqrt(2)))


def relativities(model: GLMResult) -> Table:
    """Rating relativities from a log-link GLM: exp(β) per categorical level (base = 1) and per unit of each numeric term."""
    if model.link != "log":
        raise ValueError("relativities need a log link")
    rows = []
    for term in model.terms:
        levels = [(k, v) for k, v in model.params.items() if str(k).startswith(f"{term}[")]
        if levels:
            rows.append({"factor": term, "level": "(base)", "relativity": 1.0, "estimate": 0.0})
            for k, v in levels:
                rows.append({"factor": term, "level": str(k)[len(term) + 1:-1], "relativity": math.exp(v), "estimate": v})
        elif term in model.params.index:
            rows.append({"factor": term, "level": "per unit", "relativity": math.exp(model.params[term]), "estimate": model.params[term]})
    base = math.exp(model.params["Intercept"])
    t = Table(pd.DataFrame(rows), title=f"Relativities · {model.formula}", basis=f"base rate exp(intercept) = {base:.6g}", stage="hard",
              notes=["Multiply the base rate by one relativity per factor; the base level of each factor is its most frequent level."])
    t.attrs["base_rate"] = base
    return t


@tool
def freq_sev(df: pd.DataFrame, by: Optional[Union[str, Sequence[str]]] = None, *, count: Optional[str] = None, amount: Optional[str] = None,
             exposure: Optional[str] = None) -> Table:
    """Frequency × severity summary by group: exposure, claims, frequency, severity (mean positive amount), pure premium."""
    c = infer(df, "count", count, required=False)
    a = infer(df, "value", amount, required=False)
    e = infer(df, "exposure", exposure, required=False)
    if a is None and c is None:
        raise KeyError("need a claim count and/or amount column")
    keys = [by] if isinstance(by, str) else (list(by) if by else [])
    work = pd.DataFrame(index=df.index)
    for k in keys:
        work[k] = df[k]
    work["exposure"] = pd.to_numeric(df[e], errors="coerce") if e else 1.0
    work["claims"] = pd.to_numeric(df[c], errors="coerce") if c else (pd.to_numeric(df[a], errors="coerce") > 0).astype(float)
    work["amount"] = pd.to_numeric(df[a], errors="coerce") if a else np.nan
    g = work.groupby(keys) if keys else work.assign(_all="all").groupby("_all")
    out = g.agg(exposure=("exposure", "sum"), claims=("claims", "sum"), amount=("amount", "sum")).reset_index()
    out["frequency"] = out["claims"] / out["exposure"]
    out["severity"] = np.where(out["claims"] > 0, out["amount"] / out["claims"], np.nan)
    out["pure_premium"] = out["amount"] / out["exposure"]
    if keys:
        tot = {k: "total" for k in keys}
        tot.update(exposure=out["exposure"].sum(), claims=out["claims"].sum(), amount=out["amount"].sum())
        tot["frequency"] = tot["claims"] / tot["exposure"]
        tot["severity"] = tot["amount"] / tot["claims"] if tot["claims"] else np.nan
        tot["pure_premium"] = tot["amount"] / tot["exposure"]
        out = pd.concat([out, pd.DataFrame([tot])], ignore_index=True)
    return Table(out.drop(columns=["_all"], errors="ignore"), title="Frequency × severity" + (f" by {', '.join(keys)}" if keys else ""), stage="hard",
                 notes=["frequency = claims / exposure; severity = amount / claims; pure premium = amount / exposure = frequency × severity."])


@tool
def loss_ratio(df: pd.DataFrame, by: Optional[Union[str, Sequence[str]]] = None, *, loss: Optional[str] = None, premium: Optional[str] = None) -> Table:
    """Loss ratio (Σ loss / Σ premium) by group with a total row."""
    lcol = infer(df, "value", loss)
    pcol = infer(df, "premium", premium, exclude=[lcol])
    keys = [by] if isinstance(by, str) else (list(by) if by else [])
    work = pd.DataFrame({k: df[k] for k in keys}, index=df.index)
    work["loss"] = pd.to_numeric(df[lcol], errors="coerce")
    work["premium"] = pd.to_numeric(df[pcol], errors="coerce")
    g = (work.groupby(keys) if keys else work.assign(_all="all").groupby("_all"))
    out = g[["loss", "premium"]].sum().reset_index()
    out["loss_ratio"] = out["loss"] / out["premium"]
    if keys:
        tot = {k: "total" for k in keys}
        tot.update(loss=out["loss"].sum(), premium=out["premium"].sum())
        tot["loss_ratio"] = tot["loss"] / tot["premium"]
        out = pd.concat([out, pd.DataFrame([tot])], ignore_index=True)
    return Table(out.drop(columns=["_all"], errors="ignore"), title="Loss ratio" + (f" by {', '.join(keys)}" if keys else ""), stage="hard")


def burning_cost(df: pd.DataFrame, *, loss: Optional[str] = None, exposure: Optional[str] = None, trend: float = 0.0, years: Optional[str] = None,
                 to_year: Optional[int] = None) -> float:
    """Burning cost = Σ trended losses / Σ exposure (losses trended at ``trend`` p.a. from ``years`` to ``to_year``)."""
    lcol = infer(df, "value", loss)
    ecol = infer(df, "exposure", exposure, exclude=[lcol])
    L = pd.to_numeric(df[lcol], errors="coerce").fillna(0)
    if years and trend:
        yrs = pd.to_numeric(df[years], errors="coerce")
        target = to_year or int(yrs.max())
        L = L * (1 + trend) ** (target - yrs)
    return float(L.sum() / pd.to_numeric(df[ecol], errors="coerce").sum())


@tool
def lift(actual: Sequence[float], predicted: Sequence[float], bins: int = 10, exposure: Optional[Sequence[float]] = None) -> Table:
    """Lift chart: sort by prediction into ``bins`` equal-exposure bands, compare mean actual vs mean predicted per band."""
    a = np.asarray(actual, dtype=float)
    p = np.asarray(predicted, dtype=float)
    w = np.ones_like(a) if exposure is None else np.asarray(exposure, dtype=float)
    order = np.argsort(p)
    cw = np.cumsum(w[order]) / w.sum()
    band = np.minimum((cw * bins).astype(int), bins - 1)
    rows = []
    for b in range(bins):
        m = band == b
        if not m.any():
            continue
        idx = order[m]
        rows.append({"band": b + 1, "exposure": w[idx].sum(), "actual": np.average(a[idx], weights=w[idx]), "predicted": np.average(p[idx], weights=w[idx])})
    out = pd.DataFrame(rows)
    out["lift"] = out["actual"] / (np.average(a, weights=w))
    out["a/e"] = out["actual"] / out["predicted"]
    g = gini(a, p, w)
    return Table(out, title=f"Lift · {bins} bands", basis=f"Gini {g:.3f}", stage="hard", notes=[
        "Bands are equal-exposure deciles of the prediction; a/e near 1 across bands means the model is calibrated, a rising `actual` means it discriminates.",
    ])


def gini(actual: Sequence[float], predicted: Sequence[float], exposure: Optional[Sequence[float]] = None) -> float:
    """Exposure-weighted Gini coefficient of the prediction's ordering of the actuals (0 = no discrimination)."""
    a = np.asarray(actual, dtype=float)
    p = np.asarray(predicted, dtype=float)
    w = np.ones_like(a) if exposure is None else np.asarray(exposure, dtype=float)
    order = np.argsort(p)
    a, w = a[order], w[order]
    cum_w = np.cumsum(w) / w.sum()
    cum_a = np.cumsum(a * w) / np.sum(a * w)
    area = np.trapezoid(cum_a, cum_w) if hasattr(np, "trapezoid") else np.trapz(cum_a, cum_w)
    return float(1 - 2 * area)


def rate_table(model: GLMResult, base: Optional[float] = None) -> pd.DataFrame:
    """Wide rating table: one column per factor, relativity per level (convenience view of :func:`relativities`)."""
    r = relativities(model)
    return r.pivot_table(index="level", columns="factor", values="relativity", aggfunc="first")
