# Small one-liners that round out the toolkit: rate conversions, mx <-> qx,
# life-contingent expected present values, an A/E significance test and the
# cost-of-capital risk margin. Each mirrors the Python function of the same
# name (scelo.finance / scelo.life / scelo.risk).

#' Interest-rate conversions
#'
#' `sc_nominal()` gives i^(m) from an effective rate, `sc_effective()` the
#' reverse, `sc_force()` the force of interest ln(1 + i), `sc_from_force()`
#' its inverse, `sc_discount_rate()` d = i / (1 + i).
#' @param i Effective annual rate.
#' @param m Conversions per year.
#' @param i_m Nominal rate convertible m-thly.
#' @param delta Force of interest.
#' @return A number.
#' @examples
#' sc_effective(sc_nominal(0.05, 12), 12)
#' @export
sc_nominal <- function(i, m = 12) m * ((1 + i)^(1 / m) - 1)

#' @rdname sc_nominal
#' @export
sc_effective <- function(i_m, m = 12) (1 + i_m / m)^m - 1

#' @rdname sc_nominal
#' @export
sc_force <- function(i) log(1 + i)

#' @rdname sc_nominal
#' @export
sc_from_force <- function(delta) exp(delta) - 1

#' @rdname sc_nominal
#' @export
sc_discount_rate <- function(i) i / (1 + i)

#' Central and initial mortality rates
#'
#' `sc_mx_to_qx()`: q = m / (1 + m/2) under uniform deaths, 1 - exp(-m) under
#' a constant force; `sc_qx_to_mx()` the reverse.
#' @param mx,qx Rates.
#' @param assumption "uniform" or "constant".
#' @return A numeric vector.
#' @export
sc_mx_to_qx <- function(mx, assumption = "uniform") {
  q <- if (assumption == "uniform") mx / (1 + mx / 2) else 1 - exp(-mx)
  pmin(pmax(q, 0), 1)
}

#' @rdname sc_mx_to_qx
#' @export
sc_qx_to_mx <- function(qx, assumption = "uniform") if (assumption == "uniform") qx / (1 - qx / 2) else -log(1 - qx)

#' Expected present value of a life-contingent cash-flow vector
#'
#' For a life aged `x`: sum of cf_t v^t tpx (paid at t while alive, `due =
#' TRUE`), cf_t v^(t+1) (t+1)px (paid at t+1, `due = FALSE`) or cf_t v^(t+1)
#' tpx q_(x+t) (paid at the end of the year of death, `on_death = TRUE`).
#' Any basis accepted by [sc_qx()]; the table is closed at its last age.
#' @param cashflows Cash flows from time 0.
#' @param x Age.
#' @param basis,df,... Mortality basis, see [sc_qx()].
#' @param i Interest rate.
#' @param due Payment at the start (`TRUE`) or end of each year.
#' @param on_death Benefit on death instead of survival.
#' @return A number.
#' @examples
#' sc_epv(rep(1, 200), 65, i = 0.04)   # an annuity-due of 1 = ä65
#' @export
sc_epv <- function(cashflows, x, basis = NULL, df = NULL, i = 0.04, due = TRUE, on_death = FALSE, ...) {
  q <- sc_qx(basis, df, ...)
  k0 <- match(x, q$ages)
  if (is.na(k0)) stop(sprintf("age %s is not in the basis", x), call. = FALSE)
  qs <- q$qx[k0:length(q$qx)]
  qs[length(qs)] <- 1
  n <- min(length(cashflows), length(qs))
  cf <- as.numeric(cashflows)[seq_len(n)]
  qs <- qs[seq_len(n)]
  tpx <- c(1, cumprod(1 - qs))[seq_len(n)]
  v <- 1 / (1 + i)
  t <- seq_len(n) - 1
  if (on_death) return(sum(cf * v^(t + 1) * tpx * qs))
  if (due) sum(cf * v^t * tpx) else sum(cf * v^(t + 1) * tpx * (1 - qs))
}

#' Is A/E significantly different from 1?
#'
#' Poisson z-test z = (A - E) / sqrt(E) with its two-sided p-value and a 95 %
#' interval for A/E.
#' @param actual,expected Counts.
#' @return A named list: ae, z, p_value, lower95, upper95.
#' @export
sc_ae_test <- function(actual, expected) {
  if (expected <= 0) stop("expected must be positive", call. = FALSE)
  z <- (actual - expected) / sqrt(expected)
  list(ae = actual / expected, z = z, p_value = 2 * (1 - stats::pnorm(abs(z))),
       lower95 = (actual - 1.96 * sqrt(actual)) / expected, upper95 = (actual + 1.96 * sqrt(actual)) / expected)
}

#' Cost-of-capital risk margin
#'
#' RM = CoC * sum_t SCR_t v^(t+1) for a projected SCR run-off (t = 0, 1, ...)
#' at a flat rate or a zero curve by year.
#' @param scr Projected SCRs.
#' @param rate Flat rate or a vector of zero rates.
#' @param coc Cost of capital (6 %).
#' @return A number.
#' @export
sc_risk_margin <- function(scr, rate = 0.04, coc = 0.06) {
  s <- as.numeric(scr)
  t <- seq_along(s)
  z <- if (length(rate) == 1) rep(rate, length(s)) else as.numeric(rate)[seq_along(s)]
  coc * sum(s * (1 + z)^(-t))
}
