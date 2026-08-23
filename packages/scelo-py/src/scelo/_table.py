"""Table: a pandas DataFrame that carries its own caveats.

Every Scelo output that is table-shaped is a :class:`Table`: a real
``pandas.DataFrame`` (slice it, merge it, plot it, ``.to_csv`` it) with four
extra attributes that survive most pandas operations:

``title``       one line naming the table,
``notes``       the things an actuary should know before trusting it,
``basis``       a one-line provenance label ("Gompertz–Makeham (illustrative) · i = 4 %"),
``provenance``  a dict stamped by :func:`scelo.hard`: content hash, time,
                scelo version, the audit entries that produced it.

Printing a Table prints the frame and then its notes, so the caveat is on
screen at the moment the number is, the one-way pipeline rule in practice:
a number never travels without its basis.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import pandas as pd

_NOTE_PREFIX = "  · "


class Table(pd.DataFrame):
    """A DataFrame with ``title``, ``notes``, ``basis`` and ``provenance``."""

    _metadata = ["title", "notes", "basis", "provenance", "stage"]

    def __init__(
        self,
        data=None,
        *args: Any,
        title: Optional[str] = None,
        notes: Optional[List[str]] = None,
        basis: Optional[str] = None,
        provenance: Optional[Dict[str, Any]] = None,
        stage: Optional[str] = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(data, *args, **kwargs)
        # Preserve metadata when constructed from another Table.
        src = data if isinstance(data, Table) else None
        has = src is not None
        object.__setattr__(self, "title", title if title is not None else (src.title if has else None))
        object.__setattr__(self, "notes", list(notes) if notes is not None else (list(src.notes) if has else []))
        object.__setattr__(self, "basis", basis if basis is not None else (src.basis if has else None))
        object.__setattr__(
            self, "provenance", dict(provenance) if provenance is not None else (dict(src.provenance) if has else {})
        )
        object.__setattr__(self, "stage", stage if stage is not None else (src.stage if has else "soft"))

    # pandas subclassing contract ------------------------------------------------
    @property
    def _constructor(self):
        return Table

    @property
    def _constructor_sliced(self):
        return pd.Series

    # presentation ----------------------------------------------------------------
    def _footer(self) -> str:
        lines: List[str] = []
        if self.title:
            lines.append(f"— {self.title}")
        if self.basis:
            lines.append(f"  basis: {self.basis}")
        for n in self.notes or []:
            lines.append(_NOTE_PREFIX + n)
        if self.provenance:
            h = self.provenance.get("sha256", "")
            if h:
                lines.append(f"  hard · {h[:12]} · scelo {self.provenance.get('scelo', '?')} · {self.provenance.get('at', '')}")
        return "\n".join(lines)

    def __repr__(self) -> str:  # pragma: no cover - presentation
        body = super().__repr__()
        foot = self._footer()
        return body + ("\n" + foot if foot else "")

    def _repr_html_(self) -> Optional[str]:  # pragma: no cover - presentation
        body = super()._repr_html_()
        foot = self._footer()
        if not foot or body is None:
            return body
        esc = foot.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        return body + f"<pre style='font-size:0.85em;opacity:0.8'>{esc}</pre>"

    # convenience -------------------------------------------------------------------
    def note(self, text: str) -> "Table":
        """Append a note (returns self, for chaining)."""
        self.notes.append(text)
        return self

    @property
    def df(self) -> pd.DataFrame:
        """A plain ``pandas.DataFrame`` copy (drops the Scelo metadata)."""
        return pd.DataFrame(self)

    def to_markdown_report(self) -> str:
        """Title, basis, the table (markdown) and the notes, one block."""
        out: List[str] = []
        if self.title:
            out.append(f"### {self.title}")
        if self.basis:
            out.append(f"*Basis:* {self.basis}")
        out.append("")
        try:
            out.append(pd.DataFrame(self).to_markdown(index=False))
        except ImportError:  # tabulate not installed
            out.append("```\n" + pd.DataFrame(self).to_string(index=False) + "\n```")
        if self.notes:
            out.append("")
            out.extend(f"- {n}" for n in self.notes)
        if self.provenance:
            out.append("")
            out.append(
                f"<sub>hard · sha256 {self.provenance.get('sha256', '')[:16]} · "
                f"scelo {self.provenance.get('scelo', '')} · {self.provenance.get('at', '')}</sub>"
            )
        return "\n".join(out)


def as_table(
    df: pd.DataFrame,
    title: Optional[str] = None,
    notes: Optional[List[str]] = None,
    basis: Optional[str] = None,
    stage: str = "hard",
) -> Table:
    """Wrap a DataFrame as a :class:`Table` (copying metadata if it already is one)."""
    t = Table(df)
    if title is not None:
        object.__setattr__(t, "title", title)
    if notes is not None:
        object.__setattr__(t, "notes", list(notes))
    if basis is not None:
        object.__setattr__(t, "basis", basis)
    object.__setattr__(t, "stage", stage)
    return t


def notes(x: Any) -> List[str]:
    """The notes attached to a Scelo result (empty list for plain objects)."""
    return list(getattr(x, "notes", []) or [])
