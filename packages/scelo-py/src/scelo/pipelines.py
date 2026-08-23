"""One-liners: whole workflows as single calls, Stata-style.

``reserve("claims.csv")`` (in reserving), ``experience("deaths.csv")``,
``price("policies.csv", "claims ~ C(region)")`` and ``quick("file")`` each
run a complete, audited chain and hand back hard tables.
"""

from __future__ import annotations

import os
from typing import Any, Optional, Sequence, Union

import pandas as pd

from ._alias import infer
from ._audit import tool
from ._table import Table
from .clean import clean
from .io import load
from .life import ae, graduate, life_table, qx
from .pricing import freq_sev, glm, relativities
from .profile import describe, profile
from .reserving import reserve

__all__ = ["experience", "price", "quick", "cheatsheet", "CHEATSHEET"]


def _frame(x: Union[str, os.PathLike, pd.DataFrame]) -> pd.DataFrame:
    return x if isinstance(x, pd.DataFrame) else load(x)


@tool
def experience(data: Union[str, os.PathLike, pd.DataFrame], expected: Any = None, *, h: float = 100.0, band: int = 5, **cols: Any) -> Table:
    """Mortality experience study in one line: A/E by age band against a basis, Whittaker–Henderson graduated crude rates, and the resulting life table.

    ``data`` needs age + deaths + exposure columns (inferred, or pass
    ``age= deaths= exposure=``). Returns the A/E table with the graduated
    qx in ``attrs["graduated"]`` and the life table in ``attrs["life_table"]``.
    """
    df = _frame(data)
    a = infer(df, "age", cols.get("age"))
    d = infer(df, "deaths", cols.get("deaths"), exclude=[a])
    e = infer(df, "exposure", cols.get("exposure"), exclude=[a, d])
    aet = ae(df, expected, age=a, deaths=d, exposure=e, band=band)
    g = graduate(df[[a, d, e]].rename(columns={a: "age", d: "deaths", e: "exposure"}), h=h)
    gq = pd.Series(g["graduated"].to_numpy(), index=g["age"].to_numpy(), name="qx")
    lt = life_table(gq)
    aet.notes.append(f"Graduated crude rates (WH h={h:g}) and the life table on them sit in attrs['graduated'] / attrs['life_table']; e({int(lt['age'].iloc[0])}) = {lt['ex'].iloc[0]:.2f} on the graduated basis.")
    aet.attrs["graduated"] = g
    aet.attrs["life_table"] = lt
    return aet


@tool
def price(data: Union[str, os.PathLike, pd.DataFrame], formula: str, *, family: str = "poisson", offset: Optional[str] = None, severity: Optional[str] = None,
          by: Optional[Union[str, Sequence[str]]] = None) -> Table:
    """Frequency (and optionally severity) GLM in one line, returning the relativities table with the models in ``attrs``.

    ``price(df, "claims ~ C(region) + age", offset="exposure", severity="paid")``
    fits Poisson frequency and Gamma severity on the same right-hand side
    and multiplies the relativities into a pure-premium table.
    """
    df = _frame(data)
    freq = glm(df, formula, family, offset=offset)
    rel = relativities(freq)
    out = rel.rename(columns={"relativity": "frequency"})
    sev_model = None
    if severity:
        rhs = formula.split("~", 1)[1]
        sev_model = glm(df[pd.to_numeric(df[severity], errors="coerce") > 0], f"{severity} ~{rhs}", "gamma")
        srel = relativities(sev_model).rename(columns={"relativity": "severity"})
        out = out.merge(srel[["factor", "level", "severity"]], on=["factor", "level"], how="left")
        out["pure_premium"] = out["frequency"] * out["severity"]
    t = Table(out.drop(columns=["estimate"], errors="ignore"), title=f"Pricing relativities · {formula}", basis=f"frequency {family} base {rel.attrs['base_rate']:.4g}" + (f" · severity gamma base {relativities(sev_model).attrs['base_rate']:.4g}" if sev_model else ""), stage="hard", notes=[
        "Relativities multiply: rate = base × Π relativity(level). Base levels are the most frequent level of each factor.",
    ])
    t.attrs.update(frequency=freq, severity=sev_model, summary=freq_sev(df, by, count=formula.split("~")[0].strip(), amount=severity, exposure=offset) if (by or severity) else None)
    return t


def quick(data: Union[str, os.PathLike, pd.DataFrame]) -> Table:
    """Load, profile and describe in one go: what is in this file and what it needs (the cleaning plan is in ``attrs["plan"]``)."""
    from .clean import suggest

    df = _frame(data)
    p = profile(df)
    try:
        d = describe(df)
    except ValueError:
        d = None
    plan = suggest(df)
    p.notes.extend([f"Cleaning plan: {len(plan)} op(s) ({int(plan['safe'].sum()) if len(plan) else 0} safe); see attrs['plan'].",
                    *([f"Widest relative spread: `{d['column'].iloc[0]}` (CV {d['cv'].iloc[0]:.2f})."] if d is not None and d["cv"].notna().any() else [])])
    p.attrs.update(plan=plan, describe=d)
    return p


CHEATSHEET = """\
scelo · soft data → tools → hard data                 import scelo as sc
──────────────────────────────────────────────────────────────────────────
SOFT    df = sc.load("x.csv")        sc.profile(df)   sc.describe(df)   sc.tab(df,"line")
        sc.suggest(df)               sc.clean(df)     sc.clean(df,"all")  sc.combine(a,b)
TOOLS   life      sc.life_table()  sc.commutation(i=.04)  sc.factors(i=.04,n=10)  sc.premium()
                  sc.ae(df)  sc.ae_test(a,e)  sc.graduate(qx)  sc.lee_carter(df)  sc.kaplan_meier(df)  sc.basicterm(mp)
                  sc.epv(cf, x, i=.04)  sc.mx_to_qx(m)  sc.exposure(df, "start", "end")
        reserving sc.triangle(df)  sc.chain_ladder(tri)  sc.mack(tri)  sc.bf(tri)  sc.bootstrap(tri)
                  sc.reserve("claims.csv")
        finance   sc.discount_curve(.04)  sc.smith_wilson(t,r)  sc.pv(cf,.05)  sc.irr(cf)  sc.annuity_certain(10,.05)
                  sc.nominal(i,12)  sc.force(i)  sc.duration(cf,i)  sc.bond_price(100,.05,10,.06)
        risk      sc.var(x)  sc.tvar(x)  sc.aggregate_loss("poisson","lognormal",lam=5,mu=8,sigma=1)
                  sc.fit(x)  sc.credibility(df,"group","lr")  sc.aggregate_scr({...})  sc.risk_margin(scr,.04)
        pricing   sc.glm(df,"claims ~ C(region)+age","poisson",offset="exposure")  .relativities()
                  sc.freq_sev(df,"region")  sc.loss_ratio(df,"line")  sc.lift(y,pred)
        fairness  sc.fairness(df,"y","score","group")  sc.fairness_audit(df,"score","prot",["age"])
        climate   sc.ensemble(df,"t2m")  sc.return_period(x)  sc.parametric_trigger(x)
        forecast  sc.wmtr("pension scheme, weakening covenant")  sc.sensitivity(...)
        swarm     sc.council("…")  sc.society("…")  sc.augment(df,"…")   (needs Scelo IDE / bun run dev:swarm)
HARD    sc.hard(t)  sc.report(t1,t2,to="pack.html")  sc.export(t,"out.xlsx")  sc.audit()  sc.verify(t)
        df.sc.clean()  df.sc.triangle().sc.mack()     ← the same functions as methods
"""


def cheatsheet() -> None:
    """Print the one-screen cheat-sheet."""
    print(CHEATSHEET)
