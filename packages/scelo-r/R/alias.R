# Column inference: the reason sc_triangle(df) needs no arguments.
#
# Every tools function accepts explicit column names, but when you leave
# them out it looks the columns up here: case- and punctuation-insensitive
# matches against the alias lists Scelo IDE uses for its own table
# suggestions, so accident_year / AY / Origin Year all resolve to origin.

.sc_lc <- function(s) gsub("[^a-z0-9]", "", tolower(as.character(s)))

#' Column aliases Scelo recognises
#'
#' The alias lists behind column inference, one entry per role ("age",
#' "origin", "development", "value", "premium", ...), canonical name first.
#' @format A named list of character vectors.
#' @export
SC_COLUMN_ALIASES <- list(
  age = c("age", "age_at_entry", "ageatentry", "issue_age", "attained_age", "x", "age_x", "age_band", "ageband", "age_last", "age_nearest", "entry_age", "age_years"),
  qx = c("qx", "q_x", "mortality", "mortality_rate", "death_rate", "q", "prob_death", "rate", "qx_ult"),
  mx = c("mx", "m_x", "central_rate", "hazard", "mu", "mu_x", "force_of_mortality"),
  lx = c("lx", "l_x", "lives", "survivors", "l"),
  deaths = c("deaths", "death", "d", "dx", "actual_deaths", "claims_count", "n_deaths", "died", "events", "actual"),
  exposure = c("exposure", "exposures", "exposed", "exposed_to_risk", "etr", "lives_exposed", "person_years", "policy_years", "central_exposure", "initial_exposure", "expo", "e", "ex", "time_at_risk"),
  expected = c("expected", "expected_deaths", "exp_deaths", "e_deaths", "expected_claims"),
  origin = c("origin", "origin_year", "accident_year", "accidentyear", "ay", "uw_year", "underwriting_year", "occurrence_year", "loss_year", "year_of_origin", "cohort", "origin_period", "accident_period", "acc_year", "accyear", "uwy", "policy_year"),
  development = c("development", "dev", "development_period", "dev_period", "development_year", "dev_year", "lag", "delay", "age_months", "development_lag", "dev_lag", "period", "devyear", "development_months"),
  payment = c("payment_year", "calendar_year", "paid_year", "settlement_year", "transaction_year", "report_year", "valuation_year", "cal_year", "calendar_period", "payment_period", "cy"),
  value = c("paid", "incurred", "paid_amount", "incurred_amount", "claims", "claim_amount", "amount", "loss", "losses", "payments", "value", "cumulative", "reported", "paid_claims", "incurred_claims", "claim", "cost", "severity"),
  premium = c("premium_pp", "premium", "annual_premium", "monthly_premium", "prem", "earned_premium", "written_premium", "gwp", "gep", "premiums", "ep"),
  tenor = c("tenor", "maturity", "term", "years", "year", "t", "maturity_years", "tenor_years"),
  rate = c("rate", "zero_rate", "spot", "spot_rate", "yield", "zero", "swap_rate", "par_rate", "interest_rate", "zero_coupon", "spot_yield", "r"),
  sex = c("sex", "gender", "male_female", "m_f"),
  policy_term = c("policy_term", "policyterm", "term", "term_years", "policy_term_years", "duration_years"),
  sum_assured = c("sum_assured", "sumassured", "sa", "face_amount", "face", "benefit", "sum_insured", "si", "coverage"),
  count = c("count", "policy_count", "policycount", "n", "number", "claim_count", "frequency", "num_claims", "nclaims", "claims_count", "policies"),
  year = c("year", "calendar_year", "cal_year", "period", "yr"),
  date = c("date", "as_at", "valuation_date", "effective_date", "start_date", "issue_date"),
  duration = c("duration", "time", "t", "survival_time", "policy_duration", "tenure"),
  event = c("event", "status", "died", "death", "claimed", "lapsed", "censored"),
  group = c("group", "segment", "class", "cohort", "risk_class", "region", "band"),
  actual = c("actual", "observed", "actual_claims", "actual_deaths", "deaths", "claims")
)

#' Find a column by alias
#'
#' @param columns Column names.
#' @param aliases Candidate spellings (first match wins), compared after
#'   lower-casing and stripping punctuation.
#' @return The matching column name, or `NULL`.
#' @examples
#' sc_find_column(c("Accident Year", "Paid"), SC_COLUMN_ALIASES$origin)
#' @export
sc_find_column <- function(columns, aliases) {
  keys <- .sc_lc(columns)
  for (a in aliases) {
    hit <- match(.sc_lc(a), keys)
    if (!is.na(hit)) return(columns[hit])
  }
  NULL
}

#' Resolve a column for a role
#'
#' `sc_infer(df, "origin")` returns the origin column of `df` by alias;
#' `explicit` wins when given and is validated.
#' @param df A data frame.
#' @param role A name in [SC_COLUMN_ALIASES].
#' @param explicit A column name, or `NULL` to infer.
#' @param required Error (`TRUE`) or return `NULL` when nothing matches.
#' @param exclude Columns not to pick (already used for another role).
#' @return A column name (or `NULL`).
#' @export
sc_infer <- function(df, role, explicit = NULL, required = TRUE, exclude = character()) {
  if (!is.null(explicit)) {
    if (!explicit %in% names(df)) stop(sprintf('column "%s" is not in the data (have: %s)', explicit, paste(names(df), collapse = ", ")), call. = FALSE)
    return(explicit)
  }
  aliases <- SC_COLUMN_ALIASES[[role]]
  if (is.null(aliases)) stop(sprintf("unknown column role '%s'", role), call. = FALSE)
  hit <- sc_find_column(setdiff(names(df), exclude), aliases)
  if (is.null(hit) && required) {
    stop(sprintf("could not infer the %s column: pass %s = <name>. Tried %s...; columns: %s", role, role,
                 paste(utils::head(aliases, 6), collapse = ", "), paste(names(df), collapse = ", ")), call. = FALSE)
  }
  hit
}

.sc_numeric_columns <- function(df) names(df)[vapply(df, function(c) is.numeric(c) && !is.logical(c), logical(1))]
