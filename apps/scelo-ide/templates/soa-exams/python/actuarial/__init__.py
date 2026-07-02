"""Scelo actuarial solver toolkit.

Deterministic, unit-tested implementations of the actuarial mathematics behind
the SOA exams. Import the per-exam module you need::

    from actuarial import fm          # Financial Mathematics (Exam FM)
    fm.annuity_immediate_pv(10, 0.05) # -> 7.7217...

Modules land here as each exam's benchmark is worked:
    fm   Financial Mathematics (Exam FM)   [implemented]
    p    Probability (Exam P)              [next]
    fam  Fundamentals of Actuarial Maths   [planned]
    srm  Statistics for Risk Modeling      [planned]
"""

from . import fm

__all__ = ["fm"]
