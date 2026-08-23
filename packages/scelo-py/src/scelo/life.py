"""Life: mortality bases, life tables, commutation functions, factors, premiums.

The table generators follow packages/scelo-core/src/actuarialTables.ts
line for line (the IDE's "build a life table at 4 %" chat command), so a
table built here is the table the IDE builds. Beyond those: Whittaker–
Henderson graduation, Lee–Carter (SVD, random-walk-with-drift forecast),
Kaplan–Meier, policy-year exposure, and a numpy port of lifelib's
BasicTerm_ME monthly projection with Scelo's illustrative assumptions.

A mortality basis is any of:
  * a DataFrame with age + qx (or age + lx, or age + deaths + exposure),
  * a Series of qx indexed by age,
  * ``dict(A=…, B=…, c=…)`` or the string ``"makeham"`` (Scelo's illustrative
    Gompertz–Makeham, always labelled as illustrative).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

import numpy as np
import pandas as pd

from ._alias import infer
from ._audit import tool
from ._table import Table

__all__ = [
    "ILLUSTRATIVE_MAKEHAM", "makeham", "gompertz", "qx", "life_table", "commutation", "factors", "annuity", "assurance",
    "premium", "ae", "model_points", "graduate", "lee_carter", "kaplan_meier", "exposure", "survival", "life_expectancy",
    "close_table", "basicterm", "BasicTermAssumptions", "Basis", "mx_to_qx", "qx_to_mx", "epv", "ae_test",
]

ILLUSTRATIVE_MAKEHAM = {"A": 0.00022, "B": 2.7e-6, "c": 1.124}
Basis = Union[str, Dict[str, float], pd.DataFrame, pd.Series, "QxTable", None]


# ── mortality laws ──────────────────────────────────────────────────────────

def makeham(ages: Sequence[float], A: float = ILLUSTRATIVE_MAKEHAM["A"], B: float = ILLUSTRATIVE_MAKEHAM["B"],
            c: float = ILLUSTRATIVE_MAKEHAM["c"], multiplier: float = 1.0) -> pd.Series:
    """Gompertz–Makeham qx from μx = A + B·cˣ, integrated over the year: qx = 1 − exp(−(A + B·cˣ·(c−1)/ln c)·m)."""
    x = np.asarray(ages, dtype=float)
    integral = A + (B * c ** x * (c - 1)) / math.log(c)
    q = 1 - np.exp(-integral * multiplier)
    return pd.Series(np.clip(q, 0, 1), index=pd.Index(x.astype(int) if np.all(x == np.round(x)) else x, name="age"), name="qx")


def gompertz(ages: Sequence[float], B: float = ILLUSTRATIVE_MAKEHAM["B"], c: float = ILLUSTRATIVE_MAKEHAM["c"]) -> pd.Series:
    """Gompertz qx (Makeham with A = 0)."""
    return makeham(ages, 0.0, B, c)


# ── basis → qx by age ───────────────────────────────────────────────────────

@dataclass
class QxTable:
    ages: np.ndarray
    qx: np.ndarray
    label: str
    notes: List[str]

    def series(self) -> pd.Series:
        return pd.Series(self.qx, index=pd.Index(self.ages, name="age"), name="qx")


def _fill_gaps(by_age: Dict[int, float]) -> Tuple[np.ndarray, np.ndarray, int]:
    ks = sorted(by_age)
    lo, hi = ks[0], ks[-1]
    ages = np.arange(lo, hi + 1)
    known_x = np.array(ks, dtype=float)
    known_v = np.array([by_age[k] for k in ks], dtype=float)
    vals = np.interp(ages, known_x, known_v)
    filled = int(len(ages) - len(ks))
    return ages, vals, filled


def qx(basis: Basis = None, df: Optional[pd.DataFrame] = None, *, ages: Optional[Tuple[Optional[int], Optional[int]]] = None,
       age: Optional[str] = None, qx_col: Optional[str] = None, lx: Optional[str] = None, deaths: Optional[str] = None,
       exposure_col: Optional[str] = None, **makeham_kw: float) -> QxTable:
    """Resolve any mortality basis to an annual (age, qx) table.

    ``qx()`` → Scelo's illustrative Makeham from 20 to 110; ``qx(df)`` finds
    age + qx / lx / deaths + exposure columns; ``qx(series)`` takes qx by
    age; ``qx(dict(A=…, B=…, c=…))`` a custom Makeham. Gaps in an age range
    are interpolated linearly; percent-shaped qx (> 1) is divided by 100;
    crude deaths ÷ exposure rates are flagged as ungraduated.
    """
    notes: List[str] = []
    if isinstance(basis, QxTable):
        return basis
    if isinstance(basis, pd.DataFrame) and df is None:
        df, basis = basis, None
    if basis is None and df is None:
        basis = "makeham"
    if isinstance(basis, str) and basis.lower() in ("makeham", "illustrative", "gompertz-makeham", "gompertz") or isinstance(basis, dict):
        p = dict(ILLUSTRATIVE_MAKEHAM)
        if isinstance(basis, dict):
            p.update({k: float(v) for k, v in basis.items() if k in ("A", "B", "c", "multiplier")})
        p.update({k: float(v) for k, v in makeham_kw.items() if k in ("A", "B", "c", "multiplier")})
        if isinstance(basis, str) and basis.lower() == "gompertz":
            p["A"] = 0.0
        lo = ages[0] if ages and ages[0] is not None else 20
        hi = ages[1] if ages and ages[1] is not None else 110
        ax = np.arange(lo, hi + 1)
        q = makeham(ax, p["A"], p["B"], p["c"], p.get("multiplier", 1.0)).to_numpy()
        illustrative = (p["A"], p["B"], p["c"]) == (ILLUSTRATIVE_MAKEHAM["A"], ILLUSTRATIVE_MAKEHAM["B"], ILLUSTRATIVE_MAKEHAM["c"])
        notes.append(
            "Mortality is Scelo's ILLUSTRATIVE Gompertz–Makeham basis (A = 0.00022, B = 2.7e-6, c = 1.124), not a published standard table: swap in your own qx column or parameters before relying on the figures."
            if illustrative else f"Mortality from Gompertz–Makeham μx = A + B·cˣ with A = {p['A']}, B = {p['B']}, c = {p['c']}" + (f", × {p['multiplier']}" if p.get("multiplier", 1) != 1 else "") + "."
        )
        return QxTable(ax, q, "Gompertz–Makeham (illustrative)" if illustrative else "Gompertz–Makeham (custom)", notes)
    if isinstance(basis, pd.Series):
        s = pd.to_numeric(basis, errors="coerce").dropna()
        by_age = {int(round(float(k))): float(v) for k, v in s.items()}
        label = f"qx from `{basis.name or 'qx'}` by age"
    else:
        assert df is not None
        a = infer(df, "age", age)
        have_q = qx_col or (infer(df, "qx", None, required=False, exclude=[a]) if lx is None and deaths is None else None)
        have_l = lx or (infer(df, "lx", None, required=False, exclude=[a]) if have_q is None and deaths is None else None)
        ages_s = pd.to_numeric(df[a], errors="coerce").round()
        if have_q:
            v = pd.to_numeric(df[have_q], errors="coerce")
            g = pd.DataFrame({"a": ages_s, "v": v}).dropna().groupby("a")["v"].mean()
            if g.max() > 1:
                notes.append(f"`{have_q}` looked like percentages (max {g.max():.3f}): divided by 100.")
                g = g / 100
            by_age = {int(k): float(x) for k, x in g.items()}
            label = f"qx from `{have_q}` by `{a}`"
        elif have_l:
            v = pd.to_numeric(df[have_l], errors="coerce")
            g = pd.DataFrame({"a": ages_s, "v": v}).dropna().groupby("a")["v"].mean()
            ks = sorted(int(k) for k in g.index)
            by_age = {}
            for i in range(len(ks) - 1):
                l0, l1 = g[ks[i]], g[ks[i + 1]]
                if l0 > 0 and ks[i + 1] == ks[i] + 1:
                    by_age[ks[i]] = float(min(1, max(0, 1 - l1 / l0)))
            label = f"qx derived from `{have_l}` by `{a}`"
            notes.append("qx = 1 − l(x+1)/l(x) from the survivor column; the last age has no successor and is closed with qx = 1.")
        else:
            d = infer(df, "deaths", deaths, exclude=[a])
            e = infer(df, "exposure", exposure_col, exclude=[a, d])
            g = pd.DataFrame({"a": ages_s, "d": pd.to_numeric(df[d], errors="coerce"), "e": pd.to_numeric(df[e], errors="coerce")}).dropna().groupby("a").sum()
            g = g[g["e"] > 0]
            by_age = {int(k): float(min(1, max(0, r["d"] / r["e"]))) for k, r in g.iterrows()}
            label = f"crude qx = `{d}` / `{e}` by `{a}`"
            notes.append("Crude rates (deaths ÷ exposure), ungraduated. Graduate before using for pricing or reserving (scelo.graduate).")
    if not by_age:
        raise ValueError("no usable (age, rate) pairs: check the columns are numeric")
    ax, q, filled = _fill_gaps(by_age)
    if filled:
        notes.append(f"{filled} missing age{'s' if filled != 1 else ''} interpolated linearly.")
    if ages is not None:
        lo = ages[0] if ages[0] is not None else -np.inf
        hi = ages[1] if ages[1] is not None else np.inf
        keep = (ax >= lo) & (ax <= hi)
        ax, q = ax[keep], q[keep]
        if ax.size == 0:
            raise ValueError("no ages left inside the requested range")
    return QxTable(ax, q, label, notes)


# ── life table core ─────────────────────────────────────────────────────────

def _life_cols(q: QxTable, radix: float) -> Dict[str, np.ndarray]:
    qx_ = q.qx.astype(float).copy()
    n = qx_.size
    qx_[n - 1] = 1.0  # close the table
    px = 1 - qx_
    lx = np.empty(n)
    lx[0] = radix
    surv = np.cumprod(px[:-1])
    lx[1:] = radix * surv
    dx = lx * qx_
    Lx = lx - dx / 2
    Tx = np.cumsum(Lx[::-1])[::-1]
    ex = np.where(lx > 0, Tx / np.where(lx > 0, lx, 1), 0.0)
    return {"age": q.ages, "qx": qx_, "px": px, "lx": lx, "dx": dx, "Lx": Lx, "Tx": Tx, "ex": ex}


def _commutation(L: Dict[str, np.ndarray], i: float) -> Dict[str, np.ndarray]:
    v = 1 / (1 + i)
    ages = L["age"]
    vx = v ** (ages - ages[0])
    Dx = vx * L["lx"]
    Cx = vx * v * L["dx"]
    Nx = np.cumsum(Dx[::-1])[::-1]
    Mx = np.cumsum(Cx[::-1])[::-1]
    Rx = np.cumsum(Mx[::-1])[::-1]
    Sx = np.cumsum(Nx[::-1])[::-1]
    return {"v": v, "vx": vx, "Dx": Dx, "Cx": Cx, "Nx": Nx, "Mx": Mx, "Rx": Rx, "Sx": Sx}


def _pct(i: float) -> str:
    return f"{round(i * 100, 2):g} %"


def _ages_arg(ages: Any) -> Optional[Tuple[Optional[int], Optional[int]]]:
    if ages is None:
        return None
    if isinstance(ages, (tuple, list)) and len(ages) == 2:
        return (None if ages[0] is None else int(ages[0]), None if ages[1] is None else int(ages[1]))
    if isinstance(ages, range):
        return (ages.start, ages.stop - 1)
    raise TypeError("ages must be (from, to)")


@tool
def life_table(basis: Basis = None, df: Optional[pd.DataFrame] = None, *, ages: Any = None, radix: float = 100_000, **kw: Any) -> Table:
    """Life table: age, qx, px, lx, dx, Lx, Tx, ex. ``life_table()`` uses the illustrative Makeham basis; ``life_table(df)`` your qx.

    The last age carries qx = 1 so Tx / ex are finite; Lx uses the
    uniform-deaths approximation lx − ½dx.
    """
    q = qx(basis, df, ages=_ages_arg(ages), **kw)
    L = _life_cols(q, radix)
    out = pd.DataFrame({"age": L["age"], "qx": L["qx"], "px": L["px"], "lx": L["lx"], "dx": L["dx"], "Lx": L["Lx"], "Tx": L["Tx"], "ex": L["ex"]})
    t = Table(out, title=f"Life table · {q.label}", basis=q.label, stage="hard",
              notes=[*q.notes, f"Radix l({int(L['age'][0])}) = {radix:,.0f}; table closed at age {int(L['age'][-1])} (qx set to 1). Lx uses the uniform-deaths approximation lx − ½dx."])
    return t


@tool
def commutation(basis: Basis = None, df: Optional[pd.DataFrame] = None, *, i: float = 0.04, ages: Any = None, radix: float = 100_000, **kw: Any) -> Table:
    """Commutation functions at interest ``i``: age, lx, dx, v^x, Dx, Nx, Cx, Mx, Rx, Sx (v^x measured from the first tabulated age)."""
    q = qx(basis, df, ages=_ages_arg(ages), **kw)
    L = _life_cols(q, radix)
    C = _commutation(L, i)
    out = pd.DataFrame({"age": L["age"], "lx": L["lx"], "dx": L["dx"], "v^x": C["vx"], "Dx": C["Dx"], "Nx": C["Nx"], "Cx": C["Cx"], "Mx": C["Mx"], "Rx": C["Rx"], "Sx": C["Sx"]})
    return Table(out, title=f"Commutation functions · {q.label} · i = {_pct(i)}", basis=f"{q.label} · i = {_pct(i)}", stage="hard",
                 notes=[*q.notes, f"Interest {_pct(i)} p.a.; v^x is measured from the first tabulated age ({int(L['age'][0])}), so ratios (Nx/Dx, Mx/Dx …) are unaffected. Radix {radix:,.0f}."])


@tool
def factors(basis: Basis = None, df: Optional[pd.DataFrame] = None, *, i: float = 0.04, n: Optional[int] = None, ages: Any = None, **kw: Any) -> Table:
    """Annuity and assurance factors by age: äx, ax, Ax and, with a term ``n``, äx:n, A¹x:n, nEx, Ax:n.

    äx = Nx/Dx (annuity-due), ax = äx − 1, Ax = Mx/Dx (end-of-year benefit);
    äx:n = (Nx − Nx+n)/Dx, A¹x:n = (Mx − Mx+n)/Dx, nEx = Dx+n/Dx, Ax:n = A¹x:n + nEx.
    """
    q = qx(basis, df, ages=_ages_arg(ages), **kw)
    L = _life_cols(q, 100_000)
    C = _commutation(L, i)
    Dx, Nx, Mx = C["Dx"], C["Nx"], C["Mx"]
    out = pd.DataFrame({"age": L["age"], "äx": Nx / Dx, "ax": Nx / Dx - 1, "Ax": Mx / Dx})
    if n:
        m = len(Dx)
        k = np.arange(m)
        kn = k + n
        ok = kn < m
        idx = np.where(ok, kn, 0)
        out[f"äx:{n}"] = np.where(ok, (Nx - Nx[idx]) / Dx, np.nan)
        out[f"A¹x:{n}"] = np.where(ok, (Mx - Mx[idx]) / Dx, np.nan)
        out[f"{n}Ex"] = np.where(ok, Dx[idx] / Dx, np.nan)
        out[f"Ax:{n}"] = np.where(ok, (Mx - Mx[idx] + Dx[idx]) / Dx, np.nan)
    note = "äx = Nx/Dx (annuity-due), ax = äx − 1, Ax = Mx/Dx (whole-life assurance, end-of-year benefit)"
    if n:
        note += f"; äx:{n} = (Nx − Nx+{n})/Dx, A¹x:{n} = (Mx − Mx+{n})/Dx, {n}Ex = Dx+{n}/Dx, Ax:{n} = A¹x:{n} + {n}Ex. Blank where x + {n} runs past the table."
    return Table(out, title=f"Annuity & assurance factors · {q.label} · i = {_pct(i)}" + (f" · n = {n}" if n else ""),
                 basis=f"{q.label} · i = {_pct(i)}", stage="hard", notes=[*q.notes, note + f" Interest {_pct(i)}."])


def annuity(x: int, basis: Basis = None, df: Optional[pd.DataFrame] = None, *, i: float = 0.04, n: Optional[int] = None, due: bool = True, **kw: Any) -> float:
    """One number: äx (``due=True``) or ax at age x, temporary for ``n`` years if given."""
    f = factors(basis, df, i=i, n=n, **kw)
    row = f[f["age"] == x]
    if row.empty:
        raise ValueError(f"age {x} is not in the basis")
    if n:
        val = float(row[f"äx:{n}"].iloc[0])
        return val if due else val - (1 - float(row[f"{n}Ex"].iloc[0]))
    return float(row["äx" if due else "ax"].iloc[0])


def assurance(x: int, basis: Basis = None, df: Optional[pd.DataFrame] = None, *, i: float = 0.04, n: Optional[int] = None, endowment: bool = False, **kw: Any) -> float:
    """One number: Ax (whole life), A¹x:n (term, ``n`` given) or Ax:n (``endowment=True``)."""
    f = factors(basis, df, i=i, n=n, **kw)
    row = f[f["age"] == x]
    if row.empty:
        raise ValueError(f"age {x} is not in the basis")
    if n:
        return float(row[f"Ax:{n}" if endowment else f"A¹x:{n}"].iloc[0])
    return float(row["Ax"].iloc[0])


@tool
def premium(basis: Basis = None, df: Optional[pd.DataFrame] = None, *, i: float = 0.04, product: str = "term", ages: Any = None, step: int = 5,
            terms: Sequence[int] = (10, 15, 20, 25, 30), per: float = 1000.0, **kw: Any) -> Table:
    """Annual net (equivalence-principle) premium per ``per`` of sum assured: age × term grid, payable in advance.

    ``product`` = term / endowment / whole-life. P = per·A/ä with no expense
    loading and no margin: a pure risk premium.
    """
    product = {"endow": "endowment", "whole": "whole-life"}.get(product.lower()[:5], product.lower())
    if product not in ("term", "endowment", "whole-life"):
        raise ValueError("product must be term, endowment or whole-life")
    ar = _ages_arg(ages) or (20, 65)
    lo, hi = (ar[0] if ar[0] is not None else 20), (ar[1] if ar[1] is not None else 65)
    terms = list(terms) if terms else [10, 15, 20, 25, 30]
    max_term = max(terms)
    want = (min(lo, 20), max(hi + max_term, 110)) if (basis is None or isinstance(basis, (str, dict))) and df is None else None
    q = qx(basis, df, ages=want, **kw)
    L = _life_cols(q, 100_000)
    C = _commutation(L, i)
    Dx, Nx, Mx = C["Dx"], C["Nx"], C["Mx"]
    pos = {int(a): k for k, a in enumerate(L["age"])}
    rows = []
    for a in range(lo, hi + 1, step):
        k = pos.get(a)
        if k is None:
            continue
        row: Dict[str, Any] = {"age": a}
        if product == "whole-life":
            row["whole life"] = per * Mx[k] / Nx[k]
        else:
            for n in terms:
                kn = k + n
                if kn >= len(Dx):
                    row[f"n={n}"] = np.nan
                    continue
                adue = (Nx[k] - Nx[kn]) / Dx[k]
                term = (Mx[k] - Mx[kn]) / Dx[k]
                endow = term + Dx[kn] / Dx[k]
                row[f"n={n}"] = per * (endow if product == "endowment" else term) / adue
        rows.append(row)
    if not rows:
        raise ValueError("no ages in the requested range are covered by the mortality basis")
    label = {"term": "term assurance", "endowment": "endowment", "whole-life": "whole-life"}[product]
    return Table(pd.DataFrame(rows), title=f"Net premium per {per:,.0f} SA · {label} · {q.label} · i = {_pct(i)}",
                 basis=f"{label} · {q.label} · i = {_pct(i)}", stage="hard",
                 notes=[*q.notes, f"Annual net (equivalence-principle) premium per {per:,.0f} sum assured, payable in advance throughout the term (whole of life for whole-life): P = {per:,.0f}·A/ä. No expense loading, no profit margin: a pure risk premium.", f"Interest {_pct(i)}."])


@tool
def ae(df: pd.DataFrame, expected: Basis = None, *, age: Optional[str] = None, deaths: Optional[str] = None, exposure: Optional[str] = None,
       band: int = 5, by: Optional[str] = None) -> Table:
    """Actual vs expected by age band: exposure, actual, expected = Σ exposure × qx(basis), A/E, crude qx, with a total row.

    ``expected`` defaults to the illustrative Makeham basis; pass a qx
    DataFrame / Series or a standard table. ``by`` adds a grouping column.
    """
    a = infer(df, "age", age)
    d = infer(df, "deaths", deaths, exclude=[a])
    e = infer(df, "exposure", exposure, exclude=[a, d])
    work = pd.DataFrame({"age": pd.to_numeric(df[a], errors="coerce").round(), "d": pd.to_numeric(df[d], errors="coerce"),
                         "e": pd.to_numeric(df[e], errors="coerce")})
    if by:
        work["by"] = df[by].values
    work = work.dropna(subset=["age", "e"])
    work["d"] = work["d"].fillna(0)
    lo, hi = int(work["age"].min()), int(work["age"].max())
    q = qx(expected, None if isinstance(expected, (pd.DataFrame, pd.Series, QxTable, dict, str)) else df, ages=(lo, hi)) if expected is not None else qx("makeham", ages=(lo, hi))
    q_at = pd.Series(q.qx, index=q.ages)
    work["x"] = work["e"] * work["age"].map(q_at).fillna(0.0)
    work["band"] = (work["age"] // band * band).astype(int)
    keys = ["by", "band"] if by else ["band"]
    g = work.groupby(keys)[["e", "d", "x"]].sum().reset_index()
    g["age band"] = g["band"].map(lambda b: f"{b}–{b + band - 1}")
    g["A/E"] = np.where(g["x"] > 0, g["d"] / g["x"], np.nan)
    g["crude qx"] = np.where(g["e"] > 0, g["d"] / g["e"], np.nan)
    cols = ([by] if by else []) + ["age band", "exposure", "actual deaths", "expected deaths", "A/E", "crude qx"]
    g = g.rename(columns={"e": "exposure", "d": "actual deaths", "x": "expected deaths", "by": by or "by"})
    out = g[cols]
    tot = {"age band": "total", "exposure": work["e"].sum(), "actual deaths": work["d"].sum(), "expected deaths": work["x"].sum()}
    tot["A/E"] = tot["actual deaths"] / tot["expected deaths"] if tot["expected deaths"] > 0 else np.nan
    tot["crude qx"] = tot["actual deaths"] / tot["exposure"] if tot["exposure"] > 0 else np.nan
    if by:
        tot[by] = "all"
    out = pd.concat([out, pd.DataFrame([tot])], ignore_index=True)
    return Table(out, title=f"Actual vs expected · {d} / {e} vs {q.label}", basis=f"expected: {q.label}", stage="hard",
                 notes=[*q.notes, f"Expected deaths = exposure × qx(expected basis) at each age, summed into {band}-year bands. A/E > 1 means heavier mortality than the basis."])


@tool
def model_points(df: pd.DataFrame, *, age: Optional[str] = None, sex: Optional[str] = None, term: Optional[str] = None,
                 sum_assured: Optional[str] = None, premium_col: Optional[str] = None, band: int = 5) -> Table:
    """Group a policy file into model points by age band × sex × term: count, total sum assured, mean premium, mean age.

    Output matches lifelib's basic_term model-point table so it feeds
    BasicTerm / IFRS 17 / SCR runs directly.
    """
    a = infer(df, "age", age)
    s = infer(df, "sex", sex, required=False)
    t = infer(df, "policy_term", term, required=False, exclude=[a])
    sa = infer(df, "sum_assured", sum_assured, required=False)
    pr = infer(df, "premium", premium_col, required=False)
    work = pd.DataFrame({"age": pd.to_numeric(df[a], errors="coerce")}).dropna()
    work["band"] = (work["age"] // band * band).astype(int)
    work["sex"] = df.loc[work.index, s].map(lambda v: (str(v).strip().upper()[:1] or "?") if pd.notna(v) else "?") if s else "all"
    work["term"] = pd.to_numeric(df.loc[work.index, t], errors="coerce") if t else np.nan
    work["sa"] = pd.to_numeric(df.loc[work.index, sa], errors="coerce").fillna(0) if sa else 0.0
    work["prem"] = pd.to_numeric(df.loc[work.index, pr], errors="coerce").fillna(0) if pr else 0.0
    g = work.groupby(["band", "sex", "term"], dropna=False).agg(n=("age", "size"), age=("age", "mean"), sa=("sa", "sum"), prem=("prem", "mean")).reset_index()
    g = g.sort_values(["band", "sex", "term"]).reset_index(drop=True)
    out = pd.DataFrame({
        "model_point_id": [f"MP{i + 1:04d}" for i in range(len(g))],
        "age_band": g["band"].map(lambda b: f"{b}–{b + band - 1}"),
        "age_at_entry": g["age"].round().astype(int),
        "sex": g["sex"],
        "policy_term": g["term"],
        "policy_count": g["n"],
        "sum_assured": g["sa"],
        "premium_pp": g["prem"],
    })
    return Table(out, title=f"Model points · {len(df):,} policies → {len(out)} groups", basis=f"{band}y bands", stage="hard", notes=[
        f"Grouped by {band}-year age band{' × sex' if s else ''}{' × policy term' if t else ''}: policy_count = policies in the group, sum_assured = total, premium_pp = mean per policy, age_at_entry = group mean (rounded). Shape matches lifelib's basic_term model-point table.",
        "Grouping loses within-band heterogeneity: validate a liability metric on grouped vs seriatim before relying on it.",
    ])


# ── survival helpers ────────────────────────────────────────────────────────

def survival(q: Union[pd.Series, Sequence[float]], t: Optional[int] = None) -> Union[pd.Series, float]:
    """tpx from a qx vector: the survival curve (Series) or a single t-year probability from the first age."""
    qs = pd.Series(q, dtype=float)
    p = np.cumprod(1 - qs.to_numpy())
    s = pd.Series(np.concatenate([[1.0], p]), index=range(len(qs) + 1), name="tpx")
    return float(s.iloc[t]) if t is not None else s


def life_expectancy(q: Union[pd.Series, Sequence[float]], curtate: bool = False) -> float:
    """Complete (ex, uniform deaths) or curtate life expectancy from the qx vector of one life."""
    qs = np.asarray(pd.Series(q, dtype=float).to_numpy())
    p = np.cumprod(1 - qs)
    curt = float(p.sum())
    return curt if curtate else curt + 0.5


def close_table(q: pd.Series, omega: Optional[int] = None) -> pd.Series:
    """Set qx = 1 at the last age (or at ``omega``), truncating beyond it."""
    s = q.copy()
    if omega is not None:
        s = s[s.index <= omega]
    s.iloc[-1] = 1.0
    return s


def mx_to_qx(mx: Union[pd.Series, Sequence[float]], assumption: str = "uniform") -> pd.Series:
    """Central rate → initial rate: q = m/(1 + m/2) under uniform deaths, 1 − e^{−m} under a constant force."""
    m = pd.Series(mx, dtype=float)
    q = m / (1 + m / 2) if assumption == "uniform" else 1 - np.exp(-m)
    return q.clip(0, 1).rename("qx")


def qx_to_mx(q: Union[pd.Series, Sequence[float]], assumption: str = "uniform") -> pd.Series:
    """Initial rate → central rate: m = q/(1 − q/2) under uniform deaths, −ln(1 − q) under a constant force."""
    qq = pd.Series(q, dtype=float)
    m = qq / (1 - qq / 2) if assumption == "uniform" else -np.log(1 - qq)
    return m.rename("mx")


def epv(cashflows: Sequence[float], x: int, basis: Basis = None, df: Optional[pd.DataFrame] = None, *, i: float = 0.04, due: bool = True,
        on_death: bool = False, **kw: Any) -> float:
    """Expected present value of a life-contingent cash-flow vector for a life aged x: Σ cf_t · vᵗ · tpx (survival) or Σ cf_t · vᵗ⁺¹ · tpx·q_{x+t} (death).

    ``cashflows[t]`` is paid at time t (``due=True``) or t+1 while the life
    survives; with ``on_death=True`` it is paid at the end of the year of
    death in year t. Any mortality basis accepted by :func:`qx`.
    """
    q = qx(basis, df, **kw)
    pos = {int(a): k for k, a in enumerate(q.ages)}
    if x not in pos:
        raise ValueError(f"age {x} is not in the basis")
    k0 = pos[x]
    qs = np.asarray(q.qx[k0:], dtype=float).copy()
    qs[-1] = 1.0  # close the table, as life_table / factors do
    cf = np.asarray(cashflows, dtype=float)
    n = min(len(cf), len(qs))
    tpx = np.concatenate([[1.0], np.cumprod(1 - qs[:n])])[:n]
    vv = 1 / (1 + i)
    t = np.arange(n)
    if on_death:
        return float(np.sum(cf[:n] * vv ** (t + 1) * tpx * qs[:n]))
    return float(np.sum(cf[:n] * vv ** (t if due else t + 1) * (tpx if due else tpx * (1 - qs[:n]))))


def ae_test(actual: float, expected: float, *, exposure: Optional[float] = None) -> Dict[str, float]:
    """Is A/E significantly different from 1? Poisson z-test z = (A − E)/√E with its two-sided p-value, and the 95 % interval for A/E."""
    a, e = float(actual), float(expected)
    if e <= 0:
        raise ValueError("expected must be positive")
    z = (a - e) / math.sqrt(e)
    p = 2 * (1 - _norm_cdf(abs(z)))
    return {"ae": a / e, "z": z, "p_value": p, "lower95": (a - 1.96 * math.sqrt(a)) / e, "upper95": (a + 1.96 * math.sqrt(a)) / e}


def _norm_cdf(z: float) -> float:
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


# ── graduation ──────────────────────────────────────────────────────────────

@tool
def graduate(crude: Union[pd.Series, pd.DataFrame], weights: Optional[Sequence[float]] = None, *, h: float = 100.0, z: int = 2,
             log: bool = True) -> Table:
    """Whittaker–Henderson graduation: minimise Σ w (g − u)² + h Σ (Δᶻ g)². Returns crude, graduated qx and the residuals.

    ``crude`` is qx by age (Series) or a DataFrame with age + deaths + exposure
    (weights default to exposure). Graduates log qx by default (``log=True``)
    so the smoothed rates stay positive; h = smoothness, z = difference order.
    """
    if isinstance(crude, pd.DataFrame):
        q = qx(None, crude)
        u = q.series()
        if weights is None:
            a = infer(crude, "age")
            e = infer(crude, "exposure", required=False)
            if e:
                w = pd.DataFrame({"a": pd.to_numeric(crude[a], errors="coerce").round(), "e": pd.to_numeric(crude[e], errors="coerce")}).dropna().groupby("a")["e"].sum()
                weights = w.reindex(u.index).fillna(0).to_numpy()
    else:
        u = pd.Series(crude, dtype=float)
    ages = np.asarray(u.index, dtype=float)
    y = u.to_numpy(dtype=float)
    n = y.size
    w = np.ones(n) if weights is None else np.asarray(weights, dtype=float)
    w = np.where(np.isfinite(w) & (w > 0), w, 0.0)
    if log:
        ok = y > 0
        yy = np.where(ok, np.log(np.where(ok, y, 1)), 0.0)
        w = np.where(ok, w, 0.0)
    else:
        yy = y
    w = w / w[w > 0].mean() if (w > 0).any() else w
    K = np.eye(n)
    for _ in range(z):
        K = np.diff(K, axis=0)
    A = np.diag(w) + h * (K.T @ K)
    g = np.linalg.solve(A, w * yy)
    grad = np.exp(g) if log else g
    out = pd.DataFrame({"age": ages.astype(int) if np.all(ages == np.round(ages)) else ages, "crude": y, "graduated": grad, "residual": y - grad,
                        "weight": w})
    return Table(out, title=f"Whittaker–Henderson graduation · h = {h:g}, z = {z}", basis=f"WH(h={h:g}, z={z}){' on log qx' if log else ''}", stage="hard", notes=[
        "Minimises Σ w·(graduated − crude)² + h·Σ(Δᶻ graduated)²: larger h smooths harder; z = 2 penalises curvature, z = 3 penalises change of curvature.",
        "Check the residual signs and a chi-square / runs test before adopting; a graduation that drifts from the crude rates at the old ages is the usual failure.",
    ])


# ── Lee–Carter ──────────────────────────────────────────────────────────────

@dataclass
class LeeCarterResult:
    ax: pd.Series
    bx: pd.Series
    kt: pd.Series
    drift: float
    drift_se: float
    forecast: Table
    explained: float

    def __repr__(self) -> str:  # pragma: no cover
        return (f"Lee–Carter: {len(self.ax)} ages × {len(self.kt)} years · drift {self.drift:.4f} (se {self.drift_se:.4f}) · "
                f"first SVD component explains {self.explained:.1%}\n" + repr(self.forecast))


@tool
def lee_carter(df: pd.DataFrame, *, year: Optional[str] = None, age: Optional[str] = None, rate: Optional[str] = None,
               horizon: int = 10, headline_age: int = 65) -> LeeCarterResult:
    """Lee–Carter on a long (year, age, qx or mx) file: SVD fit of log m = a_x + b_x k_t, random-walk-with-drift forecast.

    Constraints Σ b_x = 1, Σ k_t = 0. The forecast table gives the projected
    rate at ``headline_age`` with a 95 % interval (drift uncertainty and
    innovation variance), plus the implied annual improvement.
    """
    y = infer(df, "year", year)
    a = infer(df, "age", age, exclude=[y])
    r = rate or infer(df, "qx", None, required=False, exclude=[y, a]) or infer(df, "mx", None, exclude=[y, a])
    work = pd.DataFrame({"year": pd.to_numeric(df[y], errors="coerce"), "age": pd.to_numeric(df[a], errors="coerce"), "m": pd.to_numeric(df[r], errors="coerce")}).dropna()
    work = work[work["m"] > 0]
    piv = work.pivot_table(index="year", columns="age", values="m", aggfunc="mean")
    piv = piv.dropna(axis=1, how="any")
    if piv.shape[0] < 3 or piv.shape[1] < 2:
        raise ValueError("Lee–Carter needs at least 3 years × 2 ages with positive rates")
    M = np.log(piv.to_numpy())
    ax_ = M.mean(axis=0)
    C = M - ax_
    U, S, Vt = np.linalg.svd(C, full_matrices=False)
    b_raw = Vt[0]
    k_raw = U[:, 0] * S[0]
    s = b_raw.sum()
    bx_ = b_raw / s
    kt_ = k_raw * s
    kt_ = kt_ - kt_.mean()
    explained = float(S[0] ** 2 / np.sum(S ** 2))
    dk = np.diff(kt_)
    drift = float(dk.mean())
    sigma = float(dk.std(ddof=1)) if dk.size > 1 else 0.0
    drift_se = sigma / math.sqrt(dk.size) if dk.size else 0.0
    years = piv.index.to_numpy()
    ages = piv.columns.to_numpy()
    h = np.arange(1, horizon + 1)
    k_fc = kt_[-1] + drift * h
    k_sd = np.sqrt(h * sigma ** 2 + (h * drift_se) ** 2)
    ages_i = ages.astype(int)
    ha = headline_age if headline_age in ages_i else int(ages_i[np.argmin(np.abs(ages_i - headline_age))])
    j = int(np.where(ages_i == ha)[0][0])
    m_now = math.exp(ax_[j] + bx_[j] * kt_[-1])
    m_fc = np.exp(ax_[j] + bx_[j] * k_fc)
    lo = np.exp(ax_[j] + bx_[j] * (k_fc - 1.96 * k_sd * np.sign(bx_[j])))
    hi = np.exp(ax_[j] + bx_[j] * (k_fc + 1.96 * k_sd * np.sign(bx_[j])))
    fc = pd.DataFrame({"year": (years[-1] + h).astype(int), "kt": k_fc, f"rate@{ha}": m_fc, "lower95": np.minimum(lo, hi), "upper95": np.maximum(lo, hi)})
    improvement = 1 - (m_fc[-1] / m_now) ** (1 / horizon)
    t = Table(fc, title=f"Lee–Carter forecast · age {ha} · {horizon}y", basis=f"SVD fit on {len(years)} years × {len(ages)} ages · RWD drift {drift:.4f}", stage="hard", notes=[
        f"log m(x,t) = a_x + b_x·k_t with Σb = 1, Σk = 0; k_t projected as a random walk with drift {drift:.4f} (σ {sigma:.4f}); interval = ±1.96·√(h·σ² + (h·se_drift)²).",
        f"Implied annual improvement at age {ha}: {improvement:.2%} (first component explains {explained:.1%} of the log-rate variance).",
    ])
    return LeeCarterResult(pd.Series(ax_, index=ages_i, name="ax"), pd.Series(bx_, index=ages_i, name="bx"), pd.Series(kt_, index=years.astype(int), name="kt"), drift, drift_se, t, explained)


# ── Kaplan–Meier ────────────────────────────────────────────────────────────

@tool
def kaplan_meier(df: pd.DataFrame, *, duration: Optional[str] = None, event: Optional[str] = None, by: Optional[str] = None) -> Table:
    """Kaplan–Meier survival: time, at risk, events, censored, S(t), Greenwood SE and 95 % log-log bounds (optionally per group)."""
    d = infer(df, "duration", duration)
    e = infer(df, "event", event, exclude=[d])
    work = pd.DataFrame({"t": pd.to_numeric(df[d], errors="coerce"), "e": df[e].map(lambda v: 1 if str(v).strip().lower() in ("1", "true", "yes", "y", "dead", "died", "event", "claim", "lapsed") else 0)})
    if by:
        work["g"] = df[by].values
    work = work.dropna(subset=["t"])
    frames = []
    for g, sub in (work.groupby("g") if by else [("all", work)]):
        sub = sub.sort_values("t")
        times = np.unique(sub.loc[sub["e"] == 1, "t"])
        n_at = len(sub)
        S, var_acc = 1.0, 0.0
        rows = []
        for tt in times:
            at_risk = int((sub["t"] >= tt).sum())
            d_t = int(((sub["t"] == tt) & (sub["e"] == 1)).sum())
            c_t = int(((sub["t"] == tt) & (sub["e"] == 0)).sum())
            S *= 1 - d_t / at_risk
            if at_risk - d_t > 0:
                var_acc += d_t / (at_risk * (at_risk - d_t))
            se = S * math.sqrt(var_acc)
            if 0 < S < 1:
                z = 1.96 * math.sqrt(var_acc) / abs(math.log(S))
                lo, hi = S ** math.exp(z), S ** math.exp(-z)
            else:
                lo = hi = S
            rows.append({"time": tt, "at_risk": at_risk, "events": d_t, "censored": c_t, "S": S, "se": se, "lower95": lo, "upper95": hi})
        f = pd.DataFrame(rows)
        if by:
            f.insert(0, by, g)
        frames.append(f)
    out = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    return Table(out, title="Kaplan–Meier survival" + (f" by {by}" if by else ""), basis=f"{d} / {e}", stage="hard", notes=[
        "S(t) = Π (1 − d_j/n_j) over event times ≤ t; SE by Greenwood; 95 % bounds on the log(−log S) scale.",
    ])


# ── exposure ────────────────────────────────────────────────────────────────

@tool
def exposure(df: pd.DataFrame, start: str, end: str, *, birth: Optional[str] = None, age_col: Optional[str] = None, event: Optional[str] = None,
             by_year: bool = False, age_basis: str = "last") -> Table:
    """Central exposure by age (and calendar year) in policy-years, from start / end dates, with deaths if ``event`` is given.

    Age is attained age from ``birth`` (or the entry ``age_col`` advanced
    from ``start``); each policy's time at risk is split across the
    integer ages (age last birthday) it passes through.
    """
    s = pd.to_datetime(df[start], errors="coerce")
    e = pd.to_datetime(df[end], errors="coerce")
    if birth:
        b = pd.to_datetime(df[birth], errors="coerce")
        age0 = (s - b).dt.days / 365.25
    else:
        a = infer(df, "age", age_col)
        age0 = pd.to_numeric(df[a], errors="coerce").astype(float)
    ev = df[event].map(lambda v: 1 if str(v).strip().lower() in ("1", "true", "yes", "y", "dead", "died", "event", "claim") else 0) if event else pd.Series(0, index=df.index)
    rows: Dict[Tuple[int, int], List[float]] = {}
    for i in df.index:
        if pd.isna(s[i]) or pd.isna(e[i]) or pd.isna(age0[i]) or e[i] <= s[i]:
            continue
        t0 = 0.0
        total = (e[i] - s[i]).days / 365.25
        age_now = float(age0[i])
        while t0 < total - 1e-9:
            a_int = int(math.floor(age_now + 1e-9))
            to_next_age = (a_int + 1) - age_now
            step = min(to_next_age, total - t0)
            yr = (s[i] + pd.Timedelta(days=t0 * 365.25)).year if by_year else 0
            key = (a_int, yr)
            rec = rows.setdefault(key, [0.0, 0.0])
            rec[0] += step
            t0 += step
            age_now += step
        if ev[i] == 1:
            a_end = int(math.floor(age_now - 1e-9))
            yr = e[i].year if by_year else 0
            rows.setdefault((a_end, yr), [0.0, 0.0])[1] += 1
    out = pd.DataFrame([{"age": k[0], **({"year": k[1]} if by_year else {}), "exposure": v[0], "deaths": v[1]} for k, v in sorted(rows.items())])
    if not out.empty:
        out["crude_qx"] = np.where(out["exposure"] > 0, out["deaths"] / out["exposure"], np.nan)
    return Table(out, title="Central exposure by age" + (" × year" if by_year else ""), basis="policy-years, age last birthday", stage="hard", notes=[
        "Exposure in policy-years split at each birthday; deaths are allocated to the age at exit. Crude qx = deaths / exposure is a central rate (m_x); convert with q = m/(1 + m/2) if an initial rate is needed.",
    ])


# ── BasicTerm projection (lifelib basiclife port) ──────────────────────────

@dataclass
class BasicTermAssumptions:
    """Scelo's illustrative BasicTerm assumptions (apps/web lifelibBasicTerm.ts DEFAULT_ASSUMPTIONS)."""

    mort_A: float = 0.00022
    mort_B: float = 2.7e-6
    mort_c: float = 1.124
    lapse_rate: float = 0.05
    expense_acq_pp: float = 100.0
    expense_maint_pp_mth: float = 5.0
    disc_rate: float = 0.03
    pricing_loading: float = 1.12


@tool
def basicterm(mp: pd.DataFrame, assumptions: Optional[BasicTermAssumptions] = None, *, max_months: int = 1200) -> Table:
    """Monthly term-life projection of a model-point file (lifelib BasicTerm_ME semantics, pure numpy).

    Columns inferred: age_at_entry, sum_assured, policy_term, and optionally
    sex, policy_count, duration_mth, premium_pp. Mortality is Makeham
    q = clamp(A + B·cˣ, 0, 0.95) converted to monthly; level annual lapse;
    acquisition expense once at issue, maintenance monthly; premiums default
    to SA·q/12·loading when the file has none. Returns the aggregate monthly
    cash flows with PVs and the break-even month in the notes.
    """
    asm = assumptions or BasicTermAssumptions()
    a = infer(mp, "age", None)
    sa = infer(mp, "sum_assured", None)
    tm = infer(mp, "policy_term", None, exclude=[a])
    cnt = infer(mp, "count", None, required=False)
    dur = next((c for c in mp.columns if str(c).lower().replace("_", "") in ("durationmth", "durationmonths", "duration", "durmth", "elapsedmth")), None)
    prem = infer(mp, "premium", None, required=False)
    age0 = pd.to_numeric(mp[a], errors="coerce").to_numpy(dtype=float)
    sum_assured = pd.to_numeric(mp[sa], errors="coerce").to_numpy(dtype=float)
    term_y = pd.to_numeric(mp[tm], errors="coerce").to_numpy(dtype=float)
    count = pd.to_numeric(mp[cnt], errors="coerce").fillna(1).to_numpy(dtype=float) if cnt else np.ones(len(mp))
    duration = pd.to_numeric(mp[dur], errors="coerce").fillna(0).to_numpy(dtype=float) if dur else np.zeros(len(mp))
    ok = np.isfinite(age0) & np.isfinite(sum_assured) & np.isfinite(term_y) & (age0 > 0) & (sum_assured > 0) & (term_y > 0)
    dropped = int((~ok).sum())
    age0, sum_assured, term_y, count, duration = age0[ok], sum_assured[ok], term_y[ok], count[ok], duration[ok]
    n = age0.size
    if n == 0:
        raise ValueError("no usable model points: need age_at_entry, sum_assured and policy_term > 0")

    def q_annual(x: np.ndarray) -> np.ndarray:
        return np.clip(asm.mort_A + asm.mort_B * asm.mort_c ** x, 0, 0.95)

    if prem:
        premium_pp = pd.to_numeric(mp.loc[ok, prem], errors="coerce").fillna(0).to_numpy(dtype=float)
        if "annual" in str(prem).lower() or str(prem).lower().endswith("_pa"):
            premium_pp = premium_pp / 12
        source = "model-point file"
    else:
        premium_pp = np.maximum(sum_assured * (q_annual(age0) / 12) * asm.pricing_loading, 0.01)
        source = "SA × q(x0)/12 × loading"
    term_m = np.floor(term_y * 12) - duration
    horizon = int(min(max_months, max(1, np.nanmax(term_m))))
    lapse_m = 1 - (1 - asm.lapse_rate) ** (1 / 12)
    pols = count.astype(float).copy()
    prem_cf = np.zeros(horizon)
    claim_cf = np.zeros(horizon)
    exp_cf = np.zeros(horizon)
    net_cf = np.zeros(horizon)
    disc = (1 + asm.disc_rate) ** (-np.arange(horizon) / 12)
    for t in range(horizon):
        active = (t < term_m) & (pols > 1e-8)
        if not active.any():
            prem_cf, claim_cf, exp_cf, net_cf = prem_cf[:t], claim_cf[:t], exp_cf[:t], net_cf[:t]
            disc = disc[:t]
            break
        age_now = age0 + (duration + t) / 12
        qm = 1 - (1 - q_annual(age_now)) ** (1 / 12)
        pd_ = np.where(active, pols * qm, 0.0)
        pl = np.where(active, (pols - pd_) * lapse_m, 0.0)
        claims = pd_ * sum_assured
        prems = np.where(active, pols * premium_pp, 0.0)
        acq = np.where(active & (t == 0) & (duration == 0), asm.expense_acq_pp * pols, 0.0)
        exps = acq + np.where(active, pols * asm.expense_maint_pp_mth, 0.0)
        prem_cf[t], claim_cf[t], exp_cf[t] = prems.sum(), claims.sum(), exps.sum()
        net_cf[t] = prem_cf[t] - claim_cf[t] - exp_cf[t]
        pols = np.where(active, pols - pd_ - pl, pols)
    out = pd.DataFrame({"month": np.arange(len(net_cf)), "premiums": prem_cf, "claims": claim_cf, "expenses": exp_cf, "net_cf": net_cf,
                        "discount": disc, "pv_net_cf": net_cf * disc})
    pv = {k: float((v * disc).sum()) for k, v in (("premiums", prem_cf), ("claims", claim_cf), ("expenses", exp_cf), ("net", net_cf))}
    cum = np.cumsum(net_cf)
    be = next((int(t) for t in range(1, len(cum)) if cum[t] >= 0), None)
    t = Table(out, title=f"BasicTerm projection · {n:,} model points · {len(net_cf)} months", basis=f"lifelib basiclife/BasicTerm_ME semantics · premiums: {source}", stage="hard", notes=[
        f"PV net cash flow {pv['net']:,.0f} = premiums {pv['premiums']:,.0f} − claims {pv['claims']:,.0f} − expenses {pv['expenses']:,.0f} at {asm.disc_rate:.1%} p.a.; break-even month {be if be is not None else 'never'}.",
        f"Makeham q = clamp(A + B·cˣ, 0, 0.95) with A = {asm.mort_A}, B = {asm.mort_B}, c = {asm.mort_c}; lapse {asm.lapse_rate:.0%} p.a.; acquisition {asm.expense_acq_pp:g} per policy at issue, maintenance {asm.expense_maint_pp_mth:g} per policy-month. Illustrative assumptions, not a priced basis.",
    ] + ([f"{dropped} model points dropped (missing or non-positive age / sum assured / term)."] if dropped else []))
    t.attrs["pv"] = pv
    t.attrs["break_even_month"] = be
    return t
