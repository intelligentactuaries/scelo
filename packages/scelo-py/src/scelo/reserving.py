"""Reserving: triangles and the classical reserving methods, in numpy.

``triangle(df)`` builds an origin × development triangle from a claims file
(columns inferred: origin / development or payment period / amount), exactly
as Scelo IDE's run-off table does. ``chain_ladder``, ``mack``, ``bf``,
``cape_cod`` and ``bootstrap`` then work on the triangle, and ``reserve(df)``
runs the lot in one line.

The engine indexes purely by development *period*, like the IDE's numpy
bridge (apps/web/src/components/Scelo/bridges/chainladderPython.ts): it does
not infer development from calendar dates, so a development-truncated
parallelogram does not grow phantom origins. Mack's standard error is the
full 1993 formula including the inter-origin covariance term; the bootstrap
is the over-dispersed Poisson (England & Verrall) with gamma process error.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

import numpy as np
import pandas as pd

from ._alias import infer
from ._audit import tool
from ._table import Table

__all__ = [
    "triangle", "to_incremental", "to_cumulative", "is_cumulative", "latest_diagonal", "ata", "ldf", "cdf",
    "chain_ladder", "mack", "bf", "cape_cod", "bootstrap", "tail", "reserve", "ReservingResult", "from_wide",
]


# ── triangle construction ───────────────────────────────────────────────────

def _period(v: Any) -> Optional[int]:
    if v is None:
        return None
    if isinstance(v, (int, np.integer)):
        return int(v)
    if isinstance(v, (float, np.floating)):
        return None if np.isnan(v) else int(round(v))
    if isinstance(v, (pd.Timestamp, np.datetime64)):
        return int(pd.Timestamp(v).year)
    s = str(v).strip()
    try:
        return int(round(float(s)))
    except ValueError:
        pass
    return int(s[:4]) if len(s) >= 4 and s[:4].isdigit() else None


@tool
def triangle(
    df: pd.DataFrame,
    origin: Optional[str] = None,
    dev: Optional[str] = None,
    value: Optional[str] = None,
    *,
    payment: Optional[str] = None,
    cumulative: bool = True,
    incremental_input: bool = True,
) -> Table:
    """Origin × development triangle from a long claims file (columns inferred when not given).

    Rows are summed per (origin, lag). ``dev`` is an integer lag column; or
    give ``payment`` (a calendar period) and lag = payment − origin. Input
    rows are INCREMENTAL amounts by default and are accumulated along
    development (``cumulative=True``); pass ``incremental_input=False`` when
    the file already holds cumulative figures. Cells beyond the latest
    observed diagonal are NaN.
    """
    if isinstance(df, pd.DataFrame) and getattr(df, "attrs", {}).get("scelo_triangle"):
        return df  # already a triangle
    o = infer(df, "origin", origin)
    v = infer(df, "value", value, exclude=[o])
    d = None
    if dev is not None or payment is None:
        d = infer(df, "development", dev, required=False, exclude=[o, v])
    p = None
    if d is None:
        p = infer(df, "payment", payment, required=False, exclude=[o, v])
        if p is None:
            raise KeyError("need a development-lag column (dev=) or a payment-period column (payment=)")
    origins = df[o].map(_period)
    vals = pd.to_numeric(df[v], errors="coerce")
    if d is not None:
        lags = pd.to_numeric(df[d], errors="coerce").round()
    else:
        lags = df[p].map(_period) - origins
    keep = origins.notna() & vals.notna() & lags.notna() & (lags >= 0)
    skipped = int((~keep).sum())
    g = pd.DataFrame({"origin": origins[keep].astype(int), "dev": lags[keep].astype(int), "v": vals[keep]})
    if g.empty:
        raise ValueError("no (origin, development, value) triples could be read")
    wide = g.pivot_table(index="origin", columns="dev", values="v", aggfunc="sum")
    wide = wide.reindex(columns=range(int(wide.columns.min()), int(wide.columns.max()) + 1))
    # Fill inside the observed region with 0 (no claims that period), leave the future NaN.
    latest = int((g["origin"] + g["dev"]).max())
    arr = wide.to_numpy(dtype=float)
    for i, orig in enumerate(wide.index):
        for j, lag in enumerate(wide.columns):
            if orig + int(lag) <= latest and np.isnan(arr[i, j]):
                arr[i, j] = 0.0
    if incremental_input and cumulative:
        arr = _cumulate(arr)
    elif not incremental_input and not cumulative:
        arr = _decumulate(arr)
    out = pd.DataFrame(arr, index=wide.index.rename("origin"), columns=[int(c) for c in wide.columns])
    out.columns.name = "dev"
    t = Table(out, title=f"{'Cumulative' if cumulative else 'Incremental'} triangle · {v} by {o} × development", stage="hard",
              basis=f"{v} · {o} × dev")
    t.attrs["scelo_triangle"] = True
    t.attrs["cumulative"] = cumulative
    t.notes.append(
        f"{len(out)} origin periods × {out.shape[1]} development lags, summed from {len(df):,} rows"
        + (f" ({skipped} rows skipped: unreadable origin / lag / value)" if skipped else "")
        + f". Input rows treated as {'incremental' if incremental_input else 'cumulative'} amounts."
    )
    t.notes.append(f"Development lag = {p} − {o}." if p else f"Development lag read from `{d}`.")
    return t


def from_wide(data: Union[pd.DataFrame, np.ndarray, Sequence[Sequence[float]]], origins: Optional[Sequence[Any]] = None,
              cumulative: bool = True) -> Table:
    """Wrap an already-wide triangle (rows = origins, columns = development lags 0..n−1) as a Scelo triangle."""
    if isinstance(data, pd.DataFrame):
        df = data.copy()
        df.columns = [int(c) if str(c).lstrip("dev ").strip().isdigit() else c for c in df.columns]
        if not all(isinstance(c, int) for c in df.columns):
            df.columns = list(range(df.shape[1]))
    else:
        arr = np.asarray(data, dtype=float)
        df = pd.DataFrame(arr, index=list(origins) if origins is not None else list(range(arr.shape[0])), columns=list(range(arr.shape[1])))
    df.index.name = "origin"
    df.columns.name = "dev"
    t = Table(df, title=f"{'Cumulative' if cumulative else 'Incremental'} triangle", stage="hard")
    t.attrs["scelo_triangle"] = True
    t.attrs["cumulative"] = cumulative
    return t


def _cumulate(arr: np.ndarray) -> np.ndarray:
    out = arr.copy()
    for i in range(out.shape[0]):
        acc = 0.0
        for j in range(out.shape[1]):
            if np.isnan(out[i, j]):
                continue
            acc += out[i, j]
            out[i, j] = acc
    return out


def _decumulate(arr: np.ndarray) -> np.ndarray:
    out = arr.copy()
    for i in range(out.shape[0]):
        prev = 0.0
        for j in range(out.shape[1]):
            if np.isnan(out[i, j]):
                continue
            cur = out[i, j]
            out[i, j] = cur - prev
            prev = cur
    return out


def _as_array(tri: Union[pd.DataFrame, np.ndarray]) -> Tuple[np.ndarray, List[Any], List[Any]]:
    if isinstance(tri, pd.DataFrame):
        return tri.to_numpy(dtype=float), list(tri.index), list(tri.columns)
    arr = np.asarray(tri, dtype=float)
    return arr, list(range(arr.shape[0])), list(range(arr.shape[1]))


def is_cumulative(tri: pd.DataFrame) -> bool:
    """True when the triangle is cumulative (by its attrs, else by never-decreasing rows)."""
    if getattr(tri, "attrs", {}).get("scelo_triangle"):
        return bool(tri.attrs.get("cumulative", True))
    arr, _, _ = _as_array(tri)
    d = np.diff(arr, axis=1)
    return bool(np.nanmin(d) >= 0) if d.size else True


def to_incremental(tri: pd.DataFrame) -> Table:
    """Cumulative → incremental."""
    if not is_cumulative(tri):
        return tri
    arr, idx, cols = _as_array(tri)
    t = Table(pd.DataFrame(_decumulate(arr), index=idx, columns=cols), title="Incremental triangle", stage="hard")
    t.index.name, t.columns.name = "origin", "dev"
    t.attrs.update(scelo_triangle=True, cumulative=False)
    return t


def to_cumulative(tri: pd.DataFrame) -> Table:
    """Incremental → cumulative."""
    if is_cumulative(tri):
        return tri
    arr, idx, cols = _as_array(tri)
    t = Table(pd.DataFrame(_cumulate(arr), index=idx, columns=cols), title="Cumulative triangle", stage="hard")
    t.index.name, t.columns.name = "origin", "dev"
    t.attrs.update(scelo_triangle=True, cumulative=True)
    return t


def _cum(tri: pd.DataFrame) -> np.ndarray:
    arr, _, _ = _as_array(tri)
    return arr if is_cumulative(tri) else _cumulate(arr)


def latest_diagonal(tri: pd.DataFrame) -> pd.Series:
    """Latest cumulative value per origin (the paid-to-date)."""
    C = _cum(tri)
    idx = list(tri.index) if isinstance(tri, pd.DataFrame) else list(range(C.shape[0]))
    latest = []
    for i in range(C.shape[0]):
        row = np.where(np.isfinite(C[i]))[0]
        latest.append(C[i, row[-1]] if row.size else np.nan)
    return pd.Series(latest, index=idx, name="latest")


# ── development factors ─────────────────────────────────────────────────────

def _factors(C: np.ndarray, average: str = "volume", n_periods: Optional[int] = None) -> Dict[str, np.ndarray]:
    """Age-to-age factors with Mack's σ² and the column volumes S_k."""
    n_o, n_d = C.shape
    f = np.ones(n_d - 1)
    sig2 = np.zeros(n_d - 1)
    S = np.zeros(n_d - 1)
    nk = np.zeros(n_d - 1, dtype=int)
    for k in range(n_d - 1):
        obs = []
        for i in range(n_o):
            ck, ck1 = C[i, k], C[i, k + 1]
            if not (np.isfinite(ck) and np.isfinite(ck1)) or ck == 0:
                continue
            obs.append((ck, ck1))
        if n_periods is not None and len(obs) > n_periods:
            obs = obs[-n_periods:]
        if not obs:
            continue
        a = np.array([o[0] for o in obs])
        b = np.array([o[1] for o in obs])
        if average == "simple":
            f[k] = float(np.mean(b / a))
        elif average == "regression":
            f[k] = float(np.sum(a * b) / np.sum(a * a))
        else:  # volume-weighted
            f[k] = float(b.sum() / a.sum())
        S[k] = a.sum()
        nk[k] = len(obs)
        if len(obs) >= 2:
            sig2[k] = float(np.sum(a * (b / a - f[k]) ** 2) / (len(obs) - 1))
    # Mack's tail σ² convention for the last factor when it has < 2 observations
    for k in range(n_d - 1):
        if nk[k] < 2:
            if k >= 2 and sig2[k - 2] > 0:
                sig2[k] = min(sig2[k - 1] ** 2 / sig2[k - 2], sig2[k - 2], sig2[k - 1])
            elif k >= 1:
                sig2[k] = sig2[k - 1]
    return {"f": f, "sigma2": sig2, "S": S, "n": nk}


def ata(tri: pd.DataFrame) -> Table:
    """Age-to-age factor table: one row per origin, plus the volume-weighted and simple averages."""
    C = _cum(tri)
    idx = list(tri.index) if isinstance(tri, pd.DataFrame) else list(range(C.shape[0]))
    cols = list(tri.columns) if isinstance(tri, pd.DataFrame) else list(range(C.shape[1]))
    n_o, n_d = C.shape
    rows = {}
    for i in range(n_o):
        rows[idx[i]] = [C[i, k + 1] / C[i, k] if np.isfinite(C[i, k]) and np.isfinite(C[i, k + 1]) and C[i, k] != 0 else np.nan for k in range(n_d - 1)]
    names = [f"{cols[k]}→{cols[k + 1]}" for k in range(n_d - 1)]
    out = pd.DataFrame.from_dict(rows, orient="index", columns=names)
    out.loc["volume-weighted"] = _factors(C, "volume")["f"]
    out.loc["simple average"] = _factors(C, "simple")["f"]
    return Table(out, title="Age-to-age factors", stage="hard")


def ldf(tri: pd.DataFrame, average: str = "volume", n_periods: Optional[int] = None, tail_factor: float = 1.0) -> pd.Series:
    """Selected link ratios f_k (``average`` = volume / simple / regression; ``n_periods`` = latest n only) with a tail."""
    C = _cum(tri)
    cols = list(tri.columns) if isinstance(tri, pd.DataFrame) else list(range(C.shape[1]))
    f = _factors(C, average, n_periods)["f"]
    names = [f"{cols[k]}→{cols[k + 1]}" for k in range(len(f))] + ["tail"]
    return pd.Series(np.append(f, tail_factor), index=names, name="ldf")


def cdf(tri: pd.DataFrame, average: str = "volume", n_periods: Optional[int] = None, tail_factor: float = 1.0) -> pd.Series:
    """Cumulative development factors to ultimate, one per development lag."""
    f = ldf(tri, average, n_periods, tail_factor).to_numpy()
    c = np.cumprod(f[::-1])[::-1]
    cols = list(tri.columns) if isinstance(tri, pd.DataFrame) else list(range(len(f)))
    return pd.Series(c, index=cols[: len(c)], name="cdf")


# ── result type ─────────────────────────────────────────────────────────────

@dataclass
class ReservingResult:
    """Output of a reserving method: per-origin table plus totals. Prints as the reserve table."""

    method: str
    table: Table
    ibnr: float
    ultimate: float
    latest: float
    factors: np.ndarray = field(default_factory=lambda: np.array([]))
    cdf: np.ndarray = field(default_factory=lambda: np.array([]))
    se: Optional[float] = None
    cv: Optional[float] = None
    detail: Dict[str, Any] = field(default_factory=dict)

    def __repr__(self) -> str:  # pragma: no cover - presentation
        head = f"{self.method}: IBNR {self.ibnr:,.0f} · ultimate {self.ultimate:,.0f} · latest {self.latest:,.0f}"
        if self.se is not None:
            head += f" · SE {self.se:,.0f} (CV {self.cv:.1%})"
        return head + "\n" + repr(self.table)

    def _repr_html_(self) -> Optional[str]:  # pragma: no cover
        return self.table._repr_html_()

    @property
    def reserve(self) -> float:
        return self.ibnr

    def summary(self) -> pd.Series:
        s = {"method": self.method, "latest": self.latest, "ultimate": self.ultimate, "ibnr": self.ibnr}
        if self.se is not None:
            s.update(se=self.se, cv=self.cv)
        return pd.Series(s)


def _project(C: np.ndarray, f: np.ndarray, tail_factor: float = 1.0) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Latest, last-k, cdf and ultimate per origin under factors f (with tail)."""
    n_o, n_d = C.shape
    cdf_ = np.cumprod(np.append(f, tail_factor)[::-1])[::-1]  # length n_d
    latest = np.full(n_o, np.nan)
    last_k = np.zeros(n_o, dtype=int)
    for i in range(n_o):
        fin = np.where(np.isfinite(C[i]))[0]
        if fin.size:
            last_k[i] = fin[-1]
            latest[i] = C[i, fin[-1]]
    ult = latest * cdf_[last_k]
    return latest, last_k, cdf_, ult


def _table(idx: List[Any], latest: np.ndarray, ult: np.ndarray, extra: Optional[Dict[str, np.ndarray]] = None,
           last_k: Optional[np.ndarray] = None, cdf_: Optional[np.ndarray] = None) -> pd.DataFrame:
    out = pd.DataFrame({"latest": latest, "ultimate": ult, "ibnr": ult - latest}, index=pd.Index(idx, name="origin"))
    if last_k is not None and cdf_ is not None:
        out.insert(1, "cdf", cdf_[last_k])
        out.insert(2, "pct_developed", 1 / cdf_[last_k])
    if extra:
        for k, v in extra.items():
            out[k] = v
    total = out.sum(numeric_only=True)
    for c in ("cdf", "pct_developed"):
        if c in out.columns:
            total[c] = np.nan
    out.loc["total"] = total
    return out


# ── methods ─────────────────────────────────────────────────────────────────

@tool
def chain_ladder(tri: pd.DataFrame, average: str = "volume", n_periods: Optional[int] = None, tail_factor: float = 1.0) -> ReservingResult:
    """Chain ladder: volume-weighted link ratios, CDF to ultimate, IBNR = ultimate − latest."""
    tri = triangle(tri) if not getattr(tri, "attrs", {}).get("scelo_triangle") and _looks_long(tri) else tri
    C = _cum(tri)
    idx = list(tri.index) if isinstance(tri, pd.DataFrame) else list(range(C.shape[0]))
    fx = _factors(C, average, n_periods)
    latest, last_k, cdf_, ult = _project(C, fx["f"], tail_factor)
    table = Table(_table(idx, latest, ult, last_k=last_k, cdf_=cdf_), title="Chain ladder", stage="hard",
                  basis=f"{average}-weighted link ratios" + (f" · last {n_periods}" if n_periods else "") + (f" · tail {tail_factor}" if tail_factor != 1 else ""))
    table.notes.append("f_k = Σ C(o,k+1) / Σ C(o,k) over origins with both cells; CDF_k = Π f_j (j ≥ k); ultimate = latest × CDF.")
    return ReservingResult("chain-ladder", table, float(np.nansum(ult - latest)), float(np.nansum(ult)), float(np.nansum(latest)),
                           fx["f"], cdf_, detail={"sigma2": fx["sigma2"], "S": fx["S"]})


@tool
def mack(tri: pd.DataFrame, average: str = "volume", tail_factor: float = 1.0) -> ReservingResult:
    """Mack (1993) chain ladder: the CL point estimate with the full MSE (process + parameter, inter-origin covariance).

    σ̂²_k = Σ C(o,k)(C(o,k+1)/C(o,k) − f̂_k)² / (n_k − 1); the last σ² uses Mack's
    extrapolation min(σ⁴_{k−1}/σ²_{k−2}, σ²_{k−2}, σ²_{k−1}). Per-origin MSE
    and the total with the covariance term; SE = √MSE, CV = SE / IBNR.
    """
    tri = triangle(tri) if not getattr(tri, "attrs", {}).get("scelo_triangle") and _looks_long(tri) else tri
    C = _cum(tri)
    idx = list(tri.index) if isinstance(tri, pd.DataFrame) else list(range(C.shape[0]))
    n_o, n_d = C.shape
    fx = _factors(C, average)
    f, sig2, S = fx["f"], fx["sigma2"], fx["S"]
    latest, last_k, cdf_, ult = _project(C, f, tail_factor)
    # completed triangle Ĉ
    Chat = C.copy()
    for i in range(n_o):
        for k in range(last_k[i] + 1, n_d):
            Chat[i, k] = Chat[i, k - 1] * f[k - 1]
    mse_i = np.zeros(n_o)
    for i in range(n_o):
        acc = 0.0
        for k in range(last_k[i], n_d - 1):
            if f[k] == 0 or S[k] <= 0 or not np.isfinite(Chat[i, k]) or Chat[i, k] == 0:
                continue
            acc += (sig2[k] / f[k] ** 2) * (1 / Chat[i, k] + 1 / S[k])
        mse_i[i] = ult[i] ** 2 * acc if np.isfinite(ult[i]) else 0.0
    total = float(mse_i.sum())
    for i in range(n_o):
        for j in range(i + 1, n_o):
            kk = max(last_k[i], last_k[j])
            acc = 0.0
            for k in range(kk, n_d - 1):
                if f[k] == 0 or S[k] <= 0:
                    continue
                acc += (sig2[k] / f[k] ** 2) / S[k]
            if np.isfinite(ult[i]) and np.isfinite(ult[j]):
                total += 2 * ult[i] * ult[j] * acc
    ibnr = float(np.nansum(ult - latest))
    se = math.sqrt(max(total, 0.0))
    se_i = np.sqrt(np.maximum(mse_i, 0))
    res_i = ult - latest
    with np.errstate(divide="ignore", invalid="ignore"):
        cv_i = np.where(res_i > 0, se_i / np.where(res_i > 0, res_i, 1), np.nan)
    table = Table(_table(idx, latest, ult, {"se": se_i, "cv": cv_i}, last_k, cdf_),
                  title="Mack chain ladder", stage="hard", basis=f"{average}-weighted link ratios · Mack (1993) MSE")
    table.loc["total", "se"] = se
    table.loc["total", "cv"] = se / ibnr if ibnr else np.nan
    table.notes.append("SE is the square root of Mack's MSE: process + estimation error per origin, plus the inter-origin covariance in the total. ±1.96·SE is a normal-approximation interval, not a tail quantile.")
    return ReservingResult("mack", table, ibnr, float(np.nansum(ult)), float(np.nansum(latest)), f, cdf_, se=se,
                           cv=(se / ibnr if ibnr else None), detail={"sigma2": sig2, "S": S, "mse_by_origin": mse_i})


@tool
def bf(tri: pd.DataFrame, apriori: Union[None, float, Sequence[float], pd.Series, ReservingResult] = None,
       premium: Union[None, Sequence[float], pd.Series] = None, elr: Optional[float] = None,
       average: str = "volume", tail_factor: float = 1.0) -> ReservingResult:
    """Bornhuetter–Ferguson: reserve = a-priori ultimate × (1 − 1/CDF).

    The a-priori ultimate per origin comes from, in order: ``apriori`` (a
    number, a per-origin sequence, or a chain-ladder result whose ultimates
    seed it), ``premium × elr``, or the book-average chain-ladder ultimate
    (the IDE's standalone default: a flat ELR would cancel back to CL).
    """
    tri = triangle(tri) if not getattr(tri, "attrs", {}).get("scelo_triangle") and _looks_long(tri) else tri
    C = _cum(tri)
    idx = list(tri.index) if isinstance(tri, pd.DataFrame) else list(range(C.shape[0]))
    n_o = C.shape[0]
    fx = _factors(C, average)
    latest, last_k, cdf_, ult_cl = _project(C, fx["f"], tail_factor)
    if isinstance(apriori, ReservingResult):
        prior = apriori.table["ultimate"].drop("total").to_numpy(dtype=float)
        source = f"{apriori.method} ultimates"
    elif apriori is not None and np.isscalar(apriori):
        prior = np.full(n_o, float(apriori))
        source = "given a-priori"
    elif apriori is not None:
        prior = np.asarray(list(apriori), dtype=float)
        source = "given a-priori per origin"
    elif premium is not None and elr is not None:
        prior = np.asarray(list(premium), dtype=float) * float(elr)
        source = f"premium × ELR {elr:.2%}"
    else:
        prior = np.full(n_o, float(np.nanmean(ult_cl)))
        source = "book-average chain-ladder ultimate"
    pct_unrep = 1 - 1 / cdf_[last_k]
    res = prior * pct_unrep
    ult = latest + res
    table = Table(_table(idx, latest, ult, {"apriori": prior, "pct_unreported": pct_unrep}, last_k, cdf_),
                  title="Bornhuetter–Ferguson", stage="hard", basis=f"a-priori: {source}")
    table.loc["total", "pct_unreported"] = np.nan
    table.notes.append("Reserve = a-priori ultimate × (1 − 1/CDF): the expected unreported share of the prior, unmoved by the latest diagonal.")
    return ReservingResult("bornhuetter-ferguson", table, float(np.nansum(res)), float(np.nansum(ult)), float(np.nansum(latest)),
                           fx["f"], cdf_, detail={"apriori_source": source})


@tool
def cape_cod(tri: pd.DataFrame, premium: Union[Sequence[float], pd.Series], average: str = "volume", tail_factor: float = 1.0) -> ReservingResult:
    """Cape Cod (Stanard–Bühlmann): ELR = Σ latest / Σ (premium × %developed), then BF with that ELR."""
    tri = triangle(tri) if not getattr(tri, "attrs", {}).get("scelo_triangle") and _looks_long(tri) else tri
    C = _cum(tri)
    idx = list(tri.index) if isinstance(tri, pd.DataFrame) else list(range(C.shape[0]))
    fx = _factors(C, average)
    latest, last_k, cdf_, _ = _project(C, fx["f"], tail_factor)
    prem = np.asarray(list(premium), dtype=float)
    used = prem / cdf_[last_k]
    elr = float(np.nansum(latest) / np.nansum(used))
    res = prem * elr * (1 - 1 / cdf_[last_k])
    ult = latest + res
    table = Table(_table(idx, latest, ult, {"premium": prem, "used_premium": used}, last_k, cdf_), title="Cape Cod", stage="hard",
                  basis=f"ELR {elr:.2%} from used-up premium")
    table.notes.append("ELR = Σ latest / Σ (premium / CDF), one loss ratio for the book; reserve = premium × ELR × (1 − 1/CDF).")
    return ReservingResult("cape-cod", table, float(np.nansum(res)), float(np.nansum(ult)), float(np.nansum(latest)), fx["f"], cdf_,
                           detail={"elr": elr})


@tool
def bootstrap(tri: pd.DataFrame, n: int = 1000, seed: Optional[int] = 42, process: bool = True, average: str = "volume") -> ReservingResult:
    """ODP bootstrap (England & Verrall): resample scaled Pearson residuals, refit, project, add gamma process error.

    Returns the mean reserve with SE and the p5 / p50 / p75 / p95 / p99
    quantiles of the total in ``detail`` (and the simulated totals in
    ``detail["totals"]``).
    """
    tri = triangle(tri) if not getattr(tri, "attrs", {}).get("scelo_triangle") and _looks_long(tri) else tri
    C = _cum(tri)
    idx = list(tri.index) if isinstance(tri, pd.DataFrame) else list(range(C.shape[0]))
    n_o, n_d = C.shape
    rng = np.random.default_rng(seed)
    fx = _factors(C, average)
    f = fx["f"]
    latest, last_k, cdf_, ult_cl = _project(C, f)
    # fitted cumulative (backwards from ultimate) and incremental
    Chat = np.full_like(C, np.nan)
    for i in range(n_o):
        for k in range(0, last_k[i] + 1):
            Chat[i, k] = ult_cl[i] / cdf_[k]
    m_hat = np.diff(Chat, axis=1, prepend=0.0)
    m_obs = np.diff(C, axis=1, prepend=0.0)
    mask = np.isfinite(m_obs) & np.isfinite(m_hat) & (m_hat > 0)
    res = (m_obs[mask] - m_hat[mask]) / np.sqrt(m_hat[mask])
    n_obs = int(mask.sum())
    dof = max(n_obs - (n_o + n_d - 1), 1)
    phi = float(np.sum(res ** 2) / dof)
    res_adj = res * math.sqrt(n_obs / dof)
    totals = np.zeros(n)
    by_origin = np.zeros((n, n_o))
    for s in range(n):
        samp = rng.choice(res_adj, size=n_obs, replace=True)
        m_star = m_hat.copy()
        m_star[mask] = m_hat[mask] + samp * np.sqrt(m_hat[mask])
        C_star = np.cumsum(np.where(np.isfinite(m_star), m_star, 0.0), axis=1)
        C_star[~np.isfinite(C)] = np.nan
        f_star = _factors(C_star, average)["f"]
        for i in range(n_o):
            c = C_star[i, last_k[i]]
            reserve = 0.0
            for k in range(last_k[i], n_d - 1):
                nxt = c * f_star[k]
                inc = nxt - c
                if process and inc > 0 and phi > 0:
                    inc = rng.gamma(inc / phi, phi)
                reserve += inc
                c = nxt
            by_origin[s, i] = reserve
        totals[s] = by_origin[s].sum()
    ibnr = float(totals.mean())
    se = float(totals.std(ddof=1)) if n > 1 else 0.0
    q = np.quantile(totals, [0.05, 0.5, 0.75, 0.95, 0.99])
    res_mean = by_origin.mean(axis=0)
    table = Table(_table(idx, latest, latest + res_mean, {"se": by_origin.std(axis=0, ddof=1) if n > 1 else np.zeros(n_o)}, last_k, cdf_),
                  title=f"ODP bootstrap · {n:,} simulations", stage="hard", basis=f"φ = {phi:,.1f}" + (" · gamma process error" if process else " · estimation error only"))
    table.loc["total", "se"] = se
    table.notes.append(f"Total reserve p5 {q[0]:,.0f} · p50 {q[1]:,.0f} · p75 {q[2]:,.0f} · p95 {q[3]:,.0f} · p99 {q[4]:,.0f}.")
    table.notes.append("Residuals are bias-adjusted Pearson residuals of the incremental ODP fit, resampled with replacement; each pseudo-triangle is refitted by chain ladder and projected with gamma process error.")
    return ReservingResult("bootstrap", table, ibnr, float(np.nansum(latest) + ibnr), float(np.nansum(latest)), f, cdf_, se=se,
                           cv=(se / ibnr if ibnr else None),
                           detail={"totals": totals, "phi": phi, "p5": q[0], "p50": q[1], "p75": q[2], "p95": q[3], "p99": q[4], "by_origin": by_origin})


def tail(factors: Union[pd.Series, Sequence[float]], method: str = "exponential", n_fit: Optional[int] = None, horizon: int = 50) -> float:
    """Tail factor from the development pattern: fit ln(f_k − 1) ~ a + b·k (``exponential``) or inverse-power (``power``) and extrapolate.

    Returns the product of the extrapolated factors over ``horizon`` further periods.
    """
    f = np.asarray(list(factors), dtype=float)
    f = f[np.isfinite(f) & (f > 1)]
    if f.size == 0:
        return 1.0
    if n_fit:
        f = f[-n_fit:]
    k = np.arange(1, f.size + 1, dtype=float)
    y = np.log(f - 1)
    if method == "power":
        X = np.column_stack([np.ones_like(k), np.log(k)])
    else:
        X = np.column_stack([np.ones_like(k), k])
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    kk = np.arange(f.size + 1, f.size + 1 + horizon, dtype=float)
    Xk = np.column_stack([np.ones_like(kk), np.log(kk) if method == "power" else kk])
    fk = 1 + np.exp(Xk @ beta)
    return float(np.prod(fk))


@tool
def reserve(df: pd.DataFrame, n_boot: int = 1000, seed: Optional[int] = 42, **triangle_kwargs: Any) -> Table:
    """One line from a claims file (or a triangle) to a reserve summary: chain ladder, Mack, BF, ODP bootstrap side by side."""
    tri = df if getattr(df, "attrs", {}).get("scelo_triangle") else triangle(df, **triangle_kwargs)
    cl = chain_ladder(tri)
    mk = mack(tri)
    b = bf(tri, apriori=cl)
    bs = bootstrap(tri, n=n_boot, seed=seed)
    rows = [cl.summary(), mk.summary(), b.summary(), bs.summary()]
    out = pd.DataFrame(rows).set_index("method")
    out.loc["bootstrap", "p95"] = bs.detail["p95"]
    out.loc["bootstrap", "p99"] = bs.detail["p99"]
    t = Table(out, title="Reserve summary", stage="hard", basis=tri.basis if isinstance(tri, Table) else None)
    t.notes.append(f"Triangle: {tri.shape[0]} origins × {tri.shape[1]} lags. Mack SE ±1.96 → [{mk.ibnr - 1.96 * mk.se:,.0f}, {mk.ibnr + 1.96 * mk.se:,.0f}]; bootstrap p95 {bs.detail['p95']:,.0f}.")
    t.notes.append("Chain ladder and Mack share the point estimate; BF is seeded with the chain-ladder ultimates; the bootstrap is ODP with gamma process error.")
    t.attrs["results"] = {"chain_ladder": cl, "mack": mk, "bf": b, "bootstrap": bs, "triangle": tri}
    return t


def _looks_long(df: Any) -> bool:
    """A long claims file (has an origin-ish column) rather than a wide triangle."""
    if not isinstance(df, pd.DataFrame):
        return False
    try:
        infer(df, "origin")
        return True
    except KeyError:
        return False
