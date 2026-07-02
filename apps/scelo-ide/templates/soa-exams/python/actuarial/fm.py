"""Financial Mathematics (SOA Exam FM) solver toolkit.

Pure-stdlib, deterministic, and unit-tested against the official SOA Exam FM
sample answer key. This is the *hard-data* layer for exam work: where an LLM's
mental arithmetic slips, route the computation through these functions and the
answer ties out to the examiner's.

Conventions
-----------
* ``i``  annual effective interest rate (e.g. 0.05 for 5%).
* ``v = 1 / (1 + i)`` is the annual discount factor.
* Annuity values are per 1 unit of payment unless a payment amount is given.
* "immediate" = payments at period *end*; "due" = payments at period *start*.

Everything here is closed-form or solved with a bracketed root finder, so the
results are reproducible to full float precision.
"""

from __future__ import annotations

import math
from typing import Callable, Sequence

__all__ = [
    "v_factor",
    "d_from_i",
    "i_from_d",
    "delta_from_i",
    "i_from_delta",
    "i_from_nominal",
    "nominal_from_i",
    "accumulate",
    "annuity_immediate_pv",
    "annuity_due_pv",
    "annuity_immediate_fv",
    "annuity_due_fv",
    "perpetuity_immediate_pv",
    "perpetuity_due_pv",
    "deferred_annuity_pv",
    "increasing_annuity_immediate_pv",
    "decreasing_annuity_immediate_pv",
    "increasing_perpetuity_immediate_pv",
    "geometric_annuity_immediate_pv",
    "continuous_annuity_pv",
    "level_payment",
    "outstanding_balance",
    "interest_paid",
    "principal_repaid",
    "sinking_fund_payment",
    "bond_price",
    "npv",
    "irr",
    "solve_rate",
    "macaulay_duration",
    "modified_duration",
    "convexity",
    "macaulay_first_order_price_change",
    "modified_first_order_price_change",
]

# ── root finding ──────────────────────────────────────────────────────────


def _bisect(f: Callable[[float], float], lo: float, hi: float, tol: float = 1e-12,
            maxit: int = 200) -> float:
    """Bracketed bisection. Requires a sign change on [lo, hi]."""
    flo, fhi = f(lo), f(hi)
    if flo == 0:
        return lo
    if fhi == 0:
        return hi
    if flo * fhi > 0:
        raise ValueError(f"no sign change on [{lo}, {hi}]: f(lo)={flo}, f(hi)={fhi}")
    for _ in range(maxit):
        mid = 0.5 * (lo + hi)
        fmid = f(mid)
        if abs(fmid) < tol or (hi - lo) < tol:
            return mid
        if flo * fmid < 0:
            hi, fhi = mid, fmid
        else:
            lo, flo = mid, fmid
    return 0.5 * (lo + hi)


def solve_rate(f: Callable[[float], float], lo: float = -0.9999, hi: float = 10.0,
               tol: float = 1e-12) -> float:
    """Solve ``f(i) = 0`` for an interest rate on a sensible default bracket."""
    return _bisect(f, lo, hi, tol=tol)


# ── interest-rate conversions ─────────────────────────────────────────────


def v_factor(i: float) -> float:
    """Annual discount factor ``v = 1/(1+i)``."""
    return 1.0 / (1.0 + i)


def d_from_i(i: float) -> float:
    """Annual effective discount rate ``d = i/(1+i) = 1 - v``."""
    return i / (1.0 + i)


def i_from_d(d: float) -> float:
    """Effective interest from effective discount: ``i = d/(1-d)``."""
    return d / (1.0 - d)


def delta_from_i(i: float) -> float:
    """Force of interest ``delta = ln(1+i)``."""
    return math.log1p(i)


def i_from_delta(delta: float) -> float:
    """Effective interest from a constant force ``i = e^delta - 1``."""
    return math.expm1(delta)


def i_from_nominal(nominal: float, m: float) -> float:
    """Effective annual ``i`` from a nominal rate ``i^(m)`` convertible m-thly."""
    return (1.0 + nominal / m) ** m - 1.0


def nominal_from_i(i: float, m: float) -> float:
    """Nominal rate ``i^(m)`` convertible m-thly, equivalent to effective ``i``."""
    return m * ((1.0 + i) ** (1.0 / m) - 1.0)


def accumulate(principal: float, i: float, t: float) -> float:
    """Accumulated value of ``principal`` after time ``t`` at effective ``i``."""
    return principal * (1.0 + i) ** t


# ── level annuities ───────────────────────────────────────────────────────


def annuity_immediate_pv(n: float, i: float) -> float:
    r"""PV of an n-period annuity-immediate of 1, ``a_{n|} = (1 - v^n)/i``."""
    if i == 0:
        return float(n)
    return (1.0 - v_factor(i) ** n) / i


def annuity_due_pv(n: float, i: float) -> float:
    r"""PV of an n-period annuity-due of 1, ``adue_{n|} = a_{n|} * (1+i)``."""
    return annuity_immediate_pv(n, i) * (1.0 + i)


def annuity_immediate_fv(n: float, i: float) -> float:
    r"""FV of an n-period annuity-immediate of 1, ``s_{n|} = ((1+i)^n - 1)/i``."""
    if i == 0:
        return float(n)
    return ((1.0 + i) ** n - 1.0) / i


def annuity_due_fv(n: float, i: float) -> float:
    r"""FV of an n-period annuity-due of 1, ``sdue_{n|} = s_{n|} * (1+i)``."""
    return annuity_immediate_fv(n, i) * (1.0 + i)


def perpetuity_immediate_pv(i: float) -> float:
    """PV of a perpetuity-immediate of 1, ``1/i``."""
    return 1.0 / i


def perpetuity_due_pv(i: float) -> float:
    """PV of a perpetuity-due of 1, ``1/d``."""
    return 1.0 / d_from_i(i)


def deferred_annuity_pv(n: float, i: float, defer: float, due: bool = False) -> float:
    """PV of an n-period annuity deferred ``defer`` periods (immediate or due)."""
    base = annuity_due_pv(n, i) if due else annuity_immediate_pv(n, i)
    return base * v_factor(i) ** defer


# ── varying annuities ─────────────────────────────────────────────────────


def increasing_annuity_immediate_pv(n: int, i: float) -> float:
    r"""PV of an increasing annuity-immediate 1, 2, ..., n: ``(Ia)_{n|}``.

    ``(Ia)_{n|} = (adue_{n|} - n v^n) / i``.
    """
    if i == 0:
        return n * (n + 1) / 2.0
    return (annuity_due_pv(n, i) - n * v_factor(i) ** n) / i


def decreasing_annuity_immediate_pv(n: int, i: float) -> float:
    r"""PV of a decreasing annuity-immediate n, n-1, ..., 1: ``(Da)_{n|}``.

    ``(Da)_{n|} = (n - a_{n|}) / i``.
    """
    if i == 0:
        return n * (n + 1) / 2.0
    return (n - annuity_immediate_pv(n, i)) / i


def increasing_perpetuity_immediate_pv(i: float) -> float:
    r"""PV of an increasing perpetuity-immediate 1, 2, 3, ...: ``(1+i)/i^2``."""
    return (1.0 + i) / (i * i)


def geometric_annuity_immediate_pv(n: int, i: float, g: float,
                                   first: float = 1.0) -> float:
    """PV of an annuity-immediate whose payments grow geometrically at rate ``g``.

    Payment k (k = 1..n) is ``first * (1+g)^(k-1)``, discounted at ``i``.
    """
    if abs(i - g) < 1e-15:
        return first * n / (1.0 + i)
    ratio = (1.0 + g) / (1.0 + i)
    return first / (1.0 + i) * (1.0 - ratio ** n) / (1.0 - ratio)


def continuous_annuity_pv(n: float, delta: float) -> float:
    r"""PV of a continuous annuity of 1/yr for n years at force ``delta``.

    ``abar_{n|} = (1 - e^{-delta n}) / delta``.
    """
    if delta == 0:
        return float(n)
    return (1.0 - math.exp(-delta * n)) / delta


# ── loans / amortization ──────────────────────────────────────────────────


def level_payment(loan: float, n: int, i: float, due: bool = False) -> float:
    """Level payment that amortizes ``loan`` over ``n`` periods at rate ``i``."""
    ann = annuity_due_pv(n, i) if due else annuity_immediate_pv(n, i)
    return loan / ann


def outstanding_balance(loan: float, n: int, i: float, k: int) -> float:
    """Outstanding balance right after the k-th level payment (prospective)."""
    pmt = level_payment(loan, n, i)
    return pmt * annuity_immediate_pv(n - k, i)


def interest_paid(loan: float, n: int, i: float, k: int) -> float:
    """Interest portion of the k-th level payment (k = 1..n)."""
    prev = loan if k == 1 else outstanding_balance(loan, n, i, k - 1)
    return prev * i


def principal_repaid(loan: float, n: int, i: float, k: int) -> float:
    """Principal portion of the k-th level payment (k = 1..n)."""
    pmt = level_payment(loan, n, i)
    return pmt - interest_paid(loan, n, i, k)


def sinking_fund_payment(loan: float, n: int, i_loan: float, j_fund: float) -> float:
    """Total annual outlay under a sinking-fund loan repayment.

    Interest ``loan * i_loan`` is paid to the lender each period, and a deposit
    accumulating at ``j_fund`` to ``loan`` at time n is made into the fund.
    """
    deposit = loan / annuity_immediate_fv(n, j_fund)
    return loan * i_loan + deposit


# ── bonds ─────────────────────────────────────────────────────────────────


def bond_price(face: float, coupon_rate: float, n: int, yield_rate: float,
               redemption: float | None = None, freq: int = 1) -> float:
    """Price of a bond by the basic formula ``P = Fr a_{n|} + C v^n``.

    ``coupon_rate`` and ``yield_rate`` are the *annual* rates; ``freq`` coupons
    per year. ``n`` is the number of coupon periods. ``redemption`` defaults to
    ``face`` (redeemable at par).
    """
    if redemption is None:
        redemption = face
    j = yield_rate / freq
    coupon = face * coupon_rate / freq
    return coupon * annuity_immediate_pv(n, j) + redemption * v_factor(j) ** n


# ── cash-flow analytics ───────────────────────────────────────────────────


def npv(cashflows: Sequence[float], i: float, times: Sequence[float] | None = None) -> float:
    """Net present value of ``cashflows`` at effective ``i``.

    Without ``times``, cashflow k is assumed at time k (k = 0, 1, 2, ...).
    """
    if times is None:
        times = range(len(cashflows))
    return sum(cf * v_factor(i) ** t for cf, t in zip(cashflows, times))


def irr(cashflows: Sequence[float], times: Sequence[float] | None = None,
        lo: float = -0.9999, hi: float = 10.0) -> float:
    """Internal rate of return: the ``i`` solving ``NPV(i) = 0`` (first sign flip)."""
    return solve_rate(lambda r: npv(cashflows, r, times), lo=lo, hi=hi)


# ── interest-rate risk ────────────────────────────────────────────────────


def macaulay_duration(cashflows: Sequence[float], i: float,
                      times: Sequence[float] | None = None) -> float:
    """Macaulay duration = PV-weighted average time of the cash flows."""
    if times is None:
        times = list(range(len(cashflows)))
    pvs = [cf * v_factor(i) ** t for cf, t in zip(cashflows, times)]
    total = sum(pvs)
    return sum(t * pv for t, pv in zip(times, pvs)) / total


def modified_duration(cashflows: Sequence[float], i: float,
                      times: Sequence[float] | None = None) -> float:
    """Modified duration = Macaulay duration / (1 + i)."""
    return macaulay_duration(cashflows, i, times) / (1.0 + i)


def convexity(cashflows: Sequence[float], i: float,
              times: Sequence[float] | None = None) -> float:
    """(Modified) convexity: PV-weighted ``t(t+1)`` over ``(1+i)^2``, per PV."""
    if times is None:
        times = list(range(len(cashflows)))
    pvs = [cf * v_factor(i) ** t for cf, t in zip(cashflows, times)]
    total = sum(pvs)
    num = sum(t * (t + 1) * pv for t, pv in zip(times, pvs))
    return num / (total * (1.0 + i) ** 2)


def macaulay_first_order_price_change(mac_duration: float, i_old: float,
                                      i_new: float) -> float:
    r"""Fractional price change under the **first-order Macaulay** approximation.

    ``P(i_new)/P(i_old) ≈ ((1 + i_old) / (1 + i_new)) ** MacDuration``.

    This is the exam-correct "Macaulay approximation" and differs slightly from
    the naive modified-duration estimate ``-ModDur * Δi`` (a common distractor).
    Returns the fractional change (multiply by 100 for a percentage).
    """
    return ((1.0 + i_old) / (1.0 + i_new)) ** mac_duration - 1.0


def modified_first_order_price_change(mod_duration: float, di: float) -> float:
    r"""First-order **modified-duration** price change: ``-ModDur * Δi``."""
    return -mod_duration * di
