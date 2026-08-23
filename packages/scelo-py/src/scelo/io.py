"""Loading and saving: the soft-data intake, with Scelo's typing rules.

``load(path)`` reads CSV / TSV / TXT (delimiter sniffed) / Parquet / Excel /
JSON / Feather and applies the same cell coercion Scelo IDE applies at import
(``coerceCsvCell`` in packages/scelo-core): a small set of missing tokens
becomes null, only strictly numeric strings become numbers, id-like integers
("007", > 2^53) stay strings. Nothing else is touched: cleaning is an
explicit, auditable step (``scelo.clean``), not something that happens on
the way in.

Row cap: the IDE keeps a uniform reservoir sample past 250 000 rows so a
2-million-row extract cannot kill the window. ``load`` has no cap by default
(a script has the whole machine) but ``rows=`` gives you the same reservoir.
"""

from __future__ import annotations

import io as _io
import os
import re
from pathlib import Path
from typing import Any, Iterable, List, Optional, Union

import numpy as np
import pandas as pd

from ._audit import record
from ._table import Table

__all__ = [
    "load", "save", "coerce", "coerce_cell", "sniff", "samples", "sample", "reservoir",
    "DEFAULT_IMPORT_ROW_CAP", "MISSING_CELL_TOKENS",
]

PathLike = Union[str, "os.PathLike[str]"]

# Mirrors scelo-core: deliberately small and unambiguous. The long tail
# ("?", "TBD", "#N/A" …) is the cleaning layer's missing-tokens op.
MISSING_CELL_TOKENS = frozenset({"null", "na", "n/a", "nan", "none", "-"})
_NUMERIC_STRING_RE = re.compile(r"^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$")
_PLAIN_INTEGER_RE = re.compile(r"^[+-]?\d+$")
_LEADING_ZERO_RE = re.compile(r"^[+-]?0\d")
_SAFE_INT = 2**53 - 1

DEFAULT_IMPORT_ROW_CAP = 250_000

_DATA_DIR = Path(__file__).parent / "data"
_SAMPLES = {
    "claims": ("Synthetic claims", "P&C reserving / pricing demo: 79 rows of an incomplete claims triangle (origins 2018–2024) with policy, line, province, age, sex, paid, incurred, settled."),
    "climate": ("Climate reanalysis ensemble", "30 daily records for one grid cell (Pretoria, Jan 2024): 2-m temperature and precipitation under ERA5 / MERRA-2 / JRA-3Q."),
    "dirty": ("Messy intake (dirty demo)", "53-row customer ledger with every real-world mess: currency strings, %-numbers, sentinel ages, mixed booleans and date formats, mojibake, NBSP / zero-width characters, missing markers, duplicate rows."),
    "wmtr-scenarios": ("WMTR forecast scenarios", "12 scenario rows for the W(M, T, R) Monte Carlo forecast: alpha_m / alpha_t / alpha_r, relational weights, shock, horizon."),
    "lifelib-mp": ("Lifelib model points", "100-row in-force term-life model-point file shaped like lifelib's basic_term_sample (age_at_entry, sex, sum_assured, policy_term, duration_mth, premium_pp)."),
    "workspace-demo": ("Workspace demo", "2,000-policy synthetic annuity book: three low-variance real drivers acting through nonlinear channels, a crude-rate level, ten high-variance nuisance columns."),
}


# ── cell coercion ───────────────────────────────────────────────────────────

def coerce_cell(raw: Any) -> Any:
    """Scelo's import-time cell rule: "" / small missing tokens → None, strict numerics → number, else the string.

    >>> coerce_cell(" 42 "), coerce_cell("007"), coerce_cell("NA"), coerce_cell("1e3"), coerce_cell("0x1f")
    (42, '007', None, 1000.0, '0x1f')
    """
    if raw is None:
        return None
    if isinstance(raw, float):
        return None if np.isnan(raw) else raw
    if not isinstance(raw, str):
        return raw
    s = raw.strip()
    if s == "":
        return None
    if len(s) <= 4 and s.lower() in MISSING_CELL_TOKENS:
        return None
    if not _NUMERIC_STRING_RE.match(s):
        return s
    if _PLAIN_INTEGER_RE.match(s):
        if _LEADING_ZERO_RE.match(s):
            return s
        n = int(s)
        return n if abs(n) <= _SAFE_INT else s
    try:
        f = float(s)
    except ValueError:
        return s
    return f if np.isfinite(f) else s


def _coerce_object_column(col: pd.Series) -> pd.Series:
    """Apply :func:`coerce_cell` to an object column and settle its dtype.

    All-numeric → numeric dtype; ≥ 80 % numeric (Scelo's typing rule) → the
    column is left as object so the non-numeric residue ("6+") stays visible
    for the cleaning layer's coerce-numeric op; otherwise strings.
    """
    vals = col.astype(object).map(coerce_cell)
    vals = vals.astype(object).where(vals.notna(), None)
    nonnull = vals[vals.notna()]
    if len(nonnull) == 0:
        return vals
    is_num = nonnull.map(lambda v: isinstance(v, (int, float)) and not isinstance(v, bool))
    if is_num.all():
        out = pd.to_numeric(vals, errors="coerce")
        if (out.dropna() % 1 == 0).all() and not out.isna().any():
            return out.astype("int64")
        return out
    return vals


def coerce(df: pd.DataFrame) -> pd.DataFrame:
    """Apply Scelo's import coercion to every object column of a frame (returns a new frame)."""
    out = df.copy()
    for c in out.columns:
        if is_text(out[c]):
            out[c] = _coerce_object_column(out[c].astype(object))
    return out


def is_text(col: pd.Series) -> bool:
    """True for object / string-dtype columns (pandas ≥ 3 reads text as ``str`` dtype, older as ``object``)."""
    return col.dtype == object or pd.api.types.is_string_dtype(col)


# ── delimiter sniffing ──────────────────────────────────────────────────────

def sniff(path: PathLike, nbytes: int = 1024) -> Optional[str]:
    """Guess the delimiter of a text file the way the IDE does; None when it does not look like delimited text.

    Reads the first KB, rejects binary (NUL bytes, > 2 % control bytes),
    drops the last (possibly truncated) line, keeps 20 lines and picks the
    candidate in ``, \\t ;`` whose *minimum* per-line count is highest.
    """
    with open(path, "rb") as fh:
        head = fh.read(nbytes)
    if b"\x00" in head:
        return None
    control = sum(1 for b in head if b < 32 and b not in (9, 10, 13))
    if head and control / len(head) > 0.02:
        return None
    text = head.decode("utf-8", errors="replace")
    lines = re.split(r"\r?\n", text)
    if len(lines) > 1:
        lines = lines[:-1]
    lines = [ln for ln in lines if ln.strip()][:20]
    if not lines:
        return None
    best, best_min = None, 0
    for cand in (",", "\t", ";"):
        m = min(ln.count(cand) for ln in lines)
        if m >= 1 and m > best_min:
            best, best_min = cand, m
    return best


# ── reservoir sampling ──────────────────────────────────────────────────────

def reservoir(df: pd.DataFrame, n: int, seed: Optional[int] = None) -> pd.DataFrame:
    """Uniform sample of ``n`` rows in original order (the IDE's import cap), with provenance in ``attrs``."""
    if len(df) <= n:
        return df
    rng = np.random.default_rng(seed)
    idx = np.sort(rng.choice(len(df), size=n, replace=False))
    out = df.iloc[idx].reset_index(drop=True)
    out.attrs["sampled"] = True
    out.attrs["sample_kind"] = "uniform"
    out.attrs["source_total_rows"] = len(df)
    return out


# ── load / save ─────────────────────────────────────────────────────────────

def load(
    path: PathLike,
    *,
    rows: Optional[int] = None,
    sheet: Union[int, str, None] = 0,
    sep: Optional[str] = None,
    coerce_cells: bool = True,
    seed: Optional[int] = None,
    **kwargs: Any,
) -> pd.DataFrame:
    """Read a file into a DataFrame with Scelo's import typing.

    Formats by extension: ``.csv`` ``.tsv`` ``.txt`` (delimiter sniffed)
    ``.parquet`` ``.feather`` ``.xlsx`` ``.xls`` ``.json`` ``.jsonl``.

    Parameters
    ----------
    rows : keep a uniform reservoir sample of this many rows (the IDE uses 250 000).
    sheet : Excel sheet (index or name).
    sep : delimiter override for text files.
    coerce_cells : apply :func:`coerce_cell` to object columns (default True).
    kwargs : passed to the underlying pandas reader.
    """
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"{p} does not exist")
    ext = p.suffix.lower()
    if ext == ".parquet":
        df = pd.read_parquet(p, **kwargs)
    elif ext == ".feather":
        df = pd.read_feather(p, **kwargs)
    elif ext in (".xlsx", ".xls", ".xlsm"):
        df = pd.read_excel(p, sheet_name=sheet, **kwargs)
    elif ext == ".json":
        df = pd.read_json(p, **kwargs)
    elif ext == ".jsonl":
        df = pd.read_json(p, lines=True, **kwargs)
    else:
        if sep is None:
            sep = "\t" if ext == ".tsv" else ("," if ext == ".csv" else sniff(p))
            if sep is None:
                raise ValueError(
                    f"{p.name} does not look like delimited text (binary content, or no consistent delimiter in the first KB): try .csv, .tsv or .parquet"
                )
        kwargs.setdefault("dtype", str)
        kwargs.setdefault("keep_default_na", False)
        kwargs.setdefault("na_filter", False)
        kwargs.setdefault("skip_blank_lines", True)
        kwargs.setdefault("encoding", "utf-8-sig")
        df = pd.read_csv(p, sep=sep, **kwargs)
        df.columns = _dedupe_header([str(c).strip() for c in df.columns])
    if coerce_cells:
        df = coerce(df)
    if rows is not None and len(df) > rows:
        df = reservoir(df, rows, seed=seed)
    df.attrs.setdefault("name", p.name)
    df.attrs["source"] = str(p)
    record("load", {"path": str(p), "rows": rows}, None, df, 0.0)
    return df


def _dedupe_header(cols: List[str]) -> List[str]:
    """Empty names become ``column``; duplicates get ``_2``, ``_3`` …"""
    seen: dict = {}
    out: List[str] = []
    for c in cols:
        name = c if c else "column"
        if name in seen:
            seen[name] += 1
            name = f"{name}_{seen[name]}"
        else:
            seen[name] = 1
        out.append(name)
    return out


def save(df: pd.DataFrame, path: PathLike, **kwargs: Any) -> Path:
    """Write a frame by extension (.csv .tsv .parquet .feather .xlsx .json .jsonl .md .html); returns the path.

    CSV is written RFC-4180 (LF line endings, no index). A :class:`Table`'s
    notes and basis go into ``.md`` / ``.html`` output automatically.
    """
    p = Path(path)
    ext = p.suffix.lower()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".partial")
    if ext in (".csv", ".tsv", ".txt"):
        kwargs.setdefault("index", False)
        kwargs.setdefault("lineterminator", "\n")
        pd.DataFrame(df).to_csv(tmp, sep="\t" if ext == ".tsv" else ",", **kwargs)
    elif ext == ".parquet":
        pd.DataFrame(df).to_parquet(tmp, index=False, **kwargs)
    elif ext == ".feather":
        pd.DataFrame(df).reset_index(drop=True).to_feather(tmp, **kwargs)
    elif ext in (".xlsx", ".xlsm"):
        pd.DataFrame(df).to_excel(tmp, index=False, **kwargs)
    elif ext == ".json":
        pd.DataFrame(df).to_json(tmp, orient="records", indent=2, **kwargs)
    elif ext == ".jsonl":
        pd.DataFrame(df).to_json(tmp, orient="records", lines=True, **kwargs)
    elif ext == ".md":
        text = df.to_markdown_report() if isinstance(df, Table) else _md(df)
        tmp.write_text(text + "\n", encoding="utf-8")
    elif ext in (".html", ".htm"):
        body = df._repr_html_() if isinstance(df, Table) else pd.DataFrame(df).to_html(index=False)
        tmp.write_text(body or "", encoding="utf-8")
    else:
        raise ValueError(f"unsupported extension {ext!r}")
    os.replace(tmp, p)  # atomic: <file>.partial → <file>, the house rule
    return p


def _md(df: pd.DataFrame) -> str:
    try:
        return pd.DataFrame(df).to_markdown(index=False)
    except ImportError:
        return "```\n" + pd.DataFrame(df).to_string(index=False) + "\n```"


# ── bundled samples ─────────────────────────────────────────────────────────

def samples() -> pd.DataFrame:
    """The bundled sample datasets (the same six Scelo IDE offers), as a table."""
    rows = [{"key": k, "title": t, "about": a} for k, (t, a) in _SAMPLES.items()]
    return pd.DataFrame(rows)


def sample(key: str = "claims", **kwargs: Any) -> pd.DataFrame:
    """Load a bundled sample: ``claims`` ``climate`` ``dirty`` ``wmtr-scenarios`` ``lifelib-mp`` ``workspace-demo``."""
    k = key.strip().lower().replace("_", "-")
    if k not in _SAMPLES:
        raise KeyError(f"unknown sample {key!r}: choose from {', '.join(_SAMPLES)}")
    df = load(_DATA_DIR / f"{k}.csv", **kwargs)
    df.attrs["name"] = _SAMPLES[k][0]
    return df
