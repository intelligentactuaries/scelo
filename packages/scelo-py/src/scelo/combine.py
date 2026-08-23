"""Combine: joining and appending datasets with the IDE's rules.

``combine(a, b)`` decides for you: when the schemas overlap it appends (with
exact-duplicate removal), when a shared high-cardinality key with value
overlap exists it left-joins on it. ``suggest_combine`` shows the evidence
behind that decision; ``join`` / ``append`` are the explicit forms; ``diff``
and ``tieout`` compare two frames cell by cell.

Join semantics follow apps/web/src/components/Scelo/combineData.ts: the
key is matched case-insensitively, the first right-hand match wins (a join
never multiplies rows), clashing column names get ``_2``, ``_3`` …
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

import numpy as np
import pandas as pd

from ._audit import tool
from ._table import Table

__all__ = ["combine", "suggest_combine", "join", "append", "diff", "tieout", "stack"]

_ID_LIKE = re.compile(r"(^|_)(id|key|number|no|policy|claim|member|customer|client)s?($|_)", re.I)
_SAMPLE_LIMIT = 5000


def _norm(c: Any) -> str:
    return str(c).strip().lower()


def _aliases(base: pd.DataFrame, other: pd.DataFrame) -> Dict[str, str]:
    """other column → base column with the same normalised name."""
    base_map = {_norm(c): c for c in base.columns}
    return {c: base_map[_norm(c)] for c in other.columns if _norm(c) in base_map}


def _uniqueness(s: pd.Series) -> float:
    head = s.head(_SAMPLE_LIMIT)
    nn = head[~head.isna() & (head.astype(str) != "")]
    return nn.astype(str).nunique() / len(nn) if len(nn) else 0.0


def _overlap(a: pd.Series, b: pd.Series) -> float:
    ha = a.head(_SAMPLE_LIMIT)
    ha = ha[~ha.isna() & (ha.astype(str) != "")].astype(str)
    hb = set(b.head(_SAMPLE_LIMIT).dropna().astype(str))
    return float(ha.isin(hb).mean()) if len(ha) else 0.0


def _keys(base: pd.DataFrame, other: pd.DataFrame) -> List[Dict[str, Any]]:
    out = []
    for oc, bc in _aliases(base, other).items():
        u = max(_uniqueness(base[bc]), _uniqueness(other[oc]))
        if u < 0.9:
            continue
        ov = _overlap(base[bc], other[oc])
        if ov < 0.3:
            continue
        score = ov * u + (0.15 if _ID_LIKE.search(str(bc)) else 0.0)
        out.append({"key": bc, "right_key": oc, "uniqueness": u, "overlap": ov, "score": score})
    return sorted(out, key=lambda k: -k["score"])


@tool
def suggest_combine(base: pd.DataFrame, other: pd.DataFrame) -> Table:
    """The IDE's combine suggestion with its evidence: strategy (append / join-left), key, schema overlap, confidence."""
    al = _aliases(base, other)
    union = base.shape[1] + other.shape[1] - len(al)
    schema_overlap = len(al) / union if union else 0.0
    keys = _keys(base, other)
    best = keys[0] if keys else None
    if schema_overlap >= 0.8 and best and best["overlap"] >= 0.7 and other.shape[1] > len(al):
        strategy, key, conf, dedupe = "join-left", best["key"], 0.75, False
    elif schema_overlap >= 0.8:
        strategy, key, dedupe = "append", None, True
        conf = 0.6 if (best and best["overlap"] >= 0.7) else 0.9
    elif best and best["overlap"] >= 0.5:
        strategy, key, conf, dedupe = "join-left", best["key"], min(0.95, best["score"]), False
    else:
        strategy, key, dedupe = "append", None, False
        conf = 0.5 if schema_overlap >= 0.5 else 0.25
    rows = [{"strategy": strategy, "key": key, "right_key": best["right_key"] if (best and key) else None, "confidence": conf,
             "dedupe_exact": dedupe, "schema_overlap": schema_overlap, "shared_columns": len(al), "candidate_keys": ", ".join(k["key"] for k in keys)}]
    t = Table(pd.DataFrame(rows), title="Combine suggestion", stage="soft", notes=[
        "Append when ≥ 80 % of the columns line up (with exact-duplicate removal); join-left when a ≥ 90 %-unique shared column has ≥ 50 % value overlap. Confidence ≥ 0.7 high, ≥ 0.4 medium.",
    ])
    t.attrs["keys"] = keys
    return t


@tool
def join(base: pd.DataFrame, other: pd.DataFrame, key: Optional[str] = None, right_key: Optional[str] = None, how: str = "left") -> Table:
    """Join ``other`` onto ``base`` on ``key`` (inferred when omitted): first right match wins, clashes renamed ``_2``, ``_3`` …"""
    if key is None:
        ks = _keys(base, other)
        if not ks:
            raise KeyError("no shared key column: pass key=<column>")
        key, right_key = ks[0]["key"], ks[0]["right_key"]
    if key not in base.columns:
        raise KeyError(f"key {key} not in base dataset")
    rk = right_key or next((c for c in other.columns if _norm(c) == _norm(key)), key)
    if rk not in other.columns:
        raise KeyError(f"key {rk} not in second dataset")
    base_set = {_norm(c) for c in base.columns}
    rename: Dict[str, str] = {}
    for c in other.columns:
        if c == rk:
            continue
        name = str(c)
        if _norm(name) in base_set:
            n = 2
            while _norm(f"{c}_{n}") in base_set:
                n += 1
            name = f"{c}_{n}"
        base_set.add(_norm(name))
        rename[c] = name
    right = other.rename(columns=rename)
    rk_vals = right[rk].astype(str)
    valid = ~right[rk].isna() & (rk_vals != "")
    dup_right = int(rk_vals[valid].duplicated().sum())
    right = right[valid].drop_duplicates(subset=[rk], keep="first")
    right = right.rename(columns={rk: "__key__"})
    right["__key__"] = right["__key__"].astype(str)
    left = base.copy()
    left["__key__"] = base[key].astype(str).where(~base[key].isna() & (base[key].astype(str) != ""), None)
    merged = left.merge(right, on="__key__", how="left" if how == "left" else "inner", sort=False)
    matched = int(merged[list(rename.values())[0]].notna().sum()) if rename else len(merged)
    merged = merged.drop(columns=["__key__"])
    t = Table(merged, title=f"{how} join on {key}", stage="soft", notes=[
        f"{matched:,} of {len(base):,} base rows matched; {len(base) - matched:,} unmatched{' kept with nulls' if how == 'left' else ' dropped'}; {dup_right} duplicate right keys ignored (first wins)."
        + (f" Renamed: {', '.join(f'{k}→{v}' for k, v in rename.items() if k != v)}." if any(k != v for k, v in rename.items()) else ""),
    ])
    return t


@tool
def append(base: pd.DataFrame, other: pd.DataFrame, dedupe: bool = True) -> Table:
    """Append ``other`` below ``base``: columns matched case-insensitively, the union kept (base order first), exact duplicates dropped when ``dedupe``."""
    al = _aliases(base, other)
    mapped = other.rename(columns=al)
    new_cols = [c for c in mapped.columns if c not in base.columns]
    out = pd.concat([base, mapped], ignore_index=True, sort=False)[list(base.columns) + new_cols]
    n_before = len(out)
    if dedupe:
        out = out.drop_duplicates().reset_index(drop=True)
    return Table(out, title="append", stage="soft", notes=[
        f"{len(other):,} rows appended; {len(new_cols)} new column(s); {n_before - len(out):,} exact duplicates dropped." if dedupe else f"{len(other):,} rows appended; {len(new_cols)} new column(s).",
    ])


stack = append


@tool
def combine(base: pd.DataFrame, *others: pd.DataFrame, key: Optional[str] = None, how: Optional[str] = None) -> Table:
    """Combine datasets the way the IDE does: each step is suggested (append or join-left) unless ``how`` / ``key`` force it."""
    out = base
    notes: List[str] = []
    for other in others:
        if how == "append":
            step = append(out, other)
        elif how in ("join", "join-left", "left"):
            step = join(out, other, key)
        elif how in ("inner", "join-inner"):
            step = join(out, other, key, how="inner")
        else:
            s = suggest_combine(out, other).iloc[0]
            step = join(out, other, s["key"], s["right_key"]) if s["strategy"] == "join-left" else append(out, other, dedupe=bool(s["dedupe_exact"]))
            notes.append(f"{s['strategy']} (confidence {s['confidence']:.2f})")
        notes.extend(step.notes)
        out = step
    t = Table(out, title=f"combine · {len(others) + 1} datasets", stage="soft", notes=notes)
    return t


def diff(a: pd.DataFrame, b: pd.DataFrame, key: Optional[str] = None, tol: float = 0.0) -> Table:
    """Cells that differ between two frames (aligned on ``key`` or position): key, column, a, b, delta."""
    if key:
        a2 = a.set_index(key)
        b2 = b.set_index(key)
    else:
        a2, b2 = a.reset_index(drop=True), b.reset_index(drop=True)
    cols = [c for c in a2.columns if c in b2.columns]
    idx = a2.index.intersection(b2.index)
    rows = []
    for c in cols:
        va, vb = a2.loc[idx, c], b2.loc[idx, c]
        num = pd.api.types.is_numeric_dtype(va) and pd.api.types.is_numeric_dtype(vb)
        if num:
            d = (pd.to_numeric(va, errors="coerce") - pd.to_numeric(vb, errors="coerce")).abs()
            m = (d > tol) | (va.isna() != vb.isna())
        else:
            m = (va.astype(str) != vb.astype(str)) & ~(va.isna() & vb.isna())
        for k in idx[m.to_numpy()]:
            rows.append({"key": k, "column": c, "a": va[k], "b": vb[k], "delta": (va[k] - vb[k]) if num else None})
    out = pd.DataFrame(rows, columns=["key", "column", "a", "b", "delta"])
    only_a = [c for c in a2.columns if c not in b2.columns]
    only_b = [c for c in b2.columns if c not in a2.columns]
    return Table(out, title=f"diff · {len(out)} differing cells", stage="hard", notes=[
        f"{len(idx):,} aligned rows; rows only in a: {len(a2.index.difference(b2.index))}, only in b: {len(b2.index.difference(a2.index))}; columns only in a: {only_a or 'none'}, only in b: {only_b or 'none'}.",
    ])


def tieout(a: Union[pd.DataFrame, pd.Series, float], b: Union[pd.DataFrame, pd.Series, float], tol: float = 1e-6, rel: bool = False) -> bool:
    """True when two numbers / series / frames agree within ``tol`` (absolute, or relative with ``rel=True``)."""
    if np.isscalar(a) and np.isscalar(b):
        d = abs(float(a) - float(b))
        return d <= (tol * max(abs(float(a)), abs(float(b)), 1e-300) if rel else tol)
    A = pd.DataFrame(a) if not isinstance(a, pd.DataFrame) else a
    B = pd.DataFrame(b) if not isinstance(b, pd.DataFrame) else b
    if A.shape != B.shape:
        return False
    An = A.apply(pd.to_numeric, errors="coerce").to_numpy(dtype=float)
    Bn = B.apply(pd.to_numeric, errors="coerce").to_numpy(dtype=float)
    num = ~np.isnan(An) & ~np.isnan(Bn)
    if rel:
        ok = np.abs(An[num] - Bn[num]) <= tol * np.maximum(np.abs(An[num]), np.abs(Bn[num]))
    else:
        ok = np.abs(An[num] - Bn[num]) <= tol
    if not ok.all():
        return False
    rest = ~num
    return bool((A.astype(str).to_numpy()[rest] == B.astype(str).to_numpy()[rest]).all()) if rest.any() else True
