"""The audit trail: what the tools layer did, in order.

Scelo's pipeline rule is that hard data never travels without the trail that
produced it. Every tools function records one entry here (function, the
arguments that matter, input/output shapes and content hashes, wall time).
``scelo.audit()`` returns the trail as a DataFrame; ``scelo.hard()`` copies
the relevant entries onto the table it stamps.
"""

from __future__ import annotations

import functools
import hashlib
import inspect
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

import numpy as np
import pandas as pd

from ._version import __version__

_TRAIL: List[Dict[str, Any]] = []
_ENABLED = True


def content_hash(obj: Any) -> str:
    """sha256 of a DataFrame / Series / array / scalar's content (not its identity)."""
    h = hashlib.sha256()
    if isinstance(obj, pd.DataFrame):
        h.update(",".join(map(str, obj.columns)).encode())
        try:
            h.update(pd.util.hash_pandas_object(obj, index=False).values.tobytes())
        except TypeError:  # unhashable cells (lists, dicts)
            h.update(obj.to_csv(index=False).encode())
    elif isinstance(obj, pd.Series):
        try:
            h.update(pd.util.hash_pandas_object(obj, index=False).values.tobytes())
        except TypeError:
            h.update(obj.to_csv(index=False).encode())
    elif isinstance(obj, np.ndarray):
        h.update(np.ascontiguousarray(obj).tobytes())
    elif obj is None:
        h.update(b"None")
    else:
        h.update(repr(obj).encode())
    return h.hexdigest()


def _shape(obj: Any) -> Optional[str]:
    if isinstance(obj, pd.DataFrame):
        return f"{len(obj)}×{obj.shape[1]}"
    if isinstance(obj, (pd.Series, np.ndarray, list, tuple)):
        return f"{len(obj)}"
    return None


def _summarise_arg(v: Any) -> Any:
    if isinstance(v, (pd.DataFrame, pd.Series, np.ndarray)):
        return f"<{type(v).__name__} {_shape(v)} {content_hash(v)[:8]}>"
    if isinstance(v, (int, float, str, bool)) or v is None:
        return v
    if isinstance(v, (list, tuple)) and len(v) <= 12:
        return [_summarise_arg(x) for x in v]
    if isinstance(v, dict) and len(v) <= 12:
        return {k: _summarise_arg(x) for k, x in v.items()}
    return f"<{type(v).__name__}>"


def record(fn: str, args: Dict[str, Any], inputs: Any, output: Any, ms: float, note: str = "") -> Dict[str, Any]:
    entry = {
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "fn": fn,
        "args": {k: _summarise_arg(v) for k, v in args.items()},
        "in": content_hash(inputs)[:16] if inputs is not None else None,
        "in_shape": _shape(inputs),
        "out": content_hash(output)[:16] if output is not None else None,
        "out_shape": _shape(output),
        "ms": round(ms, 2),
        "scelo": __version__,
        "note": note,
    }
    if _ENABLED:
        _TRAIL.append(entry)
    return entry


def tool(fn: Callable) -> Callable:
    """Decorator: time the call, hash its first DataFrame-like input and its output, log it."""
    sig = inspect.signature(fn)

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any):
        t0 = time.perf_counter()
        out = fn(*args, **kwargs)
        ms = (time.perf_counter() - t0) * 1000
        if _ENABLED:
            try:
                bound = sig.bind_partial(*args, **kwargs)
                argmap = dict(bound.arguments)
            except TypeError:
                argmap = {"args": args, "kwargs": kwargs}
            first = next((v for v in argmap.values() if isinstance(v, (pd.DataFrame, pd.Series, np.ndarray))), None)
            out_for_hash = out
            if isinstance(out, tuple) and out and isinstance(out[0], (pd.DataFrame, pd.Series)):
                out_for_hash = out[0]
            elif not isinstance(out, (pd.DataFrame, pd.Series, np.ndarray)):
                out_for_hash = getattr(out, "table", None)
            record(fn.__name__, argmap, first, out_for_hash, ms)
        return out

    wrapper.__scelo_tool__ = True  # type: ignore[attr-defined]
    return wrapper


def audit(last: Optional[int] = None) -> pd.DataFrame:
    """The audit trail as a DataFrame (most recent last). ``last=n`` for the tail."""
    rows = _TRAIL[-last:] if last else list(_TRAIL)
    if not rows:
        return pd.DataFrame(columns=["at", "fn", "args", "in", "in_shape", "out", "out_shape", "ms", "scelo", "note"])
    return pd.DataFrame(rows)


def clear_audit() -> None:
    """Forget the trail (a new session / a new deliverable)."""
    _TRAIL.clear()


def enable_audit(on: bool = True) -> None:
    """Switch recording on/off (it is on by default; off saves a little time in tight loops)."""
    global _ENABLED
    _ENABLED = bool(on)


def entries() -> List[Dict[str, Any]]:
    return list(_TRAIL)
