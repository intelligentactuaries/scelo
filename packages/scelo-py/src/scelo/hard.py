"""Hard data: stamping, reporting, exporting.

A hard number is one that can be defended: it carries what produced it.
``hard(table)`` stamps a :class:`Table` with a content hash, the time, the
scelo version and the audit entries that led to it; ``report(...)`` writes
a board-pack (Markdown or HTML) from any number of tables with their notes
and provenance; ``export`` writes one table to a file; ``provenance`` reads
the stamp back; ``audit`` is the trail itself.
"""

from __future__ import annotations

import html as _html
import json
import os
import platform
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Union

import pandas as pd

from ._audit import audit, clear_audit, content_hash, enable_audit, entries
from ._table import Table, as_table
from ._version import __version__
from .io import save

__all__ = ["hard", "provenance", "report", "export", "audit", "clear_audit", "enable_audit", "verify", "snapshot", "restore", "snapshots"]


def hard(table: Union[pd.DataFrame, Table], title: Optional[str] = None, *, basis: Optional[str] = None, note: Optional[str] = None,
         assumptions: Optional[Dict[str, Any]] = None) -> Table:
    """Stamp a table as hard data: sha256 of its content, timestamp, scelo version, recent audit entries, optional assumption set."""
    t = as_table(table, title=title, basis=basis, stage="hard") if not isinstance(table, Table) else table
    if title:
        object.__setattr__(t, "title", title)
    if basis:
        object.__setattr__(t, "basis", basis)
    if note:
        t.notes.append(note)
    trail = entries()[-12:]
    prov = {
        "sha256": content_hash(pd.DataFrame(t)),
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "scelo": __version__,
        "python": platform.python_version(),
        "pandas": pd.__version__,
        "rows": int(len(t)),
        "columns": list(map(str, t.columns)),
        "trail": [{"fn": e["fn"], "at": e["at"], "in": e["in"], "out": e["out"]} for e in trail],
    }
    if assumptions:
        prov["assumptions"] = dict(assumptions)
    object.__setattr__(t, "provenance", prov)
    object.__setattr__(t, "stage", "hard")
    return t


def provenance(table: Any) -> Dict[str, Any]:
    """The provenance stamp of a hard table (empty dict when it was never stamped)."""
    return dict(getattr(table, "provenance", {}) or {})


def verify(table: Table) -> bool:
    """True when a stamped table's content still hashes to its provenance sha256 (it has not been edited since)."""
    p = provenance(table)
    return bool(p) and content_hash(pd.DataFrame(table)) == p.get("sha256")


def export(table: Union[pd.DataFrame, Table], path: Union[str, os.PathLike], **kwargs: Any) -> Path:
    """Write a table by extension (.csv .xlsx .parquet .json .md .html …); notes and provenance go with .md / .html."""
    return save(table, path, **kwargs)


def _md_table(t: Union[pd.DataFrame, Table]) -> str:
    if isinstance(t, Table):
        return t.to_markdown_report()
    try:
        return pd.DataFrame(t).to_markdown(index=False)
    except ImportError:
        return "```\n" + pd.DataFrame(t).to_string(index=False) + "\n```"


def report(*tables: Union[pd.DataFrame, Table, str], title: str = "Board pack", to: Optional[Union[str, os.PathLike]] = None,
           summary: Optional[str] = None, author: Optional[str] = None, stamp: bool = True) -> str:
    """Assemble a board-pack from tables (and free-text sections given as strings); returns Markdown, or HTML when ``to`` ends in .html.

    Every table section prints the title, basis, the table, its notes and
    its provenance line; unstamped tables are stamped first when ``stamp``.
    """
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    parts: List[str] = [f"# {title}", "", f"*Generated {now} · scelo {__version__}" + (f" · {author}" if author else "") + "*", ""]
    if summary:
        parts += ["## Executive summary", "", summary, ""]
    n = 0
    for item in tables:
        if isinstance(item, str):
            parts += [item, ""]
            continue
        n += 1
        t = item if isinstance(item, Table) else as_table(item, title=f"Table {n}")
        if stamp and not provenance(t):
            t = hard(t)
        parts += [_md_table(t), ""]
    trail = audit()
    if len(trail):
        parts += ["## Audit trail", "", "| at | fn | in | out | ms |", "|---|---|---|---|---|"]
        for _, e in trail.tail(40).iterrows():
            parts.append(f"| {e['at']} | {e['fn']} | {e['in_shape'] or ''} {e['in'] or ''} | {e['out_shape'] or ''} {e['out'] or ''} | {e['ms']} |")
        parts.append("")
    parts += ["---", "<sub>scelo · soft data → tools → hard data. Every number above travels with its basis and its hash.</sub>"]
    md = "\n".join(parts)
    if to is not None:
        p = Path(to)
        if p.suffix.lower() in (".html", ".htm"):
            body = _md_to_html(md)
            tmp = p.with_name(p.name + ".partial")
            tmp.write_text(body, encoding="utf-8")
            os.replace(tmp, p)
        else:
            tmp = p.with_name(p.name + ".partial")
            tmp.write_text(md + "\n", encoding="utf-8")
            os.replace(tmp, p)
    return md


def _md_to_html(md: str) -> str:
    """A small Markdown → HTML for the report (headings, paragraphs, lists, pipe tables, code fences); no dependency."""
    lines = md.split("\n")
    out: List[str] = ["<!doctype html><meta charset='utf-8'><title>scelo report</title>",
                      "<style>body{font:15px/1.5 Inter,system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#181715;background:#E8E4D8}"
                      "table{border-collapse:collapse;margin:.5rem 0;font-size:13px}td,th{border:1px solid #CDC7B8;padding:3px 8px;text-align:right}th{background:#DAD5C6}"
                      "td:first-child,th:first-child{text-align:left}pre{background:#F2EEE2;padding:.5rem;overflow:auto}sub{color:#605A51}h3{margin-top:2rem}</style>"]
    in_table = False
    in_code = False
    for ln in lines:
        if ln.startswith("```"):
            in_code = not in_code
            out.append("<pre>" if in_code else "</pre>")
            continue
        if in_code:
            out.append(_html.escape(ln))
            continue
        if ln.startswith("|"):
            cells = [c.strip() for c in ln.strip("|").split("|")]
            if all(set(c) <= set("-: ") for c in cells):
                continue
            if not in_table:
                out.append("<table>")
                in_table = True
                out.append("<tr>" + "".join(f"<th>{_html.escape(c)}</th>" for c in cells) + "</tr>")
            else:
                out.append("<tr>" + "".join(f"<td>{_html.escape(c)}</td>" for c in cells) + "</tr>")
            continue
        if in_table:
            out.append("</table>")
            in_table = False
        if ln.startswith("# "):
            out.append(f"<h1>{_html.escape(ln[2:])}</h1>")
        elif ln.startswith("## "):
            out.append(f"<h2>{_html.escape(ln[3:])}</h2>")
        elif ln.startswith("### "):
            out.append(f"<h3>{_html.escape(ln[4:])}</h3>")
        elif ln.startswith("- "):
            out.append(f"<li>{_html.escape(ln[2:])}</li>")
        elif ln.strip() == "---":
            out.append("<hr>")
        elif ln.strip():
            txt = _html.escape(ln)
            txt = txt.replace("&lt;sub&gt;", "<sub>").replace("&lt;/sub&gt;", "</sub>")
            out.append(f"<p>{txt}</p>")
    if in_table:
        out.append("</table>")
    return "\n".join(out)


# ── snapshots (the soft-data undo stack, on disk) ────────────────────────

def _snap_dir() -> Path:
    d = Path(os.environ.get("SCELO_HOME", Path.home() / ".scelo")) / "snapshots"
    d.mkdir(parents=True, exist_ok=True)
    return d


def snapshot(df: pd.DataFrame, name: str) -> Path:
    """Keep a named copy of a frame under ~/.scelo/snapshots (parquet when available, else CSV) so a step can be undone later."""
    d = _snap_dir()
    try:
        p = d / f"{name}.parquet"
        pd.DataFrame(df).to_parquet(p, index=False)
    except Exception:
        p = d / f"{name}.csv"
        pd.DataFrame(df).to_csv(p, index=False)
    meta = {"name": name, "at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "rows": int(len(df)), "cols": int(df.shape[1]), "sha256": content_hash(pd.DataFrame(df))}
    (d / f"{name}.json").write_text(json.dumps(meta, indent=2))
    return p


def restore(name: str) -> pd.DataFrame:
    """Load a snapshot by name."""
    d = _snap_dir()
    p = d / f"{name}.parquet"
    if p.exists():
        return pd.read_parquet(p)
    p = d / f"{name}.csv"
    if p.exists():
        return pd.read_csv(p)
    raise FileNotFoundError(f"no snapshot named {name!r} in {d}")


def snapshots() -> pd.DataFrame:
    """The snapshots on disk: name, time, rows, cols, hash."""
    rows = [json.loads(p.read_text()) for p in sorted(_snap_dir().glob("*.json"))]
    return pd.DataFrame(rows, columns=["name", "at", "rows", "cols", "sha256"])
