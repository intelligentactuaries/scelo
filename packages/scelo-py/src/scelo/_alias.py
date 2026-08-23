"""Column inference: the reason ``sc.triangle(df)`` needs no arguments.

Every tools function accepts explicit column names, but when you leave them
out it looks the columns up here: case- and punctuation-insensitive matches
against the alias lists Scelo IDE uses for its own table suggestions, so
``accident_year`` / ``AY`` / ``Origin Year`` all resolve to the origin column.
"""

from __future__ import annotations

import re
from typing import Dict, Iterable, List, Optional, Sequence

import pandas as pd

_NON_ALNUM = re.compile(r"[^a-z0-9]")


def _lc(s: str) -> str:
    return _NON_ALNUM.sub("", str(s).lower())


# Mirrors packages/scelo-core/src/actuarialTables.ts COLUMN_ALIASES, with the
# extra spellings that show up on real extracts. Order matters: the first alias
# that matches wins, so the canonical name leads each list.
COLUMN_ALIASES: Dict[str, List[str]] = {
    "age": [
        "age", "age_at_entry", "ageatentry", "issue_age", "attained_age", "x", "age_x",
        "age_band", "ageband", "age_last", "age_nearest", "entry_age", "age_years",
    ],
    "qx": ["qx", "q_x", "mortality", "mortality_rate", "death_rate", "q", "prob_death", "rate", "qx_ult"],
    "mx": ["mx", "m_x", "central_rate", "hazard", "mu", "mu_x", "force_of_mortality"],
    "lx": ["lx", "l_x", "lives", "survivors", "l"],
    "deaths": ["deaths", "death", "d", "dx", "actual_deaths", "claims_count", "n_deaths", "died", "events", "actual"],
    "exposure": [
        "exposure", "exposures", "exposed", "exposed_to_risk", "etr", "lives_exposed", "person_years",
        "policy_years", "central_exposure", "initial_exposure", "expo", "e", "ex", "time_at_risk",
    ],
    "expected": ["expected", "expected_deaths", "exp_deaths", "e_deaths", "expected_claims"],
    "origin": [
        "origin", "origin_year", "accident_year", "accidentyear", "ay", "uw_year", "underwriting_year",
        "occurrence_year", "loss_year", "year_of_origin", "cohort", "origin_period", "accident_period",
        "acc_year", "accyear", "uwy", "policy_year",
    ],
    "development": [
        "development", "dev", "development_period", "dev_period", "development_year", "dev_year", "lag",
        "delay", "age_months", "development_lag", "dev_lag", "period", "devyear", "development_months",
    ],
    "payment": [
        "payment_year", "calendar_year", "paid_year", "settlement_year", "transaction_year", "report_year",
        "valuation_year", "cal_year", "calendar_period", "payment_period", "cy",
    ],
    "value": [
        "paid", "incurred", "paid_amount", "incurred_amount", "claims", "claim_amount", "amount", "loss",
        "losses", "payments", "value", "cumulative", "reported", "paid_claims", "incurred_claims",
        "claim", "cost", "severity",
    ],
    "premium": [
        "premium_pp", "premium", "annual_premium", "monthly_premium", "prem", "earned_premium",
        "written_premium", "gwp", "gep", "premiums", "ep",
    ],
    "tenor": ["tenor", "maturity", "term", "years", "year", "t", "maturity_years", "tenor_years"],
    "rate": [
        "rate", "zero_rate", "spot", "spot_rate", "yield", "zero", "swap_rate", "par_rate",
        "interest_rate", "zero_coupon", "spot_yield", "r",
    ],
    "sex": ["sex", "gender", "male_female", "m_f"],
    "policy_term": ["policy_term", "policyterm", "term", "term_years", "policy_term_years", "duration_years"],
    "sum_assured": ["sum_assured", "sumassured", "sa", "face_amount", "face", "benefit", "sum_insured", "si", "coverage"],
    "count": ["count", "policy_count", "policycount", "n", "number", "claim_count", "frequency", "num_claims", "nclaims", "claims_count", "policies"],
    "year": ["year", "calendar_year", "cal_year", "period", "yr"],
    "date": ["date", "as_at", "valuation_date", "effective_date", "start_date", "issue_date"],
    "duration": ["duration", "time", "t", "survival_time", "policy_duration", "tenure"],
    "event": ["event", "status", "died", "death", "claimed", "lapsed", "censored"],
    "group": ["group", "segment", "class", "cohort", "risk_class", "region", "band"],
    "actual": ["actual", "observed", "actual_claims", "actual_deaths", "deaths", "claims"],
}


def find_column(columns: Iterable[str], aliases: Sequence[str]) -> Optional[str]:
    """First column whose normalised name matches one of the aliases, else None."""
    cols = list(columns)
    table = {}
    for c in cols:
        table.setdefault(_lc(c), c)
    for a in aliases:
        hit = table.get(_lc(a))
        if hit is not None:
            return hit
    return None


def infer(df: pd.DataFrame, role: str, explicit: Optional[str] = None, *, required: bool = True,
          exclude: Iterable[str] = ()) -> Optional[str]:
    """Resolve a column for ``role`` ("age", "origin", …).

    ``explicit`` wins when given (and is validated). Otherwise the alias list
    for the role is searched, skipping anything in ``exclude`` (so the same
    column is not picked for two roles). Raises a ``KeyError`` naming the
    role, the aliases tried and the columns available when ``required``.
    """
    if explicit is not None:
        if explicit not in df.columns:
            raise KeyError(f'column "{explicit}" is not in the data (have: {", ".join(map(str, df.columns))})')
        return explicit
    aliases = COLUMN_ALIASES.get(role)
    if aliases is None:
        raise KeyError(f"unknown column role {role!r}")
    ex = set(exclude)
    hit = find_column([c for c in df.columns if c not in ex], aliases)
    if hit is None and required:
        raise KeyError(
            f"could not infer the {role} column: pass {role}=<name>. "
            f"Tried {', '.join(aliases[:6])}…; columns: {', '.join(map(str, df.columns))}"
        )
    return hit


def numeric_columns(df: pd.DataFrame) -> List[str]:
    """Names of the numeric (non-boolean) columns."""
    return [c for c in df.columns if pd.api.types.is_numeric_dtype(df[c]) and not pd.api.types.is_bool_dtype(df[c])]
