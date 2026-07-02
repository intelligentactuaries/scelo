"""Correctness tests for the FM toolkit.

Several cases tie out directly to the official SOA *Exam FM Sample Solutions*
answer key, so a green suite means the toolkit reproduces the examiner's
numbers — not just internally-consistent ones.

Run inside the Scelo IDE tests panel, or::

    python -m pytest tests/            # if pytest is available
    python tests/test_fm.py           # standalone fallback
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))

from actuarial import fm  # noqa: E402

TOL = 1e-9


# ── official SOA Exam FM sample-answer tie-outs ───────────────────────────


def test_fm_q1_force_of_interest():
    # Q1: nominal 4% convertible semiannually -> equivalent force delta.
    # Official answer: (C) 0.0396.
    i = fm.i_from_nominal(0.04, 2)
    delta = fm.delta_from_i(i)
    assert round(delta, 4) == 0.0396


def test_fm_q6_loan_150pct_interest():
    # Q6: 20-yr loan of 1000 at 10%; first 10 payments = 150% of interest due,
    # last 10 payments = X. Official answer: (D) 97.
    # Each early year principal falls to 95% (pay 1.5*interest -> repay 0.5*int
    # of principal, i.e. 0.05*balance), so B_10 = 1000 * 0.95**10.
    b10 = 1000 * 0.95 ** 10
    x = b10 / fm.annuity_immediate_pv(10, 0.10)
    assert round(x) == 97


def test_annuity_immediate_pv_known_value():
    # a_{10|} at 5% = 7.7217 (matches an independent hand + CLI check).
    assert round(fm.annuity_immediate_pv(10, 0.05), 4) == 7.7217


def test_fm_q146_macaulay_first_order():
    # Q146: 20-yr bond, yield 10%, Macaulay duration 11; yield +0.25%. The
    # first-order *Macaulay* approximation gives -2.47% (B), NOT the naive
    # modified -2.50% (distractor C). Official answer: (B) -2.47%.
    chg = fm.macaulay_first_order_price_change(11, 0.10, 0.1025)
    assert round(chg * 100, 2) == -2.47


def test_fm_q449_bond_book_value_uses_original_yield():
    # Q449: 30-yr 1000 bond, 7% semi coupons first 15y (=35), 9% last 15y (=45),
    # bought to yield 8% conv semi (4%/period). Book value after the 20th coupon
    # is the PV of the *remaining* cash flows at the ORIGINAL 4% yield — the
    # later 6% "market yield" is a distractor. Official answer: (C) 1018.
    cfs = [0.0] + [35.0] * 10 + [45.0] * 30  # coupons 21..60 at times 1..40
    cfs[40] += 1000.0  # redemption at time 40
    bv = fm.npv(cfs, 0.04)
    assert round(bv) == 1018


# ── interest-rate conversions ─────────────────────────────────────────────


def test_rate_conversions_roundtrip():
    i = 0.07
    assert abs(fm.i_from_d(fm.d_from_i(i)) - i) < TOL
    assert abs(fm.i_from_delta(fm.delta_from_i(i)) - i) < TOL
    assert abs(fm.i_from_nominal(fm.nominal_from_i(i, 12), 12) - i) < TOL


def test_discount_and_force_identities():
    i = 0.05
    assert abs(fm.d_from_i(i) - (1 - fm.v_factor(i))) < TOL
    assert abs(fm.delta_from_i(i) - math.log(1 + i)) < TOL


# ── annuities ─────────────────────────────────────────────────────────────


def test_due_is_immediate_times_one_plus_i():
    n, i = 15, 0.06
    assert abs(fm.annuity_due_pv(n, i) - fm.annuity_immediate_pv(n, i) * (1 + i)) < TOL
    assert abs(fm.annuity_due_fv(n, i) - fm.annuity_immediate_fv(n, i) * (1 + i)) < TOL


def test_annuity_fv_equals_pv_accumulated():
    n, i = 20, 0.04
    pv = fm.annuity_immediate_pv(n, i)
    fv = fm.annuity_immediate_fv(n, i)
    assert abs(fv - pv * (1 + i) ** n) < 1e-7


def test_perpetuities():
    i = 0.08
    assert abs(fm.perpetuity_immediate_pv(i) - 1 / i) < TOL
    assert abs(fm.perpetuity_due_pv(i) - 1 / fm.d_from_i(i)) < TOL
    # Increasing perpetuity-immediate 1,2,3,... = (1+i)/i^2.
    assert abs(fm.increasing_perpetuity_immediate_pv(i) - (1 + i) / i ** 2) < TOL


def test_increasing_decreasing_identity():
    # (Ia)_n + (Da)_n = (n+1) * a_n.
    n, i = 10, 0.05
    lhs = fm.increasing_annuity_immediate_pv(n, i) + fm.decreasing_annuity_immediate_pv(n, i)
    rhs = (n + 1) * fm.annuity_immediate_pv(n, i)
    assert abs(lhs - rhs) < 1e-7


def test_geometric_annuity_matches_level_when_g_zero():
    n, i = 12, 0.05
    assert abs(fm.geometric_annuity_immediate_pv(n, i, 0.0) - fm.annuity_immediate_pv(n, i)) < 1e-9


# ── loans / amortization ──────────────────────────────────────────────────


def test_amortization_splits_reconstruct_payment():
    loan, n, i = 10000, 10, 0.06
    pmt = fm.level_payment(loan, n, i)
    for k in range(1, n + 1):
        assert abs(fm.interest_paid(loan, n, i, k) + fm.principal_repaid(loan, n, i, k) - pmt) < 1e-7
    # Final balance is ~0.
    assert abs(fm.outstanding_balance(loan, n, i, n)) < 1e-6


def test_sinking_fund_reduces_to_amortization_when_rates_equal():
    # When the fund rate equals the loan rate, the sinking-fund outlay equals
    # the amortization payment.
    loan, n, i = 5000, 8, 0.05
    assert abs(fm.sinking_fund_payment(loan, n, i, i) - fm.level_payment(loan, n, i)) < 1e-7


# ── bonds ─────────────────────────────────────────────────────────────────


def test_par_bond_prices_at_face():
    assert abs(fm.bond_price(1000, 0.05, 10, 0.05) - 1000) < 1e-7


def test_bond_premium_when_coupon_exceeds_yield():
    p = fm.bond_price(1000, 0.08, 10, 0.06)
    assert p > 1000  # premium bond


# ── cash-flow analytics + duration ────────────────────────────────────────


def test_irr_recovers_rate():
    assert abs(fm.irr([-100, 110]) - 0.10) < 1e-9
    # A bond priced at yield y has IRR y.
    cfs = [-fm.bond_price(1000, 0.07, 5, 0.05)] + [70] * 4 + [1070]
    assert abs(fm.irr(cfs) - 0.05) < 1e-7


def test_modified_is_macaulay_over_one_plus_i():
    cfs, i = [0, 0, 0, 0, 0, 1000], 0.05
    assert abs(fm.modified_duration(cfs, i) - fm.macaulay_duration(cfs, i) / (1 + i)) < TOL
    # A single cash flow at time t has Macaulay duration t.
    assert abs(fm.macaulay_duration([0, 0, 0, 0, 0, 1000], i) - 5) < TOL


if __name__ == "__main__":
    # Standalone fallback when pytest isn't installed.
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    passed = 0
    for fn in fns:
        try:
            fn()
            passed += 1
            print(f"PASS {fn.__name__}")
        except Exception as e:  # noqa: BLE001
            print(f"FAIL {fn.__name__}: {e}")
    print(f"\n{passed}/{len(fns)} passed")
    sys.exit(0 if passed == len(fns) else 1)
