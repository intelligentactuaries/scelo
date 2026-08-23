"""Profiling: the column summary and the descriptive report, one definition.

``profile(df)`` is the IDE's column-summary header (type, missing, unique,
five-number summary, Tukey fences, outlier count, quintiles, top values,
date range). ``describe(df)`` is the descriptive report every Scelo surface
prints: Bessel sd, type-7 quantiles, adjusted Fisher–Pearson G1 / G2 shape,
Jarque–Bera normality, ranked by coefficient of variation so a premium
column in cents cannot outrank a loss ratio just by scale.

Both follow packages/scelo-core exactly, so a median printed here is the
median the IDE would print for the same file.
"""

from __future__ import annotations

import math
import re
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

import numpy as np
import pandas as pd

from ._alias import numeric_columns
from ._audit import tool
from ._table import Table
from .io import coerce_cell, is_text


def _numeric_vec(col: pd.Series) -> pd.Series:
    """Float view of a column: numbers as they are; strictly numeric strings (Scelo's import rule) as numbers; else NaN. Vectorised via uniques."""
    if pd.api.types.is_bool_dtype(col):
        return pd.Series(np.nan, index=col.index, dtype=float)
    if pd.api.types.is_numeric_dtype(col):
        return pd.to_numeric(col, errors="coerce").astype(float)
    obj = col.astype(object)
    out = pd.Series(np.nan, index=col.index, dtype=float)
    isnum = obj.map(lambda v: isinstance(v, (int, float, np.integer, np.floating)) and not isinstance(v, bool)) if obj.map(type).nunique() > 1 else pd.Series(False, index=col.index)
    if isnum.any():
        out[isnum] = pd.to_numeric(obj[isnum], errors="coerce").astype(float)
    try:
        strmask = obj.str.len().notna()
    except AttributeError:
        return out
    if strmask.any():
        u = pd.Series(pd.unique(obj[strmask]).astype(object), dtype="string").str.strip()
        ok = u.str.match(r"^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$").fillna(False) & ~u.str.match(r"^[+-]?0\d").fillna(False)
        vals = pd.to_numeric(u.where(ok).astype(object), errors="coerce").astype(float)
        vals[~np.isfinite(vals)] = np.nan
        lookup = pd.Series(vals.to_numpy(), index=pd.unique(obj[strmask]).astype(object))
        out[strmask] = obj[strmask].map(lookup).astype(float).to_numpy()
    return out


def _num_or_nan(v: Any) -> Any:
    """A cell as a number when it is one (or a strictly numeric string, as the IDE would have typed it at import), else NaN."""
    if isinstance(v, bool):
        return np.nan
    if isinstance(v, (int, float, np.integer, np.floating)):
        return v
    if isinstance(v, str):
        c = coerce_cell(v)
        return c if isinstance(c, (int, float)) and not isinstance(c, bool) else np.nan
    return np.nan

__all__ = [
    "profile", "describe", "types", "missing", "unique", "tab", "corr", "quantile", "box", "fences",
    "histogram", "outliers", "inliers", "iqr", "column_type", "skew", "kurt", "jarque_bera", "summary",
]

_DATE_SHAPE_RE = re.compile(r"^(\d{4})[-/](\d{2})[-/](\d{2})([T ]\S.*)?$")
_DATE_PROBE_MIN = 8
_DATE_PROBE_TARGET = 200
_QUINTILE_MIN_N = 5
_TOP_VALUES = 8
_HIST_BINS = 12


# ── scalar helpers ──────────────────────────────────────────────────────────

def quantile(values: Sequence[float], q: Union[float, Sequence[float]]) -> Union[float, np.ndarray]:
    """Type-7 quantile (R default, numpy default): linear interpolation on (n−1)·q."""
    arr = np.asarray([v for v in np.asarray(values, dtype=float) if np.isfinite(v)], dtype=float)
    if arr.size == 0:
        return 0.0 if np.isscalar(q) else np.zeros(len(q))  # type: ignore[arg-type]
    return float(np.quantile(arr, q)) if np.isscalar(q) else np.quantile(arr, q)


def box(values: Sequence[float]) -> Optional[Dict[str, Any]]:
    """Tukey box statistics: ``lo q1 median q3 hi`` whiskers, fences, and the outliers outside them.

    When the IQR is 0 (≥ 50 % identical values) the fences collapse onto the
    quartiles, so no outlier classification is made and the whiskers span the
    range: a discrete column must not light up a quarter of its rows.
    """
    arr = np.sort(np.asarray([v for v in np.asarray(values, dtype=float) if np.isfinite(v)], dtype=float))
    if arr.size == 0:
        return None
    q1, med, q3 = (float(x) for x in np.quantile(arr, [0.25, 0.5, 0.75]))
    iqr_ = q3 - q1
    if iqr_ == 0:
        return {"lo": float(arr[0]), "q1": q1, "median": med, "q3": q3, "hi": float(arr[-1]),
                "lo_fence": q1, "hi_fence": q3, "iqr": 0.0, "outliers": np.array([], dtype=float)}
    lo_f, hi_f = q1 - 1.5 * iqr_, q3 + 1.5 * iqr_
    inside = arr[(arr >= lo_f) & (arr <= hi_f)]
    out = arr[(arr < lo_f) | (arr > hi_f)]
    return {
        "lo": float(inside[0]) if inside.size else float(arr[0]),
        "q1": q1, "median": med, "q3": q3,
        "hi": float(inside[-1]) if inside.size else float(arr[-1]),
        "lo_fence": lo_f, "hi_fence": hi_f, "iqr": iqr_, "outliers": out,
    }


def fences(values: Sequence[float], k: float = 1.5) -> Tuple[float, float]:
    """The Tukey fences ``(q1 − k·IQR, q3 + k·IQR)``."""
    q1, q3 = quantile(values, [0.25, 0.75])
    return float(q1 - k * (q3 - q1)), float(q3 + k * (q3 - q1))


def iqr(values: Sequence[float]) -> float:
    """Interquartile range (type-7 quartiles)."""
    q1, q3 = quantile(values, [0.25, 0.75])
    return float(q3 - q1)


def histogram(values: Sequence[float], bins: int = _HIST_BINS) -> pd.DataFrame:
    """Equal-width histogram between min and max (the IDE's 12-bin sparkline); one row per bin."""
    arr = np.asarray([v for v in np.asarray(values, dtype=float) if np.isfinite(v)], dtype=float)
    if arr.size == 0 or arr.max() == arr.min():
        return pd.DataFrame(columns=["lo", "hi", "count"])
    counts, edges = np.histogram(arr, bins=bins, range=(arr.min(), arr.max()))
    return pd.DataFrame({"lo": edges[:-1], "hi": edges[1:], "count": counts})


def _moments(arr: np.ndarray) -> Dict[str, Optional[float]]:
    n = arr.size
    mean = float(arr.mean())
    dev = arr - mean
    d2 = dev * dev
    m2 = float(d2.mean())
    m3 = float((d2 * dev).mean())
    m4 = float((d2 * d2).mean())
    sd = math.sqrt(m2 * n / (n - 1)) if n > 1 else 0.0
    g1 = m3 / m2**1.5 if m2 > 0 else None
    g2 = m4 / (m2 * m2) - 3 if m2 > 0 else None
    skewness = (math.sqrt(n * (n - 1)) / (n - 2)) * g1 if (g1 is not None and n > 2) else None
    kurtosis = ((n - 1) / ((n - 2) * (n - 3))) * ((n + 1) * g2 + 6) if (g2 is not None and n > 3) else None
    jb = None
    if g1 is not None and g2 is not None and n >= 8:
        stat = (n / 6) * (g1 * g1 + (g2 * g2) / 4)
        jb = (stat, math.exp(-stat / 2))
    return {"mean": mean, "sd": sd, "g1": g1, "g2": g2, "skewness": skewness, "kurtosis": kurtosis, "jb": jb}


def skew(values: Sequence[float]) -> Optional[float]:
    """Adjusted Fisher–Pearson skewness G1 (what R's e1071 type 2, SAS and Excel report); None if n < 3 or constant."""
    arr = _finite(values)
    return _moments(arr)["skewness"] if arr.size else None


def kurt(values: Sequence[float]) -> Optional[float]:
    """Adjusted excess kurtosis G2 (normal ≈ 0); None if n < 4 or constant."""
    arr = _finite(values)
    return _moments(arr)["kurtosis"] if arr.size else None


def jarque_bera(values: Sequence[float]) -> Optional[Tuple[float, float]]:
    """Jarque–Bera ``(statistic, p)`` on the unadjusted g1 / g2; None below n = 8."""
    arr = _finite(values)
    return _moments(arr)["jb"] if arr.size else None


def _finite(values: Any) -> np.ndarray:
    s = pd.to_numeric(pd.Series(values), errors="coerce").to_numpy(dtype=float)
    return s[np.isfinite(s)]


# ── typing a column ─────────────────────────────────────────────────────────

def _is_missing(v: Any) -> bool:
    """Scelo's "missing" cell: None, NaN / NA / NaT, or the empty string."""
    if v is None:
        return True
    if isinstance(v, str):
        return v == ""
    try:
        return bool(pd.isna(v))
    except (TypeError, ValueError):
        return False


def column_type(col: pd.Series) -> str:
    """``number`` / ``date`` / ``string`` / ``bool`` under Scelo's rules (80 % numeric; strict ISO date probe)."""
    if pd.api.types.is_bool_dtype(col):
        return "bool"
    if pd.api.types.is_numeric_dtype(col):
        return "number"
    if pd.api.types.is_datetime64_any_dtype(col):
        return "date"
    miss = col.isna() | (col.astype(object) == "") if is_text(col) else col.isna()
    vals = col[~miss]
    if len(vals) == 0:
        return "string"
    nums = _numeric_vec(vals)
    if nums.notna().sum() / len(vals) >= 0.8:
        return "number"
    strs = vals[vals.map(lambda v: isinstance(v, str))]
    stride = max(1, len(strs) // _DATE_PROBE_TARGET)
    probe = strs.iloc[::stride][:_DATE_PROBE_TARGET]
    if len(probe) >= _DATE_PROBE_MIN:
        shaped = probe.map(lambda s: _date_year(s) is not None).sum()
        if shaped / len(probe) >= 0.8:
            return "date"
    return "string"


def _date_year(s: str) -> Optional[int]:
    m = _DATE_SHAPE_RE.match(s)
    if not m:
        return None
    month, day = int(m.group(2)), int(m.group(3))
    if month < 1 or month > 12 or day < 1 or day > 31:
        return None
    return int(m.group(1))


# ── profile ─────────────────────────────────────────────────────────────────

def _profile_column(col: pd.Series) -> Dict[str, Any]:
    total = len(col)
    miss_mask = col.isna() | (col.astype(object) == "") if is_text(col) else col.isna()
    missing_n = int(miss_mask.sum())
    present = col[~miss_mask]
    meta: Dict[str, Any] = {
        "column": col.name, "type": column_type(col), "count": total, "missing": missing_n,
        "missing_pct": (missing_n / total) if total else 0.0,
        "unique": int(present.map(lambda v: str(v) if not isinstance(v, (int, float)) else v).nunique()) if len(present) else 0,
    }
    if meta["type"] == "number":
        nums = _numeric_vec(present)
        mixed = int(nums.isna().sum())
        arr = nums.dropna().to_numpy(dtype=float)
        arr = arr[np.isfinite(arr)]
        if mixed:
            meta["mixed"] = mixed
        if arr.size:
            meta.update(min=float(arr.min()), max=float(arr.max()), mean=float(arr.mean()))
            b = box(arr)
            if b:
                meta.update(q1=b["q1"], median=b["median"], q3=b["q3"], box_lo=b["lo"], box_hi=b["hi"],
                            lo_fence=b["lo_fence"], hi_fence=b["hi_fence"], outliers=int(b["outliers"].size))
            if arr.size >= _QUINTILE_MIN_N:
                meta["quintiles"] = [float(x) for x in np.quantile(arr, [0.2, 0.4, 0.6, 0.8])]
            if arr.max() > arr.min():
                meta["histogram"] = [int(x) for x in np.histogram(arr, bins=_HIST_BINS, range=(arr.min(), arr.max()))[0]]
    elif meta["type"] == "date":
        if pd.api.types.is_datetime64_any_dtype(col):
            d = present.dropna()
            meta["date_min"] = str(d.min().date()) if len(d) else None
            meta["date_max"] = str(d.max().date()) if len(d) else None
            years = d.dt.year.value_counts().sort_index()
        else:
            strs = present[present.map(lambda v: isinstance(v, str) and _date_year(v) is not None)]
            meta["date_min"] = str(strs.min()) if len(strs) else None
            meta["date_max"] = str(strs.max()) if len(strs) else None
            years = strs.map(_date_year).value_counts().sort_index()
        meta["year_histogram"] = {int(k): int(v) for k, v in years.items()}
    elif meta["type"] == "bool":
        vc = present.value_counts()
        meta["top_values"] = [(str(k), int(v)) for k, v in vc.items()]
    else:
        vc = present.map(str).value_counts()
        meta["top_values"] = [(str(k), int(v)) for k, v in vc.head(_TOP_VALUES).items()]
    return meta


@tool
def profile(df: pd.DataFrame, columns: Optional[Sequence[str]] = None) -> Table:
    """Per-column summary: type, count, missing, unique, min / q1 / median / q3 / max, fences, outliers, top values.

    The same numbers the IDE's column headers show. Numeric columns carry the
    Tukey five-number summary and fences; categoricals the top 8 values;
    dates the range and per-year counts. ``mixed`` counts non-numeric cells
    in a number-typed column ("6+"), which every numeric stat excludes.
    """
    cols = list(columns) if columns is not None else list(df.columns)
    metas = [_profile_column(df[c]) for c in cols]
    order = ["column", "type", "count", "missing", "missing_pct", "unique", "mixed", "min", "q1", "median", "mean", "q3",
             "max", "lo_fence", "hi_fence", "outliers", "quintiles", "top_values", "date_min", "date_max",
             "year_histogram", "histogram", "box_lo", "box_hi"]
    out = pd.DataFrame(metas)
    out = out[[c for c in order if c in out.columns]]
    t = Table(out, title=f"profile · {len(df):,} rows × {len(cols)} columns", stage="soft")
    n_missing = sum(m["missing"] for m in metas)
    if n_missing:
        t.notes.append(f"{n_missing:,} missing cells across {sum(1 for m in metas if m['missing'])} columns (null or empty string).")
    mixed = [m["column"] for m in metas if m.get("mixed")]
    if mixed:
        t.notes.append(f"Non-numeric residue in number-typed columns ({', '.join(map(str, mixed))}): excluded from every numeric stat; see scelo.clean.")
    return t


# ── describe ────────────────────────────────────────────────────────────────

@tool
def describe(df: pd.DataFrame, columns: Optional[Sequence[str]] = None, top: Optional[int] = None) -> Table:
    """Descriptive statistics for every numeric column, ranked by coefficient of variation.

    Columns: n, miss %, mean, sd (Bessel), se, cv, min, q1, median, q3, max,
    iqr, skewness (G1), kurtosis (G2), jarque_bera, jb_p. Columns whose mean
    is ≈ 0 (CV undefined) rank last, by sd among themselves. ``top=n`` keeps
    the first n rows, the way the IDE's report shows five and lists the rest.
    """
    cols = list(columns) if columns is not None else list(df.columns)
    total = len(df)
    rows: List[Dict[str, Any]] = []
    for c in cols:
        s = df[c]
        if pd.api.types.is_bool_dtype(s) or pd.api.types.is_datetime64_any_dtype(s):
            continue
        vals = _numeric_vec(s)
        arr = vals.to_numpy(dtype=float)
        arr = np.sort(arr[np.isfinite(arr)])
        n = arr.size
        if n == 0:
            continue
        mo = _moments(arr)
        q1, med, q3 = (float(x) for x in np.quantile(arr, [0.25, 0.5, 0.75]))
        mean, sd = mo["mean"], mo["sd"]
        cv = sd / abs(mean) if abs(mean) > 1e-12 else None
        rows.append({
            "column": c, "n": n, "missing": total - n, "missing_pct": (total - n) / total if total else 0.0,
            "mean": mean, "sd": sd, "se": sd / math.sqrt(n), "cv": cv,
            "min": float(arr[0]), "q1": q1, "median": med, "q3": q3, "max": float(arr[-1]), "iqr": q3 - q1,
            "skewness": mo["skewness"], "kurtosis": mo["kurtosis"],
            "jarque_bera": mo["jb"][0] if mo["jb"] else None, "jb_p": mo["jb"][1] if mo["jb"] else None,
        })
    if not rows:
        raise ValueError("No numeric columns found: nothing to summarise.")
    rows.sort(key=lambda r: (r["cv"] is None, -(r["cv"] if r["cv"] is not None else 0.0), -r["sd"]))
    out = pd.DataFrame(rows)
    if top is not None:
        out = out.head(top)
    lead = rows[0]
    notes = [
        f"{len(rows)} numeric columns profiled: sample moments (Bessel), type-7 quantiles, G1/G2 shape, Jarque–Bera normality.",
        f"Widest relative spread is `{lead['column']}`" + (f" (CV {lead['cv']:.2f})" if lead["cv"] is not None else "")
        + f": mean {lead['mean']:.4g}, sd {lead['sd']:.4g}, range [{lead['min']:.4g}, {lead['max']:.4g}].",
    ]
    gappy = sum(1 for r in rows if r["missing_pct"] > 0.1)
    if gappy:
        notes.append(f"{gappy} column(s) are >10% missing/non-numeric: worth resolving before any fit.")
    return Table(out, title=f"describe · {total:,} rows", notes=notes, stage="soft")


summary = describe


# ── small Stata-flavoured helpers ─────────────────────────────────────────

def types(df: pd.DataFrame) -> pd.Series:
    """Scelo type (number / date / string / bool) of every column."""
    return pd.Series({c: column_type(df[c]) for c in df.columns}, name="type")


def missing(df: pd.DataFrame) -> pd.DataFrame:
    """Missing (null or empty-string) count and share per column, worst first."""
    m = df.apply(lambda s: int(s.map(_is_missing).sum()))
    out = pd.DataFrame({"missing": m, "pct": m / len(df) if len(df) else 0.0})
    return out.sort_values("missing", ascending=False)


def unique(df: pd.DataFrame) -> pd.Series:
    """Distinct non-missing values per column."""
    return df.apply(lambda s: s[~s.map(_is_missing)].map(lambda v: str(v) if not isinstance(v, (int, float)) else v).nunique())


def tab(df: pd.DataFrame, col: str, by: Optional[str] = None, *, pct: bool = False, margins: bool = True) -> pd.DataFrame:
    """One- or two-way frequency table (Stata's ``tab``): ``tab(df, "line")`` or ``tab(df, "line", "sex")``."""
    if by is None:
        vc = df[col].value_counts(dropna=False)
        out = pd.DataFrame({"count": vc, "pct": 100 * vc / vc.sum()})
        out.index.name = col
        return out
    ct = pd.crosstab(df[col], df[by], margins=margins, normalize="index" if pct else False)
    return ct * 100 if pct else ct


def corr(df: pd.DataFrame, method: str = "pearson", min_abs: float = 0.0) -> pd.DataFrame:
    """Correlation matrix of the numeric columns; ``min_abs`` blanks weaker cells."""
    c = df[numeric_columns(df)].corr(method=method)
    return c.where(c.abs() >= min_abs) if min_abs > 0 else c


def outliers(df: pd.DataFrame, col: str, k: float = 1.5) -> pd.DataFrame:
    """Rows where ``col`` sits outside the Tukey fences (the IDE's outlier-dot filter)."""
    lo, hi = fences(df[col], k)
    v = pd.to_numeric(df[col], errors="coerce")
    return df[(v < lo) | (v > hi)]


def inliers(df: pd.DataFrame, col: str, k: float = 1.5) -> pd.DataFrame:
    """Rows where ``col`` is inside the Tukey fences (complement of :func:`outliers`); nulls are kept."""
    lo, hi = fences(df[col], k)
    v = pd.to_numeric(df[col], errors="coerce")
    return df[~((v < lo) | (v > hi))]
