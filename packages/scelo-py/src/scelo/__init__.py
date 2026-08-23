"""scelo: soft data → tools → hard data, for actuaries who write code.

    import scelo as sc
    df  = sc.load("claims.csv")          # soft: typed the way Scelo IDE types it
    df  = sc.clean(df)                   # the IDE's safe cleaning ops, audited
    res = sc.reserve(df)                 # tools: chain ladder, Mack, BF, bootstrap
    sc.report(res, to="pack.html")       # hard: numbers that travel with their basis

Everything is one ``sc.`` away and every table-shaped result is a
:class:`Table`, a pandas DataFrame that carries its title, basis, notes and
provenance. ``sc.cheatsheet()`` prints the one-screen map.
"""

from __future__ import annotations

from ._version import __version__
from ._table import Table, as_table, notes
from ._alias import COLUMN_ALIASES, find_column, infer
from ._audit import audit, clear_audit, enable_audit, content_hash
from .io import *  # noqa: F401,F403
from .profile import *  # noqa: F401,F403
from .clean import *  # noqa: F401,F403
from .combine import *  # noqa: F401,F403
from .life import *  # noqa: F401,F403
from .reserving import *  # noqa: F401,F403
from .finance import *  # noqa: F401,F403
from .risk import *  # noqa: F401,F403
from .pricing import *  # noqa: F401,F403
from .fairness import *  # noqa: F401,F403
from .climate import *  # noqa: F401,F403
from .wmtr import *  # noqa: F401,F403
from .swarm import *  # noqa: F401,F403
from .workspace import *  # noqa: F401,F403
from .lifelib import *  # noqa: F401,F403
from .hard import *  # noqa: F401,F403
from .pipelines import *  # noqa: F401,F403
from .viz import *  # noqa: F401,F403
import importlib as _importlib  # noqa: E402

_importlib.import_module("scelo.accessor")  # registers df.sc

_MODULES = ("io", "profile", "clean", "combine", "life", "reserving", "finance", "risk", "pricing", "fairness", "climate", "wmtr", "swarm",
            "workspace", "lifelib", "hard", "pipelines", "viz")
__all__ = sorted(
    {n for m in _MODULES for n in getattr(_importlib.import_module(f"scelo.{m}"), "__all__", [])}
    | {"Table", "as_table", "notes", "COLUMN_ALIASES", "find_column", "infer", "audit", "clear_audit", "enable_audit", "content_hash", "__version__"}
)
