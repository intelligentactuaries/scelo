"""WMTR: the W(M, T, R) survival forecast, ported from the Scelo swarm engine.

W = M^αM · T^αT · R^αR (material × time × relational capital) evolves year by
year under Poisson shocks; a Cox-style hazard h = h₀·(W/W₀)^−β accumulates
survival; each Monte Carlo path is classified grew / stabilized / declined /
collapsed. This is a line-for-line port of apps/swarm/src/shared/wmtr.ts
(itself ported from intelligentactuaries/nanoeconomics-simulation), down to
the Mulberry32 random stream, so ``wmtr(..., seed=42)`` here gives the
numbers the IDE's forecast card and the swarm's evidence block give.

``wmtr("rural village under a severe drought")`` derives the configuration
from the scenario text the way the IDE's forecast family does (word-bounded
cue matching, FNV-1a seed), then runs it. ``wmtr(df)`` reads a scenario row
(the ``wmtr-scenarios`` sample). Pass any parameter by name to override.
"""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass, field, replace
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, Union

import numpy as np
import pandas as pd

from ._audit import tool
from ._table import Table

__all__ = [
    "WmtrParams", "DEFAULT_WMTR_PARAMS", "wmtr", "run_wmtr", "derive_config", "apply_intervention", "driver_contributions",
    "dominant_driver", "classify", "sensitivity", "mulberry32", "WmtrResult", "SHOCK_PARAMS", "INTERVENTION_PARAMS",
]

# ── RNG (Mulberry32, bit-exact with the TypeScript) ───────────────────────

_M32 = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    return (a * b) & _M32


def mulberry32(seed: int) -> Callable[[], float]:
    """The swarm's seedable RNG: the same seed gives the same stream as the IDE."""
    s = int(seed) & _M32

    def rand() -> float:
        nonlocal s
        s = (s + 0x6D2B79F5) & _M32
        t = s
        t = _imul(t ^ (t >> 15), t | 1)
        t ^= (t + _imul(t ^ (t >> 7), t | 61)) & _M32
        t &= _M32
        return ((t ^ (t >> 14)) & _M32) / 4294967296

    return rand


def _gauss(rand: Callable[[], float], mu: float = 0.0, sigma: float = 1.0) -> float:
    u1 = max(rand(), 1e-12)
    u2 = rand()
    return mu + sigma * math.sqrt(-2 * math.log(u1)) * math.cos(2 * math.pi * u2)


def _poisson(rand: Callable[[], float], lam: float) -> int:
    L = math.exp(-lam)
    k = 0
    p = 1.0
    while True:
        k += 1
        p *= rand()
        if p <= L:
            break
    return k - 1


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


# ── wealth, spatial, relational ─────────────────────────────────────────

def _compute_w(M: float, T: float, R: float, aM: float, aT: float, aR: float) -> float:
    return max(M, 1e-9) ** aM * max(T, 1e-9) ** aT * max(R, 1e-9) ** aR


_SPATIAL_PEAK, _SPATIAL_K, _SPATIAL_LOW, _SPATIAL_HIGH = 250.0, 0.015 * 3, 100.0, 400.0


def _spatial_r(sqft: float) -> float:
    if sqft < 0:
        return 0.0
    left = 1 / (1 + math.exp(-_SPATIAL_K * (sqft - _SPATIAL_LOW)))
    right = 1 - 1 / (1 + math.exp(-_SPATIAL_K * (sqft - _SPATIAL_HIGH)))
    raw = left * right
    pk_left = 1 / (1 + math.exp(-_SPATIAL_K * (_SPATIAL_PEAK - _SPATIAL_LOW)))
    pk_right = 1 - 1 / (1 + math.exp(-_SPATIAL_K * (_SPATIAL_PEAK - _SPATIAL_HIGH)))
    peak = pk_left * pk_right
    return 0.0 if peak <= 0 else _clamp(raw / peak, 0, 1)


def _compute_r(family: float, religion: float, sqft: float, wF: float, wRel: float, wS: float) -> float:
    total = wF + wRel + wS
    t = total if total > 0 else 1.0
    return (wF / t) * family + (wRel / t) * religion + (wS / t) * _spatial_r(sqft)


# ── shocks ────────────────────────────────────────────────────────────────

SHOCK_PARAMS: Dict[str, Dict[str, float]] = {
    "mild": {"lam": 0.10, "mu": 0.08, "sd": 0.04, "pLocal": 0.35, "pRegional": 0.10, "pGlobal": 0.02, "pIdio": 0.53},
    "moderate": {"lam": 0.25, "mu": 0.15, "sd": 0.08, "pLocal": 0.35, "pRegional": 0.20, "pGlobal": 0.05, "pIdio": 0.40},
    "severe": {"lam": 0.45, "mu": 0.25, "sd": 0.12, "pLocal": 0.30, "pRegional": 0.30, "pGlobal": 0.15, "pIdio": 0.25},
}
_TARGET_WEIGHTS = [("material", 0.35), ("time", 0.2), ("family", 0.15), ("religion", 0.1), ("meaning_crisis", 0.1), ("combined", 0.1)]


def _pick_target(rand: Callable[[], float]) -> str:
    r = rand()
    for target, w in _TARGET_WEIGHTS:
        r -= w
        if r <= 0:
            return target
    return "material"


def _single_shocks(rand: Callable[[], float], env: str) -> List[Tuple[str, float]]:
    p = SHOCK_PARAMS[env]
    n = _poisson(rand, p["lam"])
    out = []
    for _ in range(n):
        sev = _clamp(_gauss(rand, p["mu"], p["sd"]), 0.01, 0.9)
        out.append((_pick_target(rand), sev))
    return out


# ── parameters ────────────────────────────────────────────────────────────

@dataclass
class WmtrParams:
    """Single-community forecast parameters (DEFAULT_WMTR_SINGLE_PARAMS in the engine)."""

    population: float = 500
    sqftPerResident: float = 300
    alphaM: float = 0.4
    alphaT: float = 0.3
    alphaR: float = 0.3
    wF: float = 0.4
    wRel: float = 0.3
    wS: float = 0.3
    pProduction: float = 0.4
    pFamily: float = 0.25
    pReligion: float = 0.15
    pSpatial: float = 0.1
    pLeisure: float = 0.1
    initFamily: float = 0.7
    initReligion: float = 0.6
    shock: str = "moderate"
    collapse: float = 0.3
    recovery: int = 5
    growth: float = 0.2
    stability: float = 0.1
    horizon: int = 30
    nPaths: int = 200
    seed: int = 42


DEFAULT_WMTR_PARAMS = WmtrParams()
INTERVENTION_PARAMS = ["alphaM", "alphaT", "alphaR", "wF", "wRel", "wS", "pProduction", "pFamily", "pReligion", "pSpatial", "pLeisure", "initFamily", "initReligion", "shock"]

_H0, _BETA_W = 0.02, 2.0


def classify(w_hist: Sequence[float], w0: float, collapse: float = 0.3, recovery: int = 5, growth: float = 0.2, stability: float = 0.1) -> str:
    """Outcome of a wealth path: collapsed (below collapse·W₀ for `recovery` consecutive years), grew, declined or stabilized."""
    run = 0
    for w in w_hist:
        if w < collapse * w0:
            run += 1
            if run >= recovery:
                return "collapsed"
        else:
            run = 0
    wT = w_hist[-1]
    if wT > w0 * (1 + growth):
        return "grew"
    if wT < w0 * (1 - stability):
        return "declined"
    return "stabilized"


def _normalize_five(p: Sequence[float]) -> List[float]:
    total = sum(p)
    return [x / total for x in p] if total > 0 else [0.2] * 5


def _run_one_path(p: WmtrParams, rand: Callable[[], float]) -> Dict[str, Any]:
    dt = 1.0
    pProd, pFam, pRel, pSp, pLeis = _normalize_five([p.pProduction, p.pFamily, p.pReligion, p.pSpatial, p.pLeisure])
    a_sum = (p.alphaM + p.alphaT + p.alphaR) or 1
    aM, aT, aR = p.alphaM / a_sum, p.alphaT / a_sum, p.alphaR / a_sum
    M = 1.0
    family = _clamp(p.initFamily, 0, 1)
    religion = _clamp(p.initReligion, 0, 1)
    sqft = p.sqftPerResident
    Teff0 = pProd + 0.3 * pLeis
    R0 = _compute_r(family, religion, sqft, p.wF, p.wRel, p.wS)
    W0 = _compute_w(M, Teff0, R0, aM, aT, aR)
    w_hist, m_hist, t_hist, r_hist, surv = [W0], [M], [Teff0], [R0], [1.0]
    cum_haz = 0.0
    cooldown = 0.0
    for _ in range(1, p.horizon + 1):
        m_growth = 0.04 * pProd * M * dt
        m_drain = 0.01 * M * dt
        M = max(M + m_growth - m_drain, 1e-6)
        mc_severity = 0.0
        if cooldown <= 0:
            shocks = _single_shocks(rand, p.shock)
            for target, sev in shocks:
                if target in ("material", "combined"):
                    M = max(M * (1 - sev), 1e-6)
                if target in ("time", "combined"):
                    red = pProd * sev * 0.5
                    pProd = max(pProd - red, 0.01)
                    pSp = pSp + red * 0.5
                if target == "family":
                    family = max(family * (1 - sev), 0)
                if target == "religion":
                    religion = max(religion * (1 - sev), 0)
                if target == "meaning_crisis":
                    mc_severity = max(mc_severity, sev)
            if shocks:
                cooldown = 0.5
        else:
            cooldown -= dt
        if pFam >= 0.1:
            family = _clamp(family + 0.1 * pFam * dt, 0, 1)
        else:
            family = _clamp(family - 0.05 * dt, 0, 1)
        eff_rel = pRel * (1.0 + religion * 0.2)
        if pRel >= 0.05:
            religion = _clamp(religion + 0.08 * eff_rel * dt, 0, 1)
        else:
            religion = _clamp(religion - 0.03 * dt, 0, 1)
        if mc_severity > 0:
            religion = _clamp(religion - mc_severity * religion * 0.1 * dt, 0, 1)
        Teff = pProd + 0.3 * pLeis
        R = _compute_r(family, religion, sqft, p.wF, p.wRel, p.wS)
        W = _compute_w(M, Teff, R, aM, aT, aR)
        h = _H0 * math.exp(-_BETA_W * math.log(max(W / W0, 1e-6)))
        cum_haz += h * dt
        surv.append(math.exp(-cum_haz))
        w_hist.append(W)
        m_hist.append(M)
        t_hist.append(Teff)
        r_hist.append(R)
    return {"w": w_hist, "m": m_hist, "t": t_hist, "r": r_hist, "surv": surv,
            "outcome": classify(w_hist, W0, p.collapse, p.recovery, p.growth, p.stability)}


def _percentile(sorted_col: np.ndarray, pct: float) -> float:
    idx = int(_clamp(math.floor((pct / 100) * (sorted_col.size - 1)), 0, sorted_col.size - 1))
    return float(sorted_col[idx])


@dataclass
class WmtrResult:
    params: WmtrParams
    paths: List[Dict[str, Any]]
    table: Table
    outcome_fractions: Dict[str, float]
    dominant: str
    w0: float
    drivers: Dict[str, float] = field(default_factory=dict)

    @property
    def survival(self) -> float:
        return float(self.table["survival"].iloc[-1])

    def __repr__(self) -> str:  # pragma: no cover
        return (f"WMTR · {self.params.shock} · {self.params.horizon}y · {self.params.nPaths} paths · survival@horizon {self.survival:.3f} · "
                f"W/W₀ {self.table['mean_W'].iloc[-1] / self.w0:.2f} · dominant {self.dominant} · driver {dominant_driver(self)}\n" + repr(self.table))


def run_wmtr(params: WmtrParams) -> WmtrResult:
    """Run the Monte Carlo for explicit parameters (see :func:`wmtr` for the convenient form)."""
    rand = mulberry32(params.seed)
    paths = [_run_one_path(params, rand) for _ in range(params.nPaths)]
    T = params.horizon + 1

    def agg(key: str, how: Union[str, float]) -> np.ndarray:
        out = np.empty(T)
        for i in range(T):
            col = np.sort(np.array([pth[key][i] for pth in paths]))
            out[i] = col.mean() if how == "mean" else _percentile(col, float(how))
        return out

    counts = {"grew": 0, "stabilized": 0, "declined": 0, "collapsed": 0}
    for pth in paths:
        counts[pth["outcome"]] += 1
    total = len(paths) or 1
    fracs = {k: v / total for k, v in counts.items()}
    dominant, best = "stabilized", -1.0
    for k in ("grew", "stabilized", "declined", "collapsed"):
        if fracs[k] > best:
            best, dominant = fracs[k], k
    w0 = paths[0]["w"][0] if paths else 1.0
    table = pd.DataFrame({"year": np.arange(T), "mean_W": agg("w", "mean"), "p10_W": agg("w", 10), "p25_W": agg("w", 25), "p75_W": agg("w", 75),
                          "p90_W": agg("w", 90), "survival": agg("surv", "mean"), "mean_M": agg("m", "mean"), "mean_T": agg("t", "mean"), "mean_R": agg("r", "mean")})
    res = WmtrResult(params, paths, Table(table, stage="hard"), fracs, dominant, w0)
    res.drivers = driver_contributions(res)
    t = res.table
    object.__setattr__(t, "title", f"WMTR forecast · {params.shock} shocks · {params.horizon}y · {params.nPaths} paths · seed {params.seed}")
    object.__setattr__(t, "basis", f"α = ({params.alphaM:g}, {params.alphaT:g}, {params.alphaR:g}) · w = ({params.wF:g}, {params.wRel:g}, {params.wS:g}) · shock {params.shock}")
    d = res.drivers
    t.notes.extend([
        f"Outcomes: grew {fracs['grew']:.0%} · stabilized {fracs['stabilized']:.0%} · declined {fracs['declined']:.0%} · collapsed {fracs['collapsed']:.0%} (dominant: {dominant}). Mean survival at horizon {res.survival:.3f}; W/W₀ {table['mean_W'].iloc[-1] / w0:.2f}.",
        f"Drivers (Σ = mean Δln W = {d['net']:+.4f}): M {d['M']:+.4f} · T {d['T']:+.4f} · R {d['R']:+.4f}; dominant {dominant_driver(res)}. Exact Cobb-Douglas decomposition, accumulated per path then averaged.",
        "W = M^αM·T^αT·R^αR; hazard h = 0.02·(W/W₀)^−2; shocks ~ Poisson(λ) with Normal severities clipped to (0.01, 0.9). Same Mulberry32 stream as Scelo IDE / the swarm for this seed.",
    ])
    t.attrs.update(outcome_fractions=fracs, dominant=dominant, drivers=d, w0=w0)
    return res


def driver_contributions(r: WmtrResult, up_to: Optional[int] = None) -> Dict[str, float]:
    """Exact decomposition ln W_T − ln W_0 = αM·Δln M + αT·Δln T + αR·Δln R, averaged over paths."""
    p = r.params
    a_sum = (p.alphaM + p.alphaT + p.alphaR) or 1
    aM, aT, aR = p.alphaM / a_sum, p.alphaT / a_sum, p.alphaR / a_sum
    last = int(_clamp(math.floor(up_to if up_to is not None else p.horizon), 0, p.horizon))
    ln = lambda x: math.log(max(x, 1e-9))  # noqa: E731
    M = T = R = net = 0.0
    for pth in r.paths:
        M += aM * (ln(pth["m"][last]) - ln(pth["m"][0]))
        T += aT * (ln(pth["t"][last]) - ln(pth["t"][0]))
        R += aR * (ln(pth["r"][last]) - ln(pth["r"][0]))
        net += ln(pth["w"][last]) - ln(pth["w"][0])
    n = len(r.paths) or 1
    return {"M": M / n, "T": T / n, "R": R / n, "net": net / n}


def dominant_driver(r: WmtrResult) -> str:
    c = driver_contributions(r)
    return max(("M", "T", "R"), key=lambda k: abs(c[k]))


# ── scenario → config (apps/web forecast/derive.ts) ──────────────────────

_CUE_CACHE: Dict[str, re.Pattern] = {}


def _cue(cue: str) -> re.Pattern:
    pat = _CUE_CACHE.get(cue)
    if pat is None:
        stem = cue.endswith("*")
        body = re.escape(cue[:-1] if stem else cue)
        pat = re.compile(rf"\b{body}" if stem else rf"\b{body}s?\b", re.I)
        _CUE_CACHE[cue] = pat
    return pat


def _kw(text: str, cues: Sequence[str]) -> bool:
    t = text.replace("_", " ")
    return any(_cue(c).search(t) for c in cues)


def _fnv1a(s: str) -> int:
    """The IDE's scenario hash: FNV-1a as JavaScript evaluates it, i.e. with the multiply in double precision."""
    h = 2166136261
    for ch in s:
        x = h ^ ord(ch)
        if x >= 2**31:  # `^` yields a signed int32 in JS
            x -= 2**32
        prod = float(x * 16777619)  # rounds to the nearest double, as V8 does
        h = int(prod) & _M32  # ToUint32
    return h


def derive_config(scenario: str, **overrides: Any) -> WmtrParams:
    """The IDE's forecast-family heuristic: shock severity, domain α presets, horizon and a scenario-specific seed from the text."""
    base = WmtrParams()
    if _kw(scenario, ["catastroph*", "war", "warfare", "pandemic", "famine", "collapse*", "severe", "crisis", "crises", "depression", "shock", "downgrade", "cliff"]):
        base.shock = "severe"
    elif _kw(scenario, ["mild", "calm", "stable", "benign", "orderly", "normal"]):
        base.shock = "mild"
    else:
        base.shock = "moderate"
    if _kw(scenario, ["pension", "scheme", "sponsor", "covenant", "db plan", "annuity book"]):
        base.alphaM, base.alphaT, base.alphaR = 0.35, 0.25, 0.40
    elif _kw(scenario, ["life book", "life insurance", "term life", "ifrs 17", "csm", "solvency ii"]):
        base.alphaM, base.alphaT, base.alphaR = 0.50, 0.20, 0.30
    elif _kw(scenario, ["reserv*", "ibnr", "triangle", "chain ladder", "bornhuetter"]):
        base.alphaM, base.alphaT, base.alphaR = 0.55, 0.30, 0.15
    elif _kw(scenario, ["rural", "village", "subsistence", "agrarian", "farming"]):
        base.alphaM, base.alphaT, base.alphaR = 0.30, 0.30, 0.40
        base.wF, base.wRel, base.wS = 0.50, 0.30, 0.20
        base.sqftPerResident = 800
    elif _kw(scenario, ["urban", "city", "cities", "metropol*", "downtown"]):
        base.alphaM, base.alphaT, base.alphaR = 0.50, 0.30, 0.20
        base.sqftPerResident = 220
    if _kw(scenario, ["century", "long-term", "multi-generational"]):
        base.horizon = 60
    elif _kw(scenario, ["next year", "short term", "immediate"]):
        base.horizon = 10
    base.seed = _fnv1a(scenario) % 9999
    base.nPaths = 200
    return replace(base, **_norm_overrides(overrides))


_ROW_ALIASES = {
    "alphaM": ["alpha_m", "alpham"], "alphaT": ["alpha_t", "alphat"], "alphaR": ["alpha_r", "alphar"],
    "wF": ["w_f", "wf"], "wRel": ["w_rel", "wrel"], "wS": ["w_s", "ws"],
    "pProduction": ["p_production", "pproduction"], "pFamily": ["p_family", "pfamily"], "pReligion": ["p_religion", "preligion"],
    "pSpatial": ["p_spatial", "pspatial"], "pLeisure": ["p_leisure", "pleisure"],
    "initFamily": ["init_family", "initfamily", "family_0"], "initReligion": ["init_religion", "initreligion", "religion_0"],
    "population": ["population", "pop", "n"], "sqftPerResident": ["sqft_per_resident", "sqft_resident"],
    "horizon": ["horizon", "horizon_years", "years"], "nPaths": ["n_paths", "paths", "monte_carlo_paths"],
    "shock": ["shock", "shock_severity", "severity"], "seed": ["seed"],
}


def _norm_overrides(kw: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    fields = {f.lower(): f for f in WmtrParams.__dataclass_fields__}
    alias = {a: k for k, al in _ROW_ALIASES.items() for a in al}
    for k, v in kw.items():
        key = fields.get(k.lower()) or alias.get(k.lower()) or fields.get(k.lower().replace("_", ""))
        if key is None:
            raise KeyError(f"unknown WMTR parameter {k!r}")
        out[key] = v if key != "shock" else str(v).lower()
    return out


def _config_from_row(row: pd.Series) -> Dict[str, Any]:
    cols = {str(c).lower(): c for c in row.index}
    out: Dict[str, Any] = {}
    for key, aliases in _ROW_ALIASES.items():
        for a in aliases:
            if a in cols and pd.notna(row[cols[a]]):
                v = row[cols[a]]
                out[key] = str(v).lower() if key == "shock" else (int(v) if key in ("horizon", "nPaths", "seed") else float(v))
                break
    if "shock" in out and out["shock"] not in SHOCK_PARAMS:
        out.pop("shock")
    return out


@tool
def wmtr(scenario: Union[str, pd.DataFrame, pd.Series, WmtrParams, None] = None, **overrides: Any) -> WmtrResult:
    """Forecast an entity's survival: ``wmtr("pension scheme, sponsor covenant weakening")``, ``wmtr(df)`` (scenario row), ``wmtr(shock="severe", horizon=50)``.

    Returns a result whose table is the year-by-year mean / p10 / p25 / p75 /
    p90 wealth, survival and the M, T, R means; outcome fractions, the
    dominant outcome and the driver decomposition sit in the notes and
    ``attrs``. Parameters may be given by engine name (``alphaM``) or column
    name (``alpha_m``).
    """
    if isinstance(scenario, WmtrParams):
        params = replace(scenario, **_norm_overrides(overrides))
    elif isinstance(scenario, str):
        params = derive_config(scenario, **overrides)
    elif isinstance(scenario, (pd.DataFrame, pd.Series)):
        row = scenario.iloc[0] if isinstance(scenario, pd.DataFrame) else scenario
        cfg = _config_from_row(row)
        cfg.update(_norm_overrides(overrides))
        params = replace(WmtrParams(), **cfg)
    else:
        params = replace(WmtrParams(), **_norm_overrides(overrides))
    return run_wmtr(params)


def apply_intervention(params: WmtrParams, param: str, direction: str = "increase", magnitude: str = "small") -> WmtrParams:
    """A council intervention: shift one parameter by 0.07 (small) or 0.20 (large), or step the shock environment."""
    if param not in INTERVENTION_PARAMS:
        raise KeyError(f"param must be one of {', '.join(INTERVENTION_PARAMS)}")
    nxt = replace(params)
    if param == "shock":
        order = ["mild", "moderate", "severe"]
        idx = order.index(params.shock)
        nxt.shock = order[max(0, min(2, idx + (1 if direction == "increase" else -1)))]
        return nxt
    step = 0.07 if magnitude == "small" else 0.20
    sign = 1 if direction == "increase" else -1
    setattr(nxt, param, max(0.0, min(1.0, getattr(params, param) + sign * step)))
    return nxt


@tool
def sensitivity(scenario: Union[str, WmtrParams, None] = None, **overrides: Any) -> Table:
    """Shock sensitivity: the same forecast under mild / moderate / severe shocks, outcome mix and survival side by side."""
    base = scenario if isinstance(scenario, WmtrParams) else (derive_config(scenario, **overrides) if isinstance(scenario, str) else replace(WmtrParams(), **_norm_overrides(overrides)))
    rows = []
    for env in ("mild", "moderate", "severe"):
        r = run_wmtr(replace(base, shock=env))
        rows.append({"shock": env, "grew": r.outcome_fractions["grew"], "stabilized": r.outcome_fractions["stabilized"], "declined": r.outcome_fractions["declined"],
                     "collapsed": r.outcome_fractions["collapsed"], "survival": r.survival, "W/W0": r.table["mean_W"].iloc[-1] / r.w0})
    out = pd.DataFrame(rows)
    delta = out.loc[2, "collapsed"] - out.loc[0, "collapsed"]
    return Table(out, title="WMTR shock sensitivity", basis=f"horizon {base.horizon}y · {base.nPaths} paths · seed {base.seed}", stage="hard",
                 notes=[f"Collapse-Δ (severe − mild) = {delta:+.1%}: the share of paths that collapse depends on the shock environment by this much."])
