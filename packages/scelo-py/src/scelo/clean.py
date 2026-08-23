"""Cleaning: the IDE's cleaning banner as functions.

``suggest(df)`` reads the data and proposes operations with the evidence for
each (cells affected, columns, why). ``clean(df)`` applies the *safe* ones:
the nine that cannot lose information (trim, collapse whitespace, fix
mojibake, null the missing markers, parse numbers / dates / booleans, null
numeric sentinels, coerce numeric residue). ``clean(df, "all")`` also runs
the learned and destructive ones (impute, cap outliers, drop duplicates /
empty / constant columns, lower-case categoricals, recode near-duplicate
labels, null future years, snake-case headers) and iterates until the data
is clean, stalls, or eight passes are spent, the way the IDE's autonomous
clean does.

Every threshold here is the IDE's (apps/web/src/components/Scelo/cleaning.ts),
so the library and the banner propose the same ops on the same file. The
result is a :class:`scelo.Table` whose notes list what was done.
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple, Union

import numpy as np
import pandas as pd

from ._audit import tool
from ._table import Table
from .io import is_text
from .profile import _is_missing, column_type, profile

__all__ = [
    "suggest", "clean", "trim", "collapse_ws", "fix_encoding", "missing_tokens", "parse_numbers", "parse_dates",
    "booleans", "sentinels", "coerce_numeric", "recode", "future_years", "impute", "cap_outliers", "dedupe",
    "drop_empty", "drop_constant", "lowercase", "snake_names", "snake_case", "parse_number", "parse_date",
    "infer_day_first", "SAFE_OPS", "ALL_OPS", "MISSING_TOKENS", "TRUE_TOKENS", "FALSE_TOKENS", "NUMERIC_SENTINELS",
]

# ── constants (verbatim from cleaning.ts) ───────────────────────────────────

MISSING_TOKENS = frozenset([
    "na", "n/a", "n.a.", "n/a.", "nan", "null", "nil", "none", "missing", "unknown", "undefined", "void",
    "no data", "no value", "not available", "not applicable",
    "<na>", "#na", "#n/a",
    "#null!", "#div/0!", "#value!", "#ref!", "#name?", "#num!",
    "-", "--", "---", "—", "–", "?", "??", "*", "**", ".", "x",
    "tbd", "tbc", "pending", "blank", "empty",
])
TRUE_TOKENS = frozenset(["true", "yes", "y", "t", "on", "ok", "✓", "✔"])
FALSE_TOKENS = frozenset(["false", "no", "n", "f", "off", "✗", "✘", "x"])
NUMERIC_SENTINELS = frozenset([
    -1, -9, -99, -999, -9999, -99999, -999999, -888, -8888, 9, 99,999, 9999, 99999, 999999,
    -999.99, 9999.99, 999.99,
])
_MOJIBAKE_PAIRS = [
    ("â€™", "’"), ("â€˜", "‘"), ("â€œ", "“"), ("â€", "”"), ("â€¦", "…"), ("â€¢", "•"),
    ("Ã©", "é"), ("Ã¨", "è"), ("Ãª", "ê"), ("Ã«", "ë"), ("Ã ", "à"), ("Ã¢", "â"), ("Ã®", "î"), ("Ã¯", "ï"),
    ("Ã´", "ô"), ("Ã¶", "ö"), ("Ã»", "û"), ("Ã¼", "ü"), ("Ã§", "ç"), ("Ã±", "ñ"), ("Ã¡", "á"), ("Ã­", "í"),
    ("Ã³", "ó"), ("Ãº", "ú"), ("Ã„", "Ä"), ("Ã–", "Ö"), ("Ãœ", "Ü"), ("ÃŸ", "ß"),
    ("Â£", "£"), ("Â©", "©"), ("Â®", "®"), ("Â°", "°"), ("Â ", " "),
]
_ENCODING_NOISE_RE = re.compile("﻿| |​|‌|‍|⁠|­")
_ZERO_WIDTH_RE = re.compile("﻿|​|‌|‍|⁠|­")
_INTERNAL_WS_RE = re.compile(r"\s{2,}")
_ISO_TIMESTAMP_RE = re.compile(
    r"^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$"
)
_MONTHS = {m: i + 1 for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}
_MONTHS.update({m: i + 1 for i, m in enumerate([
    "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"])})
_MONTHS["sept"] = 9
_YEAR_COL_RE = re.compile(r"year|yr", re.I)
_ID_NAME_RE = re.compile(r"(^|[_\s])(id|no|num|number|ref|code)$", re.I)
_CURRENCY_RE = re.compile(r"[$£€¥₹]")
_CCY_CODE_RE = re.compile(r"\s*[A-Za-z]{3,4}\s*$")
_CCY_PREFIX_RE = re.compile(r"^[A-Za-z]{1,3}\s+(?=[\d(+\-.])")
_SEP_RE = re.compile(r"[,_\s ]")
_DASH_RE = re.compile("[‐-―−]")
_NUM_PREFIX_RE = re.compile(r"^[+-]?\d+(?:\.\d+)?")
_SNAKE_QUOTES = re.compile(r"['\"`]")
_SNAKE_CAMEL = re.compile(r"([a-z0-9])([A-Z])")
_SNAKE_SEP = re.compile(r"[\s\-.\\/()\[\]{}]+")
_SNAKE_MULTI = re.compile(r"__+")
_SNAKE_EDGE = re.compile(r"^_+|_+$")

AUTO_CLEAN_MAX_PASSES = 8

SAFE_OPS: Tuple[str, ...] = (
    "fix-encoding", "trim", "collapse-whitespace", "missing-tokens", "standardise-booleans", "parse-dates",
    "parse-numeric", "coerce-numeric", "replace-numeric-sentinels",
)
UNSAFE_OPS: Tuple[str, ...] = (
    "recode-value", "null-future-years", "lowercase-categoricals", "drop-duplicates", "drop-empty-cols",
    "drop-constant-cols", "rename-snake-case", "cap-outliers", "impute-missing",
)
ALL_OPS: Tuple[str, ...] = SAFE_OPS + UNSAFE_OPS

_OP_ALIASES = {
    "whitespace": "trim", "strip": "trim", "trim-whitespace": "trim",
    "collapse": "collapse-whitespace", "collapse-ws": "collapse-whitespace",
    "encoding": "fix-encoding", "mojibake": "fix-encoding",
    "missing": "missing-tokens", "missing-markers": "missing-tokens", "nulls": "missing-tokens",
    "numbers": "parse-numeric", "numeric": "parse-numeric", "parse-numbers": "parse-numeric", "money": "parse-numeric",
    "dates": "parse-dates", "date": "parse-dates",
    "booleans": "standardise-booleans", "bool": "standardise-booleans", "bools": "standardise-booleans",
    "sentinels": "replace-numeric-sentinels", "sentinel": "replace-numeric-sentinels",
    "coerce": "coerce-numeric",
    "recode": "recode-value", "typos": "recode-value",
    "future-years": "null-future-years",
    "impute": "impute-missing", "fillna": "impute-missing", "fill": "impute-missing", "median": "impute-missing", "mode": "impute-missing",
    "cap": "cap-outliers", "winsorize": "cap-outliers", "winsorise": "cap-outliers", "clip": "cap-outliers", "tukey": "cap-outliers", "iqr": "cap-outliers", "outliers": "cap-outliers",
    "dedupe": "drop-duplicates", "duplicates": "drop-duplicates", "dedup": "drop-duplicates",
    "empty": "drop-empty-cols", "drop-empty": "drop-empty-cols",
    "constant": "drop-constant-cols", "drop-constant": "drop-constant-cols",
    "lowercase": "lowercase-categoricals", "lower": "lowercase-categoricals", "case": "lowercase-categoricals",
    "snake": "rename-snake-case", "snakecase": "rename-snake-case", "snake-case": "rename-snake-case", "headers": "rename-snake-case", "rename": "rename-snake-case", "names": "rename-snake-case",
}


def _norm_op(key: str) -> str:
    k = key.strip().lower().replace("_", "-")
    k = _OP_ALIASES.get(k, k)
    if k not in ALL_OPS:
        raise KeyError(f"unknown cleaning op {key!r}: choose from {', '.join(ALL_OPS)}")
    return k


# ── scalar helpers ──────────────────────────────────────────────────────────

def _fix_encoding_str(s: str) -> str:
    for bad, good in _MOJIBAKE_PAIRS:
        if bad in s:
            s = s.replace(bad, good)
    s = s.replace(" ", " ")
    return _ZERO_WIDTH_RE.sub("", s)


def snake_case(name: str) -> Optional[str]:
    """``"Customer Name"`` → ``customer_name``; None when the result is empty or unchanged."""
    s = _SNAKE_QUOTES.sub("", str(name))
    s = _SNAKE_CAMEL.sub(r"\1_\2", s)
    s = _SNAKE_SEP.sub("_", s)
    s = _SNAKE_MULTI.sub("_", s)
    s = _SNAKE_EDGE.sub("", s).lower()
    return None if (s == "" or s == name) else s


def parse_number(raw: Any) -> Optional[float]:
    """Flexible number parse: ``"R 1,234.50"``, ``"(1,200)"`` → −1200, ``"85%"`` → 85, ``"1 200 ZAR"`` → 1200; None when not a number.

    Order: Unicode dashes → ASCII; accounting parentheses negate; trailing %
    stripped (value kept as displayed); currency symbols, a trailing
    3–4-letter code and a leading 1–3-letter code ("R 1,234.50") removed;
    thousand separators (comma, underscore, space, NBSP) removed; then a
    strict float.
    """
    if raw is None:
        return None
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float, np.integer, np.floating)):
        return None if (isinstance(raw, float) and np.isnan(raw)) else float(raw)
    s = str(raw).strip()
    if not s:
        return None
    s = _DASH_RE.sub("-", s)
    negate = False
    if len(s) >= 2 and s.startswith("(") and s.endswith(")"):
        negate = True
        s = s[1:-1].strip()
    if s.endswith("%"):
        s = s[:-1]
    s = _CURRENCY_RE.sub("", s)
    s = _CCY_CODE_RE.sub("", s)
    s = _CCY_PREFIX_RE.sub("", s)  # "R 1,234.50", "ZAR 500": a leading currency code before a number (Scelo extension)
    s = _SEP_RE.sub("", s)
    if s in ("", "-", "+"):
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    if not np.isfinite(v):
        return None
    return -v if negate else v


def _coerce_numeric_value(raw: Any) -> Optional[float]:
    v = parse_number(raw)
    if v is not None:
        return v
    m = _NUM_PREFIX_RE.match(str(raw).strip())
    return float(m.group(0)) if m else None


def _expand_year(y: int, digits: int) -> int:
    if digits > 2:
        return y
    return 2000 + y if y < 70 else 1900 + y


def _valid(y: int, m: int, d: int) -> bool:
    if not (1 <= m <= 12 and 1 <= d <= 31 and 1700 <= y <= 2200):
        return False
    try:
        date(y, m, d)
    except ValueError:
        return False
    return True


_P_ISO = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]\d.*)?$")
_P_YSL = re.compile(r"^(\d{4})/(\d{1,2})/(\d{1,2})$")
_P_NUM = re.compile(r"^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$")
_P_MON1 = re.compile(r"^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})$")
_P_MON2 = re.compile(r"^(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{2,4})$")


def _date_parts(raw: str, day_first: bool = False) -> Optional[Tuple[int, int, int]]:
    s = raw.strip()
    if len(s) < 6 or len(s) > 35:
        return None
    m = _P_ISO.match(s) or _P_YSL.match(s)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        return (y, mo, d) if _valid(y, mo, d) else None
    m = _P_NUM.match(s)
    if m:
        a, b, ys = int(m.group(1)), int(m.group(2)), m.group(3)
        y = _expand_year(int(ys), len(ys))
        if a > 12 and b <= 12:
            d, mo = a, b
        elif b > 12 and a <= 12:
            mo, d = a, b
        elif a > 12 and b > 12:
            return None
        else:
            d, mo = (a, b) if day_first else (b, a)
        return (y, mo, d) if _valid(y, mo, d) else None
    m = _P_MON1.match(s)
    if m:
        mo = _MONTHS.get(m.group(1).lower())
        if mo is None:
            return None
        d, ys = int(m.group(2)), m.group(3)
        y = _expand_year(int(ys), len(ys))
        return (y, mo, d) if _valid(y, mo, d) else None
    m = _P_MON2.match(s)
    if m:
        mo = _MONTHS.get(m.group(2).lower())
        if mo is None:
            return None
        d, ys = int(m.group(1)), m.group(3)
        y = _expand_year(int(ys), len(ys))
        return (y, mo, d) if _valid(y, mo, d) else None
    return None


def parse_date(raw: Any, day_first: bool = False) -> Optional[datetime]:
    """Parse one cell the way the IDE does (ISO, y/m/d, d/m/y or m/d/y with the >12 rule, "Jan 5, 2024", "5 Jan 2024").

    Ambiguous numeric forms follow ``day_first`` (default month-first, as the
    IDE). ISO timestamps keep their time; a zone offset is honoured.
    """
    if raw is None or not isinstance(raw, str):
        if isinstance(raw, (datetime, pd.Timestamp)):
            return raw
        return None
    s = raw.strip()
    if len(s) < 6 or len(s) > 35:
        return None
    m = _ISO_TIMESTAMP_RE.match(s)
    if m:
        y, mo, d, hh, mi = int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4)), int(m.group(5))
        ss = int(m.group(6) or 0)
        if not _valid(y, mo, d) or hh > 23 or mi > 59 or ss > 59:
            return None
        if m.group(8):
            try:
                return pd.Timestamp(s.replace(" ", "T")).tz_convert("UTC").tz_localize(None).to_pydatetime()
            except Exception:
                return None
        frac = m.group(7)
        micro = int((frac + "000000")[:6]) if frac else 0
        return datetime(y, mo, d, hh, mi, ss, micro)
    p = _date_parts(s, day_first)
    return datetime(*p) if p else None


def _is_date_shaped(s: str) -> bool:
    m = _ISO_TIMESTAMP_RE.match(s)
    if m:
        return _valid(int(m.group(1)), int(m.group(2)), int(m.group(3))) and int(m.group(4)) <= 23 and int(m.group(5)) <= 59 and int(m.group(6) or 0) <= 59
    return _date_parts(s, False) is not None


def infer_day_first(values: Iterable[str]) -> bool:
    """True when the unambiguous cells (a > 12 or b > 12) say day comes first; ties → month-first."""
    day_first = month_first = 0
    for v in values:
        m = _P_NUM.match(str(v).strip())
        if not m:
            continue
        a, b = int(m.group(1)), int(m.group(2))
        if a > 12 and b <= 12:
            day_first += 1
        elif b > 12 and a <= 12:
            month_first += 1
    return day_first > month_first


def _levenshtein_at_most(a: str, b: str, mx: int) -> Optional[int]:
    if abs(len(a) - len(b)) > mx:
        return None
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        if min(cur) > mx:
            return None
        prev = cur
    return prev[-1] if prev[-1] <= mx else None


def _differs_only_in_code_token(a: str, b: str) -> bool:
    ta, tb = a.split(), b.split()
    if len(ta) != len(tb):
        return False
    diff = [(x, y) for x, y in zip(ta, tb) if x != y]
    return len(diff) == 1 and len(diff[0][0]) <= 2 and len(diff[0][1]) <= 2


def _near_duplicate(top: List[Tuple[str, int]], non_missing: int) -> Optional[Tuple[str, str, int]]:
    top = top[:12]
    min_count = max(4, round(non_missing * 0.002))
    best: Optional[Tuple[str, str, int]] = None
    for i in range(len(top)):
        for j in range(i + 1, len(top)):
            (va, ca), (vb, cb) = top[i], top[j]
            if ca < min_count or cb < min_count or ca == cb:
                continue
            al, bl = va.lower(), vb.lower()
            if al == bl:
                continue
            min_len = min(len(al), len(bl))
            if min_len < 4:
                continue
            max_dist = 2 if min_len >= 8 else 1
            if _levenshtein_at_most(al, bl, max_dist) is None:
                continue
            if _differs_only_in_code_token(al, bl):
                continue
            frm, to, cnt = (va, vb, ca) if ca < cb else (vb, va, cb)
            if best is None or cnt > best[2]:
                best = (frm, to, cnt)
    return best



# ── vectorised twins of the scalar rules (same semantics, pandas .str speed) ──

def parse_number_vec(s: pd.Series) -> pd.Series:
    """Vectorised :func:`parse_number` over a Series of strings: float where parseable, NaN otherwise."""
    t = s.astype("string").str.strip()
    t = t.str.replace(_DASH_RE.pattern, "-", regex=True)
    paren = (t.str.len() >= 2) & t.str.startswith("(") & t.str.endswith(")")
    t = t.where(~paren.fillna(False), t.str.slice(1, -1).str.strip())
    t = t.str.replace(r"%$", "", regex=True)
    t = t.str.replace(_CURRENCY_RE.pattern, "", regex=True)
    t = t.str.replace(_CCY_CODE_RE.pattern, "", regex=True)
    t = t.str.replace(_CCY_PREFIX_RE.pattern, "", regex=True)
    t = t.str.replace(_SEP_RE.pattern, "", regex=True)
    bad = t.isin(["", "-", "+"]).fillna(True) | t.str.contains(r"^[+-]?(?:inf|infinity|nan)$", case=False, regex=True).fillna(False)
    v = pd.to_numeric(t.where(~bad).astype(object), errors="coerce").astype(float)
    v[~np.isfinite(v)] = np.nan
    return v.where(~paren.fillna(False), -v).astype(float)


_P_ISO_V = r"^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]\d.*)?$"
_P_YSL_V = r"^(\d{4})/(\d{1,2})/(\d{1,2})$"
_P_NUM_V = r"^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$"


def _numf(x: Any) -> pd.Series:
    """to_numeric → plain float64 (NaN, never pd.NA)."""
    return pd.to_numeric(pd.Series(x), errors="coerce").astype("float64")


def _bool(x: pd.Series) -> pd.Series:
    return pd.Series(x).fillna(False).astype(bool)


def _valid_vec(y: pd.Series, m: pd.Series, d: pd.Series) -> pd.Series:
    y, m, d = _numf(y), _numf(m), _numf(d)
    ok = _bool(y.between(1700, 2200) & m.between(1, 12) & d.between(1, 31))
    dt = pd.to_datetime(pd.DataFrame({"year": y.where(ok, 2000).astype(int), "month": m.where(ok, 1).astype(int), "day": d.where(ok, 1).astype(int)}), errors="coerce")
    return _bool(ok & dt.notna())


def date_parts_vec(s: pd.Series, day_first: bool = False) -> pd.DataFrame:
    """Vectorised :func:`parse_date` for date-only cells: columns year / month / day (NaN where not a date)."""
    t = s.astype("string").str.strip()
    n = len(t)
    y = pd.Series(np.nan, index=t.index, dtype=float)
    m = y.copy()
    d = y.copy()
    lenok = _bool(t.str.len().between(6, 35))
    for pat in (_P_ISO_V, _P_YSL_V):
        g = t.str.extract(pat)
        hit = _bool(g[0].notna()) & lenok & y.isna()
        yy, mm, dd = _numf(g[0]), _numf(g[1]), _numf(g[2])
        ok = hit & _valid_vec(yy, mm, dd)
        y[ok], m[ok], d[ok] = yy[ok], mm[ok], dd[ok]
    g = t.str.extract(_P_NUM_V)
    hit = _bool(g[0].notna()) & lenok & y.isna()
    if hit.any():
        a, b = _numf(g[0]), _numf(g[1])
        yy = _numf(g[2])
        two = _bool(g[2].str.len() <= 2)
        yy = yy.where(~two, np.where(yy < 70, 2000 + yy, 1900 + yy))
        dayfirst = _bool((a > 12) & (b <= 12))
        monthfirst = _bool((b > 12) & (a <= 12))
        both = _bool((a > 12) & (b > 12))
        dd = pd.Series(np.where(dayfirst, a, np.where(monthfirst, b, a if day_first else b)), index=t.index, dtype=float)
        mm = pd.Series(np.where(dayfirst, b, np.where(monthfirst, a, b if day_first else a)), index=t.index, dtype=float)
        ok = hit & ~both & _valid_vec(yy, mm, dd)
        y[ok], m[ok], d[ok] = yy[ok], mm[ok], dd[ok]
    rest = t[y.isna() & lenok & _bool(t.str.contains(r"[A-Za-z]{3,9}", regex=True))]
    if len(rest):
        parts = rest.map(lambda v: _date_parts(str(v), day_first))
        for idx, p in parts.items():
            if p:
                y[idx], m[idx], d[idx] = p
    return pd.DataFrame({"year": y, "month": m, "day": d})


def date_shaped_vec(s: pd.Series) -> pd.Series:
    """Vectorised ``is date-shaped``: an ISO timestamp with a valid time, or any of the date-only forms (timestamps with an invalid time are not dates, as in the IDE)."""
    t = s.astype("string").str.strip()
    lenok = _bool(t.str.len().between(6, 35))
    ts = t.str.extract(_ISO_TIMESTAMP_RE.pattern)
    is_ts = _bool(ts[0].notna()) & lenok
    shaped = pd.Series(False, index=t.index)
    if is_ts.any():
        yy, mm, dd, hh, mi = (_numf(ts[k]) for k in range(5))
        ss = _numf(ts[5]).fillna(0)
        shaped = is_ts & _valid_vec(yy, mm, dd) & _bool((hh <= 23) & (mi <= 59) & (ss <= 59))
    rest = ~is_ts & lenok
    if rest.any():
        parts = date_parts_vec(t[rest], False)
        shaped.loc[parts.index[parts["year"].notna()]] = True
    return _bool(shaped)


def parse_date_vec(s: pd.Series, day_first: bool = False) -> pd.Series:
    """Vectorised :func:`parse_date`: datetime64 Series (NaT where not a date). ISO timestamps keep their time; offsets are converted to UTC."""
    t = s.astype("string").str.strip()
    out = pd.Series(pd.NaT, index=t.index, dtype="datetime64[ns]")
    ts = t.str.extract(_ISO_TIMESTAMP_RE.pattern)
    is_ts = _bool(ts[0].notna()) & _bool(t.str.len().between(6, 35))
    if is_ts.any():
        vals = t[is_ts].astype(object).str.replace(" ", "T", n=1, regex=False)
        parsed = pd.to_datetime(vals, errors="coerce", utc=True, format="ISO8601").dt.tz_localize(None)
        yy, mm, dd, hh, mi = (_numf(ts[k][is_ts]) for k in range(5))
        ss = _numf(ts[5][is_ts]).fillna(0)
        ok = _valid_vec(yy, mm, dd) & _bool((hh <= 23) & (mi <= 59) & (ss <= 59))
        out[is_ts] = parsed.where(ok.to_numpy(), pd.NaT).to_numpy()
    rest = ~is_ts
    if rest.any():
        parts = date_parts_vec(t[rest], day_first)
        okp = parts["year"].notna()
        if okp.any():
            got = pd.to_datetime(parts[okp].astype(int), errors="coerce")
            out.loc[got.index] = got.to_numpy()
    return out


class _TextInfo:
    """Everything the analyser needs about one text column, computed once from its unique strings."""

    __slots__ = ("uniq", "counts", "stripped", "lower", "cand", "n_cand", "trim", "ws", "enc", "missing", "_numeric", "_date", "bool_true", "bool_false", "n_str")
    SCREEN = 2000  # uniques (most frequent first) used to decide whether a full numeric / date scan can qualify

    def __init__(self, col: pd.Series) -> None:
        col = col.astype(object)
        mask = _str_mask(col)
        vc = col[mask].value_counts() if mask.any() else pd.Series(dtype=int)
        self.uniq = pd.Series(vc.index.astype(object), dtype="string")
        self.counts = pd.Series(vc.to_numpy(), dtype=int)
        self.n_str = int(self.counts.sum())
        self.stripped = self.uniq.str.strip()
        self.lower = self.stripped.str.lower()
        self.missing = self.lower.isin(list(MISSING_TOKENS)).fillna(False) & (self.stripped != "").fillna(False)
        self.cand = (self.stripped != "").fillna(False) & ~self.missing
        self.n_cand = int(self.counts[self.cand.to_numpy()].sum()) if len(self.counts) else 0
        self.trim = (self.uniq != self.stripped).fillna(False)
        self.ws = self.stripped.str.contains(_INTERNAL_WS_RE.pattern, regex=True).fillna(False)
        bad = "|".join(re.escape(b) for b, _ in _MOJIBAKE_PAIRS)
        self.enc = (self.stripped.str.contains(_ENCODING_NOISE_RE.pattern, regex=True) | self.uniq.str.contains(bad, regex=True)).fillna(False)
        self._numeric = None
        self._date = None
        self.bool_true = self.lower.isin(list(TRUE_TOKENS)).fillna(False) & self.cand
        self.bool_false = self.lower.isin(list(FALSE_TOKENS)).fillna(False) & self.cand

    def count(self, mask: pd.Series) -> int:
        return int(self.counts[np.asarray(mask, dtype=bool)].sum()) if len(self.counts) else 0

    def _screen(self, fn: Callable[[pd.Series], pd.Series]) -> pd.Series:
        """Full mask when a head sample (most frequent uniques) shows the op could reach 80 %; else all-False without the full scan."""
        n = len(self.uniq)
        if n > self.SCREEN:
            head = self.SCREEN
            hmask = fn(self.stripped.head(head)) & self.cand.head(head)
            covered = int(self.counts.head(head).sum())
            if covered and int(self.counts.head(head)[hmask.to_numpy()].sum()) / covered < 0.3:
                return pd.Series(False, index=self.uniq.index)
        return fn(self.stripped) & self.cand

    @property
    def numeric(self) -> pd.Series:
        if self._numeric is None:
            self._numeric = self._screen(lambda u: parse_number_vec(u).notna())
        return self._numeric

    @property
    def date(self) -> pd.Series:
        if self._date is None:
            self._date = self._screen(date_shaped_vec)
        return self._date

    def share(self, mask: pd.Series) -> float:
        return self.count(mask) / self.n_cand if self.n_cand >= 4 else 0.0

# ── column-wise application helpers ─────────────────────────────────────────

def _str_mask(col: pd.Series) -> pd.Series:
    """True where a cell is a Python string (vectorised: .str.len() is NaN for non-strings)."""
    if pd.api.types.is_string_dtype(col) and col.dtype != object:
        return col.notna()
    if col.dtype != object:
        return pd.Series(False, index=col.index)
    try:
        return col.str.len().notna()
    except AttributeError:  # no strings at all
        return pd.Series(False, index=col.index)


def _apply_strings(col: pd.Series, fn: Callable[[str], Any]) -> pd.Series:
    """Map ``fn`` over the string cells of a text column, via uniques (fast on categoricals). Returns object dtype."""
    if not is_text(col):
        return col
    col = col.astype(object)
    mask = _str_mask(col)
    if not mask.any():
        return col
    uniq = pd.unique(col[mask])
    lookup = {u: fn(u) for u in uniq}
    out = col.copy()
    out[mask] = col[mask].map(lookup)
    return out


def _vec_apply(col: pd.Series, fn: Callable[[pd.Series], pd.Series], fill: Any = np.nan, keep: Optional[Callable[[Any], bool]] = None) -> pd.Series:
    """Apply a vectorised string→value function over the unique strings of a column.

    Non-string cells are kept as they are when ``keep(cell)`` is true (a number
    in a numeric parse, a datetime in a date parse …), otherwise they become
    ``fill``. The IDE's ops only ever touch string cells; this is that rule.
    """
    col = col.astype(object)
    mask = _str_mask(col)
    out = pd.Series(fill, index=col.index, dtype=object)
    if keep is not None:
        other = ~mask & col.notna()
        if other.any():
            kept = col[other].map(lambda v: v if keep(v) else fill)
            out[other] = kept.to_numpy()
    if not mask.any():
        return out
    uniq = pd.Series(pd.unique(col[mask]).astype(object))
    vals = fn(uniq)
    lookup = pd.Series(vals.to_numpy(), index=uniq.to_numpy())
    out[mask] = col[mask].map(lookup).to_numpy()
    return out


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float, np.integer, np.floating)) and not isinstance(v, bool)


def _count_strings(col: pd.Series, pred: Callable[[str], bool]) -> int:
    if not is_text(col):
        return 0
    mask = _str_mask(col)
    if not mask.any():
        return 0
    vc = col[mask].value_counts()
    return int(sum(c for v, c in vc.items() if pred(v)))


# ── individual ops (each returns a new frame) ─────────────────────────────

def fix_encoding(df: pd.DataFrame, columns: Optional[Sequence[str]] = None) -> pd.DataFrame:
    """Repair UTF-8↔Latin-1 mojibake ("Ã©" → "é"), NBSP → space, drop BOM / zero-width / soft-hyphen characters."""
    out = df.copy()
    for c in columns or out.columns:
        out[c] = _apply_strings(out[c], _fix_encoding_str)
    return out


def trim(df: pd.DataFrame, columns: Optional[Sequence[str]] = None) -> pd.DataFrame:
    """Strip leading / trailing whitespace from every string cell."""
    out = df.copy()
    for c in columns or out.columns:
        out[c] = _apply_strings(out[c], str.strip)
    return out


def collapse_ws(df: pd.DataFrame, columns: Optional[Sequence[str]] = None) -> pd.DataFrame:
    """Collapse runs of internal whitespace to one space."""
    out = df.copy()
    for c in columns or out.columns:
        out[c] = _apply_strings(out[c], lambda s: _INTERNAL_WS_RE.sub(" ", s))
    return out


def missing_tokens(df: pd.DataFrame, columns: Optional[Sequence[str]] = None, tokens: Optional[Iterable[str]] = None) -> pd.DataFrame:
    """Null the missing markers ("N/A", "?", "-", "TBD", "#N/A", "null" … case-insensitive, trimmed)."""
    toks = frozenset(t.lower() for t in tokens) if tokens is not None else MISSING_TOKENS
    out = df.copy()
    for c in columns or out.columns:
        out[c] = _apply_strings(out[c], lambda s: None if s.strip().lower() in toks else s)
    return out


def parse_numbers(df: pd.DataFrame, columns: Optional[Sequence[str]] = None) -> pd.DataFrame:
    """Turn money / percent / thousands-separated strings into numbers (columns default to those ≥ 80 % parseable)."""
    out = df.copy()
    cols = list(columns) if columns is not None else [c for c in out.columns if is_text(out[c]) and _TextInfo(out[c]).share(_TextInfo(out[c]).numeric) >= 0.8]
    for c in cols:
        out[c] = pd.to_numeric(_vec_apply(out[c], parse_number_vec, keep=_is_num), errors="coerce").astype(float)
    return out


def parse_dates(df: pd.DataFrame, columns: Optional[Sequence[str]] = None, day_first: Optional[bool] = None) -> pd.DataFrame:
    """Parse mixed-format date strings into ``datetime64`` (day-first inferred per column from the unambiguous cells)."""
    out = df.copy()
    cols = list(columns) if columns is not None else [c for c in out.columns if is_text(out[c]) and column_type(out[c]) != "number" and _TextInfo(out[c]).share(_TextInfo(out[c]).date) >= 0.8]
    for c in cols:
        if pd.api.types.is_datetime64_any_dtype(out[c]):
            continue
        mask = _str_mask(out[c])
        df_first = infer_day_first(out.loc[mask, c]) if day_first is None else day_first  # votes on cells, like the IDE
        out[c] = _vec_apply(out[c], lambda u, dfst=df_first: parse_date_vec(u, dfst), fill=pd.NaT,
                            keep=lambda v: isinstance(v, (datetime, pd.Timestamp, np.datetime64))).astype("datetime64[ns]")
    return out


def booleans(df: pd.DataFrame, columns: Optional[Sequence[str]] = None) -> pd.DataFrame:
    """Standardise yes / no / Y / N / true / false / on / off / ✓ / ✗ into a nullable boolean column."""
    out = df.copy()
    cols = list(columns) if columns is not None else [c for c in out.columns if is_text(out[c]) and _bool_candidate_info(_TextInfo(out[c]))]
    for c in cols:
        def conv(u: pd.Series) -> pd.Series:
            low = u.astype("string").str.strip().str.lower()
            v = pd.Series(pd.NA, index=u.index, dtype="boolean")
            v[low.isin(list(TRUE_TOKENS)).fillna(False).to_numpy()] = True
            v[low.isin(list(FALSE_TOKENS)).fillna(False).to_numpy()] = False
            v[low.isin(list(MISSING_TOKENS)).fillna(False).to_numpy()] = pd.NA
            return v
        out[c] = _vec_apply(out[c], conv, fill=pd.NA, keep=lambda v: isinstance(v, (bool, np.bool_))).astype("boolean")
    return out


def sentinels(df: pd.DataFrame, columns: Optional[Sequence[str]] = None, values: Optional[Iterable[float]] = None) -> pd.DataFrame:
    """Null legacy numeric sentinels (−999, 9999, −1 …) when they sit ≥ 5 IQR outside the column's body and recur ≥ 3 times."""
    out = df.copy()
    cols = list(columns) if columns is not None else list(out.columns)
    for c in cols:
        if not pd.api.types.is_numeric_dtype(out[c]) or pd.api.types.is_bool_dtype(out[c]):
            continue
        vals = _sentinel_values(out[c]) if values is None else set(values)
        if vals:
            out[c] = out[c].mask(out[c].isin(list(vals)))
    return out


def coerce_numeric(df: pd.DataFrame, columns: Optional[Sequence[str]] = None) -> pd.DataFrame:
    """Number-typed columns with string residue: keep the numeric prefix ("6+" → 6), null the digit-free rest."""
    out = df.copy()
    cols = list(columns) if columns is not None else [c for c in out.columns if is_text(out[c]) and column_type(out[c]) == "number"]
    for c in cols:
        def conv(u: pd.Series) -> pd.Series:
            v = parse_number_vec(u)
            prefix = _numf(u.astype("string").str.strip().str.extract(r"^([+-]?\d+(?:\.\d+)?)")[0])
            return v.where(v.notna(), prefix)
        out[c] = pd.to_numeric(_vec_apply(out[c], conv, keep=_is_num), errors="coerce").astype(float)
    return out


def recode(df: pd.DataFrame, column: str, frm: Any, to: Any) -> pd.DataFrame:
    """Replace one exact value in one column (the near-duplicate-label fix)."""
    out = df.copy()
    out[column] = out[column].map(lambda v: to if v == frm else v)
    return out


def future_years(df: pd.DataFrame, columns: Optional[Sequence[str]] = None, max_year: Optional[int] = None) -> pd.DataFrame:
    """Null integer years after ``max_year`` (default: this year) in year-named numeric columns."""
    cut = max_year or date.today().year
    out = df.copy()
    cols = list(columns) if columns is not None else [c for c in out.columns if _YEAR_COL_RE.search(str(c)) and pd.api.types.is_numeric_dtype(out[c])]
    for c in cols:
        v = out[c]
        out[c] = v.mask((v > cut) & (v % 1 == 0))
    return out


def impute(df: pd.DataFrame, columns: Optional[Sequence[str]] = None, strategy: str = "auto", indicator: bool = True,
           value: Any = None) -> pd.DataFrame:
    """Fill missing cells: numeric → median, categorical → mode (``strategy`` = auto / median / mean / mode / value), with a ``was_missing_<col>`` indicator.

    Follows the IDE's refusal rules in ``auto`` mode: nothing missing, fewer
    than 4 known values, > 95 % missing, a date column, an identifier-like
    column (unique > max(20, 2 % of present)) or no value common enough to
    be a mode (< 2 %) are skipped rather than invented.
    """
    out = df.copy()
    cols = list(columns) if columns is not None else list(out.columns)
    existing = set(out.columns)
    for c in cols:
        miss = _missing_mask(out[c])
        n_missing = int(miss.sum())
        if n_missing == 0:
            continue
        present = out.loc[~miss, c]
        if strategy == "auto" and _impute_skip(out[c], present, n_missing):
            continue
        fill: Any
        if strategy == "value":
            fill = value
        elif strategy in ("median", "mean") or (strategy == "auto" and column_type(out[c]) == "number"):
            nums = pd.to_numeric(present, errors="coerce").dropna()
            if nums.empty:
                continue
            fill = float(nums.mean()) if strategy == "mean" else float(nums.median())
        else:
            vc = present.value_counts()
            if vc.empty:
                continue
            fill = vc.index[0]
        if indicator:
            name = "was_missing_" + (snake_case(str(c)) or str(c))
            if name not in existing:
                loc = list(out.columns).index(c) + 1
                out.insert(loc, name, miss.astype(bool))
                existing.add(name)
        out[c] = out[c].where(~miss, fill)
    return out


def cap_outliers(df: pd.DataFrame, columns: Optional[Sequence[str]] = None, k: float = 1.5) -> pd.DataFrame:
    """Winsorise numeric columns to the Tukey fences (q1 − k·IQR, q3 + k·IQR). Nothing is dropped.

    Skips year columns (a calendar fact, not a distribution), identifier-like
    columns (all distinct and id-named) and columns with no spread.
    """
    out = df.copy()
    cols = list(columns) if columns is not None else list(out.columns)
    for c in cols:
        if not pd.api.types.is_numeric_dtype(out[c]) or pd.api.types.is_bool_dtype(out[c]):
            continue
        if columns is None and _cap_skip(out[c], str(c)):
            continue
        v = out[c].astype(float)
        q1, q3 = v.quantile([0.25, 0.75])
        lo, hi = q1 - k * (q3 - q1), q3 + k * (q3 - q1)
        if hi <= lo:
            continue
        out[c] = v.clip(lower=lo, upper=hi)
    return out


def dedupe(df: pd.DataFrame, columns: Optional[Sequence[str]] = None) -> pd.DataFrame:
    """Drop exact duplicate rows (first occurrence kept)."""
    return df.drop_duplicates(subset=list(columns) if columns else None).reset_index(drop=True)


def drop_empty(df: pd.DataFrame, threshold: float = 0.95) -> pd.DataFrame:
    """Drop columns more than ``threshold`` missing (never all of them)."""
    miss = {c: float(_missing_mask(df[c]).mean()) for c in df.columns}
    cols = [c for c in df.columns if miss[c] > threshold]
    if not cols or len(cols) == len(df.columns):
        return df.copy()
    return df.drop(columns=cols)


def drop_constant(df: pd.DataFrame) -> pd.DataFrame:
    """Drop single-valued columns (never all of them)."""
    cols = []
    for c in df.columns:
        present = df[c][~_missing_mask(df[c])]
        if len(present) and present.astype(str).nunique() == 1:
            cols.append(c)
    if not cols or len(cols) == len(df.columns):
        return df.copy()
    return df.drop(columns=cols)


def lowercase(df: pd.DataFrame, columns: Optional[Sequence[str]] = None) -> pd.DataFrame:
    """Lower-case string columns whose top values differ only by case (WEST / west / West)."""
    out = df.copy()
    cols = list(columns) if columns is not None else [c for c in out.columns if _case_merges(out[c]) > 0]
    for c in cols:
        out[c] = _apply_strings(out[c], str.lower)
    return out


def snake_names(df: pd.DataFrame) -> pd.DataFrame:
    """snake_case the headers ("Customer Name" → customer_name). Abandoned entirely on any collision."""
    mapping: Dict[str, str] = {}
    taken = set(map(str, df.columns))
    for c in df.columns:
        s = snake_case(str(c))
        if s is None:
            continue
        if s in taken or s in mapping.values():
            return df.copy()
        mapping[c] = s
    return df.rename(columns=mapping)


# ── analyser internals ──────────────────────────────────────────────────────

def _share(col: pd.Series, pred: Callable[[str], bool]) -> float:
    """Share of candidate string cells (non-missing-token) satisfying ``pred``; 0 when fewer than 4 candidates."""
    if not is_text(col):
        return 0.0
    mask = _str_mask(col)
    if not mask.any():
        return 0.0
    vc = col[mask].value_counts()
    cand = [(v, c) for v, c in vc.items() if v.strip() and v.strip().lower() not in MISSING_TOKENS]
    n = sum(c for _, c in cand)
    if n < 4:
        return 0.0
    return sum(c for v, c in cand if pred(v.strip())) / n


def _bool_candidate(col: pd.Series) -> bool:
    if not is_text(col):
        return False
    mask = _str_mask(col)
    if not mask.any():
        return False
    vc = col[mask].value_counts()
    cand = [(v.strip().lower(), c, v) for v, c in vc.items() if v.strip() and v.strip().lower() not in MISSING_TOKENS]
    n = sum(c for _, c, _ in cand)
    if n < 4:
        return False
    t = sum(c for v, c, _ in cand if v in TRUE_TOKENS)
    f = sum(c for v, c, _ in cand if v in FALSE_TOKENS)
    other = n - t - f
    noncanon = sum(c for v, c, raw in cand if (v in TRUE_TOKENS or v in FALSE_TOKENS) and raw not in ("true", "false"))
    return t > 0 and f > 0 and other / n <= 0.05 and noncanon > 0


def _sentinel_values(col: pd.Series) -> Set[float]:
    v = pd.to_numeric(col, errors="coerce").dropna()
    if v.empty:
        return set()
    q1, q3 = v.quantile([0.25, 0.75])
    iqr_ = q3 - q1
    if not np.isfinite(iqr_) or iqr_ <= 0:
        return set()
    lo_cut, hi_cut = q1 - 5 * iqr_, q3 + 5 * iqr_
    vc = v[v.isin(list(NUMERIC_SENTINELS))].value_counts()
    return {float(val) for val, cnt in vc.items() if cnt >= 3 and not (lo_cut < val < hi_cut)}


def _case_merges(col: pd.Series) -> int:
    if not is_text(col):
        return 0
    mask = _str_mask(col)
    if not mask.any():
        return 0
    top = col[mask].value_counts().head(8)
    if len(top) < 2:
        return 0
    groups: Dict[str, int] = {}
    for v in top.index:
        groups[v.lower()] = groups.get(v.lower(), 0) + 1
    return sum(n - 1 for n in groups.values() if n > 1)


def _impute_skip(col: pd.Series, present: pd.Series, n_missing: int, ctype: Optional[str] = None) -> Optional[str]:
    count = len(col)
    n_present = len(present)
    if n_present < 4:
        return "too few known values to learn a fill from"
    if n_missing / count > 0.95:
        return "over 95% missing: a fill would be inventing the column"
    t = ctype or column_type(col)
    if t == "date":
        return "a date has no defensible constant fill"
    if t == "number":
        return None
    uniq = present.nunique()
    if uniq > max(20, n_present * 0.02):
        return "reads as an identifier or free text"
    vc = present.value_counts()
    if vc.empty or vc.iloc[0] / n_present < 0.02:
        return "no value is common enough to stand as the mode"
    return None


def _cap_skip(col: pd.Series, name: str) -> Optional[str]:
    if _YEAR_COL_RE.search(name):
        return "a year is a calendar fact, not a distribution to winsorise"
    v = pd.to_numeric(col, errors="coerce").dropna()
    if v.empty:
        return "no numeric values"
    q1, q3 = v.quantile([0.25, 0.75])
    iqr_ = q3 - q1
    if iqr_ <= 0:
        return "Q1 equals Q3, so both fences land on one value"
    lo, hi = q1 - 1.5 * iqr_, q3 + 1.5 * iqr_
    if not ((v < lo) | (v > hi)).any():
        return "nothing sits outside the fences"
    if v.nunique() == len(v) and _ID_NAME_RE.search(name):
        return "every value is distinct and the name reads as an identifier"
    return None


def _analyse(df: pd.DataFrame) -> List[Dict[str, Any]]:
    """One pass of the IDE's analyser: the ops the data asks for, with evidence. One scan per column, vectorised."""
    ops: List[Dict[str, Any]] = []
    cols = list(df.columns)
    year_now = date.today().year
    types = {c: column_type(df[c]) for c in cols}
    info = {c: _TextInfo(df[c]) for c in cols if is_text(df[c])}
    str_cols = list(info)
    nmiss = {c: int(_missing_mask(df[c]).sum()) for c in cols}

    def add(key: str, **kw: Any) -> None:
        ops.append({"op": key, "safe": key in SAFE_OPS, **kw})

    # table-wide string hygiene
    n_enc = sum(info[c].count(info[c].enc) for c in str_cols)
    if n_enc:
        add("fix-encoding", cells=n_enc, columns=[], why="mojibake, NBSP or zero-width characters")
    n_trim = sum(info[c].count(info[c].trim) for c in str_cols)
    if n_trim:
        add("trim", cells=n_trim, columns=[], why="leading / trailing whitespace")
    n_ws = sum(info[c].count(info[c].ws) for c in str_cols)
    if n_ws:
        add("collapse-whitespace", cells=n_ws, columns=[], why="runs of internal whitespace")
    found: Dict[str, int] = {}
    for c in str_cols:
        ti = info[c]
        if ti.missing.any():
            for tok, cnt in zip(ti.stripped[ti.missing.to_numpy()], ti.counts[ti.missing.to_numpy()]):
                found[str(tok)] = found.get(str(tok), 0) + int(cnt)
    if found:
        add("missing-tokens", cells=sum(found.values()), columns=[], why="missing markers: " + ", ".join(sorted(found)[:12]))

    # typed parses
    claimed: Set[str] = set()
    num_cols = [c for c in str_cols if types[c] == "string" and info[c].share(info[c].numeric) >= 0.8]
    if num_cols:
        claimed.update(num_cols)
        add("parse-numeric", cells=sum(info[c].count(info[c].numeric) for c in num_cols), columns=num_cols, why="≥ 80 % of cells parse as numbers")
    date_cols = [c for c in str_cols if c not in claimed and types[c] != "number" and info[c].share(info[c].date) >= 0.8]
    if date_cols:
        claimed.update(date_cols)
        add("parse-dates", cells=sum(info[c].count(info[c].date) for c in date_cols), columns=date_cols, why="≥ 80 % of cells are date-shaped")
    bool_cols = [c for c in str_cols if c not in claimed and _bool_candidate_info(info[c])]
    if bool_cols:
        claimed.update(bool_cols)
        add("standardise-booleans", cells=sum(info[c].count(info[c].bool_true | info[c].bool_false) for c in bool_cols), columns=bool_cols, why="two boolean spellings, ≤ 5 % other values")
    sent_cols = []
    sent_cells = 0
    for c in cols:
        if pd.api.types.is_numeric_dtype(df[c]) and not pd.api.types.is_bool_dtype(df[c]):
            vals = _sentinel_values(df[c])
            if vals:
                sent_cols.append(c)
                sent_cells += int(df[c].isin(list(vals)).sum())
    if sent_cols:
        add("replace-numeric-sentinels", cells=sent_cells, columns=sent_cols, why="recurring sentinel values ≥ 5 IQR outside the body")
    coerce_cols = [c for c in str_cols if types[c] == "number"]
    if coerce_cols:
        add("coerce-numeric", cells=sum(info[c].n_str for c in coerce_cols), columns=coerce_cols, why="number-typed columns holding string residue")
        claimed.update(coerce_cols)

    # recode near-duplicate labels (at most one per plan)
    best: Optional[Tuple[str, str, str, int]] = None
    for c in str_cols:
        ti = info[c]
        if ti.n_str == 0:
            continue
        top = [(str(v), int(n)) for v, n in zip(ti.uniq.head(8), ti.counts.head(8))]
        hit = _near_duplicate(top, len(df) - nmiss[c])
        if hit and (best is None or hit[2] > best[3]):
            best = (c, hit[0], hit[1], hit[2])
    if best:
        add("recode-value", cells=best[3], columns=[best[0]], why=f'"{best[1]}" looks like a misspelling of "{best[2]}"', recode={"column": best[0], "from": best[1], "to": best[2]})

    # future years
    fy_cols = []
    fy_cells = 0
    for c in cols:
        if pd.api.types.is_numeric_dtype(df[c]) and _YEAR_COL_RE.search(str(c)):
            v = pd.to_numeric(df[c], errors="coerce").dropna()
            if len(v) and v.min() >= 1900 and v.max() <= 2100 and v.max() > year_now:
                n = int(((v > year_now) & (v % 1 == 0)).sum())
                if n:
                    fy_cols.append(c)
                    fy_cells += n
    if fy_cols:
        add("null-future-years", cells=fy_cells, columns=fy_cols, why=f"years after {year_now}")

    # duplicates
    n_dupes = int(df.duplicated().sum())
    if n_dupes:
        add("drop-duplicates", cells=n_dupes, columns=[], why="exact duplicate rows")

    # empty / constant columns
    empty_cols = [c for c in cols if len(df) and nmiss[c] / len(df) > 0.95]
    if empty_cols and len(empty_cols) < len(cols):
        add("drop-empty-cols", cells=len(empty_cols), columns=empty_cols, why="> 95 % missing")
    const_cols = []
    for c in cols:
        present = len(df) - nmiss[c]
        if present and df[c][~_missing_mask(df[c])].astype(str).nunique() == 1:
            const_cols.append(c)
    if const_cols and len(const_cols) < len(cols):
        add("drop-constant-cols", cells=len(const_cols), columns=const_cols, why="single-valued")

    # lower-case categoricals
    lc = {c: _case_merges_info(info[c]) for c in str_cols}
    lc_cols = [c for c in str_cols if lc[c] > 0]
    if lc_cols:
        add("lowercase-categoricals", cells=sum(lc[c] for c in lc_cols), columns=lc_cols, why="labels differing only by case")

    # learned ops, held back on columns unsettled by this pass
    unsettled: Set[str] = set()
    for o in ops:
        if o["op"] == "missing-tokens":
            unsettled.update(str_cols)
        unsettled.update(o.get("columns", []))
    cap_cols = [c for c in cols if c not in unsettled and pd.api.types.is_numeric_dtype(df[c]) and not pd.api.types.is_bool_dtype(df[c]) and _cap_skip(df[c], str(c)) is None]
    if cap_cols:
        n = 0
        for c in cap_cols:
            v = pd.to_numeric(df[c], errors="coerce").dropna()
            q1, q3 = v.quantile([0.25, 0.75])
            lo, hi = q1 - 1.5 * (q3 - q1), q3 + 1.5 * (q3 - q1)
            n += int(((v < lo) | (v > hi)).sum())
        add("cap-outliers", cells=n, columns=cap_cols, why="values outside the Tukey fences")
    imp_cols = []
    imp_cells = 0
    for c in cols:
        if c in unsettled or nmiss[c] == 0:
            continue
        miss = _missing_mask(df[c])
        if _impute_skip(df[c], df.loc[~miss, c], nmiss[c], types[c]):
            continue
        imp_cols.append(c)
        imp_cells += nmiss[c]
    if imp_cols:
        add("impute-missing", cells=imp_cells, columns=imp_cols, why="median (numeric) / mode (categorical) fills with was_missing_* indicators")

    # snake-case headers
    mapping = {}
    collision = False
    taken = set(map(str, cols))
    for c in cols:
        sn = snake_case(str(c))
        if sn is None:
            continue
        if sn in taken or sn in mapping.values():
            collision = True
            break
        mapping[c] = sn
    if mapping and not collision:
        add("rename-snake-case", cells=len(mapping), columns=list(mapping), why="headers with spaces, punctuation or CamelCase")
    return ops


def _missing_mask(col: pd.Series) -> pd.Series:
    """Vectorised Scelo "missing": null / NA / NaT or the empty string."""
    m = col.isna()
    if is_text(col):
        m = m | (col.astype(object) == "")
    return m


def _bool_candidate_info(ti: "_TextInfo") -> bool:
    if ti.n_cand < 4:
        return False
    t = ti.count(ti.bool_true)
    f = ti.count(ti.bool_false)
    other = ti.n_cand - t - f
    canon = ti.uniq.isin(["true", "false"]).fillna(False)
    noncanon = ti.count((ti.bool_true | ti.bool_false) & ~canon)
    return t > 0 and f > 0 and other / ti.n_cand <= 0.05 and noncanon > 0


def _case_merges_info(ti: "_TextInfo") -> int:
    top = ti.uniq.head(8)
    if len(top) < 2:
        return 0
    groups = top.str.lower().value_counts()
    return int((groups[groups > 1] - 1).sum())


_OP_TITLES = {
    "fix-encoding": "fix encoding", "trim": "trim whitespace", "collapse-whitespace": "collapse internal whitespace",
    "missing-tokens": "null missing markers", "parse-numeric": "parse numbers", "parse-dates": "parse dates",
    "standardise-booleans": "standardise booleans", "replace-numeric-sentinels": "null numeric sentinels",
    "coerce-numeric": "coerce numeric residue", "recode-value": "recode near-duplicate label",
    "null-future-years": "null future years", "drop-duplicates": "drop duplicate rows",
    "drop-empty-cols": "drop empty columns", "drop-constant-cols": "drop constant columns",
    "lowercase-categoricals": "lower-case categoricals", "rename-snake-case": "snake_case headers",
    "cap-outliers": "cap outliers to the Tukey fences", "impute-missing": "impute missing values",
}


@tool
def suggest(df: pd.DataFrame) -> Table:
    """What the data asks for: one row per proposed cleaning op with evidence (cells, columns, why) and a ``safe`` flag.

    Safe ops are applied by ``clean(df)``; the rest only by ``clean(df, "all")``
    or by naming them. Read it the way you would read the IDE's banner.
    """
    ops = _analyse(df)
    rows = [{"op": o["op"], "title": _OP_TITLES[o["op"]], "safe": o["safe"], "cells": o["cells"],
             "columns": ", ".join(map(str, o.get("columns", []))), "why": o["why"]} for o in ops]
    t = Table(pd.DataFrame(rows, columns=["op", "title", "safe", "cells", "columns", "why"]),
              title=f"cleaning plan · {len(ops)} op(s) · {len(df):,} rows × {df.shape[1]} cols", stage="soft")
    if not ops:
        t.notes.append("Nothing to clean: no op found anything to do.")
    else:
        t.notes.append(f"{sum(1 for o in ops if o['safe'])} safe op(s) run with clean(df); {sum(1 for o in ops if not o['safe'])} need clean(df, \"all\") or an explicit list.")
    return t


def _apply_plan(df: pd.DataFrame, ops: List[Dict[str, Any]], enabled: Set[str]) -> Tuple[pd.DataFrame, List[str]]:
    """Apply the enabled ops of a plan in the IDE's order; returns (frame, what-was-done lines)."""
    done: List[str] = []
    out = df
    by_key = {o["op"]: o for o in ops}

    def on(key: str) -> Optional[Dict[str, Any]]:
        return by_key.get(key) if key in enabled else None

    for key, fn in (("fix-encoding", fix_encoding), ("trim", trim), ("collapse-whitespace", collapse_ws), ("missing-tokens", missing_tokens)):
        o = on(key)
        if o:
            out = fn(out)
            done.append(f"{_OP_TITLES[key]}: {o['cells']:,} cells")
    o = on("recode-value")
    if o:
        r = o["recode"]
        out = recode(out, r["column"], r["from"], r["to"])
        done.append(f"recode `{r['column']}`: \"{r['from']}\" → \"{r['to']}\" ({o['cells']} cells)")
    o = on("standardise-booleans")
    if o:
        out = booleans(out, o["columns"])
        done.append(f"booleans: {', '.join(map(str, o['columns']))}")
    o = on("parse-dates")
    if o:
        before = {c: int(_missing_mask(out[c]).sum()) for c in o["columns"]}
        out = parse_dates(out, o["columns"])
        unparsed = {c: int(out[c].isna().sum()) - before[c] for c in o["columns"]}
        extra = "; ".join(f"{c}: {n} unparseable → null" for c, n in unparsed.items() if n > 0)
        done.append(f"dates: {', '.join(map(str, o['columns']))}" + (f" ({extra})" if extra else ""))
    o = on("parse-numeric")
    if o:
        before = {c: int(_missing_mask(out[c]).sum()) for c in o["columns"]}
        out = parse_numbers(out, o["columns"])
        unparsed = {c: int(out[c].isna().sum()) - before[c] for c in o["columns"]}
        extra = "; ".join(f"{c}: {n} unparseable → null" for c, n in unparsed.items() if n > 0)
        done.append(f"numbers: {', '.join(map(str, o['columns']))}" + (f" ({extra})" if extra else ""))
    o = on("coerce-numeric")
    if o:
        out = coerce_numeric(out, o["columns"])
        done.append(f"coerce numeric residue: {', '.join(map(str, o['columns']))}")
    o = on("replace-numeric-sentinels")
    if o:
        out = sentinels(out, o["columns"])
        done.append(f"sentinels → null: {', '.join(map(str, o['columns']))} ({o['cells']} cells)")
    o = on("null-future-years")
    if o:
        out = future_years(out, o["columns"])
        done.append(f"future years → null: {', '.join(map(str, o['columns']))} ({o['cells']} cells)")
    o = on("lowercase-categoricals")
    if o:
        out = lowercase(out, o["columns"])
        done.append(f"lower-case: {', '.join(map(str, o['columns']))}")
    o = on("drop-duplicates")
    if o:
        n0 = len(out)
        out = dedupe(out)
        done.append(f"duplicates dropped: {n0 - len(out)} rows")
    dropped: List[str] = []
    for key in ("drop-empty-cols", "drop-constant-cols"):
        o = on(key)
        if o:
            dropped.extend(o["columns"])
    if dropped:
        out = out.drop(columns=[c for c in dropped if c in out.columns])
        done.append(f"columns dropped (empty / constant): {', '.join(map(str, dropped))}")
    o = on("rename-snake-case")
    if o:
        out = snake_names(out)
        done.append(f"headers snake_cased: {len(o['columns'])}")
    rename = {c: (snake_case(str(c)) or c) for c in dropped} if on("rename-snake-case") else {}
    o = on("cap-outliers")
    if o:
        cols = [(_rename(c, on("rename-snake-case"))) for c in o["columns"]]
        cols = [c for c in cols if c in out.columns]
        out = cap_outliers(out, cols)
        done.append(f"outliers capped: {', '.join(map(str, cols))} ({o['cells']} values)")
    o = on("impute-missing")
    if o:
        cols = [(_rename(c, on("rename-snake-case"))) for c in o["columns"]]
        cols = [c for c in cols if c in out.columns]
        out = impute(out, cols)
        done.append(f"imputed: {', '.join(map(str, cols))} ({o['cells']} cells, was_missing_* indicators added)")
    return out, done


def _rename(c: Any, snake_op: Optional[Dict[str, Any]]) -> Any:
    if snake_op and c in snake_op["columns"]:
        return snake_case(str(c)) or c
    return c


@tool
def clean(
    df: pd.DataFrame,
    ops: Union[None, str, Sequence[str]] = None,
    *,
    passes: Optional[int] = None,
) -> Table:
    """Clean a frame. ``clean(df)`` runs the safe ops once; ``clean(df, "all")`` runs everything until clean (≤ 8 passes).

    ``ops`` may also be a list of op names (aliases accepted: "dedupe",
    "winsorize", "impute", "snake", "dates", "money" …). The returned
    :class:`Table` notes list exactly what changed; nothing is printed.
    """
    if ops is None or (isinstance(ops, str) and ops.lower() in ("safe", "default", "recommended")):
        enabled: Optional[Set[str]] = set(SAFE_OPS)
        max_passes = passes or 1
    elif isinstance(ops, str) and ops.lower() in ("all", "everything", "*"):
        enabled = None
        max_passes = passes or AUTO_CLEAN_MAX_PASSES
    else:
        enabled = {_norm_op(o) for o in ([ops] if isinstance(ops, str) else ops)}
        max_passes = passes or 1
    working = pd.DataFrame(df)
    rows0, cols0 = working.shape
    notes: List[str] = []
    prev_sig = None
    outcome = "clean"
    for p in range(1, max_passes + 1):
        plan = _analyse(working)
        plan = [o for o in plan if enabled is None or o["op"] in enabled]
        if not plan:
            outcome = "clean"
            break
        sig = json.dumps([(o["op"], o["cells"], list(map(str, o.get("columns", [])))) for o in plan], sort_keys=True)
        if sig == prev_sig:
            outcome = "stalled"
            break
        prev_sig = sig
        working, done = _apply_plan(working, plan, {o["op"] for o in plan})
        notes.extend((f"pass {p} · " if max_passes > 1 else "") + d for d in done)
        outcome = "exhausted"
    if outcome == "exhausted" and max_passes > 1:
        rem = [o for o in _analyse(working) if enabled is None or o["op"] in enabled]
        outcome = "clean" if not rem else "exhausted"
    if not notes:
        notes.append("Nothing to clean.")
    else:
        remaining = _analyse(working)
        rem_enabled = [o for o in remaining if enabled is None or o["op"] in enabled]
        rem_other = [o for o in remaining if enabled is not None and o["op"] not in enabled]
        shape = f"{rows0:,}×{cols0} → {len(working):,}×{working.shape[1]}"
        if outcome == "stalled":
            notes.append(f"{shape} · stalled: the same plan came back twice, so the rest needs a human.")
        elif rem_enabled:
            notes.append(f"{shape} · {max_passes} pass(es) spent; {len(rem_enabled)} op(s) still apply, run again or inspect suggest().")
        else:
            notes.append(f"{shape} · clean: a further pass finds nothing more to do" + (
                f" ({len(rem_other)} unsafe op(s) available via clean(df, \"all\"): {', '.join(o['op'] for o in rem_other)})." if rem_other else "."))
    out = Table(working, title=f"clean · {len(df):,} rows", notes=notes, stage="soft")
    return out
