"""Charts: the few forms an actuarial report needs, drawn to one quiet spec.

Every function returns a ``matplotlib.figure.Figure`` (no pyplot state, so a
notebook shows it once and a script can ``fig.savefig``). The look follows
one spec for every chart: a white surface, hairline solid gridlines, thin
marks, text in ink tokens (never in the series colour), selective direct
labels, a legend whenever there is more than one series.

The palette is Scelo's brand stepped to pass the colour checks (lightness
band, chroma floor, colour-vision-deficiency separation, contrast) on white
and on the IDE's cream; ``SERIES[:3]`` also pass every pairwise check, so
small multiples and scatter plots stop at three hues. matplotlib is an
optional dependency: ``pip install matplotlib``.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

import numpy as np
import pandas as pd

__all__ = [
    "PALETTE", "SERIES", "SEQUENTIAL", "palette", "plot_bars", "plot_rates", "plot_relativities", "plot_projection", "plot_scr", "plot_csm",
    "plot_lines", "plot_triangle", "plot_table", "save_figure",
]

PALETTE: Dict[str, Any] = {
    "surface": "#FFFFFF",
    "ink": "#181715",          # text primary (Scelo fg)
    "ink_2": "#605A51",        # text secondary (fg-dim)
    "grid": "#E6E2D9",         # one step off the surface
    "axis": "#CDC7B8",
    "muted": "#B8B2A6",        # de-emphasis series
    "series": ["#1F8F5C", "#345DCB", "#C4631F", "#7649C7", "#B43939"],   # validated adjacent order; first 3 pass all-pairs
    "series_dark": ["#37996B", "#5F86DB", "#CC7238", "#9A72D6", "#D05656"],
    "sequential": ["#7FC4A3", "#4FAC82", "#1F8F5C", "#156B43", "#0E4A2E"],  # one hue, light → dark, validated ordinal
    "diverging": ("#345DCB", "#EDEAE3", "#C4631F"),
}
SERIES: List[str] = PALETTE["series"]
SEQUENTIAL: List[str] = PALETTE["sequential"]


def palette() -> Dict[str, Any]:
    """The chart palette (copy): surface, ink tokens, the categorical series order, the sequential ramp."""
    return {k: (list(v) if isinstance(v, list) else v) for k, v in PALETTE.items()}


def _mpl():
    try:
        import matplotlib
        from matplotlib.figure import Figure
    except ImportError:
        raise ImportError("charts need matplotlib: pip install matplotlib") from None
    return matplotlib, Figure


_FIG_CLASS = None


def _figure_class():
    """A Figure that Jupyter can show without pyplot: it renders itself to PNG on request."""
    global _FIG_CLASS
    if _FIG_CLASS is None:
        _, Figure = _mpl()

        class SceloFigure(Figure):
            def _repr_png_(self):
                import io
                buf = io.BytesIO()
                self.savefig(buf, format="png", dpi=self.dpi, facecolor=PALETTE["surface"], bbox_inches="tight")
                return buf.getvalue()

            def __repr__(self):
                return f"<scelo figure {self.get_figwidth():g}×{self.get_figheight():g} in, {len(self.axes)} axes>"

        _FIG_CLASS = SceloFigure
    return _FIG_CLASS


def _figure(w: float = 8.0, h: float = 4.0, rows: int = 1, cols: int = 1, **kw: Any):
    Figure = _figure_class()
    fig = Figure(figsize=(w, h), dpi=110, facecolor=PALETTE["surface"], layout="constrained")
    axes = fig.subplots(rows, cols, **kw)
    for ax in (np.atleast_1d(axes).ravel() if rows * cols > 1 else [axes]):
        _style_axis(ax)
    return fig, axes


def _style_axis(ax, grid_axis: str = "y") -> None:
    ax.set_facecolor(PALETTE["surface"])
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(PALETTE["axis"])
        ax.spines[side].set_linewidth(0.8)
    ax.tick_params(colors=PALETTE["ink_2"], labelsize=8.5, length=3, width=0.8, color=PALETTE["axis"])
    ax.grid(True, axis=grid_axis, color=PALETTE["grid"], linewidth=0.8, linestyle="-")
    ax.grid(False, axis="x" if grid_axis == "y" else "y")
    ax.set_axisbelow(True)
    ax.title.set_color(PALETTE["ink"])
    ax.xaxis.label.set_color(PALETTE["ink_2"])
    ax.yaxis.label.set_color(PALETTE["ink_2"])


def _title(ax, title: Optional[str], subtitle: Optional[str] = None) -> None:
    if title:
        ax.set_title(title, loc="left", fontsize=10.5, fontweight="bold", color=PALETTE["ink"], pad=18 if subtitle else 6)
    if subtitle:
        ax.text(0, 1.0, subtitle, transform=ax.transAxes, fontsize=8, color=PALETTE["ink_2"], va="bottom", ha="left")


def _fmt(v: float, digits: int = 0) -> str:
    if v is None or (isinstance(v, float) and not np.isfinite(v)):
        return ""
    if abs(v) >= 1e6:
        return f"{v / 1e6:,.2f}M"
    if abs(v) >= 1e4:
        return f"{v / 1e3:,.0f}k"
    return f"{v:,.{digits}f}" if abs(v) >= 100 or digits == 0 else f"{v:,.{max(digits, 2)}f}"


def _thousands(ax, axis: str = "y") -> None:
    matplotlib, _ = _mpl()
    from matplotlib.ticker import FuncFormatter
    formatter = FuncFormatter(lambda v, _p: _fmt(v))
    (ax.yaxis if axis == "y" else ax.xaxis).set_major_formatter(formatter)


def _legend(ax, **kw: Any) -> None:
    leg = ax.legend(frameon=False, fontsize=8.5, labelcolor=PALETTE["ink_2"], handlelength=1.2, **kw)
    for t in leg.get_texts():
        t.set_color(PALETTE["ink_2"])


# ── bars ─────────────────────────────────────────────────────────────────

def plot_bars(values: Union[pd.Series, pd.DataFrame], x: Optional[str] = None, y: Optional[str] = None, *, title: Optional[str] = None,
              subtitle: Optional[str] = None, horizontal: bool = True, sort: bool = True, highlight: Optional[Sequence[Any]] = None,
              label: bool = True, fmt: int = 0, xlabel: Optional[str] = None, figsize: Tuple[float, float] = (8, 4)):
    """One-series bar chart (magnitude by category): thin bars in one hue, values at the tips, optional ``highlight`` of a few categories.

    ``values`` is a Series (index = category) or a DataFrame with ``x`` and ``y``.
    """
    s = values if isinstance(values, pd.Series) else values.set_index(x)[y]
    s = pd.to_numeric(s, errors="coerce").dropna()
    if sort:
        s = s.sort_values(ascending=horizontal)
    n = len(s)
    fig, ax = _figure(figsize[0], max(figsize[1], 0.3 * n + 1.2) if horizontal else figsize[1])
    cats = [str(c) for c in s.index]
    hl = set(map(str, highlight)) if highlight else set()
    colors = [SERIES[0] if (not hl or c in hl) else PALETTE["muted"] for c in cats]
    if horizontal:
        bars = ax.barh(cats, s.to_numpy(), color=colors, height=0.5, edgecolor=PALETTE["surface"], linewidth=1.5)
        _style_axis(ax, grid_axis="x")
        _thousands(ax, "x")
        if label and n <= 30:
            for b, v in zip(bars, s.to_numpy()):
                ax.text(b.get_width(), b.get_y() + b.get_height() / 2, " " + _fmt(v, fmt), va="center", ha="left", fontsize=8, color=PALETTE["ink_2"])
        ax.margins(x=0.12)
        if xlabel:
            ax.set_xlabel(xlabel, fontsize=8.5)
    else:
        slot_px = figsize[0] * 0.82 * 110 / max(n, 1)          # pixels per category slot
        width = min(0.5, 32 / slot_px)                           # a column is at most ~32 px thick; the rest of the slot is air
        bars = ax.bar(cats, s.to_numpy(), color=colors, width=width, edgecolor=PALETTE["surface"], linewidth=1.5)
        _thousands(ax, "y")
        if label and n <= 30:
            for b, v in zip(bars, s.to_numpy()):
                ax.text(b.get_x() + b.get_width() / 2, b.get_height(), _fmt(v, fmt), va="bottom", ha="center", fontsize=8, color=PALETTE["ink_2"])
        ax.margins(y=0.12)
        if n > 8:
            ax.tick_params(axis="x", rotation=45)
        if xlabel:
            ax.set_ylabel(xlabel, fontsize=8.5)
    _title(ax, title, subtitle)
    return fig


def plot_rates(df: pd.DataFrame, by: str, event: str, *, exposure: Optional[str] = None, title: Optional[str] = None, ci: bool = True,
               min_n: int = 1, figsize: Tuple[float, float] = (8, 4)):
    """Event rate by group (lapse rate by country, by MBTI …): sorted bars in one hue with a 95 % interval and n in the tick label.

    ``event`` is a 0/1 column (or a count), ``exposure`` an optional exposure
    column (rate per unit of exposure); otherwise the rate is per policy.
    """
    e = pd.to_numeric(df[event], errors="coerce").fillna(0)
    w = pd.to_numeric(df[exposure], errors="coerce").fillna(0) if exposure else pd.Series(1.0, index=df.index)
    g = pd.DataFrame({"g": df[by].astype(str), "e": e, "w": w}).groupby("g").agg(events=("e", "sum"), expo=("w", "sum"), n=("e", "size"))
    g = g[g["n"] >= min_n]
    g["rate"] = g["events"] / g["expo"]
    g["se"] = np.sqrt(np.maximum(g["events"], 0.5)) / g["expo"]  # Poisson
    g = g.sort_values("rate")
    fig, ax = _figure(figsize[0], max(figsize[1], 0.3 * len(g) + 1.2))
    labels = [f"{k}  (n={int(r.n):,})" for k, r in g.iterrows()]
    y = np.arange(len(g))
    ax.barh(y, g["rate"].to_numpy(), color=SERIES[0], height=0.5, edgecolor=PALETTE["surface"], linewidth=1.5)
    if ci:
        ax.errorbar(g["rate"], y, xerr=1.96 * g["se"], fmt="none", ecolor=PALETTE["ink_2"], elinewidth=0.8, capsize=2)
    ax.set_yticks(y)
    ax.set_yticklabels(labels)
    _style_axis(ax, grid_axis="x")
    ax.xaxis.set_major_formatter(_mpl()[0].ticker.PercentFormatter(1.0, decimals=0))
    for yy, v in zip(y, g["rate"]):
        ax.text(v + (1.96 * g["se"].iloc[yy] if ci else 0), yy, f"  {v:.1%}", va="center", ha="left", fontsize=8, color=PALETTE["ink_2"])
    ax.margins(x=0.15)
    ax.set_xlim(left=0)
    overall = e.sum() / w.sum() if w.sum() else float("nan")
    ax.axvline(overall, color=PALETTE["ink_2"], linewidth=0.8)
    ax.text(overall, len(g) - 0.4, f" all {overall:.1%}", fontsize=8, color=PALETTE["ink_2"], va="bottom")
    _title(ax, title or f"{event} rate by {by}", "95 % Poisson interval" if ci else None)
    return fig


# ── GLM ──────────────────────────────────────────────────────────────────

def plot_relativities(model: Any, *, title: Optional[str] = None, log: bool = True, figsize: Optional[Tuple[float, float]] = None):
    """Forest plot of a log-link GLM's relativities: one panel per factor, dots at exp(β) with 95 % intervals, the base level hollow at 1.

    Levels sort by relativity inside each panel; the x-axis is log-scaled so
    0.5× and 2× sit symmetrically around the reference line.
    """
    coef = model.coef.set_index("term")
    terms = list(model.terms)
    cats = [t for t in terms if any(str(k).startswith(f"{t}[") for k in coef.index)]
    nums = [t for t in terms if t not in cats]
    panels = [(t, [k for k in coef.index if str(k).startswith(f"{t}[")]) for t in cats] + ([("numeric (per unit)", nums)] if nums else [])
    heights = [len(levels) + 1.5 for _, levels in panels]
    fig, axes = _figure(*(figsize or (8.5, max(3.2, 0.26 * sum(heights) + 0.8))), rows=len(panels), cols=1, gridspec_kw={"height_ratios": heights}, sharex=True)
    axes = np.atleast_1d(axes)
    for ax, (factor, keys) in zip(axes, panels):
        est = coef.loc[keys, "estimate"].to_numpy(dtype=float)
        se = coef.loc[keys, "std_err"].to_numpy(dtype=float)
        names = [str(k)[len(factor) + 1:-1] if str(k).startswith(f"{factor}[") else str(k) for k in keys]
        order = np.argsort(est)
        est, se, names = est[order], se[order], [names[i] for i in order]
        rel, lo, hi = np.exp(est), np.exp(est - 1.96 * se), np.exp(est + 1.96 * se)
        y = np.arange(len(names)) + 1
        ax.hlines(y, lo, hi, color=SERIES[0], linewidth=1.2)
        ax.plot(rel, y, "o", color=SERIES[0], markersize=6, markeredgecolor=PALETTE["surface"], markeredgewidth=1.5)
        if factor in cats:
            ax.plot([1.0], [0], "o", markerfacecolor=PALETTE["surface"], markeredgecolor=SERIES[0], markersize=6, markeredgewidth=1.4)
            names = [f"{getattr(model, 'base_levels', {}).get(factor, '')} (base)".strip()] + names
            y = np.concatenate([[0], y])
        ax.set_yticks(y)
        ax.set_yticklabels(names, fontsize=8.5)
        ax.axvline(1.0, color=PALETTE["ink_2"], linewidth=0.8)
        _style_axis(ax, grid_axis="x")
        ax.set_title(factor, loc="left", fontsize=9, color=PALETTE["ink"])
        if log:
            ax.set_xscale("log")
            from matplotlib.ticker import FixedLocator, FuncFormatter, NullLocator
            lo_all, hi_all = float(np.nanmin(lo)), float(np.nanmax(hi))
            ticks = [t for t in (0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50) if lo_all / 1.5 <= t <= hi_all * 1.5]
            ax.xaxis.set_major_locator(FixedLocator(ticks))
            ax.xaxis.set_minor_locator(NullLocator())
            ax.xaxis.set_major_formatter(FuncFormatter(lambda t, _p: f"{t:g}×"))
        ax.margins(y=0.15)
        top = np.argsort(rel)[-3:]  # label the three largest only
        for k in top:
            ax.text(hi[k], y[k + 1] if factor in cats else y[k], f"  {rel[k]:.2f}×", fontsize=7.5, color=PALETTE["ink_2"], va="center", ha="left")
    axes[-1].set_xlabel("relativity (exp β), 95 % interval", fontsize=8.5)
    fig.suptitle((title or f"Relativities · {model.formula}") + f"\n{model.family} / {model.link} · n = {model.n:,}", x=0.01, ha="left", fontsize=10.5, fontweight="bold", color=PALETTE["ink"])
    return fig


# ── projection / SCR / CSM ────────────────────────────────────────────────

def plot_projection(table: pd.DataFrame, *, title: Optional[str] = None, figsize: Tuple[float, float] = (11, 3.6)):
    """Three small multiples of a BasicTerm projection: annual cash flows (premiums, claims, expenses), cumulative PV of net cash flow, policies in force."""
    t = pd.DataFrame(table)
    yr = (t["month"] // 12) + 1
    annual = t.groupby(yr)[["premiums", "claims", "expenses"]].sum()
    cum = t["pv_net_cf"].cumsum()
    fig, axes = _figure(figsize[0], figsize[1], rows=1, cols=3)
    ax = axes[0]
    for i, (col, name) in enumerate([("premiums", "premiums"), ("claims", "claims"), ("expenses", "expenses")]):
        ax.plot(annual.index, annual[col], color=SERIES[i], linewidth=2, label=name, solid_capstyle="round")
    _thousands(ax, "y")
    ax.margins(x=0.05)
    ax.set_xlabel("projection year", fontsize=8.5)
    _legend(ax, loc="upper right")
    _title(ax, "Annual cash flows")
    ax = axes[1]
    ax.plot(t["month"] / 12, cum, color=SERIES[0], linewidth=2)
    ax.fill_between(t["month"] / 12, 0, cum, color=SERIES[0], alpha=0.10, linewidth=0)
    ax.axhline(0, color=PALETTE["ink_2"], linewidth=0.8)
    be = getattr(table, "attrs", {}).get("break_even_month")
    if be and be > 1 and be < len(cum):
        ax.plot([be / 12], [cum.iloc[be]], "o", color=SERIES[0], markersize=7, markeredgecolor=PALETTE["surface"], markeredgewidth=1.5)
        ax.text(be / 12, cum.iloc[be], f"  break-even month {be}", fontsize=8, color=PALETTE["ink_2"], va="bottom")
    ax.text(t["month"].iloc[-1] / 12, cum.iloc[-1], f" {_fmt(cum.iloc[-1])}", fontsize=8, color=PALETTE["ink_2"], va="center")
    ax.margins(x=0.15)
    _thousands(ax, "y")
    ax.set_xlabel("projection year", fontsize=8.5)
    _title(ax, "Cumulative PV of net cash flow")
    ax = axes[2]
    if "inforce_policies" in t.columns:
        ax.plot(t["month"] / 12, t["inforce_policies"], color=SERIES[0], linewidth=2)
        ax.text(0, t["inforce_policies"].iloc[0], f" {_fmt(t['inforce_policies'].iloc[0])} at start", fontsize=8, color=PALETTE["ink_2"], va="bottom")
        ax.margins(x=0.05)
        _thousands(ax, "y")
        ax.set_ylim(bottom=0)
    ax.set_xlabel("projection year", fontsize=8.5)
    _title(ax, "Policies in force")
    fig.suptitle(title or getattr(table, "title", None) or "BasicTerm projection", x=0.01, ha="left", fontsize=11, fontweight="bold", color=PALETTE["ink"])
    return fig


def plot_scr(table: pd.DataFrame, *, title: Optional[str] = None, figsize: Tuple[float, float] = (8, 3.8)):
    """The SCR build-up: sub-risk charges as bars in one hue, the undiversified sum and the diversified SCR in ink, diversification labelled."""
    t = pd.DataFrame(table)
    modules = t.drop(index=[i for i in ("sum", "SCR", "diversification") if i in t.index], errors="ignore")
    modules = modules[modules["charge"] > 0].sort_values("charge")
    total = float(t.loc["sum", "charge"]) if "sum" in t.index else float(modules["charge"].sum())
    scr = float(t.loc["SCR", "charge"]) if "SCR" in t.index else float("nan")
    fig, ax = _figure(figsize[0], max(figsize[1], 0.34 * (len(modules) + 2) + 1.3))
    cats = ["SCR (diversified)", "sum of charges"] + list(modules.index)   # bottom → top: totals, then charges ascending
    vals = [scr, total] + list(modules["charge"])
    colors = [PALETTE["ink_2"], PALETTE["muted"]] + [SERIES[0]] * len(modules)
    y = np.arange(len(cats))
    ax.barh(y, vals, color=colors, height=0.5, edgecolor=PALETTE["surface"], linewidth=1.5)
    ax.set_yticks(y)
    ax.set_yticklabels(cats, fontsize=8.5)
    for yy, v in zip(y, vals):
        ax.text(v, yy, " " + _fmt(v), va="center", ha="left", fontsize=8, color=PALETTE["ink_2"])
    ax.axvline(scr, color=PALETTE["ink_2"], linewidth=0.8)
    _style_axis(ax, grid_axis="x")
    _thousands(ax, "x")
    ax.margins(x=0.15)
    ax.set_xlim(left=0)
    div = total - scr if np.isfinite(scr) else float("nan")
    _title(ax, title or getattr(table, "title", None) or "Solvency II life SCR", f"diversification {_fmt(div)} ({div / total:.0%} of the charges)" if total else None)
    return fig


def plot_csm(table: pd.DataFrame, *, title: Optional[str] = None, figsize: Tuple[float, float] = (9, 3.4)):
    """IFRS 17 CSM roll-forward: the closing balance by year (line) beside the yearly release (columns), same x-axis."""
    t = pd.DataFrame(table)
    fig, axes = _figure(figsize[0], figsize[1], rows=1, cols=2, sharex=True)
    ax = axes[0]
    yrs = np.concatenate([[t["year"].iloc[0] - 1], t["year"].to_numpy()])
    bal = np.concatenate([[t["csm_open"].iloc[0]], t["csm_close"].to_numpy()])
    ax.plot(yrs, bal, color=SERIES[0], linewidth=2)
    ax.fill_between(yrs, 0, bal, color=SERIES[0], alpha=0.10, linewidth=0)
    ax.plot([yrs[0]], [bal[0]], "o", color=SERIES[0], markersize=7, markeredgecolor=PALETTE["surface"], markeredgewidth=1.5)
    ax.text(yrs[0], bal[0], f"  CSM₀ {_fmt(bal[0])}", fontsize=8, color=PALETTE["ink_2"], va="center")
    _thousands(ax, "y")
    ax.set_ylim(bottom=0)
    ax.set_xlabel("year", fontsize=8.5)
    _title(ax, "CSM balance (closing)")
    ax = axes[1]
    slot_px = figsize[0] / 2 * 0.82 * 110 / max(len(t), 1)
    ax.bar(t["year"], t["release"], color=SERIES[0], width=min(0.7, 32 / slot_px), edgecolor=PALETTE["surface"], linewidth=1.2)
    _thousands(ax, "y")
    ax.set_xlabel("year", fontsize=8.5)
    _title(ax, "Release to P&L (coverage units)")
    fig.suptitle(title or getattr(table, "title", None) or "IFRS 17 CSM", x=0.01, ha="left", fontsize=11, fontweight="bold", color=PALETTE["ink"])
    return fig


# ── generic lines, triangles, tables ──────────────────────────────────────

def plot_lines(df: pd.DataFrame, x: str, ys: Sequence[str], *, title: Optional[str] = None, subtitle: Optional[str] = None, labels: bool = True,
               figsize: Tuple[float, float] = (8, 4)):
    """Up to five series over x as 2 px lines in the fixed categorical order, end-labelled, with a legend."""
    if len(ys) > 5:
        raise ValueError("plot_lines takes at most five series; fold the rest or use small multiples")
    fig, ax = _figure(*figsize)
    for i, col in enumerate(ys):
        ax.plot(df[x], df[col], color=SERIES[i], linewidth=2, label=str(col), solid_capstyle="round")
        if labels:
            ax.text(df[x].iloc[-1], df[col].iloc[-1], " " + str(col), fontsize=8, color=PALETTE["ink_2"], va="center")
    _thousands(ax, "y")
    ax.margins(x=0.12)
    if len(ys) > 1:
        _legend(ax)
    _title(ax, title, subtitle)
    return fig


def plot_triangle(tri: pd.DataFrame, *, title: Optional[str] = None, figsize: Tuple[float, float] = (8, 4)):
    """Development curves of a cumulative triangle, one line per origin in the one-hue ordinal ramp (oldest light, latest dark), first and last labelled."""
    arr = pd.DataFrame(tri)
    n = len(arr)
    ramp = SEQUENTIAL
    fig, ax = _figure(*figsize)
    for i, (origin, row) in enumerate(arr.iterrows()):
        vals = row.to_numpy(dtype=float)
        ok = np.isfinite(vals)
        color = ramp[min(len(ramp) - 1, int(i * len(ramp) / max(n, 1)))]
        ax.plot(np.asarray(arr.columns, dtype=float)[ok], vals[ok], color=color, linewidth=1.6, solid_capstyle="round")
        if i in (0, n - 1):
            ax.text(np.asarray(arr.columns, dtype=float)[ok][-1], vals[ok][-1], f" {origin}", fontsize=8, color=PALETTE["ink_2"], va="center")
    _thousands(ax, "y")
    ax.set_xlabel("development period", fontsize=8.5)
    ax.margins(x=0.1)
    _title(ax, title or getattr(tri, "title", None) or "Development", f"{n} origins, oldest light → latest dark")
    return fig


def plot_table(df: pd.DataFrame, *, title: Optional[str] = None, fmt: int = 0, figsize: Optional[Tuple[float, float]] = None):
    """A small table as a figure (for packs that need a picture): ink text, hairline rules."""
    d = pd.DataFrame(df)
    rows, cols = d.shape
    fig, ax = _figure(*(figsize or (max(4, 1.3 * cols), 0.32 * rows + 1)))
    ax.axis("off")
    cells = [[_fmt(v, fmt) if isinstance(v, (int, float, np.integer, np.floating)) else str(v) for v in r] for r in d.to_numpy()]
    tbl = ax.table(cellText=cells, colLabels=[str(c) for c in d.columns], rowLabels=[str(i) for i in d.index], loc="center", cellLoc="right")
    tbl.auto_set_font_size(False)
    tbl.set_fontsize(8.5)
    for (r, c), cell in tbl.get_celld().items():
        cell.set_edgecolor(PALETTE["grid"])
        cell.set_linewidth(0.6)
        cell.get_text().set_color(PALETTE["ink"] if r == 0 or c == -1 else PALETTE["ink_2"])
    _title(ax, title)
    return fig


def save_figure(fig, path: Union[str, "os.PathLike[str]"], dpi: int = 160) -> str:  # noqa: F821
    """Write a figure to PNG / SVG / PDF by extension; returns the path (``sc.save`` is the data writer)."""
    fig.savefig(str(path), dpi=dpi, facecolor=PALETTE["surface"], bbox_inches="tight")
    return str(path)
